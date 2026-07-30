import { redactSecrets } from "@massion/evidence";
import {
  metricObservationChecksum,
  type MetricObservationReader,
  type MetricObservationStore,
} from "@massion/assurance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import {
  GrowthGateway,
  GrowthEvaluationIntegrityError,
  GrowthTriggerStore,
  createReflectionSnapshot,
  growthChecksum,
  growthTargetChecksum,
  validateSuggestionCandidate,
  type GrowthTrigger,
  type ReflectionSnapshot,
  type ReflectionSourceReference,
  type SuggestionCandidate,
  type GrowthSignalReceiptInput,
  type GrowthSuggestionDetails,
  type GrowthSuggestionRecord,
  type GrowthEffectSample,
  type ReflectionRunRecord,
} from "@massion/growth";
import type { AgentExecutionResult, StructuredAgentRunner, StructuredOutputSpec } from "@massion/runtime";
import type { MassionDatabase } from "@massion/storage";

export const GROWTH_EFFECT_METRIC_SOURCE_ID = "massion.growth.assurance-pass-rate.v1";

interface GrowthEffectMetricArtifact {
  readonly checksum: string;
}

interface GrowthEffectMetricVerification {
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly passed: boolean;
}

interface GrowthEffectMetricRun {
  readonly assurance_run_id: string;
  readonly status: "passed" | "failed";
  readonly completed_at: unknown;
}

function metricIsoDateTime(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw || !Number.isFinite(new Date(raw).getTime()))
    throw new Error("Growth Metric completedAt가 유효하지 않습니다");
  return new Date(raw).toISOString();
}

/** 서버가 terminal Assurance와 검증 artifact를 재조회해 만드는 단일 v1 효과 지표입니다. */
export function createGrowthEffectMetricReader(): MetricObservationReader {
  return {
    async observe(executor, input) {
      if (input.producer.kind !== "system_adapter" || input.producer.id !== GROWTH_EFFECT_METRIC_SOURCE_ID)
        throw new Error("Growth effect metric adapter가 아닙니다");
      if (input.source.kind !== "artifact_version")
        throw new Error("Growth effect metric source는 검증 artifact여야 합니다");
      const [[artifacts], [verifications]] = await Promise.all([
        executor.query<[GrowthEffectMetricArtifact[]]>(
          "SELECT checksum FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id LIMIT 1;",
          {
            organization_id: input.organizationId,
            work_id: input.workId,
            artifact_version_id: input.source.id,
          },
        ),
        executor.query<[GrowthEffectMetricVerification[]]>(
          "SELECT verification_id, assurance_run_id, passed FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id AND evidence_artifact_version_id = $artifact_version_id LIMIT 1;",
          {
            organization_id: input.organizationId,
            work_id: input.workId,
            artifact_version_id: input.source.id,
          },
        ),
      ]);
      const artifact = artifacts[0];
      const verification = verifications[0];
      if (!artifact || !verification) throw new Error("Growth effect metric의 artifact·verification 계보가 없습니다");
      const [runs] = await executor.query<[GrowthEffectMetricRun[]]>(
        "SELECT assurance_run_id, status, completed_at FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND status IN ['passed', 'failed'] LIMIT 1;",
        {
          organization_id: input.organizationId,
          work_id: input.workId,
          assurance_run_id: verification.assurance_run_id,
        },
      );
      const run = runs[0];
      if (!run || verification.passed !== (run.status === "passed"))
        throw new Error("Growth effect metric의 terminal Assurance verdict가 verification과 다릅니다");
      const measuredAt = metricIsoDateTime(run.completed_at);
      const value = run.status === "passed" ? 1 : 0;
      const unit = "ratio";
      return {
        value,
        unit,
        measuredAt,
        sourceChecksum: artifact.checksum,
        checksum: metricObservationChecksum({ ...input, value, unit, measuredAt, sourceChecksum: artifact.checksum }),
      };
    },
  };
}

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
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Growth source row가 유효하지 않습니다");
  return value as Row;
}

function rowRevision(value: Row): string {
  const revision = value.version ?? value.sequence ?? value.created_at ?? "1";
  // Row = Record<string, unknown>이라 타입상 object 가능성이 남지만, 실제 스키마는
  // version/sequence: int, created_at: datetime이며 SurrealDB 드라이버는 이 값들을
  // 원시값 또는 자체 toString(ISO 8601)을 가진 값으로 내려줍니다(plain object 아님).
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
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
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Growth Reflection 출력이 object가 아닙니다");
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
  readonly metricObservations?: Pick<MetricObservationStore, "record">;
  readonly intervalMs?: number;
}

interface EffectAdoptionRow {
  readonly adoption_id: string;
  readonly suggestion_id: string;
  readonly target_kind: "prompt" | "memory" | "policy" | "organization";
  readonly evaluation_run_id: string;
  readonly before_version_id: string;
  readonly after_version_id?: string;
  readonly status: "observing";
}

interface EffectBaselineRow {
  readonly baseline_id: string;
  readonly status: "pending" | "captured" | "closed";
}

interface EffectRunRow {
  readonly assurance_run_id: string;
  readonly work_id: string;
  readonly status: "passed" | "failed";
  readonly profile_id: string;
  readonly profile_version: string;
  readonly completed_at: unknown;
}

interface EffectWorkRow {
  readonly prompt_version_id?: string;
  readonly policy_version_id?: string;
  readonly organization_version_id?: string;
}

interface EffectPromptRow {
  readonly prompt_definition_version_id: string;
  readonly memory_version_ids: readonly string[];
}

interface EffectVerificationRow {
  readonly verification_id: string;
  readonly evidence_artifact_version_id: string;
}

interface EffectStrategyRow {
  readonly strategy_version_id: string;
}

interface OrphanSourceReferenceRow {
  readonly organization_id: string;
  readonly work_id: string;
  readonly suggestion_id: string;
  readonly source_kind: ReflectionSourceReference["kind"];
  readonly source_id: string;
  readonly source_checksum: string;
  readonly captured_revision: string;
}

interface OrphanConfigurationRow {
  readonly configuration_version_id: string;
  readonly status: "active" | "superseded";
}

class GrowthOrphanValidationError extends Error {}

export class GrowthWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<GrowthWorkerResult> | undefined;
  private closed = false;

  public constructor(private readonly dependencies: GrowthWorkerDependencies) {}

  public start(context: TenantContext): void {
    if (this.timer || this.closed) return;
    const intervalMs = Math.max(5_000, this.dependencies.intervalMs ?? 30_000);
    this.timer = setInterval(() => {
      this.schedule(context);
    }, intervalMs);
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
    try {
      await this.processEffects(context);
    } catch {
      // 효과 목록 조회 자체가 실패해도 독립적인 orphan/trigger 단계는 계속 진행합니다.
    }
    try {
      await this.resumeOrphanSuggestions(context);
    } catch {
      // orphan 목록 조회 자체가 실패해도 새 trigger 처리는 계속 진행합니다.
    }
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
    await this.evaluateAndAdopt(context, claimed.trigger, snapshot, result.suggestions);
    return { outcome: "claimed", trigger: claimed.trigger, suggestions: result.suggestions.length };
  }

  private async resumeOrphanSuggestions(context: TenantContext): Promise<void> {
    const suggestions = await this.dependencies.gateway.listSuggestions(context, {
      status: ["proposed", "evaluated"],
      recoverableOnly: true,
      oldestFirst: true,
      limit: 20,
    });
    for (const suggestion of suggestions) {
      if (suggestion.status !== "proposed" && suggestion.status !== "evaluated") continue;
      try {
        const detail = await this.dependencies.gateway.getSuggestionDetails(context, suggestion.suggestion_id);
        if (detail.suggestion.suggestion_id !== suggestion.suggestion_id) {
          throw new GrowthOrphanValidationError("Growth Suggestion 상세 계보가 일치하지 않습니다");
        }
        if (detail.suggestion.status !== "proposed" && detail.suggestion.status !== "evaluated") continue;
        await this.resumeOrphanSuggestion(context, detail);
      } catch (error) {
        const reason =
          error instanceof GrowthOrphanValidationError
            ? error.message
            : error instanceof GrowthEvaluationIntegrityError
              ? "저장된 Growth evaluation 계보가 유효하지 않습니다"
              : error instanceof SyntaxError
                ? "Growth Suggestion 상세 JSON이 유효하지 않습니다"
                : undefined;
        if (!reason) continue;
        try {
          await this.dependencies.gateway.quarantine(context, {
            commandId: `growth:${suggestion.suggestion_id}:orphan-quarantine`,
            suggestionId: suggestion.suggestion_id,
            expectedRevision: suggestion.revision,
            reason: `자동 복구 격리: ${reason}`.slice(0, 1_000),
          });
        } catch {
          // 다른 worker가 먼저 수렴했거나 저장소가 일시 실패해도 다음 후보를 계속 처리합니다.
        }
      }
    }
  }

  private async resumeOrphanSuggestion(context: TenantContext, detail: GrowthSuggestionDetails): Promise<void> {
    const { suggestion } = detail;
    const { trigger, snapshot } = await this.orphanLineage(context, suggestion);
    if (suggestion.status === "proposed") {
      const outcome = await this.evaluateAndAdoptSuggestion(context, trigger, snapshot, suggestion, true);
      if (outcome !== "eligible") throw new GrowthOrphanValidationError(`저장된 평가 결과가 ${outcome}입니다`);
      return;
    }
    const evaluation = detail.evaluation;
    if (
      !evaluation ||
      evaluation.organizationId !== context.organizationId ||
      evaluation.suggestionId !== suggestion.suggestion_id
    ) {
      throw new GrowthOrphanValidationError("eligible Evaluation 계보가 없습니다");
    }
    if (evaluation.outcome !== "eligible") {
      throw new GrowthOrphanValidationError(`저장된 평가 결과가 ${evaluation.outcome}입니다`);
    }
    const candidate = this.validatedSuggestionCandidate(suggestion, snapshot);
    const patch = candidate.patch;
    const receiptIds = new Set(evaluation.receiptIds);
    if (
      receiptIds.size !== evaluation.receiptIds.length ||
      evaluation.signals.length !== receiptIds.size ||
      evaluation.signals.some(
        (signal) =>
          !receiptIds.has(signal.receiptId) ||
          signal.organizationId !== context.organizationId ||
          signal.suggestionId !== suggestion.suggestion_id,
      )
    ) {
      throw new GrowthOrphanValidationError("저장된 Evaluation receipt 집합이 유효하지 않습니다");
    }
    const requiredSignal = (signalId: "lineage" | "target" | "candidate") => {
      const signals = evaluation.signals.filter(
        (signal) =>
          signal.signalId === signalId && signal.group === "required" && signal.outcome === "passed" && signal.fresh,
      );
      if (signals.length !== 1) throw new GrowthOrphanValidationError(`저장된 ${signalId} signal이 유효하지 않습니다`);
      return signals[0];
    };
    const lineageSignal = requiredSignal("lineage");
    const targetSignal = requiredSignal("target");
    const candidateSignal = requiredSignal("candidate");
    const hasWorkerSignalLineage = (
      signal: (typeof evaluation.signals)[number] | undefined,
      signalId: "lineage" | "target" | "candidate" | "assurance",
    ) =>
      signal?.commandId === `growth:${suggestion.suggestion_id}:signal:${signalId}` &&
      signal.adapterId === `growth-worker:${trigger.trigger_id}` &&
      signal.adapterVersion === "1";
    const assuranceSignals = evaluation.signals.filter(
      (signal) =>
        signal.signalId === "assurance" &&
        signal.group === "supporting" &&
        signal.origin === "independent" &&
        signal.outcome === "passed" &&
        signal.fresh,
    );
    const assurance = snapshot.material.sources.find(
      (source) => source.kind === "assurance" && source.referenceId === trigger.assurance_run_id,
    );
    if (
      !hasWorkerSignalLineage(lineageSignal, "lineage") ||
      !hasWorkerSignalLineage(targetSignal, "target") ||
      !hasWorkerSignalLineage(candidateSignal, "candidate") ||
      !hasWorkerSignalLineage(assuranceSignals[0], "assurance") ||
      lineageSignal?.sourceId !== trigger.records_run_id ||
      lineageSignal.sourceChecksum !== snapshot.hash ||
      candidateSignal?.sourceId !== suggestion.suggestion_id ||
      candidateSignal.sourceChecksum !== growthChecksum(candidate) ||
      !assurance ||
      assuranceSignals.length !== 1 ||
      assuranceSignals[0]?.sourceId !== assurance.referenceId ||
      assuranceSignals[0].sourceChecksum !== assurance.checksum
    ) {
      throw new GrowthOrphanValidationError("저장된 Evaluation source 계보가 유효하지 않습니다");
    }
    const target = await this.dependencies.gateway.inspectTarget(context, {
      targetKind: suggestion.target_kind,
      suggestionId: suggestion.suggestion_id,
      patch,
    });
    await this.assertOrphanTarget(snapshot, suggestion, target);
    if (targetSignal?.sourceId !== target.versionId || targetSignal.sourceChecksum !== target.checksum) {
      throw new GrowthOrphanValidationError("저장된 평가 뒤 Growth target이 변경됐습니다");
    }
    await this.dependencies.gateway.adopt(context, {
      commandId: `growth:${suggestion.suggestion_id}:adopt`,
      suggestionId: suggestion.suggestion_id,
      suggestionRevision: suggestion.revision,
      evaluationRunId: evaluation.evaluationRunId,
      expectedEvaluationInputHash: evaluation.inputHash,
      expectedTargetChecksum: targetSignal.sourceChecksum,
    });
  }

  private async orphanLineage(
    context: TenantContext,
    suggestion: GrowthSuggestionRecord,
  ): Promise<{ readonly trigger: GrowthTrigger; readonly snapshot: ReflectionSnapshot }> {
    if (suggestion.organization_id !== context.organizationId) {
      throw new GrowthOrphanValidationError("Suggestion 조직 계보가 일치하지 않습니다");
    }
    const [reflections] = await this.dependencies.database.query<[ReflectionRunRecord[]]>(
      "SELECT * FROM reflection_run WHERE organization_id = $organization_id AND reflection_run_id = $reflection_run_id LIMIT 1;",
      { organization_id: context.organizationId, reflection_run_id: suggestion.reflection_run_id },
    );
    const reflection = reflections[0];
    if (
      !reflection ||
      reflection.organization_id !== context.organizationId ||
      reflection.status !== "completed" ||
      reflection.work_id !== suggestion.work_id
    ) {
      throw new GrowthOrphanValidationError("terminal completed Reflection 계보가 없습니다");
    }
    const [triggers] = await this.dependencies.database.query<[GrowthTrigger[]]>(
      "SELECT * FROM growth_trigger WHERE organization_id = $organization_id AND trigger_id = $trigger_id LIMIT 1;",
      { organization_id: context.organizationId, trigger_id: reflection.trigger_id },
    );
    const trigger = triggers[0];
    if (
      !trigger ||
      trigger.organization_id !== context.organizationId ||
      trigger.status !== "completed" ||
      trigger.work_id !== reflection.work_id ||
      trigger.records_run_id !== reflection.records_run_id ||
      trigger.configuration_version_id !== reflection.configuration_version_id
    ) {
      throw new GrowthOrphanValidationError("completed Growth trigger 계보가 없습니다");
    }
    const [configurations] = await this.dependencies.database.query<[OrphanConfigurationRow[]]>(
      "SELECT configuration_version_id, status FROM growth_configuration_version WHERE organization_id = $organization_id AND configuration_version_id = $configuration_version_id LIMIT 1;",
      {
        organization_id: context.organizationId,
        configuration_version_id: trigger.configuration_version_id,
      },
    );
    const configuration = configurations[0];
    if (
      !configuration ||
      configuration.configuration_version_id !== trigger.configuration_version_id ||
      configuration.status !== "active"
    ) {
      throw new GrowthOrphanValidationError("Growth configuration version이 active가 아닙니다");
    }
    const snapshot = await this.snapshot(context, trigger);
    if (snapshot.hash !== reflection.snapshot_hash) {
      throw new GrowthOrphanValidationError("Reflection snapshot source가 변경됐습니다");
    }
    if (
      !snapshot.material.sources.some(
        (source) => source.kind === "assurance" && source.referenceId === trigger.assurance_run_id,
      )
    ) {
      throw new GrowthOrphanValidationError("Growth 평가에 필요한 Assurance source가 없습니다");
    }
    const [storedSources] = await this.dependencies.database.query<[OrphanSourceReferenceRow[]]>(
      "SELECT organization_id, work_id, suggestion_id, source_kind, source_id, source_checksum, captured_revision FROM growth_source_reference WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id ORDER BY source_id ASC;",
      { organization_id: context.organizationId, suggestion_id: suggestion.suggestion_id },
    );
    const sourceIds = new Set(suggestion.source_reference_ids);
    if (sourceIds.size !== suggestion.source_reference_ids.length || storedSources.length !== sourceIds.size) {
      throw new GrowthOrphanValidationError("Suggestion source reference 집합이 일치하지 않습니다");
    }
    for (const sourceId of sourceIds) {
      const snapshotSource = snapshot.material.sources.find((source) => source.referenceId === sourceId);
      const stored = storedSources.find((source) => source.source_id === sourceId);
      if (
        !snapshotSource ||
        !stored ||
        stored.organization_id !== context.organizationId ||
        stored.work_id !== suggestion.work_id ||
        stored.suggestion_id !== suggestion.suggestion_id ||
        stored.source_kind !== snapshotSource.kind ||
        stored.source_checksum !== snapshotSource.checksum ||
        stored.captured_revision !== snapshotSource.capturedRevision
      ) {
        throw new GrowthOrphanValidationError("Suggestion source 계보가 변경됐습니다");
      }
    }
    return { trigger, snapshot };
  }

  private async evaluateAndAdopt(
    context: TenantContext,
    trigger: GrowthTrigger,
    snapshot: ReflectionSnapshot,
    suggestions: readonly GrowthSuggestionRecord[],
  ): Promise<void> {
    for (const suggestion of suggestions) {
      await this.evaluateAndAdoptSuggestion(context, trigger, snapshot, suggestion);
    }
  }

  private async evaluateAndAdoptSuggestion(
    context: TenantContext,
    trigger: GrowthTrigger,
    snapshot: ReflectionSnapshot,
    suggestion: GrowthSuggestionRecord,
    verifySnapshotTarget = false,
  ): Promise<"eligible" | "ineligible" | "blocked"> {
    const candidate = this.validatedSuggestionCandidate(suggestion, snapshot);
    const patch = candidate.patch;
    const assurance = snapshot.material.sources.find((candidate) => candidate.referenceId === trigger.assurance_run_id);
    if (!assurance) throw new Error("Growth 평가에 필요한 Assurance source가 없습니다");
    const target = await this.dependencies.gateway.inspectTarget(context, {
      targetKind: suggestion.target_kind,
      suggestionId: suggestion.suggestion_id,
      patch,
    });
    if (verifySnapshotTarget) await this.assertOrphanTarget(snapshot, suggestion, target);
    const explicitMemory = await this.explicitMemoryConflict(context, suggestion, patch);
    const signals: GrowthSignalReceiptInput[] = [
      this.signal(trigger, suggestion, {
        signalId: "lineage",
        group: "required",
        origin: "deterministic",
        sourceId: trigger.records_run_id,
        sourceChecksum: snapshot.hash,
        evidence: { recordsRunId: trigger.records_run_id, snapshotHash: snapshot.hash },
      }),
      this.signal(trigger, suggestion, {
        signalId: "target",
        group: "required",
        origin: "deterministic",
        sourceId: target.versionId,
        sourceChecksum: target.checksum,
        evidence: { targetKind: target.targetKind, versionId: target.versionId, revision: target.revision },
      }),
      this.signal(trigger, suggestion, {
        signalId: "candidate",
        group: "required",
        origin: "deterministic",
        sourceId: suggestion.suggestion_id,
        sourceChecksum: growthChecksum(candidate),
        evidence: { operation: suggestion.operation, targetKind: suggestion.target_kind },
      }),
      this.signal(trigger, suggestion, {
        signalId: "self",
        group: "supporting",
        origin: "model-self",
        sourceId: suggestion.reflection_run_id,
        sourceChecksum: growthChecksum({
          rationale: suggestion.rationale,
          expectedEffect: suggestion.expected_effect,
        }),
        evidence: { reflectionRunId: suggestion.reflection_run_id },
      }),
      this.signal(trigger, suggestion, {
        signalId: "assurance",
        group: "supporting",
        origin: "independent",
        sourceId: assurance.referenceId,
        sourceChecksum: assurance.checksum,
        evidence: { sourceKind: assurance.kind, capturedRevision: assurance.capturedRevision },
      }),
    ];
    if (explicitMemory) {
      signals.push(
        this.signal(trigger, suggestion, {
          signalId: "explicit-memory-conflict",
          group: "conflict",
          origin: "deterministic",
          sourceId: explicitMemory.memory_version_id,
          sourceChecksum: explicitMemory.checksum,
          evidence: { key: patch.key, memoryVersionId: explicitMemory.memory_version_id },
        }),
      );
    }
    const receipts = [];
    for (const signal of signals) receipts.push(await this.dependencies.gateway.recordSignal(context, signal));
    const evaluation = await this.dependencies.gateway.evaluate(context, {
      commandId: `growth:${suggestion.suggestion_id}:evaluate`,
      suggestionId: suggestion.suggestion_id,
      receiptIds: receipts.map((receipt) => receipt.receiptId),
    });
    if (evaluation.outcome !== "eligible") return evaluation.outcome;
    await this.dependencies.gateway.adopt(context, {
      commandId: `growth:${suggestion.suggestion_id}:adopt`,
      suggestionId: suggestion.suggestion_id,
      suggestionRevision: suggestion.revision,
      evaluationRunId: evaluation.evaluationRunId,
      expectedEvaluationInputHash: evaluation.inputHash,
      expectedTargetChecksum: target.checksum,
    });
    return evaluation.outcome;
  }

  private suggestionPatch(suggestion: GrowthSuggestionRecord): Readonly<Record<string, unknown>> {
    try {
      const patch = JSON.parse(suggestion.patch_json) as unknown;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("object가 아닙니다");
      }
      return patch as Readonly<Record<string, unknown>>;
    } catch {
      throw new GrowthOrphanValidationError("Suggestion patch JSON이 유효하지 않습니다");
    }
  }

  private validatedSuggestionCandidate(
    suggestion: GrowthSuggestionRecord,
    snapshot: ReflectionSnapshot,
  ): SuggestionCandidate {
    const candidate = {
      targetKind: suggestion.target_kind,
      operation: suggestion.operation,
      patch: this.suggestionPatch(suggestion),
      summary: suggestion.summary,
      rationale: suggestion.rationale,
      expectedEffect: suggestion.expected_effect,
      riskSummary: suggestion.risk_summary,
      sourceReferenceIds: suggestion.source_reference_ids,
    } satisfies SuggestionCandidate;
    try {
      return validateSuggestionCandidate(candidate, snapshot);
    } catch (error) {
      if (error instanceof GrowthOrphanValidationError) throw error;
      throw new GrowthOrphanValidationError(
        error instanceof Error ? error.message : "Growth Suggestion domain 검증에 실패했습니다",
      );
    }
  }

  private async assertOrphanTarget(
    snapshot: ReflectionSnapshot,
    suggestion: GrowthSuggestionRecord,
    target: { readonly versionId: string; readonly checksum: string },
  ): Promise<void> {
    if (suggestion.target_kind === "organization") {
      const version = snapshot.material.activeVersions.find((candidate) => candidate.kind === "organization");
      if (!version || version.versionId !== target.versionId)
        throw new GrowthOrphanValidationError("Reflection 뒤 Growth target이 변경됐습니다");
      const [rows] = await this.dependencies.database.query<[Array<{ readonly after_json: string }>]>(
        "SELECT after_json FROM organization_version WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
        { organization_id: snapshot.material.organizationId, version_id: version.versionId },
      );
      const nodes = rows[0] ? (JSON.parse(rows[0].after_json) as unknown) : undefined;
      if (!Array.isArray(nodes) || growthTargetChecksum({ versionId: version.versionId, nodes }) !== target.checksum) {
        throw new GrowthOrphanValidationError("Reflection 뒤 Growth target이 변경됐습니다");
      }
      return;
    }
    if (
      !snapshot.material.activeVersions.some(
        (version) =>
          version.kind === suggestion.target_kind &&
          version.versionId === target.versionId &&
          version.checksum === target.checksum,
      )
    ) {
      throw new GrowthOrphanValidationError("Reflection 뒤 Growth target이 변경됐습니다");
    }
  }

  private async processEffects(context: TenantContext): Promise<void> {
    const metricObservations = this.dependencies.metricObservations;
    if (!metricObservations) return;
    const [adoptions] = await this.dependencies.database.query<[EffectAdoptionRow[]]>(
      "SELECT adoption_id, suggestion_id, target_kind, evaluation_run_id, before_version_id, after_version_id, status, updated_at FROM growth_adoption_run WHERE organization_id = $organization_id AND status = 'observing' AND after_version_id != NONE ORDER BY updated_at ASC LIMIT 20;",
      { organization_id: context.organizationId },
    );
    for (const adoption of adoptions) {
      try {
        await this.processEffect(context, adoption);
      } catch {
        // 한 effect 후보의 계보/저장소 오류가 다음 후보를 막지 않습니다.
      }
    }
  }

  private async processEffect(context: TenantContext, adoption: EffectAdoptionRow): Promise<void> {
    const [baselines] = await this.dependencies.database.query<[EffectBaselineRow[]]>(
      "SELECT baseline_id, status FROM growth_effect_baseline WHERE organization_id = $organization_id AND adoption_id = $adoption_id LIMIT 1;",
      { organization_id: context.organizationId, adoption_id: adoption.adoption_id },
    );
    const baseline = baselines[0];
    if (!baseline) return;
    if (baseline.status === "pending") {
      const sample = await this.effectSample(context, adoption, adoption.before_version_id, "latest");
      if (sample) {
        await this.dependencies.gateway.captureEffectBaseline(context, {
          commandId: `growth-effect-baseline:${adoption.adoption_id}:${sample.lineage.targetVersionId}:${growthChecksum(sample.lineage)}`,
          adoptionId: adoption.adoption_id,
          sample,
        });
      }
      return;
    }
    if (baseline.status !== "captured" || !adoption.after_version_id) return;
    const sample = await this.effectSample(context, adoption, adoption.after_version_id, "earliest");
    if (!sample) return;
    const lineageChecksum = growthChecksum(sample.lineage);
    const evaluation = await this.dependencies.gateway.observeEffect(context, {
      commandId: `growth-effect-observe:${adoption.adoption_id}:${lineageChecksum}`,
      adoptionId: adoption.adoption_id,
      sample,
    });
    if (evaluation.result === "degraded") {
      const [suggestions] = await this.dependencies.database.query<[Array<{ revision: number }>]>(
        "SELECT revision FROM growth_suggestion WHERE organization_id = $organization_id AND suggestion_id = $suggestion_id LIMIT 1;",
        { organization_id: context.organizationId, suggestion_id: adoption.suggestion_id },
      );
      const suggestion = suggestions[0];
      if (!suggestion) return;
      await this.dependencies.gateway.revert(context, {
        commandId: `growth-effect-revert:${adoption.adoption_id}:${evaluation.effect_evaluation_id}`,
        adoptionId: adoption.adoption_id,
        suggestionRevision: suggestion.revision,
        reason: "degraded",
      });
    }
  }

  private async effectSample(
    context: TenantContext,
    adoption: EffectAdoptionRow,
    targetVersionId: string,
    order: "latest" | "earliest",
  ): Promise<GrowthEffectSample | undefined> {
    const [runs] = await this.dependencies.database.query<[EffectRunRow[]]>(
      `SELECT assurance_run_id, work_id, status, profile_id, profile_version, completed_at FROM assurance_run WHERE organization_id = $organization_id AND status IN ['passed', 'failed'] AND completed_at != NONE ORDER BY completed_at ${order === "latest" ? "DESC" : "ASC"}, assurance_run_id ASC LIMIT 30;`,
      { organization_id: context.organizationId },
    );
    const samples: GrowthEffectSample["lineage"]["samples"] extends readonly (infer T)[] ? T[] : never = [];
    const values: number[] = [];
    let contractProfile: { readonly profileId: string; readonly profileVersion: string } | undefined;
    for (const run of runs) {
      if (samples.length >= 3) break;
      const [workRows] = await this.dependencies.database.query<[EffectWorkRow[]]>(
        "SELECT prompt_version_id, policy_version_id, organization_version_id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: run.work_id },
      );
      const work = workRows[0];
      if (!work || !(await this.workUsesTarget(context, adoption.target_kind, work, targetVersionId))) continue;
      const [verificationRows] = await this.dependencies.database.query<[EffectVerificationRow[]]>(
        "SELECT verification_id, evidence_artifact_version_id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          work_id: run.work_id,
          assurance_run_id: run.assurance_run_id,
        },
      );
      const verification = verificationRows[0];
      if (!verification) continue;
      contractProfile ??= { profileId: run.profile_id, profileVersion: run.profile_version };
      if (contractProfile.profileId !== run.profile_id || contractProfile.profileVersion !== run.profile_version)
        continue;
      const metric = await this.dependencies.metricObservations?.record(context, {
        commandId: `growth-effect-metric:${adoption.adoption_id}:${run.work_id}:${run.assurance_run_id}`,
        workId: run.work_id,
        producer: { kind: "system_adapter", id: GROWTH_EFFECT_METRIC_SOURCE_ID },
        source: { kind: "artifact_version", id: verification.evidence_artifact_version_id },
        expectedUnit: "ratio",
        maximumAgeMs: 30 * 24 * 60 * 60 * 1_000,
      });
      if (!metric) continue;
      values.push(metric.value);
      samples.push({
        workId: run.work_id,
        assuranceRunId: run.assurance_run_id,
        verificationId: verification.verification_id,
        metricObservationId: metric.observationId,
        sourceChecksum: metric.checksum,
      });
    }
    if (samples.length < 3 || !contractProfile) return undefined;
    const [strategyRows] = await this.dependencies.database.query<[EffectStrategyRow[]]>(
      "SELECT strategy_version_id FROM growth_evaluation_run WHERE organization_id = $organization_id AND evaluation_run_id = $evaluation_run_id LIMIT 1;",
      { organization_id: context.organizationId, evaluation_run_id: adoption.evaluation_run_id },
    );
    const strategy = strategyRows[0];
    if (!strategy) return undefined;
    const contract = {
      strategyVersionId: strategy.strategy_version_id,
      caseSetChecksum: growthChecksum({
        ...contractProfile,
        targetKind: adoption.target_kind,
        metricSourceId: GROWTH_EFFECT_METRIC_SOURCE_ID,
      }),
      metricSourceId: GROWTH_EFFECT_METRIC_SOURCE_ID,
      metricSourceVersion: "1.0.0",
      unit: "ratio",
      windowChecksum: growthChecksum({
        schemaVersion: "massion.growth.effect-window.v1",
        selection: "three-terminal-assurances",
        order: "terminalAt,assuranceRunId",
        minimumObservations: 3,
      }),
      direction: "higher" as const,
      stableTolerance: 0.05,
      degradationThreshold: 0.2,
      minimumObservations: 3,
    };
    return {
      score: values.reduce((total, value) => total + value, 0) / values.length,
      observationCount: values.length,
      contract,
      lineage: { targetVersionId, samples },
    };
  }

  private async workUsesTarget(
    context: TenantContext,
    kind: EffectAdoptionRow["target_kind"],
    work: EffectWorkRow,
    targetVersionId: string,
  ): Promise<boolean> {
    if (kind === "policy") return work.policy_version_id === targetVersionId;
    if (kind === "organization") return work.organization_version_id === targetVersionId;
    if (!work.prompt_version_id) return false;
    const [prompts] = await this.dependencies.database.query<[EffectPromptRow[]]>(
      "SELECT prompt_definition_version_id, memory_version_ids FROM prompt_version WHERE organization_id = $organization_id AND prompt_version_id = $prompt_version_id LIMIT 1;",
      { organization_id: context.organizationId, prompt_version_id: work.prompt_version_id },
    );
    const prompt = prompts[0];
    return kind === "prompt"
      ? prompt?.prompt_definition_version_id === targetVersionId
      : Boolean(prompt?.memory_version_ids.includes(targetVersionId));
  }

  private async explicitMemoryConflict(
    context: TenantContext,
    suggestion: GrowthSuggestionRecord,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly memory_version_id: string; readonly checksum: string } | undefined> {
    if (suggestion.target_kind !== "memory" || typeof patch.key !== "string" || !patch.key.trim()) return undefined;
    const [rows] = await this.dependencies.database.query<
      [Array<{ readonly memory_version_id: string; readonly checksum: string; readonly entries_json: string }>]
    >(
      "SELECT memory_version_id, checksum, entries_json FROM memory_version WHERE organization_id = $organization_id AND scope = 'user' AND subject_id = $user_id AND status = 'active' LIMIT 1;",
      { organization_id: context.organizationId, user_id: context.userId },
    );
    const active = rows[0];
    if (!active) return undefined;
    const entries = JSON.parse(active.entries_json) as Array<{ readonly key?: unknown }>;
    return entries.some((entry) => entry.key === patch.key)
      ? { memory_version_id: active.memory_version_id, checksum: active.checksum }
      : undefined;
  }

  private signal(
    trigger: GrowthTrigger,
    suggestion: GrowthSuggestionRecord,
    input: Omit<
      GrowthSignalReceiptInput,
      | "commandId"
      | "suggestionId"
      | "adapterId"
      | "adapterVersion"
      | "outcome"
      | "score"
      | "unit"
      | "fresh"
      | "evidence"
    > & {
      readonly evidence: Readonly<Record<string, unknown>>;
    },
  ): GrowthSignalReceiptInput {
    return {
      commandId: `growth:${suggestion.suggestion_id}:signal:${input.signalId}`,
      suggestionId: suggestion.suggestion_id,
      adapterId: `growth-worker:${trigger.trigger_id}`,
      adapterVersion: "1",
      outcome: "passed",
      score: 1,
      unit: "boolean",
      fresh: true,
      ...input,
    };
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
    if (!record || !verification || !assurance)
      throw new GrowthOrphanValidationError("Growth Reflection에 필요한 완료 기록이 없습니다");

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
      for (const artifact of artifacts.map(row))
        sources.push(source("artifact", artifact, String(artifact.artifact_version_id)));
    }
    const [workRows] = await this.dependencies.database.query<[Row[]]>(
      "SELECT prompt_version_id, policy_version_id, organization_version_id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: context.organizationId, work_id: trigger.work_id },
    );
    const work = workRows[0];
    if (!work) throw new GrowthOrphanValidationError("Growth Reflection source Work를 찾을 수 없습니다");
    const [[promptRows], [policyRows], [organizationRows]] = await Promise.all([
      typeof work.prompt_version_id === "string"
        ? this.dependencies.database.query<[Row[]]>(
            "SELECT prompt_definition_version_id, prompt_definition_checksum, memory_version_ids, memory_checksums FROM prompt_version WHERE organization_id = $organization_id AND prompt_version_id = $prompt_version_id LIMIT 1;",
            { organization_id: context.organizationId, prompt_version_id: work.prompt_version_id },
          )
        : Promise.resolve([[]] as [Row[]]),
      typeof work.policy_version_id === "string"
        ? this.dependencies.database.query<[Row[]]>(
            "SELECT policy_version_id, checksum FROM governance_policy_version WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id LIMIT 1;",
            { organization_id: context.organizationId, policy_version_id: work.policy_version_id },
          )
        : Promise.resolve([[]] as [Row[]]),
      this.dependencies.database.query<[Row[]]>(
        "SELECT version_id, version, before_json, after_json FROM organization_version WHERE organization_id = $organization_id AND version_id = $organization_version_id LIMIT 1;",
        { organization_id: context.organizationId, organization_version_id: work.organization_version_id },
      ),
    ]);
    const prompt = promptRows[0];
    const policy = policyRows[0];
    const organization = organizationRows[0];
    if (!organization)
      throw new GrowthOrphanValidationError("Growth Reflection source Organization version을 찾을 수 없습니다");
    const activeVersions = [
      ...(prompt === undefined
        ? []
        : [
            {
              kind: "prompt" as const,
              versionId: String(prompt.prompt_definition_version_id),
              checksum: String(prompt.prompt_definition_checksum),
            },
            ...(Array.isArray(prompt.memory_version_ids) ? prompt.memory_version_ids : []).map((versionId, index) => ({
              kind: "memory" as const,
              versionId: String(versionId),
              checksum: String(Array.isArray(prompt.memory_checksums) ? prompt.memory_checksums[index] : ""),
            })),
          ]),
      ...(policy === undefined
        ? []
        : [
            { kind: "policy" as const, versionId: String(policy.policy_version_id), checksum: String(policy.checksum) },
          ]),
      {
        kind: "organization" as const,
        versionId: String(organization.version_id),
        checksum: growthChecksum({
          version: organization.version,
          before: organization.before_json,
          after: organization.after_json,
        }),
      },
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
    generate: async (context: TenantContext, input: { reflectionRunId: string; snapshot: ReflectionSnapshot }) => {
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
    verifySource: async (context: TenantContext, reference: ReflectionSourceReference) => {
      // ReflectionSourceReference["kind"]는 SOURCE_TABLES가 다루지 않는 값(message/evidence/symbol/memory)도
      // 허용하므로, 실제로는 undefined가 나올 수 있는 부분 매핑입니다(as keyof는 이 사실을 숨기는 거짓 캐스팅).
      const table = (SOURCE_TABLES as Partial<Record<ReflectionSourceReference["kind"], string>>)[reference.kind];
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
    verifyRuntime: async (context: TenantContext, input: { workId: string; runtimeExecutionId: string }) => {
      const [rows] = await database.query<
        [Array<{ organization_id: string; work_id: string; agent_handle: string; status: string }>]
      >(
        "SELECT organization_id, work_id, agent_handle, status FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
        { organization_id: context.organizationId, execution_id: input.runtimeExecutionId },
      );
      const execution = rows[0];
      if (
        !execution ||
        execution.work_id !== input.workId ||
        execution.agent_handle !== "growth" ||
        execution.status !== "succeeded"
      )
        throw new Error("Growth Runtime Execution 검증에 실패했습니다");
    },
  };
}
