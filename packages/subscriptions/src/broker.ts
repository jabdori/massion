import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { type SubscriptionAccountService } from "./account-service.js";
import type { SubscriptionScope, SubscriptionSessionLease } from "./contracts.js";
import {
  SUBSCRIPTION_LEASE_EXECUTION_MIGRATION,
  SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION,
  SUBSCRIPTION_MIGRATION,
} from "./schema.js";

export interface AcquireSessionInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly scope: SubscriptionScope;
  readonly workId: string;
  readonly agentHandle: string;
  readonly routeAttemptId: string;
  readonly quotaSnapshotId?: string;
  readonly fallbackFromLeaseId?: string;
}

export interface ConnectorFailureSignal {
  readonly kind: "timeout" | "rate-limit" | "provider-unavailable" | "authentication" | "invalid-request" | "cancelled";
}

export interface ConnectorLeaseFailure {
  readonly status: "failed";
  readonly fallbackAllowed: boolean;
  readonly failureKind: ConnectorFailureSignal["kind"];
}

export interface ConnectorSessionLeaseView {
  readonly leaseId: string;
  readonly executionId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly adapterId?: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly routeAttemptId: string;
  readonly quotaSnapshotId?: string;
  readonly status: SubscriptionSessionLease["status"];
  readonly expiresAt: string;
}

export interface ConnectorSessionLease extends ConnectorSessionLeaseView {
  complete(input: { readonly commandId: string }): Promise<ConnectorSessionLeaseView>;
  fail(input: {
    readonly commandId: string;
    readonly emittedTokens: number;
    readonly sideEffectsStarted: boolean;
    readonly signal: ConnectorFailureSignal;
  }): Promise<ConnectorLeaseFailure>;
  renew(input: { readonly commandId: string; readonly expectedExpiresAt: string }): Promise<ConnectorSessionLeaseView>;
}

export interface ConnectorRequest {
  readonly protocol: "massion.connector.v1";
  readonly requestId: string;
  readonly leaseId: string;
  readonly operation: "generate" | "generate-structured" | "agent-turn" | "cancel" | "quota" | "health";
  readonly payload: unknown;
}

export interface ConnectorEvent {
  readonly kind: "data" | "usage" | "error" | "done";
  readonly sequence: number;
  readonly payload: unknown;
}

export interface ConnectorTransportDirectory {
  invoke(
    organizationId: string,
    connectorId: string,
    request: ConnectorRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ConnectorEvent>;
}

export interface SubscriptionConnectorBrokerOptions {
  readonly now?: () => Date;
  readonly leaseTtlMs?: number;
  readonly transport?: ConnectorTransportDirectory;
}

interface AuditRow {
  readonly actor_user_id: string;
  readonly event_type: string;
  readonly resource_id: string;
  readonly request_hash: string;
  readonly result_json: string;
}

function requireText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}이 유효하지 않습니다`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}이 유효하지 않습니다`);
  return normalized;
}

function requireSubscriptionScope(value: unknown): SubscriptionScope {
  if (value !== "personal" && value !== "organization") {
    throw new Error("Session Lease scope가 유효하지 않습니다");
  }
  return value;
}

const CONNECTOR_OPERATIONS = new Set(["generate", "generate-structured", "agent-turn", "cancel", "quota", "health"]);

function parseConnectorRequest(value: unknown): ConnectorRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector 요청이 유효하지 않습니다");
  }
  const request = value as Record<string, unknown>;
  if (request.protocol !== "massion.connector.v1") throw new Error("Connector 요청 protocol이 유효하지 않습니다");
  requireText(request.requestId, "Connector Request ID");
  requireText(request.leaseId, "Session Lease ID");
  if (typeof request.operation !== "string" || !CONNECTOR_OPERATIONS.has(request.operation)) {
    throw new Error("Connector 요청 operation이 유효하지 않습니다");
  }
  return request as unknown as ConnectorRequest;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function iso(value: unknown, label: string): string {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}이 유효하지 않습니다`);
  return date.toISOString();
}

function retryableBeforeOutput(kind: ConnectorFailureSignal["kind"]): boolean {
  return kind === "authentication" || kind === "timeout" || kind === "rate-limit" || kind === "provider-unavailable";
}

export class SubscriptionConnectorBroker {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly accounts: SubscriptionAccountService,
    private readonly now: () => Date,
    private readonly leaseTtlMs: number,
    private readonly transport: ConnectorTransportDirectory,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    accounts: SubscriptionAccountService,
    options: SubscriptionConnectorBrokerOptions = {},
  ): Promise<SubscriptionConnectorBroker> {
    const leaseTtlMs = options.leaseTtlMs ?? 300_000;
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 3_600_000) {
      throw new Error("Connector Session Lease TTL이 유효하지 않습니다");
    }
    await applyMigrations(database, [
      SUBSCRIPTION_MIGRATION,
      SUBSCRIPTION_LEASE_EXECUTION_MIGRATION,
      SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION,
    ]);
    const transport =
      options.transport ??
      ({
        invoke(): AsyncIterable<ConnectorEvent> {
          throw new Error("Connector transport가 연결되지 않았습니다");
        },
      } satisfies ConnectorTransportDirectory);
    return new SubscriptionConnectorBroker(
      database,
      organizations,
      accounts,
      options.now ?? (() => new Date()),
      leaseTtlMs,
      transport,
    );
  }

  public async acquire(context: TenantContext, input: AcquireSessionInput): Promise<ConnectorSessionLease> {
    const commandId = requireText(input.commandId, "Command ID");
    const executionId = requireText(input.executionId, "Execution ID");
    const accountId = requireText(input.accountId, "계정 ID");
    const connectorId = requireText(input.connectorId, "Connector ID");
    const scope = requireSubscriptionScope(input.scope);
    const workId = requireText(input.workId, "Work ID");
    const agentHandle = requireText(input.agentHandle, "Agent handle");
    const routeAttemptId = requireText(input.routeAttemptId, "Route Attempt ID");
    const quotaSnapshotId = input.quotaSnapshotId ? requireText(input.quotaSnapshotId, "Quota Snapshot ID") : undefined;
    const fallbackFromLeaseId = input.fallbackFromLeaseId
      ? requireText(input.fallbackFromLeaseId, "이전 Session Lease ID")
      : undefined;
    const requestHash = sha256(
      canonicalJson({
        action: "acquire",
        executionId,
        accountId,
        connectorId,
        scope,
        workId,
        agentHandle,
        routeAttemptId,
        ...(quotaSnapshotId ? { quotaSnapshotId } : {}),
        ...(fallbackFromLeaseId ? { fallbackFromLeaseId } : {}),
      }),
    );
    await this.organizations.verifyTenantContext(context);
    const row = await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeatedAudit(
        tx,
        context,
        commandId,
        "subscription_session_acquired",
        requestHash,
        true,
      );
      if (repeated) return await this.requireLease(tx, context.organizationId, repeated.resource_id);
      const account = await this.accounts.requireUsable(context, accountId, scope, tx);
      if (account.connector_id !== connectorId) throw new Error("Session Lease Connector binding이 일치하지 않습니다");
      if (fallbackFromLeaseId) {
        await this.requireFallbackAllowed(tx, context, fallbackFromLeaseId, workId);
      }
      const [existing] = await tx.query<[SubscriptionSessionLease[]]>(
        `SELECT * OMIT id FROM subscription_session_lease
         WHERE organization_id = $organization_id AND route_attempt_id = $route_attempt_id LIMIT 1;`,
        { organization_id: context.organizationId, route_attempt_id: routeAttemptId },
      );
      if (existing[0]) throw new Error("이 Route Attempt에는 이미 Session Lease가 있습니다");
      const leaseId = randomUUID();
      const expiresAt = new Date(this.now().getTime() + this.leaseTtlMs);
      const [created] = await tx.query<[SubscriptionSessionLease[]]>(
        `CREATE subscription_session_lease CONTENT {
          lease_id: $lease_id, organization_id: $organization_id, account_id: $account_id,
          execution_id: $execution_id,
          connector_id: $connector_id, work_id: $work_id, agent_handle: $agent_handle,
          route_attempt_id: $route_attempt_id, quota_snapshot_id: $quota_snapshot_id,
          status: 'active', expires_at: $expires_at, created_at: $now, updated_at: $now
        } RETURN AFTER;`,
        {
          lease_id: leaseId,
          execution_id: executionId,
          organization_id: context.organizationId,
          account_id: accountId,
          connector_id: connectorId,
          work_id: workId,
          agent_handle: agentHandle,
          route_attempt_id: routeAttemptId,
          quota_snapshot_id: quotaSnapshotId,
          expires_at: expiresAt,
          now: this.now(),
        },
      );
      const lease = created[0];
      if (!lease) throw new Error("Connector Session Lease를 생성하지 못했습니다");
      await this.writeAudit(tx, context, commandId, "subscription_session_acquired", lease.lease_id, requestHash, {
        leaseId: lease.lease_id,
        routeAttemptId,
      });
      return lease;
    });
    return this.bind(context, row);
  }

  public async recover(context: TenantContext): Promise<readonly ConnectorSessionLeaseView[]> {
    return (await this.recoverRows(context)).map((row) => this.view(row));
  }

  public async recoverActive(context: TenantContext): Promise<readonly ConnectorSessionLease[]> {
    return (await this.recoverRows(context)).map((row) => this.bind(context, row));
  }

  public async getLease(context: TenantContext, leaseId: string): Promise<ConnectorSessionLease> {
    await this.organizations.verifyTenantContext(context);
    const lease = await this.requireLease(
      this.database,
      context.organizationId,
      requireText(leaseId, "Session Lease ID"),
    );
    return this.bind(context, lease);
  }

  public async bindRuntime(
    context: TenantContext,
    input: { readonly commandId: string; readonly leaseId: string; readonly adapterId: string },
  ): Promise<ConnectorSessionLeaseView> {
    const commandId = requireText(input.commandId, "Command ID");
    const leaseId = requireText(input.leaseId, "Session Lease ID");
    const adapterId = requireText(input.adapterId, "Runtime Adapter ID");
    const requestHash = sha256(canonicalJson({ action: "bind-runtime", leaseId, adapterId }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeatedAudit(
        tx,
        context,
        commandId,
        "subscription_session_runtime_bound",
        requestHash,
      );
      if (repeated) return JSON.parse(repeated.result_json) as ConnectorSessionLeaseView;
      const lease = await this.requireActiveLease(tx, context.organizationId, leaseId);
      if (lease.adapter_id && lease.adapter_id !== adapterId) {
        throw new Error("Session Lease에는 다른 runtime adapter가 이미 결합됐습니다");
      }
      const [updated] = await tx.query<[SubscriptionSessionLease[]]>(
        `UPDATE subscription_session_lease SET adapter_id = $adapter_id, updated_at = $now
         WHERE organization_id = $organization_id AND lease_id = $lease_id AND status = 'active'
         AND (adapter_id = NONE OR adapter_id = $adapter_id) RETURN AFTER;`,
        {
          organization_id: context.organizationId,
          lease_id: leaseId,
          adapter_id: adapterId,
          now: this.now(),
        },
      );
      if (!updated[0]) throw new Error("Session Lease runtime adapter 결합이 충돌했습니다");
      const result = this.view(updated[0]);
      await this.writeAudit(tx, context, commandId, "subscription_session_runtime_bound", leaseId, requestHash, result);
      return result;
    });
  }

  public async findExecutionLeases(
    context: TenantContext,
    executionId: string,
  ): Promise<readonly ConnectorSessionLease[]> {
    await this.organizations.verifyTenantContext(context);
    const [leases] = await this.database.query<[SubscriptionSessionLease[]]>(
      `SELECT * OMIT id FROM subscription_session_lease
       WHERE organization_id = $organization_id AND execution_id = $execution_id
       AND status IN ['active', 'expired'] ORDER BY created_at ASC;`,
      {
        organization_id: context.organizationId,
        execution_id: requireText(executionId, "Execution ID"),
      },
    );
    return leases.map((lease) => this.bind(context, lease));
  }

  private async recoverRows(context: TenantContext): Promise<readonly SubscriptionSessionLease[]> {
    await this.organizations.verifyTenantContext(context);
    const now = this.now();
    await this.database.query(
      `UPDATE subscription_session_lease SET status = 'expired', updated_at = $now
       WHERE organization_id = $organization_id AND status = 'active' AND expires_at <= $now;`,
      { organization_id: context.organizationId, now },
    );
    const [rows] = await this.database.query<[SubscriptionSessionLease[]]>(
      `SELECT * OMIT id FROM subscription_session_lease
       WHERE organization_id = $organization_id AND status = 'active' AND expires_at > $now
       ORDER BY created_at ASC;`,
      { organization_id: context.organizationId, now },
    );
    return rows;
  }

  public async *invoke(context: TenantContext, input: unknown, signal?: AbortSignal): AsyncIterable<ConnectorEvent> {
    const request = parseConnectorRequest(input);
    let requestBytes: number;
    try {
      requestBytes = Buffer.byteLength(JSON.stringify(request));
    } catch (error) {
      throw new Error("Connector 요청 payload를 직렬화할 수 없습니다", { cause: error });
    }
    if (requestBytes > 16 * 1024 * 1024) throw new Error("Connector 요청 byte 상한을 초과했습니다");
    await this.organizations.verifyTenantContext(context);
    const lease = await this.requireActiveLease(this.database, context.organizationId, request.leaseId);
    let previousSequence = -1;
    let terminal = false;
    for await (const event of this.transport.invoke(context.organizationId, lease.connector_id, request, signal)) {
      const encoded = JSON.stringify(event);
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("Connector event frame byte 상한을 초과했습니다");
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
        throw new Error("Connector event sequence가 유효하지 않습니다");
      }
      if (!new Set(["data", "usage", "error", "done"]).has(event.kind)) {
        throw new Error("Connector event kind가 유효하지 않습니다");
      }
      if (terminal) throw new Error("Connector terminal event 뒤에 추가 frame이 있습니다");
      previousSequence = event.sequence;
      terminal = event.kind === "error" || event.kind === "done";
      yield event;
    }
    if (!terminal) throw new Error("Connector 응답에 terminal event가 없습니다");
  }

  private bind(context: TenantContext, row: SubscriptionSessionLease): ConnectorSessionLease {
    return {
      ...this.view(row),
      complete: async (input) => await this.complete(context, row.lease_id, input),
      fail: async (input) => await this.fail(context, row.lease_id, input),
      renew: async (input) => await this.renew(context, row.lease_id, input),
    };
  }

  private view(row: SubscriptionSessionLease): ConnectorSessionLeaseView {
    return {
      leaseId: row.lease_id,
      executionId: requireText(row.execution_id, "Session Lease Execution ID"),
      accountId: row.account_id,
      connectorId: row.connector_id,
      ...(row.adapter_id ? { adapterId: row.adapter_id } : {}),
      workId: row.work_id,
      agentHandle: row.agent_handle,
      routeAttemptId: row.route_attempt_id,
      ...(row.quota_snapshot_id ? { quotaSnapshotId: row.quota_snapshot_id } : {}),
      status: row.status,
      expiresAt: iso(row.expires_at, "Session Lease 만료 시각"),
    };
  }

  private async complete(
    context: TenantContext,
    leaseId: string,
    input: { readonly commandId: string },
  ): Promise<ConnectorSessionLeaseView> {
    const commandId = requireText(input.commandId, "Command ID");
    const requestHash = sha256(canonicalJson({ action: "complete", leaseId }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeatedAudit(tx, context, commandId, "subscription_session_completed", requestHash);
      if (repeated) {
        const replayed = await this.requireLease(tx, context.organizationId, leaseId);
        if (replayed.status !== "completed") throw new Error("Session Lease terminal 상태가 일치하지 않습니다");
        return this.view(replayed);
      }
      const lease = await this.requireSettleableLease(tx, context.organizationId, leaseId);
      const [updated] = await tx.query<[SubscriptionSessionLease[]]>(
        `UPDATE subscription_session_lease SET status = 'completed', updated_at = $now
         WHERE organization_id = $organization_id AND lease_id = $lease_id
         AND status IN ['active', 'expired'] RETURN AFTER;`,
        { organization_id: context.organizationId, lease_id: leaseId, now: this.now() },
      );
      if (!updated[0]) throw new Error("Connector Session Lease 완료가 충돌했습니다");
      const view = this.view(updated[0]);
      await this.writeAudit(
        tx,
        context,
        commandId,
        "subscription_session_completed",
        lease.lease_id,
        requestHash,
        view,
      );
      return view;
    });
  }

  private async fail(
    context: TenantContext,
    leaseId: string,
    input: {
      readonly commandId: string;
      readonly emittedTokens: number;
      readonly sideEffectsStarted: boolean;
      readonly signal: ConnectorFailureSignal;
    },
  ): Promise<ConnectorLeaseFailure> {
    const commandId = requireText(input.commandId, "Command ID");
    if (!Number.isSafeInteger(input.emittedTokens) || input.emittedTokens < 0) {
      throw new Error("출력 token 수가 유효하지 않습니다");
    }
    if (typeof input.sideEffectsStarted !== "boolean") throw new Error("부작용 시작 여부가 유효하지 않습니다");
    const fallbackAllowed =
      input.emittedTokens === 0 && !input.sideEffectsStarted && retryableBeforeOutput(input.signal.kind);
    const requestHash = sha256(
      canonicalJson({
        action: "fail",
        leaseId,
        emittedTokens: input.emittedTokens,
        sideEffectsStarted: input.sideEffectsStarted,
        signal: input.signal,
      }),
    );
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeatedAudit(tx, context, commandId, "subscription_session_failed", requestHash);
      if (repeated) {
        const replayed = await this.requireLease(tx, context.organizationId, leaseId);
        if (replayed.status !== "failed") throw new Error("Session Lease terminal 상태가 일치하지 않습니다");
        return JSON.parse(repeated.result_json) as ConnectorLeaseFailure;
      }
      const lease = await this.requireSettleableLease(tx, context.organizationId, leaseId);
      await tx.query(
        `UPDATE subscription_session_lease SET status = 'failed', updated_at = $now
         WHERE organization_id = $organization_id AND lease_id = $lease_id
         AND status IN ['active', 'expired'];`,
        { organization_id: context.organizationId, lease_id: leaseId, now: this.now() },
      );
      const result = { status: "failed" as const, fallbackAllowed, failureKind: input.signal.kind };
      await this.writeAudit(tx, context, commandId, "subscription_session_failed", lease.lease_id, requestHash, result);
      return result;
    });
  }

  private async renew(
    context: TenantContext,
    leaseId: string,
    input: { readonly commandId: string; readonly expectedExpiresAt: string },
  ): Promise<ConnectorSessionLeaseView> {
    const commandId = requireText(input.commandId, "Command ID");
    const expectedExpiresAt = iso(input.expectedExpiresAt, "예상 Session Lease 만료 시각");
    const requestHash = sha256(canonicalJson({ action: "renew", leaseId, expectedExpiresAt }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeatedAudit(tx, context, commandId, "subscription_session_renewed", requestHash);
      if (repeated) return JSON.parse(repeated.result_json) as ConnectorSessionLeaseView;
      const lease = await this.requireActiveLease(tx, context.organizationId, leaseId);
      if (iso(lease.expires_at, "Session Lease 만료 시각") !== expectedExpiresAt) {
        throw new Error("Session Lease 만료 시각이 변경되었습니다");
      }
      const expiresAt = new Date(this.now().getTime() + this.leaseTtlMs);
      const [updated] = await tx.query<[SubscriptionSessionLease[]]>(
        `UPDATE subscription_session_lease SET expires_at = $expires_at, updated_at = $now
         WHERE organization_id = $organization_id AND lease_id = $lease_id AND status = 'active'
         AND expires_at = $expected_expires_at RETURN AFTER;`,
        {
          organization_id: context.organizationId,
          lease_id: leaseId,
          expected_expires_at: new Date(expectedExpiresAt),
          expires_at: expiresAt,
          now: this.now(),
        },
      );
      if (!updated[0]) throw new Error("Session Lease renew이 충돌했습니다");
      const view = this.view(updated[0]);
      await this.writeAudit(tx, context, commandId, "subscription_session_renewed", leaseId, requestHash, view);
      return view;
    });
  }

  private async requireFallbackAllowed(
    executor: QueryExecutor,
    context: TenantContext,
    fallbackFromLeaseId: string,
    workId: string,
  ): Promise<void> {
    const leaseId = requireText(fallbackFromLeaseId, "이전 Session Lease ID");
    const [leases] = await executor.query<[SubscriptionSessionLease[]]>(
      `SELECT * OMIT id FROM subscription_session_lease
       WHERE organization_id = $organization_id AND lease_id = $lease_id LIMIT 1;`,
      { organization_id: context.organizationId, lease_id: leaseId },
    );
    const lease = leases[0];
    if (!lease || lease.work_id !== workId || lease.status !== "failed") {
      throw new Error("이전 Connector Session Lease에서 fallback할 수 없습니다");
    }
    const [events] = await executor.query<[Array<Pick<AuditRow, "result_json">>]>(
      `SELECT result_json FROM subscription_audit_event
       WHERE organization_id = $organization_id AND resource_id = $lease_id
       AND event_type = 'subscription_session_failed' LIMIT 1;`,
      { organization_id: context.organizationId, lease_id: leaseId },
    );
    const result = events[0] ? (JSON.parse(events[0].result_json) as { fallbackAllowed?: unknown }) : undefined;
    if (result?.fallbackAllowed !== true) throw new Error("이전 Connector Session Lease에서 fallback할 수 없습니다");
  }

  private async requireActiveLease(
    executor: QueryExecutor,
    organizationId: string,
    leaseId: string,
  ): Promise<SubscriptionSessionLease> {
    const lease = await this.requireLease(executor, organizationId, leaseId);
    if (lease.status !== "active") throw new Error("활성 Connector Session Lease가 없습니다");
    if (new Date(String(lease.expires_at)).getTime() <= this.now().getTime()) {
      throw new Error("Connector Session Lease가 만료되었습니다");
    }
    return lease;
  }

  private async requireLease(
    executor: QueryExecutor,
    organizationId: string,
    leaseId: string,
  ): Promise<SubscriptionSessionLease> {
    const [leases] = await executor.query<[SubscriptionSessionLease[]]>(
      `SELECT * OMIT id FROM subscription_session_lease
       WHERE organization_id = $organization_id AND lease_id = $lease_id LIMIT 1;`,
      { organization_id: organizationId, lease_id: requireText(leaseId, "Session Lease ID") },
    );
    const lease = leases[0];
    if (!lease) throw new Error("Connector Session Lease가 없습니다");
    return lease;
  }

  private async requireSettleableLease(
    executor: QueryExecutor,
    organizationId: string,
    leaseId: string,
  ): Promise<SubscriptionSessionLease> {
    const lease = await this.requireLease(executor, organizationId, leaseId);
    if (lease.status !== "active" && lease.status !== "expired") {
      throw new Error("Session Lease terminal 상태가 일치하지 않습니다");
    }
    return lease;
  }

  private async repeatedAudit(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    eventType: string,
    requestHash: string,
    requireSameActor = false,
  ): Promise<AuditRow | undefined> {
    const [events] = await executor.query<[AuditRow[]]>(
      `SELECT actor_user_id, event_type, resource_id, request_hash, result_json
       FROM subscription_audit_event
       WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: context.organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (requireSameActor && event.actor_user_id !== context.userId) {
      throw new Error("같은 Command ID를 다른 actor가 사용할 수 없습니다");
    }
    if (event.event_type !== eventType || event.request_hash !== requestHash) {
      throw new Error("같은 Command ID에 다른 요청을 사용할 수 없습니다");
    }
    return event;
  }

  private async writeAudit(
    executor: QueryExecutor,
    context: TenantContext,
    commandId: string,
    eventType: string,
    resourceId: string,
    requestHash: string,
    result: unknown,
  ): Promise<void> {
    const resultJson = JSON.stringify(result);
    await executor.query(
      `CREATE subscription_audit_event CONTENT {
        event_id: $event_id, organization_id: $organization_id, actor_user_id: $actor_user_id,
        command_id: $command_id, event_type: $event_type, resource_id: $resource_id,
        request_hash: $request_hash, result_json: $result_json, created_at: $now
      };`,
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        actor_user_id: context.userId,
        command_id: commandId,
        event_type: eventType,
        resource_id: resourceId,
        request_hash: requestHash,
        result_json: resultJson,
        now: this.now(),
      },
    );
  }
}
