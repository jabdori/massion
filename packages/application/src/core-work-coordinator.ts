import type { TenantContext } from "@massion/identity";

import { type ApplicationRunStage, type ApplicationRunView, ApplicationRunStore } from "./run-store.js";
import {
  WorkDirectiveBusyError,
  type WorkDirectiveMode,
  type WorkDirectiveStore,
  type WorkDirectiveView,
} from "./work-directive-store.js";

export const APPLICATION_RUN_STAGES = [
  "intake",
  "context-strategy",
  "evidence",
  "delivery",
  "assurance",
  "records",
] as const;

export type CoreWorkStage = (typeof APPLICATION_RUN_STAGES)[number];

interface ApprovalResumeInput {
  readonly approvalId: string;
}

export interface CoreWorkStageInput {
  readonly runId: string;
  readonly workId?: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly request: unknown;
  readonly resumeInput?: unknown;
  readonly directives?: readonly {
    readonly directiveId: string;
    readonly content: string;
    readonly mode: WorkDirectiveMode;
  }[];
  readonly signal?: AbortSignal;
}

export type CoreWorkStageResult = (
  | { readonly outcome: "advanced"; readonly workId?: string; readonly data?: unknown }
  | { readonly outcome: "in-progress" }
  | { readonly outcome: "awaiting-approval"; readonly approvalId: string }
  | { readonly outcome: "blocked"; readonly reason: string; readonly workId?: string }
) & { readonly appliedDirectiveIds?: readonly string[] };

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

function validateApprovalResumeInput(value: unknown): ApprovalResumeInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("승인 재개 입력은 approvalId만 포함해야 합니다");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "approvalId") ||
    typeof record.approvalId !== "string" ||
    record.approvalId.trim().length === 0
  ) {
    throw new Error("승인 재개 입력은 비어 있지 않은 approvalId만 포함해야 합니다");
  }
  return { approvalId: record.approvalId };
}

function stageCommandId(runId: string, stage: CoreWorkStage, retryAttemptId?: string): string {
  const prefix = retryAttemptId === undefined ? `${runId}:${stage}` : `${runId}:${stage}:retry:${retryAttemptId}`;
  return prefix;
}

function acknowledgedAllClaimedDirectives(
  result: CoreWorkStageResult,
  claimedDirectives: readonly WorkDirectiveView[],
): boolean {
  if (claimedDirectives.length === 0) return true;
  const acknowledged = result.appliedDirectiveIds;
  if (acknowledged === undefined || acknowledged.length !== claimedDirectives.length) return false;
  const acknowledgedIds = new Set(acknowledged);
  return (
    acknowledgedIds.size === acknowledged.length &&
    claimedDirectives.every((directive) => acknowledgedIds.has(directive.directiveId))
  );
}

export class CoreWorkCoordinator {
  private readonly activeStageAbortControllers = new Map<string, Set<AbortController>>();
  private readonly cancellationRequests = new Map<string, Promise<ApplicationRunView>>();

  public constructor(
    private readonly store: ApplicationRunStore,
    private readonly executors: Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>,
    private readonly hooks: CoreWorkCoordinatorHooks = {},
    private readonly directives?: Pick<
      WorkDirectiveStore,
      "claimEligible" | "markApplied" | "markFailed" | "markUnapplied" | "requeueFailed"
    >,
  ) {}

  public async start(
    context: TenantContext,
    input: { readonly commandId: string; readonly correlationId: string; readonly request: unknown },
  ): Promise<ApplicationRunView> {
    const run = await this.store.start(context, input);
    return await this.execute(context, run, undefined, false);
  }

  public async resume(context: TenantContext, runId: string, resumeInput: unknown): Promise<ApplicationRunView> {
    const validatedResumeInput = validateApprovalResumeInput(resumeInput);
    const run = await this.store.get(context, runId);
    if (run.status !== "awaiting-approval") throw new Error("승인 대기 중인 Application run만 재개할 수 있습니다");
    if (run.approvalId !== validatedResumeInput.approvalId) {
      throw new Error("Application run의 승인 ID가 승인 재개 입력과 일치하지 않습니다");
    }
    return await this.execute(context, run, validatedResumeInput, true);
  }

  public async recover(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    return await this.execute(context, run, run.resumeInput, false);
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
    if (run.status === "blocked") {
      return await this.execute(context, run, run.resumeInput, false, true, retryAttemptId);
    }
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
    await this.directives?.markUnapplied(context, runId);
    if (cleanupError) throw cleanupError;
    return cancelled;
  }

  private async execute(
    context: TenantContext,
    initial: ApplicationRunView,
    resumeInput: ApprovalResumeInput | undefined,
    resumeAwaitingApproval: boolean,
    resumeBlocked = false,
    retryAttemptId?: string,
  ): Promise<ApplicationRunView> {
    let run = initial;
    if (run.stage === "terminal") {
      await this.directives?.markUnapplied(context, run.runId);
      return run;
    }
    let nextResumeInput = resumeInput;
    let shouldResume = resumeAwaitingApproval;
    let nextRetryAttemptId = retryAttemptId;
    while (run.stage !== "terminal") {
      const controller = this.registerStageAbortController(run.runId);
      const explicitRetryAttemptId = resumeBlocked ? nextRetryAttemptId : undefined;
      let claim: Awaited<ReturnType<ApplicationRunStore["claim"]>>;
      try {
        claim = await this.store.claim(context, run.runId, {
          resumeAwaitingApproval: shouldResume,
          resumeBlocked,
          ...(nextRetryAttemptId === undefined ? {} : { retryAttemptId: nextRetryAttemptId }),
          ...(shouldResume && nextResumeInput !== undefined ? { approvalId: nextResumeInput.approvalId } : {}),
        });
        if (claim.outcome === "claimed" && explicitRetryAttemptId !== undefined) {
          if (claim.retryAttemptId !== explicitRetryAttemptId) {
            throw new Error("Application run retry attempt가 지시 재큐잉 요청과 일치하지 않습니다");
          }
          await this.directives?.requeueFailed(context, run.runId, explicitRetryAttemptId, claim.leaseGeneration);
        }
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
      let claimedDirectives: readonly WorkDirectiveView[] = [];
      try {
        let result: CoreWorkStageResult;
        try {
          claimedDirectives =
            (await this.directives?.claimEligible(context, run.runId, stage, claim.leaseGeneration)) ?? [];
          result = await this.executors[stage].execute(context, {
            runId: run.runId,
            ...(run.workId === undefined ? {} : { workId: run.workId }),
            commandId: stageCommandId(run.runId, stage, claim.retryAttemptId),
            correlationId: run.correlationId,
            request: run.request,
            ...(nextResumeInput === undefined ? {} : { resumeInput: nextResumeInput }),
            ...(claimedDirectives.length === 0
              ? {}
              : {
                  directives: claimedDirectives.map((directive) => ({
                    directiveId: directive.directiveId,
                    content: directive.content,
                    mode: directive.mode,
                  })),
                }),
            signal: controller.signal,
          });
        } catch (error) {
          const cancellation = controller.signal.aborted ? this.cancellationRequests.get(run.runId) : undefined;
          if (cancellation) return await cancellation;
          const current = await this.store.get(context, run.runId);
          if (current.status === "cancelled") return current;
          const reason = error instanceof WorkDirectiveBusyError ? `${stage}-directive-busy` : `${stage}-stage-failed`;
          await Promise.allSettled(
            claimedDirectives.map(
              (directive) =>
                // directives가 없으면(undefined) 즉시 이행 Promise로 배열 요소를 Promise로 맞춥니다.
                this.directives?.markFailed(context, directive.directiveId, directive.leaseGeneration, reason) ??
                Promise.resolve(),
            ),
          );
          return await this.store.block(context, run.runId, claim.leaseGeneration, reason, run.workId);
        } finally {
          this.releaseStageAbortController(run.runId, controller);
        }
        if (controller.signal.aborted) {
          const cancellation = this.cancellationRequests.get(run.runId);
          if (cancellation) return await cancellation;
          return await this.store.get(context, run.runId);
        }
        if (!acknowledgedAllClaimedDirectives(result, claimedDirectives)) {
          const reason =
            result.outcome === "blocked" && result.reason === `${stage}-directive-unsupported`
              ? result.reason
              : `${stage}-directive-unacknowledged`;
          await Promise.all(
            claimedDirectives.map(
              (directive) =>
                this.directives?.markFailed(context, directive.directiveId, directive.leaseGeneration, reason) ??
                Promise.resolve(),
            ),
          );
          return await this.store.block(context, run.runId, claim.leaseGeneration, reason, run.workId);
        }
        await Promise.all(
          claimedDirectives.map(
            (directive) =>
              this.directives?.markApplied(context, directive.directiveId, directive.leaseGeneration) ??
              Promise.resolve(),
          ),
        );
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
          const completed = await this.store.complete(context, run.runId, claim.leaseGeneration, result.data);
          await this.directives?.markUnapplied(context, run.runId);
          return completed;
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
