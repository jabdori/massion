import { randomUUID } from "node:crypto";

import { GovernanceApprovalRequiredError, type GovernanceAuthorization } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import { GROWTH_EFFECT_REVERT_MIGRATION } from "./schema.js";
import { GrowthTargetRegistry } from "./targets.js";

export type GrowthRevertStatus = "awaiting-review" | "reverted";

export function decideGrowthRevertTransition(input: {
  readonly mode: "review" | "auto" | "explicit";
  readonly authorization: "allow" | "require-approval" | "deny";
}): GrowthRevertStatus {
  if (input.authorization === "deny") throw new Error("Growth Revert가 Governance에 의해 거부됐습니다");
  if (input.mode === "review") {
    if (input.authorization !== "require-approval") throw new Error("review Revert는 명시적 승인이 필요합니다");
    return "awaiting-review";
  }
  if (input.authorization !== "allow") throw new Error("Growth Revert에는 Governance allow가 필요합니다");
  return "reverted";
}

interface AdoptionRecord {
  readonly adoption_id: string;
  readonly organization_id: string;
  readonly suggestion_id: string;
  readonly target_kind: "prompt" | "memory" | "policy" | "organization";
  readonly configuration_version_id: string;
  readonly runtime_execution_id: string;
  readonly before_version_id: string;
  readonly before_checksum: string;
  readonly after_version_id?: string;
  readonly after_checksum?: string;
  readonly status: string;
}
interface ConfigurationRecord {
  readonly adoption_mode: "review" | "auto";
}
export interface GrowthRevertOperation {
  readonly revert_operation_id: string;
  readonly organization_id: string;
  readonly adoption_id: string;
  readonly status: "awaiting-review" | "completed" | "rejected" | "blocked";
  readonly reverted_version_id?: string;
  readonly approval_id?: string;
  readonly command_id: string;
  readonly request_hash: string;
}

export interface GrowthRevertAuthorizer {
  authorizeRevert(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly suggestionId: string;
      readonly suggestionRevision: number;
      readonly runtimeExecutionId: string;
      readonly mode: "review" | "auto" | "explicit";
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization>;
}

export interface RevertGrowthAdoptionInput {
  readonly commandId: string;
  readonly adoptionId: string;
  readonly suggestionRevision: number;
  readonly reason: "degraded" | "explicit";
  readonly approvalId?: string;
}

export class GrowthRevertService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly authorizer: GrowthRevertAuthorizer,
    private readonly targets: GrowthTargetRegistry,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    authorizer: GrowthRevertAuthorizer,
    targets: GrowthTargetRegistry,
  ): Promise<GrowthRevertService> {
    await applyMigrations(database, [GROWTH_EFFECT_REVERT_MIGRATION]);
    return new GrowthRevertService(database, organizations, authorizer, targets);
  }

  public async revert(context: TenantContext, input: RevertGrowthAdoptionInput): Promise<GrowthRevertOperation> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = growthChecksum({ ...input, approvalId: undefined });
    const observed = await this.byCommand(context.organizationId, input.commandId, this.database);
    if (observed && (observed.status !== "awaiting-review" || !input.approvalId))
      return this.replay(observed, requestHash);
    return await this.database.transaction(async (executor) => {
      await this.organizations.verifyTenantContext(context, undefined, executor);
      const concurrent = await this.byCommand(context.organizationId, input.commandId, executor);
      if (concurrent && (concurrent.status !== "awaiting-review" || !input.approvalId))
        return this.replay(concurrent, requestHash);
      const adoption = await this.adoption(context.organizationId, input.adoptionId, executor);
      if (adoption.status !== "observing" || !adoption.after_version_id || !adoption.after_checksum)
        throw new Error("observing Growth Adoption만 되돌릴 수 있습니다");
      if (input.reason === "degraded")
        await this.assertDegraded(context.organizationId, adoption.adoption_id, executor);
      await executor.query(
        "UPDATE growth_adoption_run SET exposure_status = 'suspended', updated_at = time::now() WHERE organization_id = $organization_id AND adoption_id = $adoption_id;",
        { organization_id: context.organizationId, adoption_id: adoption.adoption_id },
      );
      const configuration = await this.configuration(
        context.organizationId,
        adoption.configuration_version_id,
        executor,
      );
      const mode = input.reason === "explicit" ? "explicit" : configuration.adoption_mode;
      const [suggestions] = await executor.query<[Array<{ work_id: string }>]>(
        "SELECT work_id FROM growth_suggestion WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id LIMIT 1;",
        { organization_id: context.organizationId, suggestion_id: adoption.suggestion_id },
      );
      if (!suggestions[0]) throw new Error("Growth Revert Suggestion을 찾을 수 없습니다");
      const preview = {
        targetKind: adoption.target_kind,
        currentVersionId: adoption.after_version_id,
        currentChecksum: adoption.after_checksum,
        restoreContentVersionId: adoption.before_version_id,
        restoreContentChecksum: adoption.before_checksum,
      };
      let authorization: GovernanceAuthorization;
      try {
        authorization = await this.authorizer.authorizeRevert(
          context,
          {
            commandId: input.commandId,
            workId: suggestions[0].work_id,
            suggestionId: adoption.suggestion_id,
            suggestionRevision: input.suggestionRevision,
            runtimeExecutionId: adoption.runtime_execution_id,
            mode,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          },
          executor,
        );
      } catch (error) {
        if (!(error instanceof GovernanceApprovalRequiredError) || mode !== "review") throw error;
        return await this.createOperation(
          executor,
          context,
          input,
          adoption,
          mode,
          preview,
          requestHash,
          "awaiting-review",
          error.decisionId,
          error.approvalId,
        );
      }
      if (mode === "review" && !input.approvalId) throw new Error("review Revert에는 approval permit이 필요합니다");
      const result = await this.targets.get(adoption.target_kind).revert(
        context,
        {
          commandId: `${input.commandId}:target`,
          suggestionId: adoption.suggestion_id,
          suggestionRevision: input.suggestionRevision,
          expectedVersionId: adoption.after_version_id,
          targetVersionId: adoption.before_version_id,
          governanceDecisionId: authorization.decision.decisionId,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        executor,
      );
      const operation = concurrent
        ? await this.completeWaiting(
            executor,
            context,
            concurrent,
            result.after.versionId,
            authorization.decision.decisionId,
            input.approvalId,
          )
        : await this.createOperation(
            executor,
            context,
            input,
            adoption,
            mode,
            preview,
            requestHash,
            "completed",
            authorization.decision.decisionId,
            input.approvalId,
            result.after.versionId,
          );
      await executor.query(
        "UPDATE growth_adoption_run SET status = 'reverted', exposure_status = 'reverted', active_target_guard = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND adoption_id = $adoption_id; UPDATE growth_effect_baseline SET status = 'closed' WHERE organization_id = $organization_id AND adoption_id = $adoption_id;",
        { organization_id: context.organizationId, adoption_id: adoption.adoption_id },
      );
      return operation;
    });
  }

  private async assertDegraded(org: string, adoptionId: string, executor: QueryExecutor): Promise<void> {
    const [effects] = await executor.query<[Array<{ result: string }>]>(
      "SELECT result, created_at FROM growth_effect_evaluation WHERE organization_id = $organization_id AND adoption_id = $adoption_id ORDER BY created_at DESC LIMIT 1;",
      { organization_id: org, adoption_id: adoptionId },
    );
    if (effects[0]?.result !== "degraded") throw new Error("degraded effect evaluation이 필요합니다");
  }

  private async adoption(org: string, id: string, executor: QueryExecutor): Promise<AdoptionRecord> {
    const [rows] = await executor.query<[AdoptionRecord[]]>(
      "SELECT * FROM growth_adoption_run WHERE organization_id = $organization_id AND adoption_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!rows[0]) throw new Error("Growth Adoption을 찾을 수 없습니다");
    return rows[0];
  }

  private async configuration(org: string, id: string, executor: QueryExecutor): Promise<ConfigurationRecord> {
    const [rows] = await executor.query<[ConfigurationRecord[]]>(
      "SELECT adoption_mode FROM growth_configuration_version WHERE organization_id = $organization_id AND configuration_version_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!rows[0]) throw new Error("Growth configuration을 찾을 수 없습니다");
    return rows[0];
  }

  private async byCommand(
    org: string,
    command: string,
    executor: QueryExecutor,
  ): Promise<GrowthRevertOperation | undefined> {
    const [rows] = await executor.query<[GrowthRevertOperation[]]>(
      "SELECT * FROM growth_revert_operation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: org, command_id: command },
    );
    return rows[0];
  }

  private replay(record: GrowthRevertOperation, hash: string): GrowthRevertOperation {
    if (record.request_hash !== hash) throw new Error("같은 commandId에 다른 Revert payload를 사용할 수 없습니다");
    return record;
  }

  private async createOperation(
    executor: QueryExecutor,
    context: TenantContext,
    input: RevertGrowthAdoptionInput,
    adoption: AdoptionRecord,
    mode: "auto" | "review" | "explicit",
    preview: Readonly<Record<string, unknown>>,
    requestHash: string,
    status: "awaiting-review" | "completed",
    decisionId: string,
    approvalId?: string,
    revertedVersionId?: string,
  ): Promise<GrowthRevertOperation> {
    const id = randomUUID();
    const [rows] = await executor.query<[GrowthRevertOperation[]]>(
      "CREATE growth_revert_operation CONTENT { revert_operation_id: $id, organization_id: $organization_id, adoption_id: $adoption_id, suggestion_id: $suggestion_id, target_kind: $target_kind, mode: $mode, before_version_id: $before_version_id, expected_after_version_id: $expected_after_version_id, expected_after_checksum: $expected_after_checksum, reverted_version_id: $reverted_version_id, preview_json: $preview_json, preview_checksum: $preview_checksum, governance_decision_id: $decision_id, approval_id: $approval_id, status: $status, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        adoption_id: adoption.adoption_id,
        suggestion_id: adoption.suggestion_id,
        target_kind: adoption.target_kind,
        mode,
        before_version_id: adoption.before_version_id,
        expected_after_version_id: adoption.after_version_id,
        expected_after_checksum: adoption.after_checksum,
        reverted_version_id: revertedVersionId,
        preview_json: canonicalGrowthJson(preview),
        preview_checksum: growthChecksum(preview),
        decision_id: decisionId,
        approval_id: approvalId,
        status,
        command_id: input.commandId,
        request_hash: requestHash,
        user_id: context.userId,
      },
    );
    if (!rows[0]) throw new Error("Growth Revert operation 생성 결과가 없습니다");
    return rows[0];
  }

  private async completeWaiting(
    executor: QueryExecutor,
    context: TenantContext,
    current: GrowthRevertOperation,
    versionId: string,
    decisionId: string,
    approvalId?: string,
  ): Promise<GrowthRevertOperation> {
    if (!approvalId) throw new Error("Revert 승인 재개에는 approvalId가 필요합니다");
    const [rows] = await executor.query<[GrowthRevertOperation[]]>(
      "UPDATE growth_revert_operation SET status = 'completed', reverted_version_id = $version_id, governance_decision_id = $decision_id, approval_id = $approval_id, updated_at = time::now() WHERE organization_id = $organization_id AND revert_operation_id = $id AND status = 'awaiting-review' RETURN AFTER;",
      {
        organization_id: context.organizationId,
        id: current.revert_operation_id,
        version_id: versionId,
        decision_id: decisionId,
        approval_id: approvalId,
      },
    );
    if (!rows[0]) throw new Error("awaiting-review Revert 상태가 변경됐습니다");
    return rows[0];
  }
}
