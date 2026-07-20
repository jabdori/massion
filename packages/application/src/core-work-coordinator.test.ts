import type { TenantContext } from "@massion/identity";
import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_RUN_STAGES,
  CoreWorkCoordinator,
  type CoreWorkStage,
  type CoreWorkStageExecutor,
} from "./core-work-coordinator.js";
import { createCoreWorkPipelineExecutors } from "./core-pipeline.js";
import { ApplicationRunStore } from "./run-store.js";

function executors(calls: string[]): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  return Object.fromEntries(
    APPLICATION_RUN_STAGES.map((stage) => [
      stage,
      {
        async execute(_context: TenantContext, input: { commandId: string }) {
          calls.push(`${stage}:${input.commandId}`);
          return {
            outcome: "advanced" as const,
            ...(stage === "intake" ? { workId: "work-core-run" } : {}),
            data: { stage },
          };
        },
      },
    ]),
  ) as unknown as Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
}

describe("CoreWorkCoordinator", () => {
  it("intake→strategy→evidence→delivery→assurance→records를 결정적 command로 실행한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "coordinator@example.com", displayName: "Core" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, executors(calls));

    const completed = await coordinator.start(context, {
      commandId: "core-run-start-command-0001",
      correlationId: "core-run-correlation-0001",
      request: { text: "전체 파이프라인" },
    });
    expect(completed).toMatchObject({ status: "completed", workId: "work-core-run", stage: "terminal" });
    expect(calls.map((call) => call.split(":").at(-1))).toEqual(APPLICATION_RUN_STAGES);
    expect(calls.every((call) => call.includes(completed.runId))).toBe(true);
    expect(calls).toEqual(APPLICATION_RUN_STAGES.map((stage) => `${stage}:${completed.runId}:${stage}`));
  });

  it("approval 대기와 model unavailable을 명시 상태로 두고 승인 입력으로 재개한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "coordinator-wait@example.com", displayName: "Wait" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    let approved = false;
    const deliveryCommandIds: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        async execute(_context, input) {
          deliveryCommandIds.push(input.commandId);
          if (!approved && input.resumeInput === undefined) {
            return { outcome: "awaiting-approval", approvalId: "approval-core-run" };
          }
          approved = true;
          return { outcome: "advanced" };
        },
      },
    });
    const waiting = await coordinator.start(context, {
      commandId: "core-run-wait-command-0001",
      correlationId: "core-run-wait-correlation-0001",
      request: {},
    });
    expect(waiting).toMatchObject({ status: "awaiting-approval", stage: "delivery", approvalId: "approval-core-run" });
    await expect(
      coordinator.resume(context, waiting.runId, { approvalId: "approval-core-run" }),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    expect(deliveryCommandIds).toEqual([`${waiting.runId}:delivery`, `${waiting.runId}:delivery`]);

    let modelAvailable = false;
    const blockedCoordinator = new CoreWorkCoordinator(store, {
      ...stages,
      intake: {
        execute: async () =>
          modelAvailable ? { outcome: "advanced" } : { outcome: "blocked", reason: "model-unavailable" },
      },
    });
    const blocked = await blockedCoordinator.start(context, {
      commandId: "core-run-blocked-command-0001",
      correlationId: "core-run-blocked-correlation-0001",
      request: {},
    });
    expect(blocked).toMatchObject({ status: "blocked", stage: "intake", blockedReason: "model-unavailable" });
    modelAvailable = true;
    await expect(
      blockedCoordinator.retryBlocked(context, blocked.runId, "core-run-retry-command-0001"),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
  });

  it("stage 실행 예외는 run을 대기 상태로 남기지 않고 차단 상태로 끝낸다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "coordinator-stage-failure@example.com", displayName: "Fail" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      delivery: {
        async execute() {
          throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
        },
      },
    });

    const blocked = await coordinator.start(context, {
      commandId: "core-run-stage-failure-command-0001",
      correlationId: "core-run-stage-failure-correlation-0001",
      request: {},
    });

    expect(blocked).toMatchObject({ status: "blocked", stage: "delivery", blockedReason: "delivery-stage-failed" });
    await expect(store.getByCommand(context, "core-run-stage-failure-command-0001")).resolves.toMatchObject({
      status: "blocked",
      stage: "delivery",
      blockedReason: "delivery-stage-failed",
    });
  });

  it("차단된 재시도와 실행 중 취소는 같은 재시도 시도 command prefix를 사용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-prefix@example.com",
      displayName: "Retry prefix",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const calls: string[] = [];
    let retrying = false;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          calls.push(input.commandId);
          return retrying
            ? { outcome: "in-progress" as const }
            : { outcome: "blocked" as const, reason: "assurance-verifier-interrupted" };
        },
        async cancel(_context, input) {
          calls.push(input.commandId);
        },
      },
    });
    const blocked = await coordinator.start(context, {
      commandId: "core-run-retry-prefix-start-0001",
      correlationId: "core-run-retry-prefix-correlation-0001",
      request: {},
    });
    retrying = true;
    const retryAttemptId = "core-run-retry-prefix-resume-0001";
    const retried = await coordinator.retryBlocked(context, blocked.runId, retryAttemptId);
    expect(retried).toMatchObject({ status: "running", retryAttemptId });
    expect(calls).toEqual([`${blocked.runId}:intake`, `${blocked.runId}:intake:retry:${retryAttemptId}`]);

    await expect(coordinator.cancel(context, blocked.runId)).resolves.toMatchObject({ status: "cancelled" });
    expect(calls).toEqual([
      `${blocked.runId}:intake`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
      `${blocked.runId}:intake:retry:${retryAttemptId}:cancel`,
    ]);
  });

  it("같은 재시도 command는 실행 중에는 기다리고 만료 뒤에는 같은 prefix로 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-recovery@example.com",
      displayName: "Retry recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const clock = { now: new Date("2026-07-19T01:00:00.000Z") };
    const store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 1_000 });
    const calls: string[] = [];
    let retrying = false;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          calls.push(input.commandId);
          return retrying
            ? { outcome: "in-progress" as const }
            : { outcome: "blocked" as const, reason: "assurance-verifier-interrupted" };
        },
      },
    });
    const blocked = await coordinator.start(context, {
      commandId: "core-run-retry-recovery-start-0001",
      correlationId: "core-run-retry-recovery-correlation-0001",
      request: {},
    });
    const retryAttemptId = "core-run-retry-recovery-command-0001";
    retrying = true;
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
    });
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
    });
    expect(calls).toEqual([`${blocked.runId}:intake`, `${blocked.runId}:intake:retry:${retryAttemptId}`]);

    clock.now = new Date("2026-07-19T01:00:01.000Z");
    await expect(coordinator.retryBlocked(context, blocked.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId,
      leaseGeneration: 3,
    });
    expect(calls).toEqual([
      `${blocked.runId}:intake`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
      `${blocked.runId}:intake:retry:${retryAttemptId}`,
    ]);
  });

  it("같은 재시도 command는 approval 대기 상태를 다시 실행하지 않고 그대로 반환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-awaiting@example.com",
      displayName: "Retry awaiting",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-awaiting-start-0001",
      correlationId: "core-run-retry-awaiting-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const retryAttemptId = "core-run-retry-awaiting-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.suspend(context, run.runId, retryClaim.leaseGeneration, "approval-retry-awaiting");
    const coordinator = new CoreWorkCoordinator(store, executors([]));

    await expect(coordinator.retryBlocked(context, run.runId, retryAttemptId)).resolves.toMatchObject({
      status: "awaiting-approval",
      retryAttemptId,
    });
    await expect(
      coordinator.retryBlocked(context, run.runId, "core-run-retry-awaiting-other-command-0001"),
    ).rejects.toThrow("같은 재시도");
  });

  it("advance 뒤 같은 재시도 command는 ready stage를 일반 prefix로 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-replay@example.com",
      displayName: "Retry replay",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-replay-start-0001",
      correlationId: "core-run-retry-replay-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const retryAttemptId = "core-run-retry-replay-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, retryClaim.leaseGeneration, { stage: "context-strategy" });
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      "context-strategy": {
        async execute(_context, input) {
          calls.push(input.commandId);
          return { outcome: "in-progress" };
        },
      },
    });

    await expect(coordinator.retryBlocked(context, run.runId, retryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryReplayId: retryAttemptId,
    });
    expect(calls).toEqual([`${run.runId}:context-strategy`]);
    await expect(
      coordinator.retryBlocked(context, run.runId, "core-run-retry-replay-other-command-0001"),
    ).rejects.toThrow("같은 재시도");
  });

  it("이전 재시도 command replay는 일반 prefix stage의 blocked 결과를 다시 실행하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-retry-replay-blocked@example.com",
      displayName: "Retry replay blocked",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-retry-replay-blocked-start-0001",
      correlationId: "core-run-retry-replay-blocked-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, run.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, run.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const replayAttemptId = "core-run-retry-replay-blocked-command-0001";
    const retryClaim = await store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId: replayAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");
    await store.advance(context, run.runId, retryClaim.leaseGeneration, { stage: "context-strategy" });
    const normalClaim = await store.claim(context, run.runId);
    if (normalClaim.outcome !== "claimed") throw new Error("일반 stage lease를 얻지 못했습니다");
    await store.block(context, run.runId, normalClaim.leaseGeneration, "context-strategy-blocked");
    const calls: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      "context-strategy": {
        async execute(_context, input) {
          calls.push(input.commandId);
          return { outcome: "in-progress" };
        },
      },
    });

    await expect(coordinator.retryBlocked(context, run.runId, replayAttemptId)).resolves.toMatchObject({
      status: "blocked",
      retryReplayId: replayAttemptId,
    });
    expect(calls).toEqual([]);

    const newRetryAttemptId = "core-run-retry-replay-blocked-command-0002";
    await expect(coordinator.retryBlocked(context, run.runId, newRetryAttemptId)).resolves.toMatchObject({
      status: "running",
      retryAttemptId: newRetryAttemptId,
    });
    expect(calls).toEqual([`${run.runId}:context-strategy:retry:${newRetryAttemptId}`]);
  });

  it("stage side effect 뒤 crash는 같은 command를 replay해 중복 없이 복구한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-crash@example.com",
      displayName: "Crash",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations, { leaseMs: 1_000 });
    const sideEffects = new Set<string>();
    const stages = executors([]);
    let crash = true;
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...stages,
        evidence: {
          async execute(_context, input) {
            sideEffects.add(input.commandId);
            return { outcome: "advanced" };
          },
        },
      },
      {
        afterStage: (stage) => {
          if (stage === "evidence" && crash) {
            crash = false;
            throw new Error("coordinator crash injection");
          }
        },
      },
    );
    await expect(
      coordinator.start(context, {
        commandId: "core-run-crash-command-0001",
        correlationId: "core-run-crash-correlation-0001",
        request: {},
      }),
    ).rejects.toThrow("crash injection");
    const run = await store.getByCommand(context, "core-run-crash-command-0001");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(coordinator.recover(context, run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(sideEffects.size).toBe(1);
  });

  it("cancel은 현재 stage drain을 먼저 요청하고 새 stage 실행을 막는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel@example.com",
      displayName: "Cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    const drains: string[] = [];
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        execute: async () => ({ outcome: "awaiting-approval", approvalId: "approval-cancel" }),
        cancel: async (_context, input) => {
          drains.push(input.commandId);
        },
      },
    });
    const waiting = await coordinator.start(context, {
      commandId: "core-run-cancel-command-0001",
      correlationId: "core-run-cancel-correlation-0001",
      request: {},
    });
    const cancelled = await coordinator.cancel(context, waiting.runId);
    expect(cancelled).toMatchObject({ status: "cancelled", stage: "terminal" });
    expect(drains).toEqual([`${waiting.runId}:delivery:cancel`]);
    await expect(coordinator.recover(context, waiting.runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("실행 중 취소가 먼저 끝나면 늦은 stage 결과가 cancelled run을 덮어쓰지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-race@example.com",
      displayName: "Race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const stages = executors([]);
    let entered!: () => void;
    let release!: () => void;
    const enteredStage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseStage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      intake: {
        execute: async () => {
          entered();
          await releaseStage;
          return { outcome: "advanced", workId: "work-cancel-race" };
        },
        cancel: async () => undefined,
      },
    });

    const starting = coordinator.start(context, {
      commandId: "core-run-cancel-race-command-0001",
      correlationId: "core-run-cancel-race-correlation-0001",
      request: {},
    });
    await enteredStage;
    const active = await store.getByCommand(context, "core-run-cancel-race-command-0001");
    await expect(coordinator.cancel(context, active.runId)).resolves.toMatchObject({ status: "cancelled" });
    release();
    await expect(starting).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
  });

  it("intake snapshot 대기 중 취소하면 Work와 Representative를 시작하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-intake-preflight-cancel@example.com",
      displayName: "Intake preflight cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseSnapshot!: (value: { readonly version: { readonly version_id: string } }) => void;
    let enteredSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve;
    });
    const snapshot = new Promise<{ readonly version: { readonly version_id: string } }>((resolve) => {
      releaseSnapshot = resolve;
    });
    let createWorkCalls = 0;
    let representativeCalls = 0;
    const coordinator = new CoreWorkCoordinator(
      store,
      createCoreWorkPipelineExecutors({
        graph: {
          getCurrentSnapshot: async () => {
            enteredSnapshot();
            return await snapshot;
          },
        },
        works: {
          createWork: async () => {
            createWorkCalls += 1;
            return { work: { work_id: "work-should-not-exist", revision: 1, status: "draft" } };
          },
          getWork: async () => ({ work_id: "work-should-not-exist", revision: 1, status: "draft" }),
          transition: async () => ({}) as never,
        },
        runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
        representative: {
          execute: async () => {
            representativeCalls += 1;
            return { executionId: "representative-should-not-start", status: "succeeded" };
          },
          cancel: async () => undefined,
        },
        strategy: { plan: async () => ({}) as never },
        evidence: { execute: async () => ({ outcome: "advanced" }) },
        delivery: { execute: async () => ({ outcome: "advanced" }) },
        assurance: { execute: async () => ({ outcome: "advanced" }) },
        records: { execute: async () => ({ outcome: "advanced" }) },
      } as never),
    );

    const starting = coordinator.start(context, {
      commandId: "core-run-intake-preflight-cancel-command-0001",
      correlationId: "core-run-intake-preflight-cancel-correlation-0001",
      request: { text: "snapshot 대기 중 취소" },
    });
    await snapshotEntered;
    const active = await store.getByCommand(context, "core-run-intake-preflight-cancel-command-0001");
    await expect(coordinator.cancel(context, active.runId)).resolves.toMatchObject({ status: "cancelled" });
    releaseSnapshot({ version: { version_id: "organization-version" } });
    await expect(starting).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
    expect(createWorkCalls).toBe(0);
    expect(representativeCalls).toBe(0);
  });

  it("AbortSignal 뒤 stage cancel이 대기 중이어도 start는 최종 cancelled 결과를 반환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-result-race@example.com",
      displayName: "Cancel result race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseSnapshot!: () => void;
    let releaseStageCancel!: () => void;
    let enteredSnapshot!: () => void;
    let observedAbort!: () => void;
    let enteredStageCancel!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const snapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          enteredSnapshot();
          await snapshot;
          if (!input.signal?.aborted) throw new Error("취소 신호가 전달되지 않았습니다");
          observedAbort();
          throw new Error("Application run cancelled");
        },
        async cancel() {
          enteredStageCancel();
          await stageCancel;
        },
      },
    });

    const starting = coordinator.start(context, {
      commandId: "core-run-cancel-result-race-command-0001",
      correlationId: "core-run-cancel-result-race-correlation-0001",
      request: {},
    });
    const startingOutcome = starting.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await snapshotEntered;
    const active = await store.getByCommand(context, "core-run-cancel-result-race-command-0001");
    const cancelling = coordinator.cancel(context, active.runId);
    await stageCancelEntered;
    releaseSnapshot();
    await abortObserved;
    await expect(
      Promise.race([
        startingOutcome,
        new Promise<"pending">((resolve) => {
          setImmediate(() => resolve("pending"));
        }),
      ]),
    ).resolves.toBe("pending");
    releaseStageCancel();
    await expect(Promise.all([starting, cancelling])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
  });

  it("claim 직후 취소가 먼저 들어와도 intake side effect에는 aborted signal이 전달된다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-claim-cancel-race@example.com",
      displayName: "Claim cancel race",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseStageCancel!: () => void;
    let enteredStageCancel!: () => void;
    let enteredStage!: () => void;
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const stageEntered = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    let sideEffects = 0;
    let receivedAborted: boolean | undefined;
    const coordinator = new CoreWorkCoordinator(store, {
      ...executors([]),
      intake: {
        async execute(_context, input) {
          receivedAborted = input.signal?.aborted;
          if (!input.signal?.aborted) sideEffects += 1;
          enteredStage();
          if (input.signal?.aborted) throw new Error("Application run cancelled");
          return { outcome: "in-progress" };
        },
        async cancel() {
          enteredStageCancel();
          await stageCancel;
        },
      },
    });
    const run = await store.start(context, {
      commandId: "core-run-claim-cancel-race-command-0001",
      correlationId: "core-run-claim-cancel-race-correlation-0001",
      request: {},
    });
    const originalClaim = store.claim.bind(store);
    let cancelling: Promise<unknown> | undefined;
    (store as { claim: typeof store.claim }).claim = async (...args) => {
      const claimed = await originalClaim(...args);
      if (claimed.outcome === "claimed") {
        cancelling = coordinator.cancel(context, run.runId);
        await stageCancelEntered;
      }
      return claimed;
    };

    const recovering = coordinator.recover(context, run.runId);
    await stageEntered;
    const cancellation = cancelling;
    if (!cancellation) throw new Error("claim 직후 취소가 시작되지 않았습니다");
    releaseStageCancel();
    await expect(Promise.all([recovering, cancellation])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
    expect(receivedAborted).toBe(true);
    expect(sideEffects).toBe(0);
  });

  it("취소 중 stage가 advanced를 반환해도 hook이나 다음 stage를 실행하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-post-execute-cancel@example.com",
      displayName: "Post execute cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    let releaseStage!: () => void;
    let releaseStageCancel!: () => void;
    let enteredStage!: () => void;
    let enteredStageCancel!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    const stageCancelEntered = new Promise<void>((resolve) => {
      enteredStageCancel = resolve;
    });
    const stage = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const stageCancel = new Promise<void>((resolve) => {
      releaseStageCancel = resolve;
    });
    let afterStageCalls = 0;
    let nextStageCalls = 0;
    const coordinator = new CoreWorkCoordinator(
      store,
      {
        ...executors([]),
        intake: {
          async execute() {
            enteredStage();
            await stage;
            return { outcome: "advanced", workId: "post-execute-work" };
          },
          async cancel() {
            enteredStageCancel();
            await stageCancel;
          },
        },
        "context-strategy": {
          async execute() {
            nextStageCalls += 1;
            return { outcome: "in-progress" };
          },
        },
      },
      {
        afterStage: async () => {
          afterStageCalls += 1;
        },
      },
    );
    const starting = coordinator.start(context, {
      commandId: "core-run-post-execute-cancel-command-0001",
      correlationId: "core-run-post-execute-cancel-correlation-0001",
      request: {},
    });
    await stageEntered;
    const active = await store.getByCommand(context, "core-run-post-execute-cancel-command-0001");
    const cancelling = coordinator.cancel(context, active.runId);
    await stageCancelEntered;
    releaseStage();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const observedBeforeCancellationCompletes = { afterStageCalls, nextStageCalls };
    releaseStageCancel();
    await expect(Promise.all([starting, cancelling])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
      expect.objectContaining({ status: "cancelled", stage: "terminal" }),
    ]);
    expect(observedBeforeCancellationCompletes).toEqual({ afterStageCalls: 0, nextStageCalls: 0 });
  });

  it("stage cancel 정리 실패 뒤 Work와 Application run을 cancelled로 끝내고 오류를 호출자에게 전파한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "coordinator-cancel-cleanup-failure@example.com",
      displayName: "Cancel cleanup failure",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ApplicationRunStore.create(database, organizations);
    const run = await store.start(context, {
      commandId: "core-run-cancel-cleanup-failure-command-0001",
      correlationId: "core-run-cancel-cleanup-failure-correlation-0001",
      request: {},
    });
    const claim = await store.claim(context, run.runId);
    if (claim.outcome !== "claimed") throw new Error("delivery 취소용 lease를 얻지 못했습니다");
    const delivery = await store.advance(context, run.runId, claim.leaseGeneration, {
      stage: "delivery",
      workId: "work-cancel-cleanup-failure",
    });
    const workTransitions: unknown[] = [];
    const coordinator = new CoreWorkCoordinator(
      store,
      createCoreWorkPipelineExecutors({
        graph: { getCurrentSnapshot: async () => ({ version: { version_id: "organization-version" } }) },
        works: {
          createWork: async () => ({ work: { work_id: "work-should-not-create", revision: 1, status: "draft" } }),
          getWork: async () => ({ work_id: "work-cancel-cleanup-failure", revision: 4, status: "draft" }),
          transition: async (_context: unknown, input: unknown) => {
            workTransitions.push(input);
            return {} as never;
          },
        },
        runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
        representative: {
          execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
          cancel: async () => undefined,
        },
        strategy: { plan: async () => ({}) as never },
        evidence: { execute: async () => ({ outcome: "advanced" }) },
        delivery: {
          execute: async () => ({ outcome: "advanced" }),
          cancel: async () => {
            throw new Error("stage cleanup failed");
          },
        },
        assurance: { execute: async () => ({ outcome: "advanced" }) },
        records: { execute: async () => ({ outcome: "advanced" }) },
      } as never),
    );

    await expect(coordinator.cancel(context, delivery.runId)).rejects.toThrow("stage cleanup failed");
    expect(workTransitions).toEqual([
      {
        commandId: `${delivery.runId}:work-cancel`,
        workId: "work-cancel-cleanup-failure",
        expectedRevision: 4,
        target: "cancelled",
      },
    ]);
    await expect(store.get(context, delivery.runId)).resolves.toMatchObject({ status: "cancelled", stage: "terminal" });
  });
});
