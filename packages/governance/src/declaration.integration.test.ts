import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, DeclarationStore, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { DeclarationGovernanceAdapter } from "./declaration.js";
import { createDefaultPolicy } from "./defaults.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceApprovalRequiredError, GovernanceGate } from "./gate.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";

describe("Declaration Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let approvals: ApprovalStore;
  let declarations: DeclarationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "declaration@example.com", displayName: "Declaration" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
    declarations = await DeclarationStore.create(database, new DeclarationGovernanceAdapter(context, gate));
    await declarations.apply("project-a", { name: "A" });
  });

  it("선언 변경은 승인 후 같은 content hash와 revision으로 원자 적용한다", async () => {
    const commandId = crypto.randomUUID();
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await declarations.apply("project-a", { name: "B" }, { commandId, environment: "local" });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("선언 변경 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "declaration reviewed",
    });

    const changed = await declarations.apply(
      "project-a",
      { name: "B" },
      { commandId, environment: "local", approvalId: required.approvalId },
    );

    expect(changed.declaration.revision).toBe(2);
  });
});
