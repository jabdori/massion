import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { OrganizationGraphService } from "@massion/organization";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { CONTINUATION_STAFFING_MIGRATION, STRATEGY_GENERATION_MIGRATION } from "./schema.js";
import type { StrategyTask } from "./strategy-schema.js";

export interface StaffingAssessmentInput {
  readonly commandId: string;
  readonly workId: string;
  readonly strategyGenerationId: string;
  readonly tasks: readonly StrategyTask[];
}

export interface StaffingRecommendation {
  readonly taskKey: string;
  readonly agentHandle: string;
  readonly requiredCapabilities: readonly string[];
}

export interface StaffingGap {
  readonly gapId: string;
  readonly taskKey: string;
  readonly reason: "missing_recommendation" | "unavailable_recommendation";
  readonly capability?: string;
  readonly agentHandle?: string;
}

export interface StaffingAssessment {
  readonly assessmentId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly strategyGenerationId: string;
  readonly commandId: string;
  readonly status: "verified" | "gaps";
  readonly recommendations: readonly StaffingRecommendation[];
  readonly gaps: readonly StaffingGap[];
  readonly createdByUserId: string;
  readonly createdAt: unknown;
}

interface StaffingAssessmentRecord {
  readonly assessment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly strategy_generation_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly status: StaffingAssessment["status"];
  readonly recommendations_json: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface StaffingGapRecord {
  readonly gap_id: string;
  readonly task_key: string;
  readonly reason: StaffingGap["reason"];
  readonly capability?: string;
  readonly agent_handle?: string;
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

function requestHash(input: StaffingAssessmentInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export class StaffingAdvisor {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly graph: Pick<OrganizationGraphService, "verifyActiveNode">,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    graph: Pick<OrganizationGraphService, "verifyActiveNode">,
  ): Promise<StaffingAdvisor> {
    await applyMigrations(database, [STRATEGY_GENERATION_MIGRATION, CONTINUATION_STAFFING_MIGRATION]);
    return new StaffingAdvisor(database, organizations, graph);
  }

  public async assess(context: TenantContext, input: StaffingAssessmentInput): Promise<StaffingAssessment> {
    await this.organizations.verifyTenantContext(context);
    if (input.tasks.length === 0) throw new Error("Staffing assessment에는 Strategy Task가 필요합니다");
    const hash = requestHash(input);
    const existing = await this.findByCommand(context.organizationId, input.commandId);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("같은 commandId에 다른 staffing 요청을 사용할 수 없습니다");
      return await this.view(existing);
    }

    const recommendations: StaffingRecommendation[] = [];
    const gaps: Omit<StaffingGap, "gapId">[] = [];
    for (const task of input.tasks) {
      if (task.requiredCapabilities.length > 0 && task.recommendedAgentHandles.length === 0) {
        for (const capability of task.requiredCapabilities) {
          gaps.push({ taskKey: task.key, reason: "missing_recommendation", capability });
        }
        continue;
      }
      for (const agentHandle of task.recommendedAgentHandles) {
        try {
          await this.graph.verifyActiveNode(context, agentHandle);
          recommendations.push({
            taskKey: task.key,
            agentHandle,
            requiredCapabilities: task.requiredCapabilities,
          });
        } catch {
          gaps.push({ taskKey: task.key, reason: "unavailable_recommendation", agentHandle });
        }
      }
    }

    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.findByCommand(context.organizationId, input.commandId, tx);
      if (repeated) {
        if (repeated.request_hash !== hash) throw new Error("같은 commandId에 다른 staffing 요청을 사용할 수 없습니다");
        return await this.view(repeated, tx);
      }
      const assessmentId = randomUUID();
      const status = gaps.length > 0 ? "gaps" : "verified";
      const [created] = await tx.query<[StaffingAssessmentRecord[]]>(
        "CREATE staffing_assessment CONTENT { assessment_id: $assessment_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, command_id: $command_id, request_hash: $request_hash, status: $status, recommendations_json: $recommendations_json, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          assessment_id: assessmentId,
          organization_id: context.organizationId,
          work_id: input.workId,
          strategy_generation_id: input.strategyGenerationId,
          command_id: input.commandId,
          request_hash: hash,
          status,
          recommendations_json: canonicalJson(recommendations),
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("Staffing assessment 생성 결과가 없습니다");
      for (const gap of gaps) {
        await tx.query(
          "CREATE staffing_gap CONTENT { gap_id: $gap_id, assessment_id: $assessment_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, task_key: $task_key, reason: $reason, capability: $capability, agent_handle: $agent_handle, created_at: time::now() };",
          {
            gap_id: randomUUID(),
            assessment_id: assessmentId,
            organization_id: context.organizationId,
            work_id: input.workId,
            strategy_generation_id: input.strategyGenerationId,
            task_key: gap.taskKey,
            reason: gap.reason,
            capability: gap.capability,
            agent_handle: gap.agentHandle,
          },
        );
      }
      if (gaps.length > 0) {
        await tx.query(
          "CREATE strategy_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, command_id: $command_id, event_type: 'staffing_gap_detected', payload_json: $payload_json, created_at: time::now() };",
          {
            event_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: input.workId,
            strategy_generation_id: input.strategyGenerationId,
            command_id: `${input.commandId}:gap`,
            payload_json: canonicalJson({ assessmentId, gapCount: gaps.length }),
          },
        );
      }
      return await this.view(created[0], tx);
    });
  }

  private async findByCommand(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<StaffingAssessmentRecord | undefined> {
    const [records] = await executor.query<[StaffingAssessmentRecord[]]>(
      "SELECT * OMIT id FROM staffing_assessment WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async view(
    record: StaffingAssessmentRecord,
    executor: QueryExecutor = this.database,
  ): Promise<StaffingAssessment> {
    const [gapRecords] = await executor.query<[StaffingGapRecord[]]>(
      "SELECT * OMIT id FROM staffing_gap WHERE organization_id = $organization_id AND assessment_id = $assessment_id ORDER BY created_at ASC;",
      { organization_id: record.organization_id, assessment_id: record.assessment_id },
    );
    return {
      assessmentId: record.assessment_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      strategyGenerationId: record.strategy_generation_id,
      commandId: record.command_id,
      status: record.status,
      recommendations: JSON.parse(record.recommendations_json) as StaffingRecommendation[],
      gaps: gapRecords.map((gap) => ({
        gapId: gap.gap_id,
        taskKey: gap.task_key,
        reason: gap.reason,
        ...(gap.capability ? { capability: gap.capability } : {}),
        ...(gap.agent_handle ? { agentHandle: gap.agent_handle } : {}),
      })),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }
}
