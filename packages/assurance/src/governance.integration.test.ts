import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  AssuranceBindingStore,
  GovernanceBindingActivationAuthorizer,
  type ProposeAssuranceBindingInput,
} from "./binding-store.js";

describe("Assurance binding Governance 통합", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let approvals: ApprovalStore;
  let organizations: OrganizationService;
  let gate: GovernanceGate;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "binding-gate@example.com", displayName: "Gate" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });
  });

  afterEach(async () => database.close());

  function proposal(): ProposeAssuranceBindingInput {
    return {
      commandId: crypto.randomUUID(),
      workId: "work-governed",
      planVersionId: "plan-1",
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      authorHandle: "context-strategy",
      requiredCriteria: [{ criterionKey: "criterion:evidence", method: "evidence" }],
      bindings: [
        {
          bindingKey: "check:evidence",
          criterionKey: "criterion:evidence",
          kind: "evidence",
          executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
          evidenceKinds: ["artifact-version"],
          maximumAgeMs: 60_000,
          requiredEvidenceKinds: ["artifact-version"],
        },
      ],
    };
  }

  it("위험한 binding 활성화는 실제 사람 승인과 permit 소비 후 허용한다", async () => {
    const store = await AssuranceBindingStore.create(
      database,
      organizations,
      new GovernanceBindingActivationAuthorizer(gate),
      { allowedAuthorHandles: ["context-strategy"] },
    );
    const draft = await store.propose(context, proposal());
    const commandId = crypto.randomUUID();
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await store.activate(context, {
        commandId,
        bindingVersionId: draft.bindingVersionId,
        expectedRevision: draft.revision,
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("Assurance binding activation 승인 요청이 없습니다");
    const pending = await approvals.get(context, required.approvalId);
    const [decisions] = await database.query<[{ request_summary_json: string }[]]>(
      "SELECT request_summary_json FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id;",
      { organization_id: context.organizationId, decision_id: required.decisionId },
    );
    const decision = decisions[0];
    if (!decision) throw new Error("Binding Governance decision을 찾을 수 없습니다");
    expect(pending.resource_revision).toBe(draft.revision);
    expect(JSON.parse(decision.request_summary_json)).toMatchObject({
      resource: { type: "AssuranceBindingVersion", id: draft.bindingVersionId },
    });
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "검증 recipe를 검토했습니다",
    });

    const active = await store.activate(context, {
      commandId,
      bindingVersionId: draft.bindingVersionId,
      expectedRevision: draft.revision,
      approvalId: required.approvalId,
    });

    expect(active).toMatchObject({
      status: "active",
      governanceDecisionId: required.decisionId,
      governanceApprovalId: required.approvalId,
    });
    expect((await approvals.get(context, required.approvalId)).status).toBe("consumed");
  });

  it("local-private 외부 binding 활성화는 실제 Governance deny를 유지한다", async () => {
    const denied = new GovernanceBindingActivationAuthorizer(gate, {
      external: true,
      dataClassification: "local-private",
    });
    await expect(
      denied.authorize(context, {
        commandId: crypto.randomUUID(),
        bindingVersionId: "binding-denied",
        workId: "work-governed",
        revision: 1,
      }),
    ).rejects.toThrow("Governance 정책이 요청을 거부했습니다");
  });
});
