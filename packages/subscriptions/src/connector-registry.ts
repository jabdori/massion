import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { SubscriptionConnector } from "./contracts.js";
import { ConnectorEnrollmentService, type EnrollmentVerificationInput } from "./enrollment.js";
import { SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION, SUBSCRIPTION_MIGRATION } from "./schema.js";

export type EnrollConnectorInput = EnrollmentVerificationInput;

export interface ConnectorHeartbeat {
  readonly organizationId: string;
  readonly connectorId: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly observedAt: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface ConnectorRegistryOptions {
  readonly now?: () => Date;
  readonly heartbeatTtlMs?: number;
  readonly maximumClockSkewMs?: number;
}

const DEFAULT_HEARTBEAT_TTL_MS = 30_000;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1_000;

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

export function createHeartbeatSignaturePayload(input: Omit<ConnectorHeartbeat, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify({
      organizationId: input.organizationId,
      connectorId: input.connectorId,
      version: input.version,
      capabilities: normalizeCapabilities(input.capabilities),
      observedAt: input.observedAt,
      nonce: input.nonce,
    }),
  );
}

export class ConnectorRegistry {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly enrollment: ConnectorEnrollmentService,
    private readonly now: () => Date,
    private readonly heartbeatTtlMs: number,
    private readonly maximumClockSkewMs: number,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    enrollment: ConnectorEnrollmentService,
    options: ConnectorRegistryOptions = {},
  ): Promise<ConnectorRegistry> {
    const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    const maximumClockSkewMs = options.maximumClockSkewMs ?? DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(heartbeatTtlMs) || heartbeatTtlMs < 1)
      throw new Error("Heartbeat TTL이 유효하지 않습니다");
    if (!Number.isSafeInteger(maximumClockSkewMs) || maximumClockSkewMs < 0) {
      throw new Error("Heartbeat 허용 시각 오차가 유효하지 않습니다");
    }
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION]);
    return new ConnectorRegistry(
      database,
      organizations,
      enrollment,
      options.now ?? (() => new Date()),
      heartbeatTtlMs,
      maximumClockSkewMs,
    );
  }

  public async enroll(input: EnrollConnectorInput): Promise<SubscriptionConnector> {
    const now = this.now();
    return await this.database.transaction(async (tx) => {
      const verified = await this.enrollment.verify(input, now, tx);
      const connectorId = requireText(input.connectorId, "Connector ID");
      const protocol = requireText(input.protocol, "Connector protocol");
      const version = requireText(input.version, "Connector version");
      const capabilities = normalizeCapabilities(input.capabilities);
      await tx.query(
        `CREATE subscription_connector CONTENT {
          connector_id: $connector_id,
          organization_id: $organization_id,
          owner_user_id: $owner_user_id,
          location: $location,
          execution_kind: $execution_kind,
          protocol: $protocol,
          version: $version,
          public_key: $public_key,
          capabilities: $capabilities,
          status: 'ready',
          last_heartbeat_at: $last_heartbeat_at,
          expires_at: $expires_at,
          created_at: $created_at,
          updated_at: $created_at
        };`,
        {
          connector_id: connectorId,
          organization_id: verified.organizationId,
          owner_user_id: verified.ownerUserId,
          location: verified.location,
          execution_kind: verified.executionKind,
          protocol,
          version,
          public_key: input.publicKey,
          capabilities,
          last_heartbeat_at: now,
          expires_at: new Date(now.getTime() + this.heartbeatTtlMs),
          created_at: now,
        },
      );
      return await this.requireConnector(tx, verified.organizationId, connectorId);
    });
  }

  public async heartbeat(input: ConnectorHeartbeat): Promise<SubscriptionConnector> {
    const now = this.now();
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Heartbeat 관측 시각이 유효하지 않습니다");
    if (Math.abs(now.getTime() - observedAt.getTime()) > this.maximumClockSkewMs) {
      throw new Error("Heartbeat 관측 시각이 허용 범위를 벗어났습니다");
    }
    const nonce = requireText(input.nonce, "Heartbeat nonce");
    if (nonce.length < 16 || nonce.length > 256) throw new Error("Heartbeat nonce 길이가 유효하지 않습니다");
    const capabilities = normalizeCapabilities(input.capabilities);

    return await this.database.transaction(async (tx) => {
      const connector = await this.requireConnector(tx, input.organizationId, input.connectorId);
      if (connector.status === "revoked") throw new Error("폐기된 Connector는 heartbeat를 보낼 수 없습니다");
      if (connector.status === "incompatible") throw new Error("호환되지 않는 Connector입니다");
      if (!/^[A-Za-z0-9_-]{86}$/u.test(input.signature)) throw new Error("Heartbeat 서명 형식이 유효하지 않습니다");
      const key = createPublicKey(connector.public_key);
      if (
        key.asymmetricKeyType !== "ed25519" ||
        !verifySignature(null, createHeartbeatSignaturePayload(input), key, Buffer.from(input.signature, "base64url"))
      ) {
        throw new Error("Heartbeat 장치 서명이 유효하지 않습니다");
      }
      const nonceHash = sha256(nonce);
      const [replays] = await tx.query<[Array<{ nonce_id: string }>]>(
        `SELECT nonce_id FROM subscription_connector_nonce
         WHERE organization_id = $organization_id AND connector_id = $connector_id AND nonce_hash = $nonce_hash
         LIMIT 1;`,
        { organization_id: input.organizationId, connector_id: input.connectorId, nonce_hash: nonceHash },
      );
      if (replays[0]) throw new Error("Heartbeat nonce를 재사용할 수 없습니다");
      await tx.query(
        `CREATE subscription_connector_nonce CONTENT {
          nonce_id: $nonce_id, organization_id: $organization_id, connector_id: $connector_id,
          nonce_hash: $nonce_hash, observed_at: $observed_at, created_at: $created_at
        };`,
        {
          nonce_id: randomUUID(),
          organization_id: input.organizationId,
          connector_id: input.connectorId,
          nonce_hash: nonceHash,
          observed_at: observedAt,
          created_at: now,
        },
      );
      await tx.query(
        `UPDATE subscription_connector
         SET version = $version, capabilities = $capabilities, status = 'ready',
             last_heartbeat_at = $observed_at, expires_at = $expires_at, updated_at = $updated_at
         WHERE organization_id = $organization_id AND connector_id = $connector_id;`,
        {
          organization_id: input.organizationId,
          connector_id: input.connectorId,
          version: requireText(input.version, "Connector version"),
          capabilities,
          observed_at: observedAt,
          expires_at: new Date(now.getTime() + this.heartbeatTtlMs),
          updated_at: now,
        },
      );
      await tx.query(
        `UPDATE subscription_account SET status = 'active', version += 1, updated_at = $updated_at
         WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'offline';`,
        { organization_id: input.organizationId, connector_id: input.connectorId, updated_at: now },
      );
      return await this.requireConnector(tx, input.organizationId, input.connectorId);
    });
  }

  public async expire(now = this.now()): Promise<number> {
    return await this.database.transaction(async (tx) => {
      const [expired] = await tx.query<[SubscriptionConnector[]]>(
        `SELECT * OMIT id FROM subscription_connector
         WHERE status = 'ready' AND expires_at <= $now ORDER BY connector_id ASC;`,
        { now },
      );
      for (const connector of expired) {
        await tx.query(
          `UPDATE subscription_connector SET status = 'offline', updated_at = $now
           WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'ready';
           UPDATE subscription_account SET status = 'offline', version += 1, updated_at = $now
           WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'active';`,
          { organization_id: connector.organization_id, connector_id: connector.connector_id, now },
        );
      }
      return expired.length;
    });
  }

  public async get(context: TenantContext, connectorId: string): Promise<SubscriptionConnector> {
    await this.organizations.verifyTenantContext(context);
    return await this.requireConnector(this.database, context.organizationId, connectorId);
  }

  public async revoke(context: TenantContext, connectorId: string): Promise<SubscriptionConnector> {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const connector = await this.requireConnector(tx, context.organizationId, connectorId);
      if (connector.owner_user_id !== context.userId && context.role === "member") {
        throw new Error("Connector 소유자 또는 조직 관리자만 폐기할 수 있습니다");
      }
      const now = this.now();
      await tx.query(
        `UPDATE subscription_connector SET status = 'revoked', updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id;
         UPDATE subscription_account SET status = 'offline', version += 1, updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'active';`,
        { organization_id: context.organizationId, connector_id: connectorId, now },
      );
      return await this.requireConnector(tx, context.organizationId, connectorId);
    });
  }

  private async requireConnector(
    executor: QueryExecutor,
    organizationId: string,
    connectorId: string,
  ): Promise<SubscriptionConnector> {
    const [connectors] = await executor.query<[SubscriptionConnector[]]>(
      `SELECT * OMIT id FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id LIMIT 1;`,
      { organization_id: organizationId, connector_id: connectorId },
    );
    if (!connectors[0]) throw new Error(`Connector를 찾을 수 없습니다: ${connectorId}`);
    return connectors[0];
  }
}
