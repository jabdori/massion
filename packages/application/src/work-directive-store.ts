import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ApplicationRunStage, ApplicationRunStatus } from "./run-store.js";
import { APPLICATION_WORK_DIRECTIVE_MIGRATION, APPLICATION_WORK_DIRECTIVE_MUTATION_MIGRATION } from "./schema.js";

export type WorkDirectiveMode = "now" | "next-stage";
export type WorkDirectiveStatus = "queued" | "applying" | "applied" | "failed" | "unapplied" | "cancelled";

export class WorkDirectiveBusyError extends Error {
  public constructor() {
    super("Work directive applying 지시가 이미 처리 중입니다");
    this.name = "WorkDirectiveBusyError";
  }
}

export interface WorkDirectiveClock {
  readonly now: Date;
}

export interface WorkDirectiveView {
  readonly directiveId: string;
  readonly organizationId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly workId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly content: string;
  readonly mode: WorkDirectiveMode;
  readonly submittedStage: Exclude<ApplicationRunStage, "terminal">;
  readonly status: WorkDirectiveStatus;
  readonly revision: number;
  readonly leaseGeneration: number;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DirectiveRecord {
  readonly directive_id: string;
  readonly organization_id: string;
  readonly actor_user_id: string;
  readonly command_id: string;
  readonly correlation_id: string;
  readonly work_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly content: string;
  readonly content_hash: string;
  readonly request_hash: string;
  readonly mode: WorkDirectiveMode;
  readonly submitted_stage: Exclude<ApplicationRunStage, "terminal">;
  readonly status: WorkDirectiveStatus;
  readonly revision: number;
  readonly lease_generation: number;
  readonly lease_expires_at?: unknown;
  readonly last_mutation_command_id?: string;
  readonly last_mutation_request_hash?: string;
  readonly failure_reason?: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface RunBoundaryRecord {
  readonly run_id: string;
  readonly work_id?: string;
  readonly stage: ApplicationRunStage;
  readonly status: ApplicationRunStatus;
  readonly lease_generation: number;
  readonly directive_sequence: number;
  readonly retry_attempt_id?: string;
  readonly updated_at: unknown;
}

interface WorkBoundaryRecord {
  readonly work_id: string;
  readonly status: string;
  readonly revision: number;
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

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Work directive datetime이 유효하지 않습니다");
  return date.toISOString();
}

function validateContent(value: string): string {
  const content = value.trim();
  if (!content || Buffer.byteLength(content, "utf8") > 64 * 1024 || /\0/u.test(content)) {
    throw new Error("Work directive 내용이 유효하지 않습니다");
  }
  return content;
}

export class WorkDirectiveStore {
  private readonly clock: WorkDirectiveClock;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly leaseMs: number,
    clock?: WorkDirectiveClock,
  ) {
    this.clock = clock ?? {
      get now() {
        return new Date();
      },
    };
  }

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    input: { readonly leaseMs?: number; readonly clock?: WorkDirectiveClock } = {},
  ): Promise<WorkDirectiveStore> {
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Work directive lease 범위가 유효하지 않습니다");
    }
    await applyMigrations(database, [
      APPLICATION_WORK_DIRECTIVE_MIGRATION,
      APPLICATION_WORK_DIRECTIVE_MUTATION_MIGRATION,
    ]);
    return new WorkDirectiveStore(database, organizations, leaseMs, input.clock);
  }

  public async submit(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly correlationId: string;
      readonly expectedRevision: number;
      readonly workId: string;
      readonly runId: string;
      readonly content: string;
      readonly mode: WorkDirectiveMode;
    },
  ): Promise<WorkDirectiveView> {
    await this.organizations.verifyTenantContext(context);
    const content = validateContent(input.content);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("Work revision이 유효하지 않습니다");
    }
    if (!(["now", "next-stage"] as const).includes(input.mode)) {
      throw new Error("Work directive mode가 유효하지 않습니다");
    }
    const requestHash = sha256(canonicalJson({ ...input, content }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          await this.organizations.verifyTenantContext(context, undefined, transaction);
          const repeated = await first<DirectiveRecord>(
            transaction,
            "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
            { organization_id: context.organizationId, command_id: input.commandId },
          );
          if (repeated) {
            if (repeated.request_hash !== requestHash) {
              throw new Error("같은 commandId에 다른 Work directive 요청을 사용할 수 없습니다");
            }
            return this.view(repeated);
          }
          const run = await first<RunBoundaryRecord>(
            transaction,
            "SELECT run_id, work_id, stage, status, lease_generation, directive_sequence FROM application_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
            { organization_id: context.organizationId, run_id: input.runId },
          );
          if (!run) throw new Error("Application run을 찾을 수 없습니다");
          if (["completed", "failed", "cancelled"].includes(run.status) || run.stage === "terminal") {
            throw new Error("종료된 실행에는 지시를 보낼 수 없습니다. work.follow-up으로 후속 Work를 생성하세요");
          }
          if (run.work_id !== input.workId) throw new Error("Work와 Application run 연결이 일치하지 않습니다");
          const work = await first<WorkBoundaryRecord>(
            transaction,
            "SELECT work_id, status, revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
            { organization_id: context.organizationId, work_id: input.workId },
          );
          if (!work) throw new Error("Work를 찾을 수 없습니다");
          if (["completed", "cancelled"].includes(work.status)) {
            throw new Error("종료된 Work에는 지시를 보낼 수 없습니다. work.follow-up으로 후속 Work를 생성하세요");
          }
          if (work.revision !== input.expectedRevision) {
            throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
          }
          const sequence = run.directive_sequence + 1;
          const [sequenceUpdates] = await transaction.query<[RunBoundaryRecord[]]>(
            "UPDATE application_run SET directive_sequence = $sequence WHERE organization_id = $organization_id AND run_id = $run_id AND directive_sequence = $previous_sequence RETURN AFTER;",
            {
              organization_id: context.organizationId,
              run_id: input.runId,
              previous_sequence: run.directive_sequence,
              sequence,
            },
          );
          if (!sequenceUpdates[0]) throw new Error("Work directive sequence conflict입니다");
          const directiveId = randomUUID();
          const createdAt = this.clock.now.toISOString();
          await transaction.query(
            "CREATE application_work_directive CONTENT { directive_id: $directive_id, organization_id: $organization_id, actor_user_id: $actor_user_id, command_id: $command_id, correlation_id: $correlation_id, work_id: $work_id, run_id: $run_id, sequence: $sequence, content: $content, content_hash: $content_hash, request_hash: $request_hash, mode: $mode, submitted_stage: $submitted_stage, status: 'queued', revision: 1, lease_generation: 0, lease_expires_at: NONE, failure_reason: NONE, last_mutation_command_id: NONE, last_mutation_request_hash: NONE, created_at: <datetime>$created_at, updated_at: <datetime>$created_at };",
            {
              directive_id: directiveId,
              organization_id: context.organizationId,
              actor_user_id: context.userId,
              command_id: input.commandId,
              correlation_id: input.correlationId,
              work_id: input.workId,
              run_id: input.runId,
              sequence,
              content,
              content_hash: sha256(content),
              request_hash: requestHash,
              mode: input.mode,
              submitted_stage: run.stage,
              created_at: createdAt,
            },
          );
          return this.view(await this.find(transaction, context.organizationId, directiveId));
        });
      } catch (error) {
        const repeated = await first<DirectiveRecord>(
          this.database,
          "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
          { organization_id: context.organizationId, command_id: input.commandId },
        );
        if (repeated) {
          if (repeated.request_hash !== requestHash) {
            throw new Error("같은 commandId에 다른 Work directive 요청을 사용할 수 없습니다", { cause: error });
          }
          return this.view(repeated);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 2 || !/application_work_directive_(?:sequence|command)|conflict/iu.test(message)) throw error;
      }
    }
    throw new Error("Work directive 저장 동시성 충돌을 해결하지 못했습니다");
  }

  public async update(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedWorkRevision: number;
      readonly expectedDirectiveRevision: number;
      readonly workId: string;
      readonly directiveId: string;
      readonly content: string;
      readonly mode: WorkDirectiveMode;
    },
  ): Promise<WorkDirectiveView> {
    const content = validateContent(input.content);
    if (!(["now", "next-stage"] as const).includes(input.mode))
      throw new Error("Work directive mode가 유효하지 않습니다");
    return await this.mutate(context, {
      ...input,
      content,
      requestHash: sha256(canonicalJson({ ...input, content })),
      status: "queued",
    });
  }

  public async cancel(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedWorkRevision: number;
      readonly expectedDirectiveRevision: number;
      readonly workId: string;
      readonly directiveId: string;
    },
  ): Promise<WorkDirectiveView> {
    return await this.mutate(context, {
      ...input,
      requestHash: sha256(canonicalJson(input)),
      status: "cancelled",
    });
  }

  public async claimEligible(
    context: TenantContext,
    runId: string,
    stage: Exclude<ApplicationRunStage, "terminal">,
    expectedRunLeaseGeneration: number,
  ): Promise<readonly WorkDirectiveView[]> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const run = await first<RunBoundaryRecord>(
        transaction,
        "SELECT run_id, work_id, stage, status, lease_generation, directive_sequence, updated_at FROM application_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
        { organization_id: context.organizationId, run_id: runId },
      );
      if (!run) throw new Error("Application run을 찾을 수 없습니다");
      if (run.stage !== stage) throw new Error("Application run stage가 지시 적용 경계와 일치하지 않습니다");
      if (run.status !== "running") throw new Error("running Application run에서만 지시를 적용할 수 있습니다");
      if (
        !Number.isSafeInteger(expectedRunLeaseGeneration) ||
        expectedRunLeaseGeneration < 1 ||
        run.lease_generation !== expectedRunLeaseGeneration
      ) {
        throw new Error("Application run lease generation이 지시 claim과 일치하지 않습니다");
      }
      const previousRunUpdatedAt = iso(run.updated_at);
      const nextRunUpdatedAt = new Date(
        Math.max(this.clock.now.getTime(), new Date(previousRunUpdatedAt).getTime() + 1),
      ).toISOString();
      const [runFenceUpdates] = await transaction.query<[RunBoundaryRecord[]]>(
        "UPDATE application_run SET updated_at = <datetime>$next_updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND stage = $stage AND lease_generation = $lease_generation AND updated_at = <datetime>$previous_updated_at RETURN AFTER;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          stage,
          lease_generation: expectedRunLeaseGeneration,
          previous_updated_at: previousRunUpdatedAt,
          next_updated_at: nextRunUpdatedAt,
        },
      );
      if (!runFenceUpdates[0]) {
        throw new Error("Application run lease generation이 지시 claim과 일치하지 않습니다");
      }
      const [applying] = await transaction.query<[DirectiveRecord[]]>(
        "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'applying' ORDER BY sequence ASC;",
        { organization_id: context.organizationId, run_id: runId },
      );
      for (const record of applying) {
        let expiresAt = Number.NaN;
        try {
          if (record.lease_expires_at !== undefined) expiresAt = Date.parse(iso(record.lease_expires_at));
        } catch {
          // 손상된 lease 시각은 회수하지 않고 실패 폐쇄합니다.
        }
        if (!Number.isFinite(expiresAt) || expiresAt > this.clock.now.getTime()) throw new WorkDirectiveBusyError();
        const [recovered] = await transaction.query<[DirectiveRecord[]]>(
          "UPDATE application_work_directive SET status = 'queued', lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND directive_id = $directive_id AND status = 'applying' AND lease_generation = $lease_generation RETURN AFTER;",
          {
            organization_id: context.organizationId,
            directive_id: record.directive_id,
            lease_generation: record.lease_generation,
            updated_at: this.clock.now.toISOString(),
          },
        );
        if (!recovered[0]) throw new Error("Work directive 만료 lease 회수 동시성 충돌입니다");
      }
      const [records] = await transaction.query<[DirectiveRecord[]]>(
        "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'queued' AND (mode = 'now' OR submitted_stage != $stage) ORDER BY sequence ASC LIMIT 100;",
        { organization_id: context.organizationId, run_id: runId, stage },
      );
      const claimed: WorkDirectiveView[] = [];
      for (const record of records) {
        const leaseGeneration = record.lease_generation + 1;
        const leaseExpiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
        const [updates] = await transaction.query<[DirectiveRecord[]]>(
          "UPDATE application_work_directive SET status = 'applying', lease_generation = $lease_generation, lease_expires_at = <datetime>$lease_expires_at, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND directive_id = $directive_id AND status = $status AND lease_generation = $previous_generation RETURN AFTER;",
          {
            organization_id: context.organizationId,
            directive_id: record.directive_id,
            status: record.status,
            previous_generation: record.lease_generation,
            lease_generation: leaseGeneration,
            lease_expires_at: leaseExpiresAt,
            updated_at: this.clock.now.toISOString(),
          },
        );
        const updated = updates[0];
        if (!updated) throw new Error("Work directive lease 동시성 충돌입니다");
        claimed.push(this.view(updated));
      }
      return claimed;
    });
  }

  public async markApplied(
    context: TenantContext,
    directiveId: string,
    leaseGeneration: number,
  ): Promise<WorkDirectiveView> {
    return await this.finish(context, directiveId, leaseGeneration, "applied");
  }

  public async markFailed(
    context: TenantContext,
    directiveId: string,
    leaseGeneration: number,
    reason: string,
  ): Promise<WorkDirectiveView> {
    return await this.finish(context, directiveId, leaseGeneration, "failed", reason);
  }

  public async requeueFailed(
    context: TenantContext,
    runId: string,
    retryAttemptId: string,
    expectedRunLeaseGeneration: number,
  ): Promise<void> {
    if (!retryAttemptId.trim()) throw new Error("Work directive retry attempt가 유효하지 않습니다");
    await this.organizations.verifyTenantContext(context);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const run = await first<RunBoundaryRecord>(
        transaction,
        "SELECT run_id, status, retry_attempt_id, lease_generation, updated_at FROM application_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
        { organization_id: context.organizationId, run_id: runId },
      );
      if (!run) throw new Error("Application run을 찾을 수 없습니다");
      if (run.status !== "running" || run.retry_attempt_id !== retryAttemptId) {
        throw new Error("Application run retry attempt가 재큐잉 요청과 일치하지 않습니다");
      }
      if (
        !Number.isSafeInteger(expectedRunLeaseGeneration) ||
        expectedRunLeaseGeneration < 1 ||
        run.lease_generation !== expectedRunLeaseGeneration
      ) {
        throw new Error("Application run lease generation이 지시 재큐잉 요청과 일치하지 않습니다");
      }
      const previousRunUpdatedAt = iso(run.updated_at);
      const nextRunUpdatedAt = new Date(
        Math.max(this.clock.now.getTime(), new Date(previousRunUpdatedAt).getTime() + 1),
      ).toISOString();
      const [runFenceUpdates] = await transaction.query<[RunBoundaryRecord[]]>(
        "UPDATE application_run SET updated_at = <datetime>$next_updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND retry_attempt_id = $retry_attempt_id AND lease_generation = $lease_generation AND updated_at = <datetime>$previous_updated_at RETURN AFTER;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          retry_attempt_id: retryAttemptId,
          lease_generation: expectedRunLeaseGeneration,
          previous_updated_at: previousRunUpdatedAt,
          next_updated_at: nextRunUpdatedAt,
        },
      );
      if (!runFenceUpdates[0]) {
        throw new Error("Application run lease generation이 지시 재큐잉 요청과 일치하지 않습니다");
      }
      await transaction.query(
        "UPDATE application_work_directive SET status = 'queued', lease_expires_at = NONE, failure_reason = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'failed';",
        { organization_id: context.organizationId, run_id: runId, updated_at: this.clock.now.toISOString() },
      );
    });
  }

  public async markUnapplied(context: TenantContext, runId: string): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const run = await first<RunBoundaryRecord>(
        transaction,
        "SELECT run_id, work_id, stage, status, lease_generation, directive_sequence FROM application_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
        { organization_id: context.organizationId, run_id: runId },
      );
      if (!run) throw new Error("Application run을 찾을 수 없습니다");
      if (run.stage !== "terminal" || !["completed", "failed", "cancelled"].includes(run.status)) {
        throw new Error("terminal Application run의 미반영 지시만 종료할 수 있습니다");
      }
      await transaction.query(
        "UPDATE application_work_directive SET status = 'unapplied', lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status IN ['queued', 'applying'];",
        { organization_id: context.organizationId, run_id: runId, updated_at: this.clock.now.toISOString() },
      );
    });
  }

  public async listByRun(context: TenantContext, runId: string): Promise<readonly WorkDirectiveView[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[DirectiveRecord[]]>(
      "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND run_id = $run_id ORDER BY sequence ASC;",
      { organization_id: context.organizationId, run_id: runId },
    );
    return records.map((record) => this.view(record));
  }

  private async finish(
    context: TenantContext,
    directiveId: string,
    leaseGeneration: number,
    status: "applied" | "failed",
    reason?: string,
  ): Promise<WorkDirectiveView> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [updates] = await transaction.query<[DirectiveRecord[]]>(
        "UPDATE application_work_directive SET status = $next_status, lease_expires_at = NONE, failure_reason = $failure_reason, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND directive_id = $directive_id AND status = 'applying' AND lease_generation = $lease_generation RETURN AFTER;",
        {
          organization_id: context.organizationId,
          directive_id: directiveId,
          lease_generation: leaseGeneration,
          next_status: status,
          failure_reason: reason,
          updated_at: this.clock.now.toISOString(),
        },
      );
      const updated = updates[0];
      if (!updated) throw new Error("Work directive lease generation이 일치하지 않습니다");
      return this.view(updated);
    });
  }

  private async mutate(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly requestHash: string;
      readonly expectedWorkRevision: number;
      readonly expectedDirectiveRevision: number;
      readonly workId: string;
      readonly directiveId: string;
      readonly status: "queued" | "cancelled";
      readonly content?: string;
      readonly mode?: WorkDirectiveMode;
    },
  ): Promise<WorkDirectiveView> {
    if (!input.commandId.trim()) throw new Error("Work directive mutation commandId가 유효하지 않습니다");
    if (!Number.isSafeInteger(input.expectedWorkRevision) || input.expectedWorkRevision < 0)
      throw new Error("Work revision이 유효하지 않습니다");
    if (!Number.isSafeInteger(input.expectedDirectiveRevision) || input.expectedDirectiveRevision < 1)
      throw new Error("Work directive revision이 유효하지 않습니다");
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const current = await this.find(transaction, context.organizationId, input.directiveId);
      if (current.work_id !== input.workId) throw new Error("Work와 Work directive 연결이 일치하지 않습니다");
      if (current.last_mutation_command_id === input.commandId) {
        if (current.last_mutation_request_hash !== input.requestHash)
          throw new Error("같은 commandId에 다른 Work directive mutation 요청을 사용할 수 없습니다");
        return this.view(current);
      }
      const work = await first<WorkBoundaryRecord>(
        transaction,
        "SELECT work_id, status, revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      if (!work) throw new Error("Work를 찾을 수 없습니다");
      if (work.revision !== input.expectedWorkRevision)
        throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
      if (current.status !== "queued") throw new Error("queued Work directive만 수정하거나 취소할 수 있습니다");
      if (current.revision !== input.expectedDirectiveRevision)
        throw new Error(`현재 Work directive revision은 ${String(current.revision)}입니다`);
      const nextRevision = current.revision + 1;
      const [updates] =
        input.status === "cancelled"
          ? await transaction.query<[DirectiveRecord[]]>(
              "UPDATE application_work_directive SET status = 'cancelled', revision = $next_revision, last_mutation_command_id = $command_id, last_mutation_request_hash = $request_hash, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND directive_id = $directive_id AND status = 'queued' AND revision = $expected_revision RETURN AFTER;",
              {
                organization_id: context.organizationId,
                directive_id: input.directiveId,
                expected_revision: input.expectedDirectiveRevision,
                next_revision: nextRevision,
                command_id: input.commandId,
                request_hash: input.requestHash,
                updated_at: this.clock.now.toISOString(),
              },
            )
          : await transaction.query<[DirectiveRecord[]]>(
              "UPDATE application_work_directive SET content = $content, content_hash = $content_hash, mode = $mode, revision = $next_revision, last_mutation_command_id = $command_id, last_mutation_request_hash = $request_hash, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND directive_id = $directive_id AND status = 'queued' AND revision = $expected_revision RETURN AFTER;",
              {
                organization_id: context.organizationId,
                directive_id: input.directiveId,
                expected_revision: input.expectedDirectiveRevision,
                next_revision: nextRevision,
                content: input.content,
                content_hash: sha256(input.content ?? ""),
                mode: input.mode,
                command_id: input.commandId,
                request_hash: input.requestHash,
                updated_at: this.clock.now.toISOString(),
              },
            );
      const updated = updates[0];
      if (!updated) throw new Error("Work directive revision 동시성 충돌입니다");
      return this.view(updated);
    });
  }

  private async find(executor: QueryExecutor, organizationId: string, directiveId: string): Promise<DirectiveRecord> {
    const record = await first<DirectiveRecord>(
      executor,
      "SELECT * OMIT id FROM application_work_directive WHERE organization_id = $organization_id AND directive_id = $directive_id LIMIT 1;",
      { organization_id: organizationId, directive_id: directiveId },
    );
    if (!record) throw new Error("Work directive를 찾을 수 없습니다");
    return record;
  }

  private view(record: DirectiveRecord): WorkDirectiveView {
    if (sha256(record.content) !== record.content_hash) throw new Error("Work directive 내용 계보가 유효하지 않습니다");
    return {
      directiveId: record.directive_id,
      organizationId: record.organization_id,
      commandId: record.command_id,
      correlationId: record.correlation_id,
      workId: record.work_id,
      runId: record.run_id,
      sequence: record.sequence,
      content: record.content,
      mode: record.mode,
      submittedStage: record.submitted_stage,
      status: record.status,
      revision: record.revision,
      leaseGeneration: record.lease_generation,
      ...(record.failure_reason === undefined ? {} : { failureReason: record.failure_reason }),
      createdAt: iso(record.created_at),
      updatedAt: iso(record.updated_at),
    };
  }
}
