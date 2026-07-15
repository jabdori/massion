import { describe, expect, it, vi } from "vitest";

import type { RoutedAgentRuntimeLease } from "@massion/runtime";

import { executeOptimizationCase } from "./model-optimization-executor.js";

describe("모델 최적화 평가 실행기", () => {
  it("구독 Agent 실행기 결과를 평가 receipt 입력으로 정산한다", async () => {
    const complete = vi.fn(async () => ({ actual_cost_micros: 0 }) as never);
    const fail = vi.fn(async () => ({ status: "failed", fallbackAllowed: false }));
    const lease: RoutedAgentRuntimeLease = {
      kind: "agent-runtime",
      attemptId: "attempt-1",
      credentialId: "credential-1",
      sessionLeaseId: "session-1",
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      subscription: {
        workId: "optimization:run-1",
        agentHandle: "representative",
        accountId: "account-1",
        connectorId: "connector-1",
        adapterId: "codex",
      },
      executor: {
        execute: vi.fn(async () => ({
          outcome: "completed" as const,
          executionId: "run-1",
          sessionId: "session-1",
          value: "READY",
          usage: { inputTokens: 2, outputTokens: 3 },
        })),
      },
      renewSession: vi.fn(async () => new Date(Date.now() + 60_000).toISOString()),
      complete,
      fail,
    };

    const result = await executeOptimizationCase({
      lease,
      executionId: "run-1",
      caseId: "case-1",
      prompt: "READY만 답해주세요.",
      expectedOutcome: "READY",
    });

    expect(result).toMatchObject({
      qualityScore: 1,
      costMicros: 0,
      completed: true,
      inputTokens: 2,
      outputTokens: 3,
    });
    expect(complete).toHaveBeenCalledWith({
      commandId: "run-1:case-1:complete",
      inputTokens: 2,
      outputTokens: 3,
    });
    expect(fail).not.toHaveBeenCalled();
  });
});
