import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutedAgentRuntimeLease, RoutedLanguageModelLease } from "@massion/runtime";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock("@massion/runtime", async (importOriginal) => {
  const [runtime, source] = await Promise.all([
    importOriginal<typeof import("@massion/runtime")>(),
    import("../../../packages/runtime/src/voltagent-runner.js"),
  ]);
  return { ...runtime, failureSignal: source.failureSignal, generateText: generateTextMock };
});

import { executeOptimizationCase } from "./model-optimization-executor.js";

describe("모델 최적화 평가 실행기", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  function modelLease(fail = vi.fn(async () => ({ status: "failed", fallbackAllowed: false }))) {
    return {
      lease: {
        kind: "model",
        attemptId: "attempt-model-1",
        credentialId: "credential-model-1",
        model: { modelId: "evaluation-model" } as never,
        supportsStructuredOutput: false,
        complete: vi.fn(async () => ({ actual_cost_micros: 0 }) as never),
        fail,
      } satisfies RoutedLanguageModelLease,
      fail,
    };
  }

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

  it.each([
    [
      "HTTP 503",
      Object.assign(new Error("service unavailable"), { statusCode: 503 }),
      { kind: "http", statusCode: 503 },
    ],
    ["HTTP 429", Object.assign(new Error("rate limited"), { statusCode: 429 }), { kind: "http", statusCode: 429 }],
    ["HTTP 401", Object.assign(new Error("unauthorized"), { statusCode: 401 }), { kind: "http", statusCode: 401 }],
    ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" }), { kind: "timeout" }],
    ["network", new TypeError("fetch failed"), { kind: "network" }],
    ["unknown", new Error("provider failed"), { kind: "unknown" }],
  ] as const)("직접 모델의 %s 오류를 실제 Route Attempt 실패 신호로 보존한다", async (_label, error, signal) => {
    const { lease, fail } = modelLease();
    generateTextMock.mockRejectedValueOnce(error);

    await expect(
      executeOptimizationCase({
        lease,
        executionId: "run-model-failure",
        caseId: "case-model-failure",
        prompt: "평가해주세요.",
        expectedOutcome: "READY",
      }),
    ).rejects.toBe(error);

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith({
      commandId: "run-model-failure:case-model-failure:fail",
      signal,
      emittedTokens: 0,
      sideEffectsStarted: false,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("직접 모델 평가를 120초 timeout 신호로 제한한다", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const error = new DOMException("timed out", "TimeoutError");
    const { lease, fail } = modelLease();
    generateTextMock.mockRejectedValueOnce(error);

    try {
      await expect(
        executeOptimizationCase({
          lease,
          executionId: "run-model-timeout",
          caseId: "case-model-timeout",
          prompt: "평가해주세요.",
          expectedOutcome: "READY",
        }),
      ).rejects.toBe(error);
      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
      expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({ abortSignal: timeout.signal });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "timeout" } }));
  });

  it("성공 정산 오류를 후속 실패 정산 오류로 덮어쓰지 않는다", async () => {
    const settlementError = new Error("성공 정산 실패");
    const fail = vi.fn(async () => {
      throw new Error("실패 정산도 실패");
    });
    const fixture = modelLease(fail);
    const lease: RoutedLanguageModelLease = {
      ...fixture.lease,
      complete: vi.fn(async () => {
        throw settlementError;
      }),
    };
    generateTextMock.mockResolvedValueOnce({
      text: "READY",
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    await expect(
      executeOptimizationCase({
        lease,
        executionId: "run-settlement-failure",
        caseId: "case-settlement-failure",
        prompt: "평가해주세요.",
        expectedOutcome: "READY",
      }),
    ).rejects.toBe(settlementError);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "run-settlement-failure:case-settlement-failure:fail",
        signal: { kind: "unknown" },
      }),
    );
  });
});
