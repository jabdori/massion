import { createHash } from "node:crypto";

import type {
  AssuranceCheckStatus,
  AssuranceCriterionStatus,
  AssuranceFindingSeverity,
  AssuranceFindingStatus,
} from "./contracts.js";

export interface AssuranceVerdictCriterionInput {
  readonly criterionId: string;
  readonly status: AssuranceCriterionStatus;
}

export interface AssuranceVerdictCheckInput {
  readonly criterionId: string;
  readonly bindingKey: string;
  readonly status: AssuranceCheckStatus;
  readonly outputHash?: string;
}

export interface AssuranceVerdictFindingInput {
  readonly findingId: string;
  readonly severity: AssuranceFindingSeverity;
  readonly status: AssuranceFindingStatus;
}

export interface AssuranceVerdictDecisionInput {
  readonly cancellationRequested: boolean;
  readonly snapshotStatus: "fresh" | "stale" | "invalid";
  readonly identityValid: boolean;
  readonly bindingValid: boolean;
  readonly independenceValid: boolean;
  readonly verifierSucceeded: boolean;
  readonly requiredEvidenceComplete: boolean;
  readonly criteria: readonly AssuranceVerdictCriterionInput[];
  readonly checks: readonly AssuranceVerdictCheckInput[];
  readonly findings: readonly AssuranceVerdictFindingInput[];
}

export type AssuranceVerdictDecision =
  | { readonly status: "cancelled"; readonly evidenceHash: string }
  | {
      readonly status: "passed" | "failed" | "blocked";
      readonly evidenceHash: string;
      readonly failure?: { readonly category: string; readonly causeHash: string };
    };

const CRITERION_STATUSES = new Set<AssuranceCriterionStatus>(["pending", "passed", "failed", "blocked", "excluded"]);
const CHECK_STATUSES = new Set<AssuranceCheckStatus>([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);
const FINDING_SEVERITIES = new Set<AssuranceFindingSeverity>(["critical", "major", "minor", "info"]);
const FINDING_STATUSES = new Set<AssuranceFindingStatus>(["open", "resolved", "accepted"]);

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

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function unknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function criterion(value: unknown): value is AssuranceVerdictCriterionInput {
  return (
    record(value) &&
    text(value.criterionId) &&
    typeof value.status === "string" &&
    CRITERION_STATUSES.has(value.status as AssuranceCriterionStatus)
  );
}

function check(value: unknown): value is AssuranceVerdictCheckInput {
  if (
    !record(value) ||
    !text(value.criterionId) ||
    !text(value.bindingKey) ||
    typeof value.status !== "string" ||
    !CHECK_STATUSES.has(value.status as AssuranceCheckStatus)
  ) {
    return false;
  }
  return (
    !["passed", "failed"].includes(value.status) ||
    (typeof value.outputHash === "string" && /^[a-f0-9]{64}$/u.test(value.outputHash))
  );
}

function finding(value: unknown): value is AssuranceVerdictFindingInput {
  return (
    record(value) &&
    text(value.findingId) &&
    typeof value.severity === "string" &&
    FINDING_SEVERITIES.has(value.severity as AssuranceFindingSeverity) &&
    typeof value.status === "string" &&
    FINDING_STATUSES.has(value.status as AssuranceFindingStatus)
  );
}

function decision(
  status: "passed" | "failed" | "blocked",
  evidenceHash: string,
  category?: string,
): AssuranceVerdictDecision {
  return {
    status,
    evidenceHash,
    ...(category ? { failure: { category, causeHash: sha256(canonicalJson({ category, evidenceHash })) } } : {}),
  };
}

function structurallyValid(input: AssuranceVerdictDecisionInput): boolean {
  const candidate = input as unknown as Readonly<Record<string, unknown>>;
  const rawCriteria = candidate.criteria;
  const rawChecks = candidate.checks;
  const rawFindings = candidate.findings;
  if (
    typeof input.cancellationRequested !== "boolean" ||
    !["fresh", "stale", "invalid"].includes(input.snapshotStatus) ||
    [
      input.identityValid,
      input.bindingValid,
      input.independenceValid,
      input.verifierSucceeded,
      input.requiredEvidenceComplete,
    ].some((value) => typeof value !== "boolean") ||
    !unknownArray(rawCriteria) ||
    !unknownArray(rawChecks) ||
    !unknownArray(rawFindings) ||
    rawCriteria.length > 1_000 ||
    rawChecks.length > 10_000 ||
    rawFindings.length > 10_000
  ) {
    return false;
  }
  const criteria = rawCriteria.filter(criterion);
  const checks = rawChecks.filter(check);
  const findings = rawFindings.filter(finding);
  if (
    criteria.length !== rawCriteria.length ||
    new Set(criteria.map((item) => item.criterionId)).size !== criteria.length
  ) {
    return false;
  }
  if (checks.length !== rawChecks.length || new Set(checks.map((item) => item.bindingKey)).size !== checks.length) {
    return false;
  }
  if (
    findings.length !== rawFindings.length ||
    new Set(findings.map((item) => item.findingId)).size !== findings.length
  ) {
    return false;
  }
  const criterionIds = new Set(criteria.map((item) => item.criterionId));
  return checks.every((item) => criterionIds.has(item.criterionId));
}

export function decideAssuranceVerdict(input: AssuranceVerdictDecisionInput): AssuranceVerdictDecision {
  const caller = input as unknown as Readonly<Record<string, unknown>>;
  const injected = ["verdict", "target"].find((key) => key in caller);
  if (injected) throw new Error(`caller verdict 주입은 허용되지 않습니다: ${injected}`);
  const evidenceHash = sha256(canonicalJson(input));
  if (input.cancellationRequested) return { status: "cancelled", evidenceHash };
  if (input.snapshotStatus !== "fresh" || !input.identityValid || !input.bindingValid || !input.independenceValid) {
    return decision("blocked", evidenceHash, "assurance_integrity_blocked");
  }
  if (!structurallyValid(input)) return decision("blocked", evidenceHash, "assurance_evidence_blocked");
  const definiteFailure =
    input.criteria.some((criterion) => criterion.status === "failed") ||
    input.checks.some((check) => check.status === "failed") ||
    input.findings.some(
      (finding) =>
        (finding.status === "open" && finding.severity !== "info") ||
        (finding.status === "accepted" && (finding.severity === "critical" || finding.severity === "major")),
    );
  if (definiteFailure) return decision("failed", evidenceHash, "assurance_criterion_failed");
  const activeCriteria = input.criteria.filter((criterion) => criterion.status !== "excluded");
  const blocked =
    !input.verifierSucceeded ||
    !input.requiredEvidenceComplete ||
    activeCriteria.length === 0 ||
    activeCriteria.some((criterion) => criterion.status !== "passed") ||
    activeCriteria.some((criterion) => !input.checks.some((check) => check.criterionId === criterion.criterionId)) ||
    input.checks.some((check) => check.status !== "passed");
  if (blocked) return decision("blocked", evidenceHash, "assurance_evidence_blocked");
  return decision("passed", evidenceHash);
}
