import type { MaterializedEvidencePrompt } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import { isSoftwareEngineeringTask } from "@massion/software-engineering";
import type { QueryExecutor } from "@massion/storage";
import type { WorkRecoveryBundle, WorkService, WorkTask } from "@massion/work";
import type { WorkspaceService } from "@massion/workspace";

import type { CoreEvidenceStage } from "./core-evidence-stage.js";
import type { DynamicStaffingCoordinator } from "./core-staffing.js";
import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

const APPLICATION_RUN_CANCELLED = "Application run cancelled";
const MAX_KNOWLEDGE_TOKENS = 24_000;
const STAGE_OUTPUT_RESERVE_TOKENS = 4_000;

function requestedTokenBudget(request: unknown): number {
  const value = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  const tokenBudget = (value as { tokenBudget?: unknown }).tokenBudget ?? 32_000;
  if (!Number.isSafeInteger(tokenBudget) || (tokenBudget as number) < 1_000 || (tokenBudget as number) > 1_000_000) {
    throw new Error("Core Work token budget이 유효하지 않습니다");
  }
  return tokenBudget as number;
}

function promptTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function stageBaseline(value: unknown): number {
  return promptTokens(value) + STAGE_OUTPUT_RESERVE_TOKENS;
}

function softwarePrompt(task: WorkTask, request: unknown): unknown {
  const softwareDelivery =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as { softwareDelivery?: unknown }).softwareDelivery
      : undefined;
  const allowedPaths =
    softwareDelivery && typeof softwareDelivery === "object" && !Array.isArray(softwareDelivery)
      ? (softwareDelivery as { allowedPaths?: unknown }).allowedPaths
      : [];
  return {
    objective: task.objective,
    acceptanceCriteria:
      typeof task.acceptance_criteria_json === "string" ? (JSON.parse(task.acceptance_criteria_json) as unknown) : [],
    allowedPaths,
    instruction: "testPatch와 implementationPatch를 분리해 제안하고 filesystem이나 process를 직접 실행하지 마세요.",
  };
}

function isSoftwareTask(task: WorkTask): boolean {
  return isSoftwareEngineeringTask({
    requiredCapabilities: task.required_capabilities ?? [],
    recommendedAgentHandles: task.recommended_agent_handles ?? [],
  });
}

function deliveryAgentHandle(task: WorkTask): string {
  return task.recommended_agent_handles?.find((handle) => handle !== "assurance") ?? "delivery-coordination";
}

function sourceRequest(request: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const input = request as Record<string, unknown>;
  const context = Object.fromEntries(
    ["text", "scopeIn", "scopeOut", "constraints", "assumptions", "unknowns", "decisions"].flatMap((key) =>
      input[key] === undefined ? [] : [[key, input[key]]],
    ),
  );
  return Object.keys(context).length === 0 ? undefined : context;
}

function dependencyOutputs(task: WorkTask, recovery: WorkRecoveryBundle): readonly Readonly<Record<string, unknown>>[] {
  const dependencyIds = new Set(task.dependency_ids ?? []);
  if (dependencyIds.size === 0) return [];
  const allowedVersionIds = new Set(recovery.work.artifact_version_ids);
  const versions = new Map(
    recovery.artifactVersions.map((version) => [version.artifact_version_id, version.content_json] as const),
  );
  return recovery.messages
    .filter(
      (message) =>
        message.task_id !== undefined &&
        dependencyIds.has(message.task_id) &&
        message.artifact_version_id !== undefined &&
        allowedVersionIds.has(message.artifact_version_id),
    )
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((message) => {
      const artifactVersionId = message.artifact_version_id;
      const contentJson = artifactVersionId === undefined ? undefined : versions.get(artifactVersionId);
      if (artifactVersionId === undefined || contentJson === undefined || message.task_id === undefined) return [];
      return [
        {
          taskId: message.task_id,
          artifactVersionId,
          content: JSON.parse(contentJson) as unknown,
        },
      ];
    });
}

export interface CoreSoftwareTaskPort {
  inspectTask?(
    context: TenantContext,
    input: { readonly runId: string; readonly workId: string; readonly task: WorkTask },
  ): Promise<{ readonly outcome: "failed" | "cancelled"; readonly reason: string } | undefined>;
  executeTask(
    context: TenantContext,
    input: {
      readonly runId: string;
      readonly leaseGeneration?: number;
      readonly commandId: string;
      readonly correlationId: string;
      readonly workId: string;
      readonly task: WorkTask;
      readonly request: unknown;
      readonly knowledgeSources?: readonly MaterializedEvidencePrompt[];
      readonly resumeInput?: unknown;
      readonly signal?: AbortSignal;
    },
  ): Promise<{
    readonly outcome: "completed" | "awaiting-approval" | "blocked" | "failed" | "cancelled";
    readonly approvalId?: string;
    readonly reason?: string;
  }>;
  cancelTask(
    context: TenantContext,
    input: {
      readonly runId: string;
      readonly leaseGeneration?: number;
      readonly commandId: string;
      readonly workId: string;
      readonly task: WorkTask;
      readonly request: unknown;
    },
  ): Promise<void>;
}

export class CoreDeliveryStage implements CoreWorkStageExecutor {
  public constructor(
    private readonly dependencies: {
      readonly works: Pick<
        WorkService,
        | "listTasks"
        | "listAssignments"
        | "getWork"
        | "transition"
        | "assignTask"
        | "transitionTask"
        | "createArtifactVersion"
        | "recoverWork"
      >;
      readonly runner: Pick<AgentRunner, "execute" | "recover" | "cancel">;
      readonly runtimeExecutions: Pick<RuntimeExecutionStore, "findExecutionIdByCommand">;
      readonly software?: CoreSoftwareTaskPort;
      readonly staffing: Pick<DynamicStaffingCoordinator, "prepare">;
      readonly workspaces?: Pick<WorkspaceService, "get">;
      readonly evidence?: Pick<CoreEvidenceStage, "materializeActive">;
    },
  ) {}

  public async convergeFailure(
    context: TenantContext,
    result: Extract<CoreWorkStageResult, { readonly outcome: "failed" }>,
    executor: QueryExecutor,
  ): Promise<void> {
    const failure = result.failure;
    if (!failure || !result.workId) return;
    await this.dependencies.works.transitionTask(
      context,
      {
        commandId: failure.commandId,
        workId: result.workId,
        expectedRevision: failure.expectedWorkRevision,
        taskId: failure.taskId,
        expectedTaskRevision: failure.expectedTaskRevision,
        target: "failed",
      },
      executor,
    );
  }

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    this.throwIfCancelled(input);
    if (!input.workId) throw new Error("Delivery stage에 Work ID가 없습니다");
    let initial = await this.dependencies.works.getWork(context, input.workId);
    this.throwIfCancelled(input);
    if (initial.status === "failed" || initial.status === "cancelled") {
      return {
        outcome: initial.status,
        reason: `delivery-work-${initial.status}`,
        workId: input.workId,
      };
    }
    if (initial.status === "completed") {
      return { outcome: "completed", workId: input.workId, data: { recoveredFromWork: "completed" } };
    }
    if (initial.status === "verifying") {
      return { outcome: "advanced", workId: input.workId, data: { artifactVersionIds: [] } };
    }
    if (this.dependencies.software?.inspectTask) {
      const tasks = await this.dependencies.works.listTasks(context, input.workId);
      this.throwIfCancelled(input);
      for (const task of tasks.filter(isSoftwareTask)) {
        const terminal = await this.dependencies.software.inspectTask(context, {
          runId: input.runId,
          workId: input.workId,
          task,
        });
        this.throwIfCancelled(input);
        if (!terminal) continue;
        return terminal.outcome === "failed"
          ? {
              ...terminal,
              workId: input.workId,
              failure: {
                taskId: task.task_id,
                expectedWorkRevision: initial.revision,
                expectedTaskRevision: task.revision,
                commandId: `${input.runId}:delivery:task:${task.task_id}:failed`,
              },
            }
          : { ...terminal, workId: input.workId };
      }
    }
    // 신뢰 게이트: workspace에 바인딩된 Work는 trusted 승인 전 도구 실행(delivery)을 차단합니다.
    // blocked는 재시도 가능 상태이므로 신뢰 결정 후 명시적 retry로 재개합니다.
    if (initial.workspace_id !== undefined && this.dependencies.workspaces) {
      const workspace = await this.dependencies.workspaces.get(context, initial.workspace_id);
      this.throwIfCancelled(input);
      if (workspace.trust !== "trusted") return { outcome: "blocked", reason: "workspace-untrusted" };
    }
    const tokenBudget = requestedTokenBudget(input.request);
    if (initial.status === "planned") {
      const approvalId =
        input.resumeInput &&
        typeof input.resumeInput === "object" &&
        !Array.isArray(input.resumeInput) &&
        typeof (input.resumeInput as { readonly approvalId?: unknown }).approvalId === "string"
          ? (input.resumeInput as { readonly approvalId: string }).approvalId
          : undefined;
      const staffing = await this.dependencies.staffing.prepare(context, {
        commandId: `${input.commandId}:staffing`,
        workId: input.workId,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      this.throwIfCancelled(input);
      if (staffing.outcome === "awaiting-approval") return staffing;
      if (staffing.outcome === "blocked") return { ...staffing, workId: input.workId };
      initial = await this.dependencies.works.getWork(context, input.workId);
      this.throwIfCancelled(input);
    }
    if (initial.status === "planned") {
      const tasks = await this.dependencies.works.listTasks(context, input.workId);
      this.throwIfCancelled(input);
      for (const task of tasks.filter((candidate) => candidate.status !== "cancelled")) {
        this.throwIfCancelled(input);
        const existing = (await this.dependencies.works.listAssignments(context, input.workId)).find(
          (assignment) => assignment.task_id === task.task_id && assignment.status === "assigned",
        );
        this.throwIfCancelled(input);
        if (existing) continue;
        const assigned = await this.dependencies.works.assignTask(context, {
          commandId: `${input.commandId}:task:${task.task_id}:assign`,
          workId: input.workId,
          expectedRevision: initial.revision,
          taskId: task.task_id,
          agentHandle: deliveryAgentHandle(task),
        });
        this.throwIfCancelled(input);
        initial = assigned.work;
      }
      this.throwIfCancelled(input);
      initial = (
        await this.dependencies.works.transition(context, {
          commandId: `${input.commandId}:work-ready`,
          workId: input.workId,
          expectedRevision: initial.revision,
          target: "ready",
        })
      ).work;
      this.throwIfCancelled(input);
    }
    if (initial.status === "waiting_approval" && input.resumeInput === undefined) {
      return { outcome: "blocked", reason: "approval-resume-required" };
    }
    if (initial.status === "ready" || (initial.status === "waiting_approval" && input.resumeInput !== undefined)) {
      this.throwIfCancelled(input);
      initial = (
        await this.dependencies.works.transition(context, {
          commandId: `${input.commandId}:work-running`,
          workId: input.workId,
          expectedRevision: initial.revision,
          target: "running",
        })
      ).work;
      this.throwIfCancelled(input);
    }
    if (initial.status !== "running") {
      return { outcome: "blocked", reason: `delivery-work-${initial.status}` };
    }
    const artifacts: string[] = [];
    for (let iterations = 0; iterations < 1000; iterations += 1) {
      const tasks = await this.dependencies.works.listTasks(context, input.workId);
      this.throwIfCancelled(input);
      if (tasks.every((task) => task.status === "completed" || task.status === "cancelled")) {
        const current = await this.dependencies.works.getWork(context, input.workId);
        this.throwIfCancelled(input);
        if (current.status === "running") {
          this.throwIfCancelled(input);
          await this.dependencies.works.transition(context, {
            commandId: `${input.commandId}:work-verifying`,
            workId: input.workId,
            expectedRevision: current.revision,
            target: "verifying",
          });
          this.throwIfCancelled(input);
        }
        return { outcome: "advanced", data: { artifactVersionIds: artifacts } };
      }
      const running = tasks.find((task) => task.status === "running");
      const ready = tasks.find((task) => task.status === "ready");
      const task = running ?? ready;
      if (!task)
        return {
          outcome: "blocked",
          reason: tasks.some((item) => item.status === "failed")
            ? "delivery-task-failed"
            : "delivery-dependencies-blocked",
        };
      const softwareTask = isSoftwareTask(task);
      if (softwareTask && !this.dependencies.software) {
        return { outcome: "blocked", reason: "software-delivery-not-configured" };
      }
      const recovery = softwareTask ? undefined : await this.dependencies.works.recoverWork(context, input.workId);
      const requestContext = sourceRequest(recovery?.request ?? input.request);
      const priorOutputs = recovery ? dependencyOutputs(task, recovery) : [];
      this.throwIfCancelled(input);
      const runtimeInput = {
        operation: "execute_work_task",
        title: task.title,
        objective: task.objective,
        acceptanceCriteria:
          typeof task.acceptance_criteria_json === "string"
            ? (JSON.parse(task.acceptance_criteria_json) as unknown)
            : [],
        outputContract:
          "최종 응답 전체는 Task output ArtifactVersion으로 자동 저장되고 후속 Assurance가 acceptance evidence를 검증합니다. Artifact 생성·제출 도구를 찾거나 호출하지 말고 acceptance criteria를 충족하는 최종 결과 본문만 반환하세요.",
        ...(requestContext === undefined ? {} : { sourceRequest: requestContext }),
        ...(priorOutputs.length === 0 ? {} : { dependencyOutputs: priorOutputs }),
      };
      const baselineTokens = stageBaseline(softwareTask ? softwarePrompt(task, input.request) : runtimeInput);
      if (baselineTokens > tokenBudget) return { outcome: "blocked", reason: "evidence-invalid" };
      let knowledgeSources: readonly MaterializedEvidencePrompt[] | undefined;
      if (initial.workspace_id !== undefined) {
        if (!this.dependencies.evidence) return { outcome: "blocked", reason: "evidence-invalid" };
        const maxKnowledgeTokens = Math.min(MAX_KNOWLEDGE_TOKENS, tokenBudget - baselineTokens);
        if (maxKnowledgeTokens < 1) return { outcome: "blocked", reason: "evidence-invalid" };
        try {
          const materials = await this.dependencies.evidence.materializeActive(
            context,
            input.workId,
            maxKnowledgeTokens,
          );
          if (materials.length > 0) knowledgeSources = materials;
        } catch {
          this.throwIfCancelled(input);
          return { outcome: "blocked", reason: "evidence-invalid" };
        }
        this.throwIfCancelled(input);
      }
      if (softwareTask) {
        this.throwIfCancelled(input);
        // ponytail: async 대기 후 속성이 변경될 수 있어 지역 변수로 좁힘 — 라인 187 가드와 동일 조건
        const software = this.dependencies.software;
        if (!software) return { outcome: "blocked", reason: "software-delivery-not-configured" };
        const result = await software.executeTask(context, {
          runId: input.runId,
          ...(input.leaseGeneration === undefined ? {} : { leaseGeneration: input.leaseGeneration }),
          commandId: `${input.commandId}:task:${task.task_id}`,
          correlationId: input.correlationId,
          workId: input.workId,
          task,
          request: input.request,
          ...(knowledgeSources === undefined ? {} : { knowledgeSources }),
          ...(input.resumeInput === undefined ? {} : { resumeInput: input.resumeInput }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        this.throwIfCancelled(input);
        if (result.outcome === "awaiting-approval" && result.approvalId) {
          const current = await this.dependencies.works.getWork(context, input.workId);
          this.throwIfCancelled(input);
          if (current.status === "running") {
            this.throwIfCancelled(input);
            await this.dependencies.works.transition(context, {
              commandId: `${input.commandId}:work-awaiting-approval`,
              workId: input.workId,
              expectedRevision: current.revision,
              target: "waiting_approval",
            });
            this.throwIfCancelled(input);
          }
          return { outcome: "awaiting-approval", approvalId: result.approvalId };
        }
        if (result.outcome === "blocked")
          return { outcome: "blocked", reason: result.reason ?? "software-delivery-blocked" };
        if (result.outcome === "failed") {
          const [current, tasks] = await Promise.all([
            this.dependencies.works.getWork(context, input.workId),
            this.dependencies.works.listTasks(context, input.workId),
          ]);
          this.throwIfCancelled(input);
          const active = tasks.find((candidate) => candidate.task_id === task.task_id);
          if (!active) throw new Error("실패한 Software Delivery의 Task를 찾을 수 없습니다");
          return {
            outcome: "failed",
            reason: result.reason ?? "software-delivery-failed",
            workId: input.workId,
            ...(current.status === "failed" && active.status === "failed"
              ? {}
              : {
                  failure: {
                    taskId: active.task_id,
                    expectedWorkRevision: current.revision,
                    expectedTaskRevision: active.revision,
                    commandId: `${input.runId}:delivery:task:${active.task_id}:failed`,
                  },
                }),
          };
        }
        if (result.outcome === "cancelled") {
          return {
            outcome: "cancelled",
            reason: result.reason ?? "software-delivery-cancelled",
            workId: input.workId,
          };
        }
        continue;
      }
      const root = `${input.commandId}:task:${task.task_id}`;
      let work = await this.dependencies.works.getWork(context, input.workId);
      this.throwIfCancelled(input);
      let active = task;
      let assignment = (await this.dependencies.works.listAssignments(context, input.workId)).find(
        (candidate) => candidate.task_id === task.task_id && candidate.status === "assigned",
      );
      this.throwIfCancelled(input);
      if (task.status === "ready") {
        if (!assignment) {
          this.throwIfCancelled(input);
          const assigned = await this.dependencies.works.assignTask(context, {
            commandId: `${root}:assign`,
            workId: input.workId,
            expectedRevision: work.revision,
            taskId: task.task_id,
            agentHandle: deliveryAgentHandle(task),
          });
          this.throwIfCancelled(input);
          work = assigned.work;
          assignment = assigned.assignment;
        }
        this.throwIfCancelled(input);
        const started = await this.dependencies.works.transitionTask(context, {
          commandId: `${root}:running`,
          workId: input.workId,
          expectedRevision: work.revision,
          taskId: task.task_id,
          expectedTaskRevision: task.revision,
          target: "running",
        });
        this.throwIfCancelled(input);
        active = started.task;
      }
      if (!assignment) return { outcome: "blocked", reason: "delivery-assignment-missing" };
      const agentHandle = assignment.agent_handle;
      const runtimeCommand = `${root}:runtime`;
      const executionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(context, runtimeCommand);
      this.throwIfCancelled(input);
      const execution = executionId
        ? await this.dependencies.runner.recover(context, executionId)
        : await this.dependencies.runner.execute(context, {
            commandId: runtimeCommand,
            workId: input.workId,
            taskId: task.task_id,
            agentHandle,
            modelRoute: "delivery-quality",
            correlationId: input.correlationId,
            estimatedTokens: baselineTokens + (knowledgeSources?.[0]?.estimatedTokens ?? 0),
            estimatedCostMicros: 0,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            input: {
              ...runtimeInput,
              ...(knowledgeSources === undefined ? {} : { knowledgeSources }),
            },
          });
      this.throwIfCancelled(input);
      if (execution.status === "blocked_model_unavailable") return { outcome: "blocked", reason: "model-unavailable" };
      if (execution.status !== "succeeded") return { outcome: "blocked", reason: `delivery-${execution.status}` };
      work = await this.dependencies.works.getWork(context, input.workId);
      this.throwIfCancelled(input);
      const artifact = await this.dependencies.works.createArtifactVersion(context, {
        commandId: `${root}:artifact`,
        workId: input.workId,
        expectedRevision: work.revision,
        kind: "task-output",
        name: `task-${task.task_id}`,
        mediaType: "application/json",
        content: execution.output ?? null,
        creatorAgentHandle: agentHandle,
        creatorExecutionId: execution.executionId,
        creatorTaskId: task.task_id,
      });
      this.throwIfCancelled(input);
      artifacts.push(artifact.artifactVersion.artifact_version_id);
      await this.dependencies.works.transitionTask(context, {
        commandId: `${root}:completed`,
        workId: input.workId,
        expectedRevision: artifact.work.revision,
        taskId: task.task_id,
        expectedTaskRevision: active.revision,
        target: "completed",
      });
      this.throwIfCancelled(input);
    }
    return { outcome: "blocked", reason: "delivery-iteration-limit" };
  }

  public async cancel(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void> {
    if (!input.workId) return;
    const tasks = await this.dependencies.works.listTasks(context, input.workId);
    for (const task of tasks.filter(
      (candidate) => candidate.status === "running" || (candidate.status === "ready" && isSoftwareTask(candidate)),
    )) {
      const commandId = `${input.commandId.replace(/:cancel$/u, "")}:task:${task.task_id}`;
      if (isSoftwareTask(task)) {
        if (!this.dependencies.software) continue;
        await this.dependencies.software.cancelTask(context, {
          runId: input.runId,
          ...(input.leaseGeneration === undefined ? {} : { leaseGeneration: input.leaseGeneration }),
          commandId,
          workId: input.workId,
          task,
          request: input.request,
        });
        continue;
      }
      const executionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(
        context,
        `${commandId}:runtime`,
      );
      if (executionId) await this.dependencies.runner.cancel(context, executionId, "Application run cancelled");
    }
  }

  private throwIfCancelled(input: CoreWorkStageInput): void {
    if (input.signal?.aborted) throw new Error(APPLICATION_RUN_CANCELLED);
  }
}
