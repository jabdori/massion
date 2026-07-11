#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApplicationHttpClient, ApplicationRemoteError } from "@massion/application";

import { executeCliInvocation } from "./commands.js";
import { CliConfigStore } from "./config.js";
import { processJsonLines, writeWithBackpressure } from "./jsonl.js";
import { initializeCli } from "./init.js";
import { LocalDaemonManager } from "./local.js";
import { parseCliArguments } from "./parser.js";
import { renderCliOutput } from "./render.js";
import { runHeadless } from "./run.js";
import { resolveTokenReference } from "./token.js";

const HELP = `mass - Massion AgentOS command line\n\n사용법: mass <version|local|init|status|run|resume|watch|org|work|chat|task|approval|assurance|runtime|provider|ext|growth|doctor> [options]\n`;

async function readStdin(maximum = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > maximum) throw new Error("stdin byte 상한을 초과했습니다");
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function exitCode(error: unknown): number {
  if (error instanceof ApplicationRemoteError && error.body && typeof error.body === "object") {
    const category = (error.body as { category?: unknown }).category;
    return (
      {
        validation: 2,
        authentication: 3,
        authorization: 4,
        policy: 4,
        conflict: 5,
        "not-found": 6,
        unavailable: 7,
        "rate-limit": 7,
      }[String(category)] ?? 70
    );
  }
  return 2;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const invocation = parseCliArguments(argv);
    if (invocation.command === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (invocation.command === "version") {
      process.stdout.write("Massion AgentOS 1.0.0\n");
      return 0;
    }
    if (invocation.command === "local") {
      const manager = new LocalDaemonManager();
      const value =
        invocation.subcommand === "start"
          ? await manager.start()
          : invocation.subcommand === "status"
            ? await manager.status()
            : invocation.subcommand === "backup"
              ? await manager.backup(invocation.arguments[0])
              : await manager.stop();
      process.stdout.write(
        renderCliOutput(value, invocation.output, {
          tty: process.stdout.isTTY,
          noColor: process.env.NO_COLOR !== undefined,
        }),
      );
      return value.status === "foreign" ? 5 : 0;
    }
    if (invocation.command === "init") {
      const endpoint = invocation.arguments[0] ?? "http://127.0.0.1:7331";
      const email = invocation.arguments[1];
      const displayName = invocation.arguments.slice(2).join(" ");
      if (!email || !displayName) throw new Error("사용법: mass init [endpoint] <email> <display name>");
      const value = await initializeCli({
        endpoint,
        email,
        displayName,
        profile: invocation.profile ?? "local",
        config: new CliConfigStore(),
        bootstrap: async (
          baseUrl: string,
          bootstrapInput: { readonly commandId: string; readonly email: string; readonly displayName: string },
        ) => await ApplicationHttpClient.bootstrap(baseUrl, bootstrapInput),
      });
      process.stdout.write(
        renderCliOutput(value, invocation.output, {
          tty: process.stdout.isTTY,
          noColor: process.env.NO_COLOR !== undefined,
        }),
      );
      return 0;
    }
    const config = await new CliConfigStore().load();
    const profileName = invocation.profile ?? config.selectedProfile;
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`CLI profile을 찾을 수 없습니다: ${profileName}`);
    const token = await resolveTokenReference(profile.tokenReference);
    const authenticated = new ApplicationHttpClient({ baseUrl: profile.endpoint, token });
    if (invocation.command === "run" && invocation.output === "jsonl") {
      await processJsonLines(
        process.stdin,
        async (input) => ({
          schemaVersion: "massion.cli.jsonl.v1",
          type: "result",
          data: await authenticated.command(input),
        }),
        async (line) => {
          await writeWithBackpressure(process.stdout, line);
        },
      );
      return 0;
    }
    const signals = new AbortController();
    let signalCount = 0;
    const interrupt = (): void => {
      signalCount += 1;
      if (signalCount === 1) signals.abort();
      else process.exit(130);
    };
    process.on("SIGINT", interrupt);
    try {
      if (invocation.command === "run") {
        const text = invocation.arguments.join(" ").trim();
        if (!text) throw new Error("run request text가 필요합니다");
        const value = await runHeadless(
          authenticated,
          { text, surface: "cli" },
          {
            detach: invocation.detach,
            signal: signals.signal,
            ...(invocation.output === "jsonl"
              ? {
                  onEvent: async (event: unknown) => {
                    await writeWithBackpressure(
                      process.stdout,
                      `${JSON.stringify({ schemaVersion: "massion.cli.jsonl.v1", type: "event", data: event })}\n`,
                    );
                  },
                }
              : {}),
          },
        );
        await writeWithBackpressure(
          process.stdout,
          renderCliOutput(value, invocation.output, {
            tty: process.stdout.isTTY,
            noColor: process.env.NO_COLOR !== undefined,
          }),
        );
        return recordStatus(value) === "blocked" ? 7 : recordStatus(value) === "cancelled" ? 130 : 0;
      }
      if (invocation.command === "watch") {
        for await (const event of authenticated.streamEvents(invocation.after ?? 0, signals.signal)) {
          await writeWithBackpressure(process.stdout, `${JSON.stringify(event)}\n`);
        }
        return signals.signal.aborted ? 130 : 0;
      }
    } finally {
      process.off("SIGINT", interrupt);
    }
    const value = await executeCliInvocation(authenticated, invocation, {
      readJson: async () => JSON.parse((await readStdin()).toString("utf8")) as unknown,
      readArtifact: async (path) => {
        const archive = await readFile(path);
        if (archive.length > 64 * 1024 * 1024) throw new Error("Extension artifact byte 상한을 초과했습니다");
        return archive;
      },
    });
    process.stdout.write(
      renderCliOutput(value, invocation.output, {
        tty: process.stdout.isTTY,
        noColor: process.env.NO_COLOR !== undefined,
      }),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "알 수 없는 CLI 오류"}\n`);
    return exitCode(error);
  }
}

function recordStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]))
  process.exitCode = await runCli();
