import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { ServerConnectorAuthenticationRequiredError, ServerConnectorProvisioningService } from "@massion/subscriptions";

import { ServerConnectorStartupRecoveryService } from "./server-connector-startup-recovery.js";

const owner: TenantContext = {
  organizationId: "organization-12345678",
  userId: "user-12345678",
  membershipId: "membership-12345678",
  role: "owner",
};

describe("서버 Connector 시작 복구", () => {
  it("Codex 인증 만료는 시작 복구에서도 health 감사는 롤백하고 profile 재인증 상태만 기록한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const registered = await identities.registerPersonalUser({
      email: "startup-reauth@example.com",
      displayName: "Startup Reauth",
    });
    const context = await organizations.resolveTenantContext(
      registered.user.user_id,
      registered.organization.organization_id,
    );
    const runtimeAttestor = {
      inspectArtifact: vi.fn().mockResolvedValue({
        runtimeId: "codex",
        runtimeArtifactDigest: "a".repeat(64),
        version: "0.144.1",
      }),
      attestHealth: vi.fn().mockImplementation(async (input: { providerId: string; connectorId: string }) => {
        throw new ServerConnectorAuthenticationRequiredError(input.providerId, input.connectorId);
      }),
    };
    const connectors = await ServerConnectorProvisioningService.create(database, organizations, { runtimeAttestor });
    await connectors.provision(context, {
      commandId: "startup-reauth-provision",
      connectorId: "server-startup-reauth-12345678",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
    });
    await database.query(
      `CREATE subscription_account CONTENT {
        account_id: 'account-startup-reauth-12345678', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'server-startup-reauth-12345678',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      {
        organization_id: context.organizationId,
        owner_user_id: context.userId,
        fingerprint: "b".repeat(64),
      },
    );
    const unavailable: unknown[] = [];
    const transitions: unknown[] = [];
    const recovery = new ServerConnectorStartupRecoveryService(database, organizations, connectors, {
      bootId: "boot-reauth-12345678",
      onUnavailable: (failure) => unavailable.push(failure),
      onTransition: (transition) => transitions.push(transition),
    });

    await recovery.start();

    expect(recovery.ready()).toBe(true);
    expect(unavailable).toEqual([{ category: "health-attestation-failed" }]);
    expect(transitions).toEqual([{ attempted: 1, restored: 0, unavailable: 1 }]);
    const [connectorRows, accountRows, auditRows] = await database.query<
      [Array<{ status: string }>, Array<{ status: string; version: number }>, Array<{ event_type: string }>]
    >(
      `SELECT status FROM subscription_connector WHERE connector_id = 'server-startup-reauth-12345678';
       SELECT status, version FROM subscription_account WHERE account_id = 'account-startup-reauth-12345678';
       SELECT event_type FROM subscription_audit_event
       WHERE organization_id = $organization_id ORDER BY event_type ASC;`,
      { organization_id: context.organizationId },
    );
    expect(connectorRows).toEqual([{ status: "offline" }]);
    expect(accountRows).toEqual([{ status: "needs-reauth", version: 2 }]);
    expect(auditRows).toEqual([
      { event_type: "subscription_server_connector_provisioned" },
      { event_type: "subscription_server_connector_reauthentication_required" },
    ]);
  });

  it("재시작 뒤 offline 서버 Connector를 소유자 문맥으로 다시 건강 증명한다", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-codex-12345678",
        },
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-claude-12345678",
        },
      ],
    ]);
    const resolveTenantContext = vi.fn().mockResolvedValue(owner);
    const attestHealth = vi.fn().mockResolvedValue({ status: "ready" });
    const transitions: unknown[] = [];
    const service = new ServerConnectorStartupRecoveryService(
      { query } as never,
      { resolveTenantContext } as never,
      { attestHealth } as never,
      {
        bootId: "boot-12345678",
        maximumConcurrency: 2,
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(resolveTenantContext).toHaveBeenCalledTimes(2);
    expect(attestHealth).toHaveBeenCalledTimes(2);
    for (const call of attestHealth.mock.calls) {
      expect(call[0]).toEqual(owner);
      expect(call[1]).toMatchObject({
        commandId: expect.stringMatching(/^startup-boot-12345678-[a-f0-9]{32}$/u),
        connectorId: expect.stringMatching(/^server-/u),
      });
    }
    expect(new Set(attestHealth.mock.calls.map((call) => call[1].commandId)).size).toBe(2);
    expect(transitions).toEqual([{ attempted: 2, restored: 2, unavailable: 0 }]);
  });

  it("로그아웃·삭제된 소유자는 해당 Connector만 offline으로 보존하고 안전한 집계만 보고한다", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-ready-12345678",
        },
        {
          organization_id: "organization-private-value",
          owner_user_id: "removed-user-private-value",
          connector_id: "server-private-value",
        },
      ],
    ]);
    const resolveTenantContext = vi
      .fn()
      .mockResolvedValueOnce(owner)
      .mockRejectedValueOnce(new Error("private@example.com Bearer raw-secret"));
    const attestHealth = vi.fn().mockResolvedValueOnce({ status: "ready" });
    const errors: unknown[] = [];
    const transitions: unknown[] = [];
    const service = new ServerConnectorStartupRecoveryService(
      { query } as never,
      { resolveTenantContext } as never,
      { attestHealth } as never,
      {
        bootId: "boot-safe-12345678",
        onUnavailable: (failure) => {
          errors.push(failure);
        },
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(attestHealth).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([{ attempted: 2, restored: 1, unavailable: 1 }]);
    expect(errors).toEqual([{ category: "owner-context-unavailable" }]);
    expect(JSON.stringify([errors, transitions])).not.toMatch(/private|Bearer|secret|@/u);
  });

  it("같은 복구 인스턴스의 중복 시작과 잘못된 동시성 설정을 거부한다", async () => {
    expect(
      () =>
        new ServerConnectorStartupRecoveryService({ query: vi.fn() } as never, {} as never, {} as never, {
          maximumConcurrency: 0,
        }),
    ).toThrow("동시성");

    const service = new ServerConnectorStartupRecoveryService(
      { query: vi.fn().mockResolvedValue([[]]) } as never,
      { resolveTenantContext: vi.fn() } as never,
      { attestHealth: vi.fn() } as never,
      { bootId: "boot-empty-12345678" },
    );
    await service.start();
    await expect(service.start()).rejects.toThrow("이미 시작");
    await expect(service.close()).resolves.toBeUndefined();
    expect(service.ready()).toBe(false);
  });
});
