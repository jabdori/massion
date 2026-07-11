import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";

export interface SubscriptionAgentInput {
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly sessionId?: string;
}

export type SubscriptionAgentResult =
  | {
      readonly outcome: "completed";
      readonly executionId: string;
      readonly sessionId: string;
      readonly value: unknown;
      readonly usage?: unknown;
    }
  | {
      readonly outcome: "suspended";
      readonly executionId: string;
      readonly sessionId: string;
      readonly approvalId: string;
    }
  | {
      readonly outcome: "cancelled";
      readonly executionId: string;
      readonly sessionId?: string;
    }
  | {
      readonly outcome: "failed";
      readonly executionId: string;
      readonly sessionId?: string;
      readonly category: string;
      readonly retryable: boolean;
    };

export interface SubscriptionAgentResumeInput {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface SubscriptionAgentAdapter {
  execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult>;
  executeStructured?(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult>;
  resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult>;
  cancel(context: TenantContext, executionId: string): Promise<void>;
}

interface ActiveExecution {
  readonly adapterId: string;
  readonly adapter: SubscriptionAgentAdapter;
  readonly context: TenantContext;
  readonly input: SubscriptionAgentInput;
  result?: SubscriptionAgentResult;
}

function sameTenant(left: TenantContext, right: TenantContext): boolean {
  return left.organizationId === right.organizationId && left.userId === right.userId;
}

export class SubscriptionAgentRuntimeCoordinator {
  private readonly executions = new Map<string, ActiveExecution>();

  public constructor(private readonly adapters: Readonly<Record<string, SubscriptionAgentAdapter>>) {}

  public async execute(
    adapterId: string,
    context: TenantContext,
    input: SubscriptionAgentInput,
  ): Promise<SubscriptionAgentResult> {
    if (this.executions.has(input.executionId)) throw new Error("구독 Agent 실행 ID가 이미 사용 중입니다");
    const adapter = this.adapters[adapterId];
    if (!adapter) throw new Error(`구독 Agent adapter를 찾을 수 없습니다: ${adapterId}`);
    const active: ActiveExecution = { adapterId, adapter, context, input };
    this.executions.set(input.executionId, active);
    try {
      const result = await adapter.execute(context, input);
      active.result = result;
      if (result.outcome !== "suspended") this.executions.delete(input.executionId);
      return result;
    } catch (error) {
      this.executions.delete(input.executionId);
      throw error;
    }
  }

  public async resume(
    context: TenantContext,
    executionId: string,
    approval: { readonly approvalId: string; readonly approved: boolean },
  ): Promise<SubscriptionAgentResult> {
    const active = this.executions.get(executionId);
    if (!active || active.result?.outcome !== "suspended") throw new Error("재개할 구독 Agent 실행이 없습니다");
    if (!sameTenant(active.context, context)) throw new Error("구독 Agent 실행 TenantContext가 일치하지 않습니다");
    if (active.result.approvalId !== approval.approvalId)
      throw new Error("구독 Agent 실행 승인 ID가 일치하지 않습니다");
    const result = await active.adapter.resume(context, active.input, {
      sessionId: active.result.sessionId,
      approvalId: approval.approvalId,
      approved: approval.approved,
    });
    active.result = result;
    if (result.outcome !== "suspended") this.executions.delete(executionId);
    return result;
  }

  public async cancel(context: TenantContext, executionId: string): Promise<void> {
    const active = this.executions.get(executionId);
    if (!active) return;
    if (!sameTenant(active.context, context)) throw new Error("구독 Agent 실행 TenantContext가 일치하지 않습니다");
    await active.adapter.cancel(context, executionId);
    this.executions.delete(executionId);
  }
}
