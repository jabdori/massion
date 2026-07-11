import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ConnectorRegistry, createHeartbeatSignaturePayload, type ConnectorHeartbeat } from "./connector-registry.js";
import { ConnectorEnrollmentService, createEnrollmentSignaturePayload } from "./enrollment.js";

describe("Connector 상태 확인 신호와 만료", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let enrollment: ConnectorEnrollmentService;
  let registry: ConnectorRegistry;
  let now: Date;
  let privateKey: KeyObject;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "connector@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    now = new Date("2030-01-01T00:00:00.000Z");
    enrollment = await ConnectorEnrollmentService.create(database, organizations, { now: () => now });
    registry = await ConnectorRegistry.create(database, organizations, enrollment, {
      now: () => now,
      heartbeatTtlMs: 30_000,
      maximumClockSkewMs: 5_000,
    });
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const issued = await enrollment.issue(context, {
      commandId: randomUUID(),
      location: "edge",
      executionKind: "agent-runtime",
    });
    const unsigned = {
      ...issued,
      connectorId: "edge-claude-1",
      publicKey,
      protocol: "massion-connector-v1",
      version: "1.0.0",
      capabilities: ["claude", "quota"],
    };
    await registry.enroll({
      ...unsigned,
      signature: sign(null, createEnrollmentSignaturePayload(unsigned), privateKey).toString("base64url"),
    });
  });

  afterEach(async () => database.close());

  function heartbeat(nonce: string): ConnectorHeartbeat {
    const unsigned = {
      organizationId: context.organizationId,
      connectorId: "edge-claude-1",
      version: "1.0.1",
      capabilities: ["claude", "quota"],
      observedAt: now.toISOString(),
      nonce,
    };
    return {
      ...unsigned,
      signature: sign(null, createHeartbeatSignaturePayload(unsigned), privateKey).toString("base64url"),
    };
  }

  it("서명된 heartbeat nonce를 재사용할 수 없다", async () => {
    const input = heartbeat("heartbeat-nonce-1");

    await expect(registry.heartbeat(input)).resolves.toMatchObject({ status: "ready", version: "1.0.1" });
    await expect(registry.heartbeat(input)).rejects.toThrow("재사용");
  });

  it("heartbeat TTL이 지나면 Connector와 계정이 offline이 되고 새 신호로 복구된다", async () => {
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'account-claude-1', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'anthropic-claude', alias: 'Claude', scope: 'personal', connector_id: 'edge-claude-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId, fingerprint: "a".repeat(64) },
    );
    now = new Date("2030-01-01T00:00:31.000Z");

    await expect(registry.expire()).resolves.toBe(1);
    await expect(registry.get(context, "edge-claude-1")).resolves.toMatchObject({ status: "offline" });
    const [offlineAccounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'account-claude-1';",
    );
    expect(offlineAccounts[0]).toMatchObject({ status: "offline" });

    await registry.heartbeat(heartbeat("heartbeat-nonce-2"));
    const [recoveredAccounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'account-claude-1';",
    );
    expect(recoveredAccounts[0]).toMatchObject({ status: "active" });
  });

  it("계정 소유자 또는 조직 관리자만 Connector를 폐기할 수 있다", async () => {
    await expect(registry.revoke(context, "edge-claude-1")).resolves.toMatchObject({ status: "revoked" });
    await expect(registry.heartbeat(heartbeat("heartbeat-after-revoke"))).rejects.toThrow("폐기");
  });
});
