import { isAbsolute } from "node:path";

import { EdgeConnectorClient } from "./client.js";
import { enrollEdgeConnector } from "./enrollment.js";
import { EdgeRequestExecutor } from "./executor.js";
import {
  ConnectorIdentityStore,
  type ActiveConnectorIdentity,
  type EdgeBillingKind,
  type EdgeProviderId,
  readOwnerOnlySecret,
} from "./identity-store.js";
import {
  ProviderProfileOwnershipError,
  ProviderProfilePathError,
  ProviderProfilePermissionError,
  secureProviderProfileRoot,
} from "./profile-permissions.js";
import { ProviderReauthenticationRequiredError, type ProviderProfileAuthKind } from "./profile-health.js";

export type ConnectorCliInvocation =
  | {
      readonly command: "enroll";
      readonly baseUrl: string;
      readonly tokenFile: string;
      readonly enrollmentFile: string;
      readonly identityFile: string;
      readonly providerId: EdgeProviderId;
      readonly alias: string;
      readonly authKind: ProviderProfileAuthKind;
      readonly billingKind: EdgeBillingKind;
      readonly profileRoot: string;
      readonly workspaceRoots: readonly string[];
      readonly runtimeExecutable?: string;
      readonly acceptExperimental?: true;
    }
  | { readonly command: "run"; readonly identityFile: string }
  | { readonly command: "secure-profile"; readonly profileRoot: string };

export interface ConnectorCliDependencies {
  readonly enroll?: typeof enrollEdgeConnector;
  readonly loadIdentity?: (path: string) => Promise<ActiveConnectorIdentity>;
  readonly run?: (identity: ActiveConnectorIdentity, signal?: AbortSignal) => Promise<void>;
  readonly secureProfile?: (path: string) => Promise<string>;
  readonly readStdin?: () => Promise<string>;
  readonly output?: (line: string) => void;
  readonly signal?: AbortSignal;
}

const SENSITIVE_FLAGS = new Set(["--token", "--enrollment-code", "--private-key", "--authorization"]);

export function connectorCliFailureMessage(error: unknown): string {
  if (error instanceof ProviderProfilePermissionError) {
    return "massion-connector: secure-profile 명령으로 Provider profile을 owner-only 0700으로 보호해주세요";
  }
  if (error instanceof ProviderProfileOwnershipError) {
    return "massion-connector: Provider profile은 현재 사용자 소유여야 합니다";
  }
  if (error instanceof ProviderProfilePathError) {
    return "massion-connector: Provider profile은 symlink 없는 실제 디렉터리 절대 경로여야 합니다";
  }
  if (error instanceof ProviderReauthenticationRequiredError) {
    return "massion-connector: needs-reauth — Provider profile에 다시 로그인해주세요";
  }
  return "massion-connector: 요청을 안전하게 완료하지 못했습니다";
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 값이 필요합니다`);
  return value;
}

function parseFlags(arguments_: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Connector CLI flag와 값이 유효하지 않습니다");
    }
    if (SENSITIVE_FLAGS.has(flag)) throw new Error("비밀 값은 argv에서 허용하지 않습니다");
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }
  return flags;
}

function one(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name);
  if (!values || values.length !== 1) throw new Error(`${name} flag가 정확히 한 번 필요합니다`);
  return required(values[0], name);
}

function exactFlags(flags: Map<string, string[]>, allowed: readonly string[]): void {
  const unknown = [...flags.keys()].find((flag) => !allowed.includes(flag));
  if (unknown) throw new Error(`알 수 없는 Connector CLI flag입니다: ${unknown}`);
}

export function parseConnectorCli(arguments_: readonly string[]): ConnectorCliInvocation {
  const command = arguments_[0];
  if (command !== "enroll" && command !== "run" && command !== "secure-profile")
    throw new Error("Connector CLI command는 enroll, run 또는 secure-profile이어야 합니다");
  const flags = parseFlags(arguments_.slice(1));
  if (command === "secure-profile") {
    exactFlags(flags, ["--profile-root"]);
    return { command, profileRoot: one(flags, "--profile-root") };
  }
  if (command === "run") {
    exactFlags(flags, ["--identity-file"]);
    return { command, identityFile: one(flags, "--identity-file") };
  }
  const allowed = [
    "--base-url",
    "--token-file",
    "--enrollment-file",
    "--identity-file",
    "--provider",
    "--alias",
    "--auth",
    "--billing",
    "--profile-root",
    "--runtime-executable",
    "--accept-experimental",
    "--workspace-root",
  ];
  exactFlags(flags, allowed);
  const provider = one(flags, "--provider");
  const providers = new Set<EdgeProviderId>([
    "openai-codex",
    "anthropic-claude-code",
    "google-gemini-cli-enterprise",
    "github-copilot",
    "xai-grok-build",
  ]);
  if (!providers.has(provider as EdgeProviderId)) {
    throw new Error("--provider가 Edge Connector 지원 범위에 없습니다");
  }
  const providerId = provider as EdgeProviderId;
  const authKind = one(flags, "--auth");
  if (authKind !== "cli-profile" && authKind !== "api-key") {
    throw new Error("--auth는 cli-profile 또는 api-key여야 합니다");
  }
  const external =
    providerId === "google-gemini-cli-enterprise" || providerId === "github-copilot" || providerId === "xai-grok-build";
  if (external && authKind !== "cli-profile") {
    throw new Error("외부 ACP Provider는 ambient token 없는 cli-profile 인증만 지원합니다");
  }
  const billing = one(flags, "--billing");
  const billingByProvider: Readonly<Record<EdgeProviderId, ReadonlySet<string>>> = {
    "openai-codex": new Set(["consumer-subscription", "api-usage"]),
    "anthropic-claude-code": new Set(["consumer-subscription", "api-usage"]),
    "google-gemini-cli-enterprise": new Set(["enterprise-subscription"]),
    "github-copilot": new Set(["consumer-subscription", "organization-subscription"]),
    "xai-grok-build": new Set(["consumer-subscription"]),
  };
  if (!billingByProvider[providerId].has(billing)) {
    throw new Error("--billing 값이 유효하지 않습니다");
  }
  const runtimeExecutable = flags.has("--runtime-executable") ? one(flags, "--runtime-executable") : undefined;
  if (external && (!runtimeExecutable || !isAbsolute(runtimeExecutable))) {
    throw new Error("외부 ACP Provider에는 절대 경로 --runtime-executable 실행 파일이 필요합니다");
  }
  if (!external && runtimeExecutable !== undefined) {
    throw new Error("Bundled Provider에는 --runtime-executable을 지정할 수 없습니다");
  }
  const experimental = flags.has("--accept-experimental") ? one(flags, "--accept-experimental") : undefined;
  if (external && experimental !== "true") {
    throw new Error("외부 ACP Provider 연결에는 --accept-experimental true 동의가 필요합니다");
  }
  if (!external && experimental !== undefined) {
    throw new Error("기본 지원 Provider에는 --accept-experimental을 지정할 수 없습니다");
  }
  const workspaceRoots = flags.get("--workspace-root") ?? [];
  if (workspaceRoots.length !== 1) throw new Error("Massion 전용 --workspace-root가 정확히 1개 필요합니다");
  return {
    command,
    baseUrl: one(flags, "--base-url"),
    tokenFile: one(flags, "--token-file"),
    enrollmentFile: one(flags, "--enrollment-file"),
    identityFile: one(flags, "--identity-file"),
    providerId,
    alias: one(flags, "--alias"),
    authKind,
    billingKind: billing as EdgeBillingKind,
    profileRoot: one(flags, "--profile-root"),
    workspaceRoots,
    ...(runtimeExecutable ? { runtimeExecutable } : {}),
    ...(experimental === "true" ? { acceptExperimental: true as const } : {}),
  };
}

async function stdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if (typeof chunk !== "string") throw new Error("Enrollment stdin 형식이 유효하지 않습니다");
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > 64 * 1024) throw new Error("Enrollment stdin byte 상한을 초과했습니다");
    chunks.push(chunk);
  }
  return chunks.join("");
}

function enrollmentJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Enrollment JSON이 유효하지 않습니다");
  }
}

async function defaultRun(identity: ActiveConnectorIdentity, signal?: AbortSignal): Promise<void> {
  const executor = new EdgeRequestExecutor({ identity });
  const client = new EdgeConnectorClient({ identity, executor });
  await client.run(signal);
}

export async function executeConnectorCli(
  invocation: ConnectorCliInvocation,
  dependencies: ConnectorCliDependencies = {},
): Promise<void> {
  const output = dependencies.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (invocation.command === "secure-profile") {
    await (dependencies.secureProfile ?? secureProviderProfileRoot)(invocation.profileRoot);
    output(JSON.stringify({ schemaVersion: "massion.edge-connector.cli.v1", status: "profile-secured" }));
    return;
  }
  if (invocation.command === "run") {
    if (!isAbsolute(invocation.identityFile)) throw new Error("Identity file은 절대 경로여야 합니다");
    const identity = await (
      dependencies.loadIdentity ?? (async (path) => await new ConnectorIdentityStore(path).loadActive())
    )(invocation.identityFile);
    output(
      JSON.stringify({
        schemaVersion: "massion.edge-connector.cli.v1",
        status: "running",
        connectorId: identity.connectorId,
      }),
    );
    await (dependencies.run ?? defaultRun)(identity, dependencies.signal);
    output(
      JSON.stringify({
        schemaVersion: "massion.edge-connector.cli.v1",
        status: "stopped",
        connectorId: identity.connectorId,
      }),
    );
    return;
  }
  const encodedEnrollment =
    invocation.enrollmentFile === "-"
      ? await (dependencies.readStdin ?? stdin)()
      : await readOwnerOnlySecret(invocation.enrollmentFile, "Enrollment JSON 파일");
  const result = await (dependencies.enroll ?? enrollEdgeConnector)({
    baseUrl: invocation.baseUrl,
    tokenFile: invocation.tokenFile,
    identityFile: invocation.identityFile,
    enrollment: enrollmentJson(encodedEnrollment),
    providerId: invocation.providerId,
    alias: invocation.alias,
    authKind: invocation.authKind,
    billingKind: invocation.billingKind,
    profileRoot: invocation.profileRoot,
    workspaceRoots: invocation.workspaceRoots,
    ...(invocation.runtimeExecutable ? { runtimeExecutable: invocation.runtimeExecutable } : {}),
    ...(invocation.acceptExperimental ? { acceptExperimental: true } : {}),
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  output(
    JSON.stringify({
      schemaVersion: "massion.edge-connector.cli.v1",
      status: "enrolled",
      connectorId: result.identity.connectorId,
      accountId: result.account.accountId,
      alias: result.account.alias,
      accountStatus: result.account.status,
    }),
  );
}
