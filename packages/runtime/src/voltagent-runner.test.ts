import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent, AgentRegistry, VoltAgent } from "@voltagent/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { RouteAttempt } from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { AgentExecutionInput } from "./contracts.js";
import { RuntimeExecutionStore } from "./execution-store.js";
import type { RoutedModelFactory, RoutedModelLease } from "./model-factory.js";
import { normalizeVoltAgentStreamPart, RoutedModelRegistry, VoltAgentRunner } from "./voltagent-runner.js";

const USAGE = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

describe("VoltAgent AgentRunner", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: RuntimeExecutionStore;
  let voltAgent: VoltAgent;
  let registry: RoutedModelRegistry;
  let agentId: string;
  let rejectionListeners: ReturnType<typeof process.rawListeners>;

  beforeEach(async () => {
    rejectionListeners = process.rawListeners("unhandledRejection");
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
    registry = new RoutedModelRegistry();
    agentId = `${context.organizationId}:representative`;
    voltAgent = new VoltAgent({
      agents: {
        representative: new Agent({
          id: agentId,
          name: `${context.organizationId}:representative`,
          instructions: "Respond",
          model: registry.resolve,
          maxRetries: 0,
        }),
      },
    });
    await voltAgent.ready;
  });

  afterEach(async () => {
    AgentRegistry.getInstance().removeAgent(agentId);
    await voltAgent.shutdown();
    await database.close();
    for (const listener of process.rawListeners("unhandledRejection")) {
      if (!rejectionListeners.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
  });

  function input(): AgentExecutionInput {
    return {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "representative",
      modelRoute: "coding-balanced",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      input: "hello",
    };
  }

  function lease(
    model: MockLanguageModelV3,
    attemptId = crypto.randomUUID(),
    fallbackAllowed = false,
  ): RoutedModelLease {
    return {
      attemptId,
      credentialId: crypto.randomUUID(),
      model,
      complete: vi.fn().mockResolvedValue({ status: "succeeded" } as RouteAttempt),
      fail: vi.fn().mockResolvedValue({ status: "failed", fallbackAllowed }),
    };
  }

  it("실제 VoltAgent generateText를 동적 routed model로 실행하고 usage·terminal event를 정산한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "hello runtime" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const factory: RoutedModelFactory = { acquire: vi.fn().mockResolvedValue(routed) };
    const runner = new VoltAgentRunner(voltAgent, store, factory, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result).toMatchObject({ status: "succeeded", output: "hello runtime" });
    expect(routed.complete).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
    expect(recovery.events.map((event) => event.event_type)).toEqual([
      "execution_queued",
      "execution_running",
      "execution_succeeded",
    ]);
    expect(registry.size).toBe(0);
  });

  it("JSON Schema로 검증한 structured object를 Runtime 계보와 함께 반환한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "완제품 구현" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "검증 가능한 실행 계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "완제품 구현" } });
    expect(routed.complete).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
  });

  it("structured 실행도 첫 응답 전 실패를 동급 모델로 fallback한다", async () => {
    const failedModel = new MockLanguageModelV3({
      doGenerate: async () => {
        const error = new Error("unauthorized") as Error & { statusCode: number };
        error.statusCode = 401;
        throw error;
      },
    });
    const first = lease(failedModel, "structured-attempt-1", true);
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ objective: "fallback plan" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
      "structured-attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.executeStructured(context, input(), {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
    });

    expect(result).toMatchObject({ status: "succeeded", output: { objective: "fallback plan" } });
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "http", statusCode: 401 } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "structured-attempt-1" });
  });

  it("structured schema 실패와 모델 부재를 secret 없는 terminal 상태로 기록한다", async () => {
    const invalid = lease(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: JSON.stringify({ apiKey: "secret-value" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const invalidRunner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(invalid) },
      registry,
    );
    const spec = {
      name: "strategy-plan",
      description: "계획",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
      validate: (value: unknown) =>
        value && typeof value === "object" && typeof (value as Record<string, unknown>).objective === "string"
          ? { success: true as const, value }
          : { success: false as const, error: new Error("objective 필드가 필요합니다") },
    } as const;

    const failed = await invalidRunner.executeStructured(context, input(), spec);
    const failedRecovery = await store.getRecovery(context, failed.executionId);

    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failedRecovery)).not.toContain("secret-value");

    const blockedRunner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockRejectedValue(new Error("blocked_model_unavailable: route 없음")) },
      registry,
    );
    const blocked = await blockedRunner.executeStructured(context, input(), spec);

    expect(blocked.status).toBe("blocked_model_unavailable");
  });

  it("first-token 전 인증 실패는 Router가 허용한 다음 lease로 fallback한다", async () => {
    const failedModel = new MockLanguageModelV3({
      doGenerate: async () => {
        const error = new Error("unauthorized") as Error & { statusCode: number };
        error.statusCode = 401;
        throw error;
      },
    });
    const first = lease(failedModel, "attempt-1", true);
    const second = lease(
      new MockLanguageModelV3({
        doGenerate: { content: [{ type: "text", text: "fallback" }], finishReason: "stop", usage: USAGE, warnings: [] },
      }),
      "attempt-2",
    );
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runner = new VoltAgentRunner(voltAgent, store, { acquire }, registry);

    const result = await runner.execute(context, input());

    expect(result.output).toBe("fallback");
    expect(first.fail).toHaveBeenCalledWith(expect.objectContaining({ signal: { kind: "http", statusCode: 401 } }));
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ fallbackFromAttemptId: "attempt-1" });
  });

  it("사용 가능한 모델이 없으면 명시적인 blocked 상태로 종료한다", async () => {
    const factory: RoutedModelFactory = {
      acquire: vi.fn().mockRejectedValue(new Error("blocked_model_unavailable: credential 없음")),
    };
    const runner = new VoltAgentRunner(voltAgent, store, factory, registry);

    const result = await runner.execute(context, input());
    const recovery = await store.getRecovery(context, result.executionId);

    expect(result.status).toBe("blocked_model_unavailable");
    expect(recovery.events.at(-1)?.event_type).toBe("execution_blocked_model_unavailable");
  });

  it("stream part를 단조 Runtime Event로 영속하고 text delta를 전달한다", async () => {
    const routed = lease(
      new MockLanguageModelV3({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "hello" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ],
          }),
        },
      }),
    );
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn().mockResolvedValue(routed) }, registry);

    const events = [];
    for await (const event of runner.stream(context, input())) events.push(event);

    expect(
      events.some((event) => event.type === "model_text_delta" && JSON.stringify(event.payload).includes("hello")),
    ).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((_, index) => index + 1)]);
    const first = events[0];
    if (!first) throw new Error("stream event가 없습니다");
    const recovery = await store.getRecovery(context, first.executionId);
    expect(recovery.execution.status).toBe("succeeded");
  });

  it("tool·handoff 귀속 필드는 유지하고 provider secret은 제거한다", () => {
    const payload = normalizeVoltAgentStreamPart({
      type: "tool-call",
      toolName: "delegate_task",
      toolCallId: "handoff-1",
      providerMetadata: { authorization: "secret-token" },
      credential: "secret-token",
    });

    expect(payload).toEqual({ type: "tool-call", toolName: "delegate_task", toolCallId: "handoff-1" });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("stream 실행을 cancel하면 AbortSignal과 영속 상태가 한 번만 cancelled가 된다", async () => {
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            abortSignal?.addEventListener("abort", () => controller.error(new DOMException("cancelled", "AbortError")));
          },
        }),
      }),
    });
    const runner = new VoltAgentRunner(
      voltAgent,
      store,
      { acquire: vi.fn().mockResolvedValue(lease(model)) },
      registry,
    );
    const iterator = runner.stream(context, input())[Symbol.asyncIterator]();
    const queued = await iterator.next();
    if (queued.done) throw new Error("queued event가 없습니다");
    const running = await iterator.next();
    if (running.done) throw new Error("running event가 없습니다");
    const consuming = iterator.next();
    await vi.waitFor(() => expect(registry.size).toBe(1));

    await Promise.all([
      runner.cancel(context, queued.value.executionId, "user"),
      runner.cancel(context, queued.value.executionId, "user"),
    ]);
    await consuming;
    const recovery = await store.getRecovery(context, queued.value.executionId);
    expect(recovery.execution.status).toBe("cancelled");
    expect(recovery.events.filter((event) => event.event_type === "execution_cancelled")).toHaveLength(1);
  });

  it("framework-neutral suspend·resume·recover 계약을 lifecycle adapter에 연결한다", async () => {
    const lifecycle = {
      suspend: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue({ executionId: "execution-1", status: "succeeded" }),
      recover: vi.fn().mockResolvedValue({ executionId: "execution-1", status: "suspended" }),
    };
    const runner = new VoltAgentRunner(voltAgent, store, { acquire: vi.fn() }, registry, lifecycle);

    await runner.suspend(context, "execution-1", "approval");
    await expect(runner.resume(context, "execution-1", { approved: true })).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(runner.recover(context, "execution-1")).resolves.toMatchObject({ status: "suspended" });

    expect(lifecycle.suspend).toHaveBeenCalledWith(context, "execution-1", "approval");
  });
});
