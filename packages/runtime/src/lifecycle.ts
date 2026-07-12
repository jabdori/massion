import type { TenantContext } from "@massion/identity";

import type { AgentExecutionResult } from "./contracts.js";
import { RuntimeRecovery } from "./recovery.js";
import type { AgentExecutionLifecycle } from "./voltagent-runner.js";
import { VoltAgentWorkflowRuntime } from "./workflow-runtime.js";

/**
 * 영속 Workflow checkpoint가 없는 직접 Agent 실행의 정직한 수명주기입니다.
 * 재시작 복구는 안전하게 terminal 상태로 수렴시키되, 지원하지 않는 중단·재개는 즉시 거부합니다.
 */
export class DirectExecutionLifecycle implements AgentExecutionLifecycle {
  public constructor(private readonly recovery: Pick<RuntimeRecovery, "recover">) {}

  public suspend(): Promise<void> {
    return Promise.reject(new Error("직접 Agent 실행은 안전한 checkpoint 중단을 지원하지 않습니다"));
  }

  public resume(): Promise<AgentExecutionResult> {
    return Promise.reject(new Error("직접 Agent 실행은 안전한 checkpoint 재개를 지원하지 않습니다"));
  }

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    return await this.recovery.recover(context, executionId);
  }
}

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
