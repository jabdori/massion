import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";

import { ApprovalStore, type ApprovalStatus } from "./approval-store.js";
import type { PolicyDecision, PolicyRequest } from "./contracts.js";
import { EmergencyControl } from "./emergency.js";
import { GovernanceService, hashPolicyRequest } from "./governance-service.js";
import { PermitStore, type ExecutionPermit } from "./permit.js";

export interface GovernedActionInput {
  readonly commandId: string;
  readonly action: string;
  readonly resource: {
    readonly type: string;
    readonly id: string;
    readonly revision?: number;
    readonly dataClassification?: string;
  };
  readonly environment: string;
  readonly riskClass: string;
  readonly external: boolean;
  readonly executionId: string;
  readonly approvalId?: string;
}

export interface GovernanceAuthorization {
  readonly outcome: "allow";
  readonly decision: PolicyDecision;
  readonly permit?: ExecutionPermit;
}

export class GovernanceApprovalRequiredError extends Error {
  public constructor(
    public readonly decisionId: string,
    public readonly approvalId: string,
  ) {
    super(`사람 승인이 필요합니다: ${approvalId}`);
    this.name = "GovernanceApprovalRequiredError";
  }
}

export class GovernanceDeniedError extends Error {
  public constructor(public readonly decision: PolicyDecision) {
    super(`Governance 정책이 요청을 거부했습니다: ${decision.reasons.join(",") || decision.errors.join(",")}`);
    this.name = "GovernanceDeniedError";
  }
}

export class GovernanceGate {
  public constructor(
    private readonly governance: GovernanceService,
    private readonly approvals: ApprovalStore,
    private readonly permits: PermitStore,
    private readonly emergency: EmergencyControl,
  ) {}

  public async authorize(
    context: TenantContext,
    input: GovernedActionInput,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.action !== "work.read" && input.action !== "emergency.stop")
      await this.emergency.assertExecutionAllowed(context);
    const request = this.request(context, input);
    if (input.approvalId) {
      const approval = await this.approvals.get(context, input.approvalId);
      const decision = await this.governance.getDecision(context, approval.decision_id);
      if (approval.resource_revision !== input.resource.revision)
        throw new Error("resource revision precondition이 일치하지 않습니다");
      if (decision.requestHash !== hashPolicyRequest(request))
        throw new Error("request hash precondition이 일치하지 않습니다");
      if (!decision.policyVersionId) throw new Error("Policy Decision에 version이 없습니다");
      const permit = await this.permits.consume(
        context,
        {
          commandId: `${input.commandId}:permit`,
          approvalId: input.approvalId,
          requestHash: decision.requestHash,
          policyVersionId: decision.policyVersionId,
          ...(input.resource.revision === undefined ? {} : { resourceRevision: input.resource.revision }),
          executionId: input.executionId,
        },
        executor,
      );
      return { outcome: "allow", decision, permit };
    }
    const decision = await this.governance.evaluate(context, {
      commandId: `${input.commandId}:policy`,
      request,
    });
    if (decision.outcome === "deny") throw new GovernanceDeniedError(decision);
    if (decision.outcome === "allow") return { outcome: "allow", decision };
    const approval = await this.approvals.request(context, {
      commandId: `${input.commandId}:approval`,
      decisionId: decision.decisionId,
      ...(input.resource.revision === undefined ? {} : { resourceRevision: input.resource.revision }),
    });
    throw new GovernanceApprovalRequiredError(decision.decisionId, approval.approval_id);
  }

  public async getApprovalStatus(context: TenantContext, approvalId: string): Promise<ApprovalStatus> {
    return (await this.approvals.expire(context, approvalId)).status;
  }

  private request(context: TenantContext, input: GovernedActionInput): PolicyRequest {
    return {
      principal: {
        type: "Human",
        id: context.userId,
        organizationId: context.organizationId,
        attributes: { kind: "human", role: context.role },
      },
      action: input.action,
      resource: {
        type: input.resource.type,
        id: input.resource.id,
        organizationId: context.organizationId,
        ...(input.resource.revision === undefined ? {} : { revision: input.resource.revision }),
        attributes: { dataClassification: input.resource.dataClassification ?? "internal" },
      },
      context: {
        environment: input.environment,
        riskClass: input.riskClass,
        external: input.external,
      },
    };
  }
}
