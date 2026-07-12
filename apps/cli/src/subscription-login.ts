import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  inspectBundledSubscriptionRuntime,
  type BundledSubscriptionRuntimeArtifact,
  type BundledSubscriptionRuntimeId,
} from "@massion/runtime";
import { subscriptionDataDisclosure, type SubscriptionDataDisclosure } from "@massion/subscriptions";

export interface ServerSubscriptionLoginClient {
  status(): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
}

export interface ServerSubscriptionLoginInput {
  readonly providerId: string;
  readonly alias?: string;
  readonly modelId?: string;
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
  readonly confirmDataDisclosure?: (disclosure: SubscriptionDataDisclosure) => Promise<boolean>;
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

interface PendingLogin {
  readonly schema: "massion.server-subscription-login.v1";
  readonly providerId: string;
  readonly alias: string;
  readonly requestedModelId?: string;
  readonly phase: "login" | "prepare" | "attest";
  readonly disclosureVersion: string;
  readonly disclosureCommandId: string;
  readonly disclosureCorrelationId: string;
  readonly disclosureAcknowledged: boolean;
  readonly stagingId: string;
  readonly prepareCommandId: string;
  readonly prepareCorrelationId: string;
  readonly attestCommandId: string;
  readonly attestCorrelationId: string;
  readonly prepared?: PreparedBinding;
}

const PROVIDERS: Readonly<Record<string, ProviderLoginContract>> = {
  "openai-codex": {
    runtimeId: "codex",
    defaultAlias: "OpenAI Codex",
    arguments: (artifact) => [...artifact.commandArguments, "login"],
    environment: (profileRoot) => ({ CODEX_HOME: profileRoot }),
  },
};

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

async function ownerOnlyDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("구독 profile directory가 안전하지 않습니다");
  if ((metadata.mode & 0o077) !== 0) throw new Error("구독 profile directory는 owner-only여야 합니다");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("구독 profile directory는 현재 사용자 소유여야 합니다");
  }
  return await realpath(path);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error("구독 profile directory가 안전하지 않습니다");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("구독 profile directory는 현재 사용자 소유여야 합니다");
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
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
  if (
    source.schema !== "massion.server-subscription-login.v1" ||
    source.providerId !== providerId ||
    !new Set(["login", "prepare", "attest"]).has(source.phase ?? "") ||
    typeof source.alias !== "string" ||
    typeof source.disclosureVersion !== "string" ||
    typeof source.disclosureCommandId !== "string" ||
    typeof source.disclosureCorrelationId !== "string" ||
    typeof source.disclosureAcknowledged !== "boolean" ||
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
  if (source.disclosureVersion !== subscriptionDataDisclosure(providerId).version) {
    throw new Error("재개 중인 구독 로그인 데이터 처리 고지 버전이 현재 버전과 일치하지 않습니다");
  }
  return source as PendingLogin;
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

async function defaultDataDisclosureConfirmation(disclosure: SubscriptionDataDisclosure): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("데이터 처리 고지 동의에는 대화형 터미널이 필요합니다");
  }
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${disclosure.title}\n${disclosure.summary}\n자세히: ${disclosure.documentationUrl}\n`);
    const answer = await terminal.question("내용을 확인했고 로그인을 진행하려면 '동의'를 입력하세요: ");
    return answer.trim() === "동의";
  } finally {
    terminal.close();
  }
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

function assertDisclosureAcknowledged(value: unknown, disclosure: SubscriptionDataDisclosure): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("데이터 처리 고지 동의 응답이 유효하지 않습니다");
  }
  const response = value as { outcome?: unknown; data?: { providerId?: unknown; version?: unknown } };
  if (
    response.outcome !== "succeeded" ||
    response.data?.providerId !== disclosure.providerId ||
    response.data.version !== disclosure.version
  ) {
    throw new Error("데이터 처리 고지 동의가 완료되지 않았습니다");
  }
}

function assertAttested(value: unknown, connectorId: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("서버 구독 건강 증명 응답이 유효하지 않습니다");
  const response = value as { outcome?: unknown; data?: { connectorId?: unknown; status?: unknown } };
  if (
    response.outcome !== "succeeded" ||
    response.data?.connectorId !== connectorId ||
    response.data.status !== "ready"
  ) {
    throw new Error("서버 구독 Runtime이 준비 상태가 되지 않았습니다");
  }
}

function assertLocalMode(value: unknown): void {
  if (!value || typeof value !== "object" || (value as { data?: { mode?: unknown } }).data?.mode !== "local") {
    throw new Error("서버 관리형 소비자 구독 로그인은 local mode에서만 사용할 수 있습니다");
  }
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
): Promise<{
  readonly status: "ready";
  readonly providerId: string;
  readonly alias: string;
  readonly accountId: string;
  readonly connectorId: string;
}> {
  if (input.providerId === "anthropic-claude-code") {
    throw new Error("Anthropic 사전 승인 전에는 Claude 소비자 구독 로그인을 제공할 수 없습니다");
  }
  const contract = PROVIDERS[input.providerId];
  if (!contract) throw new Error("서버 관리형 소비자 구독 로그인은 Codex만 지원합니다");
  const disclosure = subscriptionDataDisclosure(input.providerId);
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
    if (!pending) {
      pending = {
        schema: "massion.server-subscription-login.v1",
        providerId: input.providerId,
        alias: selectedAlias,
        ...(selectedModelId === undefined ? {} : { requestedModelId: selectedModelId }),
        phase: "login",
        disclosureVersion: disclosure.version,
        disclosureCommandId: randomUUID(),
        disclosureCorrelationId: randomUUID(),
        disclosureAcknowledged: false,
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
    if (!pending.disclosureAcknowledged) {
      const confirm = options.confirmDataDisclosure ?? defaultDataDisclosureConfirmation;
      if (!(await confirm(disclosure))) throw new Error("데이터 처리 고지에 동의해야 구독 로그인을 시작할 수 있습니다");
      const acknowledged = await client.command(
        commandEnvelope(
          pending.disclosureCommandId,
          pending.disclosureCorrelationId,
          "subscription.data-disclosure.acknowledge",
          {
            providerId: disclosure.providerId,
            version: disclosure.version,
          },
        ),
      );
      assertDisclosureAcknowledged(acknowledged, disclosure);
      pending = { ...pending, disclosureAcknowledged: true };
      await writePending(pendingPath, pending);
    }
    if (pending.phase === "login") {
      const profileRoot = await ownerOnlyDirectory(stagingRoot);
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

    const prepared = pending.prepared;
    if (!prepared) throw new Error("서버 구독 준비 결과를 찾을 수 없습니다");
    await placeProfile(profilesRoot, stagingRoot, prepared.profileHandle);
    const attested = await client.command(
      commandEnvelope(pending.attestCommandId, pending.attestCorrelationId, "subscription.server.attest", {
        connectorId: prepared.connectorId,
        accountId: prepared.accountId,
        ...(pending.requestedModelId === undefined ? {} : { modelId: pending.requestedModelId }),
      }),
    );
    assertAttested(attested, prepared.connectorId);
    await rm(pendingPath, { force: true });
    return {
      status: "ready",
      providerId: pending.providerId,
      alias: pending.alias,
      accountId: prepared.accountId,
      connectorId: prepared.connectorId,
    };
  } finally {
    await release();
  }
}
