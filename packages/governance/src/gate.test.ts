import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceApprovalRequiredError, GovernanceGate } from "./gate.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";

describe("Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let approvals: ApprovalStore;
  let emergency: EmergencyControl;
  let gate: GovernanceGate;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "gate@example.com", displayName: "Gate" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    emergency = await EmergencyControl.create(database, organizations, permits);
    gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
  });

  function input() {
    return {
      commandId: "organization-change-1",
      action: "organization.change",
      resource: { type: "Organization", id: context.organizationId, revision: 1 },
      environment: "local",
      riskClass: "write",
      external: false,
      executionId: "organization-change-1",
    } as const;
  }

  it("승인 필요 오류에 decision·approval ID를 제공하고 승인 후 재시도를 허용한다", async () => {
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await gate.authorize(context, input());
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("승인 필요 오류가 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    const result = await gate.authorize(context, {
      ...input(),
      approvalId: required.approvalId,
    });

    expect(result.outcome).toBe("allow");
    expect(result.permit?.approval_id).toBe(required.approvalId);
  });

  it("승인 후 target revision을 바꾼 재시도는 TOCTOU로 거부한다", async () => {
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await gate.authorize(context, input());
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
    }
    if (!required) throw new Error("승인 필요 오류가 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    await expect(
      gate.authorize(context, {
        ...input(),
        resource: { ...input().resource, revision: 2 },
        approvalId: required.approvalId,
      }),
    ).rejects.toThrow("resource revision");
  });

  it("긴급 중단 상태에서는 safe-read가 아니면 정책 평가 전에 차단한다", async () => {
    await emergency.activate(context, { commandId: crypto.randomUUID(), reason: "incident" });

    await expect(gate.authorize(context, input())).rejects.toThrow("긴급 중단");
  });
});
