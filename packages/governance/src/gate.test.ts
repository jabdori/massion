import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApprovalStore } from "./approval-store.js";
import { createDefaultPolicy } from "./defaults.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceApprovalRequiredError, GovernanceGate, type GovernedAgentIdentityReader } from "./gate.js";
import { GovernanceService } from "./governance-service.js";
import { PermitStore } from "./permit.js";
import { PolicyStore } from "./policy-store.js";

describe("Governance Gate", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let approvals: ApprovalStore;
  let emergency: EmergencyControl;
  let gate: GovernanceGate;
  let agentIdentity: {
    organizationId: string;
    workId: string;
    agentHandle: string;
    status: "succeeded" | "failed";
  };

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "gate@example.com", displayName: "Gate" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    emergency = await EmergencyControl.create(database, organizations, permits);
    agentIdentity = {
      organizationId: context.organizationId,
      workId: "work-1",
      agentHandle: "growth",
      status: "succeeded",
    };
    const identityReader: GovernedAgentIdentityReader = { resolve: async () => agentIdentity };
    gate = new GovernanceGate(governance, approvals, permits, emergency, identityReader);
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

  it("모델 추천 승인을 recommendation checksum·resource에 결합해 Permit을 한 번 소비한다", async () => {
    const governed = {
      commandId: "optimization-recommendation-approve",
      action: "model.optimization.approve",
      resource: {
        type: "OptimizationRecommendation",
        id: "recommendation-1",
        attributes: { recommendationChecksum: "a".repeat(64) },
      },
      environment: "local",
      riskClass: "model-optimization",
      external: false,
      executionId: "optimization-recommendation:recommendation-1",
    } as const;
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await gate.authorize(context, governed);
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("모델 추천 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: "optimization-recommendation-vote",
      approvalId: required.approvalId,
      expectedRevision: 1,
      vote: "approve",
      reason: "검증된 모델 추천입니다",
    });

    const authorized = await gate.authorize(context, { ...governed, approvalId: required.approvalId });
    const replayed = await gate.authorize(context, { ...governed, approvalId: required.approvalId });
    expect(replayed.permit).toEqual(authorized.permit);
    const [permits] = await database.query<[Array<{ approval_id: string }>]>(
      "SELECT approval_id FROM governance_execution_permit WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, approval_id: required.approvalId },
    );
    expect(permits).toEqual([{ approval_id: required.approvalId }]);
    await expect(
      gate.authorize(context, {
        ...governed,
        resource: {
          ...governed.resource,
          attributes: { recommendationChecksum: "b".repeat(64) },
        },
        approvalId: required.approvalId,
      }),
    ).rejects.toThrow("request hash");
    await expect(
      gate.authorize(context, {
        ...governed,
        resource: { ...governed.resource, id: "recommendation-2" },
        approvalId: required.approvalId,
      }),
    ).rejects.toThrow("request hash");
  });

  it("구독 Runtime 승인만 명시적인 재개 대상으로 기록한다", async () => {
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await gate.authorize(context, {
        ...input(),
        action: "tool.call",
        resource: { type: "Tool", id: "tool-call-1" },
        workId: "work-1",
        executionId: "execution-1",
        resumeTarget: "runtime-subscription",
        approvalPreview: {
          kind: "file-change",
          title: "파일 변경",
          path: "/workspace/src/index.ts",
          summary: "검증 로직 변경",
        },
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("구독 Runtime 승인 요청이 없습니다");

    await expect(approvals.get(context, required.approvalId)).resolves.toMatchObject({
      work_id: "work-1",
      execution_id: "execution-1",
      resume_target: "runtime-subscription",
      display_preview_json: JSON.stringify({
        kind: "file-change",
        path: "/workspace/src/index.ts",
        summary: "검증 로직 변경",
        title: "파일 변경",
      }),
    });
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

  it("active Policy 교체는 현재 정책의 사람 승인과 원자 Permit을 요구한다", async () => {
    const administered = await PolicyStore.create(database, organizations, gate);
    const defaults = createDefaultPolicy("personal");
    const active = await administered.getActive(context);
    if (!active) throw new Error("active 정책이 없습니다");
    const draft = await administered.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    const commandId = crypto.randomUUID();
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await administered.activate(context, {
        commandId,
        policyVersionId: draft.policy_version_id,
        expectedActivePolicyVersionId: active.policy_version_id,
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("정책 교체 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: crypto.randomUUID(),
      approvalId: required.approvalId,
      vote: "approve",
      reason: "policy reviewed",
    });

    const activated = await administered.activate(context, {
      commandId,
      policyVersionId: draft.policy_version_id,
      expectedActivePolicyVersionId: active.policy_version_id,
      governanceApprovalId: required.approvalId,
    });

    expect(activated.status).toBe("active");
  });

  it("검증된 Growth Agent의 review는 승인 요청하고 auto는 허용한다", async () => {
    const adoption = {
      commandId: "growth-agent-adoption",
      action: "growth.adopt",
      workId: "work-1",
      resource: { type: "Suggestion", id: "suggestion-1", revision: 1 },
      environment: "local",
      riskClass: "growth-adoption",
      external: false,
      executionId: "growth-execution-1",
    } as const;

    await expect(gate.authorizeAgent(context, { ...adoption, automationMode: "review" })).rejects.toBeInstanceOf(
      GovernanceApprovalRequiredError,
    );
    await expect(
      gate.authorizeAgent(context, {
        ...adoption,
        commandId: "growth-agent-adoption-auto",
        automationMode: "auto",
      }),
    ).resolves.toMatchObject({ outcome: "allow" });
    const [decisions] = await database.query<[Array<{ principal_type: string; principal_id: string }>]>(
      "SELECT principal_type, principal_id FROM governance_policy_decision WHERE command_id = 'growth-agent-adoption-auto:policy';",
    );
    expect(decisions[0]).toEqual({ principal_type: "Agent", principal_id: "growth-execution-1" });
  });

  it("다른 Work·handle·상태의 실행은 Growth Agent로 가장할 수 없다", async () => {
    const adoption = {
      commandId: "invalid-growth-agent",
      action: "growth.adopt",
      workId: "work-1",
      automationMode: "auto" as const,
      resource: { type: "Suggestion", id: "suggestion-1", revision: 1 },
      environment: "local",
      riskClass: "growth-adoption",
      external: false,
      executionId: "delivery-execution-1",
    };

    agentIdentity = { ...agentIdentity, agentHandle: "delivery-coordination" };
    await expect(gate.authorizeAgent(context, adoption)).rejects.toThrow("Growth Agent");
    agentIdentity = { ...agentIdentity, agentHandle: "growth", status: "failed" };
    await expect(gate.authorizeAgent(context, adoption)).rejects.toThrow("succeeded");
    agentIdentity = { ...agentIdentity, status: "succeeded", workId: "other-work" };
    await expect(gate.authorizeAgent(context, adoption)).rejects.toThrow("Work");
    agentIdentity = { ...agentIdentity, workId: "work-1", organizationId: "other-organization" };
    await expect(gate.authorizeAgent(context, adoption)).rejects.toThrow("organization");
  });
});
