import type { TenantContext } from "@massion/identity";

import type { AgentExecutionResult } from "./contracts.js";
import { RuntimeRecovery } from "./recovery.js";
import type { AgentExecutionLifecycle } from "./voltagent-runner.js";
import { VoltAgentWorkflowRuntime } from "./workflow-runtime.js";

export class WorkflowExecutionLifecycle implements AgentExecutionLifecycle {
  public constructor(
    private readonly workflows: VoltAgentWorkflowRuntime,
    private readonly recovery: RuntimeRecovery,
  ) {}

  public async suspend(context: TenantContext, executionId: string, reason?: string): Promise<void> {
    await this.workflows.suspend(context, executionId, reason);
  }

  public async resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult> {
    return await this.workflows.resume(context, executionId, input);
  }

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    return await this.recovery.recover(context, executionId);
  }
}
