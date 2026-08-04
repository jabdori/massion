import type { TenantContext } from "@massion/identity";

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

export interface ApplicationRunStartupRecoverySource {
  listStartupRecoverable(
    limit: number,
    cursor?: ApplicationRunStartupRecoveryCursor,
  ): Promise<readonly ApplicationRunStartupRecoveryCandidate[]>;
}

export interface ApplicationRunRecoveryContextResolver {
  resolveTenantContext(userId: string, organizationId: string): Promise<TenantContext>;
}

export interface ApplicationRunRecoveryTarget {
  recover(context: TenantContext, runId: string): Promise<unknown>;
}

export type ApplicationRunStartupRecoveryFailureReason =
  "candidate_list_failed" | "legacy_actor_lineage_missing" | "membership_unavailable" | "recovery_failed";

export interface ApplicationRunStartupRecoveryFailure {
  readonly reason: ApplicationRunStartupRecoveryFailureReason;
  readonly runId?: string;
  readonly organizationId?: string;
  readonly cause?: unknown;
}

export interface ApplicationRunStartupRecoveryOptions {
  readonly onFailure?: (failure: ApplicationRunStartupRecoveryFailure) => void | Promise<void>;
}

const STARTUP_RECOVERY_PAGE_SIZE = 100;

function recoveryCursor(candidate: ApplicationRunStartupRecoveryCandidate): ApplicationRunStartupRecoveryCursor {
  if (typeof candidate.createdAt !== "string") {
    throw new Error("ApplicationRun 시작 복구 후보 생성 시각이 유효하지 않습니다");
  }
  const createdAt = new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== candidate.createdAt) {
    throw new Error("ApplicationRun 시작 복구 후보 생성 시각이 유효하지 않습니다");
  }
  if (
    typeof candidate.runId !== "string" ||
    candidate.runId.length === 0 ||
    candidate.runId.length > 128 ||
    candidate.runId.trim() !== candidate.runId
  ) {
    throw new Error("ApplicationRun 시작 복구 후보 실행 ID가 유효하지 않습니다");
  }
  return { createdAt: candidate.createdAt, runId: candidate.runId };
}

export class ApplicationRunStartupRecoveryService {
  private started = false;
  private closed = false;
  private healthy = false;
  private active: Promise<void> | undefined;

  public constructor(
    private readonly source: ApplicationRunStartupRecoverySource,
    private readonly contexts: ApplicationRunRecoveryContextResolver,
    private readonly target: ApplicationRunRecoveryTarget,
    private readonly options: ApplicationRunStartupRecoveryOptions = {},
  ) {}

  public start(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("종료된 ApplicationRun 시작 복구 서비스는 다시 시작할 수 없습니다"));
    if (this.started) return Promise.reject(new Error("ApplicationRun 시작 복구 서비스가 이미 실행됐습니다"));
    this.started = true;
    this.healthy = false;
    const active = this.recoverAll();
    this.active = active;
    void active.then(
      () => {
        if (this.active === active) this.active = undefined;
      },
      () => {
        this.healthy = false;
        if (this.active === active) this.active = undefined;
      },
    );
    return Promise.resolve();
  }

  public ready(): boolean {
    return this.started && !this.closed && this.healthy;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      await this.active;
      return;
    }
    this.closed = true;
    this.healthy = false;
    await this.active;
  }

  private async recoverAll(): Promise<void> {
    let healthy = true;
    let cursor: ApplicationRunStartupRecoveryCursor | undefined;
    while (!this.closed) {
      let candidates: readonly ApplicationRunStartupRecoveryCandidate[];
      try {
        candidates = await this.source.listStartupRecoverable(STARTUP_RECOVERY_PAGE_SIZE, cursor);
      } catch (error) {
        this.healthy = false;
        await this.report({ reason: "candidate_list_failed", cause: error });
        return;
      }

      if (this.isClosed()) return;
      this.healthy = healthy;
      if (candidates.length === 0) break;

      let nextCursor: ApplicationRunStartupRecoveryCursor;
      try {
        const lastCandidate = candidates.at(-1);
        if (!lastCandidate) throw new Error("ApplicationRun 시작 복구 page가 비어 있습니다");
        nextCursor = recoveryCursor(lastCandidate);
        if (
          cursor &&
          (nextCursor.createdAt < cursor.createdAt ||
            (nextCursor.createdAt === cursor.createdAt && nextCursor.runId <= cursor.runId))
        ) {
          throw new Error("ApplicationRun 시작 복구 page cursor가 엄격히 증가하지 않습니다");
        }
      } catch (error) {
        healthy = false;
        this.healthy = false;
        await this.report({ reason: "candidate_list_failed", cause: error });
        break;
      }

      for (const candidate of candidates) {
        if (this.isClosed()) {
          healthy = false;
          break;
        }
        if (!candidate.actorUserId) {
          healthy = false;
          this.healthy = false;
          await this.report({
            reason: "legacy_actor_lineage_missing",
            runId: candidate.runId,
            organizationId: candidate.organizationId,
          });
          continue;
        }

        let context: TenantContext;
        try {
          context = await this.contexts.resolveTenantContext(candidate.actorUserId, candidate.organizationId);
        } catch (error) {
          healthy = false;
          this.healthy = false;
          await this.report({
            reason: "membership_unavailable",
            runId: candidate.runId,
            organizationId: candidate.organizationId,
            cause: error,
          });
          continue;
        }

        if (this.isClosed()) {
          healthy = false;
          break;
        }
        try {
          await this.target.recover(context, candidate.runId);
        } catch (error) {
          healthy = false;
          this.healthy = false;
          await this.report({
            reason: "recovery_failed",
            runId: candidate.runId,
            organizationId: candidate.organizationId,
            cause: error,
          });
        }
      }
      cursor = nextCursor;
    }
    if (!this.closed) this.healthy = healthy;
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private async report(failure: ApplicationRunStartupRecoveryFailure): Promise<void> {
    try {
      await this.options.onFailure?.(failure);
    } catch {
      // 실패 보고 오류가 다음 실행 복구를 막아서는 안 됩니다.
    }
  }
}
