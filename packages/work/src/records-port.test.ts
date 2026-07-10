import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  WorkRecordsPort,
  type FinalizeRecordsProjectionInput,
  type RecordsProjectionDocumentInput,
} from "./records-port.js";
import { WorkService } from "./work.js";
import { WORK_RECORDS_COMPLETION_MIGRATION, WORK_RECORDS_LINK_MIGRATION } from "./schema.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Work Records N+2 projection", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let works: WorkService;
  let port: WorkRecordsPort;
  let workId: string;
  let document: RecordsProjectionDocumentInput;

  it("0048 Work Records linkage migration checksum을 고정한다", () => {
    expect(WORK_RECORDS_LINK_MIGRATION.id).toBe("0048-work-records-link");
    expect(WORK_RECORDS_LINK_MIGRATION.checksum).toBe(
      "e7b9a4914870e7c26ec02520f55bc8965c41c59de696952a6a2c3113c4c0fd74",
    );
    expect(WORK_RECORDS_COMPLETION_MIGRATION.id).toBe("0049-work-records-completion");
    expect(WORK_RECORDS_COMPLETION_MIGRATION.checksum).toBe(
      "76c7c803b7803d362df0801320fc4f31af33477ac3f77bcd087497820b009e1c",
    );
  });

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "work-records@example.com",
      displayName: "Work Records",
    });
    const other = await identity.registerPersonalUser({
      email: "other-work-records@example.com",
      displayName: "Other Work Records",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    works = await WorkService.create(database, organizations);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "Records projection",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    workId = created.work.work_id;
    await database.query(
      `
UPDATE work SET status = 'planned', revision = 2 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'ready', revision = 3 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'running', revision = 4 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'verifying', revision = 5 WHERE organization_id = $organization_id AND work_id = $work_id;
CREATE work_verification CONTENT { verification_id: 'verification-1', organization_id: $organization_id, work_id: $work_id, verifier_id: 'assurance', passed: true, criteria_json: '{}', evidence_artifact_version_ids: [], created_at: time::now() };
DEFINE TABLE records_run SCHEMALESS;
DEFINE TABLE records_event SCHEMALESS;
DEFINE TABLE documentation_impact_assessment SCHEMALESS;
DEFINE TABLE records_document SCHEMALESS;
CREATE records_run CONTENT { records_run_id: 'records-run-1', organization_id: $organization_id, work_id: $work_id, target_work_revision: 5, verification_id: 'verification-1', assurance_run_id: 'assurance-run-1', snapshot_hash: $snapshot_hash, renderer_version: 'massion.records.markdown.v1', status: 'rendering', version: 2 };
CREATE documentation_impact_assessment CONTENT { assessment_id: 'assessment-work-record', organization_id: $organization_id, work_id: $work_id, records_run_id: 'records-run-1', kind: 'work-record', outcome: 'required' };
CREATE documentation_impact_assessment CONTENT { assessment_id: 'assessment-adr', organization_id: $organization_id, work_id: $work_id, records_run_id: 'records-run-1', kind: 'adr', outcome: 'required' };
CREATE documentation_impact_assessment CONTENT { assessment_id: 'assessment-changelog', organization_id: $organization_id, work_id: $work_id, records_run_id: 'records-run-1', kind: 'changelog', outcome: 'not-applicable' };
CREATE documentation_impact_assessment CONTENT { assessment_id: 'assessment-runbook', organization_id: $organization_id, work_id: $work_id, records_run_id: 'records-run-1', kind: 'runbook', outcome: 'not-applicable' };
`,
      { organization_id: context.organizationId, work_id: workId, snapshot_hash: "a".repeat(64) },
    );
    await database.query("REMOVE EVENT IF EXISTS work_assurance_completion_guard ON TABLE work;");
    port = await WorkRecordsPort.create(database, organizations);
    const sourceJson = JSON.stringify({
      kind: "adr",
      title: "기록 투영 결정",
      sourceReferenceIds: ["message-1"],
    });
    const markdown = "# 기록 투영 결정\n\n## Status\n\nAccepted\n";
    document = {
      documentId: "document-adr-1",
      kind: "adr",
      schemaVersion: "massion.records.adr.v1",
      rendererVersion: "massion.records.markdown.v1",
      sourceJson,
      sourceChecksum: sha256(sourceJson),
      markdown,
      markdownChecksum: sha256(markdown),
    };
  });

  afterEach(async () => database.close());

  function input(commandId: string = crypto.randomUUID()): FinalizeRecordsProjectionInput {
    return {
      commandId,
      workId,
      expectedRevision: 5,
      recordsRunId: "records-run-1",
      recordsSnapshotHash: "a".repeat(64),
      verificationId: "verification-1",
      documents: [document],
    };
  }

  it("문서 ArtifactVersion·WorkRecord·event와 Work N+2를 한 transaction에 만든다", async () => {
    const result = await port.finalize(context, input());

    expect(result.work.revision).toBe(6);
    expect(result.event.event_type).toBe("records_finalized");
    expect(result.record).toMatchObject({
      recorded_work_revision: 6,
      records_run_id: "records-run-1",
      records_snapshot_hash: "a".repeat(64),
      document_ids: ["document-adr-1"],
      schema_version: "massion.work-record.v1",
    });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      document_id: "document-adr-1",
      artifact_version_id: result.artifactVersions[0]?.artifact_version_id,
      markdown_checksum: document.markdownChecksum,
    });
    expect(result.artifactVersions[0]).toMatchObject({
      media_type: "text/markdown; charset=utf-8",
      checksum: document.markdownChecksum,
      content_json: document.markdown,
    });
    const [recordsEvents] = await database.query<[{ event_type: string; sequence: number }[]]>(
      "SELECT event_type, sequence FROM records_event WHERE records_run_id = 'records-run-1' ORDER BY sequence ASC;",
    );
    expect(recordsEvents).toContainEqual({ event_type: "records_document_rendered", sequence: 3 });
  });

  it("같은 command를 멱등 재생하고 다른 payload는 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await port.finalize(context, input(commandId));
    const repeated = await port.finalize(context, input(commandId));
    expect(repeated.record.work_record_id).toBe(first.record.work_record_id);
    await expect(
      port.finalize(context, {
        ...input(commandId),
        documents: [
          { ...document, markdown: `${document.markdown}\n`, markdownChecksum: sha256(`${document.markdown}\n`) },
        ],
      }),
    ).rejects.toThrow("다른 명령");
  });

  it("stale·tenant·run·checksum·duplicate·caller summary를 거부한다", async () => {
    await expect(port.finalize(context, { ...input(), expectedRevision: 4 })).rejects.toThrow("revision");
    await expect(port.finalize(otherContext, input())).rejects.toThrow("찾을 수 없습니다");
    await expect(port.finalize(context, { ...input(), recordsRunId: "unknown" })).rejects.toThrow("Records run");
    await expect(
      port.finalize(context, { ...input(), documents: [{ ...document, markdownChecksum: "b".repeat(64) }] }),
    ).rejects.toThrow("checksum");
    await expect(port.finalize(context, { ...input(), documents: [document, document] })).rejects.toThrow("중복");
    await expect(
      port.finalize(context, { ...input(), summary: "caller summary" } as unknown as FinalizeRecordsProjectionInput),
    ).rejects.toThrow("summary");
  });

  it("required assessment와 정확히 같은 document kind만 허용한다", async () => {
    await expect(port.finalize(context, { ...input(), documents: [] })).rejects.toThrow("required");
    await database.query(
      "UPDATE documentation_impact_assessment SET outcome = 'required' WHERE records_run_id = 'records-run-1' AND kind = 'runbook';",
    );
    await expect(port.finalize(context, input())).rejects.toThrow("required");
  });

  it("Records run이 시작된 Work의 legacy summary와 direct DB record 우회를 거부한다", async () => {
    await expect(
      works.finalizeRecord(context, {
        commandId: crypto.randomUUID(),
        workId,
        expectedRevision: 5,
        summary: "legacy summary",
      }),
    ).rejects.toThrow("Records projection");
    await expect(
      database.query(
        "CREATE work_record CONTENT { work_record_id: 'bypass-record', organization_id: $organization_id, work_id: $work_id, version: 1, recorded_work_revision: 6, summary: 'bypass', event_start_sequence: 1, event_end_sequence: 1, decision_message_ids: [], artifact_version_ids: [], verification_ids: ['verification-1'], finalized: true, finalized_by: $user_id, finalized_at: time::now() };",
        { organization_id: context.organizationId, work_id: workId, user_id: context.userId },
      ),
    ).rejects.toThrow("Records projection");
  });

  it("N+2 계보와 문서 checksum이 정확할 때만 N+3 completed를 만든다", async () => {
    const finalized = await port.finalize(context, input());
    const completed = await port.complete(context, {
      commandId: "records-run-1:complete",
      workId,
      expectedRevision: finalized.work.revision,
      recordsRunId: "records-run-1",
      recordsSnapshotHash: "a".repeat(64),
      verificationId: "verification-1",
    });

    expect(completed.work).toMatchObject({ status: "completed", revision: 7 });
    expect(completed.event.event_type).toBe("work_state_changed");
    const repeated = await port.complete(context, {
      commandId: "records-run-1:complete",
      workId,
      expectedRevision: finalized.work.revision,
      recordsRunId: "records-run-1",
      recordsSnapshotHash: "a".repeat(64),
      verificationId: "verification-1",
    });
    expect(repeated.event.event_id).toBe(completed.event.event_id);
  });

  it("문서 Artifact 내용 변조와 direct completed 우회를 DB gate에서 거부한다", async () => {
    await expect(
      database.query(
        "UPDATE work SET status = 'completed', revision = 6 WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      ),
    ).rejects.toThrow("Records");

    const finalized = await port.finalize(context, input());
    await database.query(
      "UPDATE artifact_version SET content_json = 'tampered' WHERE organization_id = $organization_id AND artifact_version_id = $artifact_version_id;",
      {
        organization_id: context.organizationId,
        artifact_version_id: finalized.artifactVersions[0]?.artifact_version_id,
      },
    );
    await expect(
      port.complete(context, {
        commandId: "records-run-1:complete",
        workId,
        expectedRevision: finalized.work.revision,
        recordsRunId: "records-run-1",
        recordsSnapshotHash: "a".repeat(64),
        verificationId: "verification-1",
      }),
    ).rejects.toThrow("checksum");
  });
});
