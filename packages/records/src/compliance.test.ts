import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createBackup, createDatabase, restoreBackup } from "@massion/storage";

import {
  auditRecordsCompletionLineage,
  RecordsComplianceAuditor,
  type RecordsCompletionLineage,
} from "./compliance.js";
import { renderDocument, type ChangelogDocumentSource } from "./renderer.js";

const source: ChangelogDocumentSource = {
  kind: "changelog",
  title: "Records completion",
  sourceReferenceIds: ["event-public-1"],
  category: "security",
  audience: "Massion 사용자",
  notableChange: "검증된 기록 계보 없이는 완료할 수 없습니다.",
};
const rendered = renderDocument(source);

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} fixture가 없습니다`);
  return value;
}

function lineage(): RecordsCompletionLineage {
  return {
    workId: "work-1",
    workStatus: "completed",
    workRevision: 11,
    workEventSequence: [
      { sequence: 8, eventType: "verification_recorded" },
      { sequence: 9, eventType: "records_finalized" },
      { sequence: 10, eventType: "work_state_changed" },
    ],
    run: {
      recordsRunId: "records-run-1",
      status: "completed",
      targetWorkRevision: 9,
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      snapshotHash: "a".repeat(64),
      rendererVersion: "massion.records.markdown.v1",
    },
    recordsEventSequence: [
      { sequence: 1, eventType: "records_run_started" },
      { sequence: 2, eventType: "records_impacts_evaluated" },
      { sequence: 3, eventType: "records_document_rendered" },
      { sequence: 4, eventType: "records_run_completed" },
    ],
    verification: {
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      passed: true,
      projectedWorkRevision: 9,
    },
    record: {
      finalized: true,
      recordedWorkRevision: 10,
      recordsRunId: "records-run-1",
      recordsSnapshotHash: "a".repeat(64),
      verificationIds: ["verification-1"],
      documentIds: ["document-1"],
      artifactVersionIds: ["artifact-version-1"],
      schemaVersion: "massion.work-record.v1",
    },
    assessments: [
      { kind: "work-record", outcome: "required" },
      { kind: "adr", outcome: "not-applicable" },
      { kind: "changelog", outcome: "required" },
      { kind: "runbook", outcome: "not-applicable" },
    ],
    documents: [
      {
        documentId: "document-1",
        kind: "changelog",
        sourceJson: rendered.sourceJson,
        sourceChecksum: rendered.sourceChecksum,
        markdownChecksum: rendered.markdownChecksum,
        rendererVersion: rendered.rendererVersion,
        artifactVersionId: "artifact-version-1",
      },
    ],
    artifacts: [
      {
        artifactVersionId: "artifact-version-1",
        checksum: rendered.markdownChecksum,
        content: rendered.markdown,
      },
    ],
  };
}

describe("Records completed lineage audit", () => {
  it("유효한 N+1→N+2→N+3 계보를 승인한다", () => {
    expect(auditRecordsCompletionLineage(lineage())).toEqual([]);
  });

  it.each([
    [
      "snapshot",
      (value: RecordsCompletionLineage) => ({
        ...value,
        record: { ...value.record, recordsSnapshotHash: "b".repeat(64) },
      }),
    ],
    [
      "source",
      (value: RecordsCompletionLineage) => ({
        ...value,
        documents: [{ ...first(value.documents, "document"), sourceJson: "{}" }],
      }),
    ],
    [
      "artifact",
      (value: RecordsCompletionLineage) => ({
        ...value,
        artifacts: [{ ...first(value.artifacts, "artifact"), content: "tampered" }],
      }),
    ],
    ["assessment", (value: RecordsCompletionLineage) => ({ ...value, assessments: value.assessments.slice(0, 3) })],
    [
      "verification",
      (value: RecordsCompletionLineage) => ({
        ...value,
        verification: { ...value.verification, verificationId: "other" },
      }),
    ],
    [
      "event",
      (value: RecordsCompletionLineage) => ({
        ...value,
        recordsEventSequence: value.recordsEventSequence.slice().reverse(),
      }),
    ],
  ] as const)("%s 변조를 finding으로 검출한다", (code, mutate) => {
    expect(auditRecordsCompletionLineage(mutate(lineage())).map((finding) => finding.code)).toContain(code);
  });

  it("저장 checksum 자체를 공격자가 다시 계산해도 renderer byte 불일치를 검출한다", () => {
    const value = lineage();
    const content = `${rendered.markdown}\nattacker`;
    const checksum = createHash("sha256").update(content).digest("hex");
    const findings = auditRecordsCompletionLineage({
      ...value,
      documents: [{ ...first(value.documents, "document"), markdownChecksum: checksum }],
      artifacts: [{ ...first(value.artifacts, "artifact"), checksum, content }],
    });
    expect(findings.map((finding) => finding.code)).toContain("artifact");
  });
});

describe("restored Records database audit", () => {
  it("유효한 backup은 승인하고 복원 후 snapshot 변조는 거부한다", async () => {
    await using sourceDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const value = lineage();
    await sourceDatabase.query(
      `
DEFINE TABLE work SCHEMALESS; DEFINE TABLE work_event SCHEMALESS; DEFINE TABLE records_run SCHEMALESS;
DEFINE TABLE records_event SCHEMALESS; DEFINE TABLE work_verification SCHEMALESS; DEFINE TABLE work_record SCHEMALESS;
DEFINE TABLE documentation_impact_assessment SCHEMALESS; DEFINE TABLE records_document SCHEMALESS; DEFINE TABLE artifact_version SCHEMALESS;
CREATE work CONTENT { organization_id: 'organization-1', work_id: 'work-1', status: 'completed', revision: 11, records_schema_version: 'massion.work.records.v1' };
CREATE records_run CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', status: 'completed', target_work_revision: 9, verification_id: 'verification-1', assurance_run_id: 'assurance-run-1', snapshot_hash: $snapshot_hash, renderer_version: $renderer_version };
CREATE work_verification CONTENT { organization_id: 'organization-1', work_id: 'work-1', verification_id: 'verification-1', assurance_run_id: 'assurance-run-1', passed: true, projected_work_revision: 9, created_at: time::now() };
CREATE work_record CONTENT { organization_id: 'organization-1', work_id: 'work-1', work_record_id: 'record-1', version: 1, finalized: true, recorded_work_revision: 10, records_run_id: 'records-run-1', records_snapshot_hash: $snapshot_hash, verification_ids: ['verification-1'], document_ids: ['document-1'], artifact_version_ids: ['artifact-version-1'], schema_version: 'massion.work-record.v1' };
CREATE documentation_impact_assessment CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', kind: 'work-record', outcome: 'required' };
CREATE documentation_impact_assessment CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', kind: 'adr', outcome: 'not-applicable' };
CREATE documentation_impact_assessment CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', kind: 'changelog', outcome: 'required' };
CREATE documentation_impact_assessment CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', kind: 'runbook', outcome: 'not-applicable' };
CREATE records_document CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', document_id: 'document-1', kind: 'changelog', source_json: $source_json, source_checksum: $source_checksum, markdown_checksum: $markdown_checksum, renderer_version: $renderer_version, artifact_version_id: 'artifact-version-1' };
CREATE artifact_version CONTENT { organization_id: 'organization-1', work_id: 'work-1', artifact_version_id: 'artifact-version-1', checksum: $markdown_checksum, content_json: $markdown };
CREATE work_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', sequence: 8, event_type: 'verification_recorded' };
CREATE work_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', sequence: 9, event_type: 'records_finalized' };
CREATE work_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', sequence: 10, event_type: 'work_state_changed' };
CREATE records_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', sequence: 1, event_type: 'records_run_started' };
CREATE records_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', sequence: 2, event_type: 'records_impacts_evaluated' };
CREATE records_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', sequence: 3, event_type: 'records_document_rendered' };
CREATE records_event CONTENT { organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', sequence: 4, event_type: 'records_run_completed' };
`,
      {
        snapshot_hash: value.run.snapshotHash,
        renderer_version: value.run.rendererVersion,
        source_json: value.documents[0]?.sourceJson,
        source_checksum: value.documents[0]?.sourceChecksum,
        markdown_checksum: value.documents[0]?.markdownChecksum,
        markdown: value.artifacts[0]?.content,
      },
    );
    const backup = await createBackup(sourceDatabase);
    await using restored = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await restoreBackup(restored, backup);
    const auditor = new RecordsComplianceAuditor(restored);
    await expect(auditor.assertDatabaseCompliance()).resolves.toBeUndefined();

    await restored.query("UPDATE work_record SET records_snapshot_hash = $hash;", { hash: "b".repeat(64) });
    await expect(auditor.assertDatabaseCompliance()).rejects.toThrow("snapshot");
  });
});
