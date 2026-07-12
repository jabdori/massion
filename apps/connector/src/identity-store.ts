import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createEdgeWorkspaceRootCapability } from "@massion/subscriptions";

import { assertSecureProviderProfileRoot } from "./profile-permissions.js";
import type { ProviderProfileAuthKind } from "./profile-health.js";
import type { EdgeRuntimeArtifact, ExternalEdgeProviderId } from "./runtime-artifact.js";

export const EDGE_IDENTITY_SCHEMA = "massion.edge-connector.identity.v1" as const;
export const EDGE_CONNECTOR_VERSION = "1.0.0" as const;

export type EdgeProviderId = "openai-codex" | "anthropic-claude-code" | ExternalEdgeProviderId;

export type EdgeBillingKind =
  "consumer-subscription" | "organization-subscription" | "enterprise-subscription" | "api-usage";

interface PendingIdentityInput {
  readonly baseUrl: string;
  readonly enrollmentId: string;
  readonly connectorId: string;
  readonly commandId: string;
  readonly providerId: EdgeProviderId;
  readonly accountAlias: string;
  readonly authKind: ProviderProfileAuthKind;
  readonly billingKind: EdgeBillingKind;
  readonly enrollmentDigest: string;
  readonly profileRoot: string;
  readonly workspaceRoots: readonly string[];
  readonly runtimeArtifact?: EdgeRuntimeArtifact;
}

interface IdentityBase {
  readonly schemaVersion: typeof EDGE_IDENTITY_SCHEMA;
  readonly status: "pending" | "active";
  readonly baseUrl: string;
  readonly enrollmentId: string;
  readonly connectorId: string;
  readonly commandId: string;
  readonly providerId: EdgeProviderId;
  readonly accountAlias: string;
  readonly authKind: ProviderProfileAuthKind;
  readonly billingKind: EdgeBillingKind;
  readonly enrollmentDigest: string;
  readonly profileRoot: string;
  readonly workspaceRoots: readonly string[];
  readonly runtimeArtifact?: EdgeRuntimeArtifact;
  readonly capabilities: readonly string[];
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: string;
}

export interface PendingConnectorIdentity extends IdentityBase {
  readonly status: "pending";
}

export interface ActiveConnectorIdentity extends IdentityBase {
  readonly status: "active";
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "member";
}

export type ConnectorIdentity = PendingConnectorIdentity | ActiveConnectorIdentity;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const MANAGED_WORKSPACE_MARKER = ".massion-managed-workspaces-v1";
const MANAGED_WORKSPACE_MARKER_CONTENT = "massion.edge-managed-workspaces.v1\n";
const MANAGED_WORKSPACE_SEGMENT = /^[a-f0-9]{64}$/u;
const ACTIVE_FIELDS = [
  "schemaVersion",
  "status",
  "baseUrl",
  "enrollmentId",
  "connectorId",
  "commandId",
  "providerId",
  "accountAlias",
  "authKind",
  "billingKind",
  "enrollmentDigest",
  "profileRoot",
  "workspaceRoots",
  "runtimeArtifact",
  "capabilities",
  "publicKey",
  "privateKey",
  "createdAt",
  "organizationId",
  "ownerUserId",
  "membershipId",
  "role",
] as const;
const PENDING_FIELDS = ACTIVE_FIELDS.filter(
  (field) => !["organizationId", "ownerUserId", "membershipId", "role"].includes(field),
);

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function applicationOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Massion base URL은 credential 없는 HTTPS origin이어야 합니다");
  }
  return url.origin;
}

function provider(value: string): EdgeProviderId {
  if (
    !new Set([
      "openai-codex",
      "anthropic-claude-code",
      "google-gemini-cli-enterprise",
      "github-copilot",
      "xai-grok-build",
    ]).has(value)
  ) {
    throw new Error("Edge Connector Provider가 지원 범위에 없습니다");
  }
  return value as EdgeProviderId;
}

function profileAuthKind(value: string): ProviderProfileAuthKind {
  if (value !== "cli-profile" && value !== "api-key") {
    throw new Error("Edge Connector profile 인증 방식이 유효하지 않습니다");
  }
  return value;
}

function accountAlias(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\0\r\n]/u.test(normalized)) {
    throw new Error("구독 계정 별칭이 유효하지 않습니다");
  }
  return normalized;
}

function billingKind(providerId: EdgeProviderId, value: string): EdgeBillingKind {
  const allowed: Readonly<Record<EdgeProviderId, ReadonlySet<string>>> = {
    "openai-codex": new Set(["consumer-subscription", "api-usage"]),
    "anthropic-claude-code": new Set(["consumer-subscription", "api-usage"]),
    "google-gemini-cli-enterprise": new Set(["enterprise-subscription"]),
    "github-copilot": new Set(["consumer-subscription", "organization-subscription"]),
    "xai-grok-build": new Set(["consumer-subscription"]),
  };
  if (!allowed[providerId].has(value)) {
    throw new Error("Edge Connector Provider 결제 유형이 유효하지 않습니다");
  }
  return value as EdgeBillingKind;
}

function authKind(providerId: EdgeProviderId, value: string): ProviderProfileAuthKind {
  const selected = profileAuthKind(value);
  if (providerId !== "openai-codex" && providerId !== "anthropic-claude-code" && selected !== "cli-profile") {
    throw new Error("외부 ACP Edge Provider는 ambient token 없는 cli-profile 인증만 지원합니다");
  }
  return selected;
}

async function runtimeArtifact(
  providerId: EdgeProviderId,
  value: EdgeRuntimeArtifact | undefined,
): Promise<EdgeRuntimeArtifact | undefined> {
  const external =
    providerId === "google-gemini-cli-enterprise" || providerId === "github-copilot" || providerId === "xai-grok-build";
  if (!external) {
    if (value !== undefined) throw new Error("Bundled Edge Provider에는 외부 runtime artifact를 지정할 수 없습니다");
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("외부 ACP Edge Provider 실행 파일 runtime artifact가 필요합니다");
  }
  const source = value as unknown as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["executable", "digest", "version"].includes(key)) ||
    !isAbsolute(String(source.executable)) ||
    !/^[a-f0-9]{64}$/u.test(String(source.digest)) ||
    !/^[0-9][0-9A-Za-z.+_-]{0,127}$/u.test(String(source.version))
  ) {
    throw new Error("외부 ACP Edge Provider runtime artifact가 유효하지 않습니다");
  }
  const executable = String(source.executable);
  const metadata = await lstat(executable);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(executable)) !== resolve(executable)) {
    throw new Error("외부 ACP Edge Provider 실행 파일은 symlink가 아닌 regular file이어야 합니다");
  }
  return { executable, digest: String(source.digest), version: String(source.version) };
}

function enrollmentDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Enrollment payload digest가 유효하지 않습니다");
  return value;
}

async function safeDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label}는 절대 경로여야 합니다`);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}가 안전한 디렉터리가 아닙니다`);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`${label}에 symlink 경로를 사용할 수 없습니다`);
  return canonical;
}

async function requireOwnerOnlyDirectory(path: string, label: string): Promise<string> {
  const canonical = await safeDirectory(path, label);
  const metadata = await lstat(canonical);
  if ((metadata.mode & 0o077) !== 0 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label}는 현재 사용자 소유의 0700 디렉터리여야 합니다`);
  }
  return canonical;
}

async function validateManagedWorkspaceChildren(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 10_001) throw new Error("Massion 전용 workspace 항목 상한을 초과했습니다");
  for (const entry of entries) {
    if (entry.name === MANAGED_WORKSPACE_MARKER) continue;
    if (!MANAGED_WORKSPACE_SEGMENT.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Massion 전용 workspace parent에 관리되지 않은 항목이 있습니다");
    }
    const organizationRoot = await requireOwnerOnlyDirectory(join(root, entry.name), "Massion 조직 workspace");
    const workEntries = await readdir(organizationRoot, { withFileTypes: true });
    if (workEntries.length > 10_000) throw new Error("Massion Work workspace 항목 상한을 초과했습니다");
    for (const work of workEntries) {
      if (!MANAGED_WORKSPACE_SEGMENT.test(work.name) || !work.isDirectory() || work.isSymbolicLink()) {
        throw new Error("Massion 조직 workspace에 관리되지 않은 항목이 있습니다");
      }
      await requireOwnerOnlyDirectory(join(organizationRoot, work.name), "Massion Work workspace");
    }
  }
}

async function managedWorkspaceRoot(path: string, createMarker: boolean): Promise<string> {
  const root = await requireOwnerOnlyDirectory(path, "Massion 전용 workspace root");
  const marker = join(root, MANAGED_WORKSPACE_MARKER);
  let markerExists = true;
  try {
    const metadata = await lstat(marker);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("marker-file");
    assertOwner(metadata, "Massion workspace marker");
    if ((await readFile(marker, "utf8")) !== MANAGED_WORKSPACE_MARKER_CONTENT) throw new Error("marker-content");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Massion 전용 workspace marker가 유효하지 않습니다", { cause: error });
    }
    markerExists = false;
  }
  if (!markerExists) {
    const entries = await readdir(root);
    if (!createMarker || entries.length > 0) {
      throw new Error("Massion 전용 workspace root는 비어 있거나 유효한 marker가 있어야 합니다");
    }
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(MANAGED_WORKSPACE_MARKER_CONTENT, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await validateManagedWorkspaceChildren(root);
  return root;
}

function managedWorkspaceSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return createHash("sha256").update(normalized).digest("hex");
}

async function ensureManagedWorkspaceChild(parent: string, name: string, label: string): Promise<string> {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await requireOwnerOnlyDirectory(path, label);
}

export async function edgeManagedWorkspaceForWork(
  configuredRoot: string,
  organizationId: string,
  workId: string,
): Promise<string> {
  const root = await managedWorkspaceRoot(configuredRoot, false);
  const organizationRoot = await ensureManagedWorkspaceChild(
    root,
    managedWorkspaceSegment(organizationId, "조직 ID"),
    "Massion 조직 workspace",
  );
  return await ensureManagedWorkspaceChild(
    organizationRoot,
    managedWorkspaceSegment(workId, "Work ID"),
    "Massion Work workspace",
  );
}

async function ownerOnlyParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Connector 신원 상위 경로는 symlink가 아닌 디렉터리여야 합니다");
  }
  await chmod(parent, 0o700);
  if ((await realpath(parent)) !== resolve(parent)) {
    throw new Error("Connector 신원 상위 경로에 symlink를 사용할 수 없습니다");
  }
}

function assertOwner(metadata: Stats, label: string): void {
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label}은(는) 0600이어야 합니다`);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label}은(는) 현재 사용자 소유여야 합니다`);
  }
}

function validateKeyPair(privateKey: string, publicKey: string): void {
  try {
    const privateObject = createPrivateKey(privateKey);
    const publicObject = createPublicKey(publicKey);
    const derived = createPublicKey(privateObject).export({ type: "spki", format: "pem" });
    if (
      privateObject.asymmetricKeyType !== "ed25519" ||
      publicObject.asymmetricKeyType !== "ed25519" ||
      String(derived) !== publicKey
    ) {
      throw new Error("key-mismatch");
    }
  } catch {
    throw new Error("Connector Ed25519 key pair가 유효하지 않습니다");
  }
}

export function edgeWorkspaceRootBindings(input: {
  privateKey: string;
  workspaceRoots: readonly string[];
}): readonly { readonly capability: string; readonly workspaceRoot: string }[] {
  const secret = createHash("sha256")
    .update("massion.edge-workspace-capability-secret.v1\0", "utf8")
    .update(input.privateKey, "utf8")
    .digest();
  return input.workspaceRoots.map((workspaceRoot) => ({
    workspaceRoot,
    capability: createEdgeWorkspaceRootCapability(secret, workspaceRoot),
  }));
}

function identityCapabilities(
  providerId: EdgeProviderId,
  privateKey: string,
  workspaceRoots: readonly string[],
  artifact?: EdgeRuntimeArtifact,
): readonly string[] {
  return [
    "agent-turn",
    providerId,
    ...(artifact
      ? [`massion.runtime-artifact.sha256.${artifact.digest}`, `massion.runtime-version.${artifact.version}`]
      : []),
    ...edgeWorkspaceRootBindings({ privateKey, workspaceRoots }).map(({ capability }) => capability),
  ].sort();
}

export async function readOwnerOnlySecret(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} 파일은 절대 경로여야 합니다`);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} 파일은 symlink가 아닌 regular file이어야 합니다`);
  }
  assertOwner(metadata, label);
  const value = (await readFile(path, "utf8")).trim();
  if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error(`${label} 값이 유효하지 않습니다`);
  return value;
}

async function writeIdentity(path: string, identity: ConnectorIdentity): Promise<void> {
  await ownerOnlyParent(path);
  const temporary = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(identity, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class ConnectorIdentityStore {
  public constructor(public readonly path: string) {
    if (!isAbsolute(path)) throw new Error("Connector 신원 파일은 절대 경로여야 합니다");
  }

  public static async createPending(path: string, input: PendingIdentityInput): Promise<PendingConnectorIdentity> {
    const store = new ConnectorIdentityStore(path);
    const selectedProvider = provider(input.providerId);
    const selectedAccountAlias = accountAlias(input.accountAlias);
    const selectedAuthKind = authKind(selectedProvider, input.authKind);
    const selectedBillingKind = billingKind(selectedProvider, input.billingKind);
    const selectedEnrollmentDigest = enrollmentDigest(input.enrollmentDigest);
    const selectedRuntimeArtifact = await runtimeArtifact(selectedProvider, input.runtimeArtifact);
    const profileRoot = await assertSecureProviderProfileRoot(input.profileRoot);
    if (input.workspaceRoots.length !== 1 || !input.workspaceRoots[0]) {
      throw new Error("Massion 전용 Workspace root는 정확히 1개여야 합니다");
    }
    const workspaceRoots = [await managedWorkspaceRoot(input.workspaceRoots[0], true)];
    const normalized = {
      baseUrl: applicationOrigin(input.baseUrl),
      enrollmentId: identifier(input.enrollmentId, "Enrollment ID"),
      connectorId: identifier(input.connectorId, "Connector ID"),
      commandId: identifier(input.commandId, "Command ID"),
      accountAlias: selectedAccountAlias,
      authKind: selectedAuthKind,
      billingKind: selectedBillingKind,
      enrollmentDigest: selectedEnrollmentDigest,
      ...(selectedRuntimeArtifact ? { runtimeArtifact: selectedRuntimeArtifact } : {}),
    };
    const existing = await store.loadPending().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (
        existing.baseUrl !== normalized.baseUrl ||
        existing.enrollmentId !== normalized.enrollmentId ||
        existing.providerId !== selectedProvider ||
        existing.accountAlias !== normalized.accountAlias ||
        existing.authKind !== normalized.authKind ||
        existing.billingKind !== normalized.billingKind ||
        existing.enrollmentDigest !== normalized.enrollmentDigest ||
        JSON.stringify(existing.runtimeArtifact) !== JSON.stringify(selectedRuntimeArtifact) ||
        existing.profileRoot !== profileRoot ||
        JSON.stringify(existing.workspaceRoots) !== JSON.stringify(workspaceRoots)
      ) {
        throw new Error("기존 pending Connector 신원과 등록 입력이 일치하지 않습니다");
      }
      return existing;
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const identity: PendingConnectorIdentity = {
      schemaVersion: EDGE_IDENTITY_SCHEMA,
      status: "pending",
      ...normalized,
      providerId: selectedProvider,
      profileRoot,
      workspaceRoots,
      ...(selectedRuntimeArtifact ? { runtimeArtifact: selectedRuntimeArtifact } : {}),
      capabilities: identityCapabilities(selectedProvider, privateKey, workspaceRoots, selectedRuntimeArtifact),
      publicKey,
      privateKey,
      createdAt: new Date().toISOString(),
    };
    await writeIdentity(store.path, identity);
    return identity;
  }

  public async loadPending(): Promise<PendingConnectorIdentity> {
    const raw = await readOwnerOnlySecret(this.path, "Connector 신원 파일");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Connector 신원 JSON이 유효하지 않습니다");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Connector pending 신원 schema가 유효하지 않습니다");
    }
    const source = value as Record<string, unknown>;
    const unknown = Object.keys(source).find((field) => !(PENDING_FIELDS as readonly string[]).includes(field));
    const missing = PENDING_FIELDS.find((field) => field !== "runtimeArtifact" && source[field] === undefined);
    if (unknown || missing || source.schemaVersion !== EDGE_IDENTITY_SCHEMA || source.status !== "pending") {
      throw new Error("Connector pending 신원 schema가 유효하지 않습니다");
    }
    const selectedProvider = provider(String(source.providerId));
    const selectedRuntimeArtifact = await runtimeArtifact(
      selectedProvider,
      source.runtimeArtifact as EdgeRuntimeArtifact | undefined,
    );
    if (!Array.isArray(source.workspaceRoots) || source.workspaceRoots.length !== 1 || !source.workspaceRoots[0]) {
      throw new Error("Connector workspace root가 유효하지 않습니다");
    }
    const profileRoot = await assertSecureProviderProfileRoot(String(source.profileRoot));
    const workspaceRoots = [await managedWorkspaceRoot(String(source.workspaceRoots[0]), false)];
    const privateKey = String(source.privateKey);
    const publicKey = String(source.publicKey);
    const capabilities = identityCapabilities(selectedProvider, privateKey, workspaceRoots, selectedRuntimeArtifact);
    const storedCapabilities = Array.isArray(source.capabilities) ? source.capabilities : [];
    if (
      !Array.isArray(source.capabilities) ||
      source.capabilities.length !== capabilities.length ||
      !capabilities.every((capability, index) => storedCapabilities[index] === capability)
    ) {
      throw new Error("Connector capability가 신원 Provider와 일치하지 않습니다");
    }
    validateKeyPair(privateKey, publicKey);
    const createdAt = new Date(String(source.createdAt));
    if (!Number.isFinite(createdAt.getTime())) throw new Error("Connector 신원 생성 시각이 유효하지 않습니다");
    return {
      schemaVersion: EDGE_IDENTITY_SCHEMA,
      status: "pending",
      baseUrl: applicationOrigin(String(source.baseUrl)),
      enrollmentId: identifier(String(source.enrollmentId), "Enrollment ID"),
      connectorId: identifier(String(source.connectorId), "Connector ID"),
      commandId: identifier(String(source.commandId), "Command ID"),
      providerId: selectedProvider,
      accountAlias: accountAlias(String(source.accountAlias)),
      authKind: authKind(selectedProvider, String(source.authKind)),
      billingKind: billingKind(selectedProvider, String(source.billingKind)),
      enrollmentDigest: enrollmentDigest(String(source.enrollmentDigest)),
      profileRoot,
      workspaceRoots,
      ...(selectedRuntimeArtifact ? { runtimeArtifact: selectedRuntimeArtifact } : {}),
      capabilities,
      publicKey,
      privateKey,
      createdAt: createdAt.toISOString(),
    };
  }

  public async activate(
    pending: PendingConnectorIdentity,
    context: {
      readonly organizationId: string;
      readonly userId: string;
      readonly membershipId: string;
      readonly role: "owner" | "admin" | "member";
    },
  ): Promise<ActiveConnectorIdentity> {
    const active: ActiveConnectorIdentity = {
      ...pending,
      status: "active",
      organizationId: identifier(context.organizationId, "조직 ID"),
      ownerUserId: identifier(context.userId, "사용자 ID"),
      membershipId: identifier(context.membershipId, "Membership ID"),
      role: context.role,
    };
    await writeIdentity(this.path, active);
    return active;
  }

  public async loadActive(): Promise<ActiveConnectorIdentity> {
    const raw = await readOwnerOnlySecret(this.path, "Connector 신원 파일");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Connector 신원 JSON이 유효하지 않습니다");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Connector 신원 schema가 유효하지 않습니다");
    }
    const source = value as Record<string, unknown>;
    const unknown = Object.keys(source).find((field) => !(ACTIVE_FIELDS as readonly string[]).includes(field));
    const missing = ACTIVE_FIELDS.find((field) => field !== "runtimeArtifact" && source[field] === undefined);
    if (unknown || missing || source.schemaVersion !== EDGE_IDENTITY_SCHEMA || source.status !== "active") {
      throw new Error("Connector 활성 신원 schema가 유효하지 않습니다");
    }
    const selectedProvider = provider(String(source.providerId));
    const selectedRuntimeArtifact = await runtimeArtifact(
      selectedProvider,
      source.runtimeArtifact as EdgeRuntimeArtifact | undefined,
    );
    if (!Array.isArray(source.workspaceRoots) || source.workspaceRoots.length !== 1 || !source.workspaceRoots[0]) {
      throw new Error("Connector workspace root가 유효하지 않습니다");
    }
    const profileRoot = await assertSecureProviderProfileRoot(String(source.profileRoot));
    const workspaceRoots = [await managedWorkspaceRoot(String(source.workspaceRoots[0]), false)];
    const privateKey = String(source.privateKey);
    const publicKey = String(source.publicKey);
    const capabilities = identityCapabilities(selectedProvider, privateKey, workspaceRoots, selectedRuntimeArtifact);
    const storedCapabilities = Array.isArray(source.capabilities) ? source.capabilities : [];
    if (
      !Array.isArray(source.capabilities) ||
      source.capabilities.length !== capabilities.length ||
      !capabilities.every((capability, index) => storedCapabilities[index] === capability)
    ) {
      throw new Error("Connector capability가 신원 Provider와 일치하지 않습니다");
    }
    validateKeyPair(privateKey, publicKey);
    const role = source.role;
    if (role !== "owner" && role !== "admin" && role !== "member")
      throw new Error("Connector 소유자 역할이 유효하지 않습니다");
    const createdAt = new Date(String(source.createdAt));
    if (!Number.isFinite(createdAt.getTime())) throw new Error("Connector 신원 생성 시각이 유효하지 않습니다");
    return {
      schemaVersion: EDGE_IDENTITY_SCHEMA,
      status: "active",
      baseUrl: applicationOrigin(String(source.baseUrl)),
      enrollmentId: identifier(String(source.enrollmentId), "Enrollment ID"),
      connectorId: identifier(String(source.connectorId), "Connector ID"),
      commandId: identifier(String(source.commandId), "Command ID"),
      providerId: selectedProvider,
      accountAlias: accountAlias(String(source.accountAlias)),
      authKind: authKind(selectedProvider, String(source.authKind)),
      billingKind: billingKind(selectedProvider, String(source.billingKind)),
      enrollmentDigest: enrollmentDigest(String(source.enrollmentDigest)),
      profileRoot,
      workspaceRoots,
      ...(selectedRuntimeArtifact ? { runtimeArtifact: selectedRuntimeArtifact } : {}),
      capabilities,
      publicKey,
      privateKey,
      createdAt: createdAt.toISOString(),
      organizationId: identifier(String(source.organizationId), "조직 ID"),
      ownerUserId: identifier(String(source.ownerUserId), "사용자 ID"),
      membershipId: identifier(String(source.membershipId), "Membership ID"),
      role,
    };
  }
}
