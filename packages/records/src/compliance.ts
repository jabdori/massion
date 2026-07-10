import { createHash } from "node:crypto";

import { renderDocument, type RecordsDocumentSource } from "./renderer.js";
import type { MassionDatabase } from "@massion/storage";

export type RecordsComplianceFindingCode =
  "work" | "snapshot" | "source" | "artifact" | "assessment" | "verification" | "event";

export interface RecordsComplianceFinding {
  readonly workId: string;
  readonly code: RecordsComplianceFindingCode;
  readonly message: string;
}

export interface RecordsCompletionLineage {
  readonly workId: string;
  readonly workStatus: string;
  readonly workRevision: number;
  readonly workEventSequence: readonly { readonly sequence: number; readonly eventType: string }[];
  readonly run: {
    readonly recordsRunId: string;
    readonly status: string;
    readonly targetWorkRevision: number;
    readonly verificationId: string;
    readonly assuranceRunId: string;
    readonly snapshotHash: string;
    readonly rendererVersion: string;
  };
  readonly recordsEventSequence: readonly { readonly sequence: number; readonly eventType: string }[];
  readonly verification: {
    readonly verificationId: string;
    readonly assuranceRunId: string;
    readonly passed: boolean;
    readonly projectedWorkRevision: number;
  };
  readonly record: {
    readonly finalized: boolean;
    readonly recordedWorkRevision: number;
    readonly recordsRunId: string;
    readonly recordsSnapshotHash: string;
    readonly verificationIds: readonly string[];
    readonly documentIds: readonly string[];
    readonly artifactVersionIds: readonly string[];
    readonly schemaVersion: string;
  };
  readonly assessments: readonly {
    readonly kind: "work-record" | "adr" | "changelog" | "runbook";
    readonly outcome: "required" | "not-applicable";
  }[];
  readonly documents: readonly {
    readonly documentId: string;
    readonly kind: "adr" | "changelog" | "runbook";
    readonly sourceJson: string;
    readonly sourceChecksum: string;
    readonly markdownChecksum: string;
    readonly rendererVersion: string;
    readonly artifactVersionId: string;
  }[];
  readonly artifacts: readonly {
    readonly artifactVersionId: string;
    readonly checksum: string;
    readonly content: string;
  }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function orderedEvents(
  events: readonly { readonly sequence: number; readonly eventType: string }[],
  expected: readonly string[],
): boolean {
  if (
    events.some((event, index) => {
      const previous = events[index - 1];
      return previous !== undefined && event.sequence <= previous.sequence;
    })
  )
    return false;
  let cursor = 0;
  for (const event of events) if (event.eventType === expected[cursor]) cursor += 1;
  return cursor === expected.length;
}

export function auditRecordsCompletionLineage(lineage: RecordsCompletionLineage): RecordsComplianceFinding[] {
  const findings: RecordsComplianceFinding[] = [];
  const add = (code: RecordsComplianceFindingCode, message: string): void => {
    if (!findings.some((finding) => finding.code === code)) findings.push({ workId: lineage.workId, code, message });
  };

  if (
    lineage.workStatus !== "completed" ||
    lineage.run.status !== "completed" ||
    lineage.workRevision !== lineage.run.targetWorkRevision + 2 ||
    !lineage.record.finalized ||
    lineage.record.recordedWorkRevision !== lineage.run.targetWorkRevision + 1 ||
    lineage.record.schemaVersion !== "massion.work-record.v1" ||
    lineage.record.recordsRunId !== lineage.run.recordsRunId
  ) {
    add("work", "Records N+1→N+2→N+3 완료 revision 또는 run·record 연결이 다릅니다");
  }
  if (lineage.record.recordsSnapshotHash !== lineage.run.snapshotHash) {
    add("snapshot", "WorkRecord와 RecordsRun snapshot hash가 다릅니다");
  }
  if (
    !lineage.verification.passed ||
    lineage.verification.verificationId !== lineage.run.verificationId ||
    lineage.verification.assuranceRunId !== lineage.run.assuranceRunId ||
    lineage.verification.projectedWorkRevision !== lineage.run.targetWorkRevision ||
    !lineage.record.verificationIds.includes(lineage.verification.verificationId)
  ) {
    add("verification", "RecordsRun·WorkVerification·WorkRecord 계보가 다릅니다");
  }
  if (
    lineage.assessments.length !== 4 ||
    new Set(lineage.assessments.map((assessment) => assessment.kind)).size !== 4 ||
    lineage.assessments.find((assessment) => assessment.kind === "work-record")?.outcome !== "required"
  ) {
    add("assessment", "네 documentation impact assessment가 정확히 하나씩 존재하지 않습니다");
  }
  const requiredKinds = lineage.assessments
    .filter((assessment) => assessment.kind !== "work-record" && assessment.outcome === "required")
    .map((assessment) => assessment.kind)
    .sort();
  const documentKinds = lineage.documents.map((document) => document.kind).sort();
  if (
    JSON.stringify(requiredKinds) !== JSON.stringify(documentKinds) ||
    new Set(lineage.record.documentIds).size !== lineage.record.documentIds.length ||
    lineage.record.documentIds.length !== lineage.documents.length ||
    lineage.documents.some((document) => !lineage.record.documentIds.includes(document.documentId))
  ) {
    add("assessment", "required assessment와 WorkRecord document 집합이 다릅니다");
  }

  for (const document of lineage.documents) {
    let rendered: ReturnType<typeof renderDocument> | undefined;
    try {
      const parsed = JSON.parse(document.sourceJson) as RecordsDocumentSource;
      rendered = renderDocument(parsed);
    } catch {
      add("source", "Records document typed source를 검증하거나 렌더링할 수 없습니다");
      continue;
    }
    if (
      sha256(document.sourceJson) !== document.sourceChecksum ||
      rendered.sourceJson !== document.sourceJson ||
      rendered.sourceChecksum !== document.sourceChecksum ||
      rendered.rendererVersion !== lineage.run.rendererVersion ||
      document.rendererVersion !== lineage.run.rendererVersion
    ) {
      add("source", "Records document source checksum 또는 renderer version이 다릅니다");
    }
    const artifact = lineage.artifacts.find((candidate) => candidate.artifactVersionId === document.artifactVersionId);
    if (
      !artifact ||
      !lineage.record.artifactVersionIds.includes(document.artifactVersionId) ||
      sha256(artifact.content) !== artifact.checksum ||
      artifact.checksum !== document.markdownChecksum ||
      rendered.markdownChecksum !== document.markdownChecksum ||
      rendered.markdown !== artifact.content
    ) {
      add("artifact", "Records Markdown Artifact byte 또는 checksum 계보가 다릅니다");
    }
  }

  if (
    !orderedEvents(lineage.workEventSequence, ["verification_recorded", "records_finalized", "work_state_changed"]) ||
    !orderedEvents(
      lineage.recordsEventSequence,
      lineage.documents.length > 0
        ? ["records_run_started", "records_impacts_evaluated", "records_document_rendered", "records_run_completed"]
        : ["records_run_started", "records_impacts_evaluated", "records_run_completed"],
    )
  ) {
    add("event", "Records·Work completion Event 순서가 N+1→N+2→N+3 계약과 다릅니다");
  }
  return findings.sort((left, right) => left.code.localeCompare(right.code));
}

interface DatabaseWork {
  readonly organization_id: string;
  readonly work_id: string;
  readonly status: string;
  readonly revision: number;
  readonly records_schema_version?: string;
}

interface DatabaseRun {
  readonly records_run_id: string;
  readonly status: string;
  readonly target_work_revision: number;
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly snapshot_hash: string;
  readonly renderer_version: string;
}

interface DatabaseVerification {
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly passed: boolean;
  readonly projected_work_revision: number;
}

interface DatabaseRecord {
  readonly finalized: boolean;
  readonly recorded_work_revision: number;
  readonly records_run_id: string;
  readonly records_snapshot_hash: string;
  readonly verification_ids: readonly string[];
  readonly document_ids: readonly string[];
  readonly artifact_version_ids: readonly string[];
  readonly schema_version: string;
}

interface DatabaseAssessment {
  readonly kind: RecordsCompletionLineage["assessments"][number]["kind"];
  readonly outcome: RecordsCompletionLineage["assessments"][number]["outcome"];
}

interface DatabaseDocument {
  readonly document_id: string;
  readonly kind: RecordsCompletionLineage["documents"][number]["kind"];
  readonly source_json: string;
  readonly source_checksum: string;
  readonly markdown_checksum: string;
  readonly renderer_version: string;
  readonly artifact_version_id: string;
}

interface DatabaseArtifact {
  readonly artifact_version_id: string;
  readonly checksum: string;
  readonly content_json: string;
}

interface DatabaseEvent {
  readonly sequence: number;
  readonly event_type: string;
}

interface DatabaseInfo {
  readonly tables: Readonly<Record<string, unknown>>;
}

export class RecordsComplianceAuditor {
  public constructor(private readonly database: MassionDatabase) {}

  public async auditDatabase(): Promise<RecordsComplianceFinding[]> {
    const [info] = await this.database.query<[DatabaseInfo?]>("INFO FOR DB;");
    if (!info || !("work" in info.tables)) return [];
    const [works] = await this.database.query<[DatabaseWork[]]>(
      "SELECT organization_id, work_id, status, revision, records_schema_version FROM work WHERE status = 'completed' ORDER BY organization_id ASC, work_id ASC;",
    );
    const findings: RecordsComplianceFinding[] = [];
    for (const work of works) {
      if (work.records_schema_version !== "massion.work.records.v1") continue;
      try {
        findings.push(...(await this.auditWork(work)));
      } catch (error) {
        findings.push({
          workId: work.work_id,
          code: "work",
          message: `Phase 13 completed Work의 RecordsRun 계보를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return findings.sort((left, right) =>
      `${left.workId}:${left.code}:${left.message}`.localeCompare(`${right.workId}:${right.code}:${right.message}`),
    );
  }

  public async assertDatabaseCompliance(): Promise<void> {
    const findings = await this.auditDatabase();
    if (findings.length > 0) {
      throw new Error(`복원된 completed Work의 Records 준수 위반입니다: ${JSON.stringify(findings)}`);
    }
  }

  private async auditWork(work: DatabaseWork): Promise<RecordsComplianceFinding[]> {
    const parameters = { organization_id: work.organization_id, work_id: work.work_id };
    const [runs] = await this.database.query<[DatabaseRun[]]>(
      "SELECT * OMIT id FROM records_run WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY target_work_revision DESC LIMIT 1;",
      parameters,
    );
    const run = runs[0];
    if (!run)
      return [{ workId: work.work_id, code: "work", message: "Phase 13 completed Work의 RecordsRun이 없습니다" }];
    const [verifications] = await this.database.query<[DatabaseVerification[]]>(
      "SELECT verification_id, assurance_run_id, passed, projected_work_revision FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id AND verification_id = $verification_id LIMIT 1;",
      { ...parameters, verification_id: run.verification_id },
    );
    const [records] = await this.database.query<[DatabaseRecord[]]>(
      "SELECT * OMIT id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id AND finalized = true ORDER BY version DESC LIMIT 1;",
      { ...parameters, records_run_id: run.records_run_id },
    );
    const verification = verifications[0];
    const record = records[0];
    if (!verification || !record) {
      return [
        { workId: work.work_id, code: "verification", message: "Records Verification 또는 WorkRecord가 없습니다" },
      ];
    }
    const queryParameters = { ...parameters, records_run_id: run.records_run_id };
    const [assessments] = await this.database.query<[DatabaseAssessment[]]>(
      "SELECT kind, outcome FROM documentation_impact_assessment WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id;",
      queryParameters,
    );
    const [documents] = await this.database.query<[DatabaseDocument[]]>(
      "SELECT document_id, kind, source_json, source_checksum, markdown_checksum, renderer_version, artifact_version_id FROM records_document WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id;",
      queryParameters,
    );
    const [artifacts] = await this.database.query<[DatabaseArtifact[]]>(
      "SELECT artifact_version_id, checksum, content_json FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $artifact_version_ids;",
      { ...parameters, artifact_version_ids: documents.map((document) => document.artifact_version_id) },
    );
    const [workEvents] = await this.database.query<[DatabaseEvent[]]>(
      "SELECT sequence, event_type FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
      parameters,
    );
    const [recordsEvents] = await this.database.query<[DatabaseEvent[]]>(
      "SELECT sequence, event_type FROM records_event WHERE organization_id = $organization_id AND records_run_id = $records_run_id ORDER BY sequence ASC;",
      queryParameters,
    );
    return auditRecordsCompletionLineage({
      workId: work.work_id,
      workStatus: work.status,
      workRevision: work.revision,
      workEventSequence: workEvents.map((event) => ({ sequence: event.sequence, eventType: event.event_type })),
      run: {
        recordsRunId: run.records_run_id,
        status: run.status,
        targetWorkRevision: run.target_work_revision,
        verificationId: run.verification_id,
        assuranceRunId: run.assurance_run_id,
        snapshotHash: run.snapshot_hash,
        rendererVersion: run.renderer_version,
      },
      recordsEventSequence: recordsEvents.map((event) => ({ sequence: event.sequence, eventType: event.event_type })),
      verification: {
        verificationId: verification.verification_id,
        assuranceRunId: verification.assurance_run_id,
        passed: verification.passed,
        projectedWorkRevision: verification.projected_work_revision,
      },
      record: {
        finalized: record.finalized,
        recordedWorkRevision: record.recorded_work_revision,
        recordsRunId: record.records_run_id,
        recordsSnapshotHash: record.records_snapshot_hash,
        verificationIds: record.verification_ids,
        documentIds: record.document_ids,
        artifactVersionIds: record.artifact_version_ids,
        schemaVersion: record.schema_version,
      },
      assessments,
      documents: documents.map((document) => ({
        documentId: document.document_id,
        kind: document.kind,
        sourceJson: document.source_json,
        sourceChecksum: document.source_checksum,
        markdownChecksum: document.markdown_checksum,
        rendererVersion: document.renderer_version,
        artifactVersionId: document.artifact_version_id,
      })),
      artifacts: artifacts.map((artifact) => ({
        artifactVersionId: artifact.artifact_version_id,
        checksum: artifact.checksum,
        content: artifact.content_json,
      })),
    });
  }
}
