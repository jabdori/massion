import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type { ModelProfile, RouteAttempt } from "@massion/router";
import type { RuntimeExecution, RuntimeEvent } from "@massion/runtime";

const RECEIPT_EVENT_TYPES = new Set([
  "subscription_route_session_acquired",
  "subscription_invocation_started",
  "subscription_checkpoint_observed",
  "subscription_terminal_observed",
  "subscription_settlement_completed",
]);

const ATTEMPT_STATUSES = new Set(["reserved", "failed", "interrupted", "succeeded"]);
const TERMINAL_OUTCOMES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const FAILURE_KINDS = new Set(["http", "timeout", "network", "input", "policy", "cancelled", "unknown"]);

interface RuntimeLineageReader {
  getRecovery(
    context: TenantContext,
    executionId: string,
  ): Promise<{ readonly execution: RuntimeExecution; readonly events: readonly RuntimeEvent[] }>;
}

interface RuntimeCorrelationLineageReader extends RuntimeLineageReader {
  listByCorrelation(context: TenantContext, correlationId: string): Promise<readonly RuntimeExecution[]>;
}

interface RouterLineageReader {
  readAttempt(context: TenantContext, attemptId: string): Promise<RouteAttempt>;
  listModels(context: TenantContext): Promise<readonly ModelProfile[]>;
}

interface ReceiptLineage {
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

interface ProjectedAttempt {
  readonly lineage: ReceiptLineage;
  acquired: boolean;
  started: boolean;
  settled: boolean;
  lastReceiptEventType?: string;
  approvalId?: string;
  terminal?: RuntimeSubscriptionTerminalView;
}

export interface RuntimeSubscriptionFailureView {
  readonly kind: "http" | "timeout" | "network" | "input" | "policy" | "cancelled" | "unknown";
  readonly statusCode?: number;
}

export interface RuntimeSubscriptionTerminalView {
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly emittedTokens: number;
  readonly sideEffectsStarted: boolean;
  readonly failure?: RuntimeSubscriptionFailureView;
}

export interface RuntimeSubscriptionAttemptLineageView {
  readonly attemptId: string;
  readonly sequence: number;
  readonly accountId: string;
  readonly credentialRef: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: "reserved" | "failed" | "interrupted" | "succeeded";
  readonly fallbackFromAttemptId?: string;
  readonly quotaSnapshotId?: string;
  readonly routingPolicyVersion?: number;
  readonly effectiveCredentialPolicy?: string;
  readonly subscriptionPolicyVersion?: number;
  readonly failureClass?: string;
  readonly statusCode?: number;
  readonly emittedTokens: number;
  readonly sideEffectsStarted: boolean;
  readonly fallbackAllowed: boolean;
  readonly lease: {
    readonly leaseId: string;
    readonly connectorId: string;
    readonly adapterId: string;
    readonly state: "acquired" | "started" | "checkpointed" | "terminal" | "settled";
  };
  readonly approvalId?: string;
  readonly terminal?: RuntimeSubscriptionTerminalView;
}

export interface RuntimeSubscriptionLineageView {
  readonly executionId: string;
  readonly status: RuntimeExecution["status"];
  readonly attempts: readonly RuntimeSubscriptionAttemptLineageView[];
}

export interface RuntimeSubscriptionCorrelationLineageView {
  readonly correlationId: string;
  readonly executions: readonly RuntimeSubscriptionLineageView[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}가 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}가 유효하지 않습니다`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return normalized;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}가 유효하지 않습니다`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label}가 유효하지 않습니다`);
  return parsed;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function httpStatus(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed < 100 || parsed > 599) throw new Error(`${label}가 유효하지 않습니다`);
  return parsed;
}

function parsePayload(event: RuntimeEvent): Record<string, unknown> {
  try {
    return record(JSON.parse(event.payload_json) as unknown, "구독 실행 영수증 payload");
  } catch (error) {
    throw new Error("구독 실행 영수증 payload를 해석할 수 없습니다", { cause: error });
  }
}

function lineage(payload: Record<string, unknown>): ReceiptLineage {
  return {
    executionId: identifier(payload.executionId, "실행 ID"),
    workId: identifier(payload.workId, "Work ID"),
    agentHandle: identifier(payload.agentHandle, "Agent handle"),
    routeAttemptId: identifier(payload.routeAttemptId, "Route Attempt ID"),
    leaseId: identifier(payload.leaseId, "Session Lease ID"),
    accountId: identifier(payload.accountId, "구독 계정 ID"),
    connectorId: identifier(payload.connectorId, "Connector ID"),
    adapterId: identifier(payload.adapterId, "Adapter ID"),
    ...(payload.quotaSnapshotId === undefined
      ? {}
      : { quotaSnapshotId: identifier(payload.quotaSnapshotId, "Quota Snapshot ID") }),
  };
}

function sameLineage(left: ReceiptLineage, right: ReceiptLineage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failure(value: unknown): RuntimeSubscriptionFailureView | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "구독 실행 실패 신호");
  if (!FAILURE_KINDS.has(String(source.kind))) throw new Error("구독 실행 실패 신호가 유효하지 않습니다");
  const kind = source.kind as RuntimeSubscriptionFailureView["kind"];
  if (kind !== "http") {
    if (source.statusCode !== undefined) throw new Error("HTTP가 아닌 실패 신호에 상태 코드가 있습니다");
    return { kind };
  }
  const statusCode = httpStatus(source.statusCode, "HTTP 상태 코드");
  return { kind, statusCode };
}

function terminal(payload: Record<string, unknown>): RuntimeSubscriptionTerminalView {
  if (!TERMINAL_OUTCOMES.has(String(payload.outcome))) throw new Error("구독 실행 terminal 결과가 유효하지 않습니다");
  const usage = record(payload.usage, "구독 실행 사용량");
  const outcome = payload.outcome as RuntimeSubscriptionTerminalView["outcome"];
  const projectedFailure = failure(payload.signal);
  if (outcome === "completed" && projectedFailure !== undefined) {
    throw new Error("완료된 구독 실행에 실패 신호가 있습니다");
  }
  return {
    outcome,
    inputTokens: nonnegativeInteger(usage.inputTokens, "입력 token"),
    outputTokens: nonnegativeInteger(usage.outputTokens, "출력 token"),
    emittedTokens: nonnegativeInteger(payload.emittedTokens, "외부 출력 token"),
    sideEffectsStarted: booleanValue(payload.sideEffectsStarted, "외부 side effect 여부"),
    ...(projectedFailure ? { failure: projectedFailure } : {}),
  };
}

function credentialRef(organizationId: string, credentialId: string): string {
  return createHash("sha256")
    .update("massion-public-credential-reference-v1\0")
    .update(organizationId)
    .update("\0")
    .update(credentialId)
    .digest("hex");
}

function leaseState(attempt: ProjectedAttempt): RuntimeSubscriptionAttemptLineageView["lease"]["state"] {
  if (attempt.settled) return "settled";
  if (attempt.terminal) return "terminal";
  if (attempt.approvalId) return "checkpointed";
  if (attempt.started) return "started";
  return "acquired";
}

function projectReceipts(execution: RuntimeExecution, events: readonly RuntimeEvent[]): readonly ProjectedAttempt[] {
  const attempts: ProjectedAttempt[] = [];
  const byAttempt = new Map<string, ProjectedAttempt>();
  let previousReceiptEventType: string | undefined;
  let previousSequence = 0;
  for (const event of events) {
    if (!RECEIPT_EVENT_TYPES.has(event.event_type)) continue;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
      throw new Error("구독 실행 영수증 sequence 순서가 유효하지 않습니다");
    }
    previousSequence = event.sequence;
    const payload = parsePayload(event);
    const parsedLineage = lineage(payload);
    if (
      parsedLineage.executionId !== execution.execution_id ||
      parsedLineage.workId !== execution.work_id ||
      parsedLineage.agentHandle !== execution.agent_handle
    ) {
      throw new Error("구독 실행 영수증의 Execution·Work·Agent 계보가 일치하지 않습니다");
    }
    let attempt = byAttempt.get(parsedLineage.routeAttemptId);
    if (!attempt) {
      if (event.event_type !== "subscription_route_session_acquired") {
        throw new Error("구독 실행 영수증이 Session 획득 사건으로 시작하지 않았습니다");
      }
      attempt = { lineage: parsedLineage, acquired: false, started: false, settled: false };
      byAttempt.set(parsedLineage.routeAttemptId, attempt);
      attempts.push(attempt);
    } else if (!sameLineage(attempt.lineage, parsedLineage)) {
      throw new Error("같은 Route Attempt의 구독 실행 계보가 변경됐습니다");
    }
    if (event.event_type === "subscription_route_session_acquired") {
      if (previousReceiptEventType !== undefined && previousReceiptEventType !== "subscription_settlement_completed") {
        throw new Error("허용되지 않는 구독 실행 영수증 순서: 이전 Attempt가 정산되지 않았습니다");
      }
      if (attempt.acquired) throw new Error("구독 Session 획득 사건이 중복됐습니다");
      attempt.acquired = true;
    } else {
      const allowedPrevious: Readonly<Record<string, readonly string[]>> = {
        subscription_invocation_started: ["subscription_route_session_acquired", "subscription_checkpoint_observed"],
        subscription_checkpoint_observed: ["subscription_invocation_started"],
        subscription_terminal_observed: ["subscription_invocation_started", "subscription_checkpoint_observed"],
        subscription_settlement_completed: ["subscription_terminal_observed"],
      };
      const expected = allowedPrevious[event.event_type];
      if (!expected?.includes(attempt.lastReceiptEventType ?? "")) {
        throw new Error(
          `허용되지 않는 구독 실행 영수증 순서: ${attempt.lastReceiptEventType ?? "none"} -> ${event.event_type}`,
        );
      }
    }
    if (event.event_type === "subscription_invocation_started") {
      attempt.started = true;
    } else if (event.event_type === "subscription_checkpoint_observed") {
      attempt.approvalId = identifier(payload.approvalId, "승인 ID");
    } else if (event.event_type === "subscription_terminal_observed") {
      attempt.terminal = terminal(payload);
    } else {
      attempt.settled = true;
    }
    attempt.lastReceiptEventType = event.event_type;
    previousReceiptEventType = event.event_type;
  }
  return attempts;
}

export async function runtimeSubscriptionLineage(
  context: TenantContext,
  executionId: string,
  runtime: RuntimeLineageReader,
  router: RouterLineageReader,
): Promise<RuntimeSubscriptionLineageView> {
  const normalizedExecutionId = identifier(executionId, "실행 ID");
  const recovery = await runtime.getRecovery(context, normalizedExecutionId);
  if (recovery.execution.execution_id !== normalizedExecutionId) {
    throw new Error("Runtime Execution 계보가 일치하지 않습니다");
  }
  const receipts = projectReceipts(recovery.execution, recovery.events);
  const models = await router.listModels(context);
  const views = await Promise.all(
    receipts.map(async (receipt): Promise<RuntimeSubscriptionAttemptLineageView> => {
      const attempt = await router.readAttempt(context, receipt.lineage.routeAttemptId);
      if (attempt.attempt_id !== receipt.lineage.routeAttemptId || !ATTEMPT_STATUSES.has(attempt.status)) {
        throw new Error("Route Attempt 계보 또는 상태가 유효하지 않습니다");
      }
      if (receipt.lineage.quotaSnapshotId !== attempt.quota_snapshot_id) {
        throw new Error("Route Attempt와 Session Lease의 Quota Snapshot 계보가 일치하지 않습니다");
      }
      const matchingModels = models.filter((model) => model.model_profile_id === attempt.model_profile_id);
      if (matchingModels.length !== 1 || !matchingModels[0]) {
        throw new Error("Route Attempt Model Profile 계보가 하나로 확정되지 않았습니다");
      }
      const model = matchingModels[0];
      return {
        attemptId: attempt.attempt_id,
        sequence: positiveInteger(attempt.selection_sequence, "Route Attempt 순서"),
        accountId: receipt.lineage.accountId,
        credentialRef: credentialRef(
          identifier(context.organizationId, "조직 ID"),
          identifier(attempt.credential_id, "Credential ID"),
        ),
        providerId: identifier(model.provider_id, "제공자 ID"),
        modelId: identifier(model.model_id, "모델 ID"),
        status: attempt.status as RuntimeSubscriptionAttemptLineageView["status"],
        ...(attempt.fallback_from_attempt_id
          ? { fallbackFromAttemptId: identifier(attempt.fallback_from_attempt_id, "이전 Route Attempt ID") }
          : {}),
        ...(attempt.quota_snapshot_id ? { quotaSnapshotId: attempt.quota_snapshot_id } : {}),
        ...(attempt.routing_policy_version === undefined
          ? {}
          : { routingPolicyVersion: positiveInteger(attempt.routing_policy_version, "Routing Policy version") }),
        ...(attempt.effective_credential_policy
          ? { effectiveCredentialPolicy: identifier(attempt.effective_credential_policy, "Credential Policy") }
          : {}),
        ...(attempt.subscription_policy_version === undefined
          ? {}
          : {
              subscriptionPolicyVersion: positiveInteger(attempt.subscription_policy_version, "구독 Policy version"),
            }),
        ...(attempt.failure_class ? { failureClass: identifier(attempt.failure_class, "실패 분류") } : {}),
        ...(attempt.status_code === undefined ? {} : { statusCode: httpStatus(attempt.status_code, "HTTP 상태 코드") }),
        emittedTokens: nonnegativeInteger(attempt.emitted_tokens, "외부 출력 token"),
        sideEffectsStarted: booleanValue(attempt.side_effects_started, "외부 side effect 여부"),
        fallbackAllowed: booleanValue(attempt.fallback_allowed, "Fallback 허용 여부"),
        lease: {
          leaseId: receipt.lineage.leaseId,
          connectorId: receipt.lineage.connectorId,
          adapterId: receipt.lineage.adapterId,
          state: leaseState(receipt),
        },
        ...(receipt.approvalId ? { approvalId: receipt.approvalId } : {}),
        ...(receipt.terminal ? { terminal: receipt.terminal } : {}),
      };
    }),
  );
  views.sort((left, right) => left.sequence - right.sequence || left.attemptId.localeCompare(right.attemptId));
  return { executionId: normalizedExecutionId, status: recovery.execution.status, attempts: views };
}

export async function runtimeSubscriptionLineagesByCorrelation(
  context: TenantContext,
  correlationId: string,
  runtime: RuntimeCorrelationLineageReader,
  router: RouterLineageReader,
): Promise<RuntimeSubscriptionCorrelationLineageView> {
  const normalizedCorrelationId = identifier(correlationId, "실행 상관관계 ID");
  const executions = await runtime.listByCorrelation(context, normalizedCorrelationId);
  const seen = new Set<string>();
  for (const execution of executions) {
    if (execution.correlation_id !== normalizedCorrelationId || seen.has(execution.execution_id)) {
      throw new Error("실행 상관관계와 Runtime Execution 계보가 일치하지 않습니다");
    }
    seen.add(execution.execution_id);
  }
  return {
    correlationId: normalizedCorrelationId,
    executions: await Promise.all(
      executions.map(
        async (execution) =>
          await runtimeSubscriptionLineage(context, identifier(execution.execution_id, "실행 ID"), runtime, router),
      ),
    ),
  };
}
