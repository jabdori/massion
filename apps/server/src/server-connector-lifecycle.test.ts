import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { ServerConnectorProvisioningService } from "@massion/subscriptions";

import { ServerConnectorLifecycleService } from "./server-connector-lifecycle.js";

describe("서버 관리형 Connector 수명주기", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let provisioning: ServerConnectorProvisioningService;
  const now = new Date("2030-01-01T00:00:00.000Z");

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "lifecycle@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    provisioning = await ServerConnectorProvisioningService.create(database, organizations, {
      now: () => now,
      runtimeAttestor: {
        inspectArtifact: async () => ({
          runtimeId: "codex",
          runtimeArtifactDigest: "a".repeat(64),
          version: "1.0.0",
        }),
        attestHealth: async (input) => ({
          runtimeId: input.runtimeId,
          runtimeArtifactDigest: input.runtimeArtifactDigest,
          processGeneration: (input.previousProcessGeneration ?? 0) + 1,
          processState: "new-process",
        }),
      },
    });
    await provisioning.provision(context, {
      commandId: "provision-server",
      connectorId: "server-codex",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
    });
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex',
        profile_fingerprint: $server_fingerprint, billing_kind: 'consumer-subscription', status: 'offline',
        consent_version: 0, version: 1, created_at: $now, updated_at: $now
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'edge-codex', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', trust_origin: 'edge-device', execution_kind: 'agent-runtime',
        protocol: 'massion.connector.v1', version: '1.0.0', public_key: 'test-public-key',
        capabilities: ['openai-codex'], status: 'ready', last_heartbeat_at: $now,
        expires_at: $expires_at, created_at: $now, updated_at: $now
      };
      CREATE subscription_account CONTENT {
        account_id: 'edge-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Edge Codex', scope: 'personal', connector_id: 'edge-codex',
        profile_fingerprint: $edge_fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: $now, updated_at: $now
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        server_fingerprint: "b".repeat(64),
        edge_fingerprint: "c".repeat(64),
        now,
        expires_at: new Date(now.getTime() + 60_000),
      },
    );
    await provisioning.attestHealth(context, { commandId: "attest-server-1", connectorId: "server-codex" });
  });

  afterEach(async () => await database.close());

  it("요청 수신 전에 이전 process의 서버 Connector와 계정만 원자적으로 offline 처리한다", async () => {
    const transitions = vi.fn();
    const lifecycle = new ServerConnectorLifecycleService(database, { now: () => now, onTransition: transitions });

    await lifecycle.start();

    expect(lifecycle.ready()).toBe(true);
    const [connectors] = await database.query<[Array<{ connector_id: string; status: string }>]>(
      "SELECT connector_id, status FROM subscription_connector ORDER BY connector_id ASC;",
    );
    expect(connectors).toEqual([
      { connector_id: "edge-codex", status: "ready" },
      { connector_id: "server-codex", status: "offline" },
    ]);
    const [accounts] = await database.query<[Array<{ account_id: string; status: string; version: number }>]>(
      "SELECT account_id, status, version FROM subscription_account ORDER BY account_id ASC;",
    );
    expect(accounts).toEqual([
      { account_id: "edge-account", status: "active", version: 1 },
      { account_id: "server-account", status: "offline", version: 3 },
    ]);
    expect(transitions).toHaveBeenCalledWith({ phase: "startup", connectorCount: 1, accountCount: 1 });
  });

  it("종료 시 다시 offline 처리하고 중복 close는 상태 version을 재증가시키지 않는다", async () => {
    const lifecycle = new ServerConnectorLifecycleService(database, { now: () => now });
    await lifecycle.start();
    await provisioning.attestHealth(context, { commandId: "attest-server-2", connectorId: "server-codex" });

    await lifecycle.close();
    await lifecycle.close();

    expect(lifecycle.ready()).toBe(false);
    const [accounts] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'server-account';",
    );
    expect(accounts[0]).toEqual({ status: "offline", version: 5 });
  });

  it("초기 offline 전환 실패 시 시작과 readiness를 실패시킨다", async () => {
    const close = database.close.bind(database);
    await close();
    const lifecycle = new ServerConnectorLifecycleService(database);

    await expect(lifecycle.start()).rejects.toThrow();
    expect(lifecycle.ready()).toBe(false);
  });
});
