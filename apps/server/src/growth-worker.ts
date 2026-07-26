import { redactSecrets } from "@massion/evidence";
import type { OrganizationService, TenantContext } from "@massion/identity";
import {
  GrowthGateway,
  GrowthTriggerStore,
  createReflectionSnapshot,
  growthChecksum,
  type GrowthTrigger,
  type ReflectionSnapshot,
  type ReflectionSourceReference,
  type SuggestionCandidate,
} from "@massion/growth";
import type { AgentExecutionResult, StructuredAgentRunner, StructuredOutputSpec } from "@massion/runtime";
import type { MassionDatabase } from "@massion/storage";

type Row = Record<string, unknown>;

const SOURCE_TABLES = {
  "work-record": "work_record",
  verification: "work_verification",
  assurance: "assurance_run",
  event: "work_event",
  artifact: "artifact_version",
} as const;

const reflectionOutput: StructuredOutputSpec = {
  name: "growth-reflection-candidates",
  description:
    "검증된 Work 기록에서 SuggestionCandidate 배열만 반환합니다. 각 후보는 targetKind·operation·patch·summary·rationale·expectedEffect·riskSummary·sourceReferenceIds 필드를 반드시 가져야 합니다. operation은 prompt=replace-instruction, memory=add-entry, policy=replace-policy, organization=change-node 중 하나이며 일반 회고 문서나 임의 operation은 반환하지 않습니다.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "targetKind",
            "operation",
            "patch",
            "summary",
            "rationale",
            "expectedEffect",
            "riskSummary",
            "sourceReferenceIds",
          ],
          properties: {
            targetKind: { type: "string", enum: ["prompt", "memory", "policy", "organization"] },
            operation: {
              type: "string",
              enum: ["replace-instruction", "add-entry", "replace-policy", "change-node"],
            },
            patch: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "targetKind별 patch 키는 prompt replace-instruction={agentHandle,instruction}, memory add-entry={kind,key,value}, policy replace-policy={policyId,policyText}, organization change-node={handle,responsibility}입니다.",
            },
            summary: { type: "string", minLength: 1, maxLength: 2_000 },
            rationale: { type: "string", minLength: 1, maxLength: 2_000 },
            expectedEffect: { type: "string", minLength: 1, maxLength: 2_000 },
            riskSummary: { type: "string", minLength: 1, maxLength: 2_000 },
            sourceReferenceIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          },
        },
      },
    },
    required: ["candidates"],
  },
  validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { success: false, error: new Error("Growth Reflection 출력은 object여야 합니다") };
    const candidates = (value as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length > 100)
      return { success: false, error: new Error("Growth Reflection candidates가 유효하지 않습니다") };
    return { success: true, value };
  },
};

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Growth source row가 유효하지 않습니다");
  return value as Row;
}

function rowRevision(value: Row): string {
  const revision = value.version ?? value.sequence ?? value.created_at ?? "1";
  return String(revision);
}

function safeExcerpt(value: Row): string {
  const raw = JSON.stringify(value);
  return redactSecrets(raw).content.slice(0, 4_096);
}

function source(kind: ReflectionSourceReference["kind"], value: Row, referenceId: string): ReflectionSourceReference {
  return {
    kind,
    referenceId,
    organizationId: String(value.organization_id),
    workId: String(value.work_id),
    checksum: growthChecksum(value),
    capturedRevision: rowRevision(value),
    excerpt: safeExcerpt(value),
  };
}

function outputCandidates(result: AgentExecutionResult): readonly SuggestionCandidate[] {
  if (result.status !== "succeeded") throw new Error(`Growth Reflection 실행이 종료되지 않았습니다: ${result.status}`);
  const value = result.output;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Growth Reflection 출력이 object가 아닙니다");
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("Growth Reflection candidates가 없습니다");
  return candidates as SuggestionCandidate[];
}

export interface GrowthWorkerResult {
  readonly outcome: "claimed" | "none" | "busy";
  readonly trigger?: GrowthTrigger;
  readonly suggestions?: number;
}

export interface GrowthWorkerDependencies {
  readonly database: MassionDatabase;
  readonly organizations: OrganizationService;
  readonly triggers: GrowthTriggerStore;
  readonly gateway: GrowthGateway;
  readonly runner: StructuredAgentRunner;
  readonly intervalMs?: number;
}

export class GrowthWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<GrowthWorkerResult> | undefined;
  private closed = false;

  public constructor(private readonly dependencies: GrowthWorkerDependencies) {}

  public start(context: TenantContext): void {
    if (this.timer || this.closed) return;
    const intervalMs = Math.max(5_000, this.dependencies.intervalMs ?? 30_000);
    this.timer = setInterval(() => this.schedule(context), intervalMs);
    this.schedule(context);
  }

  public async tick(context: TenantContext): Promise<GrowthWorkerResult> {
    if (this.running) return { outcome: "busy" };
    this.running = this.run(context);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(context: TenantContext): void {
    // ponytail: 실패는 Reflection/trigger에 기록하고 daemon process까지 전파하지 않습니다.
    void this.tick(context).catch(() => undefined);
  }

  private async run(context: TenantContext): Promise<GrowthWorkerResult> {
    await this.dependencies.triggers.requeueExpired(context);
    await this.dependencies.triggers.backfill(context);
    const claimed = await this.dependencies.triggers.claim(context, { workerId: "growth-worker", leaseMs: 120_000 });
    if (claimed.outcome !== "claimed") return { outcome: "none" };
    const snapshot = await this.snapshot(context, claimed.trigger);
    const result = await this.dependencies.gateway.reflect(context, {
      commandId: `${claimed.trigger.trigger_id}:reflection`,
      trigger: claimed.trigger,
      snapshot,
    });
    return { outcome: "claimed", trigger: claimed.trigger, suggestions: result.suggestions.length };
  }

  private async snapshot(context: TenantContext, trigger: GrowthTrigger): Promise<ReflectionSnapshot> {
    const [recordRows] = await this.dependencies.database.query<[Row[]]>(
      "SELECT * FROM work_record WHERE organization_id = $organization_id AND work_record_id = $work_record_id LIMIT 1;",
      { organization_id: context.organizationId, work_record_id: trigger.work_record_id },
    );
    const [verificationRows] = await this.dependencies.database.query<[Row[]]>(
      "SELECT * FROM work_verification WHERE organization_id = $organization_id AND verification_id = $verification_id LIMIT 1;",
      { organization_id: context.organizationId, verification_id: trigger.verification_id },
    );
    const [assuranceRows] = await this.dependencies.database.query<[Row[]]>(
      "SELECT * FROM assurance_run WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: context.organizationId, assurance_run_id: trigger.assurance_run_id },
    );
    const record = recordRows[0] ? row(recordRows[0]) : undefined;
    const verification = verificationRows[0] ? row(verificationRows[0]) : undefined;
    const assurance = assuranceRows[0] ? row(assuranceRows[0]) : undefined;
    if (!record || !verification || !assurance) throw new Error("Growth Reflection에 필요한 완료 기록이 없습니다");

    const sources: ReflectionSourceReference[] = [
      source("work-record", record, trigger.work_record_id),
      source("verification", verification, trigger.verification_id),
      source("assurance", assurance, trigger.assurance_run_id),
    ];
    const [events] = await this.dependencies.database.query<[Row[]]>(
      "SELECT * FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC LIMIT 20;",
      { organization_id: context.organizationId, work_id: trigger.work_id },
    );
    for (const event of events.map(row)) sources.push(source("event", event, String(event.event_id)));
    const artifactIds = Array.isArray(record.artifact_version_ids) ? record.artifact_version_ids.map(String) : [];
    if (artifactIds.length > 0) {
      const [artifacts] = await this.dependencies.database.query<[Row[]]>(
        "SELECT * FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $artifact_ids LIMIT 20;",
        { organization_id: context.organizationId, work_id: trigger.work_id, artifact_ids: artifactIds.slice(0, 20) },
      );
      for (const artifact of artifacts.map(row)) sources.push(source("artifact", artifact, String(artifact.artifact_version_id)));
    }
    const [[promptRows], [memoryRows], [organizationRows]] = await Promise.all([
      this.dependencies.database.query<[Row[]]>(
        "SELECT prompt_definition_version_id, checksum FROM prompt_definition_version WHERE organization_id = $organization_id AND status = 'active';",
        { organization_id: context.organizationId },
      ),
      this.dependencies.database.query<[Row[]]>(
        "SELECT memory_version_id, checksum FROM memory_version WHERE organization_id = $organization_id AND status = 'active';",
        { organization_id: context.organizationId },
      ),
      this.dependencies.database.query<[Row[]]>(
        "SELECT version_id, version, before_json, after_json FROM organization_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
        { organization_id: context.organizationId },
      ),
    ]);
    const activeVersions = [
      ...promptRows.map((item) => ({ kind: "prompt" as const, versionId: String(item.prompt_definition_version_id), checksum: String(item.checksum) })),
      ...memoryRows.map((item) => ({ kind: "memory" as const, versionId: String(item.memory_version_id), checksum: String(item.checksum) })),
      ...organizationRows.map((item) => ({
        kind: "organization" as const,
        versionId: String(item.version_id),
        checksum: growthChecksum({ version: item.version, before: item.before_json, after: item.after_json }),
      })),
    ];
    return createReflectionSnapshot({
      organizationId: context.organizationId,
      workId: trigger.work_id,
      recordsRunId: trigger.records_run_id,
      workRecordId: trigger.work_record_id,
      verificationId: trigger.verification_id,
      assuranceRunId: trigger.assurance_run_id,
      configurationVersionId: trigger.configuration_version_id ?? "unresolved",
      activeVersions,
      sources: sources.slice(0, 100),
    });
  }
}

export function createGrowthReflectionAdapters(
  database: MassionDatabase,
  organizations: OrganizationService,
  runner: StructuredAgentRunner,
) {
  return {
    async generate(context: TenantContext, input: { reflectionRunId: string; snapshot: ReflectionSnapshot }) {
      const result = await runner.executeStructured(
        context,
        {
          commandId: `${input.reflectionRunId}:runtime`,
          workId: input.snapshot.material.workId,
          agentHandle: "growth",
          modelRoute: "planning-quality",
          correlationId: input.snapshot.material.recordsRunId,
          estimatedTokens: 8_000,
          estimatedCostMicros: 0,
          input: {
            reflectionSnapshotHash: input.snapshot.hash,
            sources: input.snapshot.material.sources.map(({ excerpt, ...metadata }) => ({ ...metadata, excerpt })),
          },
        },
        reflectionOutput,
      );
      return { runtimeExecutionId: result.executionId, candidates: outputCandidates(result) };
    },
    async verifySource(context: TenantContext, reference: ReflectionSourceReference) {
      const table = SOURCE_TABLES[reference.kind as keyof typeof SOURCE_TABLES];
      if (!table) throw new Error(`Growth source kind을 검증할 수 없습니다: ${reference.kind}`);
      const field =
        reference.kind === "work-record"
          ? "work_record_id"
          : reference.kind === "verification"
            ? "verification_id"
            : reference.kind === "assurance"
              ? "assurance_run_id"
              : reference.kind === "artifact"
                ? "artifact_version_id"
                : "event_id";
      const [rows] = await database.query<[Row[]]>(
        `SELECT * FROM ${table} WHERE organization_id = $organization_id AND ${field} = $reference_id LIMIT 1;`,
        { organization_id: context.organizationId, reference_id: reference.referenceId },
      );
      const current = rows[0] ? row(rows[0]) : undefined;
      if (!current) throw new Error("Growth source를 찾을 수 없습니다");
      return {
        checksum: growthChecksum(current),
        capturedRevision: rowRevision(current),
        fresh: true,
      };
    },
    async verifyRuntime(context: TenantContext, input: { workId: string; runtimeExecutionId: string }) {
      const [rows] = await database.query<[Array<{ organization_id: string; work_id: string; agent_handle: string; status: string }>]>(
        "SELECT organization_id, work_id, agent_handle, status FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
        { organization_id: context.organizationId, execution_id: input.runtimeExecutionId },
      );
      const execution = rows[0];
      if (!execution || execution.work_id !== input.workId || execution.agent_handle !== "growth" || execution.status !== "succeeded")
        throw new Error("Growth Runtime Execution 검증에 실패했습니다");
    },
  };
}
