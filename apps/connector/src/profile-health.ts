import { execFile, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { NodeAcpClientFactory, type AcpClientFactory } from "@massion/runtime";
import { isPaidCodexPlanType } from "@massion/subscriptions";

import type { EdgeProviderId } from "./identity-store.js";
import { assertSecureProviderProfileRoot } from "./profile-permissions.js";
import type { EdgeRuntimeArtifact } from "./runtime-artifact.js";

export type ProviderProfileAuthKind = "cli-profile" | "api-key";

export interface ProviderProfileHealth {
  readonly authKind: ProviderProfileAuthKind;
}

export interface ProviderProfileHealthProbe {
  verify(input: {
    readonly providerId: EdgeProviderId;
    readonly profileRoot: string;
    readonly expectedAuthKind: ProviderProfileAuthKind;
    readonly billingKind:
      "consumer-subscription" | "organization-subscription" | "enterprise-subscription" | "api-usage";
    readonly runtimeArtifact?: EdgeRuntimeArtifact;
    readonly signal?: AbortSignal;
  }): Promise<ProviderProfileHealth>;
}

export interface PinnedProviderProfileHealthProbeOptions {
  readonly codexAccount?: (profileRoot: string, signal?: AbortSignal) => Promise<unknown>;
  readonly claudeStatus?: (profileRoot: string, signal?: AbortSignal) => Promise<unknown>;
  readonly acpSession?: (input: {
    readonly providerId: EdgeProviderId;
    readonly profileRoot: string;
    readonly runtimeArtifact: EdgeRuntimeArtifact;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly acpFactory?: AcpClientFactory;
}

export class ProviderReauthenticationRequiredError extends Error {
  public readonly code = "needs-reauth" as const;

  public constructor() {
    super("Provider profile에 재인증이 필요합니다");
    this.name = "ProviderReauthenticationRequiredError";
  }
}

const executeFile = promisify(execFile);
const localRequire = createRequire(import.meta.url);

function runtimeRoot(): string {
  const runtimeEntry = localRequire.resolve("@massion/runtime");
  return dirname(dirname(runtimeEntry));
}

function codexAuthKind(
  value: unknown,
  billingKind: "consumer-subscription" | "organization-subscription" | "enterprise-subscription" | "api-usage",
): ProviderProfileAuthKind {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderReauthenticationRequiredError();
  }
  const status = value as Record<string, unknown>;
  if (status.requiresOpenaiAuth !== true || !status.account || typeof status.account !== "object") {
    throw new ProviderReauthenticationRequiredError();
  }
  const account = status.account as Record<string, unknown>;
  if (account.type === "chatgpt" && billingKind === "consumer-subscription" && isPaidCodexPlanType(account.planType)) {
    return "cli-profile";
  }
  if (account.type === "apiKey" && billingKind === "api-usage") return "api-key";
  throw new ProviderReauthenticationRequiredError();
}

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) =>
      child.once("close", () => {
        resolve();
      }),
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref();
    }),
  ]);
  child.kill("SIGKILL");
}

async function readCodexAccount(executable: string, profileRoot: string, signal?: AbortSignal): Promise<unknown> {
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      CODEX_HOME: profileRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let receivedBytes = 0;
  let terminalError: Error | undefined;
  const waiters = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const fail = (): void => {
    terminalError ??= new Error("Codex account health RPC를 완료하지 못했습니다");
    for (const waiter of waiters.values()) waiter.reject(terminalError);
    waiters.clear();
  };
  const parseLine = (line: string): void => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      fail();
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const response = value as JsonRpcResponse;
    if (!Number.isSafeInteger(response.id)) return;
    const waiter = waiters.get(Number(response.id));
    if (!waiter) return;
    waiters.delete(Number(response.id));
    if (response.error !== undefined) waiter.reject(new Error("Codex account health RPC가 거부됐습니다"));
    else waiter.resolve(response.result);
  };
  child.stdout.on("data", (chunk: string) => {
    receivedBytes += Buffer.byteLength(chunk, "utf8");
    if (receivedBytes > 256 * 1024) {
      fail();
      child.kill("SIGKILL");
      return;
    }
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) parseLine(line);
    }
  });
  child.once("error", fail);
  child.once("close", fail);
  const onAbort = (): void => {
    fail();
    child.kill("SIGKILL");
  };
  operationSignal.addEventListener("abort", onAbort, { once: true });
  const request = (id: number, method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (terminalError) {
        reject(terminalError);
        return;
      }
      waiters.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        waiters.delete(id);
        reject(new Error("Codex account health RPC를 전송하지 못했습니다"));
      });
    });
  try {
    await request(1, "initialize", {
      clientInfo: { name: "massion_edge_connector", title: "Massion Edge Connector", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await request(2, "account/read", { refreshToken: true });
  } finally {
    operationSignal.removeEventListener("abort", onAbort);
    await stopProcess(child);
  }
}

function claudeAuthKind(value: unknown): ProviderProfileAuthKind {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderReauthenticationRequiredError();
  }
  const status = value as Record<string, unknown>;
  if (status.loggedIn !== true || status.apiProvider !== "firstParty") {
    throw new ProviderReauthenticationRequiredError();
  }
  if (status.authMethod === "claude.ai") return "cli-profile";
  if (status.authMethod === "api_key") return "api-key";
  throw new ProviderReauthenticationRequiredError();
}

function musl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown } };
  return typeof report.header?.glibcVersionRuntime !== "string";
}

function claudePlatformPackage(): string {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!architecture || !new Set(["darwin", "linux", "win32"]).has(process.platform)) {
    throw new Error("현재 platform의 Claude profile health probe를 지원하지 않습니다");
  }
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${architecture}${
    process.platform === "linux" && musl() ? "-musl" : ""
  }`;
}

async function claudeExecutable(): Promise<string> {
  const sdkRoot = await realpath(join(runtimeRoot(), "node_modules", "@anthropic-ai", "claude-agent-sdk"));
  const packageName = claudePlatformPackage();
  const metadataPath = createRequire(join(sdkRoot, "package.json")).resolve(`${packageName}/package.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).name !== packageName
  ) {
    throw new Error("Claude profile health runtime 계보가 일치하지 않습니다");
  }
  return await realpath(join(dirname(metadataPath), process.platform === "win32" ? "claude.exe" : "claude"));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Provider profile 인증 확인이 중단됐습니다");
}

export class PinnedProviderProfileHealthProbe implements ProviderProfileHealthProbe {
  public constructor(private readonly options: PinnedProviderProfileHealthProbeOptions = {}) {}

  public async verify(input: {
    readonly providerId: EdgeProviderId;
    readonly profileRoot: string;
    readonly expectedAuthKind: ProviderProfileAuthKind;
    readonly billingKind:
      "consumer-subscription" | "organization-subscription" | "enterprise-subscription" | "api-usage";
    readonly runtimeArtifact?: EdgeRuntimeArtifact;
    readonly signal?: AbortSignal;
  }): Promise<ProviderProfileHealth> {
    assertNotAborted(input.signal);
    const profileRoot = await assertSecureProviderProfileRoot(input.profileRoot);
    let authKind: ProviderProfileAuthKind;
    try {
      if (input.providerId === "openai-codex") {
        authKind = codexAuthKind(
          await (this.options.codexAccount ?? this.codex.bind(this))(profileRoot, input.signal),
          input.billingKind,
        );
      } else if (input.providerId === "anthropic-claude-code") {
        authKind = claudeAuthKind(
          await (this.options.claudeStatus ?? this.claude.bind(this))(profileRoot, input.signal),
        );
      } else {
        if (input.expectedAuthKind !== "cli-profile" || !input.runtimeArtifact) {
          throw new ProviderReauthenticationRequiredError();
        }
        await (this.options.acpSession ?? this.acp.bind(this))({
          providerId: input.providerId,
          profileRoot,
          runtimeArtifact: input.runtimeArtifact,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        authKind = "cli-profile";
      }
    } catch (error) {
      assertNotAborted(input.signal);
      if (error instanceof ProviderReauthenticationRequiredError) throw error;
      throw new ProviderReauthenticationRequiredError();
    }
    if (authKind !== input.expectedAuthKind) throw new ProviderReauthenticationRequiredError();
    return { authKind };
  }

  private async codex(profileRoot: string, signal?: AbortSignal): Promise<unknown> {
    const sdkRoot = await realpath(join(runtimeRoot(), "node_modules", "@openai", "codex-sdk"));
    const executable = await realpath(join(sdkRoot, "node_modules", ".bin", "codex"));
    return await readCodexAccount(executable, profileRoot, signal);
  }

  private async claude(profileRoot: string, signal?: AbortSignal): Promise<unknown> {
    const executable = await claudeExecutable();
    const result = await executeFile(executable, ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      signal,
      env: {
        CLAUDE_CONFIG_DIR: profileRoot,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        DISABLE_AUTOUPDATER: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new ProviderReauthenticationRequiredError();
    }
  }

  private async acp(input: {
    readonly providerId: EdgeProviderId;
    readonly profileRoot: string;
    readonly runtimeArtifact: EdgeRuntimeArtifact;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const contract =
      input.providerId === "google-gemini-cli-enterprise"
        ? { arguments: ["--acp"], profileVariable: "GEMINI_CLI_HOME" }
        : input.providerId === "github-copilot"
          ? { arguments: ["--acp", "--stdio"], profileVariable: "COPILOT_HOME" }
          : input.providerId === "xai-grok-build"
            ? {
                arguments: ["--no-auto-update", "agent", "stdio"],
                profileVariable: "GROK_HOME",
                authenticationMethod: "cached_token",
              }
            : undefined;
    if (!contract) throw new ProviderReauthenticationRequiredError();
    const operationSignal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const client = await (this.options.acpFactory ?? new NodeAcpClientFactory()).create({
      executable: input.runtimeArtifact.executable,
      args: contract.arguments,
      cwd: input.profileRoot,
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: `${dirname(input.runtimeArtifact.executable)}:/usr/bin:/bin`,
        [contract.profileVariable]: input.profileRoot,
      },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
      ...(contract.authenticationMethod ? { authenticationMethod: contract.authenticationMethod } : {}),
      signal: operationSignal,
    });
    try {
      await client.openSession({ workspaceRoot: input.profileRoot, signal: operationSignal });
    } finally {
      await client.close();
    }
  }
}
