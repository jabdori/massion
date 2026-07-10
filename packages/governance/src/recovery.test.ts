import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PolicyStore } from "./policy-store.js";
import { ApprovalRecovery } from "./recovery.js";

describe("Approval 재부팅 복구", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let approvals: ApprovalStore;
  let recovery: ApprovalRecovery;
  let now: Date;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "recovery-approval@example.com",
      displayName: "Recovery",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    now = new Date("2026-07-10T00:00:00.000Z");
    approvals = await ApprovalStore.create(database, organizations, governance, { now: () => now });
    recovery = new ApprovalRecovery(approvals);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
    const decision = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: {
        principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
        action: "tool.call",
        resource: { type: "Work", id: "work-1", organizationId: context.organizationId, revision: 1 },
        context: { environment: "local", riskClass: "write", external: false },
      },
    });
    await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: decision.decisionId,
      resourceRevision: 1,
      workId: "work-1",
      executionId: "execution-1",
    });
  });

  it("유효한 pending 승인을 재개 신호로 복원하고 만료된 것은 한 번 sweep한다", async () => {
    const pending = await recovery.recover(context);

    expect(pending).toEqual([
      expect.objectContaining({ workId: "work-1", executionId: "execution-1", status: "pending" }),
    ]);
    now = new Date("2026-07-10T02:00:00.000Z");
    expect(await recovery.recover(context)).toEqual([]);
    expect(await recovery.recover(context)).toEqual([]);
  });
});
