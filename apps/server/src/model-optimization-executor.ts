import { generateText, type RoutedModelLease } from "@massion/runtime";

export interface OptimizationCaseExecutionInput {
  readonly lease: RoutedModelLease;
  readonly executionId: string;
  readonly caseId: string;
  readonly prompt: string;
  readonly expectedOutcome: string;
}

export interface OptimizationCaseExecutionResult {
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function quality(
  text: string,
  expectedOutcome: string,
): { readonly completed: boolean; readonly qualityScore: number } {
  const normalized = text.trim().toLocaleLowerCase();
  const expected = expectedOutcome.trim().toLocaleLowerCase();
  const completed = normalized.length > 0;
  return {
    completed,
    qualityScore: completed && expected.length > 0 && normalized.includes(expected) ? 1 : completed ? 0.5 : 0,
  };
}

function usage(value: unknown): { readonly inputTokens: number; readonly outputTokens: number } {
  if (!value || typeof value !== "object") return { inputTokens: 0, outputTokens: 0 };
  const record = value as { readonly inputTokens?: unknown; readonly outputTokens?: unknown };
  return { inputTokens: tokenCount(record.inputTokens), outputTokens: tokenCount(record.outputTokens) };
}

/** 일반 모델과 구독 Agent 실행기를 동일한 평가 결과로 정산합니다. */
export async function executeOptimizationCase(
  input: OptimizationCaseExecutionInput,
): Promise<OptimizationCaseExecutionResult> {
  const startedAt = Date.now();
  try {
    let text: string;
    let tokens: { readonly inputTokens: number; readonly outputTokens: number };
    if (input.lease.kind === "model") {
      const result = await generateText({ model: input.lease.model, prompt: input.prompt, maxRetries: 0 });
      text = result.text;
      tokens = usage(result.usage);
    } else {
      const result = await input.lease.executor.execute({ executionId: input.executionId, prompt: input.prompt });
      if (result.outcome !== "completed")
        throw new Error(`모델 평가 Agent 실행이 완료되지 않았습니다: ${result.outcome}`);
      if (result.executionId !== input.executionId) throw new Error("모델 평가 Agent 실행 계보가 일치하지 않습니다");
      text = outputText(result.value);
      tokens = usage(result.usage);
    }
    const score = quality(text, input.expectedOutcome);
    const attempt = await input.lease.complete({
      commandId: `${input.executionId}:${input.caseId}:complete`,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
    });
    return {
      ...score,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costMicros: attempt.actual_cost_micros,
      privacyAllowed: true,
      ...tokens,
    };
  } catch (error) {
    await input.lease
      .fail({
        commandId: `${input.executionId}:${input.caseId}:fail`,
        signal: { kind: "unknown" },
        emittedTokens: 0,
        sideEffectsStarted: false,
        inputTokens: 0,
        outputTokens: 0,
      })
      .catch(() => undefined);
    throw error;
  }
}
