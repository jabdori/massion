import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";

describe("Governance 긴급 중단", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let governance: GovernanceService;
  let approvals: ApprovalStore;
  let permits: PermitStore;
  let emergency: EmergencyControl;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "emergency@example.com", displayName: "Emergency" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    permits = await PermitStore.create(database, organizations);
    emergency = await EmergencyControl.create(database, organizations, permits);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
  });

  it("owner가 즉시 중단하고 모든 일반 실행을 차단한다", async () => {
    const stopped = await emergency.activate(context, {
      commandId: crypto.randomUUID(),
      reason: "credential 유출 대응",
    });

    expect(stopped.active).toBe(true);
    await expect(emergency.assertExecutionAllowed(context)).rejects.toThrow("긴급 중단");
    expect((await emergency.listEvents(context)).map((event) => event.event_type)).toEqual([
      "emergency_stop_activated",
    ]);
  });

  it("사람 승인을 일회 소비해야만 긴급 중단을 해제한다", async () => {
    await emergency.activate(context, { commandId: crypto.randomUUID(), reason: "incident" });
    const decision = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: {
        principal: {
          type: "Human",
          id: context.userId,
          organizationId: context.organizationId,
          attributes: { kind: "human", role: "owner" },
        },
        action: "emergency.stop.disable",
        resource: {
          type: "Organization",
          id: context.organizationId,
          organizationId: context.organizationId,
          revision: 1,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: "local", riskClass: "destructive", external: false },
      },
    });
    const requested = await approvals.request(context, {
      commandId: crypto.randomUUID(),
      decisionId: decision.decisionId,
      resourceRevision: 1,
    });
    const approved = await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: requested.approval_id,
      vote: "approve",
      reason: "incident resolved",
    });

    const released = await emergency.release(context, {
      commandId: crypto.randomUUID(),
      approvalId: approved.approval_id,
      requestHash: decision.requestHash,
      policyVersionId: decision.policyVersionId ?? "",
      resourceRevision: 1,
      reason: "복구 확인",
    });

    expect(released.active).toBe(false);
    await expect(emergency.assertExecutionAllowed(context)).resolves.toBeUndefined();
    expect((await approvals.get(context, approved.approval_id)).status).toBe("consumed");
    expect((await emergency.listEvents(context)).map((event) => event.event_type)).toEqual([
      "emergency_stop_activated",
      "emergency_stop_released",
    ]);
  });
});
