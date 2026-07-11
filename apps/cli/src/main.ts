#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ApplicationHttpClient, ApplicationRemoteError } from "@massion/application";

import { executeCliInvocation } from "./commands.js";
import { CliConfigStore } from "./config.js";
import { parseCliArguments } from "./parser.js";
import { renderCliOutput } from "./render.js";
import { resolveTokenReference } from "./token.js";

const HELP = `mass - Massion AgentOS command line\n\n사용법: mass <init|status|run|watch|org|work|chat|task|approval|runtime|provider|ext|growth|doctor> [options]\n`;

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
    if (invocation.command === "init") throw new Error("mass init은 로컬 AgentOS bootstrap 연결이 필요합니다");
    if (["run", "watch"].includes(invocation.command))
      throw new Error(`${invocation.command}은 headless runner에서 실행해야 합니다`);
    const config = await new CliConfigStore().load();
    const profileName = invocation.profile ?? config.selectedProfile;
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`CLI profile을 찾을 수 없습니다: ${profileName}`);
    const token = await resolveTokenReference(profile.tokenReference);
    const authenticated = new ApplicationHttpClient({ baseUrl: profile.endpoint, token });
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runCli();
