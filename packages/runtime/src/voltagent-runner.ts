import { randomUUID } from "node:crypto";

import { Agent, type DynamicValue } from "@voltagent/core";
import type { LanguageModel } from "ai";

import type { TenantContext } from "@massion/identity";
import type { FailureSignal } from "@massion/router";

import type { AgentExecutionEvent, AgentExecutionInput, AgentExecutionResult, AgentRunner } from "./contracts.js";
import { type RuntimeEvent, type RuntimeExecution, RuntimeExecutionStore } from "./execution-store.js";
import type { AcquireModelInput, RoutedModelFactory, RoutedModelLease } from "./model-factory.js";

const EXECUTION_CONTEXT_KEY = "massion.executionId";
const MAX_FALLBACKS = 16;

interface ActiveExecution {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  cancellation?: Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function eventView(event: RuntimeEvent): AgentExecutionEvent {
  return {
    executionId: event.execution_id,
    sequence: event.sequence,
    type: event.event_type,
    payload: JSON.parse(event.payload_json) as unknown,
    createdAt: event.created_at,
  };
}

function prompt(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function failureSignal(error: unknown): FailureSignal {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const statusCode = record.statusCode;
    if (typeof statusCode === "number") return { kind: "http", statusCode };
    const name = record.name;
    if (name === "TimeoutError") return { kind: "timeout" };
  }
  return error instanceof TypeError ? { kind: "network" } : { kind: "unknown" };
}

function isModelUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("blocked_model_unavailable:");
}

function streamPayload(part: { readonly type: string } & Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { type: part.type };
  for (const key of ["id", "text", "delta", "toolName", "toolCallId", "finishReason", "usage"] as const) {
    if (part[key] !== undefined) safe[key] = part[key];
  }
  return safe;
}

export class RoutedModelRegistry {
  private readonly leases = new Map<string, RoutedModelLease>();

  public readonly resolve: DynamicValue<LanguageModel> = ({ context }) => {
    const executionId = context.get(EXECUTION_CONTEXT_KEY);
    if (typeof executionId !== "string") throw new Error("VoltAgent context에 Massion execution ID가 없습니다");
    const lease = this.leases.get(executionId);
    if (!lease) throw new Error(`Runtime model lease를 찾을 수 없습니다: ${executionId}`);
    return lease.model;
  };

  public set(executionId: string, lease: RoutedModelLease): void {
    if (this.leases.has(executionId)) throw new Error(`Runtime model lease가 이미 등록됐습니다: ${executionId}`);
    this.leases.set(executionId, lease);
  }

  public delete(executionId: string): void {
    this.leases.delete(executionId);
  }

  public get size(): number {
    return this.leases.size;
  }
}

interface VoltAgentReader {
  getAgents(): Agent[];
}

export interface AgentExecutionLifecycle {
  suspend(context: TenantContext, executionId: string, reason?: string): Promise<void>;
  resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult>;
  recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult>;
}

export class VoltAgentRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveExecution>();
  private accepting = true;

  public constructor(
    private readonly voltAgent: VoltAgentReader,
    private readonly store: RuntimeExecutionStore,
    private readonly models: RoutedModelFactory,
    private readonly registry: RoutedModelRegistry,
    private readonly lifecycle?: AgentExecutionLifecycle,
  ) {}

  public async execute(context: TenantContext, input: AgentExecutionInput): Promise<AgentExecutionResult> {
    this.requireAccepting();
    const created = await this.store.createExecution(context, input);
    if (created.execution.status !== "queued") return this.resultFromExecution(created.execution);
    const running = await this.store.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: { agentHandle: input.agentHandle },
    });
    const active = this.activate(running.execution.execution_id);
    try {
      return await this.generateWithFallback(context, input, running.execution, active.controller.signal);
    } finally {
      this.finish(running.execution.execution_id);
    }
  }

  public async *stream(context: TenantContext, input: AgentExecutionInput): AsyncIterable<AgentExecutionEvent> {
    this.requireAccepting();
    const created = await this.store.createExecution(context, input);
    yield eventView(created.event);
    if (created.execution.status !== "queued") return;
    let state = await this.store.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: { agentHandle: input.agentHandle },
    });
    yield eventView(state.event);
    const executionId = created.execution.execution_id;
    const active = this.activate(executionId);
    let fallbackFromAttemptId: string | undefined;
    let emittedTokens = 0;
    try {
      for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
        let lease: RoutedModelLease | undefined;
        try {
          lease = await this.models.acquire(
            context,
            this.acquireInput(input, executionId, attempt, fallbackFromAttemptId),
          );
          this.registry.set(executionId, lease);
          const agent = this.agent(context, input.agentHandle);
          const result = await agent.streamText(prompt(input.input), {
            abortSignal: active.controller.signal,
            context: new Map([[EXECUTION_CONTEXT_KEY, executionId]]),
          });
          for await (const raw of result.fullStream) {
            const part = raw as { readonly type: string } & Record<string, unknown>;
            const text = typeof part.text === "string" ? part.text : part.delta;
            if (part.type === "text-delta" && typeof text === "string" && text.length > 0) emittedTokens += 1;
            state = await this.store.appendEvent(context, {
              commandId: `${executionId}:stream:${String(state.execution.event_sequence + 1)}`,
              executionId,
              expectedVersion: state.execution.version,
              eventType: `model_${part.type.replaceAll("-", "_")}`,
              payload: streamPayload(part),
            });
            yield eventView(state.event);
          }
          const usage = await result.usage;
          await lease.complete({
            commandId: `${executionId}:model:${String(attempt)}:complete`,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
          state = await this.store.transition(context, {
            commandId: `${executionId}:succeeded`,
            executionId,
            expectedVersion: state.execution.version,
            target: "succeeded",
            payload: { attemptId: lease.attemptId },
          });
          yield eventView(state.event);
          return;
        } catch (error) {
          this.registry.delete(executionId);
          if (active.controller.signal.aborted) {
            const reason = active.controller.signal.reason as unknown;
            state = await this.toTerminalIfRunning(context, executionId, "cancelled", {
              reason,
            });
            yield eventView(state.event);
            return;
          }
          if (lease) {
            const failed = await lease.fail({
              commandId: `${executionId}:model:${String(attempt)}:fail`,
              signal: failureSignal(error),
              emittedTokens,
              inputTokens: 0,
              outputTokens: emittedTokens,
            });
            if (failed.fallbackAllowed && emittedTokens === 0) {
              fallbackFromAttemptId = lease.attemptId;
              continue;
            }
          }
          const target = isModelUnavailable(error)
            ? "blocked_model_unavailable"
            : emittedTokens > 0
              ? "interrupted"
              : "failed";
          state = await this.toTerminalIfRunning(context, executionId, target, this.errorPayload(error));
          yield eventView(state.event);
          return;
        } finally {
          this.registry.delete(executionId);
        }
      }
      state = await this.toTerminalIfRunning(context, executionId, "failed", { message: "Model fallback 한도 초과" });
      yield eventView(state.event);
    } finally {
      this.registry.delete(executionId);
      this.finish(executionId);
    }
  }

  public async cancel(context: TenantContext, executionId: string, reason = "cancelled"): Promise<void> {
    const recovery = await this.store.getRecovery(context, executionId);
    if (
      ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(
        recovery.execution.status,
      )
    )
      return;
    const active = this.active.get(executionId);
    if (active) {
      if (!active.controller.signal.aborted) active.controller.abort(reason);
      active.cancellation ??= this.cancelActive(context, executionId, reason);
      await active.cancellation;
      return;
    }
    await this.store.transition(context, {
      commandId: `${executionId}:cancelled`,
      executionId,
      expectedVersion: recovery.execution.version,
      target: "cancelled",
      payload: { reason },
    });
  }

  public async suspend(context: TenantContext, executionId: string, reason?: string): Promise<void> {
    await this.requireLifecycle().suspend(context, executionId, reason);
  }

  public async resume(context: TenantContext, executionId: string, input?: unknown): Promise<AgentExecutionResult> {
    return await this.requireLifecycle().resume(context, executionId, input);
  }

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    return await this.requireLifecycle().recover(context, executionId);
  }

  public stopAccepting(): void {
    this.accepting = false;
  }

  public get activeCount(): number {
    return this.active.size;
  }

  private async generateWithFallback(
    context: TenantContext,
    input: AgentExecutionInput,
    running: RuntimeExecution,
    abortSignal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    let fallbackFromAttemptId: string | undefined;
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
      let lease: RoutedModelLease | undefined;
      try {
        lease = await this.models.acquire(
          context,
          this.acquireInput(input, running.execution_id, attempt, fallbackFromAttemptId),
        );
        this.registry.set(running.execution_id, lease);
        const result = await this.agent(context, input.agentHandle).generateText(prompt(input.input), {
          abortSignal,
          context: new Map([[EXECUTION_CONTEXT_KEY, running.execution_id]]),
        });
        await lease.complete({
          commandId: `${running.execution_id}:model:${String(attempt)}:complete`,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        });
        const current = await this.store.getRecovery(context, running.execution_id);
        await this.store.transition(context, {
          commandId: `${running.execution_id}:succeeded`,
          executionId: running.execution_id,
          expectedVersion: current.execution.version,
          target: "succeeded",
          payload: { output: result.text, attemptId: lease.attemptId },
        });
        return { executionId: running.execution_id, status: "succeeded", output: result.text };
      } catch (error) {
        this.registry.delete(running.execution_id);
        if (abortSignal.aborted) {
          const reason = abortSignal.reason as unknown;
          await this.toTerminalIfRunning(context, running.execution_id, "cancelled", { reason });
          return { executionId: running.execution_id, status: "cancelled" };
        }
        if (lease) {
          const failed = await lease.fail({
            commandId: `${running.execution_id}:model:${String(attempt)}:fail`,
            signal: failureSignal(error),
            emittedTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
          });
          if (failed.fallbackAllowed) {
            fallbackFromAttemptId = lease.attemptId;
            continue;
          }
        }
        const target = isModelUnavailable(error) ? "blocked_model_unavailable" : "failed";
        const failed = await this.toTerminalIfRunning(context, running.execution_id, target, this.errorPayload(error));
        return this.resultFromExecution(failed.execution);
      } finally {
        this.registry.delete(running.execution_id);
      }
    }
    const failed = await this.toTerminalIfRunning(context, running.execution_id, "failed", {
      message: "Model fallback 한도 초과",
    });
    return this.resultFromExecution(failed.execution);
  }

  private acquireInput(
    input: AgentExecutionInput,
    executionId: string,
    attempt: number,
    fallbackFromAttemptId?: string,
  ): AcquireModelInput {
    return {
      commandId: `${executionId}:model:${String(attempt)}:reserve`,
      routeName: input.modelRoute,
      estimatedTokens: input.estimatedTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      stickyKey: `${input.workId}:${input.agentHandle}`,
      ...(fallbackFromAttemptId ? { fallbackFromAttemptId } : {}),
    };
  }

  private agent(context: TenantContext, handle: string): Agent {
    const name = `${context.organizationId}:${handle}`;
    const agent = this.voltAgent.getAgents().find((candidate) => candidate.name === name);
    if (!agent) throw new Error(`활성 Runtime Agent를 찾을 수 없습니다: ${handle}`);
    return agent;
  }

  private async cancelActive(context: TenantContext, executionId: string, reason: string): Promise<void> {
    try {
      await this.toTerminalIfRunning(context, executionId, "cancelled", { reason });
    } finally {
      this.finish(executionId);
    }
  }

  private activate(executionId: string): ActiveExecution {
    if (this.active.has(executionId)) throw new Error(`Runtime Execution이 이미 활성 상태입니다: ${executionId}`);
    const completion = deferred();
    const active = { controller: new AbortController(), done: completion.promise, resolveDone: completion.resolve };
    this.active.set(executionId, active);
    return active;
  }

  private finish(executionId: string): void {
    const active = this.active.get(executionId);
    if (!active) return;
    this.active.delete(executionId);
    active.resolveDone();
  }

  private async toTerminalIfRunning(
    context: TenantContext,
    executionId: string,
    target: "failed" | "cancelled" | "interrupted" | "blocked_model_unavailable",
    payload: unknown,
  ) {
    const current = await this.store.getRecovery(context, executionId);
    if (current.execution.status !== "running") {
      const event = current.events.at(-1);
      if (!event) throw new Error("Runtime terminal Event를 찾을 수 없습니다");
      return { execution: current.execution, event };
    }
    return await this.store.transition(context, {
      commandId: `${executionId}:${target}`,
      executionId,
      expectedVersion: current.execution.version,
      target,
      payload,
    });
  }

  private resultFromExecution(execution: RuntimeExecution): AgentExecutionResult {
    const stored = execution.output_json ? (JSON.parse(execution.output_json) as unknown) : undefined;
    const output =
      stored && typeof stored === "object" && "output" in stored ? (stored as Record<string, unknown>).output : stored;
    return {
      executionId: execution.execution_id,
      status: execution.status,
      ...(execution.output_json ? { output } : {}),
      ...(execution.error_json
        ? { error: { category: "runtime", retryable: false, userMessage: "Agent 실행에 실패했습니다" } }
        : {}),
    };
  }

  private errorPayload(error: unknown): Record<string, unknown> {
    return {
      category: failureSignal(error).kind,
      retryable: ["timeout", "network"].includes(failureSignal(error).kind),
      message: error instanceof Error ? error.message : "알 수 없는 Runtime 오류",
      causeId: randomUUID(),
    };
  }

  private requireAccepting(): void {
    if (!this.accepting) throw new Error("Runtime이 종료 중이어서 새 실행을 받을 수 없습니다");
  }

  private requireLifecycle(): AgentExecutionLifecycle {
    if (!this.lifecycle) throw new Error("Runtime workflow lifecycle이 구성되지 않았습니다");
    return this.lifecycle;
  }
}
