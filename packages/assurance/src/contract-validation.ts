import type {
  AssuranceCheck,
  AssuranceCriterion,
  AssuranceFinding,
  HumanAttestation,
  MetricObservation,
} from "./contracts.js";

function text(value: string, label: string, maximum = 200): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}이 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
}

function sha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function oneOf(value: string, label: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error(`${label}이 허용된 값이 아닙니다`);
}

function isoDateTime(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label}은 UTC ISO date-time 형식이어야 합니다`);
  }
}

function texts(values: readonly string[], label: string, maximumItems: number): void {
  if (values.length > maximumItems) throw new Error(`${label}은 ${String(maximumItems)}개 이하여야 합니다`);
  for (const value of values) text(value, label);
}

function common(
  value: { readonly organizationId: string; readonly workId: string; readonly assuranceRunId?: string },
  id: string,
  label: string,
): void {
  text(id, `${label} ID`);
  text(value.organizationId, "Organization ID");
  text(value.workId, "Work ID");
  if (value.assuranceRunId !== undefined) text(value.assuranceRunId, "Assurance run ID");
}

export function validateAssuranceCriterion(value: AssuranceCriterion): void {
  common(value, value.criterionId, "Criterion");
  text(value.criterionKey, "Criterion key", 100);
  if (!/^[a-z0-9][a-z0-9:._-]*$/u.test(value.criterionKey)) throw new Error("Criterion key 형식이 올바르지 않습니다");
  oneOf(value.source, "Criterion source", ["plan", "task", "profile"]);
  text(value.statement, "Criterion statement", 2_000);
  oneOf(value.method, "Criterion method", ["test", "inspection", "evidence", "metric", "human"]);
  texts(value.requiredEvidenceKinds, "Evidence kind", 20);
  texts(value.controlReferences, "Control reference", 50);
  oneOf(value.status, "Criterion status", ["pending", "passed", "failed", "blocked", "excluded"]);
  const exclusions = [value.exclusionRule, value.exclusionReason, value.exclusionActorId];
  if (value.status === "excluded") {
    if (exclusions.some((item) => !item?.trim()))
      throw new Error("Excluded criterion에는 rule·reason·actor가 필요합니다");
    for (const item of exclusions) text(item ?? "", "Criterion exclusion", 1_000);
  } else if (exclusions.some((item) => item !== undefined)) {
    throw new Error("Excluded 상태가 아닌 criterion에는 exclusion metadata를 사용할 수 없습니다");
  }
  isoDateTime(value.createdAt, "Criterion createdAt");
  isoDateTime(value.updatedAt, "Criterion updatedAt");
}

export function validateAssuranceCheck(value: AssuranceCheck): void {
  common(value, value.checkId, "Check");
  text(value.criterionId, "Criterion ID");
  oneOf(value.kind, "Check kind", ["command", "inspection", "evidence", "metric", "human"]);
  text(value.commandKey, "Check command key");
  sha256(value.inputHash, "Check input hash");
  oneOf(value.status, "Check status", ["pending", "running", "passed", "failed", "blocked", "cancelled"]);
  const runtimeExecutor = value.executorHandle !== undefined || value.executorExecutionId !== undefined;
  const systemExecutor = value.systemAdapterId !== undefined;
  if (runtimeExecutor === systemExecutor)
    throw new Error("Check executor는 Runtime Execution 또는 system adapter 하나여야 합니다");
  if (runtimeExecutor) {
    text(value.executorHandle ?? "", "Runtime check executor handle");
    text(value.executorExecutionId ?? "", "Runtime check executor execution ID");
  } else {
    text(value.systemAdapterId ?? "", "Check system adapter ID");
  }
  if (value.outputHash !== undefined) sha256(value.outputHash, "Check output hash");
  if (value.outputSummary !== undefined) text(value.outputSummary, "Check output summary", 4_000);
  texts(value.artifactVersionIds, "ArtifactVersion ID", 100);
  texts(value.evidenceBriefIds, "EvidenceBrief ID", 100);
  texts(value.metricObservationIds, "MetricObservation ID", 100);
  texts(value.humanAttestationIds, "HumanAttestation ID", 100);
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0)) {
    throw new Error("Check duration은 0 이상의 정수여야 합니다");
  }
  const terminal = ["passed", "failed", "blocked", "cancelled"].includes(value.status);
  if (terminal !== (value.completedAt !== undefined)) throw new Error("Terminal check와 completedAt이 일치해야 합니다");
  if ((value.status === "passed" || value.status === "failed") && !value.outputHash) {
    throw new Error("판정된 check에는 output hash가 필요합니다");
  }
  isoDateTime(value.createdAt, "Check createdAt");
  if (value.startedAt !== undefined) isoDateTime(value.startedAt, "Check startedAt");
  if (value.completedAt !== undefined) isoDateTime(value.completedAt, "Check completedAt");
}

export function validateAssuranceFinding(value: AssuranceFinding): void {
  common(value, value.findingId, "Finding");
  sha256(value.fingerprint, "Finding fingerprint");
  oneOf(value.category, "Finding category", ["correctness", "security", "reliability", "operability", "supply-chain"]);
  oneOf(value.severity, "Finding severity", ["critical", "major", "minor", "info"]);
  oneOf(value.status, "Finding status", ["open", "resolved", "accepted"]);
  text(value.message, "Finding message", 4_000);
  if (value.locationJson !== undefined) text(value.locationJson, "Finding location", 4_000);
  texts(value.evidenceReferenceIds, "Finding evidence reference", 100);
  texts(value.controlReferences, "Finding control reference", 50);
  const resolution = [value.resolutionReason, value.resolutionActorId, value.resolvedAt];
  if (value.status === "open") {
    if (resolution.some((item) => item !== undefined))
      throw new Error("Open finding에는 resolution metadata가 없어야 합니다");
  } else {
    if (!value.resolutionReason?.trim() || !value.resolutionActorId?.trim() || value.resolvedAt === undefined) {
      throw new Error("Resolved·accepted finding에는 reason·actor·time이 필요합니다");
    }
    text(value.resolutionReason, "Finding resolution reason", 2_000);
    text(value.resolutionActorId, "Finding resolution actor");
    isoDateTime(value.resolvedAt, "Finding resolvedAt");
  }
  isoDateTime(value.createdAt, "Finding createdAt");
}

export function validateHumanAttestation(value: HumanAttestation): void {
  common(value, value.attestationId, "Attestation");
  text(value.criterionId, "Criterion ID");
  text(value.attestorUserId, "Attestor user ID");
  sha256(value.statementHash, "Attestation statement hash");
  sha256(value.snapshotHash, "Attestation snapshot hash");
  if (typeof value.accepted !== "boolean") throw new Error("Attestation accepted는 boolean이어야 합니다");
  text(value.commandId, "Attestation command ID");
  sha256(value.requestHash, "Attestation request hash");
  isoDateTime(value.createdAt, "Attestation createdAt");
}

export function validateMetricObservation(value: MetricObservation): void {
  common(value, value.observationId, "MetricObservation");
  oneOf(value.producerKind, "Metric producer kind", ["runtime_execution", "system_adapter"]);
  text(value.producerId, "Metric producer ID");
  oneOf(value.sourceKind, "Metric source kind", ["artifact_version", "runtime_execution"]);
  text(value.sourceId, "Metric source ID");
  if (!Number.isFinite(value.value) || Math.abs(value.value) >= 9_000_000_000_000_000_000) {
    throw new Error("Metric value는 지원 범위 안의 유한한 수여야 합니다");
  }
  text(value.unit, "Metric unit", 100);
  sha256(value.checksum, "Metric checksum");
  isoDateTime(value.measuredAt, "Metric measuredAt");
  isoDateTime(value.createdAt, "Metric createdAt");
}
