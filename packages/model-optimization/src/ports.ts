import type { EvaluationCase, EvaluationRun, StoredEvaluationReceipt } from "./contracts.js";
import type { OptimizationRoleKey } from "./scoring.js";

/** 평가 실행 중 정본 변경을 막기 위해 명시적으로 전달하는 capability 집합입니다. */
export interface EvaluationCapabilities {
  readonly write: boolean;
  readonly message: boolean;
  readonly deployment: boolean;
  readonly approval: boolean;
  readonly organizationMutation: boolean;
}

export interface ModelEvaluationExecutionInput {
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode: "standard" | "shadow";
  readonly run: EvaluationRun;
  readonly case: EvaluationCase;
  readonly capabilities: EvaluationCapabilities;
}

export interface ModelEvaluationExecutionResult {
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ModelEvaluationExecutor {
  execute(input: ModelEvaluationExecutionInput): Promise<ModelEvaluationExecutionResult>;
}

export interface ModelEvaluationReceiptSummary {
  readonly run: EvaluationRun;
  readonly receipt: StoredEvaluationReceipt;
}
