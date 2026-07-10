import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ApprovalClock, ApprovalRecord } from "./approval-store.js";
import type { PolicyDecision } from "./contracts.js";
import { GOVERNANCE_PERMIT_MIGRATION } from "./schema.js";

export interface ConsumeApprovalInput {
  readonly commandId: string;
  readonly approvalId: string;
  readonly requestHash: string;
  readonly policyVersionId: string;
  readonly resourceRevision?: number;
  readonly executionId: string;
}

export interface ExecutionPermit {
  readonly permit_id: string;
  readonly organization_id: string;
  readonly approval_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly policy_version_id: string;
  readonly resource_revision?: number;
  readonly execution_id: string;
  readonly consumed_by_user_id: string;
  readonly created_at: unknown;
}

export interface CreateBypassInput {
  readonly commandId: string;
  readonly approvalId: string;
  readonly requestHash: string;
  readonly policyVersionId: string;
  readonly resourceRevision?: number;
  readonly action: string;
  readonly resourceId: string;
  readonly environment: string;
  readonly expiresAt: Date;
  readonly reason: string;
}

export interface BypassGrant {
  readonly bypass_id: string;
  readonly organization_id: string;
  readonly approval_id: string;
  readonly command_id: string;
  readonly action: string;
  readonly resource_id: string;
  readonly environment: string;
  readonly reason: string;
  readonly expires_at: unknown;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface DecisionSummaryRecord {
  readonly request_summary_json: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function instant(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

export class PermitStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly clock: ApprovalClock,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    clock: ApprovalClock = { now: () => new Date() },
  ): Promise<PermitStore> {
    await applyMigrations(database, [GOVERNANCE_PERMIT_MIGRATION]);
    return new PermitStore(database, organizations, clock);
  }

  public async consume(context: TenantContext, input: ConsumeApprovalInput): Promise<ExecutionPermit> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [repeated] = await tx.query<[ExecutionPermit[]]>(
        "SELECT * OMIT id FROM governance_execution_permit WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) {
        if (!this.samePermit(repeated[0], input))
          throw new Error("같은 commandId에 다른 Permit 요청을 사용할 수 없습니다");
        return repeated[0];
      }
      const approval = await this.approval(tx, context.organizationId, input.approvalId);
      this.verifyApproval(approval, input);
      const permitId = randomUUID();
      const consumed = await this.markConsumed(tx, context, approval, input.commandId, canonicalJson(input), {
        executionId: input.executionId,
      });
      const [created] = await tx.query<[ExecutionPermit[]]>(
        "CREATE governance_execution_permit CONTENT { permit_id: $permit_id, organization_id: $organization_id, approval_id: $approval_id, command_id: $command_id, request_hash: $request_hash, policy_version_id: $policy_version_id, resource_revision: $resource_revision, execution_id: $execution_id, consumed_by_user_id: $consumed_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          permit_id: permitId,
          organization_id: context.organizationId,
          approval_id: consumed.approval_id,
          command_id: input.commandId,
          request_hash: input.requestHash,
          policy_version_id: input.policyVersionId,
          resource_revision: input.resourceRevision,
          execution_id: input.executionId,
          consumed_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("Execution Permit 생성 결과가 없습니다");
      return await this.permit(tx, context.organizationId, permitId);
    });
  }

  public async createBypass(context: TenantContext, input: CreateBypassInput): Promise<BypassGrant> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    if (input.expiresAt.getTime() <= this.clock.now().getTime()) throw new Error("Bypass 만료는 미래여야 합니다");
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const [repeated] = await tx.query<[BypassGrant[]]>(
        "SELECT * OMIT id FROM governance_bypass WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated[0]) return repeated[0];
      const approval = await this.approval(tx, context.organizationId, input.approvalId);
      this.verifyApproval(approval, input);
      const [decisions] = await tx.query<[DecisionSummaryRecord[]]>(
        "SELECT request_summary_json FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
        { organization_id: context.organizationId, decision_id: approval.decision_id },
      );
      const summary = decisions[0]
        ? (JSON.parse(decisions[0].request_summary_json) as Record<string, unknown>)
        : undefined;
      const resource = summary?.resource as Record<string, unknown> | undefined;
      if (
        !summary ||
        summary.action !== input.action ||
        resource?.id !== input.resourceId ||
        summary.environment !== input.environment
      )
        throw new Error("Bypass 범위가 승인된 Policy 요청과 일치하지 않습니다");
      const bypassId = randomUUID();
      await this.markConsumed(tx, context, approval, input.commandId, canonicalJson(input), { bypassId });
      const [created] = await tx.query<[BypassGrant[]]>(
        "CREATE governance_bypass CONTENT { bypass_id: $bypass_id, organization_id: $organization_id, approval_id: $approval_id, command_id: $command_id, action: $action, resource_id: $resource_id, environment: $environment, reason: $reason, expires_at: $expires_at, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          bypass_id: bypassId,
          organization_id: context.organizationId,
          approval_id: approval.approval_id,
          command_id: input.commandId,
          action: input.action,
          resource_id: input.resourceId,
          environment: input.environment,
          reason: input.reason,
          expires_at: input.expiresAt,
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("Bypass 생성 결과가 없습니다");
      return await this.bypass(tx, context.organizationId, bypassId);
    });
  }

  public allowsBypass(
    grant: BypassGrant,
    outcome: PolicyDecision["outcome"],
    action: string,
    resourceId: string,
    environment: string,
  ): boolean {
    return (
      outcome === "require_approval" &&
      grant.action === action &&
      grant.resource_id === resourceId &&
      grant.environment === environment &&
      instant(grant.expires_at) > this.clock.now().getTime()
    );
  }

  private verifyApproval(
    approval: ApprovalRecord,
    input: Pick<ConsumeApprovalInput, "requestHash" | "policyVersionId" | "resourceRevision">,
  ): void {
    if (approval.status !== "approved") throw new Error(`approved Approval만 소비할 수 있습니다: ${approval.status}`);
    if (instant(approval.expires_at) <= this.clock.now().getTime()) throw new Error("Approval이 만료됐습니다");
    if (approval.request_hash !== input.requestHash) throw new Error("request hash precondition이 일치하지 않습니다");
    if (approval.policy_version_id !== input.policyVersionId)
      throw new Error("policy version precondition이 일치하지 않습니다");
    if (approval.resource_revision !== input.resourceRevision)
      throw new Error("resource revision precondition이 일치하지 않습니다");
  }

  private async markConsumed(
    tx: QueryExecutor,
    context: TenantContext,
    approval: ApprovalRecord,
    commandId: string,
    requestJson: string,
    payload: unknown,
  ): Promise<ApprovalRecord> {
    const [updated] = await tx.query<[ApprovalRecord[]]>(
      "UPDATE governance_approval SET status = 'consumed', revision += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND approval_id = $approval_id AND status = 'approved' RETURN AFTER;",
      { organization_id: context.organizationId, approval_id: approval.approval_id },
    );
    const result = updated[0];
    if (!result) throw new Error("Approval이 이미 소비됐습니다");
    await tx.query(
      "CREATE governance_approval_event CONTENT { event_id: $event_id, organization_id: $organization_id, approval_id: $approval_id, command_id: $command_id, sequence: $sequence, event_type: 'approval_consumed', request_json: $request_json, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        approval_id: approval.approval_id,
        command_id: commandId,
        sequence: result.event_sequence,
        request_json: requestJson,
        payload_json: canonicalJson(payload),
      },
    );
    return result;
  }

  private async approval(executor: QueryExecutor, organizationId: string, approvalId: string): Promise<ApprovalRecord> {
    const [records] = await executor.query<[ApprovalRecord[]]>(
      "SELECT * OMIT id FROM governance_approval WHERE organization_id = $organization_id AND approval_id = $approval_id LIMIT 1;",
      { organization_id: organizationId, approval_id: approvalId },
    );
    if (!records[0]) throw new Error(`Approval을 찾을 수 없습니다: ${approvalId}`);
    return records[0];
  }

  private async permit(executor: QueryExecutor, organizationId: string, permitId: string): Promise<ExecutionPermit> {
    const [records] = await executor.query<[ExecutionPermit[]]>(
      "SELECT * OMIT id FROM governance_execution_permit WHERE organization_id = $organization_id AND permit_id = $permit_id LIMIT 1;",
      { organization_id: organizationId, permit_id: permitId },
    );
    if (!records[0]) throw new Error(`Execution Permit을 찾을 수 없습니다: ${permitId}`);
    return records[0];
  }

  private async bypass(executor: QueryExecutor, organizationId: string, bypassId: string): Promise<BypassGrant> {
    const [records] = await executor.query<[BypassGrant[]]>(
      "SELECT * OMIT id FROM governance_bypass WHERE organization_id = $organization_id AND bypass_id = $bypass_id LIMIT 1;",
      { organization_id: organizationId, bypass_id: bypassId },
    );
    if (!records[0]) throw new Error(`Bypass를 찾을 수 없습니다: ${bypassId}`);
    return records[0];
  }

  private samePermit(permit: ExecutionPermit, input: ConsumeApprovalInput): boolean {
    return (
      permit.approval_id === input.approvalId &&
      permit.request_hash === input.requestHash &&
      permit.policy_version_id === input.policyVersionId &&
      permit.resource_revision === input.resourceRevision &&
      permit.execution_id === input.executionId
    );
  }
}
