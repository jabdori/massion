import { beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type Work } from "./work.js";

describe("Work Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let approvals: ApprovalStore;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "work-gate@example.com", displayName: "Work Gate" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    now = new Date("2026-07-10T00:00:00.000Z");
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
    const permits = await PermitStore.create(database, organizations, { now: () => now });
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    service = await WorkService.create(database, organizations, graph, gate);
  });

  async function runningWork(): Promise<Work> {
    let work = (
      await service.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "governed work",
        surface: "test",
        organizationVersionId: "org-v1",
      })
    ).work;
    work = (
      await service.addPlan(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        content: { objective: "governed" },
      })
    ).work;
    work = (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "planned",
      })
    ).work;
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "execute",
      objective: "execute",
      acceptanceCriteria: ["done"],
      dependencyIds: [],
    });
    work = task.work;
    work = (
      await service.assignTask(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        taskId: task.task.task_id,
        agentHandle: "delivery-coordination",
      })
    ).work;
    work = (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "ready",
      })
    ).work;
    return (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "running",
      })
    ).work;
  }

  it("위험 실행을 waiting_approval로 전이하고 승인 소비 후 같은 Work를 재개한다", async () => {
    const running = await runningWork();
    const commandId = crypto.randomUUID();
    const waiting = await service.authorizeRunningAction(context, {
      commandId,
      workId: running.work_id,
      expectedRevision: running.revision,
      action: "tool.call",
      environment: "local",
      riskClass: "write",
      external: false,
    });
    if (waiting.outcome !== "waiting_approval") throw new Error("승인 대기 결과가 아닙니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: waiting.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    const resumed = await service.authorizeRunningAction(context, {
      commandId,
      workId: running.work_id,
      expectedRevision: waiting.work.revision,
      governedRevision: running.revision,
      action: "tool.call",
      environment: "local",
      riskClass: "write",
      external: false,
      approvalId: waiting.approvalId,
    });

    expect(resumed.outcome).toBe("allowed");
    expect(resumed.work.status).toBe("running");
    expect((await approvals.get(context, waiting.approvalId)).status).toBe("consumed");
  });

  it.each(["rejected", "expired"] as const)("%s 승인을 waiting_approval Work 취소로 조정한다", async (status) => {
    const running = await runningWork();
    const waiting = await service.authorizeRunningAction(context, {
      commandId: crypto.randomUUID(),
      workId: running.work_id,
      expectedRevision: running.revision,
      action: "tool.call",
      environment: "local",
      riskClass: "write",
      external: false,
    });
    if (waiting.outcome !== "waiting_approval") throw new Error("승인 대기 결과가 아닙니다");
    if (status === "rejected") {
      await approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: waiting.approvalId,
        vote: "reject",
        reason: "위험 작업을 거절합니다",
      });
    } else {
      now = new Date("2026-07-10T02:00:00.000Z");
    }

    const cancelled = await service.reconcileRunningActionApproval(context, {
      commandId: crypto.randomUUID(),
      workId: running.work_id,
      expectedRevision: waiting.work.revision,
      approvalId: waiting.approvalId,
    });

    expect(cancelled.work.status).toBe("cancelled");
    expect((await approvals.get(context, waiting.approvalId)).status).toBe(status);
  });
});
