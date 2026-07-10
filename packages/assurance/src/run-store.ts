import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type {
  AssuranceEvent,
  AssuranceFailure,
  AssuranceRun,
  AssuranceRunResult,
  AssuranceRunStatus,
  AssuranceVerdict,
  StartAssuranceRunInput,
} from "./contracts.js";
import { verifyAssuranceStartIndependence } from "./database-independence.js";
import {
  buildDatabaseAssuranceSnapshot,
  type DatabaseAssuranceSnapshotInput,
  type DatabaseAssuranceSnapshotResult,
} from "./database-snapshot.js";
import { ASSURANCE_DECISION_EVIDENCE_MIGRATION, ASSURANCE_RUN_MIGRATION } from "./schema.js";

interface RunRecord {
  readonly assurance_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly plan_version_id: string;
  readonly binding_version_id: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly verifier_handle: string;
  readonly verifier_execution_id: string;
  readonly snapshot_hash: string;
  readonly status: AssuranceRunStatus;
  readonly version: number;
  readonly attempt: number;
  readonly start_command_id: string;
  readonly verdict?: AssuranceVerdict;
  readonly projected_work_revision?: number;
  readonly failure_json?: string;
  readonly decision_evidence_hash?: string;
  readonly decision_guard_revision?: number;
  readonly created_by_user_id: string;
  readonly expires_at: unknown;
  readonly started_at: unknown;
  readonly completed_at?: unknown;
  readonly updated_at: unknown;
}

interface EventRecord {
  readonly event_id: string;
  readonly organization_id: string;
  readonly assurance_run_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly request_hash: string;
  readonly payload_json: string;
  readonly actor_user_id: string;
  readonly created_at: unknown;
}

export interface TransitionAssuranceRunInput {
  readonly commandId: string;
  readonly assuranceRunId: string;
  readonly expectedVersion: number;
  readonly target: Exclude<AssuranceRunStatus, "planned">;
  readonly failure?: AssuranceFailure;
  readonly decisionEvidenceHash?: string;
}

const TERMINAL = new Set<AssuranceRunStatus>(["passed", "failed", "blocked", "cancelled"]);
const NEXT: Readonly<Record<"planned" | "running", readonly AssuranceRunStatus[]>> = {
  planned: ["running", "blocked", "cancelled"],
  running: ["passed", "failed", "blocked", "cancelled"],
};

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

function isoDateTime(value: unknown, label: string): string {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  if (value && typeof value === "object" && "toISOString" in value) {
    const convert = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof convert === "function") raw = String(convert.call(value));
  }
  if (raw !== undefined) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(`${label} datetime을 UTC ISO 형식으로 직렬화할 수 없습니다`);
}

function requestHash(operation: string, input: unknown): string {
  return sha256(canonicalJson({ operation, input }));
}

function assertText(value: string, label: string, maximum = 200): void {
  if (!value.trim()) throw new Error(`${label}이 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function guardKey(organizationId: string, input: StartAssuranceRunInput): string {
  return sha256(
    canonicalJson({
      organizationId,
      workId: input.workId,
      targetWorkRevision: input.targetWorkRevision,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
    }),
  );
}

export class AssuranceRunStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<AssuranceRunStore> {
    await applyMigrations(database, [ASSURANCE_RUN_MIGRATION, ASSURANCE_DECISION_EVIDENCE_MIGRATION]);
    return new AssuranceRunStore(database, organizations);
  }

  public async start(context: TenantContext, input: StartAssuranceRunInput): Promise<AssuranceRunResult> {
    await this.organizations.verifyTenantContext(context);
    this.validateStart(input);
    const hash = requestHash("start", input);
    const replayed = await this.replay(context.organizationId, input.commandId, hash);
    if (replayed) return { run: await this.get(context, replayed.assurance_run_id) };

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrentReplay = await this.replay(context.organizationId, input.commandId, hash, transaction);
      if (concurrentReplay) {
        return {
          run: this.view(await this.find(transaction, context.organizationId, concurrentReplay.assurance_run_id)),
        };
      }

      await verifyAssuranceStartIndependence(transaction, context.organizationId, input);
      const prepared = await buildDatabaseAssuranceSnapshot(transaction, context.organizationId, input);
      if (prepared.snapshot.hash !== input.snapshotHash) {
        throw new Error("caller snapshot hash가 현재 Work material snapshot과 일치하지 않습니다");
      }

      const key = guardKey(context.organizationId, input);
      const assuranceRunId = randomUUID();
      const [attempts] = await transaction.query<[{ attempt: number }[]]>(
        "SELECT attempt FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND target_work_revision = $target_work_revision AND profile_id = $profile_id AND profile_version = $profile_version;",
        {
          organization_id: context.organizationId,
          work_id: input.workId,
          target_work_revision: input.targetWorkRevision,
          profile_id: input.profileId,
          profile_version: input.profileVersion,
        },
      );
      const attempt = attempts.reduce((maximum, record) => Math.max(maximum, record.attempt), 0) + 1;
      const [created] = await transaction.query<[RunRecord[]]>(
        "CREATE assurance_run CONTENT { assurance_run_id: $assurance_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: $target_work_revision, plan_version_id: $plan_version_id, binding_version_id: $binding_version_id, profile_id: $profile_id, profile_version: $profile_version, verifier_handle: $verifier_handle, verifier_execution_id: $verifier_execution_id, snapshot_hash: $snapshot_hash, status: 'planned', version: 1, attempt: $attempt, start_command_id: $start_command_id, active_guard_key: $active_guard_key, created_by_user_id: $created_by_user_id, expires_at: time::now() + duration::from_millis($lease_ttl_ms), started_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          assurance_run_id: assuranceRunId,
          organization_id: context.organizationId,
          work_id: input.workId,
          target_work_revision: input.targetWorkRevision,
          plan_version_id: input.planVersionId,
          binding_version_id: input.bindingVersionId,
          profile_id: input.profileId,
          profile_version: input.profileVersion,
          verifier_handle: input.verifierHandle,
          verifier_execution_id: input.verifierExecutionId,
          snapshot_hash: input.snapshotHash,
          attempt,
          start_command_id: input.commandId,
          active_guard_key: key,
          created_by_user_id: context.userId,
          lease_ttl_ms: input.leaseTtlMs,
        },
      );
      if (!created[0]) throw new Error("Assurance run 생성 결과가 없습니다");
      for (const criterion of prepared.criteria) {
        await transaction.query(
          "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: $criterion_key, source: $source, statement: $statement, method: $method, required_evidence_kinds: $required_evidence_kinds, control_references: $control_references, status: $status, exclusion_rule: $exclusion_rule, exclusion_reason: $exclusion_reason, exclusion_actor_id: $exclusion_actor_id, created_at: time::now(), updated_at: time::now() };",
          {
            criterion_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: input.workId,
            assurance_run_id: assuranceRunId,
            criterion_key: criterion.criterionKey,
            source: criterion.source,
            statement: criterion.statement,
            method: criterion.method,
            required_evidence_kinds: criterion.requiredEvidenceKinds,
            control_references: criterion.controlReferences,
            status: criterion.status,
            exclusion_rule: criterion.exclusionRule,
            exclusion_reason: criterion.exclusionReason,
            exclusion_actor_id: criterion.exclusionActorId,
          },
        );
      }
      await this.recordEvent(transaction, context, {
        assuranceRunId,
        commandId: input.commandId,
        sequence: 1,
        eventType: "assurance_run_started",
        requestHash: hash,
        payload: {
          status: "planned",
          attempt,
          snapshotCanonicalJson: prepared.snapshot.canonicalJson,
        },
      });
      return { run: this.view(created[0]) };
    });
  }

  public async transition(context: TenantContext, input: TransitionAssuranceRunInput): Promise<AssuranceRunResult> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(
      async (transaction) => await this.transitionInTransaction(context, input, transaction),
    );
  }

  public async transitionInTransaction(
    context: TenantContext,
    input: TransitionAssuranceRunInput,
    transaction: QueryExecutor,
  ): Promise<AssuranceRunResult> {
    await this.organizations.verifyTenantContext(context, undefined, transaction);
    this.validateTransition(input);
    const hash = requestHash("transition", {
      commandId: input.commandId,
      assuranceRunId: input.assuranceRunId,
      expectedVersion: input.expectedVersion,
      target: input.target,
      ...(input.failure ? { failure: input.failure } : {}),
    });
    const decisionEvidenceHash =
      input.decisionEvidenceHash ??
      sha256(
        canonicalJson({
          assuranceRunId: input.assuranceRunId,
          expectedVersion: input.expectedVersion,
          target: input.target,
          failure: input.failure,
        }),
      );
    const replayed = await this.replay(context.organizationId, input.commandId, hash, transaction);
    if (replayed) {
      return { run: this.view(await this.find(transaction, context.organizationId, replayed.assurance_run_id)) };
    }
    const current = await this.find(transaction, context.organizationId, input.assuranceRunId);
    if (current.version !== input.expectedVersion) throw new Error("Assurance run version 충돌입니다");
    if (TERMINAL.has(current.status)) throw new Error("terminal assurance run은 변경할 수 없습니다");
    if (current.status !== "planned" && current.status !== "running") {
      throw new Error(`알 수 없는 active assurance 상태입니다: ${current.status}`);
    }
    if (!NEXT[current.status].includes(input.target)) {
      throw new Error(`허용되지 않은 assurance 상태 전이입니다: ${current.status} -> ${input.target}`);
    }

    const nextVersion = current.version + 1;
    const verdict = this.verdict(input.target);
    let decisionGuardRevision: number | undefined;
    if (verdict || input.target === "cancelled") {
      const [guards] = await transaction.query<[{ revision: number }[]]>(
        "UPDATE assurance_evidence_guard SET revision += 1, updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id RETURN AFTER;",
        { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
      );
      decisionGuardRevision = guards[0]?.revision;
      if (
        typeof decisionGuardRevision !== "number" ||
        !Number.isSafeInteger(decisionGuardRevision) ||
        decisionGuardRevision < 1
      ) {
        throw new Error("Assurance evidence guard를 획득할 수 없습니다");
      }
    }
    const terminalGuardRevision = decisionGuardRevision ?? 0;
    const [updated] = verdict
      ? await transaction.query<[RunRecord[]]>(
          "UPDATE assurance_run SET status = $status, version = $version, active_guard_key = NONE, verdict = $verdict, failure_json = $failure_json, decision_evidence_hash = $decision_evidence_hash, decision_guard_revision = $decision_guard_revision, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id RETURN AFTER;",
          {
            status: input.target,
            version: nextVersion,
            verdict,
            failure_json: input.failure ? canonicalJson(input.failure) : undefined,
            decision_evidence_hash: decisionEvidenceHash,
            decision_guard_revision: terminalGuardRevision,
            organization_id: context.organizationId,
            assurance_run_id: input.assuranceRunId,
          },
        )
      : input.target === "cancelled"
        ? await transaction.query<[RunRecord[]]>(
            "UPDATE assurance_run SET status = 'cancelled', version = $version, active_guard_key = NONE, decision_evidence_hash = $decision_evidence_hash, decision_guard_revision = $decision_guard_revision, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id RETURN AFTER;",
            {
              version: nextVersion,
              decision_evidence_hash: decisionEvidenceHash,
              decision_guard_revision: terminalGuardRevision,
              organization_id: context.organizationId,
              assurance_run_id: input.assuranceRunId,
            },
          )
        : await transaction.query<[RunRecord[]]>(
            "UPDATE assurance_run SET status = 'running', version = $version, updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id RETURN AFTER;",
            {
              version: nextVersion,
              organization_id: context.organizationId,
              assurance_run_id: input.assuranceRunId,
            },
          );
    if (!updated[0]) throw new Error("Assurance run 전이 결과가 없습니다");
    await this.recordEvent(transaction, context, {
      assuranceRunId: current.assurance_run_id,
      commandId: input.commandId,
      sequence: nextVersion,
      eventType: `assurance_run_${input.target}`,
      requestHash: hash,
      payload: {
        from: current.status,
        to: input.target,
        version: nextVersion,
        ...(TERMINAL.has(input.target) ? { decisionEvidenceHash } : {}),
      },
    });
    return { run: this.view(updated[0]) };
  }

  public async get(context: TenantContext, assuranceRunId: string): Promise<AssuranceRun> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, assuranceRunId));
  }

  public async getInTransaction(
    context: TenantContext,
    assuranceRunId: string,
    transaction: QueryExecutor,
  ): Promise<AssuranceRun> {
    await this.organizations.verifyTenantContext(context, undefined, transaction);
    return this.view(await this.find(transaction, context.organizationId, assuranceRunId));
  }

  public async prepareSnapshot(
    context: TenantContext,
    input: DatabaseAssuranceSnapshotInput,
  ): Promise<DatabaseAssuranceSnapshotResult> {
    await this.organizations.verifyTenantContext(context);
    return await buildDatabaseAssuranceSnapshot(this.database, context.organizationId, input);
  }

  public async listEvents(context: TenantContext, assuranceRunId: string): Promise<AssuranceEvent[]> {
    await this.get(context, assuranceRunId);
    const [records] = await this.database.query<[EventRecord[]]>(
      "SELECT * OMIT id FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, assurance_run_id: assuranceRunId },
    );
    return records.map((record) => ({
      eventId: record.event_id,
      organizationId: record.organization_id,
      assuranceRunId: record.assurance_run_id,
      commandId: record.command_id,
      sequence: record.sequence,
      eventType: record.event_type,
      requestHash: record.request_hash,
      payloadJson: record.payload_json,
      actorUserId: record.actor_user_id,
      createdAt: isoDateTime(record.created_at, "Assurance Event createdAt"),
    }));
  }

  private validateStart(input: StartAssuranceRunInput): void {
    assertText(input.commandId, "Command ID");
    assertText(input.workId, "Work ID");
    if (!Number.isSafeInteger(input.targetWorkRevision) || input.targetWorkRevision < 1) {
      throw new Error("Target Work revision은 1 이상의 정수여야 합니다");
    }
    assertText(input.planVersionId, "PlanVersion ID");
    assertText(input.bindingVersionId, "BindingVersion ID");
    assertText(input.profileId, "Profile ID");
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(input.profileId)) throw new Error("Profile ID 형식이 올바르지 않습니다");
    assertText(input.profileVersion, "Profile version", 100);
    if (input.verifierHandle !== "assurance") throw new Error("최종 verifier handle은 assurance여야 합니다");
    assertText(input.verifierExecutionId, "Verifier Runtime Execution ID");
    assertSha256(input.snapshotHash, "Assurance snapshot hash");
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs < 1_000 || input.leaseTtlMs > 86_400_000) {
      throw new Error("Assurance run TTL은 1초 이상 24시간 이하여야 합니다");
    }
  }

  private validateTransition(input: TransitionAssuranceRunInput): void {
    assertText(input.commandId, "Command ID");
    assertText(input.assuranceRunId, "Assurance run ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("Expected version은 1 이상의 정수여야 합니다");
    }
    if (input.target === "failed" || input.target === "blocked") {
      if (!input.failure) throw new Error(`${input.target} 전이에는 failure metadata가 필요합니다`);
      assertText(input.failure.category, "Failure category", 100);
      assertSha256(input.failure.causeHash, "Failure cause hash");
    } else if (input.failure) {
      throw new Error(`${input.target} 전이에는 failure metadata를 사용할 수 없습니다`);
    }
    if (input.decisionEvidenceHash !== undefined) {
      if (input.target === "running") throw new Error("running 전이에는 decision evidence hash를 사용할 수 없습니다");
      assertSha256(input.decisionEvidenceHash, "Decision evidence hash");
    }
  }

  private verdict(status: AssuranceRunStatus): AssuranceVerdict | undefined {
    if (status === "passed" || status === "failed" || status === "blocked") return status;
    return undefined;
  }

  private async replay(
    organizationId: string,
    commandId: string,
    hash: string,
    executor: QueryExecutor = this.database,
  ): Promise<EventRecord | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT * OMIT id FROM assurance_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_hash !== hash) {
      throw new Error("같은 command ID에 다른 assurance 명령을 사용할 수 없습니다");
    }
    return events[0];
  }

  private async find(executor: QueryExecutor, organizationId: string, assuranceRunId: string): Promise<RunRecord> {
    const [records] = await executor.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM assurance_run WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: organizationId, assurance_run_id: assuranceRunId },
    );
    if (!records[0]) throw new Error(`Assurance run을 찾을 수 없습니다: ${assuranceRunId}`);
    return records[0];
  }

  private async recordEvent(
    executor: QueryExecutor,
    context: TenantContext,
    input: {
      readonly assuranceRunId: string;
      readonly commandId: string;
      readonly sequence: number;
      readonly eventType: string;
      readonly requestHash: string;
      readonly payload: unknown;
    },
  ): Promise<void> {
    const [events] = await executor.query<[{ sequence: number }[]]>(
      "SELECT sequence FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
    );
    const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    await executor.query(
      "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: input.assuranceRunId,
        command_id: input.commandId,
        sequence,
        event_type: input.eventType,
        request_hash: input.requestHash,
        payload_json: canonicalJson(input.payload),
        actor_user_id: context.userId,
      },
    );
  }

  private view(record: RunRecord): AssuranceRun {
    const failure = record.failure_json ? (JSON.parse(record.failure_json) as AssuranceFailure) : undefined;
    return {
      assuranceRunId: record.assurance_run_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      targetWorkRevision: record.target_work_revision,
      planVersionId: record.plan_version_id,
      bindingVersionId: record.binding_version_id,
      profileId: record.profile_id,
      profileVersion: record.profile_version,
      verifierHandle: record.verifier_handle,
      verifierExecutionId: record.verifier_execution_id,
      snapshotHash: record.snapshot_hash,
      status: record.status,
      version: record.version,
      attempt: record.attempt,
      startCommandId: record.start_command_id,
      ...(record.verdict ? { verdict: record.verdict } : {}),
      ...(record.projected_work_revision !== undefined
        ? { projectedWorkRevision: record.projected_work_revision }
        : {}),
      ...(failure ? { failure } : {}),
      ...(record.decision_evidence_hash ? { decisionEvidenceHash: record.decision_evidence_hash } : {}),
      ...(record.decision_guard_revision !== undefined
        ? { decisionGuardRevision: record.decision_guard_revision }
        : {}),
      createdByUserId: record.created_by_user_id,
      expiresAt: isoDateTime(record.expires_at, "Assurance run expiresAt"),
      startedAt: isoDateTime(record.started_at, "Assurance run startedAt"),
      ...(record.completed_at !== undefined
        ? { completedAt: isoDateTime(record.completed_at, "Assurance run completedAt") }
        : {}),
      updatedAt: isoDateTime(record.updated_at, "Assurance run updatedAt"),
    };
  }
}
