import {
  canonicalAssuranceBindings,
  checksumCriterionCoverage,
  compileAssuranceCriteria,
  parseAssuranceVerifierDecision,
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
import {
  executionEvidenceIsSafe,
  type AgentRunner,
  type ExecutionEvidenceItem,
  type RuntimeExecutionStore,
} from "@massion/runtime";
import { serializeSurrealDateTime } from "@massion/storage";
import type { WorkRecoveryBundle, WorkService } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";
import { ASSURANCE_VERIFIER_REJECTED } from "./blocked-detail.js";

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

export const AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const APPLICATION_RUN_CANCELLED = "Application run cancelled";
const MAX_VERIFICATION_MATERIAL_TOKENS = 28_000;
const TASK_EVIDENCE_ARTIFACT_KINDS = new Set(["task-output", "code-change"]);
const UTC_ISO_INSTANT = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const VERIFICATION_OUTPUT_RESERVE_TOKENS = 4_000;

function approvalId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { readonly approvalId?: unknown }).approvalId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

type VerifierDecision = { readonly accepted: true } | { readonly accepted: false; readonly blockedDetail?: string };

function verifierDecision(output: unknown, snapshotHash: string): VerifierDecision {
  const decision = parseAssuranceVerifierDecision(output, snapshotHash);
  if (!decision) return { accepted: false };
  return decision.verified ? { accepted: true } : { accepted: false, blockedDetail: decision.reason };
}

function promptTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function verificationRequest(recovered: unknown, fallback: unknown): Readonly<Record<string, unknown>> {
  const recoveredText = record(recovered)?.text;
  const fallbackText = record(fallback)?.text;
  const text = typeof recoveredText === "string" ? recoveredText : fallbackText;
  return typeof text === "string" && text.trim() ? { text } : {};
}

function artifactInstant(value: unknown): { readonly createdAt: string; readonly sortKey: bigint } {
  let serialized: unknown = typeof value === "string" ? value : undefined;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Assurance ArtifactVersion createdAt이 유효하지 않습니다");
    serialized = value.toISOString();
  } else if (value && typeof value === "object") {
    serialized = serializeSurrealDateTime(value);
  }
  const createdAt = typeof serialized === "string" ? serialized : undefined;
  const match = createdAt ? UTC_ISO_INSTANT.exec(createdAt) : null;
  if (match && createdAt) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      instant.getUTCFullYear() === year &&
      instant.getUTCMonth() === month - 1 &&
      instant.getUTCDate() === day &&
      instant.getUTCHours() === hour &&
      instant.getUTCMinutes() === minute &&
      instant.getUTCSeconds() === second
    ) {
      const epochSeconds = BigInt(Math.trunc(instant.getTime() / 1_000));
      const nanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
      return { createdAt, sortKey: epochSeconds * 1_000_000_000n + nanoseconds };
    }
  }
  throw new Error("Assurance ArtifactVersion createdAt이 유효하지 않습니다");
}

type ObservationPhase =
  | "before-final-workspace-change"
  | "workspace-change"
  | "after-final-workspace-change"
  | "final-observation"
  | "indeterminate-truncated-observation";

type ObservationTimelineItem = {
  readonly observationSequence: number;
  readonly phase: ObservationPhase;
  readonly providerItemId: string;
  readonly artifactVersionId: string;
};

type ProjectedArtifactVersion = {
  readonly artifactVersionId: string;
  readonly artifactKind: string;
  readonly createdAt: string;
  readonly creatorExecutionId?: string;
  readonly taskId?: string;
  readonly content: unknown;
  readonly observationTimeline?: readonly ObservationTimelineItem[];
};

function annotateExecutionObservations(
  artifactVersions: readonly ProjectedArtifactVersion[],
): readonly ProjectedArtifactVersion[] {
  const receipts: {
    readonly artifactIndex: number;
    readonly artifactVersionId: string;
    readonly items: readonly ExecutionEvidenceItem[];
    readonly truncated: boolean;
  }[] = [];
  for (const [artifactIndex, artifact] of artifactVersions.entries()) {
    if (artifact.artifactKind !== "execution-evidence") continue;
    if (!executionEvidenceIsSafe(artifact.content)) {
      throw new Error("Assurance execution-evidence receipt가 유효하지 않습니다");
    }
    receipts.push({
      artifactIndex,
      artifactVersionId: artifact.artifactVersionId,
      items: artifact.content.items,
      truncated: artifact.content.truncated === true,
    });
  }

  const observations = receipts.flatMap((receipt) =>
    receipt.items.map((item, itemIndex) => ({ receipt, item, itemIndex })),
  );
  const lastFileObservation = observations.findLastIndex(({ item }) => item.kind === "file");
  const timelineByArtifact = new Map<number, ObservationTimelineItem[]>();
  for (const [observationIndex, observation] of observations.entries()) {
    const localLastFile = observation.receipt.items.findLastIndex((item) => item.kind === "file");
    const phase: ObservationPhase =
      observation.receipt.truncated && (localLastFile < 0 || observation.itemIndex > localLastFile)
        ? "indeterminate-truncated-observation"
        : lastFileObservation < 0
          ? "final-observation"
          : observationIndex < lastFileObservation
            ? "before-final-workspace-change"
            : observationIndex === lastFileObservation
              ? "workspace-change"
              : "after-final-workspace-change";
    const timeline = timelineByArtifact.get(observation.receipt.artifactIndex) ?? [];
    timeline.push({
      observationSequence: observationIndex + 1,
      phase,
      providerItemId: observation.item.providerItemId,
      artifactVersionId: observation.receipt.artifactVersionId,
    });
    timelineByArtifact.set(observation.receipt.artifactIndex, timeline);
  }

  return artifactVersions.map((artifact, artifactIndex) => {
    const observationTimeline = timelineByArtifact.get(artifactIndex);
    return observationTimeline ? { ...artifact, observationTimeline } : artifact;
  });
}

function verificationMaterial(
  recovery: WorkRecoveryBundle,
  planVersionId: string,
  planContentJson: string | undefined,
  fallbackRequest: unknown,
): Readonly<Record<string, unknown>> {
  const candidate = recovery as Partial<
    Pick<WorkRecoveryBundle, "request" | "work" | "tasks" | "messages" | "artifacts" | "artifactVersions">
  >;
  const currentWorkId = candidate.work?.work_id;
  const activeTasks = (candidate.tasks ?? []).filter(
    (task) =>
      typeof currentWorkId === "string" && task.plan_version_id === planVersionId && task.work_id === currentWorkId,
  );
  const taskIds = new Set(activeTasks.flatMap((task) => (typeof task.task_id === "string" ? [task.task_id] : [])));
  const tasks = activeTasks.map((task) => ({
    taskId: task.task_id,
    taskKey: task.task_key,
    title: task.title,
    objective: task.objective,
    acceptanceCriteria:
      typeof task.acceptance_criteria_json === "string" ? parseJson(task.acceptance_criteria_json) : [],
    dependencyTaskIds: Array.isArray(task.dependency_ids) ? task.dependency_ids : [],
    requiredCapabilities: Array.isArray(task.required_capabilities) ? task.required_capabilities : [],
    status: task.status,
  }));
  const messageByArtifact = new Map(
    (candidate.messages ?? []).flatMap((message) =>
      typeof message.artifact_version_id === "string" &&
      typeof message.task_id === "string" &&
      typeof currentWorkId === "string" &&
      message.work_id === currentWorkId &&
      message.message_type === "evidence" &&
      (candidate.artifacts ?? []).some(
        (artifact) =>
          TASK_EVIDENCE_ARTIFACT_KINDS.has(artifact.kind) &&
          artifact.work_id === currentWorkId &&
          artifact.artifact_id ===
            (candidate.artifactVersions ?? []).find(
              (version) =>
                version.artifact_version_id === message.artifact_version_id && version.work_id === currentWorkId,
            )?.artifact_id,
      ) &&
      taskIds.has(message.task_id)
        ? [[message.artifact_version_id, message.task_id] as const]
        : [],
    ),
  );
  const artifactKindById = new Map(
    (candidate.artifacts ?? []).flatMap((artifact) =>
      typeof artifact.artifact_id === "string" && typeof artifact.kind === "string"
        ? [[artifact.artifact_id, artifact.kind] as const]
        : [],
    ),
  );
  const versionById = new Map(
    (candidate.artifactVersions ?? []).flatMap((version) =>
      typeof version.artifact_version_id === "string" ? [[version.artifact_version_id, version] as const] : [],
    ),
  );
  const taskByExecution = new Map(
    (candidate.messages ?? []).flatMap((message) =>
      typeof message.execution_id === "string" &&
      typeof message.task_id === "string" &&
      typeof message.artifact_version_id === "string" &&
      typeof currentWorkId === "string" &&
      message.work_id === currentWorkId &&
      message.message_type === "evidence" &&
      taskIds.has(message.task_id) &&
      TASK_EVIDENCE_ARTIFACT_KINDS.has(
        artifactKindById.get(versionById.get(message.artifact_version_id)?.artifact_id ?? "") ?? "",
      )
        ? [[message.execution_id, message.task_id] as const]
        : [],
    ),
  );
  const allowed = candidate.work?.artifact_version_ids ? new Set(candidate.work.artifact_version_ids) : undefined;
  const artifactVersions = annotateExecutionObservations(
    (candidate.artifactVersions ?? [])
      .filter(
        (version) =>
          typeof version.artifact_version_id === "string" &&
          typeof currentWorkId === "string" &&
          version.work_id === currentWorkId &&
          (messageByArtifact.has(version.artifact_version_id) ||
            (typeof version.creator_execution_id === "string" &&
              taskByExecution.has(version.creator_execution_id) &&
              artifactKindById.get(version.artifact_id) === "execution-evidence" &&
              (candidate.artifacts ?? []).some(
                (artifact) => artifact.artifact_id === version.artifact_id && artifact.work_id === currentWorkId,
              ))) &&
          (allowed === undefined || allowed.has(version.artifact_version_id)),
      )
      .map((version) => {
        const instant = artifactInstant(version.created_at);
        const artifactKind = artifactKindById.get(version.artifact_id);
        if (!artifactKind) throw new Error("Assurance ArtifactVersion kind가 유효하지 않습니다");
        if (typeof version.content_json !== "string") {
          throw new Error("Assurance ArtifactVersion content가 유효하지 않습니다");
        }
        const content = parseJson(version.content_json);
        if (artifactKind === "execution-evidence" && !executionEvidenceIsSafe(content)) {
          throw new Error("Assurance execution-evidence receipt가 유효하지 않습니다");
        }
        const taskId =
          messageByArtifact.get(version.artifact_version_id) ??
          (typeof version.creator_execution_id === "string"
            ? taskByExecution.get(version.creator_execution_id)
            : undefined);
        return {
          artifactVersionId: version.artifact_version_id,
          artifactKind,
          createdAt: instant.createdAt,
          sortKey: instant.sortKey,
          ...(typeof version.creator_execution_id === "string"
            ? { creatorExecutionId: version.creator_execution_id }
            : {}),
          ...(taskId ? { taskId } : {}),
          content,
        };
      })
      .sort(
        (left, right) =>
          (left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0) ||
          left.artifactVersionId.localeCompare(right.artifactVersionId),
      )
      .map(({ sortKey: _sortKey, ...version }) => version),
  );
  return {
    request: verificationRequest(candidate.request, fallbackRequest),
    ...(planContentJson === undefined ? {} : { plan: parseJson(planContentJson) }),
    tasks,
    artifactVersions,
  };
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
    const material = verificationMaterial(recovery, plan.plan_version_id, plan.content_json, input.request);
    const materialTokens = promptTokens(material);
    if (materialTokens > MAX_VERIFICATION_MATERIAL_TOKENS) {
      return { outcome: "blocked", reason: "assurance-verification-material-too-large" };
    }
    const verifierInput = {
      commandId: verifierCommandId,
      workId,
      agentHandle: "assurance",
      modelRoute: "assurance-independent",
      correlationId: input.correlationId,
      estimatedTokens: Math.max(16_000, materialTokens + VERIFICATION_OUTPUT_RESERVE_TOKENS),
      estimatedCostMicros: 0,
      input: {
        operation: "verify_work",
        snapshotHash: prepared.snapshot.hash,
        verificationContract:
          "요청·계획·완료 기준과 각 산출물 본문을 대조하세요. execution-evidence의 before-final-workspace-change 관측은 이후 workspace change 이전 상태이므로 최종 상태의 모순으로 사용하지 말고, indeterminate-truncated-observation은 최종 상태로 간주하지 않으며, 후속 workspace change·산출물·after-final-workspace-change 검사 결과를 우선하세요. 모순, 누락 또는 검증 불가능한 주장이 하나라도 있으면 verified=false로 판정하세요. 정확히 { snapshotHash, verified, reason } JSON 객체만 반환하고 snapshotHash는 입력값을 그대로 사용하세요.",
        material,
      },
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
      const decision = verifierDecision(completedVerifier.output, prepared.snapshot.hash);
      if (!decision.accepted) {
        const current = await this.dependencies.assurance.get(context, started.run.assuranceRunId);
        await this.cancelAndThrowIfCancelled(context, input, verifier);
        const completed = await this.completeRun(context, input, workId, current);
        if (completed.result.outcome !== "blocked") {
          throw new Error("Assurance verifier 거부와 terminal 판정이 일치하지 않습니다");
        }
        return {
          ...completed.result,
          reason: ASSURANCE_VERIFIER_REJECTED,
          ...(decision.blockedDetail === undefined ? {} : { blockedDetail: decision.blockedDetail }),
        };
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
    const matchingActive =
      active && active.profileId === profile.profileId && active.profileVersion === profile.version;
    const managedActive =
      matchingActive &&
      active.authorHandle === "assurance" &&
      active.bindings.some((binding) => binding.bindingKey.startsWith("auto-"));
    if (matchingActive && !managedActive) {
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
    if (
      managedActive &&
      recipe &&
      active.criteriaChecksum === checksumCriterionCoverage(recipe.requiredCriteria) &&
      canonicalAssuranceBindings(active.bindings) === canonicalAssuranceBindings(recipe.bindings)
    ) {
      return { outcome: "ready", configuration: configurationFromBinding(active) };
    }
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
