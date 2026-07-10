import { describe, expect, it } from "vitest";

import type { HumanAttestation, MetricObservation } from "./contracts.js";
import {
  assertNoCallerVerdict,
  evaluateArtifactEvidenceCheck,
  evaluateHumanAttestationCheck,
  evaluateMetricObservationCheck,
  finalizeCriterionFromChecks,
} from "./checks.js";

const organizationId = "organization-1";
const workId = "work-1";
const assuranceRunId = "run-1";
const criterionId = "criterion-1";

describe("결정론적 Assurance check", () => {
  it("Artifact content·소유권·freshness에서만 evidence check 결과를 계산한다", () => {
    const contentJson = '{"ok":true}';
    const checksum = "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93";
    const result = evaluateArtifactEvidenceCheck({
      organizationId,
      workId,
      observedAt: "2026-07-10T12:00:00.000Z",
      maximumAgeMs: 60_000,
      requiredArtifactVersionIds: ["artifact-1"],
      artifacts: [
        {
          artifactVersionId: "artifact-1",
          organizationId,
          workId,
          contentJson,
          checksum,
          createdAt: "2026-07-10T11:59:30.000Z",
        },
      ],
    });

    expect(result).toMatchObject({ status: "passed", evidenceReferenceIds: ["artifact-1"] });
    expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      evaluateArtifactEvidenceCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        requiredArtifactVersionIds: ["missing"],
        artifacts: [],
      }).status,
    ).toBe("blocked");
  });

  it.each([
    [98.5, ">=" as const, 95, "passed"],
    [94.9, ">=" as const, 95, "failed"],
    [0, "=" as const, 0, "passed"],
    [11, "<" as const, 10, "failed"],
  ])("MetricObservation %s %s %s를 %s로 판정한다", (value, operator, threshold, status) => {
    const observation: MetricObservation = {
      observationId: "metric-1",
      organizationId,
      workId,
      producerKind: "system_adapter",
      producerId: "massion.metric.coverage.v1",
      sourceKind: "artifact_version",
      sourceId: "artifact-1",
      value,
      unit: "percent",
      checksum: "a".repeat(64),
      measuredAt: "2026-07-10T11:59:30.000Z",
      createdAt: "2026-07-10T11:59:31.000Z",
    };
    const result = evaluateMetricObservationCheck({
      organizationId,
      workId,
      observedAt: "2026-07-10T12:00:00.000Z",
      maximumAgeMs: 60_000,
      sourceKind: "artifact_version",
      operator,
      threshold,
      unit: "percent",
      observations: [observation],
    });
    expect(result.status).toBe(status);
    expect(result.metricObservationIds).toEqual(["metric-1"]);
  });

  it("Metric unit·source·freshness가 맞지 않거나 관측이 없으면 통과시키지 않는다", () => {
    const base: MetricObservation = {
      observationId: "metric-1",
      organizationId,
      workId,
      producerKind: "system_adapter",
      producerId: "adapter-1",
      sourceKind: "artifact_version",
      sourceId: "artifact-1",
      value: 100,
      unit: "percent",
      checksum: "a".repeat(64),
      measuredAt: "2026-07-10T10:00:00.000Z",
      createdAt: "2026-07-10T10:00:01.000Z",
    };
    expect(
      evaluateMetricObservationCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        observations: [base],
      }).status,
    ).toBe("blocked");
    expect(
      evaluateMetricObservationCheck({
        organizationId,
        workId,
        observedAt: "2026-07-10T12:00:00.000Z",
        maximumAgeMs: 60_000,
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        observations: [],
      }).status,
    ).toBe("blocked");
  });

  it("현재 eligible Membership의 distinct accept만 세고 reject가 하나라도 있으면 실패한다", () => {
    const attestation = (userId: string, accepted = true): HumanAttestation => ({
      attestationId: `attestation-${userId}`,
      organizationId,
      workId,
      assuranceRunId,
      criterionId,
      attestorUserId: userId,
      statementHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      accepted,
      commandId: `command-${userId}`,
      requestHash: "c".repeat(64),
      createdAt: "2026-07-10T11:59:30.000Z",
    });
    const input = {
      organizationId,
      workId,
      assuranceRunId,
      criterionId,
      statementHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      eligibleRoles: ["owner", "admin"],
      minimumAttestations: 2,
      memberships: [
        { userId: "owner", role: "owner", status: "active" as const },
        { userId: "admin", role: "admin", status: "active" as const },
      ],
      attestations: [attestation("owner"), attestation("admin")],
    };
    expect(evaluateHumanAttestationCheck(input).status).toBe("passed");
    expect(
      evaluateHumanAttestationCheck({ ...input, attestations: [attestation("owner"), attestation("admin", false)] })
        .status,
    ).toBe("failed");
    expect(evaluateHumanAttestationCheck({ ...input, memberships: input.memberships.slice(0, 1) }).status).toBe(
      "blocked",
    );
  });

  it("criterion은 예상된 모든 check evidence의 상태에서만 최종 계산한다", () => {
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
          { bindingKey: "check:metric", status: "passed", outputHash: "b".repeat(64) },
        ],
      }).status,
    ).toBe("passed");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [{ bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) }],
      }).status,
    ).toBe("blocked");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test", "check:metric"],
        checks: [
          { bindingKey: "check:test", status: "failed", outputHash: "a".repeat(64) },
          { bindingKey: "check:metric", status: "blocked", outputHash: "b".repeat(64) },
        ],
      }).status,
    ).toBe("failed");
    expect(finalizeCriterionFromChecks({ expectedBindingKeys: [], checks: [] }).status).toBe("blocked");
    expect(
      finalizeCriterionFromChecks({
        expectedBindingKeys: ["check:test"],
        checks: [
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
          { bindingKey: "check:test", status: "passed", outputHash: "a".repeat(64) },
        ],
      }).status,
    ).toBe("blocked");
  });

  it.each(["passed", "status", "verdict"])("caller의 %s 판정 주입을 거부한다", (key) => {
    expect(() => assertNoCallerVerdict({ commandId: "command-1", [key]: true })).toThrow("caller verdict");
  });
});
