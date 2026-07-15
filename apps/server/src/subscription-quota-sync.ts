import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { ProviderCredential, ProviderService } from "@massion/router";
import type { MassionDatabase } from "@massion/storage";
import {
  fetchMiniMaxQuota,
  MiniMaxQuotaFetchError,
  type QuotaWindow,
  type SubscriptionQuotaService,
} from "@massion/subscriptions";

import { CodexSubscriptionObservationError } from "./codex-subscription-observer.js";

interface AccountLineageRecord {
  readonly owner_user_id: string;
  readonly connector_id: string;
  readonly status: string;
}

interface ConnectorStateRecord {
  readonly status: string;
  readonly trust_origin?: string;
  readonly execution_kind?: string;
  readonly runtime_id?: string;
  readonly provider_id?: string;
}

interface CodexQuotaAccountRecord {
  readonly account_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly provider_id: string;
  readonly connector_id: string;
  readonly billing_kind: string;
  readonly status: string;
}

export type SubscriptionQuotaSynchronizationFailure =
  | MiniMaxQuotaFetchError["category"]
  | "owner-context-unavailable"
  | "lineage-unavailable"
  | "secret-unavailable"
  | "persistence-unavailable"
  | "scan-unavailable"
  | CodexSubscriptionObservationError["category"];

export interface SubscriptionQuotaSynchronizationTransition {
  readonly attempted: number;
  readonly refreshed: number;
  readonly unavailable: number;
}

/** 연결 완료 경로가 재로그인과 일시적 quota 관측 실패를 구분하기 위한 Codex 직접 새로고침 결과입니다. */
export type CodexQuotaRefreshResult =
  | { readonly status: "refreshed" }
  | { readonly status: "reauthentication-required"; readonly transitionApplied: boolean }
  | { readonly status: "unavailable"; readonly category: SubscriptionQuotaSynchronizationFailure };

export interface SubscriptionQuotaSynchronizationOptions {
  readonly intervalMs: number;
  readonly maximumConcurrency?: number;
  readonly commandId?: () => string;
  readonly fetchMiniMaxQuota?: (secret: string) => Promise<readonly QuotaWindow[]>;
  readonly fetchCodexQuota?: (input: {
    readonly organizationId: string;
    readonly accountId: string;
  }) => Promise<readonly QuotaWindow[]>;
  readonly onTransition?: (transition: SubscriptionQuotaSynchronizationTransition) => void | Promise<void>;
  readonly onUnavailable?: (failure: {
    readonly category: SubscriptionQuotaSynchronizationFailure;
  }) => void | Promise<void>;
  /** 인증 만료만 Connector·계정 재인증 상태로 전이합니다. schema/upstream 오류에는 호출하지 않습니다. */
  readonly onCodexAuthenticationRequired?: (input: {
    readonly context: TenantContext;
    readonly accountId: string;
    readonly connectorId: string;
    readonly commandId: string;
  }) => void | Promise<void>;
}

export class SubscriptionQuotaSynchronizationService {
  private readonly intervalMs: number;
  private readonly maximumConcurrency: number;
  private readonly commandId: () => string;
  private readonly fetchMiniMaxQuota: (secret: string) => Promise<readonly QuotaWindow[]>;
  private readonly fetchCodexQuota?: SubscriptionQuotaSynchronizationOptions["fetchCodexQuota"];
  private readonly onTransition?: SubscriptionQuotaSynchronizationOptions["onTransition"];
  private readonly onUnavailable?: SubscriptionQuotaSynchronizationOptions["onUnavailable"];
  private readonly onCodexAuthenticationRequired?: SubscriptionQuotaSynchronizationOptions["onCodexAuthenticationRequired"];
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private readonly codexRefreshes = new Map<string, Promise<CodexQuotaRefreshResult>>();
  private running = false;
  private closed = false;
  private healthy = false;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: Pick<OrganizationService, "resolveTenantContext">,
    private readonly providers: Pick<ProviderService, "resolveExecutionSecretVersion">,
    private readonly quota: Pick<SubscriptionQuotaService, "record">,
    options: SubscriptionQuotaSynchronizationOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > 86_400_000) {
      throw new Error("구독 할당량 동기화 주기가 유효하지 않습니다");
    }
    this.intervalMs = options.intervalMs;
    this.maximumConcurrency = options.maximumConcurrency ?? 4;
    if (!Number.isSafeInteger(this.maximumConcurrency) || this.maximumConcurrency < 1 || this.maximumConcurrency > 16) {
      throw new Error("구독 할당량 동기화 동시성이 유효하지 않습니다");
    }
    this.commandId = options.commandId ?? (() => `quota-sync-${randomUUID()}`);
    this.fetchMiniMaxQuota = options.fetchMiniMaxQuota ?? fetchMiniMaxQuota;
    this.fetchCodexQuota = options.fetchCodexQuota;
    this.onTransition = options.onTransition;
    this.onUnavailable = options.onUnavailable;
    this.onCodexAuthenticationRequired = options.onCodexAuthenticationRequired;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error("종료된 구독 할당량 동기화 서비스는 다시 시작할 수 없습니다");
    if (this.running) throw new Error("구독 할당량 동기화 서비스가 이미 시작됐습니다");
    this.running = true;
    try {
      await this.synchronize();
      this.healthy = true;
    } catch {
      this.running = false;
      this.healthy = false;
      await this.reportUnavailable("scan-unavailable");
      throw new Error("구독 할당량 초기 동기화에 실패했습니다");
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref();
  }

  public ready(): boolean {
    return this.running && !this.closed && this.healthy;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.running = false;
    this.closed = true;
    this.healthy = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([this.active, ...this.codexRefreshes.values()]);
  }

  /**
   * 새 연결 직후 한 계정의 Codex rate-limit을 즉시 관측합니다.
   * `requireFresh`면 이미 시작된 scheduler/직접 관측은 기다린 뒤 새 provider 관측을 시작합니다.
   */
  public async refreshCodexAccount(input: {
    readonly organizationId: string;
    readonly accountId: string;
    /** 연결 health 뒤의 새 quota가 필요할 때만 설정합니다. */
    readonly requireFresh?: boolean;
  }): Promise<CodexQuotaRefreshResult> {
    if (this.closed) throw new Error("종료된 구독 할당량 동기화 서비스는 Codex quota를 새로고침할 수 없습니다");
    const key = this.codexRefreshKey(input.organizationId, input.accountId);
    const result = await this.singleFlightCodexRefresh(
      key,
      async () => {
        const account = await this.findCodexAccount(input.organizationId, input.accountId);
        return account
          ? await this.refreshCodexAccountOnce(account)
          : { status: "unavailable", category: "lineage-unavailable" };
      },
      input.requireFresh === true,
    );
    await this.reportCodexRefresh(result, true);
    return result;
  }

  private async sweep(): Promise<void> {
    if (!this.running || this.active) return;
    const active = this.synchronize()
      .then(() => {
        this.healthy = true;
      })
      .catch(async () => {
        this.healthy = false;
        await this.reportUnavailable("scan-unavailable");
      });
    this.active = active;
    try {
      await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private async synchronize(): Promise<void> {
    const [[credentials], [codexAccounts]] = await Promise.all([
      this.database.query<[ProviderCredential[]]>(
        `SELECT * OMIT id FROM provider_credential
         WHERE provider_id = 'minimax-token-plan' AND status = 'active'
           AND material_kind = 'encrypted_secret'
           AND subscription_account_id != NONE AND subscription_connector_id != NONE
         ORDER BY organization_id ASC, credential_id ASC;`,
      ),
      this.database.query<[CodexQuotaAccountRecord[]]>(
        `SELECT account_id, organization_id, owner_user_id, provider_id, connector_id, billing_kind, status
         FROM subscription_account
         WHERE provider_id = 'openai-codex' AND billing_kind = 'consumer-subscription' AND status = 'active'
         ORDER BY organization_id ASC, account_id ASC;`,
      ),
    ]);
    const jobs: readonly (
      | { readonly kind: "minimax"; readonly credential: ProviderCredential }
      | { readonly kind: "codex"; readonly account: CodexQuotaAccountRecord }
    )[] = [
      ...credentials.map((credential) => ({ kind: "minimax" as const, credential })),
      ...codexAccounts.map((account) => ({ kind: "codex" as const, account })),
    ];
    let next = 0;
    let refreshed = 0;
    let unavailable = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const job = jobs[index];
        if (!job) return;
        const synchronized =
          job.kind === "minimax"
            ? await this.synchronizeCredential(job.credential)
            : await this.synchronizeCodexAccount(job.account);
        if (synchronized) refreshed += 1;
        else unavailable += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.maximumConcurrency, Math.max(1, jobs.length)) }, async () => {
        await worker();
      }),
    );
    await this.reportTransition({ attempted: jobs.length, refreshed, unavailable });
  }

  private async synchronizeCredential(credential: ProviderCredential): Promise<boolean> {
    const accountId = credential.subscription_account_id;
    const connectorId = credential.subscription_connector_id;
    if (!accountId || !connectorId || credential.subscription_scope === undefined) {
      await this.reportUnavailable("lineage-unavailable");
      return false;
    }
    const [accounts] = await this.database.query<[AccountLineageRecord[]]>(
      `SELECT owner_user_id, connector_id, status FROM subscription_account
       WHERE organization_id = $organization_id AND account_id = $account_id
         AND connector_id = $connector_id AND provider_id = $provider_id AND status != 'revoked' LIMIT 1;`,
      {
        organization_id: credential.organization_id,
        account_id: accountId,
        connector_id: connectorId,
        provider_id: credential.provider_id,
      },
    );
    const account = accounts[0];
    if (!account || account.connector_id !== connectorId) {
      await this.reportUnavailable("lineage-unavailable");
      return false;
    }
    const [connectors] = await this.database.query<[ConnectorStateRecord[]]>(
      `SELECT status FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND status = 'ready' LIMIT 1;`,
      { organization_id: credential.organization_id, connector_id: connectorId },
    );
    if (connectors[0]?.status !== "ready") {
      await this.reportUnavailable("lineage-unavailable");
      return false;
    }
    let context: TenantContext;
    try {
      context = await this.organizations.resolveTenantContext(account.owner_user_id, credential.organization_id);
      if (context.organizationId !== credential.organization_id || context.userId !== account.owner_user_id) {
        throw new Error("구독 계정 소유자 문맥 계보가 일치하지 않습니다");
      }
    } catch {
      await this.reportUnavailable("owner-context-unavailable");
      return false;
    }
    let secret: string;
    try {
      secret = await this.providers.resolveExecutionSecretVersion(
        context,
        credential,
        credential.secret_version,
        this.database,
      );
    } catch {
      await this.reportUnavailable("secret-unavailable");
      return false;
    }
    let windows: readonly QuotaWindow[];
    try {
      windows = await this.fetchMiniMaxQuota(secret);
    } catch (error) {
      await this.reportUnavailable(error instanceof MiniMaxQuotaFetchError ? error.category : "upstream");
      return false;
    }
    try {
      await this.quota.record(context, { commandId: this.commandId(), accountId, windows });
      return true;
    } catch {
      await this.reportUnavailable("persistence-unavailable");
      return false;
    }
  }

  private async synchronizeCodexAccount(account: CodexQuotaAccountRecord): Promise<boolean> {
    const result = await this.singleFlightCodexRefresh(
      this.codexRefreshKey(account.organization_id, account.account_id),
      async () => await this.refreshCodexAccountOnce(account),
    );
    await this.reportCodexRefresh(result, false);
    return result.status === "refreshed";
  }

  private async refreshCodexAccountOnce(account: CodexQuotaAccountRecord): Promise<CodexQuotaRefreshResult> {
    if (
      account.provider_id !== "openai-codex" ||
      account.billing_kind !== "consumer-subscription" ||
      account.status !== "active" ||
      !account.account_id ||
      !account.organization_id ||
      !account.owner_user_id ||
      !account.connector_id
    ) {
      return { status: "unavailable", category: "lineage-unavailable" };
    }
    const [connectors] = await this.database.query<[ConnectorStateRecord[]]>(
      `SELECT status, trust_origin, execution_kind, runtime_id, provider_id FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND status = 'ready' AND trust_origin = 'server-managed'
         AND execution_kind = 'agent-runtime' AND runtime_id = 'codex' AND provider_id = 'openai-codex'
       LIMIT 1;`,
      { organization_id: account.organization_id, connector_id: account.connector_id },
    );
    const connector = connectors[0];
    if (
      connector?.status !== "ready" ||
      connector.trust_origin !== "server-managed" ||
      connector.execution_kind !== "agent-runtime" ||
      connector.runtime_id !== "codex" ||
      connector.provider_id !== "openai-codex"
    ) {
      return { status: "unavailable", category: "lineage-unavailable" };
    }
    let context: TenantContext;
    try {
      context = await this.organizations.resolveTenantContext(account.owner_user_id, account.organization_id);
      if (context.organizationId !== account.organization_id || context.userId !== account.owner_user_id) {
        throw new Error("Codex 구독 계정 소유자 문맥 계보가 일치하지 않습니다");
      }
    } catch {
      return { status: "unavailable", category: "owner-context-unavailable" };
    }
    if (!this.fetchCodexQuota) {
      return { status: "unavailable", category: "runtime" };
    }
    let windows: readonly QuotaWindow[];
    try {
      windows = await this.fetchCodexQuota({
        organizationId: account.organization_id,
        accountId: account.account_id,
      });
    } catch (error) {
      const category = error instanceof CodexSubscriptionObservationError ? error.category : "upstream";
      if (category !== "authentication") return { status: "unavailable", category };
      if (!this.onCodexAuthenticationRequired) {
        return { status: "reauthentication-required", transitionApplied: false };
      }
      try {
        await this.onCodexAuthenticationRequired({
          context,
          accountId: account.account_id,
          connectorId: account.connector_id,
          commandId: `${this.commandId()}:reauth`,
        });
        return { status: "reauthentication-required", transitionApplied: true };
      } catch {
        return { status: "unavailable", category: "persistence-unavailable" };
      }
    }
    try {
      await this.quota.record(context, {
        commandId: this.commandId(),
        accountId: account.account_id,
        windows,
      });
      return { status: "refreshed" };
    } catch {
      return { status: "unavailable", category: "persistence-unavailable" };
    }
  }

  private codexRefreshKey(organizationId: string, accountId: string): string {
    if (
      !organizationId.trim() ||
      !accountId.trim() ||
      /[\0\r\n]/u.test(organizationId) ||
      /[\0\r\n]/u.test(accountId)
    ) {
      throw new Error("Codex quota 새로고침 계보가 유효하지 않습니다");
    }
    return JSON.stringify([organizationId, accountId]);
  }

  private async findCodexAccount(
    organizationId: string,
    accountId: string,
  ): Promise<CodexQuotaAccountRecord | undefined> {
    try {
      const [accounts] = await this.database.query<[CodexQuotaAccountRecord[]]>(
        `SELECT account_id, organization_id, owner_user_id, provider_id, connector_id, billing_kind, status
         FROM subscription_account
         WHERE organization_id = $organization_id AND account_id = $account_id
           AND provider_id = 'openai-codex' AND billing_kind = 'consumer-subscription' AND status = 'active'
         LIMIT 2;`,
        { organization_id: organizationId, account_id: accountId },
      );
      if (accounts.length !== 1 || accounts[0] === undefined) return undefined;
      const account = accounts[0];
      if (account.organization_id !== organizationId || account.account_id !== accountId) return undefined;
      return account;
    } catch {
      return undefined;
    }
  }

  private async singleFlightCodexRefresh(
    key: string,
    create: () => Promise<CodexQuotaRefreshResult>,
    requireFresh = false,
  ): Promise<CodexQuotaRefreshResult> {
    for (;;) {
      if (this.closed) {
        throw new Error("종료된 구독 할당량 동기화 서비스는 Codex quota를 새로고침할 수 없습니다");
      }
      const existing = this.codexRefreshes.get(key);
      if (existing) {
        if (!requireFresh) return await existing;
        // 연결 health가 시작된 뒤의 관측이 필요합니다. 이미 실행 중인 작업은
        // 그 경계보다 앞서 시작됐으므로 끝까지 기다린 뒤 한 번 새로 관측합니다.
        await existing.catch(() => undefined);
        // 같은 이전 작업을 기다린 직접 요청은 다음 새 관측 하나를 함께 사용합니다.
        requireFresh = false;
        continue;
      }
      const refresh = create();
      this.codexRefreshes.set(key, refresh);
      try {
        return await refresh;
      } finally {
        if (this.codexRefreshes.get(key) === refresh) this.codexRefreshes.delete(key);
      }
    }
  }

  private async reportCodexRefresh(result: CodexQuotaRefreshResult, direct: boolean): Promise<void> {
    if (result.status === "refreshed") {
      if (direct) await this.reportTransition({ attempted: 1, refreshed: 1, unavailable: 0 });
      return;
    }
    await this.reportUnavailable(result.status === "reauthentication-required" ? "authentication" : result.category);
    if (direct) await this.reportTransition({ attempted: 1, refreshed: 0, unavailable: 1 });
  }

  private async reportTransition(transition: SubscriptionQuotaSynchronizationTransition): Promise<void> {
    try {
      await this.onTransition?.(transition);
    } catch {
      // 관측 경로 실패가 이미 완료된 할당량 기록을 뒤집지 않게 합니다.
    }
  }

  private async reportUnavailable(category: SubscriptionQuotaSynchronizationFailure): Promise<void> {
    try {
      await this.onUnavailable?.({ category });
    } catch {
      // 비밀값 없는 실패 범주 보고는 best effort입니다.
    }
  }
}
