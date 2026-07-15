import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  ServerConnectorAuthenticationRequiredError,
  ServerConnectorPaidSubscriptionRequiredError,
  ServerConnectorProvisioningService,
  type ServerConnectorRuntimeAttestor,
  type ServerConnectorProvisioningOptions,
  type VerifiedServerConnectorHealth,
  type VerifiedServerRuntimeArtifact,
} from "./server-connector-provisioning.js";

describe("서버 관리형 Connector 프로비저닝", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let ownerContext: TenantContext;
  let memberContext: TenantContext;
  let otherOrganizationContext: TenantContext;
  let service: ServerConnectorProvisioningService;
  let runtimeAttestor: ServerConnectorRuntimeAttestor;
  let verifiedArtifact: VerifiedServerRuntimeArtifact;
  let verifiedHealth: VerifiedServerConnectorHealth;
  let now: Date;

  const artifactDigest = "a".repeat(64);

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "server-owner@example.com", displayName: "Owner" });
    const member = await identities.registerPersonalUser({
      email: "server-member@example.com",
      displayName: "Member",
    });
    const other = await identities.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    memberContext = await organizations.resolveTenantContext(member.user.user_id, ownerContext.organizationId);
    otherOrganizationContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    now = new Date("2030-01-01T00:00:00.000Z");
    verifiedArtifact = {
      runtimeId: "codex",
      runtimeArtifactDigest: artifactDigest,
      version: "0.144.1",
    };
    verifiedHealth = {
      runtimeId: "codex",
      runtimeArtifactDigest: artifactDigest,
      processGeneration: 1,
      processState: "new-process",
    };
    runtimeAttestor = {
      inspectArtifact: vi.fn().mockImplementation(() => Promise.resolve(verifiedArtifact)),
      attestHealth: vi.fn().mockImplementation(() => Promise.resolve(verifiedHealth)),
    };
    service = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor,
      now: () => now,
    });
  });

  afterEach(async () => database.close());

  function provisionInput(commandId = randomUUID(), connectorId = "server-codex-1") {
    return {
      commandId,
      connectorId,
      providerId: "openai-codex",
      executionKind: "agent-runtime" as const,
      runtimeId: "codex",
    };
  }

  it("신뢰할 서버 Runtime attestor가 없으면 fail-closed한다", async () => {
    await expect(
      ServerConnectorProvisioningService.create(database, organizations, {} as ServerConnectorProvisioningOptions),
    ).rejects.toThrow("attestor");
  });

  it("공식 Provider와 정확히 일치하는 런타임 계보를 offline 상태로 원자 기록한다", async () => {
    const connector = await service.provision(ownerContext, provisionInput());

    expect(connector).toEqual({
      connectorId: "server-codex-1",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
      runtimeArtifactDigest: artifactDigest,
      version: "0.144.1",
      capabilities: ["openai-codex"],
      status: "offline",
      trustOrigin: "server-managed",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    await expect(service.get(ownerContext, "server-codex-1")).resolves.toEqual(connector);
    await expect(service.list(ownerContext)).resolves.toEqual([connector]);

    const [stored] = await database.query<
      [
        Array<{
          trust_origin: string;
          provider_id: string;
          execution_kind: string;
          runtime_id: string;
          runtime_artifact_digest: string;
          public_key?: string;
          expires_at?: unknown;
          last_heartbeat_at?: unknown;
        }>,
      ]
    >("SELECT * OMIT id FROM subscription_connector WHERE connector_id = 'server-codex-1';");
    expect(stored[0]).toMatchObject({
      trust_origin: "server-managed",
      provider_id: "openai-codex",
      execution_kind: "agent-runtime",
      runtime_id: "codex",
      runtime_artifact_digest: artifactDigest,
    });
    expect(stored[0]).not.toHaveProperty("public_key");
    expect(stored[0]).not.toHaveProperty("expires_at");
    expect(stored[0]).not.toHaveProperty("last_heartbeat_at");
    expect(runtimeAttestor.inspectArtifact).toHaveBeenCalledWith({
      organizationId: ownerContext.organizationId,
      actorUserId: ownerContext.userId,
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
    });
  });

  it("Provider catalog의 실행 종류와 capability를 정확히 강제하고 경로 형태 runtime ID를 저장하지 않는다", async () => {
    await expect(
      service.provision(ownerContext, {
        ...provisionInput(),
        executionKind: "model",
      }),
    ).rejects.toThrow("실행 종류");
    await expect(
      service.provision(ownerContext, {
        ...provisionInput(),
        providerId: "unknown-provider",
      }),
    ).rejects.toThrow("catalog");
    await expect(
      service.provision(ownerContext, {
        ...provisionInput(),
        runtimeId: "/Users/alice/.codex/bin/codex",
      }),
    ).rejects.toThrow("Runtime ID");
    await expect(
      service.provision(ownerContext, {
        ...provisionInput(),
        runtimeId: "claude",
      }),
    ).rejects.toThrow("runtime ID");
    verifiedArtifact = { ...verifiedArtifact, runtimeId: "claude" };
    await expect(
      service.provision(ownerContext, provisionInput(randomUUID(), "wrong-attested-runtime")),
    ).rejects.toThrow("Provider 계약");
    verifiedArtifact = { ...verifiedArtifact, runtimeId: "codex" };
    verifiedArtifact = { ...verifiedArtifact, runtimeArtifactDigest: "not-a-sha256" };
    await expect(
      service.provision(ownerContext, provisionInput(randomUUID(), "invalid-attested-artifact")),
    ).rejects.toThrow("SHA-256");

    expect(JSON.stringify(await database.query("SELECT * FROM subscription_connector;"))).not.toContain("/Users/alice");
  });

  it("attestor 내부 경로가 포함된 실패를 공개 오류나 원장에 남기지 않는다", async () => {
    vi.mocked(runtimeAttestor.inspectArtifact).mockRejectedValueOnce(
      new Error("/Users/private/.codex/bin/codex digest read failed"),
    );

    const failure = await service.provision(ownerContext, provisionInput()).catch((error: unknown) => error);
    expect(failure).toEqual(new Error("서버 Runtime artifact 검증에 실패했습니다"));
    expect(String(failure)).not.toContain("/Users/private");
    expect(JSON.stringify(await database.query("SELECT * FROM subscription_audit_event;"))).not.toContain(
      "/Users/private",
    );
  });

  it("동시 재시도도 하나의 명령·Connector로 수렴하고 다른 사용자의 command replay를 차단한다", async () => {
    const commandId = randomUUID();
    const input = provisionInput(commandId);
    const [first, repeated] = await Promise.all([
      service.provision(ownerContext, input),
      service.provision(ownerContext, input),
    ]);
    expect(repeated).toEqual(first);
    const [records, events] = await database.query<[unknown[], unknown[]]>(
      `SELECT connector_id FROM subscription_connector WHERE organization_id = $organization_id;
       SELECT event_id FROM subscription_audit_event
       WHERE organization_id = $organization_id AND command_id = $command_id;`,
      { organization_id: ownerContext.organizationId, command_id: commandId },
    );
    expect(records).toHaveLength(1);
    expect(events).toHaveLength(1);

    await expect(service.provision(memberContext, input)).rejects.toThrow("다른 사용자");
    await expect(
      service.provision(ownerContext, {
        ...input,
        providerId: "anthropic-claude-code",
        runtimeId: "claude",
      }),
    ).rejects.toThrow("다른 요청");
  });

  it("같은 식별자의 Connector와 command를 조직별로 격리한다", async () => {
    const commandId = randomUUID();
    const ownerConnector = await service.provision(ownerContext, provisionInput(commandId));
    const otherConnector = await service.provision(otherOrganizationContext, provisionInput(commandId));

    expect(ownerConnector).toEqual(otherConnector);
    await expect(service.get(ownerContext, "server-codex-1")).resolves.toEqual(ownerConnector);
    await expect(service.get(otherOrganizationContext, "server-codex-1")).resolves.toEqual(otherConnector);
    await expect(service.get(ownerContext, "other-connector")).rejects.toThrow("찾을 수 없습니다");
  });

  it("일치하는 artifact와 증가한 process generation만 ready 건강 증명으로 수락한다", async () => {
    await service.provision(ownerContext, provisionInput());
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'offline',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: ownerContext.organizationId,
        owner_user_id: ownerContext.userId,
        fingerprint: "b".repeat(64),
      },
    );
    verifiedHealth = { ...verifiedHealth, runtimeArtifactDigest: "c".repeat(64) };
    await expect(
      service.attestHealth(ownerContext, { commandId: randomUUID(), connectorId: "server-codex-1" }),
    ).rejects.toThrow("artifact digest");
    verifiedHealth = { ...verifiedHealth, runtimeArtifactDigest: artifactDigest };

    const commandId = randomUUID();
    const input = {
      commandId,
      connectorId: "server-codex-1",
    };
    const ready = await service.attestHealth(ownerContext, input);
    await expect(service.attestHealth(ownerContext, input)).resolves.toEqual(ready);
    expect(ready).toMatchObject({
      status: "ready",
      processGeneration: 1,
      lastHealthAt: "2030-01-01T00:00:00.000Z",
    });
    const [accounts] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM subscription_account WHERE account_id = 'server-account';",
    );
    expect(accounts).toEqual([{ status: "active" }]);
    expect(runtimeAttestor.attestHealth).toHaveBeenCalledWith({
      organizationId: ownerContext.organizationId,
      actorUserId: ownerContext.userId,
      connectorId: "server-codex-1",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
      runtimeArtifactDigest: artifactDigest,
      version: "0.144.1",
    });

    now = new Date("2030-01-01T00:00:30.000Z");
    verifiedHealth = { ...verifiedHealth, processState: "same-process" };
    await expect(service.attestHealth(ownerContext, { ...input, commandId: randomUUID() })).resolves.toMatchObject({
      processGeneration: 1,
      lastHealthAt: now.toISOString(),
    });
    expect(runtimeAttestor.attestHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ previousProcessGeneration: 1 }),
    );

    verifiedHealth = { ...verifiedHealth, processState: "new-process", processGeneration: 1 };
    await expect(service.attestHealth(ownerContext, { ...input, commandId: randomUUID() })).rejects.toThrow(
      "generation",
    );
    verifiedHealth = { ...verifiedHealth, processGeneration: 0 };
    await expect(service.attestHealth(ownerContext, { ...input, commandId: randomUUID() })).rejects.toThrow(
      "generation",
    );

    now = new Date("2030-01-01T00:01:00.000Z");
    verifiedHealth = { ...verifiedHealth, processState: "new-process", processGeneration: 2 };
    await expect(
      service.attestHealth(ownerContext, {
        ...input,
        commandId: randomUUID(),
      }),
    ).resolves.toMatchObject({ processGeneration: 2, lastHealthAt: now.toISOString() });
  });

  it("같은 process generation의 동시 건강 증명은 하나만 상태를 전이한다", async () => {
    await service.provision(ownerContext, provisionInput());
    const health = (commandId: string) =>
      service.attestHealth(ownerContext, {
        commandId,
        connectorId: "server-codex-1",
      });

    const settled = await Promise.allSettled([health(randomUUID()), health(randomUUID())]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(service.get(ownerContext, "server-codex-1")).resolves.toMatchObject({
      status: "ready",
      processGeneration: 1,
    });
    const [events] = await database.query<[unknown[]]>(
      `SELECT event_id FROM subscription_audit_event
       WHERE organization_id = $organization_id
         AND event_type = 'subscription_server_connector_health_attested';`,
      { organization_id: ownerContext.organizationId },
    );
    expect(events).toHaveLength(1);
  });

  it("서버 구독 인증을 다시 검증한 건강 증명은 needs-reauth 계정을 active로 복구한다", async () => {
    await service.provision(ownerContext, provisionInput());
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-reauth-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'offline',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: ownerContext.organizationId,
        owner_user_id: ownerContext.userId,
        fingerprint: "e".repeat(64),
      },
    );
    await service.attestHealth(ownerContext, { commandId: randomUUID(), connectorId: "server-codex-1" });
    await database.query(
      `UPDATE subscription_account SET status = 'needs-reauth', version += 1, updated_at = time::now()
       WHERE organization_id = $organization_id AND account_id = 'server-reauth-account';`,
      { organization_id: ownerContext.organizationId },
    );
    verifiedHealth = { ...verifiedHealth, processState: "same-process" };

    await service.attestHealth(ownerContext, { commandId: randomUUID(), connectorId: "server-codex-1" });

    const [accounts] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'server-reauth-account';",
    );
    expect(accounts).toEqual([{ status: "active", version: 4 }]);
  });

  it("Codex 인증 만료는 건강 증명을 롤백한 뒤 자동으로 별도 감사 command에서 Connector와 계정을 needs-reauth로 전이한다", async () => {
    await service.provision(ownerContext, provisionInput());
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-expired-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: ownerContext.organizationId,
        owner_user_id: ownerContext.userId,
        fingerprint: "f".repeat(64),
      },
    );
    vi.mocked(runtimeAttestor.attestHealth).mockRejectedValueOnce(
      new ServerConnectorAuthenticationRequiredError("openai-codex", "server-codex-1"),
    );

    await expect(
      service.attestHealth(ownerContext, { commandId: "expired-health-command", connectorId: "server-codex-1" }),
    ).rejects.toBeInstanceOf(ServerConnectorAuthenticationRequiredError);

    const [connectors, accounts, events] = await database.query<
      [Array<{ status: string }>, Array<{ status: string; version: number }>, Array<{ event_type: string }>]
    >(
      `SELECT status FROM subscription_connector WHERE connector_id = 'server-codex-1';
       SELECT status, version FROM subscription_account WHERE account_id = 'server-expired-account';
       SELECT event_type FROM subscription_audit_event
       WHERE organization_id = $organization_id ORDER BY event_type ASC;`,
      { organization_id: ownerContext.organizationId },
    );
    expect(connectors).toEqual([{ status: "offline" }]);
    expect(accounts).toEqual([{ status: "needs-reauth", version: 2 }]);
    expect(events).toEqual([
      { event_type: "subscription_server_connector_provisioned" },
      { event_type: "subscription_server_connector_reauthentication_required" },
    ]);
  });

  it("Codex 유료 구독 불가 오류는 offline으로 전이하되 needs-reauth나 재인증 감사 event를 만들지 않는다", async () => {
    await service.provision(ownerContext, provisionInput());
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-paid-plan-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: ownerContext.organizationId,
        owner_user_id: ownerContext.userId,
        fingerprint: "1".repeat(64),
      },
    );
    vi.mocked(runtimeAttestor.attestHealth).mockRejectedValueOnce(
      new ServerConnectorPaidSubscriptionRequiredError("openai-codex", "server-codex-1"),
    );

    await expect(
      service.attestHealth(ownerContext, { commandId: "paid-plan-health-command", connectorId: "server-codex-1" }),
    ).rejects.toBeInstanceOf(ServerConnectorPaidSubscriptionRequiredError);

    const [connectors, accounts, events] = await database.query<
      [Array<{ status: string }>, Array<{ status: string; version: number }>, Array<{ event_type: string }>]
    >(
      `SELECT status FROM subscription_connector WHERE connector_id = 'server-codex-1';
       SELECT status, version FROM subscription_account WHERE account_id = 'server-paid-plan-account';
       SELECT event_type FROM subscription_audit_event
       WHERE organization_id = $organization_id ORDER BY event_type ASC;`,
      { organization_id: ownerContext.organizationId },
    );
    expect(connectors).toEqual([{ status: "offline" }]);
    expect(accounts).toEqual([{ status: "offline", version: 2 }]);
    expect(events).toEqual([
      { event_type: "subscription_server_connector_offline" },
      { event_type: "subscription_server_connector_provisioned" },
    ]);
  });

  it("일반 구성원도 조직의 안전한 공개 view를 보지만 다른 사람의 Connector를 변경할 수 없다", async () => {
    const connector = await service.provision(ownerContext, provisionInput());

    await expect(service.list(memberContext)).resolves.toEqual([connector]);
    await expect(service.get(memberContext, "server-codex-1")).resolves.toEqual(connector);
    await expect(
      service.markOffline(memberContext, { commandId: randomUUID(), connectorId: "server-codex-1" }),
    ).rejects.toThrow("소유자");
    expect(JSON.stringify(connector)).not.toMatch(/owner|userId|publicKey|path|profile/iu);
  });

  it("offline·폐기 상태를 계정에 원자 전파하고 폐기한 Connector의 재활성화를 막는다", async () => {
    await service.provision(ownerContext, provisionInput());
    await service.attestHealth(ownerContext, {
      commandId: randomUUID(),
      connectorId: "server-codex-1",
    });
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'server-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-codex-1',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: ownerContext.organizationId,
        owner_user_id: ownerContext.userId,
        fingerprint: "d".repeat(64),
      },
    );

    const offlineInput = { commandId: randomUUID(), connectorId: "server-codex-1" };
    const offline = await service.markOffline(ownerContext, offlineInput);
    await expect(service.markOffline(ownerContext, offlineInput)).resolves.toEqual(offline);
    expect(offline.status).toBe("offline");
    const [offlineAccounts] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'server-account';",
    );
    expect(offlineAccounts).toEqual([{ status: "offline", version: 2 }]);

    verifiedHealth = { ...verifiedHealth, processState: "new-process", processGeneration: 2 };
    await service.attestHealth(ownerContext, { commandId: randomUUID(), connectorId: "server-codex-1" });
    const revoked = await service.revoke(ownerContext, {
      commandId: randomUUID(),
      connectorId: "server-codex-1",
    });
    expect(revoked.status).toBe("revoked");
    const [revokedAccounts] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM subscription_account WHERE account_id = 'server-account';",
    );
    expect(revokedAccounts).toEqual([{ status: "offline", version: 4 }]);
    await expect(
      service.attestHealth(ownerContext, {
        commandId: randomUUID(),
        connectorId: "server-codex-1",
      }),
    ).rejects.toThrow("폐기");
  });
});
