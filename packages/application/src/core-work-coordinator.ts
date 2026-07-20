import type { TenantContext } from "@massion/identity";

import { type ApplicationRunStage, type ApplicationRunView, ApplicationRunStore } from "./run-store.js";

export const APPLICATION_RUN_STAGES = [
  "intake",
  "context-strategy",
  "evidence",
  "delivery",
  "assurance",
  "records",
] as const;

export type CoreWorkStage = (typeof APPLICATION_RUN_STAGES)[number];

export interface CoreWorkStageInput {
  readonly runId: string;
  readonly workId?: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly request: unknown;
  readonly resumeInput?: unknown;
  readonly signal?: AbortSignal;
}

export type CoreWorkStageResult =
  | { readonly outcome: "advanced"; readonly workId?: string; readonly data?: unknown }
  | { readonly outcome: "in-progress" }
  | { readonly outcome: "awaiting-approval"; readonly approvalId: string }
  | { readonly outcome: "blocked"; readonly reason: string; readonly workId?: string };

export interface CoreWorkStageExecutor {
  execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult>;
  cancel?(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void>;
}

export interface CoreWorkCoordinatorHooks {
  readonly afterStage?: (stage: CoreWorkStage, result: CoreWorkStageResult) => void | Promise<void>;
}

function nextStage(stage: CoreWorkStage): ApplicationRunStage {
  const index = APPLICATION_RUN_STAGES.indexOf(stage);
  return APPLICATION_RUN_STAGES[index + 1] ?? "terminal";
}

function stageCommandId(runId: string, stage: CoreWorkStage, retryAttemptId?: string): string {
  const prefix = retryAttemptId === undefined ? `${runId}:${stage}` : `${runId}:${stage}:retry:${retryAttemptId}`;
  return prefix;
}

export class CoreWorkCoordinator {
  private readonly activeStageAbortControllers = new Map<string, Set<AbortController>>();
  private readonly cancellationRequests = new Map<string, Promise<ApplicationRunView>>();

  public constructor(
    private readonly store: ApplicationRunStore,
    private readonly executors: Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>,
    private readonly hooks: CoreWorkCoordinatorHooks = {},
  ) {}

  public async start(
    context: TenantContext,
    input: { readonly commandId: string; readonly correlationId: string; readonly request: unknown },
  ): Promise<ApplicationRunView> {
    const run = await this.store.start(context, input);
    return await this.execute(context, run, undefined, false);
  }

  public async resume(context: TenantContext, runId: string, resumeInput: unknown): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    if (run.status !== "awaiting-approval") throw new Error("승인 대기 중인 Application run만 재개할 수 있습니다");
    return await this.execute(context, run, resumeInput, true);
  }

  public async recover(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    return await this.execute(context, await this.store.get(context, runId), undefined, false);
  }

  public async retryBlocked(
    context: TenantContext,
    runId: string,
    retryAttemptId: string,
  ): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    if (run.retryAttemptId === retryAttemptId || run.retryReplayId === retryAttemptId) {
      return await this.recover(context, runId);
    }
    if (run.status === "blocked") return await this.execute(context, run, undefined, false, true, retryAttemptId);
    throw new Error("차단되었거나 같은 재시도 시도를 가진 Application run만 다시 시도할 수 있습니다");
  }

  public async cancel(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    const existing = this.cancellationRequests.get(runId);
    if (existing) return await existing;
    const cancellation = this.cancelActive(context, runId);
    this.cancellationRequests.set(runId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.cancellationRequests.get(runId) === cancellation) this.cancellationRequests.delete(runId);
    }
  }

  private async cancelActive(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    if (run.stage === "terminal") return run;
    const stage = run.stage;
    this.abortStageExecutions(run.runId);
    let cleanupError: Error | undefined;
    try {
      await this.executors[stage].cancel?.(context, {
        runId: run.runId,
        ...(run.workId === undefined ? {} : { workId: run.workId }),
        commandId: `${stageCommandId(run.runId, stage, run.retryAttemptId)}:cancel`,
        correlationId: run.correlationId,
        request: run.request,
      });
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error), { cause: error });
    }
    const cancelled = await this.store.cancel(context, runId);
    if (cleanupError) throw cleanupError;
    return cancelled;
  }

  private async execute(
    context: TenantContext,
    initial: ApplicationRunView,
    resumeInput: unknown,
    resumeAwaitingApproval: boolean,
    resumeBlocked = false,
    retryAttemptId?: string,
  ): Promise<ApplicationRunView> {
    let run = initial;
    let nextResumeInput = resumeInput;
    let shouldResume = resumeAwaitingApproval;
    let nextRetryAttemptId = retryAttemptId;
    while (run.stage !== "terminal") {
      const controller = this.registerStageAbortController(run.runId);
      let claim: Awaited<ReturnType<ApplicationRunStore["claim"]>>;
      try {
        claim = await this.store.claim(context, run.runId, {
          resumeAwaitingApproval: shouldResume,
          resumeBlocked,
          ...(nextRetryAttemptId === undefined ? {} : { retryAttemptId: nextRetryAttemptId }),
        });
      } catch (error) {
        this.releaseStageAbortController(run.runId, controller);
        throw error;
      }
      shouldResume = false;
      resumeBlocked = false;
      nextRetryAttemptId = undefined;
      if (claim.outcome === "in-progress") {
        this.releaseStageAbortController(run.runId, controller);
        return await this.store.get(context, run.runId);
      }
      if (claim.outcome === "terminal") {
        this.releaseStageAbortController(run.runId, controller);
        return claim.run;
      }
      const stage = run.stage;
      try {
        let result: CoreWorkStageResult;
        try {
          result = await this.executors[stage].execute(context, {
            runId: run.runId,
            ...(run.workId === undefined ? {} : { workId: run.workId }),
            commandId: stageCommandId(run.runId, stage, claim.retryAttemptId),
            correlationId: run.correlationId,
            request: run.request,
            ...(nextResumeInput === undefined ? {} : { resumeInput: nextResumeInput }),
            signal: controller.signal,
          });
        } finally {
          this.releaseStageAbortController(run.runId, controller);
        }
        if (controller.signal.aborted) {
          const cancellation = this.cancellationRequests.get(run.runId);
          if (cancellation) return await cancellation;
          return await this.store.get(context, run.runId);
        }
        nextResumeInput = undefined;
        await this.hooks.afterStage?.(stage, result);
        if (result.outcome === "in-progress") return await this.store.get(context, run.runId);
        if (result.outcome === "awaiting-approval") {
          return await this.store.suspend(context, run.runId, claim.leaseGeneration, result.approvalId);
        }
        if (result.outcome === "blocked") {
          return await this.store.block(context, run.runId, claim.leaseGeneration, result.reason, result.workId);
        }
        const following = nextStage(stage);
        if (following === "terminal") {
          return await this.store.complete(context, run.runId, claim.leaseGeneration, result.data);
        }
        const workId = result.workId ?? run.workId;
        run = await this.store.advance(context, run.runId, claim.leaseGeneration, {
          stage: following,
          ...(workId === undefined ? {} : { workId }),
        });
      } catch (error) {
        const cancellation = controller.signal.aborted ? this.cancellationRequests.get(run.runId) : undefined;
        if (cancellation) return await cancellation;
        const current = await this.store.get(context, run.runId);
        if (current.status === "cancelled") return current;
        throw error;
      }
    }
    return run;
  }

  private registerStageAbortController(runId: string): AbortController {
    const controller = new AbortController();
    const controllers = this.activeStageAbortControllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeStageAbortControllers.set(runId, controllers);
    return controller;
  }

  private releaseStageAbortController(runId: string, controller: AbortController): void {
    const controllers = this.activeStageAbortControllers.get(runId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.activeStageAbortControllers.delete(runId);
  }

  private abortStageExecutions(runId: string): void {
    for (const controller of this.activeStageAbortControllers.get(runId) ?? []) controller.abort();
  }
}
