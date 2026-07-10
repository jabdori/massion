import { describe, expect, it } from "vitest";

import { auditAssuranceCompletionLineage, type AssuranceCompletionLineage } from "./compliance.js";

function lineage(overrides: Partial<AssuranceCompletionLineage> = {}): AssuranceCompletionLineage {
  return {
    workId: "work-1",
    workRevision: 10,
    workArtifactVersionIds: ["artifact-version-1"],
    verificationId: "verification-1",
    verificationPassed: true,
    verificationAssuranceRunId: "run-1",
    verificationTargetWorkRevision: 7,
    verificationProjectedWorkRevision: 8,
    verificationSnapshotHash: "a".repeat(64),
    verificationProfileId: "massion.assurance.acceptance.v1",
    verificationProfileVersion: "1.0.0",
    verificationBindingVersionId: "binding-1",
    verificationEvidenceArtifactVersionId: "artifact-version-1",
    runId: "run-1",
    runStatus: "passed",
    runVerdict: "passed",
    runTargetWorkRevision: 7,
    runProjectedWorkRevision: 8,
    runSnapshotHash: "a".repeat(64),
    runProfileId: "massion.assurance.acceptance.v1",
    runProfileVersion: "1.0.0",
    runBindingVersionId: "binding-1",
    runDecisionEvidenceHash: "b".repeat(64),
    decisionEvidenceValid: true,
    runDecisionGuardRevision: 4,
    currentEvidenceGuardRevision: 5,
    recordFinalized: true,
    recordRecordedWorkRevision: 9,
    recordVerificationIds: ["verification-1"],
    evidenceArtifactChecksumValid: true,
    evidenceArtifactLineageValid: true,
    snapshotFresh: true,
    independenceValid: true,
    ...overrides,
  };
}

describe("복원 후 completed Work Assurance 준수 감사", () => {
  it("exact passed run·verification·record·artifact·snapshot·guard 계보만 승인한다", () => {
    expect(auditAssuranceCompletionLineage(lineage())).toEqual([]);
  });

  it.each([
    [{ verificationPassed: false }, "verification"],
    [{ runStatus: "failed", runVerdict: "failed" }, "run-verdict"],
    [{ verificationAssuranceRunId: "other-run" }, "lineage"],
    [{ decisionEvidenceValid: false }, "lineage"],
    [{ recordVerificationIds: [] }, "record"],
    [{ evidenceArtifactChecksumValid: false }, "artifact"],
    [{ snapshotFresh: false }, "snapshot"],
    [{ independenceValid: false }, "independence"],
    [{ currentEvidenceGuardRevision: 4 }, "evidence-guard"],
  ] as const)("복원 계보 위반 %j를 %s finding으로 보고한다", (overrides, code) => {
    expect(auditAssuranceCompletionLineage(lineage(overrides))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });
});
