import type { GrowthGateway, GrowthSuggestionDetails } from "@massion/growth";
import type { TenantContext } from "@massion/identity";

export interface GrowthDecisionApproval {
  readonly approval_id: string;
  readonly status: string;
  readonly revision: number;
}

export interface GrowthSuggestionDecisionDependencies {
  readonly approvals: {
    get(context: TenantContext, approvalId: string): Promise<GrowthDecisionApproval>;
    vote(
      context: TenantContext,
      input: {
        readonly commandId: string;
        readonly approvalId: string;
        readonly expectedRevision: number;
        readonly vote: "approve" | "reject";
        readonly reason: string;
      },
    ): Promise<GrowthDecisionApproval>;
    cancel(
      context: TenantContext,
      input: { readonly commandId: string; readonly approvalId: string; readonly reason: string },
    ): Promise<GrowthDecisionApproval>;
  };
  readonly growth: Pick<GrowthGateway, "adopt" | "reject">;
}

function lineage(detail: GrowthSuggestionDetails, approvalId: string, expectedSuggestionRevision?: number) {
  if (expectedSuggestionRevision !== undefined && detail.suggestion.revision !== expectedSuggestionRevision) {
    throw new Error("Growth Suggestion revision 충돌입니다");
  }
  const adoption = detail.adoption;
  if (!adoption?.approvalId || adoption.approvalId !== approvalId || adoption.status !== "awaiting-review") {
    throw new Error("승인 대기 중인 Growth Adoption을 찾을 수 없습니다");
  }
  return adoption;
}

export async function approveGrowthSuggestion(
  context: TenantContext,
  dependencies: GrowthSuggestionDecisionDependencies,
  input: {
    readonly commandId: string;
    readonly approvalId: string;
    readonly reason: string;
    readonly detail: GrowthSuggestionDetails;
    readonly expectedApprovalRevision?: number;
    readonly expectedSuggestionRevision?: number;
  },
): Promise<{ readonly approval: GrowthDecisionApproval; readonly adoption?: unknown }> {
  const adoption = lineage(input.detail, input.approvalId, input.expectedSuggestionRevision);
  const evaluation = input.detail.evaluation;
  if (!evaluation || evaluation.outcome !== "eligible" || evaluation.inputHash !== adoption.evaluationInputHash) {
    throw new Error("Growth Suggestion의 eligible 평가 계보가 일치하지 않습니다");
  }
  let approval = await dependencies.approvals.get(context, input.approvalId);
  if (approval.approval_id !== input.approvalId) throw new Error("Growth Approval 연결이 일치하지 않습니다");
  if (approval.status === "pending") {
    approval = await dependencies.approvals.vote(context, {
      commandId: input.commandId,
      approvalId: input.approvalId,
      expectedRevision: input.expectedApprovalRevision ?? approval.revision,
      vote: "approve",
      reason: input.reason,
    });
  }
  if (approval.approval_id !== input.approvalId) throw new Error("Growth Approval 결과가 요청과 일치하지 않습니다");
  if (approval.status === "pending") return { approval };
  if (approval.status !== "approved") throw new Error(`승인되지 않은 Growth Approval입니다: ${approval.status}`);
  const adopted = await dependencies.growth.adopt(context, {
    commandId: adoption.commandId,
    suggestionId: input.detail.suggestion.suggestion_id,
    suggestionRevision: input.detail.suggestion.revision,
    evaluationRunId: evaluation.evaluationRunId,
    expectedEvaluationInputHash: adoption.evaluationInputHash,
    expectedTargetChecksum: adoption.beforeChecksum,
    approvalId: input.approvalId,
  });
  return { approval, adoption: adopted };
}

export async function rejectGrowthSuggestion(
  context: TenantContext,
  dependencies: GrowthSuggestionDecisionDependencies,
  input: {
    readonly commandId: string;
    readonly approvalId: string;
    readonly reason: string;
    readonly detail: GrowthSuggestionDetails;
    readonly expectedApprovalRevision?: number;
    readonly expectedSuggestionRevision?: number;
  },
): Promise<{ readonly approval: GrowthDecisionApproval; readonly suggestion: unknown }> {
  if (context.role !== "owner" && context.role !== "admin") {
    throw new Error("Growth Suggestion 거절은 owner 또는 admin만 수행할 수 있습니다");
  }
  lineage(input.detail, input.approvalId, input.expectedSuggestionRevision);
  let approval = await dependencies.approvals.get(context, input.approvalId);
  if (approval.approval_id !== input.approvalId) throw new Error("Growth Approval 연결이 일치하지 않습니다");
  if (
    input.expectedApprovalRevision !== undefined &&
    approval.status !== "cancelled" &&
    approval.status !== "rejected" &&
    approval.revision !== input.expectedApprovalRevision
  ) {
    throw new Error("Growth Approval revision 충돌입니다");
  }
  if (approval.status === "pending" || approval.status === "approved") {
    approval = await dependencies.approvals.cancel(context, {
      commandId: `${input.commandId}:approval-cancel`,
      approvalId: input.approvalId,
      reason: "연결된 Growth Suggestion이 거절되었습니다",
    });
  }
  if (approval.status !== "cancelled" && approval.status !== "rejected") {
    throw new Error(`종료되지 않은 Growth Approval입니다: ${approval.status}`);
  }
  const suggestion = await dependencies.growth.reject(context, {
    commandId: input.commandId,
    suggestionId: input.detail.suggestion.suggestion_id,
    expectedRevision: input.detail.suggestion.revision,
    reason: input.reason,
  });
  return { approval, suggestion };
}
