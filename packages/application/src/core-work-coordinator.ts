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
}

export type CoreWorkStageResult =
  | { readonly outcome: "advanced"; readonly workId?: string; readonly data?: unknown }
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

export class CoreWorkCoordinator {
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

  public async retryBlocked(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    if (run.status !== "blocked") throw new Error("차단된 Application run만 다시 시도할 수 있습니다");
    return await this.execute(context, run, undefined, false, true);
  }

  public async cancel(context: TenantContext, runId: string): Promise<ApplicationRunView> {
    const run = await this.store.get(context, runId);
    if (run.stage === "terminal") return run;
    const stage = run.stage;
    await this.executors[stage].cancel?.(context, {
      runId: run.runId,
      ...(run.workId === undefined ? {} : { workId: run.workId }),
      commandId: `${run.runId}:${stage}:cancel`,
      correlationId: run.correlationId,
      request: run.request,
    });
    return await this.store.cancel(context, runId);
  }

  private async execute(
    context: TenantContext,
    initial: ApplicationRunView,
    resumeInput: unknown,
    resumeAwaitingApproval: boolean,
    resumeBlocked = false,
  ): Promise<ApplicationRunView> {
    let run = initial;
    let nextResumeInput = resumeInput;
    let shouldResume = resumeAwaitingApproval;
    while (run.stage !== "terminal") {
      const claim = await this.store.claim(context, run.runId, {
        resumeAwaitingApproval: shouldResume,
        resumeBlocked,
      });
      shouldResume = false;
      resumeBlocked = false;
      if (claim.outcome === "in-progress") return await this.store.get(context, run.runId);
      if (claim.outcome === "terminal") return claim.run;
      const stage = run.stage;
      const result = await this.executors[stage].execute(context, {
        runId: run.runId,
        ...(run.workId === undefined ? {} : { workId: run.workId }),
        commandId: `${run.runId}:${stage}`,
        correlationId: run.correlationId,
        request: run.request,
        ...(nextResumeInput === undefined ? {} : { resumeInput: nextResumeInput }),
      });
      nextResumeInput = undefined;
      await this.hooks.afterStage?.(stage, result);
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
    }
    return run;
  }
}
