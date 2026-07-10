import { describe, expect, it } from "vitest";

import {
  assertNoCallerRecordsProjection,
  validateDocumentationImpactAssessment,
  validateRecordsDocument,
  validateRecordsRun,
} from "./contracts.js";
import type {
  DocumentationImpactAssessment,
  RecordsDocument,
  RecordsRun,
} from "./contracts.js";

const now = "2026-07-11T00:00:00.000Z";

function run(): RecordsRun {
  return {
    recordsRunId: "records-run-1",
    organizationId: "organization-1",
    workId: "work-1",
    targetWorkRevision: 9,
    verificationId: "verification-1",
    assuranceRunId: "assurance-run-1",
    snapshotHash: "a".repeat(64),
    rendererVersion: "massion.records.markdown.v1",
    status: "planned",
    version: 1,
    attempt: 1,
    commandId: "records:start:1",
    requestHash: "b".repeat(64),
    createdByUserId: "user-1",
    startedAt: now,
    updatedAt: now,
  };
}

function impact(): DocumentationImpactAssessment {
  return {
    assessmentId: "assessment-1",
    organizationId: "organization-1",
    workId: "work-1",
    recordsRunId: "records-run-1",
    kind: "adr",
    outcome: "required",
    ruleId: "decision.accepted.v1",
    reason: "사용자가 승인한 구조 결정이 있습니다",
    sourceReferenceIds: ["message-1"],
    evaluatorVersion: "massion.records.impact.v1",
    createdAt: now,
  };
}

function document(): RecordsDocument {
  return {
    documentId: "document-1",
    organizationId: "organization-1",
    workId: "work-1",
    recordsRunId: "records-run-1",
    kind: "adr",
    schemaVersion: "massion.records.adr.v1",
    rendererVersion: "massion.records.markdown.v1",
    sourceJson: "{}",
    sourceChecksum: "c".repeat(64),
    markdownChecksum: "d".repeat(64),
    artifactVersionId: "artifact-version-1",
    createdAt: now,
  };
}

describe("Records 공개 계약", () => {
  it("완료 대상 Work revision과 run terminal metadata를 검증한다", () => {
    expect(() => validateRecordsRun(run())).not.toThrow();
    expect(() => validateRecordsRun({ ...run(), targetWorkRevision: 0 })).toThrow("revision");
    expect(() => validateRecordsRun({ ...run(), status: "completed" })).toThrow("terminal");
    expect(() => validateRecordsRun({ ...run(), status: "completed", completedAt: now })).not.toThrow();
  });

  it("필수 문서는 실제 source reference를 요구한다", () => {
    expect(() => validateDocumentationImpactAssessment(impact())).not.toThrow();
    expect(() =>
      validateDocumentationImpactAssessment({ ...impact(), sourceReferenceIds: [] }),
    ).toThrow("source");
    expect(() =>
      validateDocumentationImpactAssessment({ ...impact(), reason: "x".repeat(2_001) }),
    ).toThrow("2000자");
  });

  it("저장 문서 checksum과 caller projection 경계를 검증한다", () => {
    expect(() => validateRecordsDocument(document())).not.toThrow();
    expect(() => validateRecordsDocument({ ...document(), markdownChecksum: "caller-value" })).toThrow("SHA-256");
    expect(() => assertNoCallerRecordsProjection({ reason: "ok" })).not.toThrow();
    expect(() => assertNoCallerRecordsProjection({ markdownChecksum: "caller-value" })).toThrow("caller");
    expect(() => assertNoCallerRecordsProjection({ status: "completed" })).toThrow("caller");
  });
});
