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
}

export class SubscriptionQuotaSynchronizationService {
  private readonly intervalMs: number;
  private readonly maximumConcurrency: number;
  private readonly commandId: () => string;
  private readonly fetchMiniMaxQuota: (secret: string) => Promise<readonly QuotaWindow[]>;
  private readonly fetchCodexQuota?: SubscriptionQuotaSynchronizationOptions["fetchCodexQuota"];
  private readonly onTransition?: SubscriptionQuotaSynchronizationOptions["onTransition"];
  private readonly onUnavailable?: SubscriptionQuotaSynchronizationOptions["onUnavailable"];
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
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
    await this.active;
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
    if (
      account.provider_id !== "openai-codex" ||
      account.billing_kind !== "consumer-subscription" ||
      account.status !== "active" ||
      !account.account_id ||
      !account.organization_id ||
      !account.owner_user_id ||
      !account.connector_id
    ) {
      await this.reportUnavailable("lineage-unavailable");
      return false;
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
      await this.reportUnavailable("lineage-unavailable");
      return false;
    }
    let context: TenantContext;
    try {
      context = await this.organizations.resolveTenantContext(account.owner_user_id, account.organization_id);
      if (context.organizationId !== account.organization_id || context.userId !== account.owner_user_id) {
        throw new Error("Codex 구독 계정 소유자 문맥 계보가 일치하지 않습니다");
      }
    } catch {
      await this.reportUnavailable("owner-context-unavailable");
      return false;
    }
    if (!this.fetchCodexQuota) {
      await this.reportUnavailable("runtime");
      return false;
    }
    let windows: readonly QuotaWindow[];
    try {
      windows = await this.fetchCodexQuota({
        organizationId: account.organization_id,
        accountId: account.account_id,
      });
    } catch (error) {
      await this.reportUnavailable(error instanceof CodexSubscriptionObservationError ? error.category : "upstream");
      return false;
    }
    try {
      await this.quota.record(context, {
        commandId: this.commandId(),
        accountId: account.account_id,
        windows,
      });
      return true;
    } catch {
      await this.reportUnavailable("persistence-unavailable");
      return false;
    }
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
