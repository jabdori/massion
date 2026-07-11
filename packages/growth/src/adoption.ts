import { randomUUID } from "node:crypto";

import { GovernanceApprovalRequiredError, type GovernanceAuthorization } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { GrowthConfigurationVersion } from "./contracts.js";
import type { AuthorizeGrowthAdoptionInput } from "./governance-adapter.js";
import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import type { GrowthSuggestionRecord, SuggestionTargetKind } from "./reflection.js";
import { GROWTH_ADOPTION_MIGRATION } from "./schema.js";
import { GrowthTargetRegistry } from "./targets.js";

export type GrowthAdoptionStatus = "awaiting-review" | "observing" | "rejected" | "reverted";

export function decideAdoptionTransition(input: {
  readonly mode: "review" | "auto";
  readonly authorization: "allow" | "require-approval" | "deny";
}): GrowthAdoptionStatus {
  if (input.authorization === "deny") throw new Error("Growth Adoption이 Governance에 의해 거부됐습니다");
  if (input.mode === "review") {
    if (input.authorization !== "require-approval") throw new Error("review mode는 명시적 승인이 필요합니다");
    return "awaiting-review";
  }
  if (input.authorization !== "allow") throw new Error("auto mode의 Governance allow가 필요합니다");
  return "observing";
}

interface AdoptionRecord {
  readonly adoption_id: string;
  readonly organization_id: string;
  readonly suggestion_id: string;
  readonly target_kind: SuggestionTargetKind;
  readonly evaluation_run_id: string;
  readonly evaluation_input_hash: string;
  readonly configuration_version_id: string;
  readonly runtime_execution_id: string;
  readonly before_version_id: string;
  readonly before_checksum: string;
  readonly after_version_id?: string;
  readonly after_checksum?: string;
  readonly governance_decision_id?: string;
  readonly approval_id?: string;
  readonly status: GrowthAdoptionStatus;
  readonly command_id: string;
  readonly request_hash: string;
}

interface EvaluationRecord {
  readonly evaluation_run_id: string;
  readonly suggestion_id: string;
  readonly input_hash: string;
  readonly outcome: string;
}
interface ReflectionRecord {
  readonly reflection_run_id: string;
  readonly configuration_version_id: string;
  readonly runtime_execution_id?: string;
}
interface ConfigurationRecord {
  readonly configuration_version_id: string;
  readonly adoption_mode: "review" | "auto";
  readonly status: string;
  readonly checksum: string;
}

export interface GrowthAdoptionAuthorizer {
  authorizeAdoption(
    context: TenantContext,
    input: AuthorizeGrowthAdoptionInput,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization>;
}

export interface AdoptGrowthSuggestionInput {
  readonly commandId: string;
  readonly suggestionId: string;
  readonly suggestionRevision: number;
  readonly evaluationRunId: string;
  readonly expectedEvaluationInputHash: string;
  readonly expectedTargetChecksum: string;
  readonly approvalId?: string;
}

export interface GrowthAdoptionResult {
  readonly adoption: AdoptionRecord;
  readonly beforeVersionId: string;
  readonly afterVersionId?: string;
  readonly approvalId?: string;
}

export class GrowthAdoptionService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly authorizer: GrowthAdoptionAuthorizer,
    private readonly targets: GrowthTargetRegistry,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    authorizer: GrowthAdoptionAuthorizer,
    targets: GrowthTargetRegistry,
  ): Promise<GrowthAdoptionService> {
    await applyMigrations(database, [GROWTH_ADOPTION_MIGRATION]);
    return new GrowthAdoptionService(database, organizations, authorizer, targets);
  }

  public async adopt(context: TenantContext, input: AdoptGrowthSuggestionInput): Promise<GrowthAdoptionResult> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = growthChecksum({ ...input, approvalId: undefined });
    const replayed = await this.byCommand(context.organizationId, input.commandId, this.database);
    if (replayed && (replayed.status !== "awaiting-review" || !input.approvalId))
      return this.replay(replayed, requestHash);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrent = await this.byCommand(context.organizationId, input.commandId, transaction);
      if (concurrent && (concurrent.status !== "awaiting-review" || !input.approvalId))
        return this.replay(concurrent, requestHash);
      const suggestion = await this.suggestion(context.organizationId, input.suggestionId, transaction);
      if (!["proposed", "evaluated", "awaiting-review"].includes(suggestion.status))
        throw new Error("Suggestion은 채택 가능한 상태가 아닙니다");
      const evaluation = await this.evaluation(context.organizationId, input.evaluationRunId, transaction);
      if (
        evaluation.suggestion_id !== suggestion.suggestion_id ||
        evaluation.outcome !== "eligible" ||
        evaluation.input_hash !== input.expectedEvaluationInputHash
      ) {
        throw new Error("eligible Evaluation hash precondition이 일치하지 않습니다");
      }
      const reflection = await this.reflection(context.organizationId, suggestion.reflection_run_id, transaction);
      if (!reflection.runtime_execution_id) throw new Error("Growth Runtime Execution 계보가 없습니다");
      await this.verifyGrowthRuntime(
        context.organizationId,
        suggestion.work_id,
        reflection.runtime_execution_id,
        transaction,
      );
      const configuration = await this.configuration(
        context.organizationId,
        reflection.configuration_version_id,
        transaction,
      );
      if (configuration.status !== "active") throw new Error("Growth configuration이 더 이상 active가 아닙니다");
      const port = this.targets.get(suggestion.target_kind);
      const patch = JSON.parse(suggestion.patch_json) as Record<string, unknown>;
      const before = await port.inspect(context, { suggestionId: suggestion.suggestion_id, patch }, transaction);
      if (before.checksum !== input.expectedTargetChecksum) throw new Error("Growth target checksum이 stale합니다");
      let authorization: GovernanceAuthorization;
      try {
        authorization = await this.authorizer.authorizeAdoption(
          context,
          {
            commandId: input.commandId,
            workId: suggestion.work_id,
            suggestionId: suggestion.suggestion_id,
            suggestionRevision: input.suggestionRevision,
            reflectionExecutionId: reflection.runtime_execution_id,
            configuration: this.configurationView(context.organizationId, configuration),
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          },
          transaction,
        );
      } catch (error) {
        if (!(error instanceof GovernanceApprovalRequiredError) || configuration.adoption_mode !== "review")
          throw error;
        const waiting = await this.createRun(
          transaction,
          context,
          input,
          suggestion,
          evaluation,
          configuration,
          reflection.runtime_execution_id,
          before.versionId,
          before.checksum,
          requestHash,
          "awaiting-review",
          error.decisionId,
          error.approvalId,
        );
        await transaction.query(
          "UPDATE growth_suggestion SET status = 'awaiting-review' WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id;",
          { organization_id: context.organizationId, suggestion_id: suggestion.suggestion_id },
        );
        return { adoption: waiting, beforeVersionId: before.versionId, approvalId: error.approvalId };
      }
      if (configuration.adoption_mode === "review" && !input.approvalId)
        throw new Error("review mode는 승인 permit이 필요합니다");
      await port.validate(
        context,
        {
          suggestionId: suggestion.suggestion_id,
          suggestionRevision: input.suggestionRevision,
          patch,
          expectedVersionId: before.versionId,
          expectedChecksum: before.checksum,
          governanceDecisionId: authorization.decision.decisionId,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        transaction,
      );
      const applied = await port.apply(
        context,
        {
          commandId: input.commandId,
          suggestionId: suggestion.suggestion_id,
          suggestionRevision: input.suggestionRevision,
          patch,
          expectedVersionId: before.versionId,
          expectedChecksum: before.checksum,
          governanceDecisionId: authorization.decision.decisionId,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        transaction,
      );
      const run = concurrent
        ? await this.completeAwaiting(
            transaction,
            context,
            concurrent,
            authorization.decision.decisionId,
            input.approvalId,
            applied.after.versionId,
            applied.after.checksum,
          )
        : await this.createRun(
            transaction,
            context,
            input,
            suggestion,
            evaluation,
            configuration,
            reflection.runtime_execution_id,
            applied.before.versionId,
            applied.before.checksum,
            requestHash,
            "observing",
            authorization.decision.decisionId,
            input.approvalId,
            applied.after.versionId,
            applied.after.checksum,
          );
      await transaction.query(
        "CREATE growth_effect_baseline CONTENT { baseline_id: $id, organization_id: $organization_id, adoption_id: $adoption_id, suggestion_id: $suggestion_id, target_kind: $target_kind, target_version_id: $target_version_id, status: 'pending', metrics_json: '{}', checksum: $checksum, created_at: time::now() }; UPDATE growth_suggestion SET status = 'adopted' WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id;",
        {
          id: randomUUID(),
          organization_id: context.organizationId,
          adoption_id: run.adoption_id,
          suggestion_id: suggestion.suggestion_id,
          target_kind: suggestion.target_kind,
          target_version_id: applied.after.versionId,
          checksum: growthChecksum({}),
        },
      );
      return {
        adoption: run,
        beforeVersionId: applied.before.versionId,
        afterVersionId: applied.after.versionId,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      };
    });
  }

  private configurationView(organizationId: string, record: ConfigurationRecord): GrowthConfigurationVersion {
    return {
      configurationVersionId: record.configuration_version_id,
      organizationId,
      subject: { type: "organization" },
      version: 1,
      reflectionEnabled: true,
      adoptionMode: record.adoption_mode,
      status: "active",
      governanceDecisionId: "stored",
      checksum: record.checksum,
      commandId: "stored",
      createdByUserId: "stored",
      createdAt: new Date(0).toISOString(),
      activatedAt: new Date(0).toISOString(),
    };
  }

  private async byCommand(org: string, command: string, executor: QueryExecutor): Promise<AdoptionRecord | undefined> {
    const [r] = await executor.query<[AdoptionRecord[]]>(
      "SELECT * FROM growth_adoption_run WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: org, command_id: command },
    );
    return r[0];
  }
  private replay(record: AdoptionRecord, hash: string): GrowthAdoptionResult {
    if (record.request_hash !== hash) throw new Error("같은 commandId에 다른 Adoption payload를 사용할 수 없습니다");
    return {
      adoption: record,
      beforeVersionId: record.before_version_id,
      ...(record.after_version_id ? { afterVersionId: record.after_version_id } : {}),
      ...(record.approval_id ? { approvalId: record.approval_id } : {}),
    };
  }
  private async suggestion(org: string, id: string, ex: QueryExecutor): Promise<GrowthSuggestionRecord> {
    const [r] = await ex.query<[GrowthSuggestionRecord[]]>(
      "SELECT * FROM growth_suggestion WHERE organization_id = $organization_id AND suggestion_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!r[0]) throw new Error("Growth Suggestion을 찾을 수 없습니다");
    return r[0];
  }
  private async evaluation(org: string, id: string, ex: QueryExecutor): Promise<EvaluationRecord> {
    const [r] = await ex.query<[EvaluationRecord[]]>(
      "SELECT * FROM growth_evaluation_run WHERE organization_id = $organization_id AND evaluation_run_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!r[0]) throw new Error("Growth Evaluation을 찾을 수 없습니다");
    return r[0];
  }
  private async reflection(org: string, id: string, ex: QueryExecutor): Promise<ReflectionRecord> {
    const [r] = await ex.query<[ReflectionRecord[]]>(
      "SELECT * FROM reflection_run WHERE organization_id = $organization_id AND reflection_run_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!r[0]) throw new Error("ReflectionRun을 찾을 수 없습니다");
    return r[0];
  }
  private async verifyGrowthRuntime(
    org: string,
    workId: string,
    executionId: string,
    ex: QueryExecutor,
  ): Promise<void> {
    const [r] = await ex.query<
      [Array<{ organization_id: string; work_id: string; agent_handle: string; status: string }>]
    >(
      "SELECT organization_id, work_id, agent_handle, status FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: org, execution_id: executionId },
    );
    const record = r[0];
    if (!record || record.work_id !== workId || record.agent_handle !== "growth" || record.status !== "succeeded")
      throw new Error("succeeded Growth Runtime Execution 계보가 일치하지 않습니다");
  }
  private async configuration(org: string, id: string, ex: QueryExecutor): Promise<ConfigurationRecord> {
    const [r] = await ex.query<[ConfigurationRecord[]]>(
      "SELECT configuration_version_id, adoption_mode, status, checksum FROM growth_configuration_version WHERE organization_id = $organization_id AND configuration_version_id = $id LIMIT 1;",
      { organization_id: org, id },
    );
    if (!r[0]) throw new Error("GrowthConfigurationVersion을 찾을 수 없습니다");
    return r[0];
  }
  private async createRun(
    ex: QueryExecutor,
    context: TenantContext,
    input: AdoptGrowthSuggestionInput,
    suggestion: GrowthSuggestionRecord,
    evaluation: EvaluationRecord,
    config: ConfigurationRecord,
    runtimeId: string,
    beforeVersion: string,
    beforeChecksum: string,
    requestHash: string,
    status: GrowthAdoptionStatus,
    decisionId: string,
    approvalId?: string,
    afterVersion?: string,
    afterChecksum?: string,
  ): Promise<AdoptionRecord> {
    const id = randomUUID();
    const [r] = await ex.query<[AdoptionRecord[]]>(
      "CREATE growth_adoption_run CONTENT { adoption_id: $id, organization_id: $organization_id, suggestion_id: $suggestion_id, target_kind: $target_kind, evaluation_run_id: $evaluation_run_id, evaluation_input_hash: $evaluation_input_hash, configuration_version_id: $configuration_version_id, runtime_execution_id: $runtime_execution_id, before_version_id: $before_version_id, before_checksum: $before_checksum, after_version_id: $after_version_id, after_checksum: $after_checksum, governance_decision_id: $governance_decision_id, approval_id: $approval_id, status: $status, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now(), active_target_guard: $guard } RETURN AFTER; CREATE growth_adoption_event CONTENT { event_id: $event_id, organization_id: $organization_id, adoption_id: $id, event_type: $status, payload_json: $payload, created_at: time::now() };",
      {
        id,
        event_id: randomUUID(),
        organization_id: context.organizationId,
        suggestion_id: suggestion.suggestion_id,
        target_kind: suggestion.target_kind,
        evaluation_run_id: evaluation.evaluation_run_id,
        evaluation_input_hash: evaluation.input_hash,
        configuration_version_id: config.configuration_version_id,
        runtime_execution_id: runtimeId,
        before_version_id: beforeVersion,
        before_checksum: beforeChecksum,
        after_version_id: afterVersion,
        after_checksum: afterChecksum,
        governance_decision_id: decisionId,
        approval_id: approvalId,
        status,
        command_id: input.commandId,
        request_hash: requestHash,
        user_id: context.userId,
        guard: status === "observing" ? `${context.organizationId}:${suggestion.target_kind}` : undefined,
        payload: canonicalGrowthJson({ decisionId, approvalId }),
      },
    );
    if (!r[0]) throw new Error("Growth Adoption 생성 결과가 없습니다");
    return r[0];
  }
  private async completeAwaiting(
    ex: QueryExecutor,
    context: TenantContext,
    current: AdoptionRecord,
    decisionId: string,
    approvalId: string | undefined,
    afterVersionId: string,
    afterChecksum: string,
  ): Promise<AdoptionRecord> {
    if (!approvalId) throw new Error("awaiting-review Adoption 재개에는 approvalId가 필요합니다");
    const [records] = await ex.query<[AdoptionRecord[]]>(
      "UPDATE growth_adoption_run SET status = 'observing', governance_decision_id = $decision_id, approval_id = $approval_id, after_version_id = $after_version_id, after_checksum = $after_checksum, active_target_guard = $guard, updated_at = time::now() WHERE organization_id = $organization_id AND adoption_id = $adoption_id AND status = 'awaiting-review' RETURN AFTER; CREATE growth_adoption_event CONTENT { event_id: $event_id, organization_id: $organization_id, adoption_id: $adoption_id, event_type: 'adoption_resumed', payload_json: $payload, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        adoption_id: current.adoption_id,
        decision_id: decisionId,
        approval_id: approvalId,
        after_version_id: afterVersionId,
        after_checksum: afterChecksum,
        guard: `${context.organizationId}:${current.target_kind}`,
        event_id: randomUUID(),
        payload: canonicalGrowthJson({ decisionId, approvalId }),
      },
    );
    if (!records[0]) throw new Error("awaiting-review Adoption 상태가 변경됐습니다");
    return records[0];
  }
}
