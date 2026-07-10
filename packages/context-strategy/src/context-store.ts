import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import type { WorkService } from "@massion/work";

import type {
  ContextEvent,
  ContextSource,
  ContextVersion,
  CreateContextInput,
  ExcludedContextSource,
} from "./contracts.js";
import { CONTEXT_STRATEGY_MIGRATION } from "./schema.js";

interface ContextVersionRecord {
  readonly context_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly project_id?: string;
  readonly version: number;
  readonly parent_context_version_id?: string;
  readonly package_json: string;
  readonly selected_sources_json: string;
  readonly excluded_sources_json: string;
  readonly token_budget: number;
  readonly token_total: number;
  readonly checksum: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface ContextEventRecord {
  readonly event_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly context_version_id?: string;
  readonly command_id: string;
  readonly event_type: ContextEvent["eventType"];
  readonly request_hash: string;
  readonly payload_json: string;
  readonly created_at: unknown;
}

interface ContextPackageData {
  readonly objective: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly decisions: readonly string[];
  readonly sources: readonly ContextSource[];
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

export function hashContextContent(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function hashRequest(input: CreateContextInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function sourceOrder(left: ContextSource, right: ContextSource): number {
  if (!left.mandatory && !right.mandatory && left.priority !== right.priority) return right.priority - left.priority;
  return left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId);
}

export class ContextBudgetBlockedError extends Error {
  public constructor(
    public readonly requiredTokens: number,
    public readonly availableTokens: number,
    public readonly sourceIds: readonly string[],
  ) {
    super(`필수 Context source가 token budget을 초과했습니다: ${String(requiredTokens)}/${String(availableTokens)}`);
    this.name = "ContextBudgetBlockedError";
  }
}

export class ContextStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly works: Pick<WorkService, "getWork">,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    works: Pick<WorkService, "getWork">,
  ): Promise<ContextStore> {
    await applyMigrations(database, [CONTEXT_STRATEGY_MIGRATION]);
    return new ContextStore(database, organizations, works);
  }

  public async create(context: TenantContext, input: CreateContextInput): Promise<ContextVersion> {
    await this.organizations.verifyTenantContext(context);
    const work = await this.works.getWork(context, input.workId);
    if (input.projectId && work.project_id && input.projectId !== work.project_id) {
      throw new Error("Context project가 Work project와 일치하지 않습니다");
    }
    this.validateInput(input);
    const requestHash = hashRequest(input);
    const compiled = this.compile(input.sources, input.tokenBudget);
    if (compiled instanceof ContextBudgetBlockedError) {
      await this.recordBudgetBlocked(context, input, requestHash, compiled);
      throw compiled;
    }
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestHash);
      if (repeated?.context_version_id) {
        return this.view(await this.find(tx, context.organizationId, repeated.context_version_id));
      }
      const [records] = await tx.query<[ContextVersionRecord[]]>(
        "SELECT * OMIT id FROM context_version WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const latest = records.reduce<ContextVersionRecord | undefined>(
        (candidate, record) => (!candidate || record.version > candidate.version ? record : candidate),
        undefined,
      );
      if (latest?.context_version_id !== input.expectedParentContextVersionId) {
        throw new Error("parent ContextVersion precondition이 일치하지 않습니다");
      }
      const packageData: ContextPackageData = {
        objective: input.objective.trim(),
        scopeIn: input.scopeIn,
        scopeOut: input.scopeOut,
        constraints: input.constraints,
        assumptions: input.assumptions,
        unknowns: input.unknowns,
        decisions: input.decisions,
        sources: input.sources,
      };
      const version = (latest?.version ?? 0) + 1;
      const contextVersionId = randomUUID();
      const checksum = hashContextContent({
        workId: input.workId,
        projectId: input.projectId,
        version,
        parentContextVersionId: input.expectedParentContextVersionId,
        package: packageData,
        selectedSources: compiled.selected,
        excludedSources: compiled.excluded,
        tokenBudget: input.tokenBudget,
        tokenTotal: compiled.tokenTotal,
      });
      const [created] = await tx.query<[ContextVersionRecord[]]>(
        "CREATE context_version CONTENT { context_version_id: $context_version_id, organization_id: $organization_id, work_id: $work_id, project_id: $project_id, version: $version, parent_context_version_id: $parent_context_version_id, package_json: $package_json, selected_sources_json: $selected_sources_json, excluded_sources_json: $excluded_sources_json, token_budget: $token_budget, token_total: $token_total, checksum: $checksum, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          context_version_id: contextVersionId,
          organization_id: context.organizationId,
          work_id: input.workId,
          project_id: input.projectId,
          version,
          parent_context_version_id: input.expectedParentContextVersionId,
          package_json: canonicalJson(packageData),
          selected_sources_json: canonicalJson(compiled.selected),
          excluded_sources_json: canonicalJson(compiled.excluded),
          token_budget: input.tokenBudget,
          token_total: compiled.tokenTotal,
          checksum,
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("ContextVersion 생성 결과가 없습니다");
      await this.insertEvent(tx, {
        eventId: randomUUID(),
        organizationId: context.organizationId,
        workId: input.workId,
        contextVersionId,
        commandId: input.commandId,
        eventType: "context_version_created",
        requestHash,
        payload: { version, checksum, selectedSourceCount: compiled.selected.length, tokenTotal: compiled.tokenTotal },
      });
      return this.view(await this.find(tx, context.organizationId, contextVersionId));
    });
  }

  public async get(context: TenantContext, contextVersionId: string): Promise<ContextVersion> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, contextVersionId));
  }

  public async listEvents(context: TenantContext, workId: string): Promise<ContextEvent[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ContextEventRecord[]]>(
      "SELECT * OMIT id FROM context_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId, work_id: workId },
    );
    return records.map((record) => ({
      eventId: record.event_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      ...(record.context_version_id ? { contextVersionId: record.context_version_id } : {}),
      commandId: record.command_id,
      eventType: record.event_type,
      requestHash: record.request_hash,
      payload: JSON.parse(record.payload_json) as unknown,
      createdAt: record.created_at,
    }));
  }

  private validateInput(input: CreateContextInput): void {
    if (!input.objective.trim()) throw new Error("Context objective는 비어 있을 수 없습니다");
    if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1)
      throw new Error("Context token budget은 1 이상의 정수여야 합니다");
    if (input.sources.length === 0) throw new Error("Context source가 필요합니다");
    const seen = new Set<string>();
    for (const source of input.sources) {
      if (!source.sourceId.trim() || !source.revision.trim())
        throw new Error("Context source ID와 revision이 필요합니다");
      if (seen.has(source.sourceId)) throw new Error(`Context source ID가 중복됐습니다: ${source.sourceId}`);
      seen.add(source.sourceId);
      if (!/^[a-f0-9]{64}$/u.test(source.contentHash))
        throw new Error("Context source content hash 형식이 잘못됐습니다");
      if (!Number.isFinite(Date.parse(source.observedAt))) throw new Error("Context source observedAt이 잘못됐습니다");
      if (!Number.isInteger(source.estimatedTokens) || source.estimatedTokens < 0)
        throw new Error("Context source estimatedTokens는 0 이상의 정수여야 합니다");
      if (!Number.isInteger(source.priority)) throw new Error("Context source priority는 정수여야 합니다");
      if (source.classification === "secret-ref" && source.content !== undefined)
        throw new Error("secret-ref Context source에는 원문 content를 저장할 수 없습니다");
      if (source.content !== undefined && hashContextContent(source.content) !== source.contentHash)
        throw new Error("Context source content hash가 일치하지 않습니다");
    }
  }

  private compile(
    sources: readonly ContextSource[],
    tokenBudget: number,
  ):
    | { readonly selected: ContextSource[]; readonly excluded: ExcludedContextSource[]; readonly tokenTotal: number }
    | ContextBudgetBlockedError {
    const mandatory = sources.filter((source) => source.mandatory).sort(sourceOrder);
    const requiredTokens = mandatory.reduce((total, source) => total + source.estimatedTokens, 0);
    if (requiredTokens > tokenBudget) {
      return new ContextBudgetBlockedError(
        requiredTokens,
        tokenBudget,
        mandatory.map((source) => source.sourceId),
      );
    }
    const selected = [...mandatory];
    const excluded: ExcludedContextSource[] = [];
    let tokenTotal = requiredTokens;
    for (const source of sources.filter((candidate) => !candidate.mandatory).sort(sourceOrder)) {
      if (tokenTotal + source.estimatedTokens <= tokenBudget) {
        selected.push(source);
        tokenTotal += source.estimatedTokens;
      } else {
        excluded.push({
          sourceId: source.sourceId,
          requiredTokens: source.estimatedTokens,
          reason: "token_budget",
        });
      }
    }
    return { selected, excluded, tokenTotal };
  }

  private async recordBudgetBlocked(
    context: TenantContext,
    input: CreateContextInput,
    requestHash: string,
    error: ContextBudgetBlockedError,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestHash);
      if (repeated) return;
      await this.insertEvent(tx, {
        eventId: randomUUID(),
        organizationId: context.organizationId,
        workId: input.workId,
        commandId: input.commandId,
        eventType: "context_budget_blocked",
        requestHash,
        payload: {
          requiredTokens: error.requiredTokens,
          availableTokens: error.availableTokens,
          sourceIds: error.sourceIds,
        },
      });
    });
  }

  private async repeated(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestHash: string,
  ): Promise<ContextEventRecord | undefined> {
    const [records] = await executor.query<[ContextEventRecord[]]>(
      "SELECT * OMIT id FROM context_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (records[0] && records[0].request_hash !== requestHash)
      throw new Error("같은 commandId에 다른 Context 요청을 사용할 수 없습니다");
    return records[0];
  }

  private async find(
    executor: QueryExecutor,
    organizationId: string,
    contextVersionId: string,
  ): Promise<ContextVersionRecord> {
    const [records] = await executor.query<[ContextVersionRecord[]]>(
      "SELECT * OMIT id FROM context_version WHERE organization_id = $organization_id AND context_version_id = $context_version_id LIMIT 1;",
      { organization_id: organizationId, context_version_id: contextVersionId },
    );
    if (!records[0]) throw new Error(`ContextVersion을 찾을 수 없습니다: ${contextVersionId}`);
    return records[0];
  }

  private async insertEvent(executor: QueryExecutor, event: Omit<ContextEvent, "createdAt">): Promise<void> {
    await executor.query(
      "CREATE context_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: $command_id, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, created_at: time::now() };",
      {
        event_id: event.eventId,
        organization_id: event.organizationId,
        work_id: event.workId,
        context_version_id: event.contextVersionId,
        command_id: event.commandId,
        event_type: event.eventType,
        request_hash: event.requestHash,
        payload_json: canonicalJson(event.payload),
      },
    );
  }

  private view(record: ContextVersionRecord): ContextVersion {
    let packageData: ContextPackageData;
    let selectedSources: ContextSource[];
    let excludedSources: ExcludedContextSource[];
    try {
      packageData = JSON.parse(record.package_json) as ContextPackageData;
      selectedSources = JSON.parse(record.selected_sources_json) as ContextSource[];
      excludedSources = JSON.parse(record.excluded_sources_json) as ExcludedContextSource[];
    } catch {
      throw new Error(`ContextVersion checksum 입력을 해석할 수 없습니다: ${record.context_version_id}`);
    }
    const checksum = hashContextContent({
      workId: record.work_id,
      projectId: record.project_id,
      version: record.version,
      parentContextVersionId: record.parent_context_version_id,
      package: packageData,
      selectedSources,
      excludedSources,
      tokenBudget: record.token_budget,
      tokenTotal: record.token_total,
    });
    if (checksum !== record.checksum) {
      throw new Error(`ContextVersion checksum이 일치하지 않습니다: ${record.context_version_id}`);
    }
    return {
      contextVersionId: record.context_version_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      ...(record.project_id ? { projectId: record.project_id } : {}),
      version: record.version,
      ...(record.parent_context_version_id ? { parentContextVersionId: record.parent_context_version_id } : {}),
      objective: packageData.objective,
      scopeIn: packageData.scopeIn,
      scopeOut: packageData.scopeOut,
      constraints: packageData.constraints,
      assumptions: packageData.assumptions,
      unknowns: packageData.unknowns,
      decisions: packageData.decisions,
      sources: packageData.sources,
      selectedSources,
      excludedSources,
      tokenBudget: record.token_budget,
      tokenTotal: record.token_total,
      checksum: record.checksum,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }
}
