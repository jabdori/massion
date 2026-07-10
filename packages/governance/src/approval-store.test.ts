import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PolicyStore } from "./policy-store.js";

describe("Approval Inbox", () => {
  let database: MassionDatabase;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let context: TenantContext;
  let policies: PolicyStore;
  let governance: GovernanceService;
  let approvals: ApprovalStore;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "approval@example.com", displayName: "Approval" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    now = new Date("2026-07-10T00:00:00.000Z");
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
  });

  async function decision(kind: "personal" | "team" = "personal", quorum = 1, activatePolicy = true) {
    if (activatePolicy) {
      const defaults = createDefaultPolicy(kind);
      const requirements = defaults.requirements.map((requirement) => ({ ...requirement, quorum }));
      const draft = await policies.createDraft(context, {
        commandId: crypto.randomUUID(),
        bundle: defaults.bundle,
        requirements,
      });
      const active = await policies.getActive(context);
      await policies.activate(context, {
        commandId: crypto.randomUUID(),
        policyVersionId: draft.policy_version_id,
        ...(active ? { expectedActivePolicyVersionId: active.policy_version_id } : {}),
      });
    }
    return await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: {
        principal: {
          type: "Human",
          id: context.userId,
          organizationId: context.organizationId,
          attributes: { kind: "human", role: context.role },
        },
        action: "tool.call",
        resource: {
          type: "Work",
          id: "work-1",
          organizationId: context.organizationId,
          revision: 3,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: kind === "team" ? "production" : "local", riskClass: "write", external: false },
      },
    });
  }

  it("pending 요청을 만들고 개인 owner의 명시적 표로 승인한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
      workId: "work-1",
    });
    const approved = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "확인했습니다",
    });

    expect(request.status).toBe("pending");
    expect(approved.status).toBe("approved");
    expect((await approvals.listEvents(context, request.approval_id)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("동시 terminal vote는 하나만 반영한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });

    const results = await Promise.allSettled([
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "first",
      }),
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "reject",
        reason: "second",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["approved", "rejected"]).toContain((await approvals.get(context, request.approval_id)).status);
    expect(
      (await approvals.listEvents(context, request.approval_id)).filter((event) =>
        ["approval_approved", "approval_rejected"].includes(event.event_type),
      ),
    ).toHaveLength(1);
  });

  it("team separation-of-duty는 요청자의 자기 승인을 거부하고 다른 admin을 허용한다", async () => {
    const team = await organizations.createTeam(context.userId, "Governed Team");
    context = await organizations.resolveTenantContext(context.userId, team.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
    const admin = await identity.registerPersonalUser({ email: "admin@example.com", displayName: "Admin" });
    await organizations.addMember(context, admin.user.user_id, "admin");
    const adminContext = await organizations.resolveTenantContext(admin.user.user_id, context.organizationId);
    const governed = await decision("team");
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });

    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "self",
      }),
    ).rejects.toThrow("요청자와 승인자를 분리");
    await expect(
      approvals.vote(adminContext, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "reviewed",
      }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("정족수를 만족할 때만 승인하고 reject 표는 즉시 거절한다", async () => {
    const governed = await decision("personal", 2);
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const first = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: request.approval_id,
      vote: "approve",
      reason: "first",
    });

    expect(first.status).toBe("pending");
    const rejectedDecision = await decision("personal", 2, false);
    const rejectedRequest = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: rejectedDecision.decisionId,
      resourceRevision: 3,
    });
    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: rejectedRequest.approval_id,
        vote: "reject",
        reason: "unsafe",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("만료된 요청의 vote를 거부하고 expired 사건을 한 번만 기록한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    now = new Date("2026-07-10T02:00:00.000Z");

    await expect(
      approvals.vote(context, {
        commandId: crypto.randomUUID(),
        approvalId: request.approval_id,
        vote: "approve",
        reason: "late",
      }),
    ).rejects.toThrow("만료");
    await approvals.expire(context, request.approval_id);
    await approvals.expire(context, request.approval_id);

    expect((await approvals.get(context, request.approval_id)).status).toBe("expired");
    expect(
      (await approvals.listEvents(context, request.approval_id)).filter(
        (event) => event.event_type === "approval_expired",
      ),
    ).toHaveLength(1);
  });

  it("같은 command vote는 멱등이고 다른 조직은 승인 요청을 볼 수 없다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const commandId = crypto.randomUUID();
    const input = { commandId, approvalId: request.approval_id, vote: "approve" as const, reason: "ok" };
    const first = await approvals.vote(context, input);
    const repeated = await approvals.vote(context, input);
    const other = await identity.registerPersonalUser({ email: "approval-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    expect(repeated).toEqual(first);
    await expect(approvals.get(otherContext, request.approval_id)).rejects.toThrow("Approval을 찾을 수 없습니다");
  });

  it("requester가 pending 요청을 취소하고 같은 명령을 멱등 재생한다", async () => {
    const governed = await decision();
    const request = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: governed.decisionId,
      resourceRevision: 3,
    });
    const commandId = crypto.randomUUID();

    const cancelled = await approvals.cancel(context, {
      commandId,
      approvalId: request.approval_id,
      reason: "요청 철회",
    });
    const repeated = await approvals.cancel(context, {
      commandId,
      approvalId: request.approval_id,
      reason: "요청 철회",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(repeated).toEqual(cancelled);
  });
});
