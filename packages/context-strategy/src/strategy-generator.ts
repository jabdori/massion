import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { StructuredAgentRunner, StructuredOutputValidationResult } from "@massion/runtime";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { WorkService } from "@massion/work";

import type { ContextStore } from "./context-store.js";
import { hashContextContent } from "./context-store.js";
import { STRATEGY_GENERATION_MIGRATION } from "./schema.js";
import { strategyPlanJsonSchema, validateStrategyPlan, type StrategyPlan } from "./strategy-schema.js";

export type StrategyGenerationStatus =
  "pending" | "generated" | "blocked_model_unavailable" | "failed" | "applied" | "conflicted";

export interface StrategyGeneration {
  readonly strategyGenerationId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly contextVersionId: string;
  readonly commandId: string;
  readonly expectedWorkRevision: number;
  readonly status: StrategyGenerationStatus;
  readonly runtimeExecutionId?: string;
  readonly plan?: StrategyPlan;
  readonly checksum?: string;
  readonly error?: { readonly category: string; readonly causeId: string };
  readonly createdByUserId: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface GenerateStrategyInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly contextVersionId: string;
}

interface StrategyGenerationRecord {
  readonly strategy_generation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly context_version_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly expected_work_revision: number;
  readonly status: StrategyGenerationStatus;
  readonly runtime_execution_id?: string;
  readonly plan_json?: string;
  readonly checksum?: string;
  readonly error_json?: string;
  readonly created_by_user_id: string;
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

function requestHash(input: GenerateStrategyInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function validateOutput(value: unknown): StructuredOutputValidationResult {
  try {
    return { success: true, value: validateStrategyPlan(value) };
  } catch {
    return { success: false, error: new Error("StrategyPlan structured output 검증에 실패했습니다") };
  }
}

export class StrategyGenerator {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runner: StructuredAgentRunner,
    private readonly contexts: Pick<ContextStore, "get">,
    private readonly works: Pick<WorkService, "getWork">,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    runner: StructuredAgentRunner,
    contexts: Pick<ContextStore, "get">,
    works: Pick<WorkService, "getWork">,
  ): Promise<StrategyGenerator> {
    await applyMigrations(database, [STRATEGY_GENERATION_MIGRATION]);
    return new StrategyGenerator(database, organizations, runner, contexts, works);
  }

  public async generate(context: TenantContext, input: GenerateStrategyInput): Promise<StrategyGeneration> {
    await this.organizations.verifyTenantContext(context);
    const hash = requestHash(input);
    const existing = await this.byCommand(context.organizationId, input.commandId);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("같은 commandId에 다른 Strategy 요청을 사용할 수 없습니다");
      return this.view(existing);
    }
    const work = await this.works.getWork(context, input.workId);
    if (work.revision !== input.expectedWorkRevision)
      throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
    const contextVersion = await this.contexts.get(context, input.contextVersionId);
    if (contextVersion.workId !== input.workId) throw new Error("ContextVersion과 Work가 일치하지 않습니다");
    const generationId = randomUUID();
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.byCommand(context.organizationId, input.commandId, tx);
      if (repeated) {
        if (repeated.request_hash !== hash) throw new Error("같은 commandId에 다른 Strategy 요청을 사용할 수 없습니다");
        return;
      }
      await tx.query(
        "CREATE strategy_generation CONTENT { strategy_generation_id: $strategy_generation_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: $command_id, request_hash: $request_hash, expected_work_revision: $expected_work_revision, status: 'pending', created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() };",
        {
          strategy_generation_id: generationId,
          organization_id: context.organizationId,
          work_id: input.workId,
          context_version_id: input.contextVersionId,
          command_id: input.commandId,
          request_hash: hash,
          expected_work_revision: input.expectedWorkRevision,
          created_by_user_id: context.userId,
        },
      );
      await this.insertEvent(
        tx,
        context.organizationId,
        input.workId,
        generationId,
        `${input.commandId}:started`,
        "strategy_generation_started",
        { contextVersionId: input.contextVersionId },
      );
    });
    const route = contextVersion.selectedSources.some((source) => source.classification === "local-private")
      ? "local-private"
      : "planning-quality";
    const result = await this.runner.executeStructured(
      context,
      {
        commandId: `${input.commandId}:runtime`,
        workId: input.workId,
        agentHandle: "context-strategy",
        modelRoute: route,
        correlationId: input.commandId,
        estimatedTokens: contextVersion.tokenTotal + 4_000,
        estimatedCostMicros: 0,
        input: {
          operation: "create_strategy_plan",
          contextVersionId: contextVersion.contextVersionId,
          objective: contextVersion.objective,
          scopeIn: contextVersion.scopeIn,
          scopeOut: contextVersion.scopeOut,
          constraints: contextVersion.constraints,
          assumptions: contextVersion.assumptions,
          unknowns: contextVersion.unknowns,
          decisions: contextVersion.decisions,
          sources: contextVersion.selectedSources,
        },
      },
      {
        name: "massion-strategy-plan",
        description: "검증 가능한 Work StrategyPlan",
        jsonSchema: strategyPlanJsonSchema,
        validate: validateOutput,
      },
    );
    if (result.status === "succeeded") {
      try {
        const plan = validateStrategyPlan(result.output);
        return await this.finish(context, input, generationId, "generated", {
          runtimeExecutionId: result.executionId,
          plan,
          checksum: hashContextContent(plan),
        });
      } catch {
        return await this.finish(context, input, generationId, "failed", {
          runtimeExecutionId: result.executionId,
          error: { category: "structured_output", causeId: randomUUID() },
        });
      }
    }
    const status = result.status === "blocked_model_unavailable" ? "blocked_model_unavailable" : "failed";
    return await this.finish(context, input, generationId, status, {
      runtimeExecutionId: result.executionId,
      error: { category: result.error?.category ?? "runtime", causeId: result.error?.causeId ?? randomUUID() },
    });
  }

  public async get(context: TenantContext, strategyGenerationId: string): Promise<StrategyGeneration> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, strategyGenerationId));
  }

  private async finish(
    context: TenantContext,
    input: GenerateStrategyInput,
    generationId: string,
    status: "generated" | "blocked_model_unavailable" | "failed",
    output: {
      readonly runtimeExecutionId: string;
      readonly plan?: StrategyPlan;
      readonly checksum?: string;
      readonly error?: { readonly category: string; readonly causeId: string };
    },
  ): Promise<StrategyGeneration> {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [updated] = await tx.query<[StrategyGenerationRecord[]]>(
        "UPDATE strategy_generation SET status = $status, runtime_execution_id = $runtime_execution_id, plan_json = $plan_json, checksum = $checksum, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id AND status = 'pending' RETURN AFTER;",
        {
          organization_id: context.organizationId,
          strategy_generation_id: generationId,
          status,
          runtime_execution_id: output.runtimeExecutionId,
          plan_json: output.plan ? canonicalJson(output.plan) : undefined,
          checksum: output.checksum,
          error_json: output.error ? canonicalJson(output.error) : undefined,
        },
      );
      if (!updated[0]) throw new Error("Strategy generation terminal 전이에 실패했습니다");
      await this.insertEvent(
        tx,
        context.organizationId,
        input.workId,
        generationId,
        `${input.commandId}:terminal`,
        status === "generated" ? "strategy_generated" : `strategy_generation_${status}`,
        {
          status,
          runtimeExecutionId: output.runtimeExecutionId,
          ...(output.checksum ? { checksum: output.checksum } : {}),
          ...(output.error ? { error: output.error } : {}),
        },
      );
      return this.view(await this.find(tx, context.organizationId, generationId));
    });
  }

  private async byCommand(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<StrategyGenerationRecord | undefined> {
    const [records] = await executor.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async find(
    executor: QueryExecutor,
    organizationId: string,
    generationId: string,
  ): Promise<StrategyGenerationRecord> {
    const [records] = await executor.query<[StrategyGenerationRecord[]]>(
      "SELECT * OMIT id FROM strategy_generation WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id LIMIT 1;",
      { organization_id: organizationId, strategy_generation_id: generationId },
    );
    if (!records[0]) throw new Error(`Strategy generation을 찾을 수 없습니다: ${generationId}`);
    return records[0];
  }

  private async insertEvent(
    executor: QueryExecutor,
    organizationId: string,
    workId: string,
    generationId: string,
    commandId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    await executor.query(
      "CREATE strategy_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, strategy_generation_id: $strategy_generation_id, command_id: $command_id, event_type: $event_type, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        work_id: workId,
        strategy_generation_id: generationId,
        command_id: commandId,
        event_type: eventType,
        payload_json: canonicalJson(payload),
      },
    );
  }

  private view(record: StrategyGenerationRecord): StrategyGeneration {
    const plan = record.plan_json ? validateStrategyPlan(JSON.parse(record.plan_json) as unknown) : undefined;
    if (plan && record.checksum !== hashContextContent(plan)) {
      throw new Error(`Strategy generation checksum이 일치하지 않습니다: ${record.strategy_generation_id}`);
    }
    return {
      strategyGenerationId: record.strategy_generation_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      contextVersionId: record.context_version_id,
      commandId: record.command_id,
      expectedWorkRevision: record.expected_work_revision,
      status: record.status,
      ...(record.runtime_execution_id ? { runtimeExecutionId: record.runtime_execution_id } : {}),
      ...(plan ? { plan } : {}),
      ...(record.checksum ? { checksum: record.checksum } : {}),
      ...(record.error_json
        ? { error: JSON.parse(record.error_json) as { readonly category: string; readonly causeId: string } }
        : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
