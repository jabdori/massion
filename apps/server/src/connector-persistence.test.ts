import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import {
  ConnectorEnrollmentService,
  ConnectorRegistry,
  createEnrollmentSignaturePayload,
  createHeartbeatSignaturePayload,
} from "@massion/subscriptions";

import { ConnectorChannelPersistence } from "./connector-persistence.js";

describe("Connector 채널 영속 상태", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let registry: ConnectorRegistry;
  let persistence: ConnectorChannelPersistence;
  let privateKey: KeyObject;
  let publicKey: string;
  const now = new Date("2030-01-01T00:00:00.000Z");

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "channel@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const enrollment = await ConnectorEnrollmentService.create(database, organizations, { now: () => now });
    registry = await ConnectorRegistry.create(database, organizations, enrollment, {
      now: () => now,
      heartbeatTtlMs: 30_000,
      maximumClockSkewMs: 5_000,
    });
    persistence = new ConnectorChannelPersistence(database, registry, { now: () => now });
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const issued = await enrollment.issue(context, {
      commandId: randomUUID(),
      location: "edge",
      executionKind: "agent-runtime",
    });
    const unsigned = {
      ...issued,
      connectorId: "edge-connector-1",
      publicKey,
      protocol: "massion.connector.v1",
      version: "1.0.0",
      capabilities: ["anthropic-claude-code"],
    };
    await registry.enroll({
      ...unsigned,
      signature: sign(null, createEnrollmentSignaturePayload(unsigned), privateKey).toString("base64url"),
    });
  });

  afterEach(async () => await database.close());

  it("활성 Edge 장치의 공개 key만 handshake에 제공한다", async () => {
    await expect(
      persistence.findPublicKey({ organizationId: context.organizationId, connectorId: "edge-connector-1" }),
    ).resolves.toBe(publicKey);

    await registry.revoke(context, "edge-connector-1");

    await expect(
      persistence.findPublicKey({ organizationId: context.organizationId, connectorId: "edge-connector-1" }),
    ).resolves.toBeUndefined();
  });

  it("handshake nonce를 데이터베이스에서 원자적으로 한 번만 선점한다", async () => {
    const input = {
      organizationId: context.organizationId,
      connectorId: "edge-connector-1",
      nonceHash: "a".repeat(64),
      observedAt: now.toISOString(),
      claimedAt: now.toISOString(),
    };

    const results = await Promise.all(Array.from({ length: 8 }, async () => await persistence.claim(input)));

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(persistence.claim(input)).resolves.toBe(false);
  });

  it("연결 종료는 Connector와 연결 계정을 offline으로 만들고 서명 heartbeat로 복구한다", async () => {
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'account-1', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'anthropic-claude-code', alias: 'Claude', scope: 'personal',
        connector_id: 'edge-connector-1', profile_fingerprint: $fingerprint,
        billing_kind: 'consumer-subscription', status: 'offline', consent_version: 0, version: 1,
        created_at: $now, updated_at: $now
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        fingerprint: "f".repeat(64),
        now,
      },
    );
    await expect(
      persistence.connected({
        organizationId: context.organizationId,
        connectorId: "edge-connector-1",
        observedAt: now.toISOString(),
      }),
    ).resolves.toBeUndefined();

    const firstHeartbeat = {
      organizationId: context.organizationId,
      connectorId: "edge-connector-1",
      version: "1.0.1",
      capabilities: ["anthropic-claude-code"],
      observedAt: now.toISOString(),
      profileHealthObservedAt: now.toISOString(),
      nonce: "heartbeat-nonce-first-live",
    };
    await persistence.heartbeat({
      ...firstHeartbeat,
      signature: sign(null, createHeartbeatSignaturePayload(firstHeartbeat), privateKey).toString("base64url"),
    });
    await expect(registry.get(context, "edge-connector-1")).resolves.toMatchObject({ status: "ready" });
    const [initiallyActiveAccounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'account-1';",
    );
    expect(initiallyActiveAccounts[0]?.status).toBe("active");

    await persistence.disconnected({ organizationId: context.organizationId, connectorId: "edge-connector-1" });

    await expect(registry.get(context, "edge-connector-1")).resolves.toMatchObject({ status: "offline" });
    const [offlineAccounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'account-1';",
    );
    expect(offlineAccounts[0]?.status).toBe("offline");

    const heartbeatUnsigned = {
      organizationId: context.organizationId,
      connectorId: "edge-connector-1",
      version: "1.0.1",
      capabilities: ["anthropic-claude-code"],
      observedAt: now.toISOString(),
      profileHealthObservedAt: now.toISOString(),
      nonce: "heartbeat-nonce-unique-1",
    };
    await persistence.heartbeat({
      ...heartbeatUnsigned,
      signature: sign(null, createHeartbeatSignaturePayload(heartbeatUnsigned), privateKey).toString("base64url"),
    });

    await expect(registry.get(context, "edge-connector-1")).resolves.toMatchObject({ status: "ready" });
    const [activeAccounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'account-1';",
    );
    expect(activeAccounts[0]?.status).toBe("active");
  });
});
