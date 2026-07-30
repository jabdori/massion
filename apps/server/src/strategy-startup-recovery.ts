import type { StrategyGeneration, StrategyStartupRecoveryCandidate } from "@massion/context-strategy";
import type { TenantContext } from "@massion/identity";

export interface StrategyStartupRecoverySource {
  listStartupRecoverable(): Promise<readonly StrategyStartupRecoveryCandidate[]>;
}

export interface StrategyRecoveryContextResolver {
  resolveTenantContext(userId: string, organizationId: string): Promise<TenantContext>;
}

export interface StrategyStartupRecoveryTarget {
  recoverGeneration(
    context: TenantContext,
    strategyGenerationId: string,
    waitForLease: boolean,
    signal: AbortSignal,
  ): Promise<StrategyGeneration | undefined>;
}

export type StrategyStartupRecoveryFailureReason =
  "candidate_list_failed" | "legacy_actor_lineage_missing" | "membership_unavailable" | "recovery_failed";

export interface StrategyStartupRecoveryFailure {
  readonly reason: StrategyStartupRecoveryFailureReason;
  readonly strategyGenerationId?: string;
  readonly organizationId?: string;
  readonly cause?: unknown;
}

export class StrategyStartupRecoveryService {
  private started = false;
  private closed = false;
  private healthy = false;
  private active: Promise<void> | undefined;
  private activeController: AbortController | undefined;

  public constructor(
    private readonly source: StrategyStartupRecoverySource,
    private readonly contexts: StrategyRecoveryContextResolver,
    private readonly target: StrategyStartupRecoveryTarget,
    private readonly onFailure?: (failure: StrategyStartupRecoveryFailure) => void | Promise<void>,
  ) {}

  public async start(): Promise<void> {
    if (this.closed) throw new Error("종료된 Strategy 시작 복구 서비스는 다시 시작할 수 없습니다");
    if (this.started) throw new Error("Strategy 시작 복구 서비스가 이미 실행됐습니다");
    this.started = true;
    const controller = new AbortController();
    this.activeController = controller;
    const active = this.recoverAll(controller.signal);
    this.active = active;
    try {
      await active;
    } finally {
      if (this.active === active) this.active = undefined;
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  public ready(): boolean {
    return this.started && !this.closed && !this.active && this.healthy;
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.healthy = false;
      this.activeController?.abort(new Error("Strategy 시작 복구 서비스가 종료됐습니다"));
    }
    await this.active;
  }

  private async recoverAll(signal: AbortSignal): Promise<void> {
    let candidates: readonly StrategyStartupRecoveryCandidate[];
    try {
      candidates = await this.source.listStartupRecoverable();
    } catch (error) {
      if (signal.aborted) return;
      await this.report({ reason: "candidate_list_failed", cause: error });
      return;
    }
    let healthy = true;
    for (const candidate of candidates) {
      if (signal.aborted) {
        healthy = false;
        break;
      }
      if (!candidate.actorUserId) {
        healthy = false;
        await this.report({
          reason: "legacy_actor_lineage_missing",
          strategyGenerationId: candidate.strategyGenerationId,
          organizationId: candidate.organizationId,
        });
        continue;
      }
      let context: TenantContext;
      try {
        context = await this.contexts.resolveTenantContext(candidate.actorUserId, candidate.organizationId);
      } catch (error) {
        if (signal.aborted) break;
        healthy = false;
        await this.report({
          reason: "membership_unavailable",
          strategyGenerationId: candidate.strategyGenerationId,
          organizationId: candidate.organizationId,
          cause: error,
        });
        continue;
      }
      try {
        signal.throwIfAborted();
        const recovered = await this.target.recoverGeneration(context, candidate.strategyGenerationId, true, signal);
        signal.throwIfAborted();
        if (!recovered || recovered.status === "pending" || recovered.status === "generated") {
          throw new Error("Strategy 시작 복구가 terminal 상태로 수렴하지 않았습니다");
        }
      } catch (error) {
        if (signal.aborted) break;
        healthy = false;
        await this.report({
          reason: "recovery_failed",
          strategyGenerationId: candidate.strategyGenerationId,
          organizationId: candidate.organizationId,
          cause: error,
        });
      }
    }
    if (!this.closed) this.healthy = healthy;
  }

  private async report(failure: StrategyStartupRecoveryFailure): Promise<void> {
    try {
      await this.onFailure?.(failure);
    } catch {
      // 운영 보고 실패가 다음 Strategy 복구를 막지 않습니다.
    }
  }
}
