import { describe, expect, it } from "vitest";

import {
  validateAssuranceCheck,
  validateAssuranceCriterion,
  validateAssuranceFinding,
  validateHumanAttestation,
  validateMetricObservation,
} from "./contract-validation.js";
import type {
  AssuranceCheck,
  AssuranceCriterion,
  AssuranceFinding,
  HumanAttestation,
  MetricObservation,
} from "./contracts.js";

const common = { organizationId: "organization-1", workId: "work-1", assuranceRunId: "run-1" };
const now = "2026-07-10T00:00:00.000Z";

function criterion(): AssuranceCriterion {
  return {
    ...common,
    criterionId: "criterion-1",
    criterionKey: "criterion:test",
    source: "plan",
    statement: "테스트를 통과한다",
    method: "test",
    requiredEvidenceKinds: ["command"],
    controlReferences: [],
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function check(): AssuranceCheck {
  return {
    ...common,
    checkId: "check-1",
    criterionId: "criterion-1",
    kind: "command",
    systemAdapterId: "massion.command.v1",
    commandKey: "check:test",
    inputHash: "a".repeat(64),
    status: "pending",
    artifactVersionIds: [],
    evidenceBriefIds: [],
    metricObservationIds: [],
    humanAttestationIds: [],
    createdAt: now,
  };
}

function finding(): AssuranceFinding {
  return {
    ...common,
    findingId: "finding-1",
    fingerprint: "b".repeat(64),
    category: "security",
    severity: "major",
    status: "open",
    message: "권한 검사가 필요합니다",
    evidenceReferenceIds: ["evidence-1"],
    controlReferences: [],
    createdAt: now,
  };
}

it("criterion bound와 excluded metadata 조합을 검증한다", () => {
  expect(() => validateAssuranceCriterion(criterion())).not.toThrow();
  expect(() => validateAssuranceCriterion({ ...criterion(), statement: "x".repeat(2_001) })).toThrow("2000자");
  expect(() => validateAssuranceCriterion({ ...criterion(), status: "excluded" })).toThrow("rule·reason·actor");
  expect(() =>
    validateAssuranceCriterion({
      ...criterion(),
      status: "excluded",
      exclusionRule: "cancelled-task-only",
      exclusionReason: "Task가 취소됐습니다",
      exclusionActorId: "assurance",
    }),
  ).not.toThrow();
  expect(() =>
    validateAssuranceCriterion({ ...criterion(), status: "garbage" } as unknown as AssuranceCriterion),
  ).toThrow("Criterion status");
});

it("check executor 단일성, terminal metadata와 output bound를 검증한다", () => {
  expect(() => validateAssuranceCheck(check())).not.toThrow();
  expect(() =>
    validateAssuranceCheck({ ...check(), executorHandle: "assurance", executorExecutionId: "execution-1" }),
  ).toThrow("하나여야");
  expect(() => validateAssuranceCheck({ ...check(), executorHandle: "", executorExecutionId: "" })).toThrow("하나여야");
  expect(() => validateAssuranceCheck({ ...check(), status: "passed", completedAt: now })).toThrow("output hash");
  expect(() =>
    validateAssuranceCheck({ ...check(), status: "passed", outputHash: "c".repeat(64), completedAt: now }),
  ).not.toThrow();
});

it("finding resolution 상태와 bounded message를 검증한다", () => {
  expect(() => validateAssuranceFinding(finding())).not.toThrow();
  expect(() => validateAssuranceFinding({ ...finding(), status: "accepted" })).toThrow("reason·actor·time");
  expect(() =>
    validateAssuranceFinding({
      ...finding(),
      status: "accepted",
      resolutionReason: "위험을 기록합니다",
      resolutionActorId: "owner-1",
      resolvedAt: now,
    }),
  ).not.toThrow();
  expect(() => validateAssuranceFinding({ ...finding(), severity: "urgent" } as unknown as AssuranceFinding)).toThrow(
    "Finding severity",
  );
});

describe("attestation·metric 정본", () => {
  const attestation: HumanAttestation = {
    ...common,
    attestationId: "attestation-1",
    criterionId: "criterion-1",
    attestorUserId: "user-1",
    statementHash: "d".repeat(64),
    snapshotHash: "e".repeat(64),
    accepted: true,
    commandId: "attest-1",
    requestHash: "f".repeat(64),
    createdAt: now,
  };
  const observation: MetricObservation = {
    observationId: "observation-1",
    organizationId: common.organizationId,
    workId: common.workId,
    producerKind: "system_adapter",
    producerId: "massion.metric.v1",
    sourceKind: "runtime_execution",
    sourceId: "execution-1",
    value: 99.9,
    unit: "percent",
    checksum: "1".repeat(64),
    measuredAt: now,
    createdAt: now,
  };

  it("human hash와 metric finite value·checksum을 검증한다", () => {
    expect(() => validateHumanAttestation(attestation)).not.toThrow();
    expect(() => validateHumanAttestation({ ...attestation, snapshotHash: "invalid" })).toThrow("SHA-256");
    expect(() => validateHumanAttestation({ ...attestation, accepted: "yes" } as unknown as HumanAttestation)).toThrow(
      "boolean",
    );
    expect(() => validateMetricObservation(observation)).not.toThrow();
    expect(() =>
      validateMetricObservation({ ...observation, producerKind: "manual" } as unknown as MetricObservation),
    ).toThrow("Metric producer kind");
    expect(() => validateMetricObservation({ ...observation, value: Number.NaN })).toThrow("유한한 수");
    expect(() => validateMetricObservation({ ...observation, value: 9_000_000_000_000_000_000 })).toThrow("지원 범위");
  });
});
