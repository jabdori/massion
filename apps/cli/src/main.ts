#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApplicationHttpClient, ApplicationRemoteError } from "@massion/application";

import { executeCliInvocation } from "./commands.js";
import { CliConfigStore } from "./config.js";
import { processJsonLines, writeWithBackpressure } from "./jsonl.js";
import { initializeCli } from "./init.js";
import { LocalDaemonManager, resolveLocalPaths } from "./local.js";
import { defaultLocalEndpoint, ensureLocalEndpoint } from "./local-entrypoint.js";
import { parseCliArguments } from "./parser.js";
import { renderCliOutput } from "./render.js";
import { runHeadless } from "./run.js";
import { connectLocalServerSubscription } from "./subscription-login.js";
import { resolveTokenReference } from "./token.js";
import { createOnboardingPrompt } from "./onboarding.js";
import { openWebConsole } from "./web-login.js";

const HELP = `Massion AgentOS

사용법:
  massion [명령] [옵션]
  massion                 대화형 TUI 실행 및 첫 실행 온보딩
  massion --web           Web Console 로그인
  massion --help          이 도움말 표시
  massion --version       버전 표시

주요 명령:
  init [endpoint] [email] [표시명]  개인 서버 초기화 또는 온보딩
  status                         애플리케이션 상태 확인
  run <요청>                     새 업무 실행
  watch --events jsonl           이벤트 스트림 관찰
  update [version]               업데이트 확인
  upgrade [version]             호환 가능한 업데이트 설치
  local <start|status|stop|ensure> 로컬 서버 관리

기능 그룹:
  org, work, chat, task, approval, assurance, runtime
  provider, subscription, ext, growth, optimization, doctor

공통 옵션:
  --json                         한 번에 JSON으로 출력
  --jsonl                        JSON Lines로 출력
  --profile <이름>               사용할 연결 프로필 선택
  --wait                         실행이 끝날 때까지 대기
  --detach                       실행을 백그라운드로 분리

예시:
  massion
  massion init
  massion run "첫 번째 작업" --wait
  massion subscription connect openai-codex
  massion status --json

자동화·고급 명령은 각 명령의 사용법과 README를 참고하세요.
`;

async function runReleaseUpdater(arguments_: readonly string[]): Promise<number> {
  const updater = process.env.MASSION_UPDATE_BIN;
  if (!updater) throw new Error("설치된 release에서만 update·upgrade를 사용할 수 있습니다");
  const child = spawn(updater, [...arguments_], { env: process.env, stdio: "inherit" });
  return await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveCode(code ?? 1);
    });
  });
}

export function assertSecretTransportEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("CLI endpoint가 유효하지 않습니다");
  }
  if (endpoint.username || endpoint.password) throw new Error("CLI endpoint URL에 자격 증명을 포함할 수 없습니다");
  if (endpoint.protocol === "https:") return;
  if (endpoint.protocol === "http:" && new Set(["127.0.0.1", "[::1]", "localhost"]).has(endpoint.hostname)) {
    return;
  }
  throw new Error("구독 secret 전송에는 외부 HTTPS 또는 local loopback HTTP endpoint가 필요합니다");
}

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
    if (argv[0] === "--help" || argv[0] === "-h") {
      if (argv.length !== 1) throw new Error(`${argv[0]}에는 추가 인자를 지정할 수 없습니다`);
      process.stdout.write(HELP);
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      if (argv.length !== 1) throw new Error(`${argv[0]}에는 추가 인자를 지정할 수 없습니다`);
      process.stdout.write("Massion AgentOS 1.0.0\n");
      return 0;
    }
    if (argv[0] === "--web") {
      if (argv.length !== 1) throw new Error("massion --web에는 추가 인자를 지정할 수 없습니다");
      let config;
      try {
        config = await new CliConfigStore().load();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw new Error(
            'Massion이 아직 초기화되지 않았습니다. 먼저 `massion init http://127.0.0.1:7331 <email> "<표시명>"`을 실행해 주세요.',
            { cause: error },
          );
        }
        throw error;
      }
      const profile = config.profiles[config.selectedProfile];
      if (!profile) throw new Error("선택된 CLI profile이 없습니다. 먼저 massion init을 실행해 주세요");
      await ensureLocalEndpoint(profile.endpoint, { start: async () => await new LocalDaemonManager().start() });
      const token = await resolveTokenReference(profile.tokenReference);
      const web = await openWebConsole({ endpoint: profile.endpoint, token });
      process.stdout.write(
        `Web Console: ${web.url}\n일회성 로그인 코드(5분): ${web.code}\n만료 시각: ${web.expiresAt}\n`,
      );
      return 0;
    }
    const invocation = parseCliArguments(argv);
    if (invocation.command === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (invocation.command === "version") {
      process.stdout.write("Massion AgentOS 1.0.0\n");
      return 0;
    }
    if (invocation.command === "update" || invocation.command === "upgrade") {
      if (invocation.arguments.length > 1)
        throw new Error(`massion ${invocation.command}에는 버전을 하나만 지정할 수 있습니다`);
      const arguments_ = [invocation.command === "upgrade" ? "--apply" : "--check"];
      if (invocation.arguments[0]) arguments_.push(invocation.arguments[0]);
      if (invocation.output === "json") arguments_.push("--json");
      return await runReleaseUpdater(arguments_);
    }
    if (invocation.command === "local") {
      const manager = new LocalDaemonManager();
      let value;
      if (invocation.subcommand === "start") value = await manager.start();
      else if (invocation.subcommand === "status") value = await manager.status();
      else if (invocation.subcommand === "backup") value = await manager.backup(invocation.arguments[0]);
      else if (invocation.subcommand === "stop") value = await manager.stop();
      else {
        let endpoint: string | undefined;
        try {
          const config = await new CliConfigStore().load();
          endpoint = config.profiles[config.selectedProfile]?.endpoint;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        const prepared = await ensureLocalEndpoint(endpoint, { start: async () => await manager.start() });
        value = prepared ? await manager.status() : { status: "skipped", reason: "remote-profile" };
      }
      process.stdout.write(
        renderCliOutput(value, invocation.output, {
          tty: process.stdout.isTTY,
          noColor: process.env.NO_COLOR !== undefined,
        }),
      );
      return value.status === "foreign" ? 5 : 0;
    }
    if (invocation.command === "init") {
      let endpoint = invocation.arguments[0] ?? defaultLocalEndpoint();
      let email = invocation.arguments[1];
      let displayName = invocation.arguments.slice(2).join(" ");
      if (!email && !displayName && process.stdin.isTTY && process.stdout.isTTY) {
        const onboarding = createOnboardingPrompt({ environment: process.env });
        try {
          const answers = await onboarding.collect();
          endpoint = invocation.arguments[0] ?? answers.endpoint;
          email = answers.email;
          displayName = answers.displayName;
        } finally {
          onboarding.readline.close();
        }
      }
      if (!email || !displayName) throw new Error("사용법: massion init [endpoint] <email> <display name>");
      await ensureLocalEndpoint(endpoint, { start: async () => await new LocalDaemonManager().start() });
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
            ...(invocation.correlationId === undefined ? {} : { correlationId: invocation.correlationId }),
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
      connectServerSubscription: async (connection) =>
        await connectLocalServerSubscription(authenticated, connection, {
          endpoint: profile.endpoint,
          connectorDirectory: resolveLocalPaths().connectorDirectory,
          environment: process.env,
        }),
      connectServerModelSubscription: async (connection) => {
        assertSecretTransportEndpoint(profile.endpoint);
        return await authenticated.command({
          schemaVersion: "massion.application.v1",
          commandId: randomUUID(),
          correlationId: randomUUID(),
          operation: "subscription.server.connect-model",
          payload: connection,
        });
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
