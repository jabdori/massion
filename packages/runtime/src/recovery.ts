import type { TenantContext } from "@massion/identity";

import type { AgentExecutionResult, RuntimeExecutionStatus } from "./contracts.js";
import { runtimeExecutionResult, RuntimeExecutionStore } from "./execution-store.js";

export interface PersistedWorkflowState {
  readonly id: string;
  readonly workflowId: string;
  readonly status: "running" | "suspended" | "completed" | "cancelled" | "error";
  readonly output?: unknown;
}

export interface WorkflowStateReader {
  getWorkflowState(executionId: string): Promise<PersistedWorkflowState | null>;
}

export class RuntimeRecovery {
  public constructor(
    private readonly store: RuntimeExecutionStore,
    private readonly workflows: WorkflowStateReader,
  ) {}

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    const snapshot = await this.store.getRecovery(context, executionId);
    if (this.isTerminal(snapshot.execution.status) || snapshot.execution.status === "suspended") {
      return runtimeExecutionResult(snapshot.execution);
    }
    if (snapshot.execution.status !== "running") {
      return runtimeExecutionResult(snapshot.execution);
    }
    const workflow = snapshot.binding
      ? await this.workflows.getWorkflowState(snapshot.binding.workflow_execution_id)
      : null;
    const target = this.target(workflow);
    const changed = await this.store.transition(context, {
      commandId: `${executionId}:recovery:${target}`,
      executionId,
      expectedVersion: snapshot.execution.version,
      target,
      payload:
        target === "succeeded" ? { output: workflow?.output } : { workflowStatus: workflow?.status ?? "missing" },
    });
    return runtimeExecutionResult(changed.execution);
  }

  public async recoverAll(context: TenantContext): Promise<AgentExecutionResult[]> {
    const executions = await this.store.listRecoverable(context);
    return await Promise.all(executions.map(async (execution) => await this.recover(context, execution.execution_id)));
  }

  private target(
    state: PersistedWorkflowState | null,
  ): "suspended" | "succeeded" | "failed" | "cancelled" | "interrupted" {
    if (!state || state.status === "running") return "interrupted";
    if (state.status === "suspended") return "suspended";
    if (state.status === "completed") return "succeeded";
    if (state.status === "cancelled") return "cancelled";
    return "failed";
  }

  private isTerminal(status: RuntimeExecutionStatus): boolean {
    return ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(status);
  }
}
