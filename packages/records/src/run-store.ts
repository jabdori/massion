import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { validateRecordsRun, type RecordsRun, type RecordsRunStatus } from "./contracts.js";
import type { DocumentationImpactAssessment } from "./contracts.js";
import type { DocumentationImpactEvaluation, DocumentationImpactProposalInput } from "./impact.js";
import { RECORDS_DOCUMENTATION_MIGRATION } from "./schema.js";

export interface StartRecordsRunInput {
  readonly commandId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
  readonly assuranceRunId: string;
  readonly snapshotHash: string;
  readonly rendererVersion: string;
}

interface RunRecord {
  readonly records_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly snapshot_hash: string;
  readonly renderer_version: string;
  readonly status: RecordsRunStatus;
  readonly version: number;
  readonly attempt: number;
  readonly command_id: string;
  readonly request_hash: string;
  readonly failure_json?: string;
  readonly created_by_user_id: string;
  readonly started_at: unknown;
  readonly completed_at?: unknown;
  readonly updated_at: unknown;
}

interface EventRecord {
  readonly records_run_id: string;
  readonly request_hash: string;
}

interface ImpactRecord {
  readonly assessment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly records_run_id: string;
  readonly kind: DocumentationImpactAssessment["kind"];
  readonly outcome: DocumentationImpactAssessment["outcome"];
  readonly rule_id: string;
  readonly reason: string;
  readonly source_reference_ids: readonly string[];
  readonly evaluator_version: string;
  readonly created_at: unknown;
}

export interface RecordDocumentationImpactsResult {
  readonly run: RecordsRun;
  readonly assessments: readonly DocumentationImpactAssessment[];
}

export interface CompleteRecordsRunInput {
  readonly commandId: string;
  readonly recordsRunId: string;
  readonly expectedVersion: number;
}

export interface CancelRecordsRunInput {
  readonly commandId: string;
  readonly recordsRunId: string;
}

interface WorkRecord {
  readonly work_id: string;
  readonly status: string;
  readonly revision: number;
}

interface VerificationRecord {
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly passed: boolean;
  readonly projected_work_revision: number;
  readonly created_at: unknown;
}

interface AssuranceRecord {
  readonly assurance_run_id: string;
  readonly status: string;
  readonly projected_work_revision?: number;
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

function requestHash(input: StartRecordsRunInput): string {
  return sha256(canonicalJson({ operation: "start", input }));
}

function guardKey(organizationId: string, input: StartRecordsRunInput): string {
  return sha256(
    canonicalJson({
      organizationId,
      workId: input.workId,
      targetWorkRevision: input.targetWorkRevision,
    }),
  );
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label}은 1~200자여야 합니다`);
}

function isoDateTime(value: unknown, label: string): string {
  let raw: string | undefined = typeof value === "string" ? value : undefined;
  if (value && typeof value === "object" && "toISOString" in value) {
    const converter = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof converter === "function") raw = String(converter.call(value));
  }
  if (raw !== undefined) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  throw new Error(`${label} datetime을 UTC ISO 형식으로 직렬화할 수 없습니다`);
}

export class RecordsRunStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<RecordsRunStore> {
    await applyMigrations(database, [RECORDS_DOCUMENTATION_MIGRATION]);
    return new RecordsRunStore(database, organizations);
  }

  public async start(context: TenantContext, input: StartRecordsRunInput): Promise<RecordsRun> {
    await this.organizations.verifyTenantContext(context);
    this.validateStart(input);
    const hash = requestHash(input);
    const replayed = await this.replay(this.database, context.organizationId, input.commandId, hash);
    if (replayed) return this.view(await this.find(this.database, context.organizationId, replayed.records_run_id));

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrentReplay = await this.replay(transaction, context.organizationId, input.commandId, hash);
      if (concurrentReplay) {
        return this.view(await this.find(transaction, context.organizationId, concurrentReplay.records_run_id));
      }
      await this.verifyTarget(transaction, context.organizationId, input);
      const [attempts] = await transaction.query<[{ attempt: number }[]]>(
        "SELECT attempt FROM records_run WHERE organization_id = $organization_id AND work_id = $work_id AND target_work_revision = $target_work_revision;",
        {
          organization_id: context.organizationId,
          work_id: input.workId,
          target_work_revision: input.targetWorkRevision,
        },
      );
      const attempt = attempts.reduce((maximum, candidate) => Math.max(maximum, candidate.attempt), 0) + 1;
      const recordsRunId = randomUUID();
      const [created] = await transaction.query<[RunRecord[]]>(
        "CREATE records_run CONTENT { records_run_id: $records_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: $target_work_revision, verification_id: $verification_id, assurance_run_id: $assurance_run_id, snapshot_hash: $snapshot_hash, renderer_version: $renderer_version, status: 'planned', version: 1, attempt: $attempt, command_id: $command_id, request_hash: $request_hash, active_guard_key: $active_guard_key, created_by_user_id: $created_by_user_id, started_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          records_run_id: recordsRunId,
          organization_id: context.organizationId,
          work_id: input.workId,
          target_work_revision: input.targetWorkRevision,
          verification_id: input.verificationId,
          assurance_run_id: input.assuranceRunId,
          snapshot_hash: input.snapshotHash,
          renderer_version: input.rendererVersion,
          attempt,
          command_id: input.commandId,
          request_hash: hash,
          active_guard_key: guardKey(context.organizationId, input),
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("Records run 생성 결과가 없습니다");
      await transaction.query(
        "CREATE records_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, command_id: $command_id, sequence: 1, event_type: 'records_run_started', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: input.workId,
          records_run_id: recordsRunId,
          command_id: input.commandId,
          request_hash: hash,
          payload_json: canonicalJson({ status: "planned", attempt }),
          actor_user_id: context.userId,
        },
      );
      return this.view(created[0]);
    });
  }

  public async get(context: TenantContext, recordsRunId: string): Promise<RecordsRun> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, recordsRunId));
  }

  public async cancel(context: TenantContext, input: CancelRecordsRunInput): Promise<RecordsRun> {
    await this.organizations.verifyTenantContext(context);
    assertIdentifier(input.commandId, "Command ID");
    assertIdentifier(input.recordsRunId, "Records run ID");
    const hash = sha256(canonicalJson({ operation: "cancel", input }));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [events] = await transaction.query<[EventRecord[]]>(
        "SELECT records_run_id, request_hash FROM records_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'records_run_cancelled' LIMIT 1;",
        {
          organization_id: context.organizationId,
          command_id: input.commandId,
        },
      );
      if (events[0]) {
        if (events[0].request_hash !== hash || events[0].records_run_id !== input.recordsRunId) {
          throw new Error("같은 command ID에 다른 Records cancellation payload를 사용할 수 없습니다");
        }
        return this.view(await this.find(transaction, context.organizationId, input.recordsRunId));
      }
      const current = await this.find(transaction, context.organizationId, input.recordsRunId);
      let result = current;
      if (!["completed", "blocked", "cancelled"].includes(current.status)) {
        const [updated] = await transaction.query<[RunRecord[]]>(
          "UPDATE records_run SET status = 'cancelled', version += 1, active_guard_key = NONE, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND records_run_id = $records_run_id AND version = $version AND status IN ['planned', 'rendering', 'finalized'] RETURN AFTER;",
          {
            organization_id: context.organizationId,
            records_run_id: input.recordsRunId,
            version: current.version,
          },
        );
        if (!updated[0]) {
          const concurrent = await this.find(transaction, context.organizationId, input.recordsRunId);
          if (!["completed", "blocked", "cancelled"].includes(concurrent.status)) {
            throw new Error("Records run cancellation 상태가 동시에 변경되었습니다");
          }
          result = concurrent;
        } else {
          result = updated[0];
        }
      }
      const [sequences] = await transaction.query<[{ sequence: number }[]]>(
        "SELECT sequence FROM records_event WHERE organization_id = $organization_id AND records_run_id = $records_run_id;",
        { organization_id: context.organizationId, records_run_id: input.recordsRunId },
      );
      await transaction.query(
        "CREATE records_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, command_id: $command_id, sequence: $sequence, event_type: 'records_run_cancelled', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: current.work_id,
          records_run_id: input.recordsRunId,
          command_id: input.commandId,
          sequence: sequences.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
          request_hash: hash,
          payload_json: canonicalJson({ from: current.status, to: result.status, version: result.version }),
          actor_user_id: context.userId,
        },
      );
      return this.view(result);
    });
  }

  public async complete(context: TenantContext, input: CompleteRecordsRunInput): Promise<RecordsRun> {
    await this.organizations.verifyTenantContext(context);
    assertIdentifier(input.commandId, "Command ID");
    assertIdentifier(input.recordsRunId, "Records run ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("Records run expected version이 잘못됐습니다");
    }
    const hash = sha256(canonicalJson({ operation: "complete", input }));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [events] = await transaction.query<[EventRecord[]]>(
        "SELECT records_run_id, request_hash FROM records_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'records_run_completed' LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (events[0]) {
        if (events[0].request_hash !== hash || events[0].records_run_id !== input.recordsRunId) {
          throw new Error("같은 command ID에 다른 Records completion payload를 사용할 수 없습니다");
        }
        return this.view(await this.find(transaction, context.organizationId, input.recordsRunId));
      }
      const current = await this.find(transaction, context.organizationId, input.recordsRunId);
      if (current.status !== "finalized" || current.version !== input.expectedVersion) {
        throw new Error("Records run terminal 전이의 status 또는 version이 다릅니다");
      }
      const [works] = await transaction.query<[{ status: string; revision: number }[]]>(
        "SELECT status, revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: current.work_id },
      );
      const work = works[0];
      if (work?.status !== "completed" || work.revision !== current.target_work_revision + 2) {
        throw new Error("Records run terminal 전이에는 N+3 completed Work가 필요합니다");
      }
      const [updated] = await transaction.query<[RunRecord[]]>(
        "UPDATE records_run SET status = 'completed', version += 1, active_guard_key = NONE, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND records_run_id = $records_run_id RETURN AFTER;",
        { organization_id: context.organizationId, records_run_id: input.recordsRunId },
      );
      if (!updated[0]) throw new Error("Records run completed 전이 결과가 없습니다");
      await transaction.query(
        "CREATE records_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, command_id: $command_id, sequence: $sequence, event_type: 'records_run_completed', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: current.work_id,
          records_run_id: input.recordsRunId,
          command_id: input.commandId,
          sequence: updated[0].version,
          request_hash: hash,
          payload_json: canonicalJson({ status: "completed", workRevision: work.revision }),
          actor_user_id: context.userId,
        },
      );
      return this.view(updated[0]);
    });
  }

  public async recordImpacts(
    context: TenantContext,
    commandId: string,
    recordsRunId: string,
    evaluation: DocumentationImpactEvaluation,
    proposals: readonly DocumentationImpactProposalInput[] = [],
  ): Promise<RecordDocumentationImpactsResult> {
    await this.organizations.verifyTenantContext(context);
    assertIdentifier(commandId, "Command ID");
    assertIdentifier(recordsRunId, "Records run ID");
    const hash = sha256(canonicalJson({ operation: "recordImpacts", commandId, recordsRunId, evaluation, proposals }));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [events] = await transaction.query<[{ request_hash: string }[]]>(
        "SELECT request_hash FROM records_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'records_impacts_evaluated' LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (events[0]) {
        if (events[0].request_hash !== hash)
          throw new Error("같은 command ID에 다른 impact payload를 사용할 수 없습니다");
        const run = this.view(await this.find(transaction, context.organizationId, recordsRunId));
        return { run, assessments: await this.listAssessments(transaction, context.organizationId, recordsRunId) };
      }
      const current = await this.find(transaction, context.organizationId, recordsRunId);
      if (current.status !== "planned") throw new Error("Documentation impact는 planned Records run에서만 확정합니다");
      const assessments = Object.values(evaluation).sort((left, right) => left.kind.localeCompare(right.kind));
      if (
        assessments.length !== 4 ||
        new Set(assessments.map((assessment) => assessment.kind)).size !== 4 ||
        assessments.some(
          (assessment) =>
            assessment.organizationId !== context.organizationId ||
            assessment.workId !== current.work_id ||
            assessment.recordsRunId !== recordsRunId,
        )
      ) {
        throw new Error("Documentation impact evaluation이 Records run과 일치하지 않습니다");
      }
      for (const proposal of proposals) {
        await transaction.query(
          "CREATE documentation_impact_proposal CONTENT { proposal_id: $proposal_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, kind: $kind, rule_hint: $rule_hint, reason: $reason, source_reference_ids: $source_reference_ids, created_at: time::now() };",
          {
            proposal_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: current.work_id,
            records_run_id: recordsRunId,
            kind: proposal.kind,
            rule_hint: proposal.ruleHint,
            reason: proposal.reason,
            source_reference_ids: proposal.sourceReferenceIds,
          },
        );
      }
      for (const assessment of assessments) {
        await transaction.query(
          "CREATE documentation_impact_assessment CONTENT { assessment_id: $assessment_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, kind: $kind, outcome: $outcome, rule_id: $rule_id, reason: $reason, source_reference_ids: $source_reference_ids, evaluator_version: $evaluator_version, created_at: $created_at };",
          {
            assessment_id: assessment.assessmentId,
            organization_id: context.organizationId,
            work_id: current.work_id,
            records_run_id: recordsRunId,
            kind: assessment.kind,
            outcome: assessment.outcome,
            rule_id: assessment.ruleId,
            reason: assessment.reason,
            source_reference_ids: assessment.sourceReferenceIds,
            evaluator_version: assessment.evaluatorVersion,
            created_at: new Date(assessment.createdAt),
          },
        );
      }
      const [updated] = await transaction.query<[RunRecord[]]>(
        "UPDATE records_run SET status = 'rendering', version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND records_run_id = $records_run_id RETURN AFTER;",
        { organization_id: context.organizationId, records_run_id: recordsRunId },
      );
      if (!updated[0]) throw new Error("Records run rendering 전이 결과가 없습니다");
      await transaction.query(
        "CREATE records_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, command_id: $command_id, sequence: $sequence, event_type: 'records_impacts_evaluated', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: current.work_id,
          records_run_id: recordsRunId,
          command_id: commandId,
          sequence: updated[0].version,
          request_hash: hash,
          payload_json: canonicalJson({
            requiredKinds: assessments
              .filter((assessment) => assessment.outcome === "required")
              .map((assessment) => assessment.kind)
              .sort(),
          }),
          actor_user_id: context.userId,
        },
      );
      return { run: this.view(updated[0]), assessments };
    });
  }

  private validateStart(input: StartRecordsRunInput): void {
    assertIdentifier(input.commandId, "Command ID");
    assertIdentifier(input.workId, "Work ID");
    assertIdentifier(input.verificationId, "Verification ID");
    assertIdentifier(input.assuranceRunId, "Assurance run ID");
    assertIdentifier(input.rendererVersion, "Renderer version");
    if (!Number.isSafeInteger(input.targetWorkRevision) || input.targetWorkRevision < 1) {
      throw new Error("target Work revision은 1 이상인 안전한 정수여야 합니다");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.snapshotHash)) throw new Error("Snapshot hash는 SHA-256 형식이어야 합니다");
  }

  private async verifyTarget(
    executor: QueryExecutor,
    organizationId: string,
    input: StartRecordsRunInput,
  ): Promise<void> {
    const [works] = await executor.query<[WorkRecord[]]>(
      "SELECT work_id, status, revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId },
    );
    const work = works[0];
    if (!work) throw new Error("Records target Work를 찾을 수 없습니다");
    if (work.status !== "verifying") throw new Error("Records target Work는 verifying 상태여야 합니다");
    if (work.revision !== input.targetWorkRevision) throw new Error("Records target Work revision이 다릅니다");

    const [verifications] = await executor.query<[VerificationRecord[]]>(
      "SELECT verification_id, assurance_run_id, passed, projected_work_revision, created_at FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at DESC LIMIT 1;",
      { organization_id: organizationId, work_id: input.workId },
    );
    const verification = verifications[0];
    if (
      !verification ||
      !verification.passed ||
      verification.verification_id !== input.verificationId ||
      verification.assurance_run_id !== input.assuranceRunId ||
      verification.projected_work_revision !== input.targetWorkRevision
    ) {
      throw new Error("최신 passed WorkVerification이 Records target과 일치하지 않습니다");
    }
    const [runs] = await executor.query<[AssuranceRecord[]]>(
      "SELECT assurance_run_id, status, projected_work_revision FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const assurance = runs[0];
    if (!assurance || assurance.status !== "passed" || assurance.projected_work_revision !== input.targetWorkRevision) {
      throw new Error("Passed Assurance run projection이 Records target과 일치하지 않습니다");
    }
  }

  private async replay(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    hash: string,
  ): Promise<EventRecord | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT records_run_id, request_hash FROM records_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'records_run_started' LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const event = events[0];
    if (event && event.request_hash !== hash) throw new Error("같은 command ID에 다른 payload를 사용할 수 없습니다");
    return event;
  }

  private async find(executor: QueryExecutor, organizationId: string, recordsRunId: string): Promise<RunRecord> {
    const [runs] = await executor.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM records_run WHERE organization_id = $organization_id AND records_run_id = $records_run_id LIMIT 1;",
      { organization_id: organizationId, records_run_id: recordsRunId },
    );
    if (!runs[0]) throw new Error(`Records run을 찾을 수 없습니다: ${recordsRunId}`);
    return runs[0];
  }

  private async listAssessments(
    executor: QueryExecutor,
    organizationId: string,
    recordsRunId: string,
  ): Promise<readonly DocumentationImpactAssessment[]> {
    const [records] = await executor.query<[ImpactRecord[]]>(
      "SELECT * OMIT id FROM documentation_impact_assessment WHERE organization_id = $organization_id AND records_run_id = $records_run_id ORDER BY kind ASC;",
      { organization_id: organizationId, records_run_id: recordsRunId },
    );
    return records.map((record) => ({
      assessmentId: record.assessment_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      recordsRunId: record.records_run_id,
      kind: record.kind,
      outcome: record.outcome,
      ruleId: record.rule_id,
      reason: record.reason,
      sourceReferenceIds: record.source_reference_ids,
      evaluatorVersion: record.evaluator_version,
      createdAt: isoDateTime(record.created_at, "Impact createdAt"),
    }));
  }

  private view(record: RunRecord): RecordsRun {
    const run: RecordsRun = {
      recordsRunId: record.records_run_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      targetWorkRevision: record.target_work_revision,
      verificationId: record.verification_id,
      assuranceRunId: record.assurance_run_id,
      snapshotHash: record.snapshot_hash,
      rendererVersion: record.renderer_version,
      status: record.status,
      version: record.version,
      attempt: record.attempt,
      commandId: record.command_id,
      requestHash: record.request_hash,
      ...(record.failure_json
        ? { failure: JSON.parse(record.failure_json) as NonNullable<RecordsRun["failure"]> }
        : {}),
      createdByUserId: record.created_by_user_id,
      startedAt: isoDateTime(record.started_at, "startedAt"),
      ...(record.completed_at ? { completedAt: isoDateTime(record.completed_at, "completedAt") } : {}),
      updatedAt: isoDateTime(record.updated_at, "updatedAt"),
    };
    validateRecordsRun(run);
    return run;
  }
}
