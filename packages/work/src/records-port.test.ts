import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  WorkRecordsPort,
  type CompleteRecordsProjectionInput,
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

  function completionInput(
    expectedRevision: number,
    commandId: string = "records-run-1:complete",
  ): CompleteRecordsProjectionInput {
    return {
      commandId,
      workId,
      expectedRevision,
      expectedRecordsVersion: 3,
      recordsRunId: "records-run-1",
      recordsSnapshotHash: "a".repeat(64),
      verificationId: "verification-1",
    };
  }

  async function seedTaskOutputs(outputs: readonly string[]): Promise<void> {
    const artifactStatements = outputs
      .map(
        (_output, index) => `
CREATE work_artifact CONTENT { artifact_id: 'task-output-artifact-${String(index + 1)}', organization_id: $organization_id, work_id: $work_id, kind: 'task-output', name: 'task-output-${String(index + 1)}', created_by: 'delivery-coordination', created_at: time::now() };
CREATE artifact_version CONTENT { artifact_version_id: 'task-output-version-${String(index + 1)}', artifact_id: 'task-output-artifact-${String(index + 1)}', organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $checksum_${String(index)}, media_type: 'application/json', content_json: $content_json_${String(index)}, created_by: 'delivery-coordination', created_at: time::now() };`,
      )
      .join("\n");
    const artifactIds = outputs.map((_output, index) => `'task-output-version-${String(index + 1)}'`).join(", ");
    const parameters = Object.fromEntries(
      outputs.flatMap((output, index) => [
        [`checksum_${String(index)}`, sha256(JSON.stringify(output))],
        [`content_json_${String(index)}`, JSON.stringify(output)],
      ]),
    );
    await database.query(
      `
${artifactStatements}
UPDATE work SET artifact_version_ids = [${artifactIds}] WHERE organization_id = $organization_id AND work_id = $work_id;
CREATE collaboration_room CONTENT { room_id: 'core-office-room', organization_id: $organization_id, work_id: $work_id, title: 'Core Office', coordinator_handle: 'representative', status: 'active', revision: 1, next_sequence: 2, max_parallel: 8, max_tokens: 32000, max_cost_micros: 1000000, max_rounds: 100, round_count: 1, created_at: time::now(), updated_at: time::now() };
CREATE collaboration_participant CONTENT { participant_id: 'representative-participant', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', kind: 'agent', subject_id: 'representative', role: 'coordinator', status: 'active', joined_at: time::now() };
CREATE collaboration_message CONTENT { message_id: 'assurance-message', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', sequence: 1, message_type: 'evidence', author_kind: 'agent', author_id: 'assurance', content: '독립 검증을 통과했습니다.', execution_id: 'assurance-execution', token_count: 0, cost_micros: 0, created_at: time::now() };
`,
      {
        organization_id: context.organizationId,
        work_id: workId,
        ...parameters,
      },
    );
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

  it("Work와 Records 완료를 함께 확정하고 replay·동시 호출에도 완료 event를 한 번만 만든다", async () => {
    const firstDeliveryOutput = "DELIVERY_RESULT_records_projection_first";
    const secondDeliveryOutput =
      "DELIVERY_RESULT_records_projection_second Bearer bearer-record-123 sk-record-secret-1234567890 eyJabcdefghijk.abcdefghijk.abcdefghijk api_key=api-record-123 key=bare-record-123 private_key=private-record-123 secret=secret-record-123\u0001\u007f\u0085" +
      "y".repeat(6_000);
    await database.query(
      `
CREATE work_artifact CONTENT { artifact_id: 'task-output-artifact-1', organization_id: $organization_id, work_id: $work_id, kind: 'task-output', name: 'task-output-1', created_by: 'delivery-coordination', created_at: time::now() };
CREATE artifact_version CONTENT { artifact_version_id: 'task-output-version-1', artifact_id: 'task-output-artifact-1', organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $first_checksum, media_type: 'application/json', content_json: $first_content_json, created_by: 'delivery-coordination', created_at: time::now() };
CREATE work_artifact CONTENT { artifact_id: 'task-output-artifact-2', organization_id: $organization_id, work_id: $work_id, kind: 'task-output', name: 'task-output-2', created_by: 'delivery-coordination', created_at: time::now() };
CREATE artifact_version CONTENT { artifact_version_id: 'task-output-version-2', artifact_id: 'task-output-artifact-2', organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $second_checksum, media_type: 'application/json', content_json: $second_content_json, created_by: 'delivery-coordination', created_at: time::now() };
UPDATE work SET artifact_version_ids = ['task-output-version-1', 'task-output-version-2'] WHERE organization_id = $organization_id AND work_id = $work_id;
CREATE collaboration_room CONTENT { room_id: 'core-office-room', organization_id: $organization_id, work_id: $work_id, title: 'Core Office', coordinator_handle: 'representative', status: 'active', revision: 1, next_sequence: 2, max_parallel: 8, max_tokens: 32000, max_cost_micros: 1000000, max_rounds: 100, round_count: 1, created_at: time::now(), updated_at: time::now() };
CREATE collaboration_participant CONTENT { participant_id: 'representative-participant', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', kind: 'agent', subject_id: 'representative', role: 'coordinator', status: 'active', joined_at: time::now() };
CREATE collaboration_message CONTENT { message_id: 'assurance-message', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', sequence: 1, message_type: 'evidence', author_kind: 'agent', author_id: 'assurance', content: '독립 검증을 통과했습니다.', execution_id: 'assurance-execution', token_count: 0, cost_micros: 0, created_at: time::now() };
`,
      {
        organization_id: context.organizationId,
        work_id: workId,
        first_checksum: sha256(JSON.stringify(firstDeliveryOutput)),
        first_content_json: JSON.stringify(firstDeliveryOutput),
        second_checksum: sha256(JSON.stringify(secondDeliveryOutput)),
        second_content_json: JSON.stringify(secondDeliveryOutput),
      },
    );
    const finalized = await port.finalize(context, input());
    const completion = completionInput(finalized.work.revision);
    const [completed, concurrent] = await Promise.all([
      port.complete(context, completion),
      port.complete(context, completion),
    ]);

    expect(completed.work).toMatchObject({ status: "completed", revision: 7 });
    expect(completed.event.event_type).toBe("work_state_changed");
    expect(concurrent.event.event_id).toBe(completed.event.event_id);
    const repeated = await port.complete(context, completion);
    expect(repeated.event.event_id).toBe(completed.event.event_id);
    const [runs] = await database.query<
      [Array<{ status: string; version: number; released: boolean; timestamped: boolean }>]
    >(
      "SELECT status, version, active_guard_key = NONE AS released, completed_at != NONE AS timestamped FROM records_run WHERE records_run_id = 'records-run-1';",
    );
    expect(runs).toEqual([{ status: "completed", version: 4, released: true, timestamped: true }]);
    const [recordsEvents] = await database.query<
      [Array<{ command_id: string; sequence: number; event_type: string; request_hash: string }>]
    >(
      "SELECT command_id, sequence, event_type, request_hash FROM records_event WHERE records_run_id = 'records-run-1' AND event_type = 'records_run_completed';",
    );
    expect(recordsEvents).toEqual([
      {
        command_id: "records-run-1:terminal",
        sequence: 4,
        event_type: "records_run_completed",
        request_hash: sha256(
          '{"input":{"commandId":"records-run-1:terminal","expectedVersion":3,"recordsRunId":"records-run-1"},"operation":"complete"}',
        ),
      },
    ]);
    const [workEvents] = await database.query<[Array<{ event_id: string }>]>(
      "SELECT event_id FROM work_event WHERE organization_id = $organization_id AND command_id = 'records-run-1:complete';",
      { organization_id: context.organizationId },
    );
    expect(workEvents).toHaveLength(1);
    const [messages] = await database.query<
      [
        Array<{
          sequence: number;
          message_type: string;
          author_id: string;
          content: string;
          artifact_version_id?: string;
        }>,
      ]
    >(
      "SELECT sequence, message_type, author_id, content, artifact_version_id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, work_id: workId },
    );
    expect(messages).toEqual([
      expect.objectContaining({ author_id: "assurance", message_type: "evidence" }),
      expect.objectContaining({
        author_id: "representative",
        message_type: "answer",
        artifact_version_id: "task-output-version-2",
        content: expect.stringContaining("DELIVERY_RESULT_records_projection_first"),
      }),
    ]);
    expect(messages[1]?.content).toContain("DELIVERY_RESULT_records_projection_second");
    for (const secret of [
      "bearer-record-123",
      "sk-record-secret-1234567890",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
      "api-record-123",
      "bare-record-123",
      "private-record-123",
      "secret-record-123",
    ]) {
      expect(messages[1]?.content).not.toContain(secret);
    }
    expect(messages[1]?.content).toContain("[REDACTED]");
    expect(messages[1]?.content.length).toBeLessThanOrEqual(4_000);
    expect(
      Array.from(messages[1]?.content ?? "").some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
      }),
    ).toBe(false);
  });

  it("4,000자를 넘지만 16,000자 이내인 두 Markdown 결과는 전체를 보존한다", async () => {
    const first = `# 첫 번째 결과\n\n| 항목 | 값 |\n| --- | --- |\n| A | 100 |\n\n${"첫 번째 내용 ".repeat(260)}\n\n**FIRST_CLOSING_MARKER**`;
    const second = `# 두 번째 결과\n\n| 항목 | 값 |\n| --- | --- |\n| B | 200 |\n\n${"두 번째 내용 ".repeat(300)}\n\n**SECOND_CLOSING_MARKER**`;
    await seedTaskOutputs([first, second]);

    const finalized = await port.finalize(context, input());
    await port.complete(context, completionInput(finalized.work.revision));
    const [messages] = await database.query<[Array<{ content: string }>]>(
      "SELECT content FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'answer';",
      { organization_id: context.organizationId, work_id: workId },
    );
    const content = messages[0]?.content ?? "";
    expect(content).toContain("FIRST_CLOSING_MARKER");
    expect(content).toContain("SECOND_CLOSING_MARKER");
    expect(content).toContain("| A | 100 |");
    expect(content).toContain("| B | 200 |");
    expect(content).not.toContain("표시 결과가 길어 일부 내용은 생략되었습니다.");
    expect(content.length).toBeLessThanOrEqual(16_000);
  });

  it("16,000자를 넘는 astral Unicode 결과는 경계와 continuation notice를 지킨다", async () => {
    const astralLines = Array.from(
      { length: 160 },
      (_, index) => `${"😀".repeat(40)}${(index + 1) % 8 === 0 ? "\n" : ""}`,
    ).join("\n");
    const first = `# 첫 번째 결과\n\n| 항목 | 값 |\n| --- | --- |\n| A | 100 |\n\n**FIRST_BLOCK**\n\n${astralLines}\n\n**FIRST_CLOSING_MARKER**`;
    const second = `# 두 번째 결과\n\n| 항목 | 값 |\n| --- | --- |\n| B | 200 |\n\n**SECOND_BLOCK**\n\n${astralLines}\n\n**SECOND_CLOSING_MARKER**`;
    await seedTaskOutputs([first, second]);

    const finalized = await port.finalize(context, input());
    await port.complete(context, completionInput(finalized.work.revision));
    const [messages] = await database.query<[Array<{ content: string }>]>(
      "SELECT content FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'answer';",
      { organization_id: context.organizationId, work_id: workId },
    );
    const content = messages[0]?.content ?? "";
    const notice = "표시 결과가 길어 일부 내용은 생략되었습니다. 전체 원문은 저장된 결과에서 확인할 수 있습니다.";
    expect(content).toContain("😀");
    expect(content.length).toBeLessThanOrEqual(16_000);
    expect(content.endsWith(`\n\n${notice}`)).toBe(true);
    expect(content).not.toMatch(/ArtifactVersion|Markdown 블록|표시 예산/u);
    expect((content.match(/(?<!\\)\*\*/gu)?.length ?? 0) % 2).toBe(0);
    expect((content.match(/(?<!\\)`/gu)?.length ?? 0) % 2).toBe(0);
    expect(
      Array.from(content).some((character) => {
        const code = character.charCodeAt(0);
        return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
      }),
    ).toBe(false);
    for (const line of content.split("\n")) {
      if (line.trim().startsWith("|")) expect(line.trim().endsWith("|")).toBe(true);
    }
  });

  it("결과 수가 과도해도 section 수와 최종 답변 길이를 제한한다", async () => {
    await seedTaskOutputs(
      Array.from({ length: 30 }, (_, index) => `# 결과 ${String(index + 1)}\n\n고유 결과 ${String(index + 1)}`),
    );

    const finalized = await port.finalize(context, input());
    await port.complete(context, completionInput(finalized.work.revision));
    const [messages] = await database.query<[Array<{ content: string }>]>(
      "SELECT content FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'answer';",
      { organization_id: context.organizationId, work_id: workId },
    );
    const content = messages[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(16_000);
    expect(content).toContain("결과 20");
    expect(content).not.toContain("\n결과 21\n");
    expect(content).toContain("나머지 10개 결과는 저장된 전체 결과에서 확인할 수 있습니다.");
    expect(content).not.toContain("표시 결과가 길어 일부 내용은 생략되었습니다.");
    expect(content).not.toMatch(/ArtifactVersion|Markdown 블록|표시 예산/u);
  });

  it("Markdown AST 완결 block만 사용해 긴 무공백·escape·fence·GFM 행을 안전하게 줄인다", async () => {
    const first = `${"x".repeat(20_000)}\n\n\\*\\*escaped\\*\\*`;
    const second =
      "```markdown\ninner `code`\n```\n\nname | value\n--- | ---\nalpha | beta\n\n**SECOND_CLOSING_MARKER**";
    await seedTaskOutputs([first, second]);

    const finalized = await port.finalize(context, input());
    await port.complete(context, completionInput(finalized.work.revision));
    const [messages] = await database.query<[Array<{ content: string }>]>(
      "SELECT content FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND message_type = 'answer';",
      { organization_id: context.organizationId, work_id: workId },
    );
    const content = messages[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(16_000);
    expect(content).toContain("inner `code`");
    expect(content).toContain("SECOND_CLOSING_MARKER");
    expect(content).not.toContain("x".repeat(7_900));
    expect(content.endsWith("결과에서 확인할 수 있습니다.")).toBe(true);
    expect(content).not.toMatch(/ArtifactVersion|Markdown 블록|표시 예산/u);
  });

  it("기존 분리 완료 상태를 replay하면 Work event 중복 없이 Records terminal을 복구한다", async () => {
    const finalized = await port.finalize(context, input());
    const completion = completionInput(finalized.work.revision);
    const legacyEventId = crypto.randomUUID();
    const legacyRequestJson = JSON.stringify({
      commandId: completion.commandId,
      expectedRevision: completion.expectedRevision,
      recordsRunId: completion.recordsRunId,
      recordsSnapshotHash: completion.recordsSnapshotHash,
      verificationId: completion.verificationId,
      workId: completion.workId,
    });
    await database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE work SET status = 'completed', revision += 1, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      );
      const [worksAfter] = await transaction.query<[Array<Record<string, unknown>>]>(
        "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      );
      const [eventsBefore] = await transaction.query<[Array<{ sequence: number }>]>(
        "SELECT sequence FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: workId },
      );
      const resultJson = JSON.stringify({
        work: worksAfter[0],
        event: { event_id: legacyEventId, event_type: "work_state_changed" },
      });
      await transaction.query(
        "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: 'work_state_changed', actor_user_id: $actor_user_id, request_json: $request_json, payload_json: $payload_json, result_json: $result_json, created_at: time::now() };",
        {
          event_id: legacyEventId,
          organization_id: context.organizationId,
          work_id: workId,
          sequence: eventsBefore.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
          command_id: completion.commandId,
          actor_user_id: context.userId,
          request_json: legacyRequestJson,
          payload_json: JSON.stringify({ from: "verifying", to: "completed", recordsRunId: completion.recordsRunId }),
          result_json: resultJson,
        },
      );
    });

    const recovered = await port.complete(context, completion);

    expect(recovered.event.event_id).toBe(legacyEventId);
    const [runs] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM records_run WHERE records_run_id = 'records-run-1';",
    );
    expect(runs).toEqual([{ status: "completed", version: 4 }]);
    const [workEvents] = await database.query<[Array<{ event_id: string }>]>(
      "SELECT event_id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: completion.commandId },
    );
    expect(workEvents).toEqual([{ event_id: legacyEventId }]);
  });

  it("Records terminal write가 실패하면 Work와 Records 상태를 모두 유지한다", async () => {
    const finalized = await port.finalize(context, input());
    await database.query(
      "DEFINE EVENT fail_records_terminal_write ON TABLE records_run WHEN $event = 'UPDATE' AND $after.status = 'completed' THEN { THROW 'injected records terminal failure'; };",
    );

    await expect(port.complete(context, completionInput(finalized.work.revision))).rejects.toThrow(
      "injected records terminal failure",
    );
    const [worksAfter] = await database.query<[Array<{ status: string; revision: number }>]>(
      "SELECT status, revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: workId },
    );
    const [runsAfter] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM records_run WHERE organization_id = $organization_id AND records_run_id = 'records-run-1';",
      { organization_id: context.organizationId },
    );
    expect(worksAfter).toEqual([{ status: "verifying", revision: 6 }]);
    expect(runsAfter).toEqual([{ status: "finalized", version: 3 }]);
  });

  it("완료 transaction에서 tenant와 Records 계보 전체를 검증한다", async () => {
    const finalized = await port.finalize(context, input());
    const completion = completionInput(finalized.work.revision);

    await expect(port.complete(otherContext, completion)).rejects.toThrow("찾을 수 없습니다");
    await expect(port.complete(context, { ...completion, workId: "other-work" })).rejects.toThrow("찾을 수 없습니다");
    await expect(port.complete(context, { ...completion, expectedRevision: 5 })).rejects.toThrow("상태 또는 revision");
    await expect(port.complete(context, { ...completion, expectedRecordsVersion: 2 })).rejects.toThrow("계보");
    await expect(port.complete(context, { ...completion, verificationId: "other-verification" })).rejects.toThrow(
      "계보",
    );
    await expect(port.complete(context, { ...completion, recordsSnapshotHash: "b".repeat(64) })).rejects.toThrow(
      "계보",
    );
    await database.query("UPDATE records_run SET target_work_revision = 4 WHERE records_run_id = 'records-run-1';");
    await expect(port.complete(context, completion)).rejects.toThrow("계보");
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
        ...completionInput(finalized.work.revision),
      }),
    ).rejects.toThrow("checksum");
  });
});
