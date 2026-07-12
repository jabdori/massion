import { createHash, randomUUID } from "node:crypto";

import { Agent, type DynamicValue } from "@voltagent/core";
import { jsonSchema, Output, type LanguageModel } from "ai";

import type { TenantContext } from "@massion/identity";
import type { FailureSignal } from "@massion/router";

import type {
  AgentExecutionEvent,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentRunner,
  StructuredAgentRunner,
  StructuredOutputSpec,
} from "./contracts.js";
import { MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, MASSION_TENANT_CONTEXT_KEY } from "./agent-configuration.js";
import { type RuntimeEvent, type RuntimeExecution, RuntimeExecutionStore } from "./execution-store.js";
import {
  RoutedExecutionSettlementError,
  type AcquireModelInput,
  type RoutedAgentRuntimeLease,
  type RoutedAgentRuntimeResult,
  type RoutedLanguageModelLease,
  type RoutedModelFactory,
  type RoutedModelLease,
} from "./model-factory.js";
import type {
  JsonValue,
  SubscriptionExecutionReceiptCoordinator,
  SubscriptionReceiptLineage,
} from "./subscriptions/execution-receipt.js";

const MAX_FALLBACKS = 16;
const MINIMUM_SESSION_RENEW_DELAY_MS = 1_000;

export interface SessionRenewalClock {
  now(): number;
  schedule(delayMs: number, task: () => Promise<void>): () => void;
}

export interface VoltAgentRunnerOptions {
  readonly sessionRenewalClock?: SessionRenewalClock;
  readonly subscriptionReceipts?: Pick<
    SubscriptionExecutionReceiptCoordinator,
    | "read"
    | "recover"
    | "interruptSuspended"
    | "recordRouteSessionAcquired"
    | "recordInvocationStarted"
    | "recordCheckpointObserved"
    | "recordTerminalObserved"
    | "recordSettlementCompleted"
  >;
  readonly subscriptionApprovals?: {
    consume(
      context: TenantContext,
      input: { readonly executionId: string; readonly approvalId: string },
    ): Promise<"approved" | "rejected">;
    interrupt?(
      context: TenantContext,
      input: { readonly executionId: string; readonly approvalId: string },
    ): Promise<void>;
  };
}

class SessionLeaseRenewalError extends Error {
  public constructor(options: { readonly cause: unknown }) {
    super("Connector Session Lease 갱신에 실패했습니다", options);
    this.name = "SessionLeaseRenewalError";
  }
}

const DEFAULT_SESSION_RENEWAL_CLOCK: SessionRenewalClock = {
  now: () => Date.now(),
  schedule(delayMs, task) {
    const timer = setTimeout(() => void task(), delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

interface ActiveExecution {
  readonly context: TenantContext;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  cancellation?: Promise<void>;
}

interface SuspendedSubscriptionExecution {
  readonly context: TenantContext;
  readonly lease: RoutedAgentRuntimeLease;
  readonly sessionId: string;
  readonly approvalId: string;
  approvalDecision?: "approved" | "rejected";
  resumeExpectedVersion?: number;
  resumeAttempt?: Promise<AgentExecutionResult>;
}

type AgentRuntimeAttemptOutcome =
  { readonly kind: "terminal"; readonly result: AgentExecutionResult } | { readonly kind: "fallback" };

type ReceiptTerminalDetails =
  | {
      readonly outcome: "completed";
      readonly providerExecutionId: string;
      readonly providerSessionId?: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly output: { readonly kind: "inline"; readonly value: JsonValue };
    }
  | {
      readonly outcome: "failed" | "cancelled" | "interrupted";
      readonly providerExecutionId: string;
      readonly providerSessionId?: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly emittedTokens: number;
      readonly sideEffectsStarted: boolean;
      readonly signal: FailureSignal;
    };

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

export function normalizeVoltAgentStreamPart(
  part: { readonly type: string } & Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { type: part.type };
  for (const key of ["id", "text", "delta", "toolName", "toolCallId", "finishReason", "usage"] as const) {
    if (part[key] !== undefined) safe[key] = part[key];
  }
  return safe;
}

export class RoutedModelRegistry {
  private readonly leases = new Map<string, RoutedLanguageModelLease>();

  public readonly resolve: DynamicValue<LanguageModel> = ({ context }) => {
    const executionId = context.get(MASSION_RUNTIME_EXECUTION_CONTEXT_KEY);
    if (typeof executionId !== "string") throw new Error("VoltAgent context에 Massion execution ID가 없습니다");
    const lease = this.leases.get(executionId);
    if (!lease) throw new Error(`Runtime model lease를 찾을 수 없습니다: ${executionId}`);
    return lease.model;
  };

  public set(executionId: string, lease: RoutedLanguageModelLease): void {
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

export interface RoutedExecutionContextResolver {
  resolve(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly taskId?: string;
      readonly agentHandle: string;
    },
  ): Promise<{ readonly workspaceRoot?: string; readonly instruction?: string }>;
}

export class VoltAgentRunner implements AgentRunner, StructuredAgentRunner {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly suspendedSubscriptions = new Map<string, SuspendedSubscriptionExecution>();
  private readonly subscriptionReceipts: VoltAgentRunnerOptions["subscriptionReceipts"];
  private accepting = true;
  private intakeOperations = 0;
  private intakeSettled: ReturnType<typeof deferred> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(
    private readonly voltAgent: VoltAgentReader,
    private readonly store: RuntimeExecutionStore,
    private readonly models: RoutedModelFactory,
    private readonly registry: RoutedModelRegistry,
    private readonly lifecycle?: AgentExecutionLifecycle,
    private readonly executionContext?: RoutedExecutionContextResolver,
    private readonly options: VoltAgentRunnerOptions = {},
  ) {
    this.subscriptionReceipts = options.subscriptionReceipts ?? models.createSubscriptionReceipts?.(store);
  }

  public async execute(context: TenantContext, input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const releaseIntake = this.beginIntake();
    let active: ActiveExecution | undefined;
    let running: { readonly execution: RuntimeExecution } | undefined;
    try {
      const created = await this.store.createExecution(context, input);
      if (created.execution.status !== "queued") return this.resultFromExecution(created.execution);
      running = await this.store.transition(context, {
        commandId: `${created.execution.execution_id}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: { agentHandle: input.agentHandle },
      });
      active = this.activate(context, running.execution.execution_id);
    } finally {
      releaseIntake();
    }
    try {
      return await this.generateWithFallback(context, input, running.execution, active.controller.signal);
    } finally {
      this.finish(running.execution.execution_id);
    }
  }

  public async executeStructured(
    context: TenantContext,
    input: AgentExecutionInput,
    output: StructuredOutputSpec,
  ): Promise<AgentExecutionResult> {
    const releaseIntake = this.beginIntake();
    let active: ActiveExecution | undefined;
    let running: { readonly execution: RuntimeExecution } | undefined;
    try {
      const created = await this.store.createExecution(context, input);
      if (created.execution.status !== "queued") return this.resultFromExecution(created.execution);
      running = await this.store.transition(context, {
        commandId: `${created.execution.execution_id}:running`,
        executionId: created.execution.execution_id,
        expectedVersion: created.execution.version,
        target: "running",
        payload: { agentHandle: input.agentHandle, outputName: output.name },
      });
      active = this.activate(context, running.execution.execution_id);
    } finally {
      releaseIntake();
    }
    try {
      return await this.generateStructuredWithFallback(
        context,
        input,
        output,
        running.execution,
        active.controller.signal,
      );
    } finally {
      this.finish(running.execution.execution_id);
    }
  }

  public async *stream(context: TenantContext, input: AgentExecutionInput): AsyncIterable<AgentExecutionEvent> {
    const releaseIntake = this.beginIntake();
    try {
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
      const active = this.activate(context, executionId);
      releaseIntake();
      let fallbackFromAttemptId: string | undefined;
      let fallbackFromLeaseId: string | undefined;
      let emittedTokens = 0;
      try {
        for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
          let lease: RoutedModelLease | undefined;
          try {
            lease = await this.models.acquire(
              context,
              await this.acquireInput(context, input, executionId, attempt, fallbackFromAttemptId, fallbackFromLeaseId),
            );
            if (lease.kind === "agent-runtime") {
              await this.recordSubscriptionInvocationStarted(context, executionId, lease);
              const runtimeResult = await this.executeAgentRuntime(
                context,
                input,
                executionId,
                lease,
                prompt(input.input),
                active.controller.signal,
              );
              const outcome = await this.settleAgentRuntimeResult(context, executionId, lease, runtimeResult);
              if (outcome.kind === "fallback") {
                fallbackFromAttemptId = lease.attemptId;
                fallbackFromLeaseId = lease.sessionLeaseId;
                continue;
              }
              const recovery = await this.store.getRecovery(context, executionId);
              const terminalEvent = recovery.events.at(-1);
              if (!terminalEvent) throw new Error("Agent runtime terminal Event를 찾을 수 없습니다");
              this.finish(executionId);
              yield eventView(terminalEvent);
              return;
            }
            this.registry.set(executionId, lease);
            const agent = this.agent(context, input.agentHandle);
            const result = await agent.streamText(prompt(input.input), {
              abortSignal: active.controller.signal,
              context: new Map<string | symbol, unknown>([
                [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, executionId],
                [MASSION_TENANT_CONTEXT_KEY, context],
              ]),
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
                payload: normalizeVoltAgentStreamPart(part),
              });
              yield eventView(state.event);
              if (part.type === "error") {
                throw part.error instanceof Error
                  ? part.error
                  : new Error("Model stream에서 오류가 발생했습니다", { cause: part.error });
              }
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
            this.finish(executionId);
            yield eventView(state.event);
            return;
          } catch (error) {
            this.registry.delete(executionId);
            if (error instanceof RoutedExecutionSettlementError) {
              state = await this.toTerminalIfRunning(context, executionId, "interrupted", {
                category: "settlement",
              });
              this.finish(executionId);
              yield eventView(state.event);
              return;
            }
            if (active.controller.signal.aborted) {
              const reason = active.controller.signal.reason as unknown;
              state = await this.toTerminalIfRunning(context, executionId, "cancelled", {
                reason,
              });
              this.finish(executionId);
              yield eventView(state.event);
              return;
            }
            if (lease) {
              const failed = await lease.fail({
                commandId: `${executionId}:model:${String(attempt)}:fail`,
                signal: failureSignal(error),
                emittedTokens,
                sideEffectsStarted: lease.kind === "agent-runtime" || emittedTokens > 0,
                inputTokens: 0,
                outputTokens: emittedTokens,
              });
              if (failed.fallbackAllowed && emittedTokens === 0) {
                fallbackFromAttemptId = lease.attemptId;
                fallbackFromLeaseId = lease.sessionLeaseId;
                continue;
              }
            }
            const target = isModelUnavailable(error)
              ? "blocked_model_unavailable"
              : emittedTokens > 0 || error instanceof SessionLeaseRenewalError
                ? "interrupted"
                : "failed";
            state = await this.toTerminalIfRunning(context, executionId, target, this.errorPayload(error));
            this.finish(executionId);
            yield eventView(state.event);
            return;
          } finally {
            this.registry.delete(executionId);
          }
        }
        state = await this.toTerminalIfRunning(context, executionId, "failed", { message: "Model fallback 한도 초과" });
        this.finish(executionId);
        yield eventView(state.event);
      } finally {
        this.registry.delete(executionId);
        this.finish(executionId);
      }
    } finally {
      releaseIntake();
    }
  }

  public async cancel(context: TenantContext, executionId: string, reason = "cancelled"): Promise<void> {
    const recovery = await this.store.getRecovery(context, executionId);
    const active = this.active.get(executionId);
    if (
      ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(
        recovery.execution.status,
      )
    ) {
      if (active) await active.done;
      return;
    }
    const suspendedSubscription = this.suspendedSubscriptions.get(executionId);
    if (suspendedSubscription) {
      if (suspendedSubscription.context.organizationId !== context.organizationId) {
        throw new Error("구독 Agent 실행 조직이 일치하지 않습니다");
      }
      const running = await this.store.transition(suspendedSubscription.context, {
        commandId: `${executionId}:subscription:cancel-running`,
        executionId,
        expectedVersion: recovery.execution.version,
        target: "running",
        payload: { reason },
      });
      try {
        await suspendedSubscription.lease.executor.cancel?.();
        await this.settleAgentRuntimeResult(
          suspendedSubscription.context,
          executionId,
          suspendedSubscription.lease,
          {
            outcome: "cancelled",
            executionId,
            sessionId: suspendedSubscription.sessionId,
          },
          false,
        );
      } catch (error) {
        await this.toTerminalIfRunning(suspendedSubscription.context, executionId, "interrupted", {
          reason,
          category: "subscription-cancel",
          message: error instanceof Error ? error.message : "구독 Agent 취소 정산 실패",
          version: running.execution.version,
        });
        this.suspendedSubscriptions.delete(executionId);
        throw error;
      }
      return;
    }
    if (active) {
      active.cancellation ??= this.cancelActive(active, reason);
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
    const releaseIntake = this.beginIntake();
    try {
      const suspended = this.suspendedSubscriptions.get(executionId);
      if (suspended) return await this.resumeSubscription(context, executionId, input, suspended, releaseIntake);
      releaseIntake();
      return await this.requireLifecycle().resume(context, executionId, input);
    } finally {
      releaseIntake();
    }
  }

  public async recover(context: TenantContext, executionId: string): Promise<AgentExecutionResult> {
    const receipts = this.subscriptionReceipts;
    if (receipts) {
      const snapshot = await receipts.read(context, executionId);
      if (snapshot.attempts.length > 0) {
        if (snapshot.execution.status === "suspended" && !this.suspendedSubscriptions.has(executionId)) {
          const checkpoint = snapshot.attempts.at(-1)?.checkpoint;
          if (checkpoint && this.options.subscriptionApprovals?.interrupt) {
            await this.options.subscriptionApprovals.interrupt(context, {
              executionId,
              approvalId: checkpoint.approvalId,
            });
          }
          return this.resultFromExecution(await receipts.interruptSuspended(context, executionId));
        }
        return this.resultFromExecution(await receipts.recover(context, executionId));
      }
    }
    return await this.requireLifecycle().recover(context, executionId);
  }

  public stopAccepting(): void {
    this.accepting = false;
  }

  public activeExecutionIds(): readonly string[] {
    return [...new Set([...this.active.keys(), ...this.suspendedSubscriptions.keys()])].sort();
  }

  public shutdown(reason = "runtime_shutdown"): Promise<void> {
    this.stopAccepting();
    this.shutdownPromise ??= this.shutdownOnce(reason);
    return this.shutdownPromise;
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
    let fallbackFromLeaseId: string | undefined;
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
      let lease: RoutedModelLease | undefined;
      try {
        lease = await this.models.acquire(
          context,
          await this.acquireInput(
            context,
            input,
            running.execution_id,
            attempt,
            fallbackFromAttemptId,
            fallbackFromLeaseId,
          ),
        );
        if (lease.kind === "agent-runtime") {
          await this.recordSubscriptionInvocationStarted(context, running.execution_id, lease);
          const runtimeResult = await this.executeAgentRuntime(
            context,
            input,
            running.execution_id,
            lease,
            prompt(input.input),
            abortSignal,
          );
          const outcome = await this.settleAgentRuntimeResult(context, running.execution_id, lease, runtimeResult);
          if (outcome.kind === "fallback") {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
          return outcome.result;
        }
        this.registry.set(running.execution_id, lease);
        const result = await this.agent(context, input.agentHandle).generateText(prompt(input.input), {
          abortSignal,
          context: new Map<string | symbol, unknown>([
            [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, running.execution_id],
            [MASSION_TENANT_CONTEXT_KEY, context],
          ]),
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
        if (error instanceof RoutedExecutionSettlementError) {
          const interrupted = await this.toTerminalIfRunning(context, running.execution_id, "interrupted", {
            category: "settlement",
          });
          return this.resultFromExecution(interrupted.execution);
        }
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
            sideEffectsStarted: lease.kind === "agent-runtime",
            inputTokens: 0,
            outputTokens: 0,
          });
          if (failed.fallbackAllowed) {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
        }
        const target = isModelUnavailable(error)
          ? "blocked_model_unavailable"
          : error instanceof SessionLeaseRenewalError
            ? "interrupted"
            : "failed";
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

  private async generateStructuredWithFallback(
    context: TenantContext,
    input: AgentExecutionInput,
    output: StructuredOutputSpec,
    running: RuntimeExecution,
    abortSignal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    let fallbackFromAttemptId: string | undefined;
    let fallbackFromLeaseId: string | undefined;
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt += 1) {
      let lease: RoutedModelLease | undefined;
      try {
        lease = await this.models.acquire(
          context,
          await this.acquireInput(
            context,
            input,
            running.execution_id,
            attempt,
            fallbackFromAttemptId,
            fallbackFromLeaseId,
          ),
        );
        if (lease.kind === "agent-runtime") {
          await this.recordSubscriptionInvocationStarted(context, running.execution_id, lease);
          const runtimeResult = await this.executeAgentRuntime(
            context,
            input,
            running.execution_id,
            lease,
            prompt(input.input),
            abortSignal,
            output,
          );
          const outcome = await this.settleAgentRuntimeResult(context, running.execution_id, lease, runtimeResult);
          if (outcome.kind === "fallback") {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
          return outcome.result;
        }
        this.registry.set(running.execution_id, lease);
        const schema = jsonSchema(
          output.jsonSchema as Parameters<typeof jsonSchema>[0],
          output.validate ? { validate: output.validate } : undefined,
        );
        const result = await this.agent(context, input.agentHandle).generateText(prompt(input.input), {
          abortSignal,
          context: new Map<string | symbol, unknown>([
            [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, running.execution_id],
            [MASSION_TENANT_CONTEXT_KEY, context],
          ]),
          output: Output.object({ schema, name: output.name, description: output.description }),
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
          payload: { output: result.output, attemptId: lease.attemptId },
        });
        return { executionId: running.execution_id, status: "succeeded", output: result.output };
      } catch (error) {
        this.registry.delete(running.execution_id);
        if (error instanceof RoutedExecutionSettlementError) {
          const interrupted = await this.toTerminalIfRunning(context, running.execution_id, "interrupted", {
            category: "settlement",
          });
          return this.resultFromExecution(interrupted.execution);
        }
        if (abortSignal.aborted) {
          await this.toTerminalIfRunning(context, running.execution_id, "cancelled", {
            reason: abortSignal.reason as unknown,
          });
          return { executionId: running.execution_id, status: "cancelled" };
        }
        if (lease) {
          const failed = await lease.fail({
            commandId: `${running.execution_id}:model:${String(attempt)}:fail`,
            signal: failureSignal(error),
            emittedTokens: 0,
            sideEffectsStarted: lease.kind === "agent-runtime",
            inputTokens: 0,
            outputTokens: 0,
          });
          if (failed.fallbackAllowed) {
            fallbackFromAttemptId = lease.attemptId;
            fallbackFromLeaseId = lease.sessionLeaseId;
            continue;
          }
        }
        const target = isModelUnavailable(error)
          ? "blocked_model_unavailable"
          : error instanceof SessionLeaseRenewalError
            ? "interrupted"
            : "failed";
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

  private async executeAgentRuntime(
    context: TenantContext,
    input: AgentExecutionInput,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    inputPrompt: string,
    abortSignal: AbortSignal,
    output?: StructuredOutputSpec,
  ): Promise<RoutedAgentRuntimeResult> {
    this.agent(context, input.agentHandle);
    const renewal = this.startSessionRenewal(executionId, lease, abortSignal);
    try {
      let result: RoutedAgentRuntimeResult;
      if (output) {
        if (!lease.executor.executeStructured) {
          throw new Error("선택한 Agent runtime은 구조화 출력을 지원하지 않습니다");
        }
        result = await lease.executor.executeStructured(
          { executionId, prompt: inputPrompt, abortSignal: renewal.signal },
          output,
        );
      } else {
        result = await lease.executor.execute({ executionId, prompt: inputPrompt, abortSignal: renewal.signal });
      }
      const lateRenewalError = renewal.error();
      if (lateRenewalError) throw lateRenewalError;
      return result;
    } catch (error) {
      throw renewal.error() ?? error;
    } finally {
      renewal.stop();
    }
  }

  private startSessionRenewal(
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    parentSignal: AbortSignal,
  ): {
    readonly signal: AbortSignal;
    readonly error: () => SessionLeaseRenewalError | undefined;
    readonly stop: () => void;
  } {
    const clock = this.options.sessionRenewalClock ?? DEFAULT_SESSION_RENEWAL_CLOCK;
    const controller = new AbortController();
    let expectedExpiresAt = lease.sessionExpiresAt;
    let renewalError: SessionLeaseRenewalError | undefined;
    let cancelTimer: () => void = () => undefined;
    let stopped = false;
    const parentAbort = () => {
      controller.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) parentAbort();
    else parentSignal.addEventListener("abort", parentAbort, { once: true });
    const schedule = () => {
      const expiry = Date.parse(expectedExpiresAt);
      if (!Number.isFinite(expiry)) {
        renewalError = new SessionLeaseRenewalError({
          cause: new Error("Session Lease 만료 시각이 유효하지 않습니다"),
        });
        controller.abort(renewalError);
        return;
      }
      const delay = Math.max(MINIMUM_SESSION_RENEW_DELAY_MS, Math.floor((expiry - clock.now()) / 2));
      cancelTimer = clock.schedule(delay, async () => {
        if (stopped) return;
        try {
          expectedExpiresAt = await lease.renewSession({
            commandId: `${executionId}:subscription:${lease.attemptId}:renew:${expectedExpiresAt}`,
            expectedExpiresAt,
          });
          const shouldContinue = (): boolean => !stopped;
          if (shouldContinue()) schedule();
        } catch (error) {
          renewalError = new SessionLeaseRenewalError({ cause: error });
          controller.abort(renewalError);
        }
      });
    };
    schedule();
    return {
      signal: controller.signal,
      error: () => renewalError,
      stop: () => {
        stopped = true;
        cancelTimer();
        parentSignal.removeEventListener("abort", parentAbort);
      },
    };
  }

  private async settleAgentRuntimeResult(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    result: RoutedAgentRuntimeResult,
    allowFallback = true,
  ): Promise<AgentRuntimeAttemptOutcome> {
    const settlementCommand = this.subscriptionSettlementCommand(executionId, lease);
    if (result.executionId !== executionId) {
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "interrupted",
        providerExecutionId: executionId,
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "unknown" },
      });
      await lease.fail({
        commandId: settlementCommand,
        signal: { kind: "unknown" },
        emittedTokens: 0,
        sideEffectsStarted: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const interrupted = await this.toTerminalIfRunning(context, executionId, "interrupted", {
        category: "provider-execution-mismatch",
        attemptId: lease.attemptId,
        sessionLeaseId: lease.sessionLeaseId,
      });
      return { kind: "terminal", result: this.resultFromExecution(interrupted.execution) };
    }
    if (result.outcome === "completed") {
      this.suspendedSubscriptions.delete(executionId);
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "completed",
        providerExecutionId: executionId,
        providerSessionId: result.sessionId,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        },
        output: { kind: "inline", value: result.value as JsonValue },
      });
      await lease.complete({
        commandId: settlementCommand,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const current = await this.store.getRecovery(context, executionId);
      await this.store.transition(context, {
        commandId: `${executionId}:succeeded`,
        executionId,
        expectedVersion: current.execution.version,
        target: "succeeded",
        payload: {
          output: result.value,
          attemptId: lease.attemptId,
          sessionLeaseId: lease.sessionLeaseId,
          providerSessionId: result.sessionId,
        },
      });
      return { kind: "terminal", result: { executionId, status: "succeeded", output: result.value } };
    }
    if (result.outcome === "suspended") {
      this.suspendedSubscriptions.set(executionId, {
        context,
        lease,
        sessionId: result.sessionId,
        approvalId: result.approvalId,
      });
      await this.recordSubscriptionCheckpoint(context, executionId, lease, result.sessionId, result.approvalId);
      const current = await this.store.getRecovery(context, executionId);
      await this.store.transition(context, {
        commandId: `${executionId}:suspended`,
        executionId,
        expectedVersion: current.execution.version,
        target: "suspended",
        payload: {
          attemptId: lease.attemptId,
          sessionLeaseId: lease.sessionLeaseId,
          providerSessionId: result.sessionId,
          approvalId: result.approvalId,
        },
      });
      return { kind: "terminal", result: { executionId, status: "suspended" } };
    }
    if (result.outcome === "cancelled") {
      this.suspendedSubscriptions.delete(executionId);
      await this.recordSubscriptionTerminal(context, executionId, lease, {
        outcome: "cancelled",
        providerExecutionId: executionId,
        ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "cancelled" },
      });
      await lease.fail({
        commandId: settlementCommand,
        signal: { kind: "cancelled" },
        emittedTokens: 0,
        sideEffectsStarted: true,
        inputTokens: 0,
        outputTokens: 0,
      });
      await this.recordSubscriptionSettled(context, executionId, lease);
      const cancelled = await this.toTerminalIfRunning(context, executionId, "cancelled", {
        attemptId: lease.attemptId,
        sessionLeaseId: lease.sessionLeaseId,
        ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
      });
      return { kind: "terminal", result: this.resultFromExecution(cancelled.execution) };
    }
    await this.recordSubscriptionTerminal(context, executionId, lease, {
      outcome: "failed",
      providerExecutionId: executionId,
      ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
      usage: { inputTokens: 0, outputTokens: result.emittedTokens },
      emittedTokens: result.emittedTokens,
      sideEffectsStarted: result.sideEffectsStarted,
      signal: result.signal,
    });
    const failed = await lease.fail({
      commandId: settlementCommand,
      signal: result.signal,
      emittedTokens: result.emittedTokens,
      sideEffectsStarted: result.sideEffectsStarted,
      inputTokens: 0,
      outputTokens: result.emittedTokens,
    });
    await this.recordSubscriptionSettled(context, executionId, lease);
    this.suspendedSubscriptions.delete(executionId);
    if (allowFallback && failed.fallbackAllowed && result.emittedTokens === 0 && !result.sideEffectsStarted) {
      return { kind: "fallback" };
    }
    const target = result.emittedTokens > 0 || result.sideEffectsStarted ? "interrupted" : "failed";
    const terminal = await this.toTerminalIfRunning(context, executionId, target, {
      category: result.category,
      retryable: result.retryable,
      attemptId: lease.attemptId,
      sessionLeaseId: lease.sessionLeaseId,
      ...(result.sessionId ? { providerSessionId: result.sessionId } : {}),
    });
    return { kind: "terminal", result: this.resultFromExecution(terminal.execution) };
  }

  private subscriptionLineage(executionId: string, lease: RoutedAgentRuntimeLease): SubscriptionReceiptLineage {
    return {
      executionId,
      workId: lease.subscription.workId,
      agentHandle: lease.subscription.agentHandle,
      routeAttemptId: lease.attemptId,
      leaseId: lease.sessionLeaseId,
      accountId: lease.subscription.accountId,
      connectorId: lease.subscription.connectorId,
      adapterId: lease.subscription.adapterId,
      ...(lease.subscription.quotaSnapshotId ? { quotaSnapshotId: lease.subscription.quotaSnapshotId } : {}),
    };
  }

  private async recordSubscriptionInvocationStarted(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    const lineage = this.subscriptionLineage(executionId, lease);
    await receipts.recordRouteSessionAcquired(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:acquired`,
      ...lineage,
    });
    await receipts.recordInvocationStarted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:started`,
      ...lineage,
    });
  }

  private async recordSubscriptionCheckpoint(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    sessionId: string,
    approvalId: string,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordCheckpointObserved(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:checkpoint:${digestCommandId(approvalId)}`,
      ...this.subscriptionLineage(executionId, lease),
      sessionId,
      approvalId,
    });
  }

  private async recordSubscriptionTerminal(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    terminal: ReceiptTerminalDetails,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    const input = {
      commandId: `${executionId}:subscription:${lease.attemptId}:terminal`,
      ...this.subscriptionLineage(executionId, lease),
      ...terminal,
    };
    if (terminal.outcome === "completed") await receipts.recordTerminalObserved(context, input);
    else await receipts.recordTerminalObserved(context, input);
  }

  private async recordSubscriptionSettled(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordSettlementCompleted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:settled`,
      ...this.subscriptionLineage(executionId, lease),
    });
  }

  private subscriptionSettlementCommand(executionId: string, lease: RoutedAgentRuntimeLease): string {
    return `${executionId}:subscription:${lease.attemptId}:settlement:router`;
  }

  private async acquireInput(
    context: TenantContext,
    input: AgentExecutionInput,
    executionId: string,
    attempt: number,
    fallbackFromAttemptId?: string,
    fallbackFromLeaseId?: string,
  ): Promise<AcquireModelInput> {
    const resolved = await this.executionContext?.resolve(context, {
      executionId,
      workId: input.workId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentHandle: input.agentHandle,
    });
    return {
      commandId: `${executionId}:model:${String(attempt)}:reserve`,
      executionId,
      workId: input.workId,
      agentHandle: input.agentHandle,
      ...(resolved?.workspaceRoot ? { workspaceRoot: resolved.workspaceRoot } : {}),
      ...(resolved?.instruction ? { instruction: resolved.instruction } : {}),
      routeName: input.modelRoute,
      estimatedTokens: input.estimatedTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      stickyKey: `${input.workId}:${input.agentHandle}`,
      ...(fallbackFromAttemptId ? { fallbackFromAttemptId } : {}),
      ...(fallbackFromLeaseId ? { fallbackFromLeaseId } : {}),
    };
  }

  private agent(context: TenantContext, handle: string): Agent {
    const name = `${context.organizationId}:${handle}`;
    const agent = this.voltAgent.getAgents().find((candidate) => candidate.name === name);
    if (!agent) throw new Error(`활성 Runtime Agent를 찾을 수 없습니다: ${handle}`);
    return agent;
  }

  private async cancelActive(active: ActiveExecution, reason: string): Promise<void> {
    if (!active.controller.signal.aborted) active.controller.abort(reason);
    await active.done;
  }

  private activate(context: TenantContext, executionId: string): ActiveExecution {
    if (this.active.has(executionId)) throw new Error(`Runtime Execution이 이미 활성 상태입니다: ${executionId}`);
    const completion = deferred();
    const active = {
      context,
      controller: new AbortController(),
      done: completion.promise,
      resolveDone: completion.resolve,
    };
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

  private beginIntake(): () => void {
    this.requireAccepting();
    this.intakeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.intakeOperations -= 1;
      if (this.intakeOperations === 0) {
        this.intakeSettled?.resolve();
        this.intakeSettled = undefined;
      }
    };
  }

  private async waitForIntake(): Promise<void> {
    if (this.intakeOperations === 0) return;
    this.intakeSettled ??= deferred();
    await this.intakeSettled.promise;
  }

  private async shutdownOnce(reason: string): Promise<void> {
    await this.waitForIntake();
    while (this.active.size > 0 || this.suspendedSubscriptions.size > 0) {
      const contexts = new Map<string, TenantContext>();
      for (const [executionId, active] of this.active) contexts.set(executionId, active.context);
      for (const [executionId, suspended] of this.suspendedSubscriptions) {
        contexts.set(executionId, suspended.context);
      }
      const settled = await Promise.allSettled(
        [...contexts].map(async ([executionId, context]) => {
          await this.cancel(context, executionId, reason);
        }),
      );
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (failures.length > 0) throw new AggregateError(failures, "Runtime 실행 종료에 실패했습니다");
    }
  }

  private requireLifecycle(): AgentExecutionLifecycle {
    if (!this.lifecycle) throw new Error("Runtime workflow lifecycle이 구성되지 않았습니다");
    return this.lifecycle;
  }

  private async resumeSubscription(
    context: TenantContext,
    executionId: string,
    input: unknown,
    suspended: SuspendedSubscriptionExecution,
    releaseIntake: () => void,
  ): Promise<AgentExecutionResult> {
    const approvalId = this.subscriptionApprovalId(input);
    if (approvalId !== suspended.approvalId) throw new Error("구독 Agent 실행 승인 ID가 일치하지 않습니다");
    if (suspended.context.organizationId !== context.organizationId) {
      throw new Error("구독 Agent 실행 조직이 일치하지 않습니다");
    }
    const approvals = this.options.subscriptionApprovals;
    if (!approvals) throw new Error("구독 승인 정본 consumer가 구성되지 않았습니다");
    if (!suspended.lease.executor.resume) {
      throw new Error("선택한 구독 Agent runtime은 승인 재개를 지원하지 않습니다");
    }
    if (suspended.resumeAttempt) {
      releaseIntake();
      return await suspended.resumeAttempt;
    }
    const attempt = this.continueSubscriptionResume(context, executionId, suspended, approvals, releaseIntake);
    suspended.resumeAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (suspended.resumeAttempt === attempt) delete suspended.resumeAttempt;
    }
  }

  private async continueSubscriptionResume(
    context: TenantContext,
    executionId: string,
    suspended: SuspendedSubscriptionExecution,
    approvals: NonNullable<VoltAgentRunnerOptions["subscriptionApprovals"]>,
    releaseIntake: () => void,
  ): Promise<AgentExecutionResult> {
    const approvalId = suspended.approvalId;
    const resume = suspended.lease.executor.resume?.bind(suspended.lease.executor);
    if (!resume) throw new Error("선택한 구독 Agent runtime은 승인 재개를 지원하지 않습니다");
    const decision = suspended.approvalDecision ?? (await approvals.consume(context, { executionId, approvalId }));
    suspended.approvalDecision = decision;
    if (suspended.resumeExpectedVersion === undefined) {
      const current = await this.store.getRecovery(suspended.context, executionId);
      if (current.execution.status !== "suspended") {
        throw new Error("suspended 구독 Agent 실행만 재개할 수 있습니다");
      }
      suspended.resumeExpectedVersion = current.execution.version;
    }
    await this.store.transition(suspended.context, {
      commandId: `${executionId}:approval:${digestCommandId(approvalId)}:running`,
      executionId,
      expectedVersion: suspended.resumeExpectedVersion,
      target: "running",
      payload: { approvalId, approved: decision === "approved" },
    });
    await this.recordSubscriptionInvocationResumed(suspended.context, executionId, suspended.lease, approvalId);
    const active = this.activate(suspended.context, executionId);
    releaseIntake();
    const renewal = this.startSessionRenewal(executionId, suspended.lease, active.controller.signal);
    try {
      let result: RoutedAgentRuntimeResult;
      try {
        result = await resume({
          executionId,
          sessionId: suspended.sessionId,
          approvalId,
          approved: decision === "approved",
          abortSignal: renewal.signal,
        });
        const renewalError = renewal.error();
        if (renewalError) throw renewalError;
      } catch (error) {
        result = {
          outcome: "failed",
          executionId,
          sessionId: suspended.sessionId,
          category: error instanceof SessionLeaseRenewalError ? "session-renewal" : "resume",
          retryable: false,
          signal: failureSignal(error),
          emittedTokens: 0,
          sideEffectsStarted: true,
        };
      }
      const outcome = await this.settleAgentRuntimeResult(
        suspended.context,
        executionId,
        suspended.lease,
        result,
        false,
      );
      if (outcome.kind === "fallback") throw new Error("승인 재개 뒤에는 자동 fallback할 수 없습니다");
      return outcome.result;
    } finally {
      renewal.stop();
      this.finish(executionId);
    }
  }

  private subscriptionApprovalId(input: unknown): string {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error("구독 Agent 재개 입력에는 approvalId object가 필요합니다");
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.approvalId !== "string" || !record.approvalId.trim()) {
      throw new Error("구독 Agent 재개 입력은 approvalId만 허용합니다");
    }
    return record.approvalId;
  }

  private async recordSubscriptionInvocationResumed(
    context: TenantContext,
    executionId: string,
    lease: RoutedAgentRuntimeLease,
    approvalId: string,
  ): Promise<void> {
    const receipts = this.subscriptionReceipts;
    if (!receipts) return;
    await receipts.recordInvocationStarted(context, {
      commandId: `${executionId}:subscription:${lease.attemptId}:resumed:${digestCommandId(approvalId)}`,
      ...this.subscriptionLineage(executionId, lease),
    });
  }
}

function digestCommandId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
