import { describe, expect, it, vi } from "vitest";

import type { ProviderCredential } from "@massion/router";
import { MiniMaxQuotaFetchError } from "@massion/subscriptions";

import { SubscriptionQuotaSynchronizationService } from "./subscription-quota-sync.js";

const credential: ProviderCredential = {
  credential_id: "credential-12345678",
  organization_id: "organization-12345678",
  provider_id: "minimax-token-plan",
  endpoint_id: "endpoint-12345678",
  label: "MiniMax",
  credential_type: "subscription_key",
  status: "active",
  version: 1,
  secret_version: 1,
  priority: 1,
  weight: 1,
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_micros: 0,
  last_selected_sequence: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
  material_kind: "encrypted_secret",
  subscription_account_id: "account-12345678",
  subscription_connector_id: "connector-12345678",
  subscription_scope: "personal",
};

interface CodexQuotaAccount {
  readonly account_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly provider_id: "openai-codex";
  readonly connector_id: string;
  readonly billing_kind: "consumer-subscription";
  readonly status: "active";
}

function databaseFor(records: readonly ProviderCredential[], codexAccounts: readonly CodexQuotaAccount[] = []) {
  return {
    query: vi.fn().mockImplementation((statement: string, bindings?: Record<string, unknown>) => {
      if (statement.includes("FROM provider_credential")) return Promise.resolve([records]);
      if (statement.includes("FROM subscription_account")) {
        if (statement.includes("provider_id = 'openai-codex'")) return Promise.resolve([codexAccounts]);
        return Promise.resolve([
          [
            {
              owner_user_id: "user-12345678",
              connector_id: bindings?.connector_id ?? "connector-12345678",
              status: "active",
            },
          ],
        ]);
      }
      if (statement.includes("FROM subscription_connector")) {
        return Promise.resolve([
          [
            {
              status: "ready",
              trust_origin: "server-managed",
              execution_kind: bindings?.connector_id === "connector-codex-12345678" ? "agent-runtime" : "model",
              runtime_id: bindings?.connector_id === "connector-codex-12345678" ? "codex" : "openai-model",
              provider_id:
                bindings?.connector_id === "connector-codex-12345678" ? "openai-codex" : "minimax-token-plan",
            },
          ],
        ]);
      }
      throw new Error(`예상하지 못한 query: ${statement}`);
    }),
  };
}

describe("구독 할당량 자동 동기화", () => {
  it("ready 모델 구독의 암호화 secret을 실행 시점에만 복호화해 공식 endpoint 관측값을 기록한다", async () => {
    const database = databaseFor([credential]);
    const context = {
      organizationId: credential.organization_id,
      userId: "user-12345678",
      membershipId: "membership-12345678",
      role: "owner" as const,
    };
    const organizations = { resolveTenantContext: vi.fn().mockResolvedValue(context) };
    const providers = { resolveExecutionSecretVersion: vi.fn().mockResolvedValue("sk-cp-runtime-secret") };
    const record = vi.fn().mockResolvedValue({});
    const fetchQuota = vi.fn().mockResolvedValue([
      {
        kind: "session-5h",
        limit: 1_500,
        remaining: 1_200,
        remainingRatio: 0.8,
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "minimax-token-plan-endpoint",
        confidence: "reported" as const,
      },
    ]);
    const transitions: unknown[] = [];
    const service = new SubscriptionQuotaSynchronizationService(
      database as never,
      organizations as never,
      providers as never,
      { record } as never,
      {
        intervalMs: 60_000,
        commandId: () => "quota-sync-command-12345678",
        fetchMiniMaxQuota: fetchQuota,
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(providers.resolveExecutionSecretVersion).toHaveBeenCalledWith(context, credential, 1, database);
    expect(fetchQuota).toHaveBeenCalledWith("sk-cp-runtime-secret");
    expect(record).toHaveBeenCalledWith(context, {
      commandId: "quota-sync-command-12345678",
      accountId: "account-12345678",
      windows: expect.arrayContaining([expect.objectContaining({ kind: "session-5h", remainingRatio: 0.8 })]),
    });
    expect(transitions).toEqual([{ attempted: 1, refreshed: 1, unavailable: 0 }]);
    expect(JSON.stringify(transitions)).not.toMatch(/credential-|account-|organization-|sk-cp/u);
    await service.close();
    expect(service.ready()).toBe(false);
  });

  it("같은 scheduler가 ready 서버 Codex 유료 계정의 app-server 할당량도 함께 기록한다", async () => {
    const codexAccount: CodexQuotaAccount = {
      account_id: "account-codex-12345678",
      organization_id: credential.organization_id,
      owner_user_id: "user-12345678",
      provider_id: "openai-codex",
      connector_id: "connector-codex-12345678",
      billing_kind: "consumer-subscription",
      status: "active",
    };
    const database = databaseFor([], [codexAccount]);
    const context = {
      organizationId: codexAccount.organization_id,
      userId: codexAccount.owner_user_id,
      membershipId: "membership-12345678",
      role: "owner" as const,
    };
    const fetchCodexQuota = vi.fn().mockResolvedValue([
      {
        kind: "codex:codex:primary",
        remainingRatio: 0.75,
        resetsAt: "2026-07-13T00:00:00.000Z",
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "codex-app-server:account/rateLimits/read",
        confidence: "reported" as const,
      },
    ]);
    const record = vi.fn().mockResolvedValue({});
    const transitions: unknown[] = [];
    const providers = { resolveExecutionSecretVersion: vi.fn() };
    const service = new SubscriptionQuotaSynchronizationService(
      database as never,
      { resolveTenantContext: vi.fn().mockResolvedValue(context) } as never,
      providers as never,
      { record } as never,
      {
        intervalMs: 60_000,
        commandId: () => "quota-sync-codex-12345678",
        fetchCodexQuota,
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(fetchCodexQuota).toHaveBeenCalledWith({
      organizationId: codexAccount.organization_id,
      accountId: codexAccount.account_id,
    });
    expect(record).toHaveBeenCalledWith(context, {
      commandId: "quota-sync-codex-12345678",
      accountId: codexAccount.account_id,
      windows: [expect.objectContaining({ kind: "codex:codex:primary", remainingRatio: 0.75 })],
    });
    expect(providers.resolveExecutionSecretVersion).not.toHaveBeenCalled();
    expect(transitions).toEqual([{ attempted: 1, refreshed: 1, unavailable: 0 }]);
    await service.close();
  });

  it("개별 인증·소유자 실패를 다른 계정과 격리하고 비밀값 없는 범주·집계만 보고한다", async () => {
    const second = {
      ...credential,
      credential_id: "credential-private-value",
      subscription_account_id: "account-private-value",
      subscription_connector_id: "connector-private-value",
    };
    const database = databaseFor([credential, second]);
    const organizations = {
      resolveTenantContext: vi
        .fn()
        .mockResolvedValueOnce({
          organizationId: credential.organization_id,
          userId: "user-12345678",
          membershipId: "membership-12345678",
          role: "owner",
        })
        .mockRejectedValueOnce(new Error("private@example.com Bearer sk-cp-secret")),
    };
    const failures: unknown[] = [];
    const transitions: unknown[] = [];
    const service = new SubscriptionQuotaSynchronizationService(
      database as never,
      organizations as never,
      { resolveExecutionSecretVersion: vi.fn().mockResolvedValue("sk-cp-secret") } as never,
      { record: vi.fn() } as never,
      {
        intervalMs: 60_000,
        maximumConcurrency: 1,
        fetchMiniMaxQuota: vi.fn().mockRejectedValue(new MiniMaxQuotaFetchError("authentication")),
        onUnavailable: (failure) => {
          failures.push(failure);
        },
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(failures).toEqual([{ category: "authentication" }, { category: "owner-context-unavailable" }]);
    expect(transitions).toEqual([{ attempted: 2, refreshed: 0, unavailable: 2 }]);
    expect(JSON.stringify([failures, transitions])).not.toMatch(/private|Bearer|secret|@|credential-|account-/u);
    await service.close();
  });

  it("중복 시작과 잘못된 주기를 거부하고 전체 scan 실패는 readiness를 내린다", async () => {
    expect(
      () =>
        new SubscriptionQuotaSynchronizationService({} as never, {} as never, {} as never, {} as never, {
          intervalMs: 999,
        }),
    ).toThrow("주기");
    const service = new SubscriptionQuotaSynchronizationService(
      { query: vi.fn().mockRejectedValue(new Error("raw database secret")) } as never,
      {} as never,
      {} as never,
      {} as never,
      { intervalMs: 60_000 },
    );
    await expect(service.start()).rejects.toThrow("초기 동기화");
    expect(service.ready()).toBe(false);
    await expect(service.close()).resolves.toBeUndefined();
  });
});
