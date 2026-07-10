import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";

describe("Single-use Permit과 Bypass", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let policies: PolicyStore;
  let governance: GovernanceService;
  let approvals: ApprovalStore;
  let permits: PermitStore;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "permit@example.com", displayName: "Permit" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    now = new Date("2026-07-10T00:00:00.000Z");
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
    permits = await PermitStore.create(database, organizations, { now: () => now });
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
  });

  async function approved(action = "tool.call", resourceRevision = 3) {
    const decision = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: {
        principal: {
          type: "Human",
          id: context.userId,
          organizationId: context.organizationId,
          attributes: { kind: "human", role: "owner" },
        },
        action,
        resource: {
          type: "Work",
          id: "work-1",
          organizationId: context.organizationId,
          revision: resourceRevision,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: "local", riskClass: "write", external: false },
      },
    });
    const approval = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: decision.decisionId,
      resourceRevision,
    });
    const resolved = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: approval.approval_id,
      vote: "approve",
      reason: "reviewed",
    });
    return { decision, approval: resolved };
  }

  it("승인을 request hash·policy version·resource revision·execution에 결합해 한 번 소비한다", async () => {
    const { decision, approval } = await approved();
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      approvalId: approval.approval_id,
      requestHash: decision.requestHash,
      policyVersionId: decision.policyVersionId ?? "",
      resourceRevision: 3,
      executionId: "execution-1",
    };

    const permit = await permits.consume(context, input);
    const repeated = await permits.consume(context, input);

    expect(permit).toMatchObject({ approval_id: approval.approval_id, execution_id: "execution-1" });
    expect(repeated).toEqual(permit);
    expect((await approvals.get(context, approval.approval_id)).status).toBe("consumed");
  });

  it("precondition 불일치는 승인 상태를 소비하지 않는다", async () => {
    const { decision, approval } = await approved();

    await expect(
      permits.consume(context, {
        commandId: crypto.randomUUID(),
        approvalId: approval.approval_id,
        requestHash: decision.requestHash,
        policyVersionId: decision.policyVersionId ?? "",
        resourceRevision: 4,
        executionId: "execution-1",
      }),
    ).rejects.toThrow("resource revision");
    expect((await approvals.get(context, approval.approval_id)).status).toBe("approved");
  });

  it("동시 consume은 정확히 한 건만 성공한다", async () => {
    const { decision, approval } = await approved();
    const base = {
      approvalId: approval.approval_id,
      requestHash: decision.requestHash,
      policyVersionId: decision.policyVersionId ?? "",
      resourceRevision: 3,
    };

    const results = await Promise.allSettled([
      permits.consume(context, { ...base, commandId: crypto.randomUUID(), executionId: "execution-a" }),
      permits.consume(context, { ...base, commandId: crypto.randomUUID(), executionId: "execution-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("범위·환경·만료 Bypass는 require_approval만 완화하고 deny는 바꾸지 않는다", async () => {
    const { decision, approval } = await approved();
    const bypass = await permits.createBypass(context, {
      commandId: crypto.randomUUID(),
      approvalId: approval.approval_id,
      requestHash: decision.requestHash,
      policyVersionId: decision.policyVersionId ?? "",
      resourceRevision: 3,
      action: "tool.call",
      resourceId: "work-1",
      environment: "local",
      expiresAt: new Date("2026-07-10T01:00:00.000Z"),
      reason: "한 시간 자동화",
    });

    expect(permits.allowsBypass(bypass, "require_approval", "tool.call", "work-1", "local")).toBe(true);
    expect(permits.allowsBypass(bypass, "deny", "tool.call", "work-1", "local")).toBe(false);
    expect(permits.allowsBypass(bypass, "require_approval", "organization.change", "work-1", "local")).toBe(false);
    now = new Date("2026-07-10T02:00:00.000Z");
    expect(permits.allowsBypass(bypass, "require_approval", "tool.call", "work-1", "local")).toBe(false);
  });
});
