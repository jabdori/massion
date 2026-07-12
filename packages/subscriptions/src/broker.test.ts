import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionAccountService } from "./account-service.js";
import { SubscriptionConnectorBroker, type ConnectorRequest, type ConnectorTransportDirectory } from "./broker.js";

describe("구독 Connector session broker", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let broker: SubscriptionConnectorBroker;
  let disconnectedBroker: SubscriptionConnectorBroker;
  let invoked: Array<{ organizationId: string; connectorId: string; request: ConnectorRequest }>;

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
    broker = await SubscriptionConnectorBroker.create(database, organizations, accounts, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseTtlMs: 300_000,
      transport,
    });
    disconnectedBroker = await SubscriptionConnectorBroker.create(database, organizations, accounts, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      leaseTtlMs: 300_000,
    });
  });

  afterEach(async () => database.close());

  function request(routeAttemptId: string, fallbackFromLeaseId?: string) {
    return {
      commandId: randomUUID(),
      accountId: "codex-account",
      visibility: "personal" as const,
      workId: "work-1",
      agentHandle: "software-engineering.engineering-lead",
      routeAttemptId,
      ...(fallbackFromLeaseId ? { fallbackFromLeaseId } : {}),
    };
  }

  it("출력 전 재시도 가능 실패만 다음 Connector session으로 이동한다", async () => {
    const first = await broker.acquire(context, request("route-attempt-1"));
    await expect(first.fail({ emittedTokens: 0, signal: { kind: "timeout" } })).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: true,
    });

    const second = await broker.acquire(context, request("route-attempt-2", first.leaseId));
    await expect(second.fail({ emittedTokens: 1, signal: { kind: "timeout" } })).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: false,
    });
    await expect(broker.acquire(context, request("route-attempt-3", second.leaseId))).rejects.toThrow(
      "fallback할 수 없습니다",
    );
  });

  it("출력 전 인증 실패는 다음 Connector session으로 이동할 수 있다", async () => {
    const first = await broker.acquire(context, request("route-attempt-authentication"));

    await expect(first.fail({ emittedTokens: 0, signal: { kind: "authentication" } })).resolves.toMatchObject({
      status: "failed",
      fallbackAllowed: true,
    });
  });

  it("같은 route attempt를 재대여하지 않고 활성 lease를 재시작 뒤 복구한다", async () => {
    const lease = await broker.acquire(context, request("route-attempt-recovery"));
    await expect(broker.acquire(context, request("route-attempt-recovery"))).rejects.toThrow("이미 Session Lease");

    const recovered = await broker.recover(context);
    expect(recovered).toEqual([
      expect.objectContaining({ leaseId: lease.leaseId, routeAttemptId: "route-attempt-recovery", status: "active" }),
    ]);
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
