import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RuntimeExecutionStore } from "../execution-store.js";
import {
  SubscriptionExecutionReceiptCoordinator,
  type SubscriptionReceiptBroker,
  type SubscriptionReceiptLineage,
  type SubscriptionReceiptRouter,
} from "./execution-receipt.js";

describe("구독 실행 crash-safe receipt", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "receipt-owner@example.com", displayName: "Owner" });
    const other = await identities.registerPersonalUser({ email: "receipt-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function running() {
    const created = await store.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      modelRoute: "subscription-balanced",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: { objective: "구현" },
    });
    return await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
  }

  function lineage(executionId: string, suffix = "1"): SubscriptionReceiptLineage {
    return {
      executionId,
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      routeAttemptId: `attempt-${suffix}`,
      leaseId: `lease-${suffix}`,
      accountId: "account-1",
      connectorId: "connector-1",
      adapterId: "codex-subscription",
    };
  }

  function ports(value: SubscriptionReceiptLineage) {
    const routerCommands = new Set<string>();
    const leaseCommands = new Set<string>();
    let routerSettlements = 0;
    let leaseSettlements = 0;
    let leaseStatus: "active" | "completed" | "failed" = "active";
    const reportSuccess = vi.fn(async (_context: TenantContext, input: { readonly commandId: string }) => {
      if (!routerCommands.has(input.commandId)) {
        routerCommands.add(input.commandId);
        routerSettlements += 1;
      }
      return {};
    });
    const reportFailure = vi.fn(async (_context: TenantContext, input: { readonly commandId: string }) => {
      if (!routerCommands.has(input.commandId)) {
        routerCommands.add(input.commandId);
        routerSettlements += 1;
      }
      return {};
    });
    const complete = vi.fn(async (input: { readonly commandId: string }) => {
      if (!leaseCommands.has(input.commandId)) {
        leaseCommands.add(input.commandId);
        leaseSettlements += 1;
        leaseStatus = "completed";
      }
      return { status: leaseStatus };
    });
    const fail = vi.fn(async (input: { readonly commandId: string }) => {
      if (!leaseCommands.has(input.commandId)) {
        leaseCommands.add(input.commandId);
        leaseSettlements += 1;
        leaseStatus = "failed";
      }
      return { status: "failed" as const, fallbackAllowed: false, failureKind: "invalid-request" as const };
    });
    const currentLease = () => ({
      leaseId: value.leaseId,
      executionId: value.executionId,
      accountId: value.accountId,
      connectorId: value.connectorId,
      adapterId: value.adapterId,
      workId: value.workId,
      agentHandle: value.agentHandle,
      routeAttemptId: value.routeAttemptId,
      status: leaseStatus,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      complete,
      fail,
    });
    const broker: SubscriptionReceiptBroker = {
      getLease: vi.fn(async () => currentLease()),
      findExecutionLeases: vi.fn(async () => [currentLease()]),
    };
    const router = { reportSuccess, reportFailure } as unknown as SubscriptionReceiptRouter;
    return {
      broker,
      router,
      complete,
      fail,
      reportSuccess,
      reportFailure,
      counts: () => ({ routerSettlements, leaseSettlements }),
    };
  }

  async function acquiredAndStarted(
    coordinator: SubscriptionExecutionReceiptCoordinator,
    value: SubscriptionReceiptLineage,
  ) {
    await coordinator.recordRouteSessionAcquired(context, {
      commandId: `${value.executionId}:subscription:${value.routeAttemptId}:acquired`,
      ...value,
    });
    await coordinator.recordInvocationStarted(context, {
      commandId: `${value.executionId}:subscription:${value.routeAttemptId}:started`,
      ...value,
    });
  }

  it("terminal receipt가 있으면 provider를 다시 호출하지 않고 양쪽 정산과 성공 상태를 재생한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    await acquiredAndStarted(coordinator, value);
    await coordinator.recordTerminalObserved(context, {
      commandId: `${value.executionId}:subscription:${value.routeAttemptId}:terminal`,
      ...value,
      providerExecutionId: value.executionId,
      providerSessionId: "provider-session-1",
      outcome: "completed",
      usage: { inputTokens: 7, outputTokens: 3 },
      output: { kind: "inline", value: { text: "완료" } },
    });

    const recovered = await coordinator.recover(context, value.executionId);
    const replayed = await coordinator.recover(context, value.executionId);
    const snapshot = await coordinator.read(context, value.executionId);

    expect(recovered.status).toBe("succeeded");
    expect(replayed.status).toBe("succeeded");
    expect(JSON.parse(recovered.output_json ?? "null")).toMatchObject({ output: { text: "완료" } });
    expect(dependencies.counts()).toEqual({ routerSettlements: 1, leaseSettlements: 1 });
    expect(snapshot.terminal?.providerSessionId).toBe("provider-session-1");
    expect(snapshot.settled).toBeDefined();
  });

  it("started만 남으면 두 reconciler가 동시 실행돼도 재호출·fallback 없이 interrupted로 한 번 정산한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const left = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    const right = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    await acquiredAndStarted(left, value);

    const [first, second] = await Promise.all([
      left.recover(context, value.executionId),
      right.recover(context, value.executionId),
    ]);
    const events = await store.listEvents(context, value.executionId);

    expect(first.status).toBe("interrupted");
    expect(second.status).toBe("interrupted");
    expect(dependencies.counts()).toEqual({ routerSettlements: 1, leaseSettlements: 1 });
    expect(dependencies.reportFailure).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        signal: { kind: "unknown" },
        emittedTokens: 0,
        sideEffectsStarted: true,
      }),
    );
    expect(dependencies.fail).toHaveBeenCalledWith(
      expect.objectContaining({ emittedTokens: 0, sideEffectsStarted: true }),
    );
    expect(events.filter((event) => event.event_type === "subscription_terminal_observed")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "subscription_settlement_completed")).toHaveLength(1);
  });

  it("Broker acquire 직후 첫 receipt 전에 중단돼도 execution 계보로 임대를 찾아 보수적으로 정산한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);

    const recovered = await coordinator.recover(context, value.executionId);
    const snapshot = await coordinator.read(context, value.executionId);

    expect(recovered.status).toBe("interrupted");
    expect(snapshot.attempts).toEqual([
      expect.objectContaining({
        lineage: expect.objectContaining({ executionId: value.executionId, leaseId: value.leaseId }),
        acquired: true,
        started: true,
        settled: true,
      }),
    ]);
    expect(dependencies.counts()).toEqual({ routerSettlements: 1, leaseSettlements: 1 });
  });

  it("receipt 단계·계보·terminal 단일성을 transaction에서 강제하고 fallback attempt 새 cycle을 허용한다", async () => {
    const state = await running();
    const first = lineage(state.execution.execution_id, "1");
    const dependencies = ports(first);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);

    await expect(
      coordinator.recordInvocationStarted(context, { commandId: crypto.randomUUID(), ...first }),
    ).rejects.toThrow("Receipt 전이");
    await coordinator.recordRouteSessionAcquired(context, { commandId: crypto.randomUUID(), ...first });
    await expect(
      coordinator.recordInvocationStarted(context, {
        commandId: crypto.randomUUID(),
        ...first,
        leaseId: "different-lease",
      }),
    ).rejects.toThrow("Receipt 전이");
    await coordinator.recordInvocationStarted(context, { commandId: crypto.randomUUID(), ...first });
    const terminals = await Promise.allSettled([
      coordinator.recordTerminalObserved(context, {
        commandId: crypto.randomUUID(),
        ...first,
        providerExecutionId: first.executionId,
        outcome: "completed",
        usage: { inputTokens: 1, outputTokens: 1 },
        output: { kind: "inline", value: "ok" },
      }),
      coordinator.recordTerminalObserved(context, {
        commandId: crypto.randomUUID(),
        ...first,
        providerExecutionId: first.executionId,
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: false,
        signal: { kind: "timeout" },
      }),
    ]);
    expect(terminals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(terminals.filter((result) => result.status === "rejected")).toHaveLength(1);
    await coordinator.recordSettlementCompleted(context, {
      commandId: crypto.randomUUID(),
      ...first,
    });

    const second = lineage(first.executionId, "2");
    await coordinator.recordRouteSessionAcquired(context, { commandId: crypto.randomUUID(), ...second });
    await coordinator.recordInvocationStarted(context, { commandId: crypto.randomUUID(), ...second });
    expect((await coordinator.read(context, first.executionId)).attempts).toHaveLength(2);
  });

  it("suspended checkpoint는 adapter·session·approval 식별자를 보존하고 정산하지 않는다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    await acquiredAndStarted(coordinator, value);
    await coordinator.recordCheckpointObserved(context, {
      commandId: `${value.executionId}:subscription:${value.routeAttemptId}:checkpoint`,
      ...value,
      sessionId: "provider-session-1",
      approvalId: "approval-1",
    });

    const recovered = await coordinator.recover(context, value.executionId);
    const snapshot = await coordinator.read(context, value.executionId);

    expect(recovered.status).toBe("suspended");
    expect(snapshot.attempts[0]?.checkpoint).toMatchObject({
      adapterId: "codex-subscription",
      sessionId: "provider-session-1",
      approvalId: "approval-1",
    });
    expect(dependencies.counts()).toEqual({ routerSettlements: 0, leaseSettlements: 0 });
  });

  it("재시작 뒤 live adapter가 없는 suspended checkpoint는 interrupted로 보수 정산한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    await acquiredAndStarted(coordinator, value);
    await coordinator.recordCheckpointObserved(context, {
      commandId: `${value.executionId}:subscription:${value.routeAttemptId}:checkpoint`,
      ...value,
      sessionId: "provider-session-restart",
      approvalId: "approval-restart",
    });
    await coordinator.recover(context, value.executionId);

    const interrupted = await coordinator.interruptSuspended(context, value.executionId);
    const replayed = await coordinator.interruptSuspended(context, value.executionId);

    expect(interrupted.status).toBe("interrupted");
    expect(replayed.status).toBe("interrupted");
    expect(dependencies.counts()).toEqual({ routerSettlements: 1, leaseSettlements: 1 });
    expect(dependencies.reportFailure).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ sideEffectsStarted: true, signal: { kind: "unknown" } }),
    );
  });

  it("receipt 기록 전 crash는 lease에 결합된 실제 adapter 계보로만 복구한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);

    await coordinator.recover(context, value.executionId);
    const snapshot = await coordinator.read(context, value.executionId);

    expect(snapshot.attempts[0]?.lineage).toMatchObject({
      adapterId: "codex-subscription",
      connectorId: "connector-1",
    });
    expect(snapshot.attempts[0]?.lineage.adapterId).not.toBe(snapshot.attempts[0]?.lineage.connectorId);
  });

  it("provider execution ID·bounded output·조직 경계를 fail-closed로 검증한다", async () => {
    const state = await running();
    const value = lineage(state.execution.execution_id);
    const dependencies = ports(value);
    const coordinator = new SubscriptionExecutionReceiptCoordinator(store, dependencies.router, dependencies.broker);
    await acquiredAndStarted(coordinator, value);

    await expect(
      coordinator.recordTerminalObserved(context, {
        commandId: crypto.randomUUID(),
        ...value,
        providerExecutionId: "different-execution",
        outcome: "completed",
        usage: { inputTokens: 0, outputTokens: 0 },
        output: { kind: "inline", value: "잘못된 결과" },
      }),
    ).rejects.toThrow("Provider Execution ID");
    await expect(
      coordinator.recordTerminalObserved(context, {
        commandId: crypto.randomUUID(),
        ...value,
        providerExecutionId: value.executionId,
        outcome: "completed",
        usage: { inputTokens: 0, outputTokens: 0 },
        output: { kind: "inline", value: "x".repeat(70_000) },
      }),
    ).rejects.toThrow("byte 상한");
    await expect(coordinator.recover(otherContext, value.executionId)).rejects.toThrow("Runtime Execution");
    expect(dependencies.counts()).toEqual({ routerSettlements: 0, leaseSettlements: 0 });
  });
});
