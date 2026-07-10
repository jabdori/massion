import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { StructuredAgentRunner, StructuredOutputValidationResult } from "@massion/runtime";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { Work, WorkService } from "@massion/work";
import { z } from "zod";

import type { ContextStore } from "./context-store.js";
import { hashContextContent } from "./context-store.js";
import type { ContextSource, ContextVersion, CreateContextInput } from "./contracts.js";
import { CONTINUATION_STAFFING_MIGRATION } from "./schema.js";
import type { StrategyService } from "./strategy-service.js";

const decisionKind = z.enum(["extend_current", "create_follow_up", "create_independent"]);
const contextDeltaSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000).optional(),
    scopeIn: z.array(z.string().trim().min(1).max(1_000)).max(100),
    scopeOut: z.array(z.string().trim().min(1).max(1_000)).max(100),
    constraints: z.array(z.string().trim().min(1).max(1_000)).max(100),
    assumptions: z.array(z.string().trim().min(1).max(1_000)).max(100),
    unknowns: z.array(z.string().trim().min(1).max(1_000)).max(100),
    decisions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  })
  .strict();
const continuationDecisionSchema = z
  .object({
    decision: decisionKind,
    confidence: z.number().min(0).max(1),
    reasonCodes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
    contextDelta: contextDeltaSchema,
    replanRequired: z.boolean(),
  })
  .strict();

export type ContinuationModelDecision = z.infer<typeof continuationDecisionSchema>;
export type ContinuationDecisionKind = ContinuationModelDecision["decision"];

export interface ContinueWorkInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly text: string;
  readonly surface: string;
  readonly tokenBudget: number;
  readonly classification?: "public" | "internal" | "local-private";
  readonly independentProjectId?: string;
  readonly override?: {
    readonly decision: ContinuationDecisionKind;
    readonly reason: string;
  };
}

export interface ContinuationDecision {
  readonly decisionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly commandId: string;
  readonly requestText: string;
  readonly decision: ContinuationDecisionKind;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly contextDelta: ContinuationModelDecision["contextDelta"];
  readonly replanRequired: boolean;
  readonly source: "model" | "human_override";
  readonly actorUserId: string;
  readonly actorReason?: string;
  readonly status: "decided" | "applied" | "failed";
  readonly appliedWorkId?: string;
  readonly appliedContextVersionId?: string;
  readonly error?: { readonly category: string; readonly causeId: string };
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface ContinuationResult {
  readonly decision: ContinuationDecision;
  readonly work?: Work;
  readonly contextVersion?: ContextVersion;
}

interface ContinuationDecisionRecord {
  readonly decision_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly request_text: string;
  readonly decision: ContinuationDecisionKind;
  readonly confidence: number;
  readonly reason_codes_json: string;
  readonly context_delta_json: string;
  readonly replan_required: boolean;
  readonly source: ContinuationDecision["source"];
  readonly actor_user_id: string;
  readonly actor_reason?: string;
  readonly status: ContinuationDecision["status"];
  readonly applied_work_id?: string;
  readonly applied_context_version_id?: string;
  readonly error_json?: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
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

function inputHash(input: ContinueWorkInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function validateModelOutput(value: unknown): StructuredOutputValidationResult {
  const parsed = continuationDecisionSchema.safeParse(value);
  return parsed.success
    ? { success: true, value: parsed.data }
    : { success: false, error: new Error("Continuation structured output 검증에 실패했습니다") };
}

function unique(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Continuation 생성 시각을 해석할 수 없습니다");
  return date.toISOString();
}

export class ContinuationService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runner: StructuredAgentRunner,
    private readonly contexts: Pick<ContextStore, "create" | "get" | "getLatestForWork">,
    private readonly works: Pick<
      WorkService,
      | "getWork"
      | "getWorkRequest"
      | "getActivePlan"
      | "createWork"
      | "createFollowUpWork"
      | "attachContextVersion"
    >,
    private readonly strategy?: Pick<StrategyService, "plan">,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    runner: StructuredAgentRunner,
    contexts: Pick<ContextStore, "create" | "get" | "getLatestForWork">,
    works: Pick<
      WorkService,
      | "getWork"
      | "getWorkRequest"
      | "getActivePlan"
      | "createWork"
      | "createFollowUpWork"
      | "attachContextVersion"
    >,
    strategy?: Pick<StrategyService, "plan">,
  ): Promise<ContinuationService> {
    await applyMigrations(database, [CONTINUATION_STAFFING_MIGRATION]);
    return new ContinuationService(database, organizations, runner, contexts, works, strategy);
  }

  public async continue(context: TenantContext, input: ContinueWorkInput): Promise<ContinuationResult> {
    await this.organizations.verifyTenantContext(context);
    if (!input.text.trim()) throw new Error("후속 요청 원문은 비어 있을 수 없습니다");
    if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1)
      throw new Error("Continuation token budget은 1 이상의 정수여야 합니다");
    const hash = inputHash(input);
    const existing = await this.findByCommand(context.organizationId, input.commandId);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("같은 commandId에 다른 continuation 요청을 사용할 수 없습니다");
      if (existing.status === "decided") return await this.apply(context, input, existing);
      if (existing.status === "failed") {
        const failed = this.view(existing);
        throw new Error(`이전 Continuation 적용에 실패했습니다: ${failed.error?.causeId ?? "unknown"}`);
      }
      return await this.result(context, existing);
    }

    const work = await this.works.getWork(context, input.workId);
    if (work.revision !== input.expectedWorkRevision)
      throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
    const latestContext = await this.contexts.getLatestForWork(context, input.workId);
    const classified = input.override
      ? this.overrideDecision(input)
      : await this.classify(context, input, work, latestContext);
    const normalized = this.enforceState(work, classified);
    const record = await this.recordDecision(context, input, hash, normalized);
    return await this.apply(context, input, record);
  }

  private overrideDecision(input: ContinueWorkInput): ContinuationModelDecision {
    if (!input.override?.reason.trim()) throw new Error("사람 override 이유가 필요합니다");
    return {
      decision: input.override.decision,
      confidence: 1,
      reasonCodes: ["human_override"],
      contextDelta: {
        scopeIn: [],
        scopeOut: [],
        constraints: [],
        assumptions: [],
        unknowns: [],
        decisions: [],
      },
      replanRequired: false,
    };
  }

  private async classify(
    context: TenantContext,
    input: ContinueWorkInput,
    work: Work,
    latestContext: ContextVersion | undefined,
  ): Promise<ContinuationModelDecision> {
    const request = await this.works.getWorkRequest(context, work.work_id);
    const activePlan = await this.works.getActivePlan(context, work.work_id);
    const route =
      input.classification === "local-private" ||
      latestContext?.selectedSources.some((source) => source.classification === "local-private")
      ? "local-private"
      : "planning-quality";
    const result = await this.runner.executeStructured(
      context,
      {
        commandId: `${input.commandId}:classify`,
        workId: work.work_id,
        agentHandle: "context-strategy",
        modelRoute: route,
        correlationId: input.commandId,
        estimatedTokens: (latestContext?.tokenTotal ?? 0) + 2_000,
        estimatedCostMicros: 0,
        input: {
          operation: "classify_continuation",
          work: { status: work.status, revision: work.revision, projectId: work.project_id },
          originalRequest: request.text,
          latestContext: latestContext
            ? {
                contextVersionId: latestContext.contextVersionId,
                objective: latestContext.objective,
                scopeIn: latestContext.scopeIn,
                scopeOut: latestContext.scopeOut,
                constraints: latestContext.constraints,
                assumptions: latestContext.assumptions,
                unknowns: latestContext.unknowns,
                decisions: latestContext.decisions,
                selectedSources: latestContext.selectedSources,
              }
            : undefined,
          activePlanSummary: activePlan?.content_json,
          followUpRequest: input.text,
        },
      },
      {
        name: "massion-continuation-decision",
        description: "후속 요청의 Work 연장 방식을 분류한다",
        jsonSchema: z.toJSONSchema(continuationDecisionSchema) as Readonly<Record<string, unknown>>,
        validate: validateModelOutput,
      },
    );
    if (result.status === "blocked_model_unavailable") throw new Error("Continuation 분류 모델을 사용할 수 없습니다");
    if (result.status !== "succeeded") throw new Error("Continuation 분류 실행에 실패했습니다");
    const parsed = continuationDecisionSchema.safeParse(result.output);
    if (!parsed.success) throw new Error("Continuation structured output이 유효하지 않습니다");
    return parsed.data;
  }

  private enforceState(work: Work, decision: ContinuationModelDecision): ContinuationModelDecision {
    if (decision.decision !== "extend_current" || ["draft", "planned", "replanning"].includes(work.status)) {
      return decision;
    }
    return {
      ...decision,
      decision: "create_follow_up",
      reasonCodes: unique(decision.reasonCodes, ["state_requires_snapshot"]),
    };
  }

  private async recordDecision(
    context: TenantContext,
    input: ContinueWorkInput,
    hash: string,
    decision: ContinuationModelDecision,
  ): Promise<ContinuationDecisionRecord> {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.findByCommand(context.organizationId, input.commandId, tx);
      if (repeated) {
        if (repeated.request_hash !== hash)
          throw new Error("같은 commandId에 다른 continuation 요청을 사용할 수 없습니다");
        return repeated;
      }
      const decisionId = randomUUID();
      const [created] = await tx.query<[ContinuationDecisionRecord[]]>(
        "CREATE continuation_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, work_id: $work_id, command_id: $command_id, request_hash: $request_hash, request_text: $request_text, decision: $decision, confidence: $confidence, reason_codes_json: $reason_codes_json, context_delta_json: $context_delta_json, replan_required: $replan_required, source: $source, actor_user_id: $actor_user_id, actor_reason: $actor_reason, status: 'decided', created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          decision_id: decisionId,
          organization_id: context.organizationId,
          work_id: input.workId,
          command_id: input.commandId,
          request_hash: hash,
          request_text: input.text.trim(),
          decision: decision.decision,
          confidence: decision.confidence,
          reason_codes_json: canonicalJson(decision.reasonCodes),
          context_delta_json: canonicalJson(decision.contextDelta),
          replan_required: decision.replanRequired,
          source: input.override ? "human_override" : "model",
          actor_user_id: context.userId,
          actor_reason: input.override?.reason.trim(),
        },
      );
      if (!created[0]) throw new Error("Continuation decision 생성 결과가 없습니다");
      await this.insertEvent(tx, context, created[0], `${input.commandId}:decided`, "continuation_decided", {
        decision: decision.decision,
        confidence: decision.confidence,
        reasonCodes: decision.reasonCodes,
        source: input.override ? "human_override" : "model",
      });
      return created[0];
    });
  }

  private async apply(
    context: TenantContext,
    input: ContinueWorkInput,
    record: ContinuationDecisionRecord,
  ): Promise<ContinuationResult> {
    try {
      const parentWork = await this.works.getWork(context, record.work_id);
      const parentContext = await this.contexts.getLatestForWork(context, record.work_id);
      let appliedWork: Work;
      let contextVersion: ContextVersion;
      if (record.decision === "extend_current") {
        if (record.replan_required) {
          if (!this.strategy) throw new Error("재계획에 필요한 StrategyService가 구성되지 않았습니다");
          const prepared = this.buildContextInput(
            input,
            record,
            parentWork,
            parentContext,
            parentWork.work_id,
            `${input.commandId}:replan:context-placeholder`,
            true,
          );
          const { commandId: _commandId, workId: _workId, tokenBudget: _tokenBudget, ...contextInput } = prepared;
          const replanned = await this.strategy.plan(context, {
            commandId: `${input.commandId}:replan`,
            workId: parentWork.work_id,
            expectedWorkRevision: input.expectedWorkRevision,
            tokenBudget: input.tokenBudget,
            context: contextInput,
          });
          if (replanned.generation.status !== "applied" || !replanned.projection) {
            throw new Error(`Continuation 재계획이 적용되지 않았습니다: ${replanned.generation.status}`);
          }
          contextVersion = replanned.contextVersion;
          appliedWork = replanned.projection.work;
        } else {
          contextVersion = await this.createContext(
            context,
            input,
            record,
            parentWork,
            parentContext,
            parentWork.work_id,
            `${input.commandId}:context`,
            true,
          );
          appliedWork = (
            await this.works.attachContextVersion(context, {
              commandId: `${input.commandId}:attach-context`,
              workId: parentWork.work_id,
              expectedRevision: input.expectedWorkRevision,
              contextVersionId: contextVersion.contextVersionId,
            })
          ).work;
        }
      } else if (record.decision === "create_follow_up") {
        const followed = await this.works.createFollowUpWork(context, {
          commandId: `${input.commandId}:follow-up`,
          parentWorkId: parentWork.work_id,
          text: input.text,
          surface: input.surface,
        });
        contextVersion = await this.createContext(
          context,
          input,
          record,
          parentWork,
          parentContext,
          followed.work.work_id,
          `${input.commandId}:child-context`,
          true,
        );
        appliedWork = (
          await this.works.attachContextVersion(context, {
            commandId: `${input.commandId}:attach-child-context`,
            workId: followed.work.work_id,
            expectedRevision: followed.work.revision,
            contextVersionId: contextVersion.contextVersionId,
          })
        ).work;
      } else {
        const created = await this.works.createWork(context, {
          commandId: `${input.commandId}:independent`,
          text: input.text,
          surface: input.surface,
          organizationVersionId: parentWork.organization_version_id,
          ...(input.independentProjectId ? { projectId: input.independentProjectId } : {}),
          ...(parentWork.policy_version_id ? { policyVersionId: parentWork.policy_version_id } : {}),
          ...(parentWork.prompt_version_id ? { promptVersionId: parentWork.prompt_version_id } : {}),
        });
        contextVersion = await this.createContext(
          context,
          input,
          record,
          parentWork,
          undefined,
          created.work.work_id,
          `${input.commandId}:independent-context`,
          false,
        );
        appliedWork = (
          await this.works.attachContextVersion(context, {
            commandId: `${input.commandId}:attach-independent-context`,
            workId: created.work.work_id,
            expectedRevision: created.work.revision,
            contextVersionId: contextVersion.contextVersionId,
          })
        ).work;
      }
      const applied = await this.finish(context, record, "applied", {
        appliedWorkId: appliedWork.work_id,
        appliedContextVersionId: contextVersion.contextVersionId,
      });
      return { decision: this.view(applied), work: appliedWork, contextVersion };
    } catch (error) {
      const failed = await this.finish(context, record, "failed", {
        error: { category: "continuation_apply", causeId: randomUUID() },
      });
      throw new Error(`Continuation 적용에 실패했습니다: ${this.view(failed).error?.causeId ?? "unknown"}`, {
        cause: error,
      });
    }
  }

  private async createContext(
    context: TenantContext,
    input: ContinueWorkInput,
    record: ContinuationDecisionRecord,
    parentWork: Work,
    parent: ContextVersion | undefined,
    targetWorkId: string,
    commandId: string,
    inheritParent: boolean,
  ): Promise<ContextVersion> {
    return await this.contexts.create(
      context,
      this.buildContextInput(input, record, parentWork, parent, targetWorkId, commandId, inheritParent),
    );
  }

  private buildContextInput(
    input: ContinueWorkInput,
    record: ContinuationDecisionRecord,
    parentWork: Work,
    parent: ContextVersion | undefined,
    targetWorkId: string,
    commandId: string,
    inheritParent: boolean,
  ): CreateContextInput {
    const delta = JSON.parse(record.context_delta_json) as ContinuationModelDecision["contextDelta"];
    const source: ContextSource = {
      kind: "follow_up",
      sourceId: `continuation-${record.decision_id}`,
      revision: "1",
      contentHash: hashContextContent(input.text.trim()),
      observedAt: isoTimestamp(record.created_at),
      classification: input.classification ?? "internal",
      priority: 100,
      estimatedTokens: Math.max(1, Math.ceil(input.text.length / 4)),
      mandatory: true,
      content: input.text.trim(),
    };
    return {
      commandId,
      workId: targetWorkId,
      ...(parentWork.project_id ? { projectId: parentWork.project_id } : {}),
      ...(inheritParent && parent ? { expectedParentContextVersionId: parent.contextVersionId } : {}),
      tokenBudget: input.tokenBudget,
      objective: delta.objective ?? parent?.objective ?? input.text.trim(),
      scopeIn: unique(parent?.scopeIn ?? [], delta.scopeIn),
      scopeOut: unique(parent?.scopeOut ?? [], delta.scopeOut),
      constraints: unique(parent?.constraints ?? [], delta.constraints),
      assumptions: unique(parent?.assumptions ?? [], delta.assumptions),
      unknowns: unique(parent?.unknowns ?? [], delta.unknowns),
      decisions: unique(parent?.decisions ?? [], delta.decisions),
      sources: [...(parent?.sources ?? []), source],
    };
  }

  private async finish(
    context: TenantContext,
    record: ContinuationDecisionRecord,
    status: "applied" | "failed",
    result: {
      readonly appliedWorkId?: string;
      readonly appliedContextVersionId?: string;
      readonly error?: { readonly category: string; readonly causeId: string };
    },
  ): Promise<ContinuationDecisionRecord> {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const current = await this.findByCommand(context.organizationId, record.command_id, tx);
      if (!current) throw new Error("Continuation decision을 찾을 수 없습니다");
      if (current.status === status) return current;
      if (current.status !== "decided") throw new Error(`Continuation decision을 적용할 수 없습니다: ${current.status}`);
      const [updated] = await tx.query<[ContinuationDecisionRecord[]]>(
        "UPDATE continuation_decision SET status = $status, applied_work_id = $applied_work_id, applied_context_version_id = $applied_context_version_id, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND decision_id = $decision_id AND status = 'decided' RETURN AFTER;",
        {
          status,
          applied_work_id: result.appliedWorkId,
          applied_context_version_id: result.appliedContextVersionId,
          error_json: result.error ? canonicalJson(result.error) : undefined,
          organization_id: context.organizationId,
          decision_id: record.decision_id,
        },
      );
      if (!updated[0]) throw new Error("Continuation decision 상태 전이에 실패했습니다");
      await this.insertEvent(
        tx,
        context,
        updated[0],
        `${record.command_id}:${status}`,
        `continuation_${status}`,
        {
          status,
          ...(result.appliedWorkId ? { appliedWorkId: result.appliedWorkId } : {}),
          ...(result.appliedContextVersionId ? { appliedContextVersionId: result.appliedContextVersionId } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      );
      return updated[0];
    });
  }

  private async result(context: TenantContext, record: ContinuationDecisionRecord): Promise<ContinuationResult> {
    const work = record.applied_work_id ? await this.works.getWork(context, record.applied_work_id) : undefined;
    const contextVersion = record.applied_context_version_id
      ? await this.contexts.get(context, record.applied_context_version_id)
      : undefined;
    return {
      decision: this.view(record),
      ...(work ? { work } : {}),
      ...(contextVersion ? { contextVersion } : {}),
    };
  }

  private async findByCommand(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<ContinuationDecisionRecord | undefined> {
    const [records] = await executor.query<[ContinuationDecisionRecord[]]>(
      "SELECT * OMIT id FROM continuation_decision WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async insertEvent(
    executor: QueryExecutor,
    context: TenantContext,
    record: ContinuationDecisionRecord,
    commandId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    await executor.query(
      "CREATE continuation_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, decision_id: $decision_id, command_id: $command_id, event_type: $event_type, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        work_id: record.work_id,
        decision_id: record.decision_id,
        command_id: commandId,
        event_type: eventType,
        payload_json: canonicalJson(payload),
      },
    );
  }

  private view(record: ContinuationDecisionRecord): ContinuationDecision {
    return {
      decisionId: record.decision_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      commandId: record.command_id,
      requestText: record.request_text,
      decision: record.decision,
      confidence: record.confidence,
      reasonCodes: JSON.parse(record.reason_codes_json) as string[],
      contextDelta: JSON.parse(record.context_delta_json) as ContinuationModelDecision["contextDelta"],
      replanRequired: record.replan_required,
      source: record.source,
      actorUserId: record.actor_user_id,
      ...(record.actor_reason ? { actorReason: record.actor_reason } : {}),
      status: record.status,
      ...(record.applied_work_id ? { appliedWorkId: record.applied_work_id } : {}),
      ...(record.applied_context_version_id
        ? { appliedContextVersionId: record.applied_context_version_id }
        : {}),
      ...(record.error_json
        ? { error: JSON.parse(record.error_json) as { readonly category: string; readonly causeId: string } }
        : {}),
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
