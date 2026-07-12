import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";

import {
  inspectBundledSubscriptionRuntime,
  type BundledSubscriptionRuntimeArtifact,
  type BundledSubscriptionRuntimeId,
} from "@massion/runtime";
import type { MassionDatabase } from "@massion/storage";
import type {
  ServerConnectorRuntimeAttestor,
  VerifiedServerConnectorHealth,
  VerifiedServerRuntimeArtifact,
} from "@massion/subscriptions";
import { isPaidCodexPlanType } from "@massion/subscriptions";

import {
  inspectBuiltinModelRuntime,
  type BuiltinModelRuntimeArtifact,
  type BuiltinModelRuntimeId,
} from "./builtin-model-runtime.js";
import { withCodexAppServer } from "./codex-app-server.js";
import { prepareSubscriptionProfileRoot } from "./subscription-profile.js";

interface AccountBindingRecord {
  readonly account_id: string;
  readonly owner_user_id: string;
  readonly provider_id: string;
  readonly connector_id: string;
  readonly billing_kind: string;
  readonly status: string;
}

interface ConnectorStateRecord {
  readonly status: string;
}

interface ModelCredentialRecord {
  readonly credential_id: string;
  readonly subscription_account_id: string;
  readonly subscription_connector_id: string;
  readonly provider_id: string;
  readonly material_kind: string;
  readonly status: string;
  readonly secret_version: number;
}

interface SecretVersionRecord {
  readonly credential_id: string;
  readonly version: number;
  readonly algorithm: string;
}

export interface RuntimeStatusRunner {
  (
    command: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
  ): Promise<{ readonly stdout: string }>;
}

export interface CodexAccountReader {
  (
    command: string,
    commandArguments: readonly string[],
    environment: Readonly<Record<string, string>>,
  ): Promise<unknown>;
}

export interface BundledServerConnectorRuntimeAttestorOptions {
  readonly profileRoot: string;
  readonly inspectRuntime?: (runtimeId: BundledSubscriptionRuntimeId) => Promise<BundledSubscriptionRuntimeArtifact>;
  readonly inspectModelRuntime?: (runtimeId: BuiltinModelRuntimeId) => Promise<BuiltinModelRuntimeArtifact>;
  readonly run?: RuntimeStatusRunner;
  readonly codexAccount?: CodexAccountReader;
}

const STATUS_OUTPUT_MAX_BYTES = 64 * 1024;
const STATUS_TIMEOUT_MS = 15_000;
function runtimePath(): string {
  return process.platform === "win32"
    ? dirname(process.execPath)
    : `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`;
}

type SupportedRuntimeId = BundledSubscriptionRuntimeId | BuiltinModelRuntimeId;

function runtimeId(value: string): SupportedRuntimeId {
  if (value !== "codex" && value !== "claude" && value !== "openai-model") {
    throw new Error("지원하지 않는 서버 runtime입니다");
  }
  return value;
}

function expectedProvider(value: BundledSubscriptionRuntimeId): string {
  return value === "codex" ? "openai-codex" : "anthropic-claude-code";
}

function isBundledAgentRuntime(value: SupportedRuntimeId): value is BundledSubscriptionRuntimeId {
  return value === "codex" || value === "claude";
}

async function defaultStatusRunner(
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string }> {
  return await new Promise<{ readonly stdout: string }>((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      shell: false,
      windowsHide: true,
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(chunks, bytes).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Provider 인증 상태 확인 시간이 초과되었습니다"));
    }, STATUS_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > STATUS_OUTPUT_MAX_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Provider 인증 상태 출력 상한을 초과했습니다"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      finish(new Error("Provider 인증 상태 process를 시작하지 못했습니다"));
    });
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("Provider 인증 상태가 준비되지 않았습니다"));
      else finish();
    });
  });
}

function verifiedArtifact(
  artifact: BundledSubscriptionRuntimeArtifact | BuiltinModelRuntimeArtifact,
): VerifiedServerRuntimeArtifact {
  return {
    runtimeId: artifact.runtimeId,
    runtimeArtifactDigest: artifact.runtimeArtifactDigest,
    version: artifact.version,
  };
}

function verifyCodexSubscription(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex ChatGPT 구독 인증 상태를 확인할 수 없습니다");
  }
  const result = value as { readonly requiresOpenaiAuth?: unknown; readonly account?: unknown };
  const account = result.account as { readonly type?: unknown; readonly planType?: unknown } | undefined;
  if (
    result.requiresOpenaiAuth !== true ||
    !account ||
    typeof account !== "object" ||
    Array.isArray(account) ||
    account.type !== "chatgpt" ||
    !isPaidCodexPlanType(account.planType)
  ) {
    throw new Error("Codex ChatGPT 구독 인증 상태를 확인할 수 없습니다");
  }
}

export async function readCodexAppServerAccount(
  command: string,
  commandArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<unknown> {
  return await withCodexAppServer(
    command,
    commandArguments,
    environment,
    async (session) => await session.request("account/read", { refreshToken: true }),
    { timeoutMs: STATUS_TIMEOUT_MS, maximumOutputBytes: STATUS_OUTPUT_MAX_BYTES },
  );
}

function verifyClaudeSubscription(output: string): void {
  if (Buffer.byteLength(output, "utf8") > STATUS_OUTPUT_MAX_BYTES) {
    throw new Error("Claude 인증 상태 출력 상한을 초과했습니다");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Claude 구독 인증 상태를 확인할 수 없습니다");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    (decoded as { loggedIn?: unknown }).loggedIn !== true ||
    (decoded as { authMethod?: unknown }).authMethod !== "claude.ai" ||
    (decoded as { apiProvider?: unknown }).apiProvider !== "firstParty"
  ) {
    throw new Error("Claude 구독 인증 상태를 확인할 수 없습니다");
  }
}

export class BundledServerConnectorRuntimeAttestor implements ServerConnectorRuntimeAttestor {
  private readonly inspectRuntime: NonNullable<BundledServerConnectorRuntimeAttestorOptions["inspectRuntime"]>;
  private readonly inspectModelRuntime: NonNullable<
    BundledServerConnectorRuntimeAttestorOptions["inspectModelRuntime"]
  >;
  private readonly run: RuntimeStatusRunner;
  private readonly codexAccount: CodexAccountReader;
  private readonly generations = new Map<string, number>();
  private readonly modelArtifacts = new Map<BuiltinModelRuntimeId, Promise<BuiltinModelRuntimeArtifact>>();

  public constructor(
    private readonly database: Pick<MassionDatabase, "query">,
    private readonly options: BundledServerConnectorRuntimeAttestorOptions,
  ) {
    this.inspectRuntime = options.inspectRuntime ?? inspectBundledSubscriptionRuntime;
    this.inspectModelRuntime = options.inspectModelRuntime ?? inspectBuiltinModelRuntime;
    this.run = options.run ?? defaultStatusRunner;
    this.codexAccount = options.codexAccount ?? readCodexAppServerAccount;
  }

  public async inspectArtifact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly providerId: string;
    readonly executionKind: "model" | "agent-runtime";
    readonly runtimeId: string;
  }): Promise<VerifiedServerRuntimeArtifact> {
    void input.organizationId;
    void input.actorUserId;
    const selected = runtimeId(input.runtimeId);
    if (selected === "openai-model") {
      if (input.executionKind !== "model" || input.providerId !== "minimax-token-plan") {
        throw new Error("서버 내장 모델 runtime과 Provider 계약이 일치하지 않습니다");
      }
      return verifiedArtifact(await this.modelArtifact(selected));
    }
    if (input.executionKind !== "agent-runtime" || input.providerId !== expectedProvider(selected)) {
      throw new Error("서버 bundled runtime과 Provider 계약이 일치하지 않습니다");
    }
    return verifiedArtifact(await this.inspectRuntime(selected));
  }

  public async attestHealth(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly connectorId: string;
    readonly providerId: string;
    readonly executionKind: "model" | "agent-runtime";
    readonly runtimeId: string;
    readonly runtimeArtifactDigest: string;
    readonly version: string;
    readonly previousProcessGeneration?: number;
  }): Promise<VerifiedServerConnectorHealth> {
    const selected = runtimeId(input.runtimeId);
    const artifact = isBundledAgentRuntime(selected)
      ? await this.inspectRuntime(selected)
      : await this.modelArtifact(selected);
    if (
      (isBundledAgentRuntime(selected)
        ? input.executionKind !== "agent-runtime" || input.providerId !== expectedProvider(selected)
        : input.executionKind !== "model" || input.providerId !== "minimax-token-plan") ||
      artifact.runtimeId !== selected ||
      artifact.runtimeArtifactDigest !== input.runtimeArtifactDigest ||
      artifact.version !== input.version
    ) {
      throw new Error("서버 Runtime artifact 건강 계보가 일치하지 않습니다");
    }
    const account = await this.account(input.organizationId, input.connectorId, input.providerId);
    if (selected === "openai-model") {
      if (account.billing_kind !== "token-plan") {
        throw new Error("서버 내장 MiniMax runtime은 Token Plan 계정만 건강 증명할 수 있습니다");
      }
      await this.modelCredential(input.organizationId, input.connectorId, input.providerId, account.account_id);
    } else {
      if (account.billing_kind !== "consumer-subscription") {
        throw new Error("서버 bundled runtime은 소비자 구독 계정만 건강 증명할 수 있습니다");
      }
      const profileRoot = await prepareSubscriptionProfileRoot(
        this.options.profileRoot,
        input.organizationId,
        account.account_id,
      );
      try {
        if (selected === "codex") {
          if (!("command" in artifact)) throw new Error("Codex runtime artifact 계보가 일치하지 않습니다");
          const result = await this.codexAccount(artifact.command, artifact.commandArguments, {
            CODEX_HOME: profileRoot,
            HOME: profileRoot,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NO_COLOR: "1",
            PATH: runtimePath(),
          });
          verifyCodexSubscription(result);
        } else {
          if (!("command" in artifact)) throw new Error("Claude runtime artifact 계보가 일치하지 않습니다");
          const result = await this.run(artifact.command, ["auth", "status", "--json"], {
            CLAUDE_CONFIG_DIR: profileRoot,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            HOME: profileRoot,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NO_COLOR: "1",
            PATH: runtimePath(),
          });
          verifyClaudeSubscription(result.stdout);
        }
      } catch {
        throw new Error("Provider 구독 인증 상태를 확인할 수 없습니다");
      }
    }

    const key = `${input.organizationId}\0${input.connectorId}`;
    const activeGeneration = this.generations.get(key);
    const connectorStatus = await this.connectorStatus(input.organizationId, input.connectorId);
    if (activeGeneration !== undefined && connectorStatus === "ready") {
      if (input.previousProcessGeneration !== activeGeneration) {
        throw new Error("서버 Runtime의 기존 process generation이 일치하지 않습니다");
      }
      return {
        runtimeId: selected,
        runtimeArtifactDigest: artifact.runtimeArtifactDigest,
        processGeneration: activeGeneration,
        processState: "same-process",
      };
    }
    if (connectorStatus !== "offline") throw new Error("서버 Connector를 건강 증명할 수 없는 상태입니다");
    this.generations.delete(key);
    const previous = input.previousProcessGeneration ?? 0;
    const processGeneration = previous + 1;
    if (!Number.isSafeInteger(processGeneration))
      throw new Error("서버 Runtime process generation 상한을 초과했습니다");
    this.generations.set(key, processGeneration);
    return {
      runtimeId: selected,
      runtimeArtifactDigest: artifact.runtimeArtifactDigest,
      processGeneration,
      processState: "new-process",
    };
  }

  private async account(
    organizationId: string,
    connectorId: string,
    providerId: string,
  ): Promise<AccountBindingRecord> {
    const [accounts] = await this.database.query<[AccountBindingRecord[]]>(
      `SELECT account_id, owner_user_id, provider_id, connector_id, billing_kind, status
       FROM subscription_account
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND provider_id = $provider_id AND status IN ['active', 'offline', 'needs-reauth'];`,
      { organization_id: organizationId, connector_id: connectorId, provider_id: providerId },
    );
    if (accounts.length !== 1 || accounts[0] === undefined) {
      throw new Error("서버 Connector의 계정 계보가 하나로 확정되지 않았습니다");
    }
    return accounts[0];
  }

  private async modelArtifact(runtimeId: BuiltinModelRuntimeId): Promise<BuiltinModelRuntimeArtifact> {
    const existing = this.modelArtifacts.get(runtimeId);
    if (existing) return await existing;
    const inspected = this.inspectModelRuntime(runtimeId);
    this.modelArtifacts.set(runtimeId, inspected);
    try {
      return await inspected;
    } catch (error) {
      if (this.modelArtifacts.get(runtimeId) === inspected) this.modelArtifacts.delete(runtimeId);
      throw error;
    }
  }

  private async connectorStatus(organizationId: string, connectorId: string): Promise<string> {
    const [connectors] = await this.database.query<[ConnectorStateRecord[]]>(
      `SELECT status FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND trust_origin = 'server-managed' LIMIT 1;`,
      { organization_id: organizationId, connector_id: connectorId },
    );
    if (connectors.length !== 1 || connectors[0] === undefined) {
      throw new Error("서버 Connector 상태 계보를 찾을 수 없습니다");
    }
    return connectors[0].status;
  }

  private async modelCredential(
    organizationId: string,
    connectorId: string,
    providerId: string,
    accountId: string,
  ): Promise<void> {
    const [credentials] = await this.database.query<[ModelCredentialRecord[]]>(
      `SELECT credential_id, subscription_account_id, subscription_connector_id, provider_id,
              material_kind, status, secret_version
       FROM provider_credential
       WHERE organization_id = $organization_id AND subscription_connector_id = $connector_id
         AND subscription_account_id = $account_id AND provider_id = $provider_id
         AND material_kind = 'encrypted_secret' AND status = 'active';`,
      {
        organization_id: organizationId,
        connector_id: connectorId,
        account_id: accountId,
        provider_id: providerId,
      },
    );
    const credential = credentials[0];
    if (
      credentials.length !== 1 ||
      !credential ||
      credential.subscription_account_id !== accountId ||
      credential.subscription_connector_id !== connectorId ||
      credential.provider_id !== providerId ||
      credential.material_kind !== "encrypted_secret" ||
      credential.status !== "active" ||
      !Number.isSafeInteger(credential.secret_version) ||
      credential.secret_version < 1
    ) {
      throw new Error("서버 내장 모델의 암호화 Credential 계보가 하나로 확정되지 않았습니다");
    }
    const [versions] = await this.database.query<[SecretVersionRecord[]]>(
      `SELECT credential_id, version, algorithm FROM credential_secret_version
       WHERE organization_id = $organization_id AND credential_id = $credential_id
         AND version = $version LIMIT 1;`,
      {
        organization_id: organizationId,
        credential_id: credential.credential_id,
        version: credential.secret_version,
      },
    );
    const version = versions[0];
    if (
      versions.length !== 1 ||
      !version ||
      version.credential_id !== credential.credential_id ||
      version.version !== credential.secret_version ||
      version.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("서버 내장 모델의 암호화 secret version 계보가 일치하지 않습니다");
    }
  }
}
