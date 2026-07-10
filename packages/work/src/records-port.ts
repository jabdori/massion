import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { WORK_RECORDS_COMPLETION_MIGRATION, WORK_RECORDS_LINK_MIGRATION } from "./schema.js";
import type { ArtifactVersion, Work, WorkEvent, WorkRecord } from "./work.js";

export type RecordsProjectionDocumentKind = "adr" | "changelog" | "runbook";

export interface RecordsProjectionDocumentInput {
  readonly documentId: string;
  readonly kind: RecordsProjectionDocumentKind;
  readonly schemaVersion: string;
  readonly rendererVersion: string;
  readonly sourceJson: string;
  readonly sourceChecksum: string;
  readonly markdown: string;
  readonly markdownChecksum: string;
}

export interface FinalizeRecordsProjectionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedRevision: number;
  readonly recordsRunId: string;
  readonly recordsSnapshotHash: string;
  readonly verificationId: string;
  readonly documents: readonly RecordsProjectionDocumentInput[];
  readonly causedByEventId?: string;
}

export interface RecordsDocumentRecord {
  readonly document_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly records_run_id: string;
  readonly kind: RecordsProjectionDocumentKind;
  readonly schema_version: string;
  readonly renderer_version: string;
  readonly source_json: string;
  readonly source_checksum: string;
  readonly markdown_checksum: string;
  readonly artifact_version_id: string;
  readonly created_at: unknown;
}

export interface FinalizeRecordsProjectionResult {
  readonly work: Work;
  readonly event: WorkEvent;
  readonly record: WorkRecord;
  readonly documents: readonly RecordsDocumentRecord[];
  readonly artifactVersions: readonly ArtifactVersion[];
}

export interface CompleteRecordsProjectionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedRevision: number;
  readonly recordsRunId: string;
  readonly recordsSnapshotHash: string;
  readonly verificationId: string;
}

export interface CompleteRecordsProjectionResult {
  readonly work: Work;
  readonly event: WorkEvent;
}

interface RecordsRunRecord {
  readonly records_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly verification_id: string;
  readonly snapshot_hash: string;
  readonly renderer_version: string;
  readonly status: string;
  readonly version: number;
}

interface ImpactRecord {
  readonly kind: "work-record" | RecordsProjectionDocumentKind;
  readonly outcome: "required" | "not-applicable";
}

interface VerificationRecord {
  readonly verification_id: string;
  readonly passed: boolean;
  readonly evidence_artifact_version_id?: string;
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

function assertIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label}은 1~200자여야 합니다`);
}

async function findWork(executor: QueryExecutor, organizationId: string, workId: string): Promise<Work | undefined> {
  const [works] = await executor.query<[Work[]]>(
    "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: organizationId, work_id: workId },
  );
  return works[0];
}

export class WorkRecordsPort {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<WorkRecordsPort> {
    await applyMigrations(database, [WORK_RECORDS_LINK_MIGRATION, WORK_RECORDS_COMPLETION_MIGRATION]);
    return new WorkRecordsPort(database, organizations);
  }

  public async complete(
    context: TenantContext,
    input: CompleteRecordsProjectionInput,
  ): Promise<CompleteRecordsProjectionResult> {
    await this.organizations.verifyTenantContext(context);
    for (const [value, label] of [
      [input.commandId, "Command ID"],
      [input.workId, "Work ID"],
      [input.recordsRunId, "Records run ID"],
      [input.verificationId, "Verification ID"],
    ] as const) {
      assertIdentifier(value, label);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Records completion expected revision이 잘못됐습니다");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.recordsSnapshotHash)) {
      throw new Error("Records completion snapshot hash가 잘못됐습니다");
    }
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [replayed] = await transaction.query<[WorkEvent[]]>(
        "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replayed[0]) {
        if (replayed[0].request_json !== requestJson) {
          throw new Error("같은 commandId에 다른 Records completion 명령을 사용할 수 없습니다");
        }
        return JSON.parse(replayed[0].result_json) as CompleteRecordsProjectionResult;
      }
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (work.status !== "verifying" || work.revision !== input.expectedRevision) {
        throw new Error("Records completion Work 상태 또는 revision이 다릅니다");
      }
      const [runs] = await transaction.query<[RecordsRunRecord[]]>(
        "SELECT * OMIT id FROM records_run WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          work_id: input.workId,
          records_run_id: input.recordsRunId,
        },
      );
      const run = runs[0];
      if (
        !run ||
        run.status !== "finalized" ||
        run.snapshot_hash !== input.recordsSnapshotHash ||
        run.verification_id !== input.verificationId ||
        run.target_work_revision + 1 !== work.revision
      ) {
        throw new Error("Records completion run 계보가 유효하지 않습니다");
      }
      await transaction.query(
        "UPDATE work SET status = 'completed', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          revision: work.revision + 1,
          organization_id: context.organizationId,
          work_id: input.workId,
        },
      );
      const updated = await findWork(transaction, context.organizationId, input.workId);
      if (!updated) throw new Error("Records completed Work를 찾을 수 없습니다");
      const [existing] = await transaction.query<[WorkEvent[]]>(
        "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const provisional = { work: updated };
      const [events] = await transaction.query<[WorkEvent[]]>(
        "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: 'work_state_changed', actor_user_id: $actor_user_id, request_json: $request_json, payload_json: $payload_json, result_json: $result_json, created_at: time::now() } RETURN AFTER;",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: input.workId,
          sequence: existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
          command_id: input.commandId,
          actor_user_id: context.userId,
          request_json: requestJson,
          payload_json: canonicalJson({ from: "verifying", to: "completed", recordsRunId: input.recordsRunId }),
          result_json: JSON.stringify(provisional),
        },
      );
      const event = events[0];
      if (!event) throw new Error("Records completion WorkEvent 생성 결과가 없습니다");
      const result = { work: updated, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    });
  }

  public async finalize(
    context: TenantContext,
    input: FinalizeRecordsProjectionInput,
  ): Promise<FinalizeRecordsProjectionResult> {
    await this.organizations.verifyTenantContext(context);
    this.validateInput(input);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const replayed = await this.replay(transaction, context.organizationId, input.commandId, requestJson);
      if (replayed) return replayed;
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (work.status !== "verifying") throw new Error("Records projection 대상 Work는 verifying 상태여야 합니다");
      if (work.revision !== input.expectedRevision) {
        throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
      }
      const run = await this.verifyRun(transaction, context.organizationId, input);
      await this.verifyDocuments(transaction, context.organizationId, input, run);
      const verification = await this.verifyVerification(transaction, context.organizationId, input);

      await transaction.query(
        "UPDATE work SET records_schema_version = 'massion.work.records.v1' WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const documents: RecordsDocumentRecord[] = [];
      const artifactVersions: ArtifactVersion[] = [];
      for (const source of [...input.documents].sort((left, right) => left.kind.localeCompare(right.kind))) {
        const artifactId = randomUUID();
        const artifactVersionId = randomUUID();
        await transaction.query(
          "CREATE work_artifact CONTENT { artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, kind: $kind, name: $name, created_by: $created_by, created_at: time::now() };",
          {
            artifact_id: artifactId,
            organization_id: context.organizationId,
            work_id: input.workId,
            kind: `records-${source.kind}`,
            name: `records:${input.recordsRunId}:${source.kind}.md`,
            created_by: context.userId,
          },
        );
        const [createdVersions] = await transaction.query<[ArtifactVersion[]]>(
          "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $checksum, media_type: 'text/markdown; charset=utf-8', content_json: $content_json, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
          {
            artifact_version_id: artifactVersionId,
            artifact_id: artifactId,
            organization_id: context.organizationId,
            work_id: input.workId,
            checksum: source.markdownChecksum,
            content_json: source.markdown,
            created_by: context.userId,
          },
        );
        const artifactVersion = createdVersions[0];
        if (!artifactVersion) throw new Error("Records ArtifactVersion 생성 결과가 없습니다");
        const [createdDocuments] = await transaction.query<[RecordsDocumentRecord[]]>(
          "CREATE records_document CONTENT { document_id: $document_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, kind: $kind, schema_version: $schema_version, renderer_version: $renderer_version, source_json: $source_json, source_checksum: $source_checksum, markdown_checksum: $markdown_checksum, artifact_version_id: $artifact_version_id, created_at: time::now() } RETURN AFTER;",
          {
            document_id: source.documentId,
            organization_id: context.organizationId,
            work_id: input.workId,
            records_run_id: input.recordsRunId,
            kind: source.kind,
            schema_version: source.schemaVersion,
            renderer_version: source.rendererVersion,
            source_json: source.sourceJson,
            source_checksum: source.sourceChecksum,
            markdown_checksum: source.markdownChecksum,
            artifact_version_id: artifactVersionId,
          },
        );
        if (!createdDocuments[0]) throw new Error("Records document 생성 결과가 없습니다");
        artifactVersions.push(artifactVersion);
        documents.push(createdDocuments[0]);
      }

      const [records] = await transaction.query<[WorkRecord[]]>(
        "SELECT * OMIT id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY version ASC;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const [events] = await transaction.query<[WorkEvent[]]>(
        "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const [decisions] = await transaction.query<[{ message_id: string; sequence: number }[]]>(
        "SELECT message_id, sequence FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'decision' ORDER BY sequence ASC;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const documentIds = documents.map((document) => document.document_id);
      const artifactVersionIds = [
        ...new Set([
          ...work.artifact_version_ids,
          ...artifactVersions.map((artifact) => artifact.artifact_version_id),
          ...(verification.evidence_artifact_version_id ? [verification.evidence_artifact_version_id] : []),
        ]),
      ];
      const workRecordId = randomUUID();
      const [createdRecords] = await transaction.query<[WorkRecord[]]>(
        "CREATE work_record CONTENT { work_record_id: $work_record_id, organization_id: $organization_id, work_id: $work_id, version: $version, recorded_work_revision: $recorded_work_revision, summary: $summary, event_start_sequence: $event_start_sequence, event_end_sequence: $event_end_sequence, decision_message_ids: $decision_message_ids, artifact_version_ids: $artifact_version_ids, verification_ids: [$verification_id], finalized: true, finalized_by: $finalized_by, finalized_at: time::now(), records_run_id: $records_run_id, records_snapshot_hash: $records_snapshot_hash, document_ids: $document_ids, schema_version: 'massion.work-record.v1' } RETURN AFTER;",
        {
          work_record_id: workRecordId,
          organization_id: context.organizationId,
          work_id: input.workId,
          version: records.reduce((maximum, record) => Math.max(maximum, record.version), 0) + 1,
          recorded_work_revision: work.revision + 1,
          summary: `Records run ${input.recordsRunId} finalized ${String(documentIds.length)} document(s)`,
          event_start_sequence: events[0]?.sequence ?? 1,
          event_end_sequence: (events.at(-1)?.sequence ?? 0) + 1,
          decision_message_ids: decisions.map((decision) => decision.message_id),
          artifact_version_ids: artifactVersionIds,
          verification_id: input.verificationId,
          finalized_by: context.userId,
          records_run_id: input.recordsRunId,
          records_snapshot_hash: input.recordsSnapshotHash,
          document_ids: documentIds,
        },
      );
      const record = createdRecords[0];
      if (!record) throw new Error("Records WorkRecord 생성 결과가 없습니다");

      await transaction.query(
        "UPDATE work SET revision = $revision, artifact_version_ids = $artifact_version_ids, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id; UPDATE records_run SET status = 'finalized', version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND records_run_id = $records_run_id;",
        {
          revision: work.revision + 1,
          artifact_version_ids: artifactVersionIds,
          organization_id: context.organizationId,
          work_id: input.workId,
          records_run_id: input.recordsRunId,
        },
      );
      const updated = await findWork(transaction, context.organizationId, input.workId);
      if (!updated) throw new Error("Records projection 뒤 Work를 찾을 수 없습니다");
      const event = await this.appendEvent(transaction, context, updated, input, requestJson, {
        record,
        documents,
        artifactVersions,
      });
      return { work: updated, event, record, documents, artifactVersions };
    });
  }

  private validateInput(input: FinalizeRecordsProjectionInput): void {
    const raw = input as unknown as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(raw, "summary")) throw new Error("caller summary는 Records projection에 허용되지 않습니다");
    for (const [value, label] of [
      [input.commandId, "Command ID"],
      [input.workId, "Work ID"],
      [input.recordsRunId, "Records run ID"],
      [input.verificationId, "Verification ID"],
    ] as const) {
      assertIdentifier(value, label);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("expected Work revision은 1 이상이어야 합니다");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.recordsSnapshotHash)) throw new Error("Records snapshot hash가 잘못됐습니다");
    const documentIds = input.documents.map((document) => document.documentId);
    const kinds = input.documents.map((document) => document.kind);
    if (new Set(documentIds).size !== documentIds.length || new Set(kinds).size !== kinds.length) {
      throw new Error("Records document ID와 kind는 중복될 수 없습니다");
    }
    for (const document of input.documents) {
      assertIdentifier(document.documentId, "Document ID");
      if (!["adr", "changelog", "runbook"].includes(document.kind)) throw new Error("Document kind가 잘못됐습니다");
      if (sha256(document.sourceJson) !== document.sourceChecksum)
        throw new Error("Document source checksum이 다릅니다");
      if (sha256(document.markdown) !== document.markdownChecksum)
        throw new Error("Document Markdown checksum이 다릅니다");
      let parsed: unknown;
      try {
        parsed = JSON.parse(document.sourceJson);
      } catch {
        throw new Error("Document source JSON이 잘못됐습니다");
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as Readonly<Record<string, unknown>>).kind !== document.kind
      ) {
        throw new Error("Document source kind가 projection kind와 다릅니다");
      }
    }
  }

  private async verifyRun(
    executor: QueryExecutor,
    organizationId: string,
    input: FinalizeRecordsProjectionInput,
  ): Promise<RecordsRunRecord> {
    const [runs] = await executor.query<[RecordsRunRecord[]]>(
      "SELECT * OMIT id FROM records_run WHERE organization_id = $organization_id AND records_run_id = $records_run_id LIMIT 1;",
      { organization_id: organizationId, records_run_id: input.recordsRunId },
    );
    const run = runs[0];
    if (!run) throw new Error("Records run을 찾을 수 없습니다");
    if (
      run.work_id !== input.workId ||
      run.target_work_revision !== input.expectedRevision ||
      run.verification_id !== input.verificationId ||
      run.snapshot_hash !== input.recordsSnapshotHash ||
      run.status !== "rendering"
    ) {
      throw new Error("Records run이 Work projection 입력과 일치하지 않습니다");
    }
    return run;
  }

  private async verifyDocuments(
    executor: QueryExecutor,
    organizationId: string,
    input: FinalizeRecordsProjectionInput,
    run: RecordsRunRecord,
  ): Promise<void> {
    const [assessments] = await executor.query<[ImpactRecord[]]>(
      "SELECT kind, outcome FROM documentation_impact_assessment WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id;",
      { organization_id: organizationId, work_id: input.workId, records_run_id: input.recordsRunId },
    );
    if (assessments.length !== 4 || assessments.filter((value) => value.kind === "work-record").length !== 1) {
      throw new Error("Records run에는 정확히 네 documentation impact assessment가 필요합니다");
    }
    const required = assessments
      .filter((assessment) => assessment.kind !== "work-record" && assessment.outcome === "required")
      .map((assessment) => assessment.kind)
      .sort();
    const provided = input.documents.map((document) => document.kind).sort();
    if (canonicalJson(required) !== canonicalJson(provided)) {
      throw new Error("required documentation assessment와 제공 document kind가 다릅니다");
    }
    if (input.documents.some((document) => document.rendererVersion !== run.renderer_version)) {
      throw new Error("Document renderer version이 Records run과 다릅니다");
    }
  }

  private async verifyVerification(
    executor: QueryExecutor,
    organizationId: string,
    input: FinalizeRecordsProjectionInput,
  ): Promise<VerificationRecord> {
    const [verifications] = await executor.query<[VerificationRecord[]]>(
      "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id AND verification_id = $verification_id LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId, verification_id: input.verificationId },
    );
    if (!verifications[0]?.passed) throw new Error("Records projection에는 passed Verification이 필요합니다");
    return verifications[0];
  }

  private async replay(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<FinalizeRecordsProjectionResult | undefined> {
    const [events] = await executor.query<[WorkEvent[]]>(
      "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (event.request_json !== requestJson) throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
    return JSON.parse(event.result_json) as FinalizeRecordsProjectionResult;
  }

  private async appendEvent(
    executor: QueryExecutor,
    context: TenantContext,
    work: Work,
    input: FinalizeRecordsProjectionInput,
    requestJson: string,
    extra: Omit<FinalizeRecordsProjectionResult, "work" | "event">,
  ): Promise<WorkEvent> {
    const [existing] = await executor.query<[WorkEvent[]]>(
      "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, work_id: work.work_id },
    );
    if (input.causedByEventId && !existing.some((event) => event.event_id === input.causedByEventId)) {
      throw new Error("Records projection 원인 WorkEvent를 찾을 수 없습니다");
    }
    const provisional = { work, ...extra };
    const [events] = await executor.query<[WorkEvent[]]>(
      "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: 'records_finalized', actor_user_id: $actor_user_id, caused_by_event_id: $caused_by_event_id, request_json: $request_json, payload_json: $payload_json, result_json: $result_json, created_at: time::now() } RETURN AFTER;",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        work_id: work.work_id,
        sequence: existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
        command_id: input.commandId,
        actor_user_id: context.userId,
        caused_by_event_id: input.causedByEventId,
        request_json: requestJson,
        payload_json: canonicalJson({
          recordsRunId: input.recordsRunId,
          recordsSnapshotHash: input.recordsSnapshotHash,
          documentIds: extra.documents.map((document) => document.document_id),
        }),
        result_json: JSON.stringify(provisional),
      },
    );
    const event = events[0];
    if (!event) throw new Error("Records finalized WorkEvent 생성 결과가 없습니다");
    const result = { ...provisional, event };
    await executor.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
      result_json: JSON.stringify(result),
      event_id: event.event_id,
    });
    return event;
  }
}
