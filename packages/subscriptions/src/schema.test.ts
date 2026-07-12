import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import {
  SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION,
  SUBSCRIPTION_EDGE_ACCOUNT_GUARD_MIGRATION,
  SUBSCRIPTION_LEASE_EXECUTION_MIGRATION,
  SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION,
  SUBSCRIPTION_MIGRATION,
  SUBSCRIPTION_EDGE_READY_MIGRATION,
  SUBSCRIPTION_NONCE_RETENTION_MIGRATION,
  SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION,
} from "./schema.js";

describe("구독 계정 schema", () => {
  let database: MassionDatabase;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
  });

  afterEach(async () => database.close());

  it("구독 계정·연결기·할당량·실행 임대 schema를 멱등 적용한다", async () => {
    expect(SUBSCRIPTION_MIGRATION.checksum).toBe("0a6d43756b5464f162bac61dc4c2160fee15e01a0bad37540165606ac92ac79c");
    expect(SUBSCRIPTION_LEASE_EXECUTION_MIGRATION.checksum).toBe(
      "f9f21917d831d13532c687d3017845917352df907391157a7a26709f6694ab96",
    );
    await expect(
      applyMigrations(database, [
        SUBSCRIPTION_MIGRATION,
        SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION,
        SUBSCRIPTION_LEASE_EXECUTION_MIGRATION,
      ]),
    ).resolves.toEqual([
      SUBSCRIPTION_MIGRATION.id,
      SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.id,
      SUBSCRIPTION_LEASE_EXECUTION_MIGRATION.id,
    ]);
    await expect(
      applyMigrations(database, [
        SUBSCRIPTION_MIGRATION,
        SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION,
        SUBSCRIPTION_LEASE_EXECUTION_MIGRATION,
      ]),
    ).resolves.toEqual([]);

    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_MIGRATION.id,
      checksum: SUBSCRIPTION_MIGRATION.checksum,
    });
    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_LEASE_EXECUTION_MIGRATION.id,
      checksum: SUBSCRIPTION_LEASE_EXECUTION_MIGRATION.checksum,
    });
    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.id,
      checksum: SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.checksum,
    });
    const schema = JSON.stringify(await database.query("INFO FOR DB;"));
    for (const table of [
      "subscription_account",
      "subscription_consent",
      "subscription_connector",
      "subscription_quota_snapshot",
      "subscription_quota_current",
      "subscription_session_lease",
      "subscription_audit_event",
      "subscription_connector_enrollment",
      "subscription_connector_nonce",
    ]) {
      expect(schema).toContain(table);
    }
  });

  it("0091 upgrade는 Runtime 계보가 없는 기존 active Lease를 안전하게 만료시킨다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION]);
    await database.query(
      `CREATE subscription_session_lease CONTENT {
        lease_id: 'legacy-lease', organization_id: 'organization-1', account_id: 'account-1',
        connector_id: 'connector-1', work_id: 'work-1', agent_handle: 'agent-1',
        route_attempt_id: 'attempt-1', status: 'active', expires_at: time::now() + 5m,
        created_at: time::now(), updated_at: time::now()
      };`,
    );

    await applyMigrations(database, [SUBSCRIPTION_LEASE_EXECUTION_MIGRATION]);
    const [leases] = await database.query<[Array<{ status: string; execution_id?: string }>]>(
      "SELECT status, execution_id FROM subscription_session_lease WHERE lease_id = 'legacy-lease';",
    );

    expect(leases).toEqual([{ status: "expired" }]);
  });

  it("0100 upgrade는 adapter 계보가 없는 기존 active Lease를 안전하게 만료시킨다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_LEASE_EXECUTION_MIGRATION]);
    await database.query(
      `CREATE subscription_session_lease CONTENT {
        lease_id: 'legacy-runtime-lease', organization_id: 'organization-1', account_id: 'account-1',
        connector_id: 'connector-1', execution_id: 'execution-1', work_id: 'work-1', agent_handle: 'agent-1',
        route_attempt_id: 'attempt-1', status: 'active', expires_at: time::now() + 5m,
        created_at: time::now(), updated_at: time::now()
      };`,
    );

    await expect(applyMigrations(database, [SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION])).resolves.toEqual([
      "0100-subscription-lease-runtime-lineage",
    ]);
    await expect(applyMigrations(database, [SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION])).resolves.toEqual([]);
    const [leases] = await database.query<[Array<{ status: string; adapter_id?: string }>]>(
      "SELECT status, adapter_id FROM subscription_session_lease WHERE lease_id = 'legacy-runtime-lease';",
    );

    expect(leases).toEqual([{ status: "expired" }]);
  });

  it("0101 Edge 계정 guard는 한 물리 Connector의 동시 논리 계정 점유를 하나로 제한한다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_EDGE_ACCOUNT_GUARD_MIGRATION]);
    await database.query(
      `CREATE subscription_edge_account_guard CONTENT {
        organization_id: 'organization-1', connector_id: 'edge-1',
        account_id: 'account-1', created_at: time::now()
      };`,
    );

    await expect(
      database.query(
        `CREATE subscription_edge_account_guard CONTENT {
          organization_id: 'organization-1', connector_id: 'edge-1',
          account_id: 'account-2', created_at: time::now()
        };`,
      ),
    ).rejects.toThrow();
    await expect(applyMigrations(database, [SUBSCRIPTION_EDGE_ACCOUNT_GUARD_MIGRATION])).resolves.toEqual([]);
  });

  it("0093 upgrade는 기존 Connector를 Edge 장치 신뢰로 이관하고 서버 관리형 공개 key 부재를 허용한다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION]);
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'legacy-edge', organization_id: 'organization-1', owner_user_id: 'user-1',
        location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        public_key: 'legacy-public-key', capabilities: ['openai-codex'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'legacy-server', organization_id: 'organization-1', owner_user_id: 'user-1',
        location: 'server', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '0.9.0',
        public_key: 'legacy-server-key', capabilities: ['openai-codex'], status: 'ready',
        expires_at: time::now() + 1h, created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'legacy-server-account', organization_id: 'organization-1', owner_user_id: 'user-1',
        provider_id: 'openai-codex', alias: 'Legacy', scope: 'personal', connector_id: 'legacy-server',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'legacy-server', organization_id: 'organization-2', owner_user_id: 'user-2',
        location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        public_key: 'other-edge-key', capabilities: ['openai-codex'], status: 'ready',
        expires_at: time::now() + 1h, created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'other-edge-account', organization_id: 'organization-2', owner_user_id: 'user-2',
        provider_id: 'openai-codex', alias: 'Other', scope: 'personal', connector_id: 'legacy-server',
        profile_fingerprint: $other_fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      { fingerprint: "f".repeat(64), other_fingerprint: "0".repeat(64) },
    );

    expect(SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION.id).toBe("0093-subscription-server-connector");
    expect(SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION.checksum).toBe(
      "320adbc000d8eb8beb632e3397d7618863f4d676c92542ad30abd5dd786671bc",
    );
    await expect(applyMigrations(database, [SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION])).resolves.toEqual([
      SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION.id,
    ]);
    await expect(applyMigrations(database, [SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION])).resolves.toEqual([]);
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'server-managed', organization_id: 'organization-1', owner_user_id: 'user-1',
        location: 'server', trust_origin: 'server-managed', provider_id: 'openai-codex',
        execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        runtime_id: 'codex', runtime_artifact_digest: $digest,
        capabilities: ['openai-codex'], status: 'offline', created_at: time::now(), updated_at: time::now()
      };`,
      { digest: "e".repeat(64) },
    );
    const [connectors] = await database.query<
      [Array<{ connector_id: string; trust_origin: string; public_key?: string; status: string }>]
    >(
      "SELECT connector_id, trust_origin, public_key, status FROM subscription_connector WHERE organization_id = 'organization-1' ORDER BY connector_id ASC;",
    );

    expect(connectors).toEqual([
      {
        connector_id: "legacy-edge",
        public_key: "legacy-public-key",
        status: "ready",
        trust_origin: "edge-device",
      },
      {
        connector_id: "legacy-server",
        public_key: "legacy-server-key",
        status: "offline",
        trust_origin: "edge-device",
      },
      { connector_id: "server-managed", public_key: undefined, status: "offline", trust_origin: "server-managed" },
    ]);
    const [accounts] = await database.query<[Array<{ account_id: string; status: string; version: number }>]>(
      "SELECT account_id, status, version FROM subscription_account ORDER BY account_id ASC;",
    );
    expect(accounts).toEqual([
      { account_id: "legacy-server-account", status: "offline", version: 2 },
      { account_id: "other-edge-account", status: "active", version: 1 },
    ]);
    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION.id,
      checksum: SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION.checksum,
    });
  });

  it("0093 trust 불변식은 Edge 공개 key와 서버 Runtime 계보를 schema에서도 fail-closed한다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION]);

    await expect(
      database.query(
        `CREATE subscription_connector CONTENT {
          connector_id: 'invalid-edge', organization_id: 'organization-1', owner_user_id: 'user-1',
          location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
          protocol: 'massion.connector.v1', version: '1.0.0', capabilities: ['openai-codex'],
          status: 'ready', created_at: time::now(), updated_at: time::now()
        };`,
      ),
    ).rejects.toThrow("신뢰 불변식");
    await expect(
      database.query(
        `CREATE subscription_connector CONTENT {
          connector_id: 'invalid-server', organization_id: 'organization-1', owner_user_id: 'user-1',
          location: 'server', trust_origin: 'server-managed', provider_id: 'openai-codex',
          execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
          public_key: 'must-not-exist', runtime_id: 'codex', runtime_artifact_digest: $digest,
          capabilities: ['openai-codex'], status: 'offline', created_at: time::now(), updated_at: time::now()
        };`,
        { digest: "a".repeat(64) },
      ),
    ).rejects.toThrow("신뢰 불변식");
    await expect(
      database.query(
        `CREATE subscription_connector CONTENT {
          connector_id: 'incomplete-server', organization_id: 'organization-1', owner_user_id: 'user-1',
          location: 'server', trust_origin: 'server-managed', execution_kind: 'agent-runtime',
          protocol: 'massion.connector.v1', version: '1.0.0', capabilities: ['openai-codex'],
          status: 'offline', created_at: time::now(), updated_at: time::now()
        };`,
      ),
    ).rejects.toThrow("신뢰 불변식");
  });

  it("0095는 실제 heartbeat 계보가 없는 Edge ready 상태를 enrolling으로 내리고 이후 조기 승격을 거부한다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION]);
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'legacy-premature-ready', organization_id: 'organization-1', owner_user_id: 'user-1',
        location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
        protocol: 'massion.connector.v1', version: '1.0.0', public_key: 'legacy-key',
        capabilities: ['openai-codex'], status: 'ready', created_at: time::now(), updated_at: time::now()
      };`,
    );

    expect(SUBSCRIPTION_EDGE_READY_MIGRATION.id).toBe("0095-subscription-edge-ready-lineage");
    expect(SUBSCRIPTION_EDGE_READY_MIGRATION.checksum).toBe(
      "f65854165ce62616a2bd92c869b4955b89370759f506dfcdbee55672e19092a0",
    );
    await expect(applyMigrations(database, [SUBSCRIPTION_EDGE_READY_MIGRATION])).resolves.toEqual([
      SUBSCRIPTION_EDGE_READY_MIGRATION.id,
    ]);
    await expect(applyMigrations(database, [SUBSCRIPTION_EDGE_READY_MIGRATION])).resolves.toEqual([]);
    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_EDGE_READY_MIGRATION.id,
      checksum: SUBSCRIPTION_EDGE_READY_MIGRATION.checksum,
    });
    const [migrated] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_connector WHERE connector_id = 'legacy-premature-ready';",
    );
    expect(migrated).toEqual([{ status: "enrolling" }]);

    await expect(
      database.query(
        `CREATE subscription_connector CONTENT {
          connector_id: 'premature-ready', organization_id: 'organization-1', owner_user_id: 'user-1',
          location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
          protocol: 'massion.connector.v1', version: '1.0.0', public_key: 'edge-key',
          capabilities: ['openai-codex'], status: 'ready', created_at: time::now(), updated_at: time::now()
        };`,
      ),
    ).rejects.toThrow("heartbeat 계보");
    await expect(
      database.query(
        `CREATE subscription_connector CONTENT {
          connector_id: 'live-ready', organization_id: 'organization-1', owner_user_id: 'user-1',
          location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
          protocol: 'massion.connector.v1', version: '1.0.0', public_key: 'edge-key',
          capabilities: ['openai-codex'], status: 'ready', last_heartbeat_at: time::now(),
          expires_at: time::now() + 30s, created_at: time::now(), updated_at: time::now()
        };`,
      ),
    ).resolves.toBeDefined();
  });

  it("0096은 nonce 갱신 불변식을 유지하면서 replay 허용 창이 지난 record 삭제를 허용한다", async () => {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION]);
    expect(SUBSCRIPTION_NONCE_RETENTION_MIGRATION.id).toBe("0096-subscription-nonce-retention");
    await expect(applyMigrations(database, [SUBSCRIPTION_NONCE_RETENTION_MIGRATION])).resolves.toEqual([
      SUBSCRIPTION_NONCE_RETENTION_MIGRATION.id,
    ]);
    await database.query(
      `CREATE subscription_connector_nonce CONTENT {
        nonce_id: 'retained-nonce', organization_id: 'organization-1', connector_id: 'connector-1',
        nonce_hash: $nonce_hash, observed_at: time::now(), created_at: time::now()
      };`,
      { nonce_hash: "a".repeat(64) },
    );

    await expect(database.query("UPDATE subscription_connector_nonce SET observed_at = time::now();")).rejects.toThrow(
      "갱신",
    );
    await expect(database.query("DELETE subscription_connector_nonce;")).resolves.toBeDefined();
    const [remaining] = await database.query<[unknown[]]>("SELECT * FROM subscription_connector_nonce;");
    expect(remaining).toEqual([]);
  });
});
