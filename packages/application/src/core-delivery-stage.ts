import type { MaterializedEvidencePrompt } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import { isSoftwareEngineeringTask } from "@massion/software-engineering";
import type { WorkService, WorkTask } from "@massion/work";
import type { WorkspaceService } from "@massion/workspace";

import type { CoreEvidenceStage } from "./core-evidence-stage.js";
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

function stageBaseline(value: unknown, tokenBudget: number): number {
  return Math.min(tokenBudget, promptTokens(value) + STAGE_OUTPUT_RESERVE_TOKENS);
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

export interface CoreSoftwareTaskPort {
  executeTask(
    context: TenantContext,
    input: {
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
    readonly outcome: "completed" | "awaiting-approval" | "blocked";
    readonly approvalId?: string;
    readonly reason?: string;
  }>;
  cancelTask(
    context: TenantContext,
    input: { readonly commandId: string; readonly workId: string; readonly task: WorkTask; readonly request: unknown },
  ): Promise<void>;
}

export class CoreDeliveryStage implements CoreWorkStageExecutor {
  public constructor(
    private readonly dependencies: {
      readonly works: Pick<
        WorkService,
        "listTasks" | "getWork" | "transition" | "assignTask" | "transitionTask" | "createArtifactVersion"
      >;
      readonly runner: Pick<AgentRunner, "execute" | "recover" | "cancel">;
      readonly runtimeExecutions: Pick<RuntimeExecutionStore, "findExecutionIdByCommand">;
      readonly software?: CoreSoftwareTaskPort;
      readonly workspaces?: Pick<WorkspaceService, "get">;
      readonly evidence?: Pick<CoreEvidenceStage, "materializeActive">;
    },
  ) {}

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    this.throwIfCancelled(input);
    if (!input.workId) throw new Error("Delivery stage에 Work ID가 없습니다");
    let initial = await this.dependencies.works.getWork(context, input.workId);
    this.throwIfCancelled(input);
    // 신뢰 게이트: workspace에 바인딩된 Work는 trusted 승인 전 도구 실행(delivery)을 차단합니다.
    // blocked는 재시도 가능 상태이므로 신뢰 결정 후 명시적 retry로 재개합니다.
    if (initial.workspace_id !== undefined && this.dependencies.workspaces) {
      const workspace = await this.dependencies.workspaces.get(context, initial.workspace_id);
      this.throwIfCancelled(input);
      if (workspace.trust !== "trusted") return { outcome: "blocked", reason: "workspace-untrusted" };
    }
    const tokenBudget = requestedTokenBudget(input.request);
    const preassignedTaskIds = new Set<string>();
    if (initial.status === "planned") {
      const tasks = await this.dependencies.works.listTasks(context, input.workId);
      this.throwIfCancelled(input);
      for (const task of tasks.filter((candidate) => candidate.status !== "cancelled")) {
        this.throwIfCancelled(input);
        const assigned = await this.dependencies.works.assignTask(context, {
          commandId: `${input.commandId}:task:${task.task_id}:assign`,
          workId: input.workId,
          expectedRevision: initial.revision,
          taskId: task.task_id,
          agentHandle: task.recommended_agent_handles?.[0] ?? "delivery-coordination",
        });
        this.throwIfCancelled(input);
        initial = assigned.work;
        preassignedTaskIds.add(task.task_id);
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
      const runtimeInput = {
        operation: "execute_work_task",
        title: task.title,
        objective: task.objective,
        acceptanceCriteria:
          typeof task.acceptance_criteria_json === "string"
            ? (JSON.parse(task.acceptance_criteria_json) as unknown)
            : [],
      };
      const baselineTokens = stageBaseline(
        softwareTask ? softwarePrompt(task, input.request) : runtimeInput,
        tokenBudget,
      );
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
        continue;
      }
      const root = `${input.commandId}:task:${task.task_id}`;
      let work = await this.dependencies.works.getWork(context, input.workId);
      this.throwIfCancelled(input);
      let active = task;
      if (task.status === "ready") {
        const agentHandle = task.recommended_agent_handles?.[0] ?? "delivery-coordination";
        if (!preassignedTaskIds.has(task.task_id)) {
          this.throwIfCancelled(input);
          const assigned = await this.dependencies.works.assignTask(context, {
            commandId: `${root}:assign`,
            workId: input.workId,
            expectedRevision: work.revision,
            taskId: task.task_id,
            agentHandle,
          });
          this.throwIfCancelled(input);
          work = assigned.work;
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
      const runtimeCommand = `${root}:runtime`;
      const executionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(context, runtimeCommand);
      this.throwIfCancelled(input);
      const execution = executionId
        ? await this.dependencies.runner.recover(context, executionId)
        : await this.dependencies.runner.execute(context, {
            commandId: runtimeCommand,
            workId: input.workId,
            taskId: task.task_id,
            agentHandle: task.recommended_agent_handles?.[0] ?? "delivery-coordination",
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
        creatorAgentHandle: task.recommended_agent_handles?.[0] ?? "delivery-coordination",
        creatorExecutionId: execution.executionId,
      });
      this.throwIfCancelled(input);
      artifacts.push(artifact.artifactVersion.artifact_version_id);
      this.throwIfCancelled(input);
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
