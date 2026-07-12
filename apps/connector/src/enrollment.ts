import { createHash, randomUUID, sign } from "node:crypto";

import { createEnrollmentSignaturePayload, type IssuedEnrollment } from "@massion/subscriptions";

import {
  ConnectorIdentityStore,
  EDGE_CONNECTOR_VERSION,
  type ActiveConnectorIdentity,
  type EdgeBillingKind,
  type EdgeProviderId,
  readOwnerOnlySecret,
} from "./identity-store.js";
import { CONNECTOR_PROTOCOL } from "./protocol.js";
import {
  PinnedProviderProfileHealthProbe,
  ProviderReauthenticationRequiredError,
  type ProviderProfileAuthKind,
  type ProviderProfileHealthProbe,
} from "./profile-health.js";
import {
  ProviderProfileOwnershipError,
  ProviderProfilePathError,
  ProviderProfilePermissionError,
} from "./profile-permissions.js";
import { attestEdgeRuntimeArtifact, type EdgeRuntimeArtifact } from "./runtime-artifact.js";

type EnrollmentDocument = IssuedEnrollment;

export interface EnrollEdgeConnectorOptions {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly identityFile: string;
  readonly enrollment: unknown;
  readonly providerId: EdgeProviderId;
  readonly alias: string;
  readonly authKind: ProviderProfileAuthKind;
  readonly billingKind: EdgeBillingKind;
  readonly profileRoot: string;
  readonly workspaceRoots: readonly string[];
  readonly runtimeExecutable?: string;
  readonly acceptExperimental?: boolean;
  readonly attestRuntime?: (input: {
    readonly providerId: string;
    readonly executable: string;
  }) => Promise<EdgeRuntimeArtifact>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly healthProbe?: ProviderProfileHealthProbe;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
}

export interface ConnectedEdgeAccount {
  readonly accountId: string;
  readonly providerId: EdgeProviderId;
  readonly alias: string;
  readonly scope: "personal";
  readonly connectorId: string;
  readonly billingKind: EdgeBillingKind;
  readonly status: string;
  readonly version: number;
}

export interface EnrolledEdgeConnector {
  readonly identity: ActiveConnectorIdentity;
  readonly account: ConnectedEdgeAccount;
}

const ENROLLMENT_FIELDS = ["enrollmentId", "enrollmentCode", "challengeNonce", "expiresAt"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 64 * 1024): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function alias(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\0\r\n]/u.test(normalized)) {
    throw new Error("구독 계정 별칭이 유효하지 않습니다");
  }
  return normalized;
}

function billingKind(value: string): EdgeBillingKind {
  if (
    !new Set(["consumer-subscription", "organization-subscription", "enterprise-subscription", "api-usage"]).has(value)
  ) {
    throw new Error("Edge Provider 결제 유형이 유효하지 않습니다");
  }
  return value as EdgeBillingKind;
}

function externalProvider(providerId: EdgeProviderId): boolean {
  return (
    providerId === "google-gemini-cli-enterprise" || providerId === "github-copilot" || providerId === "xai-grok-build"
  );
}

function enrollmentDocument(value: unknown): EnrollmentDocument {
  const source = record(value, "Enrollment JSON");
  const unknown = Object.keys(source).find((key) => !(ENROLLMENT_FIELDS as readonly string[]).includes(key));
  if (unknown) throw new Error(`Enrollment JSON에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = ENROLLMENT_FIELDS.find((key) => source[key] === undefined);
  if (missing) throw new Error(`Enrollment JSON 필드가 필요합니다: ${missing}`);
  const expiresAt = text(source.expiresAt, "Enrollment 만료 시각", 64);
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new Error("Connector enrollment 만료 시각이 유효하지 않습니다");
  return {
    enrollmentId: text(source.enrollmentId, "Enrollment ID", 128),
    enrollmentCode: text(source.enrollmentCode, "Enrollment code", 256),
    challengeNonce: text(source.challengeNonce, "Enrollment challenge", 256),
    expiresAt: expiry.toISOString(),
  };
}

function enrollmentDigest(enrollment: EnrollmentDocument): string {
  return createHash("sha256")
    .update("massion.edge-enrollment-document.v1\0", "utf8")
    .update(JSON.stringify(enrollment), "utf8")
    .digest("hex");
}

function requestTimeout(value: number | undefined): number {
  const selected = value ?? 15_000;
  if (!Number.isSafeInteger(selected) || selected < 10 || selected > 120_000) {
    throw new Error("Connector HTTP timeout이 유효하지 않습니다");
  }
  return selected;
}

function profileHealthFailure(): never {
  throw new Error("Provider profile 인증 상태를 확인할 수 없습니다");
}

async function jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") throw new Error(`${label} 응답 형식이 유효하지 않습니다`);
  const encoded = new Uint8Array(await response.arrayBuffer());
  if (encoded.byteLength === 0 || encoded.byteLength > 1024 * 1024) {
    throw new Error(`${label} 응답 byte 상한을 초과했습니다`);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} JSON 응답이 유효하지 않습니다`);
  }
  if (!response.ok) throw new Error(`${label} 요청이 거부됐습니다 (${String(response.status)})`);
  return record(value, `${label} 응답`);
}

function requestFailure(label: string): never {
  throw new Error(`${label} 요청을 완료할 수 없습니다`);
}

async function request(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  label: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  try {
    return await jsonResponse(await fetcher(url, { ...init, signal: requestSignal }), label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    return requestFailure(label);
  }
}

function contextFromMe(value: Record<string, unknown>): {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "member";
} {
  const data = record(value.data, "현재 사용자 응답 data");
  const role = data.role;
  if (role !== "owner" && role !== "admin" && role !== "member")
    throw new Error("현재 사용자 역할이 유효하지 않습니다");
  return {
    organizationId: text(data.organizationId, "조직 ID", 128),
    userId: text(data.userId, "사용자 ID", 128),
    membershipId: text(data.membershipId, "Membership ID", 128),
    role,
  };
}

export async function enrollEdgeConnector(options: EnrollEdgeConnectorOptions): Promise<EnrolledEdgeConnector> {
  const now = options.now?.() ?? new Date();
  const enrollment = enrollmentDocument(options.enrollment);
  const accountAlias = alias(options.alias);
  const accountBillingKind = billingKind(options.billingKind);
  const timeoutMs = requestTimeout(options.requestTimeoutMs);
  const connectorId = randomUUID();
  const commandId = randomUUID();
  const store = new ConnectorIdentityStore(options.identityFile);
  const existing = await store.loadPending().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing && new Date(enrollment.expiresAt).getTime() <= now.getTime()) {
    throw new Error("Connector enrollment가 만료됐습니다");
  }
  let runtimeArtifact = existing?.runtimeArtifact;
  if (externalProvider(options.providerId)) {
    if (options.acceptExperimental !== true) {
      throw new Error("실험적 외부 ACP Edge Provider 연결에는 명시적 동의가 필요합니다");
    }
    if (!options.runtimeExecutable && !runtimeArtifact) {
      throw new Error("외부 ACP Edge Provider의 명시적 실행 파일이 필요합니다");
    }
    if (options.runtimeExecutable) {
      runtimeArtifact = await (options.attestRuntime ?? attestEdgeRuntimeArtifact)({
        providerId: options.providerId,
        executable: options.runtimeExecutable,
      });
    }
  } else if (options.runtimeExecutable !== undefined) {
    throw new Error("Bundled Edge Provider에는 외부 실행 파일을 지정할 수 없습니다");
  }
  const pendingInput = {
    baseUrl: options.baseUrl,
    enrollmentId: enrollment.enrollmentId,
    connectorId,
    commandId,
    providerId: options.providerId,
    accountAlias,
    authKind: options.authKind,
    billingKind: accountBillingKind,
    enrollmentDigest: enrollmentDigest(enrollment),
    profileRoot: options.profileRoot,
    workspaceRoots: options.workspaceRoots,
    ...(runtimeArtifact ? { runtimeArtifact } : {}),
  } as const;
  let pending = existing ? await ConnectorIdentityStore.createPending(options.identityFile, pendingInput) : undefined;
  try {
    await (options.healthProbe ?? new PinnedProviderProfileHealthProbe()).verify({
      providerId: options.providerId,
      profileRoot: options.profileRoot,
      expectedAuthKind: options.authKind,
      billingKind: accountBillingKind,
      ...(runtimeArtifact ? { runtimeArtifact } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof ProviderReauthenticationRequiredError ||
      error instanceof ProviderProfilePermissionError ||
      error instanceof ProviderProfileOwnershipError ||
      error instanceof ProviderProfilePathError
    ) {
      throw error;
    }
    profileHealthFailure();
  }
  const token = await readOwnerOnlySecret(options.tokenFile, "Application token");
  pending ??= await ConnectorIdentityStore.createPending(options.identityFile, pendingInput);
  const fetcher = options.fetcher ?? fetch;
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const me = await request(
    fetcher,
    new URL("/api/v1/me", pending.baseUrl),
    { method: "GET", headers },
    "현재 사용자 조회",
    options.signal,
    timeoutMs,
  );
  const context = contextFromMe(me);
  const unsigned = {
    ...enrollment,
    connectorId: pending.connectorId,
    publicKey: pending.publicKey,
    protocol: CONNECTOR_PROTOCOL,
    version: EDGE_CONNECTOR_VERSION,
    capabilities: pending.capabilities,
  };
  const signature = sign(null, createEnrollmentSignaturePayload(unsigned), pending.privateKey).toString("base64url");
  const envelope = {
    schemaVersion: "massion.application.v1",
    commandId: pending.commandId,
    correlationId: pending.commandId,
    operation: "subscription.connector.enroll",
    payload: { ...unsigned, signature },
  };
  const result = await request(
    fetcher,
    new URL("/api/v1/commands", pending.baseUrl),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(envelope),
    },
    "Connector 등록",
    options.signal,
    timeoutMs,
  );
  const data = record(result.data, "Connector 등록 응답 data");
  if (result.outcome !== "succeeded" || data.connectorId !== pending.connectorId) {
    throw new Error("Connector 등록 응답 계보가 일치하지 않습니다");
  }
  const accountCommandId = `${pending.commandId}:${createHash("sha256")
    .update(`${accountAlias}\0${accountBillingKind}`)
    .digest("hex")
    .slice(0, 12)}`;
  const profileLocator = `edge-profile:${createHash("sha256").update(pending.publicKey).digest("hex")}`;
  const accountResult = await request(
    fetcher,
    new URL("/api/v1/commands", pending.baseUrl),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "massion.application.v1",
        commandId: accountCommandId,
        correlationId: accountCommandId,
        operation: "subscription.account.register",
        payload: {
          providerId: pending.providerId,
          alias: accountAlias,
          connectorId: pending.connectorId,
          profileLocator,
          authKind: pending.authKind,
          billingKind: accountBillingKind,
          ...(externalProvider(pending.providerId) ? { acceptExperimental: true } : {}),
        },
      }),
    },
    "구독 계정 연결",
    options.signal,
    timeoutMs,
  );
  const accountData = record(accountResult.data, "구독 계정 연결 응답 data");
  if (
    accountResult.outcome !== "succeeded" ||
    accountData.providerId !== pending.providerId ||
    accountData.connectorId !== pending.connectorId ||
    accountData.alias !== accountAlias ||
    accountData.billingKind !== accountBillingKind ||
    accountData.scope !== "personal" ||
    typeof accountData.accountId !== "string" ||
    typeof accountData.status !== "string" ||
    !Number.isSafeInteger(accountData.version) ||
    Number(accountData.version) < 1
  ) {
    throw new Error("구독 계정 연결 응답 계보가 일치하지 않습니다");
  }
  const identity = await new ConnectorIdentityStore(options.identityFile).activate(pending, context);
  return {
    identity,
    account: {
      accountId: accountData.accountId,
      providerId: pending.providerId,
      alias: accountAlias,
      scope: "personal",
      connectorId: pending.connectorId,
      billingKind: accountBillingKind,
      status: accountData.status,
      version: Number(accountData.version),
    },
  };
}
