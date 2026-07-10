import type { TenantContext } from "@massion/identity";

export type RuntimeExecutionStatus =
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked_model_unavailable";

export interface AgentExecutionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly correlationId: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly input: unknown;
}

export interface AgentExecutionResult {
  readonly executionId: string;
  readonly status: RuntimeExecutionStatus;
  readonly output?: unknown;
  readonly error?: RuntimeExecutionError;
}

export interface AgentExecutionEvent {
  readonly executionId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: unknown;
}

export interface RuntimeExecutionError {
  readonly category: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly causeId?: string;
}

export interface AgentRunner {
  execute(context: TenantContext, input: AgentExecutionInput): Promise<AgentExecutionResult>;
  stream(context: TenantContext, input: AgentExecutionInput): AsyncIterable<AgentExecutionEvent>;
  cancel(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  suspend(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult>;
  recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult>;
}
