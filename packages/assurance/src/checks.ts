import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type { AssuranceCheck, AssuranceCriterionStatus, HumanAttestation, MetricObservation } from "./contracts.js";
import type { AssuranceCheckBinding } from "./binding-store.js";
import {
  verifyArtifactEvidence,
  verifyEvidenceBriefFreshness,
  type ArtifactEvidence,
  type EvidenceBriefEvidence,
} from "./evidence.js";

export interface DeterministicCheckResult {
  readonly status: "passed" | "failed" | "blocked";
  readonly outputHash: string;
  readonly summary: string;
  readonly evidenceReferenceIds: readonly string[];
  readonly artifactVersionIds: readonly string[];
  readonly evidenceBriefIds: readonly string[];
  readonly metricObservationIds: readonly string[];
  readonly humanAttestationIds: readonly string[];
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function result(
  status: DeterministicCheckResult["status"],
  summary: string,
  references: {
    readonly artifactVersionIds?: readonly string[];
    readonly evidenceBriefIds?: readonly string[];
    readonly metricObservationIds?: readonly string[];
    readonly humanAttestationIds?: readonly string[];
  } = {},
): DeterministicCheckResult {
  const artifactVersionIds = [...(references.artifactVersionIds ?? [])].sort();
  const evidenceBriefIds = [...(references.evidenceBriefIds ?? [])].sort();
  const metricObservationIds = [...(references.metricObservationIds ?? [])].sort();
  const humanAttestationIds = [...(references.humanAttestationIds ?? [])].sort();
  const evidenceReferenceIds = [
    ...artifactVersionIds,
    ...evidenceBriefIds,
    ...metricObservationIds,
    ...humanAttestationIds,
  ];
  return {
    status,
    outputHash: sha256(canonicalJson({ status, summary, evidenceReferenceIds })),
    summary,
    evidenceReferenceIds,
    artifactVersionIds,
    evidenceBriefIds,
    metricObservationIds,
    humanAttestationIds,
  };
}

export function assertNoCallerVerdict(input: Readonly<Record<string, unknown>>): void {
  const forbidden = ["passed", "status", "verdict"].find((key) => key in input);
  if (forbidden) throw new Error(`caller verdict 필드는 허용되지 않습니다: ${forbidden}`);
}

export function evaluateArtifactEvidenceCheck(input: {
  readonly organizationId: string;
  readonly workId: string;
  readonly observedAt: string;
  readonly maximumAgeMs: number;
  readonly requiredArtifactVersionIds: readonly string[];
  readonly artifacts: readonly ArtifactEvidence[];
}): DeterministicCheckResult {
  const verified: string[] = [];
  try {
    for (const artifactVersionId of [...new Set(input.requiredArtifactVersionIds)].sort()) {
      const artifact = input.artifacts.find((candidate) => candidate.artifactVersionId === artifactVersionId);
      if (!artifact) return result("blocked", `필수 ArtifactVersion 증거가 없습니다: ${artifactVersionId}`);
      verifyArtifactEvidence({
        organizationId: input.organizationId,
        workId: input.workId,
        allowedArtifactVersionIds: input.requiredArtifactVersionIds,
        observedAt: input.observedAt,
        maximumAgeMs: input.maximumAgeMs,
        artifact,
      });
      verified.push(artifactVersionId);
    }
  } catch (error) {
    const summary = error instanceof Error ? error.message : "ArtifactVersion 증거 검증에 실패했습니다";
    return result(summary.includes("freshness") || summary.includes("미래") ? "blocked" : "failed", summary, {
      artifactVersionIds: verified,
    });
  }
  return result("passed", `${String(verified.length)}개 ArtifactVersion 증거가 유효합니다`, {
    artifactVersionIds: verified,
  });
}

type MetricOperator = ">" | ">=" | "=" | "<=" | "<";

function compare(value: number, operator: MetricOperator, threshold: number): boolean {
  if (operator === ">") return value > threshold;
  if (operator === ">=") return value >= threshold;
  if (operator === "=") return Object.is(value, threshold) || value === threshold;
  if (operator === "<=") return value <= threshold;
  return value < threshold;
}

export function evaluateMetricObservationCheck(input: {
  readonly organizationId: string;
  readonly workId: string;
  readonly observedAt: string;
  readonly maximumAgeMs: number;
  readonly sourceKind: MetricObservation["sourceKind"];
  readonly operator: MetricOperator;
  readonly threshold: number;
  readonly unit: string;
  readonly observations: readonly MetricObservation[];
}): DeterministicCheckResult {
  if (!Number.isFinite(input.threshold)) return result("blocked", "Metric threshold가 유한한 수가 아닙니다");
  const observedAt = new Date(input.observedAt).getTime();
  if (!Number.isFinite(observedAt) || !Number.isSafeInteger(input.maximumAgeMs) || input.maximumAgeMs < 0) {
    return result("blocked", "Metric check 시간 설정이 올바르지 않습니다");
  }
  const eligible = input.observations
    .filter(
      (observation) =>
        observation.organizationId === input.organizationId &&
        observation.workId === input.workId &&
        observation.sourceKind === input.sourceKind &&
        observation.unit === input.unit &&
        Number.isFinite(observation.value) &&
        /^[a-f0-9]{64}$/u.test(observation.checksum),
    )
    .map((observation) => ({ observation, measuredAt: new Date(observation.measuredAt).getTime() }))
    .filter(
      (candidate) =>
        Number.isFinite(candidate.measuredAt) &&
        candidate.measuredAt <= observedAt &&
        observedAt - candidate.measuredAt <= input.maximumAgeMs,
    )
    .sort((left, right) => right.measuredAt - left.measuredAt);
  const latest = eligible[0]?.observation;
  if (!latest) return result("blocked", "조건에 맞는 fresh MetricObservation이 없습니다");
  const passed = compare(latest.value, input.operator, input.threshold);
  return result(
    passed ? "passed" : "failed",
    `Metric ${String(latest.value)} ${input.operator} ${String(input.threshold)} ${input.unit}`,
    { metricObservationIds: [latest.observationId] },
  );
}

export function evaluateHumanAttestationCheck(input: {
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly statementHash: string;
  readonly snapshotHash: string;
  readonly eligibleRoles: readonly string[];
  readonly minimumAttestations: number;
  readonly memberships: readonly {
    readonly userId: string;
    readonly role: string;
    readonly status: "active" | "suspended";
  }[];
  readonly attestations: readonly HumanAttestation[];
}): DeterministicCheckResult {
  if (!Number.isSafeInteger(input.minimumAttestations) || input.minimumAttestations < 1) {
    return result("blocked", "Human attestation 최소 인원 설정이 올바르지 않습니다");
  }
  const eligibleUsers = new Set(
    input.memberships
      .filter((membership) => membership.status === "active" && input.eligibleRoles.includes(membership.role))
      .map((membership) => membership.userId),
  );
  const valid = input.attestations.filter(
    (attestation) =>
      attestation.organizationId === input.organizationId &&
      attestation.workId === input.workId &&
      attestation.assuranceRunId === input.assuranceRunId &&
      attestation.criterionId === input.criterionId &&
      attestation.statementHash === input.statementHash &&
      attestation.snapshotHash === input.snapshotHash &&
      eligibleUsers.has(attestation.attestorUserId),
  );
  const distinctUsers = new Set(valid.map((attestation) => attestation.attestorUserId));
  if (distinctUsers.size !== valid.length) {
    return result("blocked", "같은 사용자의 HumanAttestation이 중복됐습니다", {
      humanAttestationIds: valid.map((attestation) => attestation.attestationId),
    });
  }
  const ids = valid.map((attestation) => attestation.attestationId);
  if (valid.some((attestation) => !attestation.accepted)) {
    return result("failed", "HumanAttestation reject가 존재합니다", { humanAttestationIds: ids });
  }
  if (valid.length < input.minimumAttestations) {
    return result(
      "blocked",
      `HumanAttestation 인원이 부족합니다: ${String(valid.length)}/${String(input.minimumAttestations)}`,
      { humanAttestationIds: ids },
    );
  }
  return result("passed", `${String(valid.length)}명의 HumanAttestation이 유효합니다`, {
    humanAttestationIds: ids,
  });
}

export function finalizeCriterionFromChecks(input: {
  readonly expectedBindingKeys: readonly string[];
  readonly checks: readonly {
    readonly bindingKey: string;
    readonly status: "passed" | "failed" | "blocked";
    readonly outputHash: string;
  }[];
}): { readonly status: Exclude<AssuranceCriterionStatus, "pending" | "excluded">; readonly evidenceHash: string } {
  const expected = [...new Set(input.expectedBindingKeys)].sort();
  const byKey = new Map(input.checks.map((check) => [check.bindingKey, check]));
  const uniqueChecks = byKey.size === input.checks.length;
  const exactKeys = input.checks.every((check) => expected.includes(check.bindingKey));
  const complete =
    expected.length > 0 &&
    expected.length === input.expectedBindingKeys.length &&
    uniqueChecks &&
    exactKeys &&
    expected.every((key) => byKey.has(key));
  const hashesValid = input.checks.every((check) => /^[a-f0-9]{64}$/u.test(check.outputHash));
  let status: "passed" | "failed" | "blocked";
  if (input.checks.some((check) => check.status === "failed")) status = "failed";
  else if (!complete || !hashesValid || input.checks.some((check) => check.status === "blocked")) status = "blocked";
  else status = "passed";
  return {
    status,
    evidenceHash: sha256(
      canonicalJson({
        status,
        expectedBindingKeys: expected,
        checks: input.checks
          .map((check) => ({ ...check }))
          .sort((left, right) => left.bindingKey.localeCompare(right.bindingKey)),
      }),
    ),
  };
}

export interface RecordAssuranceCheckInput {
  readonly commandId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly bindingKey: string;
  readonly artifactVersionIds?: readonly string[];
  readonly evidenceBriefIds?: readonly string[];
  readonly metricObservationIds?: readonly string[];
  readonly humanAttestationIds?: readonly string[];
}

export interface AssuranceCheckRecordResult {
  readonly check: AssuranceCheck;
  readonly criterionStatus: AssuranceCriterionStatus;
}

interface RunRecord {
  readonly work_id: string;
  readonly binding_version_id: string;
  readonly verifier_handle: string;
  readonly verifier_execution_id: string;
  readonly snapshot_hash: string;
  readonly status: string;
}

interface CriterionRecord {
  readonly criterion_id: string;
  readonly criterion_key: string;
  readonly statement: string;
  readonly method: string;
  readonly status: AssuranceCriterionStatus;
}

interface BindingRecord {
  readonly bindings_json: string;
}

interface CheckRecord {
  readonly check_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly assurance_run_id: string;
  readonly criterion_id: string;
  readonly kind: AssuranceCheck["kind"];
  readonly executor_handle?: string;
  readonly executor_execution_id?: string;
  readonly system_adapter_id?: string;
  readonly command_key: string;
  readonly input_hash: string;
  readonly status: AssuranceCheck["status"];
  readonly tool_name?: string;
  readonly tool_version?: string;
  readonly output_hash?: string;
  readonly output_summary?: string;
  readonly artifact_version_ids: readonly string[];
  readonly evidence_brief_ids: readonly string[];
  readonly metric_observation_ids: readonly string[];
  readonly human_attestation_ids: readonly string[];
  readonly duration_ms?: number;
  readonly created_at: unknown;
  readonly started_at?: unknown;
  readonly completed_at?: unknown;
}

interface MetricRecord {
  readonly observation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly producer_kind: MetricObservation["producerKind"];
  readonly producer_id: string;
  readonly source_kind: MetricObservation["sourceKind"];
  readonly source_id: string;
  readonly numeric_value: number;
  readonly unit: string;
  readonly checksum: string;
  readonly measured_at: unknown;
  readonly created_at: unknown;
}

interface AttestationRecord {
  readonly attestation_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly assurance_run_id: string;
  readonly criterion_id: string;
  readonly attestor_user_id: string;
  readonly statement_hash: string;
  readonly snapshot_hash: string;
  readonly accepted: boolean;
  readonly command_id: string;
  readonly request_hash: string;
  readonly created_at: unknown;
}

interface EventRecord {
  readonly request_hash: string;
  readonly payload_json: string;
}

function text(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}이 필요합니다`);
  if (normalized.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
  return normalized;
}

function ids(values: readonly string[] | undefined, label: string): readonly string[] {
  const normalized = [...new Set((values ?? []).map((value) => text(value, label)))].sort();
  if (normalized.length !== (values ?? []).length) throw new Error(`${label}에 중복 값이 있습니다`);
  if (normalized.length > 100) throw new Error(`${label}은 100개 이하여야 합니다`);
  return normalized;
}

function iso(value: unknown, label: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw) throw new Error(`${label}을 직렬화할 수 없습니다`);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}이 올바르지 않습니다`);
  return parsed.toISOString();
}

function checkView(record: CheckRecord): AssuranceCheck {
  return {
    checkId: record.check_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    assuranceRunId: record.assurance_run_id,
    criterionId: record.criterion_id,
    kind: record.kind,
    ...(record.executor_handle ? { executorHandle: record.executor_handle } : {}),
    ...(record.executor_execution_id ? { executorExecutionId: record.executor_execution_id } : {}),
    ...(record.system_adapter_id ? { systemAdapterId: record.system_adapter_id } : {}),
    commandKey: record.command_key,
    inputHash: record.input_hash,
    status: record.status,
    ...(record.tool_name ? { toolName: record.tool_name } : {}),
    ...(record.tool_version ? { toolVersion: record.tool_version } : {}),
    ...(record.output_hash ? { outputHash: record.output_hash } : {}),
    ...(record.output_summary ? { outputSummary: record.output_summary } : {}),
    artifactVersionIds: record.artifact_version_ids,
    evidenceBriefIds: record.evidence_brief_ids,
    metricObservationIds: record.metric_observation_ids,
    humanAttestationIds: record.human_attestation_ids,
    ...(record.duration_ms !== undefined ? { durationMs: record.duration_ms } : {}),
    createdAt: iso(record.created_at, "AssuranceCheck createdAt"),
    ...(record.started_at ? { startedAt: iso(record.started_at, "AssuranceCheck startedAt") } : {}),
    ...(record.completed_at ? { completedAt: iso(record.completed_at, "AssuranceCheck completedAt") } : {}),
  };
}

function isBinding(value: unknown): value is AssuranceCheckBinding {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { bindingKey?: unknown }).bindingKey === "string" &&
    typeof (value as { criterionKey?: unknown }).criterionKey === "string" &&
    typeof (value as { kind?: unknown }).kind === "string",
  );
}

export class AssuranceCheckStore {
  private readonly clock: () => Date;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    options: { readonly clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  public async record(context: TenantContext, input: RecordAssuranceCheckInput): Promise<AssuranceCheckRecordResult> {
    assertNoCallerVerdict(input as unknown as Readonly<Record<string, unknown>>);
    await this.organizations.verifyTenantContext(context);
    const normalized = this.normalize(input);
    const requestHash = sha256(
      canonicalJson({ operation: "record_assurance_check", input: normalized, actorUserId: context.userId }),
    );
    const replayedId = await this.replay(context.organizationId, normalized.commandId, requestHash, this.database);
    if (replayedId) return await this.resultFor(this.database, context.organizationId, replayedId);

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrentId = await this.replay(context.organizationId, normalized.commandId, requestHash, transaction);
      if (concurrentId) return await this.resultFor(transaction, context.organizationId, concurrentId);
      const target = await this.target(transaction, context.organizationId, normalized);
      const inputHash = sha256(canonicalJson({ ...normalized, commandId: undefined }));
      const [existingRecords] = await transaction.query<[CheckRecord[]]>(
        "SELECT * OMIT id FROM assurance_check WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND command_key = $command_key LIMIT 1;",
        {
          organization_id: context.organizationId,
          assurance_run_id: normalized.assuranceRunId,
          command_key: normalized.bindingKey,
        },
      );
      const existing = existingRecords[0];
      if (existing) {
        if (existing.input_hash !== inputHash)
          throw new Error("같은 check binding에 다른 evidence payload를 사용할 수 없습니다");
        await this.event(
          transaction,
          context,
          normalized,
          requestHash,
          existing.check_id,
          "assurance_check_deduplicated",
        );
        return { check: checkView(existing), criterionStatus: target.criterion.status };
      }
      const executor = await this.executor(transaction, context.organizationId, normalized.workId, target);
      const evaluated = await this.evaluate(transaction, context.organizationId, normalized, target, executor);
      const checkId = randomUUID();
      const [records] = await transaction.query<[CheckRecord[]]>(
        "CREATE assurance_check CONTENT { check_id: $check_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, kind: $kind, executor_handle: $executor_handle, executor_execution_id: $executor_execution_id, system_adapter_id: $system_adapter_id, command_key: $command_key, input_hash: $input_hash, status: $status, output_hash: $output_hash, output_summary: $output_summary, artifact_version_ids: $artifact_version_ids, evidence_brief_ids: $evidence_brief_ids, metric_observation_ids: $metric_observation_ids, human_attestation_ids: $human_attestation_ids, duration_ms: 0, created_at: time::now(), started_at: time::now(), completed_at: time::now() } RETURN AFTER;",
        {
          check_id: checkId,
          organization_id: context.organizationId,
          work_id: normalized.workId,
          assurance_run_id: normalized.assuranceRunId,
          criterion_id: normalized.criterionId,
          kind: this.kind(target.binding.kind),
          executor_handle: executor.handle,
          executor_execution_id: executor.executionId,
          system_adapter_id: executor.adapterId,
          command_key: normalized.bindingKey,
          input_hash: inputHash,
          status: evaluated.status,
          output_hash: evaluated.outputHash,
          output_summary: evaluated.summary,
          artifact_version_ids: evaluated.artifactVersionIds,
          evidence_brief_ids: evaluated.evidenceBriefIds,
          metric_observation_ids: evaluated.metricObservationIds,
          human_attestation_ids: evaluated.humanAttestationIds,
        },
      );
      const created = records[0];
      if (!created) throw new Error("AssuranceCheck 생성 결과가 없습니다");
      const criterionStatus = await this.projectCriterion(transaction, context.organizationId, target, normalized);
      await this.event(transaction, context, normalized, requestHash, checkId, "assurance_check_recorded");
      return { check: checkView(created), criterionStatus };
    });
  }

  private normalize(input: RecordAssuranceCheckInput): Required<RecordAssuranceCheckInput> {
    return {
      commandId: text(input.commandId, "Assurance check command ID"),
      workId: text(input.workId, "Work ID"),
      assuranceRunId: text(input.assuranceRunId, "Assurance run ID"),
      criterionId: text(input.criterionId, "Assurance criterion ID"),
      bindingKey: text(input.bindingKey, "Assurance binding key", 100),
      artifactVersionIds: ids(input.artifactVersionIds, "ArtifactVersion ID"),
      evidenceBriefIds: ids(input.evidenceBriefIds, "EvidenceBrief ID"),
      metricObservationIds: ids(input.metricObservationIds, "MetricObservation ID"),
      humanAttestationIds: ids(input.humanAttestationIds, "HumanAttestation ID"),
    };
  }

  private async target(
    executor: QueryExecutor,
    organizationId: string,
    input: Required<RecordAssuranceCheckInput>,
  ): Promise<{
    readonly run: RunRecord;
    readonly criterion: CriterionRecord;
    readonly binding: AssuranceCheckBinding;
    readonly bindings: readonly AssuranceCheckBinding[];
  }> {
    const [runs] = await executor.query<[RunRecord[]]>(
      "SELECT work_id, binding_version_id, verifier_handle, verifier_execution_id, snapshot_hash, status FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId, assurance_run_id: input.assuranceRunId },
    );
    const run = runs[0];
    if (!run || !["planned", "running"].includes(run.status)) throw new Error("활성 Assurance run을 찾을 수 없습니다");
    const [criteria] = await executor.query<[CriterionRecord[]]>(
      "SELECT criterion_id, criterion_key, statement, method, status FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id LIMIT 1;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
        criterion_id: input.criterionId,
      },
    );
    const criterion = criteria[0];
    if (!criterion || criterion.status === "excluded")
      throw new Error("판정 가능한 Assurance criterion을 찾을 수 없습니다");
    const [versions] = await executor.query<[BindingRecord[]]>(
      "SELECT bindings_json FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id AND status IN ['active', 'superseded'] LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId, binding_version_id: run.binding_version_id },
    );
    const version = versions[0];
    if (!version) throw new Error("Assurance run binding을 찾을 수 없습니다");
    const decoded = JSON.parse(version.bindings_json) as unknown;
    if (!Array.isArray(decoded) || !decoded.every(isBinding))
      throw new Error("Assurance binding JSON이 올바르지 않습니다");
    const bindings = decoded.filter((binding) => binding.criterionKey === criterion.criterion_key);
    const binding = bindings.find((candidate) => candidate.bindingKey === input.bindingKey);
    if (!binding || binding.kind !== criterion.method)
      throw new Error("Criterion에 대응하는 check binding을 찾을 수 없습니다");
    return { run, criterion, binding, bindings };
  }

  private async evaluate(
    executor: QueryExecutor,
    organizationId: string,
    input: Required<RecordAssuranceCheckInput>,
    target: { readonly run: RunRecord; readonly criterion: CriterionRecord; readonly binding: AssuranceCheckBinding },
    trustedExecutor: { readonly handle?: string; readonly executionId?: string; readonly adapterId?: string },
  ): Promise<DeterministicCheckResult> {
    if (target.binding.kind === "evidence") return await this.evidence(executor, organizationId, input, target.binding);
    if (target.binding.kind === "metric")
      return await this.metric(executor, organizationId, input, target.binding, trustedExecutor);
    if (target.binding.kind === "human")
      return await this.human(executor, organizationId, input, { ...target, binding: target.binding });
    throw new Error(`${target.binding.kind} check는 전용 trusted executor가 필요합니다`);
  }

  private async evidence(
    executor: QueryExecutor,
    organizationId: string,
    input: Required<RecordAssuranceCheckInput>,
    binding: Extract<AssuranceCheckBinding, { kind: "evidence" }>,
  ): Promise<DeterministicCheckResult> {
    if (input.metricObservationIds.length || input.humanAttestationIds.length)
      throw new Error("Evidence binding에 다른 evidence kind ID를 사용할 수 없습니다");
    if (input.artifactVersionIds.length === 0 && input.evidenceBriefIds.length === 0) {
      return result("blocked", "Evidence binding에 제출된 evidence ID가 없습니다");
    }
    if (binding.evidenceKinds.includes("artifact-version") && input.artifactVersionIds.length === 0) {
      return result("blocked", "Binding이 요구한 ArtifactVersion evidence가 없습니다");
    }
    if (binding.evidenceKinds.includes("evidence-brief") && input.evidenceBriefIds.length === 0) {
      return result("blocked", "Binding이 요구한 EvidenceBrief가 없습니다");
    }
    const [records] = await executor.query<
      [
        {
          artifact_version_id: string;
          organization_id: string;
          work_id: string;
          checksum: string;
          content_json: string;
          created_at: unknown;
        }[],
      ]
    >(
      "SELECT artifact_version_id, organization_id, work_id, checksum, content_json, created_at FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $ids;",
      { organization_id: organizationId, work_id: input.workId, ids: input.artifactVersionIds },
    );
    const artifacts: ArtifactEvidence[] = records.map((record) => ({
      artifactVersionId: record.artifact_version_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      checksum: record.checksum,
      contentJson: record.content_json,
      createdAt: iso(record.created_at, "ArtifactVersion createdAt"),
    }));
    const artifactResult = evaluateArtifactEvidenceCheck({
      organizationId,
      workId: input.workId,
      observedAt: this.clock().toISOString(),
      maximumAgeMs: binding.maximumAgeMs,
      requiredArtifactVersionIds: input.artifactVersionIds,
      artifacts,
    });
    if (artifactResult.status !== "passed") return artifactResult;
    const [briefRecords] = await executor.query<
      [
        {
          evidence_brief_id: string;
          organization_id: string;
          work_id: string;
          repository_id: string;
          repository_revision_id: string;
          index_version_id: string;
          configuration_checksum: string;
          query: string;
          status: EvidenceBriefEvidence["status"];
          references_json: string;
          claims_json: string;
          checksum: string;
          created_at: unknown;
        }[],
      ]
    >(
      "SELECT evidence_brief_id, organization_id, work_id, repository_id, repository_revision_id, index_version_id, configuration_checksum, query, status, references_json, claims_json, checksum, created_at FROM evidence_brief WHERE organization_id = $organization_id AND work_id = $work_id AND evidence_brief_id IN $ids;",
      { organization_id: organizationId, work_id: input.workId, ids: input.evidenceBriefIds },
    );
    if (briefRecords.length !== input.evidenceBriefIds.length)
      return result("blocked", "필수 EvidenceBrief 증거가 없습니다", {
        artifactVersionIds: artifactResult.artifactVersionIds,
      });
    try {
      for (const record of briefRecords) {
        const brief: EvidenceBriefEvidence = {
          evidenceBriefId: record.evidence_brief_id,
          organizationId: record.organization_id,
          workId: record.work_id,
          repositoryId: record.repository_id,
          repositoryRevisionId: record.repository_revision_id,
          indexVersionId: record.index_version_id,
          configurationChecksum: record.configuration_checksum,
          query: record.query,
          status: record.status,
          referencesJson: record.references_json,
          claimsJson: record.claims_json,
          checksum: record.checksum,
          createdAt: iso(record.created_at, "EvidenceBrief createdAt"),
        };
        const [currentIndexes] = await executor.query<
          [
            {
              repository_revision_id: string;
              index_version_id: string;
              configuration_checksum: string;
            }[],
          ]
        >(
          "SELECT repository_revision_id, index_version_id, configuration_checksum FROM index_version WHERE organization_id = $organization_id AND repository_id = $repository_id AND current = true AND status = 'ready' LIMIT 1;",
          { organization_id: organizationId, repository_id: record.repository_id },
        );
        const current = currentIndexes[0];
        if (!current) throw new Error("EvidenceBrief repository의 현재 ready IndexVersion이 없습니다");
        verifyEvidenceBriefFreshness({
          organizationId,
          workId: input.workId,
          observedAt: this.clock().toISOString(),
          maximumAgeMs: binding.maximumAgeMs,
          current: {
            repositoryRevisionId: current.repository_revision_id,
            indexVersionId: current.index_version_id,
            configurationChecksum: current.configuration_checksum,
          },
          brief,
        });
      }
    } catch (error) {
      return result("blocked", error instanceof Error ? error.message : "EvidenceBrief 검증에 실패했습니다", {
        artifactVersionIds: artifactResult.artifactVersionIds,
      });
    }
    return result("passed", "DB에서 다시 읽은 evidence가 유효합니다", {
      artifactVersionIds: artifactResult.artifactVersionIds,
      evidenceBriefIds: input.evidenceBriefIds,
    });
  }

  private async metric(
    executor: QueryExecutor,
    organizationId: string,
    input: Required<RecordAssuranceCheckInput>,
    binding: Extract<AssuranceCheckBinding, { kind: "metric" }>,
    trustedExecutor: { readonly handle?: string; readonly executionId?: string; readonly adapterId?: string },
  ): Promise<DeterministicCheckResult> {
    if (input.artifactVersionIds.length || input.evidenceBriefIds.length || input.humanAttestationIds.length)
      throw new Error("Metric binding에는 MetricObservation ID만 사용할 수 있습니다");
    const [records] = await executor.query<[MetricRecord[]]>(
      "SELECT * OMIT id FROM assurance_metric_observation WHERE organization_id = $organization_id AND work_id = $work_id AND observation_id IN $ids;",
      { organization_id: organizationId, work_id: input.workId, ids: input.metricObservationIds },
    );
    const observations: MetricObservation[] = records.map((record) => ({
      observationId: record.observation_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      producerKind: record.producer_kind,
      producerId: record.producer_id,
      sourceKind: record.source_kind,
      sourceId: record.source_id,
      value: record.numeric_value,
      unit: record.unit,
      checksum: record.checksum,
      measuredAt: iso(record.measured_at, "Metric measuredAt"),
      createdAt: iso(record.created_at, "Metric createdAt"),
    }));
    const owned = observations.filter((observation) =>
      binding.executor.kind === "system_adapter"
        ? observation.producerKind === "system_adapter" && observation.producerId === binding.executor.adapterId
        : observation.producerKind === "runtime_execution" && observation.producerId === trustedExecutor.executionId,
    );
    return evaluateMetricObservationCheck({
      organizationId,
      workId: input.workId,
      observedAt: this.clock().toISOString(),
      maximumAgeMs: binding.maxAgeMs,
      sourceKind: binding.sourceKind,
      operator: binding.operator,
      threshold: binding.threshold,
      unit: binding.unit,
      observations: owned,
    });
  }

  private async human(
    executor: QueryExecutor,
    organizationId: string,
    input: Required<RecordAssuranceCheckInput>,
    target: {
      readonly run: RunRecord;
      readonly criterion: CriterionRecord;
      readonly binding: Extract<AssuranceCheckBinding, { kind: "human" }>;
    },
  ): Promise<DeterministicCheckResult> {
    if (input.artifactVersionIds.length || input.evidenceBriefIds.length || input.metricObservationIds.length)
      throw new Error("Human binding에는 HumanAttestation ID만 사용할 수 있습니다");
    const [records] = await executor.query<[AttestationRecord[]]>(
      "SELECT * OMIT id FROM assurance_human_attestation WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
        criterion_id: input.criterionId,
      },
    );
    const attestations: HumanAttestation[] = records.map((record) => ({
      attestationId: record.attestation_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      assuranceRunId: record.assurance_run_id,
      criterionId: record.criterion_id,
      attestorUserId: record.attestor_user_id,
      statementHash: record.statement_hash,
      snapshotHash: record.snapshot_hash,
      accepted: record.accepted,
      commandId: record.command_id,
      requestHash: record.request_hash,
      createdAt: iso(record.created_at, "Attestation createdAt"),
    }));
    const users = [...new Set(attestations.map((attestation) => attestation.attestorUserId))];
    const [memberships] = await executor.query<[{ user_id: string; role: string; status: "active" | "suspended" }[]]>(
      "SELECT user_id, role, status FROM membership WHERE organization_id = $organization_id AND user_id IN $user_ids;",
      { organization_id: organizationId, user_ids: users },
    );
    return evaluateHumanAttestationCheck({
      organizationId,
      workId: input.workId,
      assuranceRunId: input.assuranceRunId,
      criterionId: input.criterionId,
      statementHash: sha256(target.criterion.statement),
      snapshotHash: target.run.snapshot_hash,
      eligibleRoles: target.binding.eligibleRoles,
      minimumAttestations: target.binding.minimumAttestations,
      memberships: memberships.map((membership) => ({
        userId: membership.user_id,
        role: membership.role,
        status: membership.status,
      })),
      attestations,
    });
  }

  private async executor(
    executor: QueryExecutor,
    organizationId: string,
    workId: string,
    target: { readonly run: RunRecord; readonly binding: AssuranceCheckBinding },
  ): Promise<{ readonly handle?: string; readonly executionId?: string; readonly adapterId?: string }> {
    if (target.binding.executor.kind === "system_adapter") return { adapterId: target.binding.executor.adapterId };
    const [executions] = await executor.query<[{ execution_id: string }[]]>(
      "SELECT execution_id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND agent_handle = $agent_handle AND status = 'succeeded' ORDER BY ended_at DESC LIMIT 1;",
      { organization_id: organizationId, work_id: workId, agent_handle: target.binding.executor.handle },
    );
    const executionId =
      target.binding.executor.handle === target.run.verifier_handle
        ? target.run.verifier_execution_id
        : executions[0]?.execution_id;
    if (!executionId) throw new Error("Check binding의 trusted Runtime executor를 찾을 수 없습니다");
    return { handle: target.binding.executor.handle, executionId };
  }

  private kind(kind: AssuranceCheckBinding["kind"]): AssuranceCheck["kind"] {
    return kind === "test" ? "command" : kind;
  }

  private async projectCriterion(
    executor: QueryExecutor,
    organizationId: string,
    target: { readonly criterion: CriterionRecord; readonly bindings: readonly AssuranceCheckBinding[] },
    input: Required<RecordAssuranceCheckInput>,
  ): Promise<AssuranceCriterionStatus> {
    const [records] = await executor.query<[CheckRecord[]]>(
      "SELECT command_key, status, output_hash FROM assurance_check WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      { organization_id: organizationId, assurance_run_id: input.assuranceRunId, criterion_id: input.criterionId },
    );
    if (records.length < target.bindings.length) return target.criterion.status;
    const finalized = finalizeCriterionFromChecks({
      expectedBindingKeys: target.bindings.map((binding) => binding.bindingKey),
      checks: records.map((record) => ({
        bindingKey: record.command_key,
        status: record.status === "passed" || record.status === "failed" ? record.status : "blocked",
        outputHash: record.output_hash ?? "",
      })),
    });
    await executor.query(
      "UPDATE assurance_criterion SET status = $status, updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      {
        status: finalized.status,
        organization_id: organizationId,
        assurance_run_id: input.assuranceRunId,
        criterion_id: input.criterionId,
      },
    );
    return finalized.status;
  }

  private async resultFor(
    executor: QueryExecutor,
    organizationId: string,
    checkId: string,
  ): Promise<AssuranceCheckRecordResult> {
    const [records] = await executor.query<[CheckRecord[]]>(
      "SELECT * OMIT id FROM assurance_check WHERE organization_id = $organization_id AND check_id = $check_id LIMIT 1;",
      { organization_id: organizationId, check_id: checkId },
    );
    const check = records[0];
    if (!check) throw new Error("AssuranceCheck을 찾을 수 없습니다");
    const [criteria] = await executor.query<[{ status: AssuranceCriterionStatus }[]]>(
      "SELECT status FROM assurance_criterion WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id LIMIT 1;",
      { organization_id: organizationId, assurance_run_id: check.assurance_run_id, criterion_id: check.criterion_id },
    );
    if (!criteria[0]) throw new Error("AssuranceCheck criterion을 찾을 수 없습니다");
    return { check: checkView(check), criterionStatus: criteria[0].status };
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor,
  ): Promise<string | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT request_hash, payload_json FROM assurance_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (event.request_hash !== requestHash)
      throw new Error("같은 commandId를 다른 AssuranceCheck payload에 재사용할 수 없습니다");
    const payload = JSON.parse(event.payload_json) as { checkId?: unknown };
    if (typeof payload.checkId !== "string") throw new Error("AssuranceCheck Event payload가 올바르지 않습니다");
    return payload.checkId;
  }

  private async event(
    executor: QueryExecutor,
    context: TenantContext,
    input: Required<RecordAssuranceCheckInput>,
    requestHash: string,
    checkId: string,
    eventType: string,
  ): Promise<void> {
    const [events] = await executor.query<[{ sequence: number }[]]>(
      "SELECT sequence FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
    );
    const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    await executor.query(
      "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: input.assuranceRunId,
        command_id: input.commandId,
        sequence,
        event_type: eventType,
        request_hash: requestHash,
        payload_json: canonicalJson({ checkId }),
        actor_user_id: context.userId,
      },
    );
  }
}
