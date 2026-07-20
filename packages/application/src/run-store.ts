import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { APPLICATION_RUN_MIGRATION, APPLICATION_RUN_RETRY_MIGRATION } from "./schema.js";

export type ApplicationRunStage =
  "intake" | "context-strategy" | "evidence" | "delivery" | "assurance" | "records" | "terminal";
export type ApplicationRunStatus =
  "ready" | "running" | "awaiting-approval" | "blocked" | "completed" | "failed" | "cancelled";

interface RunRecord {
  readonly run_id: string;
  readonly organization_id: string;
  readonly actor_user_id: string;
  readonly command_id: string;
  readonly correlation_id: string;
  readonly request_json: string;
  readonly request_hash: string;
  readonly retry_attempt_id?: string;
  readonly retry_replay_id?: string;
  readonly work_id?: string;
  readonly stage: ApplicationRunStage;
  readonly status: ApplicationRunStatus;
  readonly approval_id?: string;
  readonly blocked_reason?: string;
  readonly result_json?: string;
  readonly result_hash?: string;
  readonly lease_generation: number;
  readonly lease_expires_at?: unknown;
}

export interface ApplicationRunClock {
  readonly now: Date;
}

export interface ApplicationRunView {
  readonly runId: string;
  readonly organizationId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly request: unknown;
  readonly retryAttemptId?: string;
  readonly retryReplayId?: string;
  readonly workId?: string;
  readonly stage: ApplicationRunStage;
  readonly status: ApplicationRunStatus;
  readonly approvalId?: string;
  readonly blockedReason?: string;
  readonly result?: unknown;
  readonly leaseGeneration: number;
}

export type ClaimApplicationRunResult =
  | {
      readonly outcome: "claimed";
      readonly leaseGeneration: number;
      readonly recovered: boolean;
      readonly retryAttemptId?: string;
    }
  | { readonly outcome: "in-progress"; readonly leaseGeneration: number }
  | { readonly outcome: "terminal"; readonly run: ApplicationRunView };

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

function dateMillis(value: unknown): number {
  const millis = (value instanceof Date ? value : new Date(String(value))).getTime();
  if (Number.isNaN(millis)) throw new Error("Application run lease datetime이 유효하지 않습니다");
  return millis;
}

function validRetryAttemptId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("재시도 시도 ID가 유효하지 않습니다");
  return value;
}

export class ApplicationRunStore {
  private readonly clock: ApplicationRunClock;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly leaseMs: number,
    clock?: ApplicationRunClock,
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
    input: { readonly leaseMs?: number; readonly clock?: ApplicationRunClock } = {},
  ): Promise<ApplicationRunStore> {
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Application run lease 범위가 유효하지 않습니다");
    }
    await applyMigrations(database, [APPLICATION_RUN_MIGRATION, APPLICATION_RUN_RETRY_MIGRATION]);
    return new ApplicationRunStore(database, organizations, leaseMs, input.clock);
  }

  public async start(
    context: TenantContext,
    input: { readonly commandId: string; readonly correlationId: string; readonly request: unknown },
  ): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input.request);
    const requestHash = sha256(requestJson);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const existing = await first<RunRecord>(
        transaction,
        "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (existing) {
        if (existing.request_hash !== requestHash || existing.correlation_id !== input.correlationId) {
          throw new Error("같은 commandId에 다른 Application run 요청을 사용할 수 없습니다");
        }
        return this.view(existing);
      }
      const runId = randomUUID();
      await transaction.query(
        "CREATE application_run CONTENT { run_id: $run_id, organization_id: $organization_id, actor_user_id: $actor_user_id, command_id: $command_id, correlation_id: $correlation_id, request_json: $request_json, request_hash: $request_hash, retry_attempt_id: NONE, retry_replay_id: NONE, work_id: NONE, stage: 'intake', status: 'ready', approval_id: NONE, blocked_reason: NONE, result_json: NONE, result_hash: NONE, lease_generation: 0, lease_expires_at: NONE, created_at: <datetime>$created_at, updated_at: <datetime>$created_at };",
        {
          run_id: runId,
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          command_id: input.commandId,
          correlation_id: input.correlationId,
          request_json: requestJson,
          request_hash: requestHash,
          created_at: this.clock.now.toISOString(),
        },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        input.correlationId,
        0,
        "intake",
        "started",
        requestHash,
      );
      return this.view(await this.find(transaction, context.organizationId, runId));
    });
  }

  public async claim(
    context: TenantContext,
    runId: string,
    options: {
      readonly resumeAwaitingApproval?: boolean;
      readonly resumeBlocked?: boolean;
      readonly retryAttemptId?: string;
    } = {},
  ): Promise<ClaimApplicationRunResult> {
    const retryAttemptId = validRetryAttemptId(options.retryAttemptId);
    if (retryAttemptId !== undefined && !options.resumeBlocked) {
      throw new Error("재시도 시도 ID는 차단된 Application run 재시도에만 사용할 수 있습니다");
    }
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, runId);
      if (retryAttemptId !== undefined && !(record.status === "blocked" && options.resumeBlocked)) {
        throw new Error("새 재시도 시도 ID는 차단된 Application run에만 사용할 수 있습니다");
      }
      if (["completed", "failed", "cancelled"].includes(record.status)) {
        return { outcome: "terminal", run: this.view(record) };
      }
      if (record.status === "blocked" && !options.resumeBlocked) return { outcome: "terminal", run: this.view(record) };
      if (record.status === "awaiting-approval" && !options.resumeAwaitingApproval) {
        return { outcome: "terminal", run: this.view(record) };
      }
      if (
        record.status === "running" &&
        record.lease_expires_at !== undefined &&
        dateMillis(record.lease_expires_at) > this.clock.now.getTime()
      ) {
        return { outcome: "in-progress", leaseGeneration: record.lease_generation };
      }
      const recovered = record.status === "running";
      const generation = record.lease_generation + 1;
      const expiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
      const nextRetryAttemptId = retryAttemptId ?? record.retry_attempt_id;
      const nextRetryReplayId = retryAttemptId === undefined ? record.retry_replay_id : undefined;
      await transaction.query(
        "UPDATE application_run SET status = 'running', lease_generation = $generation, lease_expires_at = <datetime>$expires_at, approval_id = NONE, blocked_reason = NONE, retry_attempt_id = $retry_attempt_id, retry_replay_id = $retry_replay_id, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = $previous_status AND lease_generation = $previous_generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          previous_generation: record.lease_generation,
          previous_status: record.status,
          generation,
          expires_at: expiresAt,
          retry_attempt_id: nextRetryAttemptId,
          retry_replay_id: nextRetryReplayId,
          updated_at: this.clock.now.toISOString(),
        },
      );
      const claimed = await this.find(transaction, context.organizationId, runId);
      if (claimed.status !== "running" || claimed.lease_generation !== generation) {
        throw new Error("Application run lease 회수 동시성 충돌입니다");
      }
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        generation,
        record.stage,
        recovered ? "reclaimed" : "claimed",
        record.request_hash,
      );
      return {
        outcome: "claimed",
        leaseGeneration: generation,
        recovered,
        ...(claimed.retry_attempt_id === undefined ? {} : { retryAttemptId: claimed.retry_attempt_id }),
      };
    });
  }

  public async advance(
    context: TenantContext,
    runId: string,
    generation: number,
    input: { readonly stage: ApplicationRunStage; readonly workId?: string },
  ): Promise<ApplicationRunView> {
    return await this.transition(context, runId, generation, async (transaction, record) => {
      const nextRetryReplayId = record.retry_attempt_id ?? record.retry_replay_id;
      await transaction.query(
        "UPDATE application_run SET status = 'ready', stage = $stage, work_id = $work_id, retry_attempt_id = NONE, retry_replay_id = $retry_replay_id, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          generation,
          stage: input.stage,
          work_id: input.workId ?? record.work_id,
          retry_replay_id: nextRetryReplayId,
          updated_at: this.clock.now.toISOString(),
        },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        generation,
        input.stage,
        "advanced",
        sha256(input.stage),
      );
    });
  }

  public async suspend(
    context: TenantContext,
    runId: string,
    generation: number,
    approvalId: string,
  ): Promise<ApplicationRunView> {
    return await this.transition(context, runId, generation, async (transaction, record) => {
      await transaction.query(
        "UPDATE application_run SET status = 'awaiting-approval', approval_id = $approval_id, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          generation,
          approval_id: approvalId,
          updated_at: this.clock.now.toISOString(),
        },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        generation,
        record.stage,
        "suspended",
        sha256(approvalId),
      );
    });
  }

  public async block(
    context: TenantContext,
    runId: string,
    generation: number,
    reason: string,
    workId?: string,
  ): Promise<ApplicationRunView> {
    return await this.transition(context, runId, generation, async (transaction, record) => {
      await transaction.query(
        "UPDATE application_run SET status = 'blocked', blocked_reason = $blocked_reason, work_id = $work_id, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          generation,
          blocked_reason: reason,
          work_id: workId ?? record.work_id,
          updated_at: this.clock.now.toISOString(),
        },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        generation,
        record.stage,
        "blocked",
        sha256(reason),
      );
    });
  }

  public async complete(
    context: TenantContext,
    runId: string,
    generation: number,
    result?: unknown,
  ): Promise<ApplicationRunView> {
    return await this.finish(context, runId, generation, "completed", { result });
  }

  public async cancel(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, runId);
      if (["blocked", "completed", "failed", "cancelled"].includes(record.status)) return this.view(record);
      await transaction.query(
        "UPDATE application_run SET status = 'cancelled', stage = 'terminal', approval_id = NONE, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id;",
        { organization_id: context.organizationId, run_id: runId, updated_at: this.clock.now.toISOString() },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        record.lease_generation,
        "terminal",
        "cancelled",
        sha256("cancelled"),
      );
      return this.view(await this.find(transaction, context.organizationId, runId));
    });
  }

  public async get(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, runId));
  }

  public async getByCommand(context: TenantContext, commandId: string): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    const record = await first<RunRecord>(
      this.database,
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    if (!record) throw new Error("Application run을 찾을 수 없습니다");
    return this.view(record);
  }

  public async listRecoverable(context: TenantContext, limit = 100): Promise<readonly ApplicationRunView[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND (status = 'ready' OR (status = 'running' AND lease_expires_at <= <datetime>$now)) ORDER BY created_at ASC LIMIT $limit;",
      { organization_id: context.organizationId, now: this.clock.now.toISOString(), limit },
    );
    return records.map((record) => this.view(record));
  }

  private async finish(
    context: TenantContext,
    runId: string,
    generation: number,
    status: "completed",
    input: { readonly result?: unknown },
  ): Promise<ApplicationRunView> {
    const resultJson = input.result === undefined ? undefined : canonicalJson(input.result);
    return await this.transition(context, runId, generation, async (transaction, record) => {
      await transaction.query(
        "UPDATE application_run SET status = $status, stage = 'terminal', blocked_reason = $blocked_reason, result_json = $result_json, result_hash = $result_hash, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          generation,
          status,
          blocked_reason: undefined,
          result_json: resultJson,
          result_hash: resultJson === undefined ? undefined : sha256(resultJson),
          updated_at: this.clock.now.toISOString(),
        },
      );
      await this.event(
        transaction,
        context.organizationId,
        runId,
        record.correlation_id,
        generation,
        "terminal",
        "completed",
        sha256(resultJson ?? status),
      );
    });
  }

  private async transition(
    context: TenantContext,
    runId: string,
    generation: number,
    mutate: (transaction: QueryExecutor, record: RunRecord) => Promise<void>,
  ): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, runId);
      if (record.status !== "running" || record.lease_generation !== generation) {
        throw new Error("Application run lease generation이 일치하지 않습니다");
      }
      await mutate(transaction, record);
      return this.view(await this.find(transaction, context.organizationId, runId));
    });
  }

  private async find(executor: QueryExecutor, organizationId: string, runId: string): Promise<RunRecord> {
    const record = await first<RunRecord>(
      executor,
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
      { organization_id: organizationId, run_id: runId },
    );
    if (!record) throw new Error("Application run을 찾을 수 없습니다");
    return record;
  }

  private async event(
    executor: QueryExecutor,
    organizationId: string,
    runId: string,
    correlationId: string,
    generation: number,
    stage: ApplicationRunStage,
    eventType: string,
    detailHash: string,
  ): Promise<void> {
    await executor.query(
      "CREATE application_run_event CONTENT { event_id: $event_id, organization_id: $organization_id, run_id: $run_id, correlation_id: $correlation_id, lease_generation: $generation, stage: $stage, event_type: $event_type, detail_hash: $detail_hash, created_at: <datetime>$created_at };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        run_id: runId,
        correlation_id: correlationId,
        generation,
        stage,
        event_type: eventType,
        detail_hash: detailHash,
        created_at: this.clock.now.toISOString(),
      },
    );
  }

  private view(record: RunRecord): ApplicationRunView {
    const request = JSON.parse(record.request_json) as unknown;
    const result = record.result_json === undefined ? undefined : (JSON.parse(record.result_json) as unknown);
    if (sha256(record.request_json) !== record.request_hash)
      throw new Error("Application run 요청 계보가 유효하지 않습니다");
    if (record.result_json !== undefined && sha256(record.result_json) !== record.result_hash)
      throw new Error("Application run 결과 계보가 유효하지 않습니다");
    return {
      runId: record.run_id,
      organizationId: record.organization_id,
      commandId: record.command_id,
      correlationId: record.correlation_id,
      request,
      ...(record.retry_attempt_id === undefined ? {} : { retryAttemptId: record.retry_attempt_id }),
      ...(record.retry_replay_id === undefined ? {} : { retryReplayId: record.retry_replay_id }),
      ...(record.work_id === undefined ? {} : { workId: record.work_id }),
      stage: record.stage,
      status: record.status,
      ...(record.approval_id === undefined ? {} : { approvalId: record.approval_id }),
      ...(record.blocked_reason === undefined ? {} : { blockedReason: record.blocked_reason }),
      ...(result === undefined ? {} : { result }),
      leaseGeneration: record.lease_generation,
    };
  }
}
