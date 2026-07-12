import type { TenantContext } from "@massion/identity";
import type { RuntimeRecoveryCandidate } from "@massion/runtime";

export interface RuntimeStartupRecoveryStore {
  listStartupRecoverable(): Promise<RuntimeRecoveryCandidate[]>;
}

export interface RuntimeRecoveryContextResolver {
  resolveTenantContext(userId: string, organizationId: string): Promise<TenantContext>;
}

export interface RuntimeRecoveryRunner {
  recover(context: TenantContext, executionId: string): Promise<unknown>;
}

export type RuntimeStartupRecoveryFailureReason =
  "candidate_list_failed" | "legacy_actor_lineage_missing" | "membership_unavailable" | "recovery_failed";

export interface RuntimeStartupRecoveryFailure {
  readonly reason: RuntimeStartupRecoveryFailureReason;
  readonly executionId?: string;
  readonly organizationId?: string;
  readonly cause?: unknown;
}

export interface RuntimeStartupRecoveryOptions {
  readonly onFailure?: (failure: RuntimeStartupRecoveryFailure) => void | Promise<void>;
}

export class RuntimeStartupRecoveryService {
  private started = false;
  private closed = false;
  private healthy = false;
  private active: Promise<void> | undefined;

  public constructor(
    private readonly store: RuntimeStartupRecoveryStore,
    private readonly contexts: RuntimeRecoveryContextResolver,
    private readonly runner: RuntimeRecoveryRunner,
    private readonly options: RuntimeStartupRecoveryOptions = {},
  ) {}

  public async start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("종료된 Runtime 시작 복구 서비스는 다시 시작할 수 없습니다"));
    if (this.started) return Promise.reject(new Error("Runtime 시작 복구 서비스가 이미 실행됐습니다"));
    this.started = true;
    this.healthy = false;
    const active = this.recoverAll();
    this.active = active;
    try {
      await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  public ready(): boolean {
    return this.started && !this.closed && !this.active && this.healthy;
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
    let candidates: RuntimeRecoveryCandidate[];
    try {
      candidates = await this.store.listStartupRecoverable();
    } catch (error) {
      await this.report({ reason: "candidate_list_failed", cause: error });
      return;
    }

    let healthy = true;
    for (const candidate of candidates) {
      if (this.closed) {
        healthy = false;
        break;
      }
      if (!candidate.actor_user_id) {
        healthy = false;
        await this.report({
          reason: "legacy_actor_lineage_missing",
          executionId: candidate.execution_id,
          organizationId: candidate.organization_id,
        });
        continue;
      }

      let context: TenantContext;
      try {
        context = await this.contexts.resolveTenantContext(candidate.actor_user_id, candidate.organization_id);
      } catch (error) {
        healthy = false;
        await this.report({
          reason: "membership_unavailable",
          executionId: candidate.execution_id,
          organizationId: candidate.organization_id,
          cause: error,
        });
        continue;
      }

      try {
        await this.runner.recover(context, candidate.execution_id);
      } catch (error) {
        healthy = false;
        await this.report({
          reason: "recovery_failed",
          executionId: candidate.execution_id,
          organizationId: candidate.organization_id,
          cause: error,
        });
      }
    }
    if (!this.closed) this.healthy = healthy;
  }

  private async report(failure: RuntimeStartupRecoveryFailure): Promise<void> {
    try {
      await this.options.onFailure?.(failure);
    } catch {
      // 운영 보고 실패가 다른 실행의 안전한 복구를 막아서는 안 됩니다.
    }
  }
}
