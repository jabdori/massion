import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionAccountService } from "./account-service.js";
import { SubscriptionConnectorBroker, type ConnectorRequest, type ConnectorTransportDirectory } from "./broker.js";

describe("구독 Connector session broker", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let memberContext: TenantContext;
  let broker: SubscriptionConnectorBroker;
  let disconnectedBroker: SubscriptionConnectorBroker;
  let invoked: Array<{ organizationId: string; connectorId: string; request: ConnectorRequest }>;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const registered = await identities.registerPersonalUser({
      email: "broker-owner@example.com",
      displayName: "Broker Owner",
    });
    context = await organizations.resolveTenantContext(
      registered.user.user_id,
      registered.organization.organization_id,
    );
    const member = await identities.registerPersonalUser({
      email: "broker-member@example.com",
      displayName: "Broker Member",
    });
    await organizations.addMember(context, member.user.user_id, "member");
    memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'edge-codex', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['agent-turn'], status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'codex-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'edge-codex',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId, fingerprint: "c".repeat(64) },
    );
    invoked = [];
    const transport: ConnectorTransportDirectory = {
      async *invoke(organizationId, connectorId, request) {
        invoked.push({ organizationId, connectorId, request });
        yield { kind: "data", sequence: 0, payload: { text: "ok" } };
        yield { kind: "done", sequence: 1, payload: {} };
      },
    };
    now = new Date("2030-01-01T00:00:00.000Z");
    broker = await SubscriptionConnectorBroker.create(database, organizations, accounts, {
      now: () => now,
      leaseTtlMs: 300_000,
      transport,
    });
    disconnectedBroker = await SubscriptionConnectorBroker.create(database, organizations, accounts, {
      now: () => now,
      leaseTtlMs: 300_000,
    });
  });

  afterEach(async () => database.close());

  function request(
    routeAttemptId: string,
    fallbackFromLeaseId?: string,
    quotaSnapshotId?: string,
    commandId = randomUUID(),
  ) {
    return {
      commandId,
      executionId: `execution-${routeAttemptId}`,
      accountId: "codex-account",
      connectorId: "edge-codex",
      scope: "personal" as const,
      workId: "work-1",
      agentHandle: "software-engineering.engineering-lead",
      routeAttemptId,
      ...(fallbackFromLeaseId ? { fallbackFromLeaseId } : {}),
      ...(quotaSnapshotId ? { quotaSnapshotId } : {}),
    };
  }

  it("출력 전 재시도 가능 실패만 다음 Connector session으로 이동한다", async () => {
    const first = await broker.acquire(context, request("route-attempt-1"));
    await expect(
      first.fail({
        commandId: randomUUID(),
        emittedTokens: 0,
        sideEffectsStarted: false,
        signal: { kind: "timeout" },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: true,
    });

    const second = await broker.acquire(context, request("route-attempt-2", first.leaseId));
    await expect(
      second.fail({
        commandId: randomUUID(),
        emittedTokens: 1,
        sideEffectsStarted: false,
        signal: { kind: "timeout" },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: false,
    });
    await expect(broker.acquire(context, request("route-attempt-3", second.leaseId))).rejects.toThrow(
      "fallback할 수 없습니다",
    );
  });

  it("출력 전 인증 실패는 다음 Connector session으로 이동할 수 있다", async () => {
    const first = await broker.acquire(context, request("route-attempt-authentication"));

    await expect(
      first.fail({
        commandId: randomUUID(),
        emittedTokens: 0,
        sideEffectsStarted: false,
        signal: { kind: "authentication" },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: true,
    });
  });

  it("출력이 없어도 부작용이 시작됐으면 다음 Connector session으로 이동하지 않는다", async () => {
    const first = await broker.acquire(context, request("route-attempt-side-effect"));

    await expect(
      first.fail({
        commandId: randomUUID(),
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "timeout" },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: false,
    });
  });

  it("같은 route attempt를 재대여하지 않고 활성 lease를 재시작 뒤 복구한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-recovery", undefined, "quota-snapshot-1"));
    await expect(broker.acquire(context, request("route-attempt-recovery"))).rejects.toThrow("이미 Session Lease");

    const recovered = await broker.recover(context);
    expect(recovered).toEqual([
      expect.objectContaining({
        leaseId: lease.leaseId,
        routeAttemptId: "route-attempt-recovery",
        quotaSnapshotId: "quota-snapshot-1",
        status: "active",
      }),
    ]);

    const active = await broker.recoverActive(context);
    await expect(broker.findExecutionLeases(context, lease.executionId)).resolves.toEqual([
      expect.objectContaining({ leaseId: lease.leaseId, executionId: lease.executionId }),
    ]);
    await active[0]?.complete({ commandId: randomUUID() });
    expect(await broker.recover(context)).toEqual([]);
  });

  it("실행 전에 검증된 runtime adapter를 lease에 한 번 결합하고 다른 adapter 재결합을 거부한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-runtime-lineage"));
    const commandId = randomUUID();

    const bound = await broker.bindRuntime(context, {
      commandId,
      leaseId: lease.leaseId,
      adapterId: "codex",
    });
    const replayed = await broker.bindRuntime(context, {
      commandId,
      leaseId: lease.leaseId,
      adapterId: "codex",
    });

    expect(bound).toMatchObject({ leaseId: lease.leaseId, adapterId: "codex", status: "active" });
    expect(replayed).toEqual(bound);
    await expect(
      broker.bindRuntime(context, {
        commandId: randomUUID(),
        leaseId: lease.leaseId,
        adapterId: "claude",
      }),
    ).rejects.toThrow(/adapter|결합/u);
  });

  it("같은 acquire command와 정규화 요청은 commit 응답 유실 뒤 같은 Session Lease로 재생한다", async () => {
    const commandId = randomUUID();
    const input = request("route-attempt-idempotent", undefined, "quota-idempotent", commandId);

    const [first, replayed] = await Promise.all([broker.acquire(context, input), broker.acquire(context, input)]);
    const [leases, events] = await database.query<
      [Array<{ lease_id: string }>, Array<{ command_id: string; actor_user_id: string }>]
    >(
      "SELECT lease_id FROM subscription_session_lease WHERE organization_id = $organization_id; SELECT command_id, actor_user_id FROM subscription_audit_event WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: commandId },
    );

    expect(replayed.leaseId).toBe(first.leaseId);
    expect(leases).toEqual([{ lease_id: first.leaseId }]);
    expect(events).toEqual([{ command_id: commandId, actor_user_id: context.userId }]);
    await expect(broker.acquire(context, { ...input, workId: "different-work" })).rejects.toThrow("다른 요청");
    await expect(broker.acquire(memberContext, input)).rejects.toThrow("다른 actor");
  });

  it("complete와 fail은 안정 command로 멱등 재생하고 terminal 상태 불일치를 거부한다", async () => {
    const completedLease = await broker.acquire(context, request("route-attempt-complete"));
    const completeCommand = randomUUID();

    const firstComplete = await completedLease.complete({ commandId: completeCommand });
    const replayedComplete = await (
      await broker.getLease(memberContext, completedLease.leaseId)
    ).complete({
      commandId: completeCommand,
    });
    expect(replayedComplete).toEqual(firstComplete);
    await expect(
      completedLease.fail({
        commandId: randomUUID(),
        emittedTokens: 0,
        sideEffectsStarted: false,
        signal: { kind: "timeout" },
      }),
    ).rejects.toThrow("terminal 상태");

    const failedLease = await broker.acquire(context, request("route-attempt-fail"));
    const failCommand = randomUUID();
    const failure = {
      commandId: failCommand,
      emittedTokens: 0,
      sideEffectsStarted: false,
      signal: { kind: "timeout" as const },
    };
    const firstFail = await failedLease.fail(failure);
    const replayedFail = await failedLease.fail(failure);
    expect(replayedFail).toEqual(firstFail);
    await expect(failedLease.fail({ ...failure, emittedTokens: 1 })).rejects.toThrow("다른 요청");
    await expect(failedLease.complete({ commandId: randomUUID() })).rejects.toThrow("terminal 상태");

    const racedLease = await broker.acquire(context, request("route-attempt-terminal-race"));
    const raced = await Promise.allSettled([
      racedLease.complete({ commandId: randomUUID() }),
      racedLease.fail({
        commandId: randomUUID(),
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "timeout" },
      }),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("Lease renew은 기존 만료 시각 CAS와 bounded TTL을 적용하고 같은 command를 멱등 재생한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-renew"));
    const expectedExpiresAt = new Date(String(lease.expiresAt)).toISOString();
    const commandId = randomUUID();
    now = new Date("2030-01-01T00:04:00.000Z");

    const renewed = await lease.renew({ commandId, expectedExpiresAt });
    expect(new Date(String(renewed.expiresAt)).toISOString()).toBe("2030-01-01T00:09:00.000Z");
    now = new Date("2030-01-01T00:04:30.000Z");
    await expect(lease.renew({ commandId, expectedExpiresAt })).resolves.toEqual(renewed);
    await expect(
      lease.renew({ commandId: randomUUID(), expectedExpiresAt: "2030-01-01T00:05:00.000Z" }),
    ).rejects.toThrow("만료 시각");
  });

  it("TTL 이후 invoke·renew은 금지하지만 이미 관측한 terminal 정산은 허용한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-expired-settlement"));
    const expectedExpiresAt = new Date(String(lease.expiresAt)).toISOString();
    now = new Date("2030-01-01T00:06:00.000Z");

    await expect(lease.renew({ commandId: randomUUID(), expectedExpiresAt })).rejects.toThrow("만료되었습니다");
    await expect(async () => {
      for await (const event of broker.invoke(context, {
        protocol: "massion.connector.v1",
        requestId: "expired-request",
        leaseId: lease.leaseId,
        operation: "health",
        payload: {},
      })) {
        void event;
      }
    }).rejects.toThrow("만료되었습니다");
    await expect(lease.complete({ commandId: randomUUID() })).resolves.toMatchObject({ status: "completed" });
  });

  it("scope와 반환 Lease status는 runtime에서 exact enum으로 검증한다", async () => {
    await expect(
      broker.acquire(context, { ...request("route-attempt-invalid-scope"), scope: "invalid" as "personal" }),
    ).rejects.toThrow("scope");
  });

  it("활성 lease의 Connector로만 bounded RPC를 전달한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-invoke"));
    const connectorRequest = {
      protocol: "massion.connector.v1" as const,
      requestId: "request-1",
      leaseId: lease.leaseId,
      operation: "agent-turn" as const,
      payload: { promptRef: "artifact-1" },
    };

    const events = [];
    for await (const event of broker.invoke(context, connectorRequest)) events.push(event);

    expect(events.map((event) => event.kind)).toEqual(["data", "done"]);
    expect(invoked).toEqual([
      { organizationId: context.organizationId, connectorId: "edge-codex", request: connectorRequest },
    ]);
    await expect(async () => {
      for await (const _event of broker.invoke(context, {
        ...connectorRequest,
        requestId: "request-too-large",
        payload: { data: "x".repeat(16 * 1024 * 1024) },
      })) {
        void _event;
        // 반복 과정에서 요청 크기 검증 오류를 받습니다.
      }
    }).rejects.toThrow("요청 byte 상한");
  });

  it.each([
    [null, "Connector 요청이 유효하지 않습니다"],
    [
      {
        protocol: "massion.connector.v0",
        requestId: "request-invalid-protocol",
        leaseId: "unused",
        operation: "health",
        payload: {},
      },
      "protocol이 유효하지 않습니다",
    ],
  ])("신뢰하지 않은 Connector 요청 %#을 명시적으로 거부한다", async (request: unknown, message) => {
    await expect(async () => {
      for await (const event of broker.invoke(context, request)) {
        void event;
      }
    }).rejects.toThrow(message);
  });

  it("transport가 조립되지 않으면 Connector 호출을 fail closed한다", async () => {
    const lease = await disconnectedBroker.acquire(context, request("route-attempt-disconnected"));
    const connectorRequest = {
      protocol: "massion.connector.v1" as const,
      requestId: "request-disconnected",
      leaseId: lease.leaseId,
      operation: "health" as const,
      payload: {},
    };

    await expect(async () => {
      for await (const event of disconnectedBroker.invoke(context, connectorRequest)) {
        void event;
      }
    }).rejects.toThrow("transport가 연결되지 않았습니다");
  });
});
