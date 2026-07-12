import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { QuotaWindow, SubscriptionAccount } from "./contracts.js";
import { SUBSCRIPTION_MIGRATION } from "./schema.js";

interface QuotaSnapshotRecord {
  readonly snapshot_id: string;
  readonly organization_id: string;
  readonly account_id: string;
  readonly windows_json: string;
  readonly checksum: string;
  readonly exhausted: boolean;
  readonly observed_at: unknown;
  readonly created_at: unknown;
}

interface QuotaCurrentRecord {
  readonly organization_id: string;
  readonly account_id: string;
  readonly snapshot_id: string;
  readonly minimum_remaining_ratio?: number;
  readonly earliest_reset_at?: unknown;
  readonly exhausted: boolean;
  readonly observed_at: unknown;
  readonly updated_at: unknown;
}

interface SubscriptionAuditEvent {
  readonly actor_user_id: string;
  readonly request_hash: string;
  readonly result_json: string;
}

export interface RecordQuotaSnapshotInput {
  readonly commandId: string;
  readonly accountId: string;
  readonly windows: readonly QuotaWindow[];
}

export interface RecordRateLimitInput {
  readonly commandId: string;
  readonly accountId: string;
  readonly observedAt: string;
  readonly resetsAt?: string;
  readonly source: string;
}

export interface QuotaCurrentView {
  readonly accountId: string;
  readonly snapshotId: string;
  readonly windows: readonly QuotaWindow[];
  readonly minimumRemainingRatio?: number;
  readonly earliestResetAt?: string;
  readonly exhausted: boolean;
  readonly observedAt: string;
}

export interface RecordedQuotaSnapshot {
  readonly snapshotId: string;
  readonly accountId: string;
  readonly checksum: string;
  readonly windows: readonly QuotaWindow[];
  readonly current: QuotaCurrentView;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}은(는) 비어 있을 수 없습니다`);
  return normalized;
}

function iso(value: unknown): string {
  const serialized = value instanceof Date ? value.toISOString() : String(value);
  const parsed = new Date(serialized);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Quota 시각이 유효하지 않습니다");
  return parsed.toISOString();
}

function normalizeWindows(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  if (windows.length === 0) throw new Error("Quota window가 하나 이상 필요합니다");
  const kinds = new Set<string>();
  const normalized = windows.map((window) => {
    const kind = requireText(window.kind, "Quota window 종류");
    if (kinds.has(kind)) throw new Error(`중복된 Quota window입니다: ${kind}`);
    kinds.add(kind);
    const hasLimit = window.limit !== undefined;
    const hasRemaining = window.remaining !== undefined;
    if (hasLimit !== hasRemaining) throw new Error("Quota limit과 remaining은 함께 제공해야 합니다");
    if (
      (window.limit !== undefined && (!Number.isFinite(window.limit) || window.limit <= 0)) ||
      (window.remaining !== undefined &&
        (!Number.isFinite(window.remaining) || window.remaining < 0 || window.remaining > (window.limit ?? 0)))
    ) {
      throw new Error("Quota limit 또는 remaining이 유효하지 않습니다");
    }
    const derivedRatio =
      window.limit !== undefined && window.remaining !== undefined ? window.remaining / window.limit : undefined;
    if (
      window.remainingRatio !== undefined &&
      (!Number.isFinite(window.remainingRatio) || window.remainingRatio < 0 || window.remainingRatio > 1)
    ) {
      throw new Error("Quota remainingRatio가 유효하지 않습니다");
    }
    if (
      derivedRatio !== undefined &&
      window.remainingRatio !== undefined &&
      Math.abs(derivedRatio - window.remainingRatio) > 1e-9
    ) {
      throw new Error("Quota remainingRatio가 limit·remaining과 일치하지 않습니다");
    }
    const remainingRatio = derivedRatio ?? window.remainingRatio;
    return {
      kind,
      ...(window.limit !== undefined ? { limit: window.limit } : {}),
      ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
      ...(remainingRatio !== undefined ? { remainingRatio } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: iso(window.resetsAt) } : {}),
      observedAt: iso(window.observedAt),
      source: requireText(window.source, "Quota 출처"),
      confidence: window.confidence,
    } satisfies QuotaWindow;
  });
  return normalized.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source),
  );
}

export class SubscriptionQuotaService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<SubscriptionQuotaService> {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION]);
    return new SubscriptionQuotaService(database, organizations);
  }

  public async record(context: TenantContext, input: RecordQuotaSnapshotInput): Promise<RecordedQuotaSnapshot> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(
      async (tx) => await this.recordWithExecutor(context, input, tx, "management"),
    );
  }

  private async recordWithExecutor(
    context: TenantContext,
    input: RecordQuotaSnapshotInput,
    executor: QueryExecutor,
    authorization: "management" | "routing",
  ): Promise<RecordedQuotaSnapshot> {
    requireText(input.commandId, "Command ID");
    const accountId = requireText(input.accountId, "구독 계정 ID");
    const windows = normalizeWindows(input.windows);
    const windowsJson = canonicalJson(windows);
    const checksum = sha256(windowsJson);
    const requestHash = sha256(canonicalJson({ commandId: input.commandId, accountId, windows }));

    return await (async (tx: QueryExecutor) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [events] = await tx.query<[SubscriptionAuditEvent[]]>(
        `SELECT actor_user_id, request_hash, result_json FROM subscription_audit_event
         WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      const repeated = events[0];
      if (repeated) {
        if (repeated.actor_user_id !== context.userId || repeated.request_hash !== requestHash) {
          throw new Error("같은 Command ID에 다른 사용자 또는 요청을 사용할 수 없습니다");
        }
        return JSON.parse(repeated.result_json) as RecordedQuotaSnapshot;
      }
      const account = await this.requireAccount(tx, context.organizationId, accountId);
      const canRecord =
        authorization === "routing" || account.owner_user_id === context.userId || context.role !== "member";
      if (!canRecord) {
        throw new Error("계정 소유자 또는 조직 관리자만 Quota를 기록할 수 있습니다");
      }
      const ratios = windows.flatMap((window) => (window.remainingRatio === undefined ? [] : [window.remainingRatio]));
      const resets = windows.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt])).sort();
      const observedAt = windows
        .map((window) => window.observedAt)
        .sort()
        .at(-1);
      if (!observedAt) throw new Error("Quota 관측 시각을 찾을 수 없습니다");
      const exhausted = windows.some((window) => window.remaining === 0 || window.remainingRatio === 0);
      const minimumRemainingRatio = ratios.length > 0 ? Math.min(...ratios) : undefined;
      const earliestResetAt = resets[0];
      const [existingSnapshots] = await tx.query<[QuotaSnapshotRecord[]]>(
        `SELECT * OMIT id FROM subscription_quota_snapshot
         WHERE organization_id = $organization_id AND account_id = $account_id AND checksum = $checksum LIMIT 1;`,
        { organization_id: context.organizationId, account_id: accountId, checksum },
      );
      let snapshot = existingSnapshots[0];
      if (!snapshot) {
        const [created] = await tx.query<[QuotaSnapshotRecord[]]>(
          `CREATE subscription_quota_snapshot CONTENT {
            snapshot_id: $snapshot_id, organization_id: $organization_id, account_id: $account_id,
            windows_json: $windows_json, checksum: $checksum, exhausted: $exhausted,
            observed_at: $observed_at, created_at: time::now()
          } RETURN AFTER;`,
          {
            snapshot_id: randomUUID(),
            organization_id: context.organizationId,
            account_id: accountId,
            windows_json: windowsJson,
            checksum,
            exhausted,
            observed_at: new Date(observedAt),
          },
        );
        snapshot = created[0];
      }
      if (!snapshot) throw new Error("Quota snapshot 생성 결과가 없습니다");

      const [currentRows] = await tx.query<[QuotaCurrentRecord[]]>(
        `SELECT * OMIT id FROM subscription_quota_current
         WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
        { organization_id: context.organizationId, account_id: accountId },
      );
      const projectionBindings = {
        organization_id: context.organizationId,
        account_id: accountId,
        snapshot_id: snapshot.snapshot_id,
        minimum_remaining_ratio: minimumRemainingRatio,
        earliest_reset_at: earliestResetAt === undefined ? undefined : new Date(earliestResetAt),
        exhausted,
        observed_at: new Date(observedAt),
      };
      if (currentRows[0]) {
        await tx.query(
          `UPDATE subscription_quota_current
           SET snapshot_id = $snapshot_id, minimum_remaining_ratio = $minimum_remaining_ratio,
               earliest_reset_at = $earliest_reset_at, exhausted = $exhausted,
               observed_at = $observed_at, updated_at = time::now()
           WHERE organization_id = $organization_id AND account_id = $account_id;`,
          projectionBindings,
        );
      } else {
        await tx.query(
          `CREATE subscription_quota_current CONTENT {
            organization_id: $organization_id, account_id: $account_id, snapshot_id: $snapshot_id,
            minimum_remaining_ratio: $minimum_remaining_ratio, earliest_reset_at: $earliest_reset_at,
            exhausted: $exhausted, observed_at: $observed_at, updated_at: time::now()
          };`,
          projectionBindings,
        );
      }
      const current = this.currentView(
        {
          organization_id: context.organizationId,
          account_id: accountId,
          snapshot_id: snapshot.snapshot_id,
          ...(minimumRemainingRatio !== undefined ? { minimum_remaining_ratio: minimumRemainingRatio } : {}),
          ...(earliestResetAt !== undefined ? { earliest_reset_at: earliestResetAt } : {}),
          exhausted,
          observed_at: observedAt,
          updated_at: observedAt,
        },
        windows,
      );
      const result: RecordedQuotaSnapshot = {
        snapshotId: snapshot.snapshot_id,
        accountId,
        checksum,
        windows,
        current,
      };
      const safeResult = JSON.parse(JSON.stringify(result)) as RecordedQuotaSnapshot;
      await tx.query(
        `CREATE subscription_audit_event CONTENT {
          event_id: $event_id, organization_id: $organization_id, actor_user_id: $actor_user_id,
          command_id: $command_id, event_type: 'subscription_quota_observed', resource_id: $resource_id,
          request_hash: $request_hash, result_json: $result_json, created_at: time::now()
        };`,
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          command_id: input.commandId,
          resource_id: accountId,
          request_hash: requestHash,
          result_json: JSON.stringify(safeResult),
        },
      );
      return safeResult;
    })(executor);
  }

  public async recordRateLimit(context: TenantContext, input: RecordRateLimitInput): Promise<RecordedQuotaSnapshot> {
    return await this.record(context, {
      commandId: input.commandId,
      accountId: input.accountId,
      windows: [
        {
          kind: "rate-limit",
          remainingRatio: 0,
          ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
          observedAt: input.observedAt,
          source: input.source,
          confidence: "derived",
        },
      ],
    });
  }

  public async recordRateLimitForRouting(
    context: TenantContext,
    input: RecordRateLimitInput,
    executor: QueryExecutor,
  ): Promise<RecordedQuotaSnapshot> {
    return await this.recordWithExecutor(
      context,
      {
        commandId: input.commandId,
        accountId: input.accountId,
        windows: [
          {
            kind: "rate-limit",
            remainingRatio: 0,
            ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
            observedAt: input.observedAt,
            source: input.source,
            confidence: "derived",
          },
        ],
      },
      executor,
      "routing",
    );
  }

  public async current(context: TenantContext, accountId: string): Promise<QuotaCurrentView | undefined> {
    await this.organizations.verifyTenantContext(context);
    const account = await this.requireAccount(this.database, context.organizationId, accountId);
    if (account.owner_user_id !== context.userId && context.role === "member") {
      throw new Error("계정 소유자 또는 조직 관리자만 Quota를 조회할 수 있습니다");
    }
    return await this.readCurrent(context.organizationId, accountId, this.database);
  }

  public async currentForRouting(
    context: TenantContext,
    accountId: string,
    executor: QueryExecutor,
  ): Promise<QuotaCurrentView | undefined> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const account = await this.requireAccount(executor, context.organizationId, accountId);
    if (account.owner_user_id !== context.userId && account.scope !== "organization") {
      throw new Error("개인 구독 계정의 Quota는 계정 소유자만 라우팅에 사용할 수 있습니다");
    }
    return await this.readCurrent(context.organizationId, accountId, executor);
  }

  private async readCurrent(
    organizationId: string,
    accountId: string,
    executor: QueryExecutor,
  ): Promise<QuotaCurrentView | undefined> {
    const [rows] = await executor.query<[QuotaCurrentRecord[]]>(
      `SELECT * OMIT id FROM subscription_quota_current
       WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
      { organization_id: organizationId, account_id: accountId },
    );
    const current = rows[0];
    if (!current) return undefined;
    const [snapshots] = await executor.query<[QuotaSnapshotRecord[]]>(
      `SELECT * OMIT id FROM subscription_quota_snapshot
       WHERE organization_id = $organization_id AND snapshot_id = $snapshot_id LIMIT 1;`,
      { organization_id: organizationId, snapshot_id: current.snapshot_id },
    );
    if (!snapshots[0]) throw new Error("현재 Quota snapshot을 찾을 수 없습니다");
    return this.currentView(current, JSON.parse(snapshots[0].windows_json) as QuotaWindow[]);
  }

  private currentView(current: QuotaCurrentRecord, windows: readonly QuotaWindow[]): QuotaCurrentView {
    return {
      accountId: current.account_id,
      snapshotId: current.snapshot_id,
      windows,
      ...(current.minimum_remaining_ratio !== undefined
        ? { minimumRemainingRatio: current.minimum_remaining_ratio }
        : {}),
      ...(current.earliest_reset_at !== undefined ? { earliestResetAt: iso(current.earliest_reset_at) } : {}),
      exhausted: current.exhausted,
      observedAt: iso(current.observed_at),
    };
  }

  private async requireAccount(
    executor: QueryExecutor,
    organizationId: string,
    accountId: string,
  ): Promise<SubscriptionAccount> {
    const [accounts] = await executor.query<[SubscriptionAccount[]]>(
      `SELECT * OMIT id FROM subscription_account
       WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
      { organization_id: organizationId, account_id: accountId },
    );
    if (!accounts[0]) throw new Error(`구독 계정을 찾을 수 없습니다: ${accountId}`);
    return accounts[0];
  }
}
