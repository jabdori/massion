import {
  selectAssuranceProfile,
  type AssuranceBindingStore,
  type AssuranceRun,
  type AssuranceRunGateway,
  type DatabaseAssuranceSnapshotInput,
} from "@massion/assurance";
import type { TenantContext } from "@massion/identity";
import type { AgentRunner } from "@massion/runtime";
import type { WorkService } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

export interface CoreAssuranceCheckOrchestrator {
  execute(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly run: AssuranceRun;
      readonly request: unknown;
      readonly resumeInput?: unknown;
    },
  ): Promise<{
    readonly outcome: "ready" | "awaiting-approval" | "blocked";
    readonly approvalId?: string;
    readonly reason?: string;
  }>;
}

interface AssuranceConfiguration {
  readonly bindingVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly criterionExclusions?: DatabaseAssuranceSnapshotInput["criterionExclusions"];
}

function configuration(request: unknown): AssuranceConfiguration | undefined {
  const value = request && typeof request === "object" ? (request as { assurance?: unknown }).assurance : undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (![record.bindingVersionId, record.profileId, record.profileVersion].every((item) => typeof item === "string"))
    return undefined;
  return {
    bindingVersionId: record.bindingVersionId as string,
    profileId: record.profileId as string,
    profileVersion: record.profileVersion as string,
    ...(record.criterionExclusions && typeof record.criterionExclusions === "object"
      ? { criterionExclusions: record.criterionExclusions as never }
      : {}),
  };
}

export class CoreAssuranceStage implements CoreWorkStageExecutor {
  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "getWork" | "getActivePlan"> & Partial<Pick<WorkService, "recoverWork">>;
      readonly bindings?: Pick<AssuranceBindingStore, "getActive">;
      readonly runner: Pick<AgentRunner, "execute">;
      readonly assurance: Pick<AssuranceRunGateway, "prepareSnapshot" | "start" | "get" | "decide">;
      readonly checks: CoreAssuranceCheckOrchestrator;
    },
  ) {}

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    if (!input.workId) throw new Error("Assurance stage에 Work ID가 없습니다");
    const [work, plan] = await Promise.all([
      this.dependencies.works.getWork(context, input.workId),
      this.dependencies.works.getActivePlan(context, input.workId),
    ]);
    if (!plan) return { outcome: "blocked", reason: "strategy-plan-missing" };
    let config = configuration(input.request);
    if (!config && this.dependencies.bindings && this.dependencies.works.recoverWork) {
      const recovery = await this.dependencies.works.recoverWork(context, input.workId);
      const profile = selectAssuranceProfile(recovery.artifacts.map((artifact) => artifact.kind));
      const active = await this.dependencies.bindings.getActive(context, input.workId, plan.plan_version_id);
      if (active && active.profileId === profile.profileId && active.profileVersion === profile.version) {
        config = {
          bindingVersionId: active.bindingVersionId,
          profileId: active.profileId,
          profileVersion: active.profileVersion,
        };
      }
    }
    if (!config) return { outcome: "blocked", reason: "assurance-binding-required" };
    const snapshotInput: DatabaseAssuranceSnapshotInput = {
      workId: input.workId,
      targetWorkRevision: work.revision,
      planVersionId: plan.plan_version_id,
      bindingVersionId: config.bindingVersionId,
      profileId: config.profileId,
      profileVersion: config.profileVersion,
      ...(config.criterionExclusions === undefined ? {} : { criterionExclusions: config.criterionExclusions }),
    };
    const prepared = await this.dependencies.assurance.prepareSnapshot(context, snapshotInput);
    const verifier = await this.dependencies.runner.execute(context, {
      commandId: `${input.commandId}:verifier`,
      workId: input.workId,
      agentHandle: "assurance",
      modelRoute: "assurance-independent",
      correlationId: input.correlationId,
      estimatedTokens: 16_000,
      estimatedCostMicros: 0,
      input: { operation: "verify_work", snapshotHash: prepared.snapshot.hash },
    });
    if (verifier.status === "blocked_model_unavailable") return { outcome: "blocked", reason: "model-unavailable" };
    if (verifier.status !== "succeeded") return { outcome: "blocked", reason: `assurance-verifier-${verifier.status}` };
    const started = await this.dependencies.assurance.start(context, {
      commandId: `${input.commandId}:start`,
      ...snapshotInput,
      verifierHandle: "assurance",
      verifierExecutionId: verifier.executionId,
      snapshotHash: prepared.snapshot.hash,
      leaseTtlMs: 300_000,
    });
    if (["passed", "failed", "blocked", "cancelled"].includes(started.run.status)) return this.terminal(started.run);
    const checks = await this.dependencies.checks.execute(context, {
      commandId: `${input.commandId}:checks`,
      run: started.run,
      request: input.request,
      ...(input.resumeInput === undefined ? {} : { resumeInput: input.resumeInput }),
    });
    if (checks.outcome === "awaiting-approval" && checks.approvalId)
      return { outcome: "awaiting-approval", approvalId: checks.approvalId };
    if (checks.outcome === "blocked")
      return { outcome: "blocked", reason: checks.reason ?? "assurance-checks-blocked" };
    const current = await this.dependencies.assurance.get(context, started.run.assuranceRunId);
    const decided = await this.dependencies.assurance.decide(context, {
      commandId: `${input.commandId}:decide`,
      assuranceRunId: current.assuranceRunId,
      expectedVersion: current.version,
    });
    return this.terminal(decided.run);
  }

  private terminal(run: AssuranceRun): CoreWorkStageResult {
    if (run.status === "passed")
      return {
        outcome: "advanced",
        data: {
          assuranceRunId: run.assuranceRunId,
          verdict: "passed",
          projectedWorkRevision: run.projectedWorkRevision,
        },
      };
    return { outcome: "blocked", reason: `assurance-${run.status}` };
  }
}
