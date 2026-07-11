import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

import { validatePolicyBundle } from "./cedar-authorizer.js";
import type { ApprovalRequirement, PolicyBundle } from "./contracts.js";
import type { PolicyStore, PolicyVersion } from "./policy-store.js";

const PROTECTED_ACTION =
  /growth\.(?:adopt|configure)|policy\.activate|extension\.permission_increase|emergency\.stop\.disable/iu;

export interface GrowthPolicyPatch extends Readonly<Record<string, unknown>> {
  readonly policyId: string;
  readonly policyText: string;
}
export interface GrowthProjectionAuthorization {
  readonly decisionId: string;
  readonly suggestionId: string;
  readonly targetRevision: number;
  readonly approvalId?: string;
}
export interface GrowthPolicyProjectionState {
  readonly version: PolicyVersion;
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
}

export function assertGrowthPolicyPatch(patch: Readonly<Record<string, unknown>>): asserts patch is GrowthPolicyPatch {
  if (
    Object.keys(patch).sort().join(",") !== "policyId,policyText" ||
    typeof patch.policyId !== "string" ||
    typeof patch.policyText !== "string"
  ) {
    throw new Error("Policy Growth patch schema가 유효하지 않습니다");
  }
  if (PROTECTED_ACTION.test(patch.policyText)) throw new Error("self-amplification policy는 채택할 수 없습니다");
  const validation = validatePolicyBundle({
    schema: {
      Massion: {
        entityTypes: { Principal: {}, Resource: {} },
        actions: {
          GrowthProjectionCheck: { appliesTo: { principalTypes: ["Principal"], resourceTypes: ["Resource"] } },
        },
      },
    },
    policies: { [patch.policyId]: patch.policyText },
  });
  if (validation.length > 0) throw new Error(`Cedar Policy 검증 실패: ${validation.join(",")}`);
  if (/\bpermit\s*\(/iu.test(patch.policyText) && !/\baction\s*==/iu.test(patch.policyText)) {
    throw new Error("self-amplification을 만들 수 있는 포괄적 permit policy는 채택할 수 없습니다");
  }
}

interface DecisionRecord {
  readonly decision_id: string;
  readonly action: string;
  readonly resource_id: string;
  readonly resource_revision?: number;
  readonly outcome: "allow" | "deny" | "require_approval";
  readonly policy_version_id?: string;
}
interface ApprovalRecord {
  readonly approval_id: string;
  readonly decision_id: string;
  readonly status: string;
}

export class PolicyGrowthProjection {
  public constructor(private readonly policies: PolicyStore) {}

  public async inspect(context: TenantContext, executor: QueryExecutor): Promise<GrowthPolicyProjectionState> {
    return await this.policies.inspectGrowthProjection(context, executor);
  }

  public async apply(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly expectedVersionId: string;
      readonly authorization: GrowthProjectionAuthorization;
    },
    executor: QueryExecutor,
  ): Promise<GrowthPolicyProjectionState> {
    assertGrowthPolicyPatch(input.patch);
    await verifyGrowthProjectionDecision(context, input.authorization, executor);
    return await this.policies.applyGrowthProjection(
      context,
      { commandId: input.commandId, expectedVersionId: input.expectedVersionId, patch: input.patch },
      executor,
    );
  }

  public async revert(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersionId: string;
      readonly targetVersionId: string;
      readonly authorization: GrowthProjectionAuthorization;
    },
    executor: QueryExecutor,
  ): Promise<GrowthPolicyProjectionState> {
    await verifyGrowthProjectionDecision(context, input.authorization, executor, "growth.revert");
    return await this.policies.revertGrowthProjection(
      context,
      {
        commandId: input.commandId,
        expectedVersionId: input.expectedVersionId,
        targetVersionId: input.targetVersionId,
      },
      executor,
    );
  }
}

export async function verifyGrowthProjectionDecision(
  context: TenantContext,
  authorization: GrowthProjectionAuthorization,
  executor: QueryExecutor,
  expectedAction = "growth.adopt",
): Promise<void> {
  const [decisions] = await executor.query<[DecisionRecord[]]>(
    "SELECT decision_id, action, resource_id, resource_revision, outcome, policy_version_id FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
    { organization_id: context.organizationId, decision_id: authorization.decisionId },
  );
  const decision = decisions[0];
  if (
    !decision ||
    decision.action !== expectedAction ||
    decision.resource_id !== authorization.suggestionId ||
    decision.resource_revision !== authorization.targetRevision
  )
    throw new Error(`저장된 ${expectedAction} Policy Decision 범위가 일치하지 않습니다`);
  const [activePolicies] = await executor.query<[Array<{ policy_version_id: string }>]>(
    "SELECT policy_version_id FROM governance_policy_version WHERE organization_id = $organization_id AND status = 'active';",
    { organization_id: context.organizationId },
  );
  if (activePolicies.length !== 1 || decision.policy_version_id !== activePolicies[0]?.policy_version_id) {
    throw new Error(`${expectedAction} 결정의 Policy Version이 현재 active Policy와 일치하지 않습니다`);
  }
  if (decision.outcome === "allow") return;
  if (decision.outcome !== "require_approval" || !authorization.approvalId)
    throw new Error("Growth projection을 허용한 Governance decision이 없습니다");
  const [approvals] = await executor.query<[ApprovalRecord[]]>(
    "SELECT approval_id, decision_id, status FROM governance_approval WHERE organization_id = $organization_id AND approval_id = $approval_id LIMIT 1;",
    { organization_id: context.organizationId, approval_id: authorization.approvalId },
  );
  if (!approvals[0] || approvals[0].decision_id !== decision.decision_id || approvals[0].status !== "consumed")
    throw new Error("소비된 Growth approval이 아닙니다");
}
