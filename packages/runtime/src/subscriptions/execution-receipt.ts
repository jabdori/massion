import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type { FailureSignal, ReportFailureInput, ReportSuccessInput } from "@massion/router";
import type { ConnectorFailureSignal, ConnectorLeaseFailure, ConnectorSessionLeaseView } from "@massion/subscriptions";

import type { RuntimeExecution, RuntimeEvent } from "../execution-store.js";
import { RuntimeExecutionStore } from "../execution-store.js";

const RECEIPT_BYTE_LIMIT = 64 * 1024;
const RECEIPT_EVENT_TYPES = new Set([
  "subscription_route_session_acquired",
  "subscription_invocation_started",
  "subscription_checkpoint_observed",
  "subscription_terminal_observed",
  "subscription_settlement_completed",
]);

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type SubscriptionTerminalOutput =
  | { readonly kind: "inline"; readonly value: JsonValue }
  | { readonly kind: "artifact"; readonly artifactVersionId: string; readonly checksum: string };

export interface SubscriptionReceiptLineage {
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly routeAttemptId: string;
  readonly leaseId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly adapterId: string;
  readonly quotaSnapshotId?: string;
}

interface ReceiptCommand {
  readonly commandId: string;
}

export type RecordRouteSessionAcquiredInput = ReceiptCommand & SubscriptionReceiptLineage;
export type RecordInvocationStartedInput = ReceiptCommand & SubscriptionReceiptLineage;

export type RecordTerminalObservedInput =
  | (ReceiptCommand &
      SubscriptionReceiptLineage & {
        readonly providerExecutionId: string;
        readonly providerSessionId?: string;
        readonly outcome: "completed";
        readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
        readonly output: SubscriptionTerminalOutput;
      })
  | (ReceiptCommand &
      SubscriptionReceiptLineage & {
        readonly providerExecutionId: string;
        readonly providerSessionId?: string;
        readonly outcome: "failed" | "cancelled" | "interrupted";
        readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
        readonly emittedTokens: number;
        readonly sideEffectsStarted: boolean;
        readonly signal: FailureSignal;
      });

export type RecordCheckpointObservedInput = ReceiptCommand &
  SubscriptionReceiptLineage & {
    readonly sessionId: string;
    readonly approvalId: string;
  };

export type RecordSettlementCompletedInput = ReceiptCommand & SubscriptionReceiptLineage;

export interface SubscriptionReceiptLease extends ConnectorSessionLeaseView {
  complete(input: { readonly commandId: string }): Promise<ConnectorSessionLeaseView | { readonly status: string }>;
  fail(input: {
    readonly commandId: string;
    readonly emittedTokens: number;
    readonly sideEffectsStarted: boolean;
    readonly signal: ConnectorFailureSignal;
  }): Promise<ConnectorLeaseFailure>;
}

export interface SubscriptionReceiptBroker {
  getLease(context: TenantContext, leaseId: string): Promise<SubscriptionReceiptLease>;
  findExecutionLeases?(context: TenantContext, executionId: string): Promise<readonly SubscriptionReceiptLease[]>;
}

export interface SubscriptionReceiptRouter {
  reportSuccess(context: TenantContext, input: ReportSuccessInput): Promise<unknown>;
  reportFailure(context: TenantContext, input: ReportFailureInput): Promise<unknown>;
}

export interface SubscriptionReceiptCheckpoint {
  readonly adapterId: string;
  readonly sessionId: string;
  readonly approvalId: string;
}

export interface SubscriptionReceiptTerminal {
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly providerExecutionId: string;
  readonly providerSessionId?: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly emittedTokens: number;
  readonly sideEffectsStarted: boolean;
  readonly signal?: FailureSignal;
  readonly output?: SubscriptionTerminalOutput;
  readonly outputChecksum?: string;
}

export interface SubscriptionReceiptAttempt {
  readonly lineage: SubscriptionReceiptLineage;
  readonly acquired: boolean;
  readonly started: boolean;
  readonly checkpoint?: SubscriptionReceiptCheckpoint;
  readonly terminal?: SubscriptionReceiptTerminal;
  readonly settled: boolean;
}

export interface SubscriptionExecutionReceiptSnapshot {
  readonly execution: RuntimeExecution;
  readonly attempts: readonly SubscriptionReceiptAttempt[];
  readonly terminal?: SubscriptionReceiptTerminal;
  readonly settled?: true;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}이 유효하지 않습니다`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}이 유효하지 않습니다`);
  return normalized;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}이 유효하지 않습니다`);
  return Number(value);
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Subscription Receipt JSON number가 유효하지 않습니다");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Subscription Receipt JSON에 순환 참조가 있습니다");
    ancestors.add(value);
    const encoded = `[${value.map((child) => canonicalJson(child, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (ancestors.has(value)) throw new Error("Subscription Receipt JSON에 순환 참조가 있습니다");
    ancestors.add(value);
    const encoded = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => {
        if (child === undefined) throw new Error("Subscription Receipt JSON에 undefined가 있습니다");
        return `${JSON.stringify(key)}:${canonicalJson(child, ancestors)}`;
      })
      .join(",")}}`;
    ancestors.delete(value);
    return encoded;
  }
  throw new Error("Subscription Receipt 결과는 JSON-safe 값이어야 합니다");
}

function boundedPayload<T extends Readonly<Record<string, unknown>>>(payload: T): T {
  const bytes = Buffer.byteLength(canonicalJson(payload));
  if (bytes > RECEIPT_BYTE_LIMIT) throw new Error("Subscription Receipt payload byte 상한을 초과했습니다");
  return payload;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function lineagePayload(input: SubscriptionReceiptLineage): SubscriptionReceiptLineage {
  return {
    executionId: text(input.executionId, "Execution ID"),
    workId: text(input.workId, "Work ID"),
    agentHandle: text(input.agentHandle, "Agent handle"),
    routeAttemptId: text(input.routeAttemptId, "Route Attempt ID"),
    leaseId: text(input.leaseId, "Session Lease ID"),
    accountId: text(input.accountId, "Subscription Account ID"),
    connectorId: text(input.connectorId, "Connector ID"),
    adapterId: text(input.adapterId, "Subscription Adapter ID"),
    ...(input.quotaSnapshotId ? { quotaSnapshotId: text(input.quotaSnapshotId, "Quota Snapshot ID") } : {}),
  };
}

function parsePayload(event: RuntimeEvent): Record<string, unknown> {
  try {
    const value = JSON.parse(event.payload_json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object가 아닙니다");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Subscription Receipt payload가 손상됐습니다: ${event.event_id}`, { cause: error });
  }
}

function parseLineage(payload: Record<string, unknown>): SubscriptionReceiptLineage {
  const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");
  return lineagePayload({
    executionId: stringValue(payload.executionId),
    workId: stringValue(payload.workId),
    agentHandle: stringValue(payload.agentHandle),
    routeAttemptId: stringValue(payload.routeAttemptId),
    leaseId: stringValue(payload.leaseId),
    accountId: stringValue(payload.accountId),
    connectorId: stringValue(payload.connectorId),
    adapterId: stringValue(payload.adapterId),
    ...(typeof payload.quotaSnapshotId === "string" ? { quotaSnapshotId: payload.quotaSnapshotId } : {}),
  });
}

function sameLineage(left: SubscriptionReceiptLineage, right: SubscriptionReceiptLineage): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function connectorSignal(signal: FailureSignal): ConnectorFailureSignal {
  if (signal.kind === "timeout") return { kind: "timeout" };
  if (signal.kind === "network") return { kind: "provider-unavailable" };
  if (signal.kind === "cancelled") return { kind: "cancelled" };
  if (signal.kind !== "http" || signal.statusCode === undefined) return { kind: "invalid-request" };
  if (signal.statusCode === 401) return { kind: "authentication" };
  if (signal.statusCode === 408) return { kind: "timeout" };
  if (signal.statusCode === 429) return { kind: "rate-limit" };
  if (signal.statusCode >= 500) return { kind: "provider-unavailable" };
  return { kind: "invalid-request" };
}

export class SubscriptionExecutionReceiptCoordinator {
  public constructor(
    private readonly store: RuntimeExecutionStore,
    private readonly router: SubscriptionReceiptRouter,
    private readonly broker: SubscriptionReceiptBroker,
  ) {}

  public async recordRouteSessionAcquired(
    context: TenantContext,
    input: RecordRouteSessionAcquiredInput,
  ): Promise<void> {
    const lineage = await this.requireRuntimeLineage(context, input);
    await this.append(context, input.commandId, lineage, "subscription_route_session_acquired", { ...lineage });
  }

  public async recordInvocationStarted(context: TenantContext, input: RecordInvocationStartedInput): Promise<void> {
    const lineage = await this.requireRuntimeLineage(context, input);
    await this.append(context, input.commandId, lineage, "subscription_invocation_started", { ...lineage });
  }

  public async recordCheckpointObserved(context: TenantContext, input: RecordCheckpointObservedInput): Promise<void> {
    const lineage = await this.requireRuntimeLineage(context, input);
    const payload = boundedPayload({
      ...lineage,
      sessionId: text(input.sessionId, "Provider Session ID"),
      approvalId: text(input.approvalId, "Approval ID"),
    });
    await this.append(context, input.commandId, lineage, "subscription_checkpoint_observed", payload);
  }

  public async recordTerminalObserved(context: TenantContext, input: RecordTerminalObservedInput): Promise<void> {
    const lineage = await this.requireRuntimeLineage(context, input);
    if (text(input.providerExecutionId, "Provider Execution ID") !== lineage.executionId) {
      throw new Error("Provider Execution ID가 Runtime Execution ID와 일치하지 않습니다");
    }
    const usage = {
      inputTokens: nonnegativeInteger(input.usage.inputTokens, "입력 token 수"),
      outputTokens: nonnegativeInteger(input.usage.outputTokens, "출력 token 수"),
    };
    const providerSessionId = input.providerSessionId
      ? text(input.providerSessionId, "Provider Session ID")
      : undefined;
    const payload =
      input.outcome === "completed"
        ? boundedPayload({
            ...lineage,
            providerExecutionId: input.providerExecutionId,
            ...(providerSessionId ? { providerSessionId } : {}),
            outcome: input.outcome,
            usage,
            emittedTokens: usage.outputTokens,
            sideEffectsStarted: true,
            output: input.output,
            outputChecksum: checksum(input.output),
          })
        : boundedPayload({
            ...lineage,
            providerExecutionId: input.providerExecutionId,
            ...(providerSessionId ? { providerSessionId } : {}),
            outcome: input.outcome,
            usage,
            emittedTokens: nonnegativeInteger(input.emittedTokens, "방출 token 수"),
            sideEffectsStarted: input.sideEffectsStarted,
            signal: input.signal,
          });
    await this.append(context, input.commandId, lineage, "subscription_terminal_observed", payload);
  }

  public async recordSettlementCompleted(context: TenantContext, input: RecordSettlementCompletedInput): Promise<void> {
    const lineage = await this.requireRuntimeLineage(context, input);
    await this.append(context, input.commandId, lineage, "subscription_settlement_completed", {
      ...lineage,
      routerCommandId: this.routerSettlementCommand(lineage),
      leaseCommandId: this.leaseSettlementCommand(lineage),
    });
  }

  public async read(context: TenantContext, executionId: string): Promise<SubscriptionExecutionReceiptSnapshot> {
    const recovery = await this.store.getRecovery(context, text(executionId, "Execution ID"));
    const receiptEvents = recovery.events.filter((event) => RECEIPT_EVENT_TYPES.has(event.event_type));
    const attempts: Array<{
      lineage: SubscriptionReceiptLineage;
      acquired: boolean;
      started: boolean;
      checkpoint?: SubscriptionReceiptCheckpoint;
      terminal?: SubscriptionReceiptTerminal;
      settled: boolean;
    }> = [];
    const byLineage = new Map<string, (typeof attempts)[number]>();
    for (const event of receiptEvents) {
      const payload = parsePayload(event);
      const lineage = parseLineage(payload);
      if (lineage.executionId !== recovery.execution.execution_id) {
        throw new Error("Subscription Receipt Execution 계보가 일치하지 않습니다");
      }
      const key = `${lineage.routeAttemptId}\u0000${lineage.leaseId}`;
      let attempt = byLineage.get(key);
      if (!attempt) {
        attempt = { lineage, acquired: false, started: false, settled: false };
        byLineage.set(key, attempt);
        attempts.push(attempt);
      } else if (!sameLineage(attempt.lineage, lineage)) {
        throw new Error("Subscription Receipt 계보가 중간에 변경됐습니다");
      }
      if (event.event_type === "subscription_route_session_acquired") attempt.acquired = true;
      if (event.event_type === "subscription_invocation_started") attempt.started = true;
      if (event.event_type === "subscription_checkpoint_observed") {
        attempt.checkpoint = {
          adapterId: lineage.adapterId,
          sessionId: text(payload.sessionId, "Provider Session ID"),
          approvalId: text(payload.approvalId, "Approval ID"),
        };
      }
      if (event.event_type === "subscription_terminal_observed") attempt.terminal = this.parseTerminal(payload);
      if (event.event_type === "subscription_settlement_completed") attempt.settled = true;
    }
    const latest = attempts.at(-1);
    return {
      execution: recovery.execution,
      attempts,
      ...(latest?.terminal ? { terminal: latest.terminal } : {}),
      ...(latest?.settled ? { settled: true as const } : {}),
    };
  }

  public async recover(context: TenantContext, executionId: string): Promise<RuntimeExecution> {
    let snapshot = await this.read(context, executionId);
    if (snapshot.attempts.length === 0) {
      snapshot = await this.recoverUnjournaledLease(context, snapshot);
    }
    const attempt = snapshot.attempts.at(-1);
    if (!attempt?.acquired || !attempt.started) return snapshot.execution;
    if (attempt.checkpoint && !attempt.terminal) return await this.toSuspended(context, attempt, snapshot.execution);
    if (!attempt.terminal) {
      await this.recordTerminalObserved(context, {
        commandId: `${attempt.lineage.executionId}:subscription:${attempt.lineage.routeAttemptId}:recovery-terminal`,
        ...attempt.lineage,
        providerExecutionId: attempt.lineage.executionId,
        outcome: "interrupted",
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "unknown" },
      });
      snapshot = await this.read(context, executionId);
    }
    const observed = snapshot.attempts.at(-1);
    if (!observed?.terminal) throw new Error("Subscription terminal receipt를 복구하지 못했습니다");
    if (!observed.settled) {
      await this.settle(context, observed);
      snapshot = await this.read(context, executionId);
    }
    const settled = snapshot.attempts.at(-1);
    if (!settled?.terminal || !settled.settled)
      throw new Error("Subscription settlement receipt를 복구하지 못했습니다");
    return await this.toRuntimeTerminal(context, settled, snapshot.execution);
  }

  public async interruptSuspended(context: TenantContext, executionId: string): Promise<RuntimeExecution> {
    let snapshot = await this.read(context, executionId);
    let attempt = snapshot.attempts.at(-1);
    if (!attempt?.checkpoint) throw new Error("중단 정산할 Subscription checkpoint가 없습니다");
    if (snapshot.execution.status === "suspended") {
      await this.store.transition(context, {
        commandId: `${executionId}:subscription:${attempt.lineage.routeAttemptId}:restart-running`,
        executionId,
        expectedVersion: snapshot.execution.version,
        target: "running",
        payload: { recovery: "live-provider-process-unavailable" },
      });
      snapshot = await this.read(context, executionId);
      attempt = snapshot.attempts.at(-1);
    }
    if (!attempt?.checkpoint) throw new Error("재시작 중단 checkpoint 계보를 다시 읽지 못했습니다");
    if (!attempt.terminal) {
      await this.recordTerminalObserved(context, {
        commandId: `${attempt.lineage.executionId}:subscription:${attempt.lineage.routeAttemptId}:restart-interrupted`,
        ...attempt.lineage,
        providerExecutionId: attempt.lineage.executionId,
        providerSessionId: attempt.checkpoint.sessionId,
        outcome: "interrupted",
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: true,
        signal: { kind: "unknown" },
      });
      snapshot = await this.read(context, executionId);
      attempt = snapshot.attempts.at(-1);
    }
    if (!attempt?.terminal) throw new Error("재시작 중단 terminal receipt를 기록하지 못했습니다");
    if (!attempt.settled) {
      await this.settle(context, attempt);
      snapshot = await this.read(context, executionId);
      attempt = snapshot.attempts.at(-1);
    }
    if (!attempt?.terminal || !attempt.settled) throw new Error("재시작 중단 정산을 완료하지 못했습니다");
    return await this.toRuntimeTerminal(context, attempt, snapshot.execution);
  }

  private async recoverUnjournaledLease(
    context: TenantContext,
    snapshot: SubscriptionExecutionReceiptSnapshot,
  ): Promise<SubscriptionExecutionReceiptSnapshot> {
    const leases = await this.broker.findExecutionLeases?.(context, snapshot.execution.execution_id);
    const lease = leases?.at(-1);
    if (!lease) return snapshot;
    const lineage: SubscriptionReceiptLineage = {
      executionId: lease.executionId,
      workId: lease.workId,
      agentHandle: lease.agentHandle,
      routeAttemptId: lease.routeAttemptId,
      leaseId: lease.leaseId,
      accountId: lease.accountId,
      connectorId: lease.connectorId,
      adapterId: text(lease.adapterId, "복구 Session Lease Runtime Adapter ID"),
      ...(lease.quotaSnapshotId ? { quotaSnapshotId: lease.quotaSnapshotId } : {}),
    };
    await this.recordRouteSessionAcquired(context, {
      commandId: `${lineage.executionId}:subscription:${lineage.routeAttemptId}:recovery-acquired`,
      ...lineage,
    });
    await this.recordInvocationStarted(context, {
      commandId: `${lineage.executionId}:subscription:${lineage.routeAttemptId}:recovery-started`,
      ...lineage,
    });
    return await this.read(context, lineage.executionId);
  }

  private async append(
    context: TenantContext,
    commandId: string,
    lineage: SubscriptionReceiptLineage,
    eventType:
      | "subscription_route_session_acquired"
      | "subscription_invocation_started"
      | "subscription_checkpoint_observed"
      | "subscription_terminal_observed"
      | "subscription_settlement_completed",
    payload: Readonly<Record<string, unknown>> & SubscriptionReceiptLineage,
  ): Promise<void> {
    await this.store.appendSubscriptionReceipt(context, {
      commandId: text(commandId, "Receipt Command ID"),
      executionId: lineage.executionId,
      eventType,
      payload: boundedPayload({ ...payload, routeAttemptId: lineage.routeAttemptId, leaseId: lineage.leaseId }),
    });
  }

  private async requireRuntimeLineage(
    context: TenantContext,
    input: SubscriptionReceiptLineage,
  ): Promise<SubscriptionReceiptLineage> {
    const lineage = lineagePayload(input);
    const recovery = await this.store.getRecovery(context, lineage.executionId);
    if (recovery.execution.work_id !== lineage.workId || recovery.execution.agent_handle !== lineage.agentHandle) {
      throw new Error("Subscription Receipt Work·Agent 계보가 Runtime Execution과 일치하지 않습니다");
    }
    return lineage;
  }

  private parseTerminal(payload: Record<string, unknown>): SubscriptionReceiptTerminal {
    const outcome = payload.outcome;
    if (!new Set(["completed", "failed", "cancelled", "interrupted"]).has(String(outcome))) {
      throw new Error("Subscription terminal outcome이 유효하지 않습니다");
    }
    const usageValue = payload.usage;
    if (!usageValue || typeof usageValue !== "object" || Array.isArray(usageValue)) {
      throw new Error("Subscription terminal usage가 유효하지 않습니다");
    }
    const usage = usageValue as Record<string, unknown>;
    const terminal: SubscriptionReceiptTerminal = {
      outcome: outcome as SubscriptionReceiptTerminal["outcome"],
      providerExecutionId: text(payload.providerExecutionId, "Provider Execution ID"),
      ...(typeof payload.providerSessionId === "string" ? { providerSessionId: payload.providerSessionId } : {}),
      usage: {
        inputTokens: nonnegativeInteger(usage.inputTokens, "입력 token 수"),
        outputTokens: nonnegativeInteger(usage.outputTokens, "출력 token 수"),
      },
      emittedTokens: nonnegativeInteger(payload.emittedTokens, "방출 token 수"),
      sideEffectsStarted: payload.sideEffectsStarted === true,
      ...(payload.signal ? { signal: payload.signal as FailureSignal } : {}),
      ...(payload.output ? { output: payload.output as SubscriptionTerminalOutput } : {}),
      ...(typeof payload.outputChecksum === "string" ? { outputChecksum: payload.outputChecksum } : {}),
    };
    if (terminal.providerExecutionId !== String(payload.executionId)) {
      throw new Error("Provider Execution ID가 Receipt Execution ID와 일치하지 않습니다");
    }
    if (terminal.output && terminal.outputChecksum !== checksum(terminal.output)) {
      throw new Error("Subscription terminal output checksum이 일치하지 않습니다");
    }
    return terminal;
  }

  private async settle(context: TenantContext, attempt: SubscriptionReceiptAttempt): Promise<void> {
    const terminal = attempt.terminal;
    if (!terminal) throw new Error("정산할 Subscription terminal receipt가 없습니다");
    const lineage = attempt.lineage;
    const lease = await this.broker.getLease(context, lineage.leaseId);
    if (
      lease.executionId !== lineage.executionId ||
      lease.routeAttemptId !== lineage.routeAttemptId ||
      lease.accountId !== lineage.accountId ||
      lease.connectorId !== lineage.connectorId ||
      lease.workId !== lineage.workId ||
      lease.agentHandle !== lineage.agentHandle ||
      lease.quotaSnapshotId !== lineage.quotaSnapshotId
    ) {
      throw new Error("Subscription settlement Session Lease 계보가 일치하지 않습니다");
    }
    if (terminal.outcome === "completed") {
      await this.router.reportSuccess(context, {
        commandId: this.routerSettlementCommand(lineage),
        attemptId: lineage.routeAttemptId,
        actualInputTokens: terminal.usage.inputTokens,
        actualOutputTokens: terminal.usage.outputTokens,
        actualCostMicros: 0,
      });
      await lease.complete({ commandId: this.leaseSettlementCommand(lineage) });
    } else {
      const signal = terminal.signal ?? { kind: "unknown" as const };
      await this.router.reportFailure(context, {
        commandId: this.routerSettlementCommand(lineage),
        attemptId: lineage.routeAttemptId,
        signal,
        emittedTokens: terminal.emittedTokens,
        sideEffectsStarted: terminal.sideEffectsStarted,
        actualInputTokens: terminal.usage.inputTokens,
        actualOutputTokens: terminal.usage.outputTokens,
        actualCostMicros: 0,
      });
      await lease.fail({
        commandId: this.leaseSettlementCommand(lineage),
        emittedTokens: terminal.emittedTokens,
        sideEffectsStarted: terminal.sideEffectsStarted,
        signal: connectorSignal(signal),
      });
    }
    await this.recordSettlementCompleted(context, {
      commandId: `${lineage.executionId}:subscription:${lineage.routeAttemptId}:settled`,
      ...lineage,
    });
  }

  private async toSuspended(
    context: TenantContext,
    attempt: SubscriptionReceiptAttempt,
    execution: RuntimeExecution,
  ): Promise<RuntimeExecution> {
    if (execution.status === "suspended") return execution;
    if (execution.status !== "running") throw new Error("Subscription checkpoint와 Runtime 상태가 일치하지 않습니다");
    const latest = await this.store.getRecovery(context, execution.execution_id);
    const transitioned = await this.store.transition(context, {
      commandId: `${execution.execution_id}:subscription:${attempt.lineage.routeAttemptId}:suspended`,
      executionId: execution.execution_id,
      expectedVersion: latest.execution.version,
      target: "suspended",
      payload: {
        attemptId: attempt.lineage.routeAttemptId,
        sessionLeaseId: attempt.lineage.leaseId,
        checkpoint: attempt.checkpoint,
      },
    });
    return transitioned.execution;
  }

  private async toRuntimeTerminal(
    context: TenantContext,
    attempt: SubscriptionReceiptAttempt,
    execution: RuntimeExecution,
  ): Promise<RuntimeExecution> {
    const terminal = attempt.terminal;
    if (!terminal) throw new Error("Runtime에 투영할 Subscription terminal receipt가 없습니다");
    const target =
      terminal.outcome === "completed"
        ? "succeeded"
        : terminal.outcome === "cancelled"
          ? "cancelled"
          : terminal.outcome === "interrupted" || terminal.emittedTokens > 0 || terminal.sideEffectsStarted
            ? "interrupted"
            : "failed";
    if (execution.status === target) return execution;
    if (execution.status !== "running") {
      throw new Error(
        `Subscription terminal receipt와 Runtime 상태가 일치하지 않습니다: ${execution.status} -> ${target}`,
      );
    }
    const latest = await this.store.getRecovery(context, execution.execution_id);
    if (latest.execution.status === target) return latest.execution;
    const output = terminal.output?.kind === "inline" ? terminal.output.value : terminal.output;
    const transitioned = await this.store.transition(context, {
      commandId: `${execution.execution_id}:subscription:${attempt.lineage.routeAttemptId}:execution:${target}`,
      executionId: execution.execution_id,
      expectedVersion: latest.execution.version,
      target,
      payload:
        target === "succeeded"
          ? {
              output,
              attemptId: attempt.lineage.routeAttemptId,
              sessionLeaseId: attempt.lineage.leaseId,
              ...(terminal.providerSessionId ? { providerSessionId: terminal.providerSessionId } : {}),
            }
          : {
              attemptId: attempt.lineage.routeAttemptId,
              sessionLeaseId: attempt.lineage.leaseId,
              outcome: terminal.outcome,
              signal: terminal.signal,
              sideEffectsStarted: terminal.sideEffectsStarted,
              emittedTokens: terminal.emittedTokens,
            },
    });
    return transitioned.execution;
  }

  private routerSettlementCommand(lineage: SubscriptionReceiptLineage): string {
    return `${lineage.executionId}:subscription:${lineage.routeAttemptId}:settlement:router`;
  }

  private leaseSettlementCommand(lineage: SubscriptionReceiptLineage): string {
    return `${this.routerSettlementCommand(lineage)}:session`;
  }
}
