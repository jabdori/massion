import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ConnectorExecutionKind, ConnectorLocation } from "./contracts.js";
import { SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION, SUBSCRIPTION_MIGRATION } from "./schema.js";

const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1_000;

interface EnrollmentRecord {
  readonly enrollment_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly command_id: string;
  readonly code_hash: string;
  readonly challenge_nonce: string;
  readonly location: ConnectorLocation;
  readonly execution_kind: ConnectorExecutionKind;
  readonly status: "pending" | "used" | "expired";
  readonly expires_at: unknown;
  readonly used_at?: unknown;
  readonly created_at: unknown;
}

export interface IssueEnrollmentInput {
  readonly commandId: string;
  readonly location: ConnectorLocation;
  readonly executionKind: ConnectorExecutionKind;
  readonly ttlMs?: number;
}

export interface IssuedEnrollment {
  readonly enrollmentId: string;
  readonly enrollmentCode: string;
  readonly challengeNonce: string;
  readonly expiresAt: string;
}

export interface EnrollmentVerificationInput extends IssuedEnrollment {
  readonly connectorId: string;
  readonly publicKey: string;
  readonly protocol: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly signature: string;
}

export interface VerifiedEnrollment {
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly location: ConnectorLocation;
  readonly executionKind: ConnectorExecutionKind;
}

export interface EnrollmentServiceOptions {
  readonly now?: () => Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}은(는) 비어 있을 수 없습니다`);
  return normalized;
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
  const normalized = [...new Set(capabilities.map((capability) => requireText(capability, "Capability")))].sort();
  if (normalized.length === 0) throw new Error("Connector capability가 하나 이상 필요합니다");
  return normalized;
}

export function createEnrollmentSignaturePayload(input: Omit<EnrollmentVerificationInput, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify({
      enrollmentId: input.enrollmentId,
      challengeNonce: input.challengeNonce,
      connectorId: input.connectorId,
      publicKey: input.publicKey,
      protocol: input.protocol,
      version: input.version,
      capabilities: normalizeCapabilities(input.capabilities),
    }),
  );
}

export class ConnectorEnrollmentService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly now: () => Date,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: EnrollmentServiceOptions = {},
  ): Promise<ConnectorEnrollmentService> {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION]);
    return new ConnectorEnrollmentService(database, organizations, options.now ?? (() => new Date()));
  }

  public async issue(context: TenantContext, input: IssueEnrollmentInput): Promise<IssuedEnrollment> {
    await this.organizations.verifyTenantContext(context);
    requireText(input.commandId, "Command ID");
    if (input.location !== "edge") throw new Error("일회 장치 등록 code는 Edge Connector에만 발급할 수 있습니다");
    const ttlMs = input.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_ENROLLMENT_TTL_MS) {
      throw new Error("Connector 등록 code TTL은 1ms 이상 10분 이하여야 합니다");
    }
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const enrollmentCode = randomBytes(32).toString("base64url");
    const issued = {
      enrollmentId: randomUUID(),
      enrollmentCode,
      challengeNonce: randomBytes(32).toString("base64url"),
      expiresAt: expiresAt.toISOString(),
    };
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [repeated] = await tx.query<[Array<{ enrollment_id: string }>]>(
        `SELECT enrollment_id FROM subscription_connector_enrollment
         WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) {
        throw new Error("일회용 Connector 등록 code 발급 명령은 재사용할 수 없습니다");
      }
      await tx.query(
        `CREATE subscription_connector_enrollment CONTENT {
          enrollment_id: $enrollment_id,
          organization_id: $organization_id,
          owner_user_id: $owner_user_id,
          command_id: $command_id,
          code_hash: $code_hash,
          challenge_nonce: $challenge_nonce,
          location: $location,
          execution_kind: $execution_kind,
          status: 'pending',
          expires_at: $expires_at,
          created_at: $created_at
        };`,
        {
          enrollment_id: issued.enrollmentId,
          organization_id: context.organizationId,
          owner_user_id: context.userId,
          command_id: input.commandId,
          code_hash: sha256(enrollmentCode),
          challenge_nonce: issued.challengeNonce,
          location: input.location,
          execution_kind: input.executionKind,
          expires_at: expiresAt,
          created_at: now,
        },
      );
    });
    return issued;
  }

  public async verify(
    input: EnrollmentVerificationInput,
    now = this.now(),
    executor: QueryExecutor = this.database,
  ): Promise<VerifiedEnrollment> {
    const operation = async (tx: QueryExecutor): Promise<VerifiedEnrollment> => {
      const [records] = await tx.query<[EnrollmentRecord[]]>(
        `SELECT * OMIT id FROM subscription_connector_enrollment
         WHERE enrollment_id = $enrollment_id AND code_hash = $code_hash LIMIT 1;`,
        { enrollment_id: input.enrollmentId, code_hash: sha256(input.enrollmentCode) },
      );
      const record = records[0];
      if (!record) throw new Error("Connector 등록 code가 유효하지 않습니다");
      if (record.location !== "edge") throw new Error("일회 장치 등록 code는 Edge Connector에만 사용할 수 있습니다");
      if (record.status === "used") throw new Error("Connector 등록 code를 재사용할 수 없습니다");
      if (record.status !== "pending" || new Date(String(record.expires_at)).getTime() <= now.getTime()) {
        await tx.query(
          "UPDATE subscription_connector_enrollment SET status = 'expired' WHERE enrollment_id = $enrollment_id AND status = 'pending';",
          { enrollment_id: input.enrollmentId },
        );
        throw new Error("Connector 등록 code가 만료됐습니다");
      }
      if (input.challengeNonce !== record.challenge_nonce)
        throw new Error("Connector 등록 challenge가 일치하지 않습니다");
      const key = this.requireEd25519Key(input.publicKey);
      if (!/^[A-Za-z0-9_-]{86}$/u.test(input.signature))
        throw new Error("Connector 장치 서명 형식이 유효하지 않습니다");
      const valid = verifySignature(
        null,
        createEnrollmentSignaturePayload(input),
        key,
        Buffer.from(input.signature, "base64url"),
      );
      if (!valid) throw new Error("Connector 장치 서명이 유효하지 않습니다");
      const [updated] = await tx.query<[EnrollmentRecord[]]>(
        `UPDATE subscription_connector_enrollment
         SET status = 'used', used_at = $used_at
         WHERE enrollment_id = $enrollment_id AND status = 'pending' RETURN AFTER;`,
        { enrollment_id: input.enrollmentId, used_at: now },
      );
      if (!updated[0]) throw new Error("Connector 등록 code를 재사용할 수 없습니다");
      return {
        organizationId: record.organization_id,
        ownerUserId: record.owner_user_id,
        location: record.location,
        executionKind: record.execution_kind,
      };
    };
    return executor === this.database ? await this.database.transaction(operation) : await operation(executor);
  }

  private requireEd25519Key(publicKey: string) {
    try {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("not-ed25519");
      return key;
    } catch {
      throw new Error("Connector 공개 key는 Ed25519 SPKI key여야 합니다");
    }
  }
}
