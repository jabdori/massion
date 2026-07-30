import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, serializeSurrealDateTime, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  APPLICATION_RUN_APPROVAL_RESUME_MIGRATION,
  APPLICATION_RUN_MIGRATION,
  APPLICATION_RUN_RETRY_MIGRATION,
} from "./schema.js";

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
  readonly resume_approval_id?: string;
  readonly work_id?: string;
  readonly stage: ApplicationRunStage;
  readonly status: ApplicationRunStatus;
  readonly approval_id?: string;
  readonly blocked_reason?: string;
  readonly result_json?: string;
  readonly result_hash?: string;
  readonly lease_generation: number;
  readonly lease_expires_at?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface StartupRecoveryRecord {
  readonly run_id: string;
  readonly organization_id: string;
  readonly actor_user_id?: string;
  readonly created_at: unknown;
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
  readonly resumeInput?: { readonly approvalId: string };
  readonly workId?: string;
  readonly stage: ApplicationRunStage;
  readonly status: ApplicationRunStatus;
  readonly approvalId?: string;
  readonly blockedReason?: string;
  readonly result?: unknown;
  readonly leaseGeneration: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ApplicationRunApprovalLink {
  readonly kind: "active" | "resuming" | "historical";
  readonly approvalId: string;
  readonly run: ApplicationRunView;
}

export interface ApplicationRunStartupRecoveryCandidate {
  readonly runId: string;
  readonly organizationId: string;
  readonly actorUserId?: string;
  readonly createdAt: string;
}

export interface ApplicationRunStartupRecoveryCursor {
  readonly createdAt: string;
  readonly runId: string;
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

function validResumeApprovalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new Error("승인 재개 Approval ID가 유효하지 않습니다");
  }
  return value;
}

function startupRecoveryCreatedAt(value: unknown): string {
  let serialized: unknown = typeof value === "string" ? value : undefined;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Application run 시작 복구 생성 시각이 유효하지 않습니다");
    }
    serialized = value.toISOString();
  } else if (value && typeof value === "object") {
    serialized = serializeSurrealDateTime(value);
  }
  if (typeof serialized === "string") {
    const date = new Date(serialized);
    if (Number.isFinite(date.getTime()) && date.toISOString() === serialized) return serialized;
  }
  throw new Error("Application run 시작 복구 생성 시각이 유효하지 않습니다");
}

function startupRecoveryRunId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new Error("Application run 시작 복구 실행 ID가 유효하지 않습니다");
  }
  return value;
}

function startupRecoveryCursor(value: unknown): ApplicationRunStartupRecoveryCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Application run 시작 복구 cursor가 유효하지 않습니다");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("createdAt") || !keys.includes("runId")) {
    throw new Error("Application run 시작 복구 cursor가 유효하지 않습니다");
  }
  const candidate = value as Record<string, unknown>;
  try {
    const createdAt = startupRecoveryCreatedAt(candidate.createdAt);
    if (createdAt !== candidate.createdAt) throw new Error("invalid cursor datetime");
    return { createdAt, runId: startupRecoveryRunId(candidate.runId) };
  } catch {
    throw new Error("Application run 시작 복구 cursor가 유효하지 않습니다");
  }
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
    await applyMigrations(database, [
      APPLICATION_RUN_MIGRATION,
      APPLICATION_RUN_RETRY_MIGRATION,
      APPLICATION_RUN_APPROVAL_RESUME_MIGRATION,
    ]);
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
        "CREATE application_run CONTENT { run_id: $run_id, organization_id: $organization_id, actor_user_id: $actor_user_id, command_id: $command_id, correlation_id: $correlation_id, request_json: $request_json, request_hash: $request_hash, retry_attempt_id: NONE, retry_replay_id: NONE, resume_approval_id: NONE, work_id: NONE, stage: 'intake', status: 'ready', approval_id: NONE, blocked_reason: NONE, result_json: NONE, result_hash: NONE, lease_generation: 0, lease_expires_at: NONE, created_at: <datetime>$created_at, updated_at: <datetime>$created_at };",
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
      readonly reevaluateAwaitingApproval?: boolean;
      readonly resumeBlocked?: boolean;
      readonly retryAttemptId?: string;
      readonly approvalId?: string;
    } = {},
  ): Promise<ClaimApplicationRunResult> {
    const retryAttemptId = validRetryAttemptId(options.retryAttemptId);
    const resumeApprovalId = validResumeApprovalId(options.approvalId);
    if (retryAttemptId !== undefined && !options.resumeBlocked && !options.reevaluateAwaitingApproval) {
      throw new Error("재시도 시도 ID는 차단된 Application run 재시도에만 사용할 수 있습니다");
    }
    if (options.resumeAwaitingApproval && options.reevaluateAwaitingApproval) {
      throw new Error("승인 재개와 자율성 재평가를 동시에 claim할 수 없습니다");
    }
    if ((options.resumeAwaitingApproval || options.reevaluateAwaitingApproval) && resumeApprovalId === undefined) {
      throw new Error("승인 재개 Approval ID가 필요합니다");
    }
    if (!options.resumeAwaitingApproval && !options.reevaluateAwaitingApproval && resumeApprovalId !== undefined) {
      throw new Error("Approval ID는 승인 재개 claim에만 사용할 수 있습니다");
    }
    if (options.reevaluateAwaitingApproval && !/^autonomy:\d+$/u.test(retryAttemptId ?? "")) {
      throw new Error("자율성 재평가 retryAttemptId가 유효하지 않습니다");
    }
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, runId);
      if (
        options.resumeAwaitingApproval &&
        (record.status !== "awaiting-approval" || record.approval_id !== resumeApprovalId)
      ) {
        throw new Error("Application run의 승인 재개 Approval 연결이 일치하지 않습니다");
      }
      if (
        options.reevaluateAwaitingApproval &&
        (record.status !== "awaiting-approval" || record.approval_id !== resumeApprovalId)
      ) {
        throw new Error("Application run의 자율성 재평가 Approval 연결이 일치하지 않습니다");
      }
      if (
        retryAttemptId !== undefined &&
        !(record.status === "blocked" && options.resumeBlocked) &&
        !(record.status === "awaiting-approval" && options.reevaluateAwaitingApproval)
      ) {
        throw new Error("새 재시도 시도 ID는 차단된 Application run에만 사용할 수 있습니다");
      }
      if (["completed", "failed", "cancelled"].includes(record.status)) {
        return { outcome: "terminal", run: this.view(record) };
      }
      if (record.status === "blocked" && !options.resumeBlocked) return { outcome: "terminal", run: this.view(record) };
      if (record.status === "awaiting-approval" && !options.resumeAwaitingApproval && !options.reevaluateAwaitingApproval) {
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
      const nextRetryReplayId = options.reevaluateAwaitingApproval
        ? undefined
        : retryAttemptId === undefined
          ? record.retry_replay_id
          : undefined;
      const nextResumeApprovalId = options.reevaluateAwaitingApproval
        ? undefined
        : (resumeApprovalId ?? record.resume_approval_id);
      await transaction.query(
        options.reevaluateAwaitingApproval
          ? "UPDATE application_run SET status = 'running', lease_generation = $generation, lease_expires_at = <datetime>$expires_at, approval_id = NONE, resume_approval_id = NONE, blocked_reason = NONE, retry_attempt_id = $retry_attempt_id, retry_replay_id = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = $previous_status AND lease_generation = $previous_generation AND approval_id = $approval_id;"
          : options.resumeAwaitingApproval
          ? "UPDATE application_run SET status = 'running', lease_generation = $generation, lease_expires_at = <datetime>$expires_at, approval_id = NONE, resume_approval_id = $resume_approval_id, blocked_reason = NONE, retry_attempt_id = $retry_attempt_id, retry_replay_id = $retry_replay_id, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = $previous_status AND lease_generation = $previous_generation AND approval_id = $resume_approval_id;"
          : "UPDATE application_run SET status = 'running', lease_generation = $generation, lease_expires_at = <datetime>$expires_at, approval_id = NONE, resume_approval_id = $resume_approval_id, blocked_reason = NONE, retry_attempt_id = $retry_attempt_id, retry_replay_id = $retry_replay_id, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = $previous_status AND lease_generation = $previous_generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          previous_generation: record.lease_generation,
          previous_status: record.status,
          generation,
          expires_at: expiresAt,
          retry_attempt_id: nextRetryAttemptId,
          retry_replay_id: nextRetryReplayId,
          resume_approval_id: nextResumeApprovalId,
          approval_id: resumeApprovalId,
          updated_at: this.clock.now.toISOString(),
        },
      );
      const claimed = await this.find(transaction, context.organizationId, runId);
      if (
        claimed.status !== "running" ||
        claimed.lease_generation !== generation ||
        claimed.resume_approval_id !== nextResumeApprovalId ||
        (options.reevaluateAwaitingApproval && claimed.approval_id !== undefined)
      ) {
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
        "UPDATE application_run SET status = 'ready', stage = $stage, work_id = $work_id, retry_attempt_id = NONE, retry_replay_id = $retry_replay_id, resume_approval_id = NONE, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
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
        "UPDATE application_run SET status = 'awaiting-approval', approval_id = $approval_id, resume_approval_id = NONE, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
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

  public async fail(
    context: TenantContext,
    runId: string,
    generation: number,
    reason: string,
    workId?: string,
    converge?: (transaction: QueryExecutor) => Promise<void>,
  ): Promise<ApplicationRunView> {
    return await this.finish(context, runId, generation, "failed", {
      reason,
      ...(workId === undefined ? {} : { workId }),
      ...(converge === undefined ? {} : { converge }),
    });
  }

  public async cancel(
    context: TenantContext,
    runId: string,
    converge?: (transaction: QueryExecutor) => Promise<void>,
  ): Promise<ApplicationRunView> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, runId);
      if (["completed", "failed", "cancelled"].includes(record.status)) return this.view(record);
      await converge?.(transaction);
      await transaction.query(
        "UPDATE application_run SET status = 'cancelled', stage = 'terminal', approval_id = NONE, resume_approval_id = NONE, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = $previous_status AND lease_generation = $previous_generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          previous_status: record.status,
          previous_generation: record.lease_generation,
          updated_at: this.clock.now.toISOString(),
        },
      );
      const cancelled = await this.find(transaction, context.organizationId, runId);
      if (cancelled.status !== "cancelled" || cancelled.resume_approval_id !== undefined) {
        throw new Error("Application run 취소 동시성 충돌입니다");
      }
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
      return this.view(cancelled);
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

  public async findByApproval(
    context: TenantContext,
    approvalId: string,
  ): Promise<ApplicationRunApprovalLink | undefined> {
    await this.organizations.verifyTenantContext(context);
    if (approvalId.length < 8 || approvalId.length > 128) throw new Error("Approval ID가 유효하지 않습니다");
    const [current] = await this.database.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND (approval_id = $approval_id OR resume_approval_id = $approval_id) LIMIT 2;",
      { organization_id: context.organizationId, approval_id: approvalId },
    );
    if (current.length > 1) throw new Error("Approval에 연결된 Application run이 하나가 아닙니다");
    const [events] = await this.database.query<[{ run_id: string }[]]>(
      "SELECT run_id FROM application_run_event WHERE organization_id = $organization_id AND event_type = 'suspended' AND detail_hash = $detail_hash;",
      { organization_id: context.organizationId, detail_hash: sha256(approvalId) },
    );
    const runIds = new Set(events.map((event) => event.run_id));
    if (current[0]) runIds.add(current[0].run_id);
    if (runIds.size > 1) throw new Error("Approval에 연결된 Application run이 하나가 아닙니다");
    const runId = [...runIds][0];
    if (!runId) return undefined;
    const record =
      current[0]?.run_id === runId ? current[0] : await this.find(this.database, context.organizationId, runId);
    return {
      kind:
        record.approval_id === approvalId
          ? "active"
          : record.resume_approval_id === approvalId
            ? "resuming"
            : "historical",
      approvalId,
      run: this.view(record),
    };
  }

  public async getByApproval(context: TenantContext, approvalId: string): Promise<ApplicationRunView> {
    const link = await this.findByApproval(context, approvalId);
    if (!link) throw new Error("Approval에 연결된 Application run을 찾을 수 없습니다");
    return link.run;
  }

  public async listByWork(context: TenantContext, workId: string, limit = 50): Promise<readonly ApplicationRunView[]> {
    await this.organizations.verifyTenantContext(context);
    if (!workId.trim()) throw new Error("Work ID가 필요합니다");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Application run 조회 개수가 유효하지 않습니다");
    }
    const [records] = await this.database.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at DESC, run_id DESC LIMIT $limit;",
      { organization_id: context.organizationId, work_id: workId, limit },
    );
    return records.map((record) => this.view(record));
  }

  public async listRecoverable(context: TenantContext, limit = 100): Promise<readonly ApplicationRunView[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM application_run WHERE organization_id = $organization_id AND (status = 'ready' OR (status = 'running' AND lease_expires_at <= <datetime>$now)) ORDER BY created_at ASC LIMIT $limit;",
      { organization_id: context.organizationId, now: this.clock.now.toISOString(), limit },
    );
    return records.map((record) => this.view(record));
  }

  public async listStartupRecoverable(
    limit = 100,
    cursor?: ApplicationRunStartupRecoveryCursor,
  ): Promise<readonly ApplicationRunStartupRecoveryCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Application run 시작 복구 조회 개수가 유효하지 않습니다");
    }
    const validatedCursor = cursor === undefined ? undefined : startupRecoveryCursor(cursor);
    const [records] = await this.database.query<[StartupRecoveryRecord[]]>(
      `SELECT run_id, organization_id, actor_user_id, created_at FROM application_run
       WHERE (status = 'ready' OR (status = 'running' AND lease_expires_at <= <datetime>$now))${validatedCursor ? " AND (created_at > <datetime>$cursor_created_at OR (created_at = <datetime>$cursor_created_at AND run_id > $cursor_run_id))" : ""}
       ORDER BY created_at ASC, run_id ASC LIMIT $limit;`,
      {
        now: this.clock.now.toISOString(),
        limit,
        ...(validatedCursor
          ? { cursor_created_at: validatedCursor.createdAt, cursor_run_id: validatedCursor.runId }
          : {}),
      },
    );
    return records.map((record) => {
      const createdAt = startupRecoveryCreatedAt(record.created_at);
      return {
        runId: startupRecoveryRunId(record.run_id),
        organizationId: record.organization_id,
        ...(record.actor_user_id === undefined ? {} : { actorUserId: record.actor_user_id }),
        createdAt,
      };
    });
  }

  private async finish(
    context: TenantContext,
    runId: string,
    generation: number,
    status: "completed" | "failed",
    input: {
      readonly result?: unknown;
      readonly reason?: string;
      readonly workId?: string;
      readonly converge?: (transaction: QueryExecutor) => Promise<void>;
    },
  ): Promise<ApplicationRunView> {
    const resultJson = input.result === undefined ? undefined : canonicalJson(input.result);
    return await this.transition(context, runId, generation, async (transaction, record) => {
      await input.converge?.(transaction);
      await transaction.query(
        "UPDATE application_run SET status = $status, stage = 'terminal', blocked_reason = $blocked_reason, work_id = $work_id, result_json = $result_json, result_hash = $result_hash, resume_approval_id = NONE, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running' AND lease_generation = $generation;",
        {
          organization_id: context.organizationId,
          run_id: runId,
          generation,
          status,
          blocked_reason: input.reason,
          work_id: input.workId ?? record.work_id,
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
        status,
        sha256(input.reason ?? resultJson ?? status),
      );
      const terminal = await this.find(transaction, context.organizationId, runId);
      if (terminal.status !== status || terminal.stage !== "terminal" || terminal.lease_generation !== generation) {
        throw new Error("Application run terminal 전이 동시성 충돌입니다");
      }
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
      ...(record.resume_approval_id === undefined ? {} : { resumeInput: { approvalId: record.resume_approval_id } }),
      ...(record.work_id === undefined ? {} : { workId: record.work_id }),
      stage: record.stage,
      status: record.status,
      ...(record.approval_id === undefined ? {} : { approvalId: record.approval_id }),
      ...(record.blocked_reason === undefined ? {} : { blockedReason: record.blocked_reason }),
      ...(result === undefined ? {} : { result }),
      leaseGeneration: record.lease_generation,
      createdAt: new Date(String(record.created_at)).toISOString(),
      updatedAt: new Date(String(record.updated_at)).toISOString(),
    };
  }
}
