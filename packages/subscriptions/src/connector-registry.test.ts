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
  let publicKey: string;

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
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
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

  function heartbeat(nonce: string, profileHealthObservedAt = now.toISOString()): ConnectorHeartbeat {
    const unsigned = {
      organizationId: context.organizationId,
      connectorId: "edge-claude-1",
      version: "1.0.1",
      capabilities: ["claude", "quota"],
      observedAt: now.toISOString(),
      profileHealthObservedAt,
      nonce,
    };
    return {
      ...unsigned,
      signature: sign(null, createHeartbeatSignaturePayload(unsigned), privateKey).toString("base64url"),
    };
  }

  it("등록 직후에는 실행 가능 상태로 승격하지 않고 첫 서명 heartbeat만 ready로 전환한다", async () => {
    const enrolled = await registry.get(context, "edge-claude-1");
    expect(enrolled).toMatchObject({ status: "enrolling" });
    expect(enrolled).not.toHaveProperty("last_heartbeat_at");
    expect(enrolled).not.toHaveProperty("expires_at");

    const ready = await registry.heartbeat(heartbeat("first-live-heartbeat"));
    expect(ready).toMatchObject({ status: "ready" });
    expect(new Date(String(ready.last_heartbeat_at)).toISOString()).toBe(now.toISOString());
    expect(new Date(String(ready.expires_at)).toISOString()).toBe(new Date(now.getTime() + 30_000).toISOString());
  });

  it("서명된 heartbeat nonce를 재사용할 수 없다", async () => {
    const input = heartbeat("heartbeat-nonce-1");

    await expect(registry.heartbeat(input)).resolves.toMatchObject({
      status: "ready",
      version: "1.0.1",
      trust_origin: "edge-device",
    });
    await expect(registry.heartbeat(input)).rejects.toThrow("재사용");
  });

  it("서명 시각 허용 범위를 충분히 지난 nonce를 정리해 장기 실행 저장소가 무한 증가하지 않는다", async () => {
    const nonce = "heartbeat-retention-nonce";
    await registry.heartbeat(heartbeat(nonce));
    const [before] = await database.query<[Array<{ nonce_id: string }>]>(
      "SELECT nonce_id FROM subscription_connector_nonce;",
    );
    expect(before).toHaveLength(1);

    now = new Date(now.getTime() + 60_001);
    await registry.expire();

    const [after] = await database.query<[Array<{ nonce_id: string }>]>(
      "SELECT nonce_id FROM subscription_connector_nonce;",
    );
    expect(after).toEqual([]);
    await expect(registry.heartbeat(heartbeat(nonce))).resolves.toMatchObject({ status: "ready" });
  });

  it("장치 등록 경로는 server 위치를 거부하고 Edge의 Ed25519 신뢰만 만든다", async () => {
    await expect(
      enrollment.issue(context, {
        commandId: randomUUID(),
        location: "server",
        executionKind: "agent-runtime",
      }),
    ).rejects.toThrow("Edge");
    const [connectors] = await database.query<[unknown[]]>(
      "SELECT connector_id FROM subscription_connector WHERE connector_id = 'server-through-edge-registry';",
    );
    expect(connectors).toEqual([]);
  });

  it("서버 관리형 Connector에는 장치 heartbeat를 적용하지 않는다", async () => {
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'server-managed', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', trust_origin: 'server-managed', provider_id: 'openai-codex',
        execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        runtime_id: 'codex-app-server', runtime_artifact_digest: $digest,
        capabilities: ['openai-codex'], status: 'offline', created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        digest: "f".repeat(64),
      },
    );

    await expect(
      registry.heartbeat({ ...heartbeat("server-heartbeat-nonce"), connectorId: "server-managed" }),
    ).rejects.toThrow("Edge");
  });

  it("heartbeat TTL이 지나면 Connector와 계정이 offline이 되고 새 신호로 복구된다", async () => {
    await registry.heartbeat(heartbeat("heartbeat-before-expiry"));
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

  it("needs-reauth 계정은 상태 전이 뒤의 profile 건강 증명이 포함된 heartbeat로만 복구한다", async () => {
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'account-needs-reauth', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'anthropic-claude', alias: 'Claude', scope: 'personal', connector_id: 'edge-claude-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'needs-reauth',
        consent_version: 0, version: 2, created_at: $created_at, updated_at: $updated_at
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        fingerprint: "d".repeat(64),
        created_at: new Date(now.getTime() - 60_000),
        updated_at: now,
      },
    );

    await registry.heartbeat(heartbeat("stale-profile-health-nonce", new Date(now.getTime() - 1_000).toISOString()));
    const [stale] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'account-needs-reauth';",
    );
    expect(stale).toEqual([{ status: "needs-reauth", version: 2 }]);

    now = new Date(now.getTime() + 1_000);
    await registry.heartbeat(heartbeat("fresh-profile-health-nonce"));
    const [recovered] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'account-needs-reauth';",
    );
    expect(recovered).toEqual([{ status: "active", version: 3 }]);
  });

  it("heartbeat TTL 만료는 Edge 장치만 대상으로 하고 서버 관리형 Connector를 건드리지 않는다", async () => {
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'server-ready', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'server', trust_origin: 'server-managed', provider_id: 'openai-codex',
        execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        runtime_id: 'codex-app-server', runtime_artifact_digest: $digest,
        process_generation: 1, last_health_at: time::now(),
        capabilities: ['openai-codex'], status: 'ready', created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'server-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-ready',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'expired-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
        protocol: 'massion.connector.v1', version: '1.0.0', public_key: $public_key,
        capabilities: ['openai-codex'], status: 'ready', last_heartbeat_at: time::now() - 2m,
        expires_at: time::now() - 1m,
        created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        digest: "1".repeat(64),
        fingerprint: "2".repeat(64),
        public_key: publicKey,
      },
    );
    now = new Date("2030-01-01T00:00:31.000Z");

    await expect(registry.expire()).resolves.toBe(1);
    await expect(registry.get(context, "server-ready")).resolves.toMatchObject({ status: "ready" });
    await expect(registry.get(context, "expired-edge")).resolves.toMatchObject({ status: "offline" });
    await expect(registry.get(context, "edge-claude-1")).resolves.toMatchObject({ status: "enrolling" });
    const [accounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'server-account';",
    );
    expect(accounts).toEqual([{ status: "active" }]);
  });

  it("계정 소유자 또는 조직 관리자만 Connector를 폐기할 수 있다", async () => {
    await expect(registry.revoke(context, "edge-claude-1")).resolves.toMatchObject({ status: "revoked" });
    await expect(registry.heartbeat(heartbeat("heartbeat-after-revoke"))).rejects.toThrow("폐기");
  });
});
