import { beforeEach, describe, expect, it } from "vitest";

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

import { OrganizationGraphService } from "./organization.js";

describe("Organization Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let approvals: ApprovalStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "org-gate@example.com", displayName: "Org Gate" });
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
    graph = await OrganizationGraphService.create(database, organizations, gate);
    await graph.bootstrap(context);
  });

  it("승인과 일회 Permit 없이는 조직 version을 변경하지 않는다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "engineering",
      name: "Engineering",
      responsibility: "개발",
      parentHandle: "delivery-coordination",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    expect(await graph.listNodes(context)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ handle: "engineering" })]),
    );
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    const changed = await graph.execute(context, { ...command, governanceApprovalId: required.approvalId });

    expect(changed.version.version).toBe(2);
    expect(changed.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ handle: "engineering" })]));
  });

  it("조직 변경 적용 전 transaction 검증이 실패하면 승인 소비도 rollback한다", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create" as const,
      handle: "orphan",
      name: "Orphan",
      responsibility: "invalid",
      parentHandle: "missing-parent",
      scope: "persistent" as const,
    };
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await graph.execute(context, command);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("조직 변경 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "reviewed",
    });

    await expect(graph.execute(context, { ...command, governanceApprovalId: required.approvalId })).rejects.toThrow(
      "대상 노드를 찾을 수 없습니다",
    );

    expect((await approvals.get(context, required.approvalId)).status).toBe("approved");
  });
});
