import type { TenantContext } from "@massion/identity";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import type { WorkService, WorkTask } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

export interface CoreSoftwareTaskPort {
  executeTask(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly correlationId: string;
      readonly workId: string;
      readonly task: WorkTask;
    },
  ): Promise<{
    readonly outcome: "completed" | "awaiting-approval" | "blocked";
    readonly approvalId?: string;
    readonly reason?: string;
  }>;
  cancelTask?(
    context: TenantContext,
    input: { readonly commandId: string; readonly workId: string; readonly task: WorkTask },
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
    },
  ) {}

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    if (!input.workId) throw new Error("Delivery stage에 Work ID가 없습니다");
    let initial = await this.dependencies.works.getWork(context, input.workId);
    if (initial.status === "planned") {
      initial = (
        await this.dependencies.works.transition(context, {
          commandId: `${input.commandId}:work-ready`,
          workId: input.workId,
          expectedRevision: initial.revision,
          target: "ready",
        })
      ).work;
    }
    if (initial.status === "waiting_approval" && input.resumeInput === undefined) {
      return { outcome: "blocked", reason: "approval-resume-required" };
    }
    if (initial.status === "ready" || (initial.status === "waiting_approval" && input.resumeInput !== undefined)) {
      initial = (
        await this.dependencies.works.transition(context, {
          commandId: `${input.commandId}:work-running`,
          workId: input.workId,
          expectedRevision: initial.revision,
          target: "running",
        })
      ).work;
    }
    if (initial.status !== "running") {
      return { outcome: "blocked", reason: `delivery-work-${initial.status}` };
    }
    const artifacts: string[] = [];
    for (let iterations = 0; iterations < 1000; iterations += 1) {
      const tasks = await this.dependencies.works.listTasks(context, input.workId);
      if (tasks.every((task) => task.status === "completed" || task.status === "cancelled")) {
        const current = await this.dependencies.works.getWork(context, input.workId);
        if (current.status === "running") {
          await this.dependencies.works.transition(context, {
            commandId: `${input.commandId}:work-verifying`,
            workId: input.workId,
            expectedRevision: current.revision,
            target: "verifying",
          });
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
      if (
        task.required_capabilities?.some((capability) =>
          ["software-development", "software-engineering"].includes(capability),
        )
      ) {
        if (!this.dependencies.software) return { outcome: "blocked", reason: "software-delivery-not-configured" };
        const result = await this.dependencies.software.executeTask(context, {
          commandId: `${input.commandId}:task:${task.task_id}`,
          correlationId: input.correlationId,
          workId: input.workId,
          task,
        });
        if (result.outcome === "awaiting-approval" && result.approvalId) {
          const current = await this.dependencies.works.getWork(context, input.workId);
          if (current.status === "running") {
            await this.dependencies.works.transition(context, {
              commandId: `${input.commandId}:work-awaiting-approval`,
              workId: input.workId,
              expectedRevision: current.revision,
              target: "waiting_approval",
            });
          }
          return { outcome: "awaiting-approval", approvalId: result.approvalId };
        }
        if (result.outcome === "blocked")
          return { outcome: "blocked", reason: result.reason ?? "software-delivery-blocked" };
        continue;
      }
      const root = `${input.commandId}:task:${task.task_id}`;
      let work = await this.dependencies.works.getWork(context, input.workId);
      let active = task;
      if (task.status === "ready") {
        const agentHandle = task.recommended_agent_handles?.[0] ?? "delivery-coordination";
        const assigned = await this.dependencies.works.assignTask(context, {
          commandId: `${root}:assign`,
          workId: input.workId,
          expectedRevision: work.revision,
          taskId: task.task_id,
          agentHandle,
        });
        work = assigned.work;
        const started = await this.dependencies.works.transitionTask(context, {
          commandId: `${root}:running`,
          workId: input.workId,
          expectedRevision: work.revision,
          taskId: task.task_id,
          expectedTaskRevision: task.revision,
          target: "running",
        });
        work = started.work;
        active = started.task;
      }
      const runtimeCommand = `${root}:runtime`;
      const executionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(context, runtimeCommand);
      const execution = executionId
        ? await this.dependencies.runner.recover(context, executionId)
        : await this.dependencies.runner.execute(context, {
            commandId: runtimeCommand,
            workId: input.workId,
            taskId: task.task_id,
            agentHandle: task.recommended_agent_handles?.[0] ?? "delivery-coordination",
            modelRoute: "delivery-quality",
            correlationId: input.correlationId,
            estimatedTokens: 16_000,
            estimatedCostMicros: 0,
            input: {
              operation: "execute_work_task",
              title: task.title,
              objective: task.objective,
              acceptanceCriteria: JSON.parse(task.acceptance_criteria_json) as unknown,
            },
          });
      if (execution.status === "blocked_model_unavailable") return { outcome: "blocked", reason: "model-unavailable" };
      if (execution.status !== "succeeded") return { outcome: "blocked", reason: `delivery-${execution.status}` };
      work = await this.dependencies.works.getWork(context, input.workId);
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
      artifacts.push(artifact.artifactVersion.artifact_version_id);
      await this.dependencies.works.transitionTask(context, {
        commandId: `${root}:completed`,
        workId: input.workId,
        expectedRevision: artifact.work.revision,
        taskId: task.task_id,
        expectedTaskRevision: active.revision,
        target: "completed",
      });
    }
    return { outcome: "blocked", reason: "delivery-iteration-limit" };
  }

  public async cancel(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void> {
    if (!input.workId) return;
    const tasks = await this.dependencies.works.listTasks(context, input.workId);
    for (const task of tasks.filter((candidate) => candidate.status === "running")) {
      const commandId = `${input.commandId.replace(/:cancel$/u, "")}:task:${task.task_id}`;
      if (
        task.required_capabilities?.some((capability) =>
          ["software-development", "software-engineering"].includes(capability),
        )
      ) {
        await this.dependencies.software?.cancelTask?.(context, { commandId, workId: input.workId, task });
        continue;
      }
      const executionId = await this.dependencies.runtimeExecutions.findExecutionIdByCommand(
        context,
        `${commandId}:runtime`,
      );
      if (executionId) await this.dependencies.runner.cancel(context, executionId, "Application run cancelled");
    }
  }
}
