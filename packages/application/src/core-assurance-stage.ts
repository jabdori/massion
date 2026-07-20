import {
  compileAssuranceCriteria,
  selectAssuranceProfile,
  type AssuranceCheckBinding,
  type AssuranceBindingStore,
  type AssuranceRun,
  type AssuranceRunGateway,
  type DatabaseAssuranceSnapshotInput,
} from "@massion/assurance";
import { validateStrategyPlan } from "@massion/context-strategy";
import { GovernanceApprovalRequiredError, GovernanceDeniedError } from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import type { WorkRecoveryBundle, WorkService } from "@massion/work";

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

export interface AutomaticAssuranceBindingRecipe {
  readonly requiredCriteria: readonly {
    readonly criterionKey: string;
    readonly method: AssuranceCheckBinding["kind"];
  }[];
  readonly bindings: readonly AssuranceCheckBinding[];
}

/**
 * 소프트웨어 Delivery가 남긴 안전한 재검증 명령을 Assurance binding으로 변환합니다.
 * 이 경계는 Application이 명령 원문이나 저장 형식을 직접 알지 않게 합니다.
 */
export interface SoftwareAssuranceRecipeResolver {
  resolve(
    context: TenantContext,
    input: {
      readonly workId: string;
      readonly planContentJson: string;
      readonly recovery: Pick<WorkRecoveryBundle, "artifacts" | "artifactVersions" | "tasks">;
    },
  ): Promise<AutomaticAssuranceBindingRecipe | undefined>;
}

type AssuranceConfigurationResolution =
  | { readonly outcome: "ready"; readonly configuration: AssuranceConfiguration }
  | { readonly outcome: "awaiting-approval"; readonly approvalId: string }
  | { readonly outcome: "blocked"; readonly reason: string };

interface ReadyVerifier {
  readonly executionId: string;
  readonly complete: () => Promise<Awaited<ReturnType<AgentRunner["recover"]>>>;
}

const AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS = 300_000;
const APPLICATION_RUN_CANCELLED = "Application run cancelled";

function approvalId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { readonly approvalId?: unknown }).approvalId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function configurationFromBinding(binding: {
  readonly bindingVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
}): AssuranceConfiguration {
  return {
    bindingVersionId: binding.bindingVersionId,
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
  };
}

function artifactEvidenceBinding(
  bindingKey: string,
  criterionKey: string,
  evidenceKinds: readonly string[],
): AssuranceCheckBinding {
  return {
    bindingKey,
    criterionKey,
    kind: "evidence",
    executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
    evidenceKinds,
    requiredEvidenceKinds: evidenceKinds,
    maximumAgeMs: AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS,
  };
}

function automaticBindings(
  planContentJson: string,
  recovery: Pick<WorkRecoveryBundle, "tasks">,
  profile: ReturnType<typeof selectAssuranceProfile>,
): AutomaticAssuranceBindingRecipe | undefined {
  if (profile.profileId !== "massion.assurance.acceptance.v1") return undefined;
  let plan: ReturnType<typeof validateStrategyPlan>;
  try {
    plan = validateStrategyPlan(JSON.parse(planContentJson) as unknown);
  } catch {
    return undefined;
  }
  if (
    !plan.acceptanceCriteria.every(
      (criterion) =>
        criterion.method === "evidence" &&
        criterion.evidenceKinds.length === 1 &&
        criterion.evidenceKinds[0] === "artifact-version",
    )
  ) {
    return undefined;
  }
  const coverage = profile.criteria.find((criterion) => criterion.key === "profile:acceptance:coverage");
  if (
    !coverage ||
    coverage.method !== "evidence" ||
    coverage.requiredEvidenceKinds.length !== 1 ||
    coverage.requiredEvidenceKinds[0] !== "check-result"
  ) {
    return undefined;
  }
  const bindings: AssuranceCheckBinding[] = [
    ...plan.acceptanceCriteria.map((criterion, index) =>
      artifactEvidenceBinding(`auto-evidence-${String(index + 1)}`, criterion.key, ["artifact-version"]),
    ),
    artifactEvidenceBinding("auto-acceptance-coverage", coverage.key, ["check-result"]),
  ];
  try {
    const criteria = compileAssuranceCriteria({
      planContentJson,
      tasks: recovery.tasks.map((task) => ({
        taskId: task.task_id,
        status: task.status,
        acceptanceCriteriaJson: task.acceptance_criteria_json,
      })),
      profile,
      bindings: bindings.map((binding) => ({
        criterionKey: binding.criterionKey,
        method: binding.kind,
        requiredEvidenceKinds: binding.requiredEvidenceKinds,
      })),
    });
    return {
      requiredCriteria: criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        method: criterion.method,
      })),
      bindings,
    };
  } catch {
    return undefined;
  }
}

export class CoreAssuranceStage implements CoreWorkStageExecutor {
  private readonly activeVerifierDrains = new Map<string, ReadyVerifier["complete"]>();

  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "getWork" | "getActivePlan" | "recoverWork">;
      readonly bindings: Pick<AssuranceBindingStore, "getActive" | "propose" | "activate">;
      readonly runner: Pick<AgentRunner, "stream" | "recover" | "cancel">;
      readonly runtimeExecutions: Pick<RuntimeExecutionStore, "findExecutionIdByCommand" | "getRecovery">;
      readonly assurance: Pick<
        AssuranceRunGateway,
        "prepareSnapshot" | "start" | "transition" | "get" | "findByStartCommand" | "decide" | "projectVerdict"
      >;
      readonly checks: CoreAssuranceCheckOrchestrator;
      readonly softwareAssuranceRecipes?: SoftwareAssuranceRecipeResolver;
    },
  ) {}

  public async cancel(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void> {
    const stageCommandId = input.commandId.replace(/:cancel$/u, "");
    await this.cancelVerifierAndRun(
      context,
      stageCommandId,
      APPLICATION_RUN_CANCELLED,
      `${input.commandId}:decide`,
      undefined,
      this.activeVerifierDrains.get(stageCommandId),
    );
  }

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    this.throwIfCancelled(input);
    const workId = input.workId;
    if (!workId) throw new Error("Assurance stage에 Work ID가 없습니다");
    const [work, plan] = await Promise.all([
      this.dependencies.works.getWork(context, workId),
      this.dependencies.works.getActivePlan(context, workId),
    ]);
    this.throwIfCancelled(input);
    if (!plan) return { outcome: "blocked", reason: "strategy-plan-missing" };
    const recovery = await this.dependencies.works.recoverWork(context, workId);
    this.throwIfCancelled(input);
    const resolved = await this.resolveConfiguration(context, input, workId, plan, recovery);
    this.throwIfCancelled(input);
    if (resolved.outcome === "awaiting-approval") return resolved;
    if (resolved.outcome === "blocked") return resolved;
    const config = resolved.configuration;
    const snapshotInput: DatabaseAssuranceSnapshotInput = {
      workId,
      targetWorkRevision: work.revision,
      planVersionId: plan.plan_version_id,
      bindingVersionId: config.bindingVersionId,
      profileId: config.profileId,
      profileVersion: config.profileVersion,
      ...(config.criterionExclusions === undefined ? {} : { criterionExclusions: config.criterionExclusions }),
    };
    const verifierCommandId = `${input.commandId}:verifier`;
    const existingVerifierExecutionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(
      context,
      verifierCommandId,
    );
    const existingVerifier = existingVerifierExecutionId
      ? await this.dependencies.runtimeExecutions.getRecovery(context, existingVerifierExecutionId)
      : undefined;
    this.throwIfCancelled(input);
    if (existingVerifier?.execution.status === "running") return { outcome: "in-progress" };
    if (existingVerifier?.execution.status === "suspended" || existingVerifier?.execution.status === "interrupted") {
      const verifierStatus = existingVerifier.execution.status;
      await this.cancelVerifierAndRun(
        context,
        input.commandId,
        `Assurance verifier ${verifierStatus} requires explicit retry`,
        `${input.commandId}:${verifierStatus}:decide`,
      );
      return { outcome: "blocked", reason: `assurance-verifier-${verifierStatus}` };
    }
    if (existingVerifier && !["queued", "succeeded"].includes(existingVerifier.execution.status)) {
      const existingRun = await this.dependencies.assurance.findByStartCommand(context, `${input.commandId}:start`);
      this.throwIfCancelled(input);
      if (!existingRun) {
        return { outcome: "blocked", reason: `assurance-verifier-${existingVerifier.execution.status}` };
      }
      const wasTerminal = this.isTerminal(existingRun);
      const completed = await this.completeRun(
        context,
        input,
        workId,
        existingRun,
        existingVerifier.execution.status === "cancelled",
      );
      if (
        !wasTerminal &&
        existingVerifier.execution.status === "blocked_model_unavailable" &&
        completed.run.status === "blocked"
      ) {
        return { outcome: "blocked", reason: "model-unavailable" };
      }
      return completed.result;
    }
    if (existingVerifier?.execution.status === "succeeded") {
      const existingRun = await this.dependencies.assurance.findByStartCommand(context, `${input.commandId}:start`);
      this.throwIfCancelled(input);
      if (!existingRun) return { outcome: "blocked", reason: "assurance-verifier-terminal-without-run" };
    }
    this.throwIfCancelled(input);
    const prepared = await this.dependencies.assurance.prepareSnapshot(context, snapshotInput);
    this.throwIfCancelled(input);
    const verifierInput = {
      commandId: verifierCommandId,
      workId,
      agentHandle: "assurance",
      modelRoute: "assurance-independent",
      correlationId: input.correlationId,
      estimatedTokens: 16_000,
      estimatedCostMicros: 0,
      input: { operation: "verify_work", snapshotHash: prepared.snapshot.hash },
    };
    const verifier =
      existingVerifier?.execution.status === "queued"
        ? await this.startVerifier(context, input, verifierInput)
        : existingVerifierExecutionId
          ? {
              outcome: "ready" as const,
              executionId: existingVerifierExecutionId,
              complete: async () => await this.dependencies.runner.recover(context, existingVerifierExecutionId),
            }
          : await this.startVerifier(context, input, verifierInput);
    if (verifier.outcome === "blocked") {
      this.throwIfCancelled(input);
      return verifier;
    }
    this.activeVerifierDrains.set(input.commandId, verifier.complete);
    try {
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      let started: Awaited<ReturnType<AssuranceRunGateway["start"]>>;
      try {
        started = await this.dependencies.assurance.start(context, {
          commandId: `${input.commandId}:start`,
          ...snapshotInput,
          verifierHandle: "assurance",
          verifierExecutionId: verifier.executionId,
          snapshotHash: prepared.snapshot.hash,
          leaseTtlMs: 300_000,
        });
      } catch (error) {
        await this.cancelAndThrowIfCancelled(context, input, verifier);
        await this.dependencies.runner.cancel(context, verifier.executionId, "Assurance run을 시작하지 못했습니다");
        throw error;
      }
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      if (["passed", "failed", "blocked", "cancelled"].includes(started.run.status))
        return await this.terminal(context, input, workId, started.run);
      const running =
        started.run.status === "planned"
          ? await this.dependencies.assurance.transition(context, {
              commandId: `${input.commandId}:running`,
              assuranceRunId: started.run.assuranceRunId,
              expectedVersion: started.run.version,
              target: "running",
            })
          : { run: started.run };
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      const completedVerifier = await verifier.complete();
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      if (completedVerifier.status !== "succeeded") {
        const current = await this.dependencies.assurance.get(context, started.run.assuranceRunId);
        await this.cancelAndThrowIfCancelled(context, input, verifier);
        const wasTerminal = this.isTerminal(current);
        const completed = await this.completeRun(
          context,
          input,
          workId,
          current,
          completedVerifier.status === "cancelled",
        );
        if (
          !wasTerminal &&
          completedVerifier.status === "blocked_model_unavailable" &&
          completed.run.status === "blocked"
        ) {
          return { outcome: "blocked", reason: "model-unavailable" };
        }
        return completed.result;
      }
      const checks = await this.dependencies.checks.execute(context, {
        commandId: `${input.commandId}:checks`,
        run: running.run,
        request: input.request,
        ...(input.resumeInput === undefined ? {} : { resumeInput: input.resumeInput }),
      });
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      if (checks.outcome === "awaiting-approval" && checks.approvalId)
        return { outcome: "awaiting-approval", approvalId: checks.approvalId };
      if (checks.outcome === "blocked") {
        const current = await this.dependencies.assurance.get(context, started.run.assuranceRunId);
        await this.cancelAndThrowIfCancelled(context, input, verifier);
        const completed = await this.completeRun(context, input, workId, current);
        if (completed.result.outcome === "blocked") {
          return {
            ...completed.result,
            reason: checks.reason ?? completed.result.reason,
          };
        }
        return completed.result;
      }
      const current = await this.dependencies.assurance.get(context, started.run.assuranceRunId);
      await this.cancelAndThrowIfCancelled(context, input, verifier);
      return (await this.completeRun(context, input, workId, current)).result;
    } finally {
      if (this.activeVerifierDrains.get(input.commandId) === verifier.complete) {
        this.activeVerifierDrains.delete(input.commandId);
      }
    }
  }

  private async startVerifier(
    context: TenantContext,
    stageInput: CoreWorkStageInput,
    input: Parameters<AgentRunner["stream"]>[1],
  ): Promise<
    ({ readonly outcome: "ready" } & ReadyVerifier) | { readonly outcome: "blocked"; readonly reason: string }
  > {
    const stream = this.dependencies.runner.stream(context, input)[Symbol.asyncIterator]();
    const queued = await stream.next();
    if (queued.done || queued.value.type !== "execution_queued") {
      return { outcome: "blocked", reason: "assurance-verifier-start-failed" };
    }
    const executionId = queued.value.executionId;
    if (stageInput.signal?.aborted) {
      await this.cancelVerifierAndRun(
        context,
        stageInput.commandId,
        APPLICATION_RUN_CANCELLED,
        `${stageInput.commandId}:cancel:decide`,
        executionId,
      );
      throw new Error(APPLICATION_RUN_CANCELLED);
    }
    const running = await stream.next();
    if (
      running.done ||
      running.value.type !== "execution_running" ||
      running.value.executionId !== queued.value.executionId
    ) {
      return { outcome: "blocked", reason: "assurance-verifier-start-failed" };
    }
    let completion: Promise<Awaited<ReturnType<AgentRunner["recover"]>>> | undefined;
    const complete = async (): Promise<Awaited<ReturnType<AgentRunner["recover"]>>> => {
      completion ??= (async () => {
        for (let event = await stream.next(); !event.done; event = await stream.next()) {
          // verifier stream의 모든 terminal event를 영속한 뒤 Runtime 상태를 읽습니다.
        }
        return await this.dependencies.runner.recover(context, executionId);
      })();
      return await completion;
    };
    this.activeVerifierDrains.set(stageInput.commandId, complete);
    return {
      outcome: "ready",
      executionId,
      complete,
    };
  }

  private async resolveConfiguration(
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    plan: { readonly plan_version_id: string; readonly content_json: string },
    recovery: Pick<WorkRecoveryBundle, "artifacts" | "artifactVersions" | "tasks">,
  ): Promise<AssuranceConfigurationResolution> {
    const profile = selectAssuranceProfile(recovery.artifacts.map((artifact) => artifact.kind));
    const active = await this.dependencies.bindings.getActive(context, workId, plan.plan_version_id);
    this.throwIfCancelled(input);
    if (active && active.profileId === profile.profileId && active.profileVersion === profile.version) {
      return { outcome: "ready", configuration: configurationFromBinding(active) };
    }
    const recipe =
      profile.profileId === "massion.assurance.software-change.v1"
        ? await this.dependencies.softwareAssuranceRecipes?.resolve(context, {
            workId,
            planContentJson: plan.content_json,
            recovery,
          })
        : automaticBindings(plan.content_json, recovery, profile);
    if (!recipe) return { outcome: "blocked", reason: "assurance-recipe-unavailable" };
    this.throwIfCancelled(input);
    const draft = await this.dependencies.bindings.propose(context, {
      commandId: `${input.commandId}:binding:propose`,
      workId,
      planVersionId: plan.plan_version_id,
      profileId: profile.profileId,
      profileVersion: profile.version,
      authorHandle: "assurance",
      requiredCriteria: recipe.requiredCriteria,
      bindings: recipe.bindings,
    });
    this.throwIfCancelled(input);
    const resumedApprovalId = approvalId(input.resumeInput);
    try {
      this.throwIfCancelled(input);
      const binding = await this.dependencies.bindings.activate(context, {
        commandId: `${input.commandId}:binding:activate`,
        bindingVersionId: draft.bindingVersionId,
        expectedRevision: draft.revision,
        ...(resumedApprovalId === undefined ? {} : { approvalId: resumedApprovalId }),
      });
      this.throwIfCancelled(input);
      return { outcome: "ready", configuration: configurationFromBinding(binding) };
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) {
        return { outcome: "awaiting-approval", approvalId: error.approvalId };
      }
      if (error instanceof GovernanceDeniedError) {
        return { outcome: "blocked", reason: "assurance-binding-activation-denied" };
      }
      throw error;
    }
  }

  private async terminal(
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    run: AssuranceRun,
  ): Promise<CoreWorkStageResult> {
    this.throwIfCancelled(input);
    if (run.status === "passed") {
      const projection =
        run.projectedWorkRevision === undefined ? await this.projectVerdict(context, input, workId, run) : undefined;
      return {
        outcome: "advanced",
        data: {
          assuranceRunId: run.assuranceRunId,
          verdict: "passed",
          projectedWorkRevision: run.projectedWorkRevision ?? projection?.work.revision,
        },
      };
    }
    if (run.status === "failed" && run.projectedWorkRevision === undefined) {
      await this.projectVerdict(context, input, workId, run);
    }
    return { outcome: "blocked", reason: `assurance-${run.status}` };
  }

  private isTerminal(run: AssuranceRun): boolean {
    return ["passed", "failed", "blocked", "cancelled"].includes(run.status);
  }

  private async completeRun(
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    run: AssuranceRun,
    cancellationRequested = false,
  ): Promise<{ readonly run: AssuranceRun; readonly result: CoreWorkStageResult }> {
    if (this.isTerminal(run)) {
      return { run, result: await this.terminal(context, input, workId, run) };
    }
    const decided = await this.dependencies.assurance.decide(context, {
      commandId: `${input.commandId}:decide`,
      assuranceRunId: run.assuranceRunId,
      expectedVersion: run.version,
      ...(cancellationRequested ? { cancellationRequested: true } : {}),
    });
    this.throwIfCancelled(input);
    return { run: decided.run, result: await this.terminal(context, input, workId, decided.run) };
  }

  private async projectVerdict(
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    run: AssuranceRun,
  ): Promise<Awaited<ReturnType<AssuranceRunGateway["projectVerdict"]>>> {
    this.throwIfCancelled(input);
    const projection = await this.dependencies.assurance.projectVerdict(context, {
      commandId: `${input.commandId}:project`,
      workId,
      expectedRevision: run.targetWorkRevision,
      assuranceRunId: run.assuranceRunId,
    });
    this.throwIfCancelled(input);
    return projection;
  }

  private throwIfCancelled(input: CoreWorkStageInput): void {
    if (input.signal?.aborted) throw new Error(APPLICATION_RUN_CANCELLED);
  }

  private async cancelAndThrowIfCancelled(
    context: TenantContext,
    input: CoreWorkStageInput,
    verifier: ReadyVerifier,
  ): Promise<void> {
    if (!input.signal?.aborted) return;
    await this.cancelVerifierAndRun(
      context,
      input.commandId,
      APPLICATION_RUN_CANCELLED,
      `${input.commandId}:cancel:decide`,
      verifier.executionId,
      verifier.complete,
    );
    throw new Error(APPLICATION_RUN_CANCELLED);
  }

  private async cancelVerifierAndRun(
    context: TenantContext,
    stageCommandId: string,
    reason: string,
    decisionCommandId: string,
    verifierExecutionId?: string,
    drainVerifier?: ReadyVerifier["complete"],
  ): Promise<void> {
    const executionId =
      verifierExecutionId ??
      (await this.dependencies.runtimeExecutions.findExecutionIdByCommand(context, `${stageCommandId}:verifier`));
    let drained: Promise<unknown> | undefined;
    if (executionId) {
      const cancelling = this.dependencies.runner.cancel(context, executionId, reason);
      drained = drainVerifier?.();
      await cancelling;
    }
    if (drained) await drained;
    const run = await this.dependencies.assurance.findByStartCommand(context, `${stageCommandId}:start`);
    if (run && !["passed", "failed", "blocked", "cancelled"].includes(run.status)) {
      await this.dependencies.assurance.decide(context, {
        commandId: decisionCommandId,
        assuranceRunId: run.assuranceRunId,
        expectedVersion: run.version,
        cancellationRequested: true,
      });
    }
  }
}
