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
    const coordinator = new CoreWorkCoordinator(store, {
      ...stages,
      delivery: {
        async execute(_context, input) {
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
    await expect(blockedCoordinator.retryBlocked(context, blocked.runId)).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
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
});
