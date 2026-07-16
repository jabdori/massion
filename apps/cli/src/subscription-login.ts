import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { ApplicationRemoteError } from "@massion/application";
import {
  codexFileCredentialStoreArguments,
  ensureManagedCodexProfile,
  inspectBundledSubscriptionRuntime,
  managedCodexCredentialState,
  type BundledSubscriptionRuntimeArtifact,
  type BundledSubscriptionRuntimeId,
} from "@massion/runtime";

export interface ServerSubscriptionLoginClient {
  status(): Promise<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
}

export interface ServerSubscriptionLoginInput {
  readonly providerId: string;
  readonly alias?: string;
  readonly modelId?: string;
  readonly newAccount?: boolean;
}

export interface ServerSubscriptionLoginOptions {
  readonly endpoint: string;
  readonly connectorDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly inspectRuntime?: (runtimeId: BundledSubscriptionRuntimeId) => Promise<BundledSubscriptionRuntimeArtifact>;
  readonly runInteractive?: (
    command: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<number>;
}

export type ServerSubscriptionConnectionDisposition = "new" | "reused" | "reauthenticated";

export interface LocalServerSubscriptionConnection {
  readonly status: "ready";
  readonly providerId: string;
  readonly alias: string;
  readonly accountId: string;
  readonly connectorId: string;
  /** 기존 profile을 실제로 재사용했는지 UAT와 UI가 안전하게 표시하는 공개 상태입니다. */
  readonly connectionDisposition: ServerSubscriptionConnectionDisposition;
}

interface ProviderLoginContract {
  readonly runtimeId: BundledSubscriptionRuntimeId;
  readonly defaultAlias: string;
  arguments(artifact: BundledSubscriptionRuntimeArtifact): readonly string[];
  environment(profileRoot: string): Readonly<Record<string, string>>;
}

interface PreparedBinding {
  readonly accountId: string;
  readonly connectorId: string;
  readonly profileHandle: string;
}

class DirectQuotaObservationMissingError extends Error {
  public constructor() {
    super("서버 구독 건강 증명의 Codex 직접 quota 관측 증거가 없습니다");
    this.name = "DirectQuotaObservationMissingError";
  }
}

interface PendingLogin {
  readonly schema: "massion.server-subscription-login.v1";
  readonly providerId: string;
  /**
   * 중단된 로그인 흐름을 다른 사용자 의도로 이어 붙이지 않기 위한 원래 요청입니다.
   * 새 계정 추가는 명시적인 선택이어야 하므로, 다음 실행에서도 다시 확인합니다.
   */
  readonly intent: "initial" | "new-account";
  readonly alias: string;
  readonly requestedModelId?: string;
  readonly phase: "login" | "prepare" | "attest";
  readonly stagingId: string;
  readonly prepareCommandId: string;
  readonly prepareCorrelationId: string;
  readonly attestCommandId: string;
  readonly attestCorrelationId: string;
  readonly prepared?: PreparedBinding;
}

interface ExistingCodexAccount {
  readonly accountId: string;
  readonly providerId: "openai-codex";
  readonly alias: string;
  readonly connectorId: string;
  readonly profileHandle: string;
  readonly accountStatus: string;
  readonly doctorAction: string;
}

const REUSABLE_ACCOUNT_STATUSES = new Set(["active", "offline", "cooldown", "needs-reauth"]);
const REUSABLE_CONNECTOR_STATUSES = new Set(["ready", "offline"]);
const DOCTOR_QUOTA_STATUSES = new Set(["available", "exhausted", "unknown"]);
const DOCTOR_ACTIONS = new Set(["none", "reauth", "reconnect", "wait-for-reset", "inspect"]);
const QUOTA_CONFIDENCES = new Set(["reported", "derived", "unknown"]);

const PROVIDERS: Readonly<Record<string, ProviderLoginContract>> = {
  "openai-codex": {
    runtimeId: "codex",
    defaultAlias: "OpenAI Codex",
    arguments: (artifact) => [...codexFileCredentialStoreArguments(artifact.commandArguments), "login"],
    environment: (profileRoot) => ({ CODEX_HOME: profileRoot }),
  },
};

export function listLocalSubscriptionLoginProviders(): readonly {
  readonly providerId: string;
  readonly displayName: string;
}[] {
  return Object.entries(PROVIDERS).map(([providerId, contract]) => ({
    providerId,
    displayName: contract.defaultAlias,
  }));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}가 유효하지 않습니다`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) throw new Error(`${label}가 유효하지 않습니다`);
  return normalized;
}

function profileHandle(value: unknown): string {
  const normalized = text(value, "구독 profile handle", 129);
  if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/u.test(normalized)) throw new Error("구독 profile handle이 유효하지 않습니다");
  return normalized;
}

function alias(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : text(value, "구독 계정 별칭", 128);
}

function requestedModelId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const selected = identifier(value, "Codex model ID");
  if (!new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]).has(selected)) {
    throw new Error("지원하지 않는 GPT-5.6 model ID입니다");
  }
  return selected;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** macOS의 시스템 경로 별칭만 허용하고, 그 밖의 상위 symlink는 관리 경계 밖으로 봅니다. */
function expectedCanonicalPath(path: string): string {
  const resolved = resolve(path);
  if (process.platform !== "darwin") return resolved;
  for (const alias of ["/var", "/tmp"]) {
    if (resolved === alias || resolved.startsWith(`${alias}${sep}`)) {
      return resolve("/private", resolved.slice(1));
    }
  }
  return resolved;
}

function canonicalPathMatches(path: string, canonical: string): boolean {
  return canonical === expectedCanonicalPath(path);
}

async function nearestExistingDirectory(
  path: string,
): Promise<{ readonly path: string; readonly missing: readonly string[] }> {
  let candidate = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("구독 profile directory가 안전하지 않습니다");
      }
      return { path: candidate, missing };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error("구독 profile directory의 상위 경로를 찾을 수 없습니다", { cause: error });
      }
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function ownerOnlyDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const existing = await nearestExistingDirectory(resolved);
  const canonicalParent = await realpath(existing.path);
  if (!canonicalPathMatches(existing.path, canonicalParent)) {
    throw new Error("구독 profile directory의 상위 symlink 경로를 사용할 수 없습니다");
  }
  const target = resolve(canonicalParent, ...existing.missing);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("구독 profile directory가 안전하지 않습니다");
  if ((metadata.mode & 0o077) !== 0) throw new Error("구독 profile directory는 owner-only여야 합니다");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("구독 profile directory는 현재 사용자 소유여야 합니다");
  }
  const canonical = await realpath(target);
  if (canonical !== target) throw new Error("구독 profile directory의 symlink 경로를 사용할 수 없습니다");
  return canonical;
}

async function directoryExists(path: string): Promise<boolean> {
  const resolved = resolve(path);
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error("구독 profile directory가 안전하지 않습니다");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("구독 profile directory는 현재 사용자 소유여야 합니다");
    }
    const canonical = await realpath(resolved);
    if (!canonicalPathMatches(resolved, canonical)) {
      throw new Error("구독 profile directory의 symlink 경로를 사용할 수 없습니다");
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const existing = await nearestExistingDirectory(resolved);
      const canonicalParent = await realpath(existing.path);
      if (!canonicalPathMatches(existing.path, canonicalParent)) {
        throw new Error("구독 profile directory의 상위 symlink 경로를 사용할 수 없습니다", { cause: error });
      }
      return false;
    }
    throw error;
  }
}

async function writePending(path: string, record: PendingLogin): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function pendingLogin(value: unknown, providerId: string): PendingLogin {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("구독 로그인 재개 상태가 유효하지 않습니다");
  const source = value as Partial<PendingLogin>;
  // v1 초기에 저장된 기존 연결은 새 계정 의도를 표현하지 않았습니다. 누락은 가장 보수적인 기존 연결로만 해석합니다.
  const intent = source.intent === undefined ? "initial" : source.intent;
  if (
    source.schema !== "massion.server-subscription-login.v1" ||
    source.providerId !== providerId ||
    !new Set(["initial", "new-account"]).has(intent) ||
    !new Set(["login", "prepare", "attest"]).has(source.phase ?? "") ||
    typeof source.alias !== "string" ||
    typeof source.stagingId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(source.stagingId) ||
    typeof source.prepareCommandId !== "string" ||
    typeof source.prepareCorrelationId !== "string" ||
    typeof source.attestCommandId !== "string" ||
    typeof source.attestCorrelationId !== "string"
  ) {
    throw new Error("구독 로그인 재개 상태가 유효하지 않습니다");
  }
  if (source.phase === "attest") {
    if (!source.prepared) throw new Error("구독 로그인 재개 상태에 준비 결과가 없습니다");
    identifier(source.prepared.accountId, "구독 계정 ID");
    identifier(source.prepared.connectorId, "서버 Connector ID");
    profileHandle(source.prepared.profileHandle);
  }
  requestedModelId(source.requestedModelId);
  return { ...source, intent } as PendingLogin;
}

async function readPending(path: string, providerId: string): Promise<PendingLogin | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) {
      throw new Error("구독 로그인 재개 파일이 안전하지 않습니다");
    }
    return pendingLogin(JSON.parse(await readFile(path, "utf8")) as unknown, providerId);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let pid: number;
      try {
        pid = Number((await readFile(path, "utf8")).trim());
      } catch (lockReadError) {
        throw new Error("구독 로그인 lock을 확인할 수 없습니다", { cause: lockReadError });
      }
      if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) {
        throw new Error("같은 Provider의 구독 로그인이 이미 진행 중입니다", { cause: error });
      }
      await rm(path, { force: true });
      continue;
    }
    try {
      await handle.writeFile(`${String(process.pid)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
    }
    return async () => {
      await handle.close();
      await rm(path, { force: true });
    };
  }
  throw new Error("구독 로그인 lock을 선점하지 못했습니다");
}

async function defaultInteractiveRunner(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolveProcess, reject) => {
    const child = spawn(command, [...arguments_], {
      shell: false,
      windowsHide: true,
      stdio: "inherit",
      env: environment,
    });
    child.once("error", (error) => {
      reject(new Error("Provider 로그인 process를 시작하지 못했습니다", { cause: error }));
    });
    child.once("close", (code) => {
      resolveProcess(code ?? 1);
    });
  });
}

function commandEnvelope(commandId: string, correlationId: string, operation: string, payload: unknown): unknown {
  return {
    schemaVersion: "massion.application.v1",
    commandId,
    correlationId,
    operation,
    payload,
  };
}

function parsePrepared(value: unknown): PreparedBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("서버 구독 준비 응답이 유효하지 않습니다");
  const response = value as { outcome?: unknown; resource?: { id?: unknown }; data?: Record<string, unknown> };
  if (response.outcome !== "succeeded" || !response.data) throw new Error("서버 구독 준비가 완료되지 않았습니다");
  const accountId = identifier(response.data.accountId, "구독 계정 ID");
  if (response.resource?.id !== accountId) throw new Error("서버 구독 계정 계보가 일치하지 않습니다");
  return {
    accountId,
    connectorId: identifier(response.data.connectorId, "서버 Connector ID"),
    profileHandle: profileHandle(response.data.profileHandle),
  };
}

function assertAttested(value: unknown, connectorId: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("서버 구독 건강 증명 응답이 유효하지 않습니다");
  const response = value as { outcome?: unknown; data?: Record<string, unknown> };
  if (
    response.outcome !== "succeeded" ||
    response.data?.connectorId !== connectorId ||
    response.data.status !== "ready"
  ) {
    throw new Error("서버 구독 Runtime이 준비 상태가 되지 않았습니다");
  }
  const quotaObservation = response.data.quotaObservation;
  if (!quotaObservation || typeof quotaObservation !== "object" || Array.isArray(quotaObservation)) {
    throw new DirectQuotaObservationMissingError();
  }
  const observation = quotaObservation as Record<string, unknown>;
  if (observation.source !== "direct") {
    throw new Error("서버 구독 건강 증명의 Codex quota 관측 출처가 유효하지 않습니다");
  }
  observedAt(observation.attestedAt, "Codex 직접 quota 건강 증명 시각");
}

function reauthenticationRequired(error: unknown): boolean {
  if (!(error instanceof ApplicationRemoteError) || error.status !== 401) return false;
  if (!error.body || typeof error.body !== "object" || Array.isArray(error.body)) return false;
  const body = error.body as { readonly category?: unknown; readonly operatorCode?: unknown };
  return body.category === "authentication" && body.operatorCode === "APP_SUBSCRIPTION_REAUTH_REQUIRED";
}

function assertLocalMode(value: unknown): void {
  if (!value || typeof value !== "object" || (value as { data?: { mode?: unknown } }).data?.mode !== "local") {
    throw new Error("서버 관리형 소비자 구독 로그인은 local mode에서만 사용할 수 있습니다");
  }
}

function queryRows(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 응답이 유효하지 않습니다`);
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error(`${label} data가 유효하지 않습니다`);
  return data.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} 항목이 유효하지 않습니다`);
    return item as Record<string, unknown>;
  });
}

function observedAt(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label}이 유효하지 않습니다`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label}이 유효하지 않습니다`);
  return timestamp;
}

function codexQuotaWindows(
  quota: Record<string, unknown>,
  labels: {
    readonly response: string;
    readonly observedAt: string;
    readonly window: string;
  },
): readonly Record<string, unknown>[] {
  if (!Array.isArray(quota.windows) || typeof quota.exhausted !== "boolean") {
    throw new Error(`${labels.response}가 유효하지 않습니다`);
  }
  observedAt(quota.observedAt, labels.observedAt);
  return quota.windows.map((window) => {
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      throw new Error(`${labels.window}가 유효하지 않습니다`);
    }
    const record = window as Record<string, unknown>;
    const kind = text(record.kind, `${labels.window} 종류`, 256);
    if (!kind.startsWith("codex:")) throw new Error(`${labels.window} 종류가 유효하지 않습니다`);
    observedAt(record.observedAt, `${labels.window} 관측 시각`);
    enumValue(record.confidence, `${labels.window} 신뢰도`, QUOTA_CONFIDENCES);
    if (
      record.remainingRatio !== undefined &&
      (typeof record.remainingRatio !== "number" ||
        !Number.isFinite(record.remainingRatio) ||
        record.remainingRatio < 0 ||
        record.remainingRatio > 1)
    ) {
      throw new Error(`${labels.window} 잔여 비율이 유효하지 않습니다`);
    }
    return record;
  });
}

/**
 * 건강 증명은 서버에서 Codex 할당량을 직접 다시 관측합니다. 이 확인은 이전
 * projection이 남아 있거나 아직 비어 있을 때 잘못된 "연결 완료"를 반환하지
 * 않도록, 해당 건강 증명 이후 기록된 공개 quota만 받아들입니다.
 */
async function assertFreshCodexQuota(
  client: ServerSubscriptionLoginClient,
  accountId: string,
  observedAfter: number,
): Promise<void> {
  const rows = queryRows(await client.query("subscription.quota", { accountId }), "구독 quota");
  if (rows.length !== 1 || rows[0]?.accountId !== accountId) {
    throw new Error("Codex quota 직접 관측 결과의 계보가 일치하지 않습니다");
  }
  const quota = rows[0];
  const windows = codexQuotaWindows(quota, {
    response: "Codex quota 직접 관측 결과",
    observedAt: "Codex quota 관측 시각",
    window: "Codex quota window",
  });
  if (observedAt(quota.observedAt, "Codex quota 관측 시각") < observedAfter) {
    throw new Error("Codex quota가 건강 증명 이후 새로 관측되지 않았습니다");
  }
  if (windows.length === 0) {
    throw new Error("Codex quota 직접 관측 결과가 비어 있습니다");
  }
  const hasFreshReportedCodexWindow = windows.some((record) => {
    return (
      typeof record.kind === "string" &&
      record.kind.startsWith("codex:") &&
      record.confidence === "reported" &&
      observedAt(record.observedAt, "Codex quota window 관측 시각") >= observedAfter
    );
  });
  if (!hasFreshReportedCodexWindow) {
    throw new Error("Codex quota 직접 관측 결과에 최신 reported window가 없습니다");
  }
}

function existingCodexAccount(value: Record<string, unknown>): ExistingCodexAccount {
  if (
    value.providerId !== "openai-codex" ||
    typeof value.accountId !== "string" ||
    typeof value.alias !== "string" ||
    typeof value.connectorId !== "string" ||
    value.connectorLocation !== "server" ||
    typeof value.profileHandle !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error("기존 Codex 구독 계정 응답이 유효하지 않습니다");
  }
  // `canManage`는 서버가 현재 사용자가 실제 소유자인지 계산한 공개 권한 신호입니다.
  // 공유받은 구성원은 profile을 읽거나 재인증해서는 안 됩니다.
  if (value.canManage !== true) {
    throw new Error("기존 Codex profile은 계정 소유자만 재인증하거나 재사용할 수 있습니다");
  }
  if (value.scope !== "personal" && value.scope !== "organization") {
    throw new Error("기존 Codex 구독 계정 scope가 유효하지 않습니다");
  }
  if (value.billingKind !== "consumer-subscription" || value.connectorExecutionKind !== "agent-runtime") {
    throw new Error("기존 Codex 구독 계정의 실행 계보가 유효하지 않습니다");
  }
  return {
    accountId: identifier(value.accountId, "기존 구독 계정 ID"),
    providerId: "openai-codex",
    alias: text(value.alias, "기존 구독 계정 별칭", 128),
    connectorId: identifier(value.connectorId, "기존 Connector ID"),
    profileHandle: profileHandle(value.profileHandle),
    accountStatus: enumValue(value.status, "기존 Codex 계정 상태", REUSABLE_ACCOUNT_STATUSES),
    doctorAction: "inspect",
  };
}

function enumValue(value: unknown, label: string, values: ReadonlySet<string>): string {
  if (typeof value !== "string" || !values.has(value)) throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function existingCodexDoctor(value: Record<string, unknown>, account: ExistingCodexAccount): ExistingCodexAccount {
  if (
    value.accountId !== account.accountId ||
    value.providerId !== account.providerId ||
    value.alias !== account.alias ||
    value.connectorId !== account.connectorId ||
    value.connectorLocation !== "server"
  ) {
    throw new Error("기존 Codex profile doctor 계보가 일치하지 않습니다");
  }
  const accountStatus = enumValue(
    value.accountStatus,
    "기존 Codex profile doctor 계정 상태",
    REUSABLE_ACCOUNT_STATUSES,
  );
  const connectorStatus = enumValue(
    value.connectorStatus,
    "기존 Codex profile doctor Connector 상태",
    REUSABLE_CONNECTOR_STATUSES,
  );
  const quotaStatus = enumValue(value.quotaStatus, "기존 Codex profile doctor quota 상태", DOCTOR_QUOTA_STATUSES);
  const doctorAction = enumValue(value.action, "기존 Codex profile doctor 작업", DOCTOR_ACTIONS);
  void connectorStatus;
  void quotaStatus;
  if (accountStatus !== account.accountStatus) {
    throw new Error("기존 Codex profile doctor 계정 상태가 구독 계정과 일치하지 않습니다");
  }
  if ((accountStatus === "needs-reauth") !== (doctorAction === "reauth")) {
    throw new Error("기존 Codex profile doctor 재인증 상태가 일치하지 않습니다");
  }
  return { ...account, accountStatus, doctorAction };
}

function assertPreflightCodexQuota(rows: readonly Record<string, unknown>[], accountId: string): void {
  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0]?.accountId !== accountId) {
    throw new Error("기존 Codex 구독 quota 계보가 일치하지 않습니다");
  }
  const quota = rows[0];
  void codexQuotaWindows(quota, {
    response: "기존 Codex 구독 quota 응답",
    observedAt: "기존 Codex 구독 quota 관측 시각",
    window: "기존 Codex 구독 quota window",
  });
}

function manageableCodexCandidates(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return rows.flatMap((row) => {
    if (row.canManage === true) return [row];
    if (row.canManage === false) return [];
    throw new Error("기존 Codex 구독 계정의 관리 권한 응답이 유효하지 않습니다");
  });
}

async function findExistingCodexAccount(
  client: ServerSubscriptionLoginClient,
  input: ServerSubscriptionLoginInput,
): Promise<ExistingCodexAccount | undefined> {
  const rows = queryRows(await client.query("subscription.accounts", {}), "구독 계정").filter(
    (row) => row.providerId === "openai-codex" && row.connectorLocation === "server",
  );
  if (rows.length === 0) return undefined;
  const matching = input.alias === undefined ? rows : rows.filter((row) => row.alias === input.alias);
  if (matching.length === 0) {
    throw new Error("기존 Codex 계정 별칭을 찾지 못했습니다. 새 계정은 --new-account를 사용해주세요");
  }
  const selected = manageableCodexCandidates(matching);
  if (selected.length === 0) {
    throw new Error("기존 Codex profile은 계정 소유자만 재인증하거나 재사용할 수 있습니다");
  }
  if (selected.length > 1) {
    throw new Error("기존 Codex 계정이 여러 개입니다. 별칭을 지정하거나 --new-account를 사용해주세요");
  }
  const account = existingCodexAccount(selected[0] as Record<string, unknown>);
  const doctorRows = queryRows(
    await client.query("subscription.doctor", { accountId: account.accountId }),
    "구독 doctor",
  );
  if (doctorRows.length !== 1) {
    throw new Error("기존 Codex profile doctor 확인 결과가 없습니다");
  }
  const doctorAccount = existingCodexDoctor(doctorRows[0] as Record<string, unknown>, account);
  const quotaRows = queryRows(await client.query("subscription.quota", { accountId: account.accountId }), "구독 quota");
  assertPreflightCodexQuota(quotaRows, account.accountId);
  return doctorAccount;
}

function assertLoopbackEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("CLI endpoint가 유효하지 않습니다");
  }
  if (
    !new Set(["http:", "https:"]).has(endpoint.protocol) ||
    !new Set(["127.0.0.1", "::1", "localhost"]).has(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("서버 관리형 소비자 구독 로그인에는 local loopback endpoint가 필요합니다");
  }
}

function loginEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  profileRoot: string,
  contract: ProviderLoginContract,
): NodeJS.ProcessEnv {
  return {
    ...(ambient.PATH === undefined ? {} : { PATH: ambient.PATH }),
    ...(ambient.TMPDIR === undefined ? {} : { TMPDIR: ambient.TMPDIR }),
    HOME: profileRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    ...contract.environment(profileRoot),
  };
}

async function placeProfile(profilesRoot: string, stagingRoot: string, handle: string): Promise<string> {
  const [organizationSegment, accountSegment] = handle.split("/");
  if (!organizationSegment || !accountSegment) throw new Error("구독 profile handle이 유효하지 않습니다");
  const organizationRoot = await ownerOnlyDirectory(resolve(profilesRoot, organizationSegment));
  const finalRoot = resolve(organizationRoot, accountSegment);
  if (!within(profilesRoot, organizationRoot) || !within(organizationRoot, finalRoot)) {
    throw new Error("구독 profile 경로가 관리 root 밖입니다");
  }
  const stagingExists = await directoryExists(stagingRoot);
  const finalExists = await directoryExists(finalRoot);
  if (stagingExists && finalExists) throw new Error("구독 profile 대상이 이미 존재합니다");
  if (stagingExists) await rename(stagingRoot, finalRoot);
  else if (!finalExists) throw new Error("로그인된 구독 profile을 찾을 수 없습니다");
  return await ownerOnlyDirectory(finalRoot);
}

export async function connectLocalServerSubscription(
  client: ServerSubscriptionLoginClient,
  input: ServerSubscriptionLoginInput,
  options: ServerSubscriptionLoginOptions,
): Promise<LocalServerSubscriptionConnection> {
  if (input.providerId === "anthropic-claude-code") {
    throw new Error("Anthropic 사전 승인 전에는 Claude 소비자 구독 로그인을 제공할 수 없습니다");
  }
  const contract = PROVIDERS[input.providerId];
  if (!contract) throw new Error("서버 관리형 소비자 구독 로그인은 Codex만 지원합니다");
  assertLocalMode(await client.status());
  assertLoopbackEndpoint(options.endpoint);
  if (!isAbsolute(options.connectorDirectory)) throw new Error("Connector directory는 절대 경로여야 합니다");

  const selectedAlias = alias(input.alias, contract.defaultAlias);
  const selectedModelId = requestedModelId(input.modelId);
  const connectorRoot = await ownerOnlyDirectory(resolve(options.connectorDirectory));
  const profilesRoot = await ownerOnlyDirectory(join(connectorRoot, "profiles"));
  const stagingParent = await ownerOnlyDirectory(join(profilesRoot, ".staging"));
  const pendingRoot = await ownerOnlyDirectory(join(connectorRoot, ".pending-subscriptions"));
  const pendingPath = join(pendingRoot, `${input.providerId}.json`);
  const release = await acquireLock(join(pendingRoot, `${input.providerId}.lock`));
  try {
    let pending = await readPending(pendingPath, input.providerId);
    if (pending?.intent === "new-account" && input.newAccount !== true) {
      throw new Error("중단된 새 Codex 계정 추가를 재개하려면 --new-account를 다시 명시해주세요");
    }
    if (pending?.intent === "initial" && input.newAccount === true) {
      throw new Error(
        "기존 Codex 연결 재개 상태가 남아 있습니다. 새 계정을 추가하기 전에 해당 연결을 완료하거나 재개 상태를 정리해주세요",
      );
    }
    if (!pending && input.newAccount !== true) {
      const existing = await findExistingCodexAccount(client, input);
      if (existing) {
        const [organizationSegment, accountSegment] = existing.profileHandle.split("/");
        if (!organizationSegment || !accountSegment) throw new Error("기존 Codex profile 계보가 유효하지 않습니다");
        const existingProfileRoot = resolve(profilesRoot, organizationSegment, accountSegment);
        if (!within(profilesRoot, existingProfileRoot)) throw new Error("기존 Codex profile 경로가 유효하지 않습니다");
        const profileWasMissing = !(await directoryExists(existingProfileRoot));
        if (profileWasMissing) {
          await ownerOnlyDirectory(existingProfileRoot);
        }
        await ensureManagedCodexProfile(existingProfileRoot);
        const credentialState = await managedCodexCredentialState(existingProfileRoot);
        const shouldLogin =
          profileWasMissing ||
          credentialState === "missing" ||
          existing.doctorAction === "reauth" ||
          existing.accountStatus === "needs-reauth";
        let reauthenticated = shouldLogin;
        const loginExistingProfile = async (): Promise<void> => {
          const inspect = options.inspectRuntime ?? inspectBundledSubscriptionRuntime;
          const artifact = await inspect(contract.runtimeId);
          if (artifact.runtimeId !== contract.runtimeId)
            throw new Error("Bundled 구독 Runtime 계보가 일치하지 않습니다");
          const run = options.runInteractive ?? defaultInteractiveRunner;
          const code = await run(
            artifact.command,
            contract.arguments(artifact),
            loginEnvironment(options.environment ?? process.env, existingProfileRoot, contract),
          );
          if (code !== 0) throw new Error(`Provider 구독 재인증이 완료되지 않았습니다 (exit ${String(code)})`);
          if ((await managedCodexCredentialState(existingProfileRoot)) !== "present") {
            throw new Error("Provider 구독 재인증 뒤 관리 Codex profile의 auth.json을 확인할 수 없습니다");
          }
        };
        const attestExistingProfile = async (): Promise<void> => {
          const observedAfter = Date.now();
          const attested = await client.command(
            commandEnvelope(randomUUID(), randomUUID(), "subscription.server.attest", {
              connectorId: existing.connectorId,
              accountId: existing.accountId,
              ...(selectedModelId === undefined ? {} : { modelId: selectedModelId }),
            }),
          );
          assertAttested(attested, existing.connectorId);
          await assertFreshCodexQuota(client, existing.accountId, observedAfter);
        };
        if (shouldLogin) {
          await loginExistingProfile();
        }
        try {
          await attestExistingProfile();
        } catch (error) {
          if (shouldLogin || !reauthenticationRequired(error)) throw error;
          await loginExistingProfile();
          reauthenticated = true;
          await attestExistingProfile();
        }
        return {
          status: "ready",
          providerId: existing.providerId,
          alias: existing.alias,
          accountId: existing.accountId,
          connectorId: existing.connectorId,
          connectionDisposition: reauthenticated ? "reauthenticated" : "reused",
        };
      }
    }
    if (!pending) {
      pending = {
        schema: "massion.server-subscription-login.v1",
        providerId: input.providerId,
        intent: input.newAccount === true ? "new-account" : "initial",
        alias: selectedAlias,
        ...(selectedModelId === undefined ? {} : { requestedModelId: selectedModelId }),
        phase: "login",
        stagingId: randomUUID(),
        prepareCommandId: randomUUID(),
        prepareCorrelationId: randomUUID(),
        attestCommandId: randomUUID(),
        attestCorrelationId: randomUUID(),
      };
      await writePending(pendingPath, pending);
    } else if (input.alias !== undefined && pending.alias !== selectedAlias) {
      throw new Error("재개 중인 구독 로그인의 별칭과 요청한 별칭이 일치하지 않습니다");
    } else if (selectedModelId !== undefined && pending.requestedModelId !== selectedModelId) {
      throw new Error("재개 중인 구독 로그인의 model과 요청한 model이 일치하지 않습니다");
    }

    const stagingRoot = resolve(stagingParent, pending.stagingId);
    if (!within(stagingParent, stagingRoot)) throw new Error("구독 staging profile 경로가 유효하지 않습니다");
    if (pending.phase === "login") {
      const profileRoot = await ownerOnlyDirectory(stagingRoot);
      await ensureManagedCodexProfile(profileRoot);
      const inspect = options.inspectRuntime ?? inspectBundledSubscriptionRuntime;
      const artifact = await inspect(contract.runtimeId);
      if (artifact.runtimeId !== contract.runtimeId) throw new Error("Bundled 구독 Runtime 계보가 일치하지 않습니다");
      const run = options.runInteractive ?? defaultInteractiveRunner;
      const code = await run(
        artifact.command,
        contract.arguments(artifact),
        loginEnvironment(options.environment ?? process.env, profileRoot, contract),
      );
      if (code !== 0) throw new Error(`Provider 구독 로그인이 완료되지 않았습니다 (exit ${String(code)})`);
      if ((await managedCodexCredentialState(profileRoot)) !== "present") {
        throw new Error("Provider 구독 로그인 뒤 관리 Codex profile의 auth.json을 확인할 수 없습니다");
      }
      pending = { ...pending, phase: "prepare" };
      await writePending(pendingPath, pending);
    }

    if (pending.phase === "prepare") {
      if (!(await directoryExists(stagingRoot))) throw new Error("로그인된 구독 staging profile을 찾을 수 없습니다");
      const response = await client.command(
        commandEnvelope(pending.prepareCommandId, pending.prepareCorrelationId, "subscription.server.prepare", {
          providerId: pending.providerId,
          alias: pending.alias,
          authKind: "cli-profile",
          billingKind: "consumer-subscription",
          priority: 1,
          weight: 1,
        }),
      );
      pending = { ...pending, phase: "attest", prepared: parsePrepared(response) };
      await writePending(pendingPath, pending);
    }

    const pendingState = pending;
    const prepared = pendingState.prepared;
    if (!prepared) throw new Error("서버 구독 준비 결과를 찾을 수 없습니다");
    const profileRoot = await placeProfile(profilesRoot, stagingRoot, prepared.profileHandle);
    const loginPreparedProfile = async (): Promise<void> => {
      const inspect = options.inspectRuntime ?? inspectBundledSubscriptionRuntime;
      const artifact = await inspect(contract.runtimeId);
      if (artifact.runtimeId !== contract.runtimeId) throw new Error("Bundled 구독 Runtime 계보가 일치하지 않습니다");
      const run = options.runInteractive ?? defaultInteractiveRunner;
      const code = await run(
        artifact.command,
        contract.arguments(artifact),
        loginEnvironment(options.environment ?? process.env, profileRoot, contract),
      );
      if (code !== 0) throw new Error(`Provider 구독 재인증이 완료되지 않았습니다 (exit ${String(code)})`);
      if ((await managedCodexCredentialState(profileRoot)) !== "present") {
        throw new Error("Provider 구독 재인증 뒤 관리 Codex profile의 auth.json을 확인할 수 없습니다");
      }
    };
    let attestCommandId = pendingState.attestCommandId;
    let attestCorrelationId = pendingState.attestCorrelationId;
    const attestPreparedProfile = async (): Promise<void> => {
      const observedAfter = Date.now();
      const attested = await client.command(
        commandEnvelope(attestCommandId, attestCorrelationId, "subscription.server.attest", {
          connectorId: prepared.connectorId,
          accountId: prepared.accountId,
          ...(pendingState.requestedModelId === undefined ? {} : { modelId: pendingState.requestedModelId }),
        }),
      );
      assertAttested(attested, prepared.connectorId);
      await assertFreshCodexQuota(client, prepared.accountId, observedAfter);
    };
    try {
      await attestPreparedProfile();
    } catch (error) {
      if (error instanceof DirectQuotaObservationMissingError) {
        // 이전 서버가 quota 없이 성공한 응답을 같은 command ID로 replay하면
        // 새 서버로 교체한 뒤에도 보류 상태가 영구히 같은 응답을 받습니다.
        // 네트워크 단절·실패는 기존 command를 재사용하지만, 불완전한 성공은
        // 새 attestation command로 한 번만 재실행합니다.
        attestCommandId = randomUUID();
        attestCorrelationId = randomUUID();
        pending = { ...pendingState, attestCommandId, attestCorrelationId };
        await writePending(pendingPath, pending);
        await attestPreparedProfile();
      } else if (reauthenticationRequired(error)) {
        await loginPreparedProfile();
        await attestPreparedProfile();
      } else {
        throw error;
      }
    }
    await rm(pendingPath, { force: true });
    return {
      status: "ready",
      providerId: pendingState.providerId,
      alias: pendingState.alias,
      accountId: prepared.accountId,
      connectorId: prepared.connectorId,
      connectionDisposition: "new",
    };
  } finally {
    await release();
  }
}
