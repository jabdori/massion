import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { SubscriptionAccountService, SubscriptionQuotaService } from "@massion/subscriptions";

import {
  ModelRouter,
  selectCredential,
  type CredentialPolicy,
  type CredentialSelectionView,
  type ModelProfile,
} from "./model-router.js";
import { ProviderService, type ProviderEndpoint } from "./provider.js";
import { CredentialVault } from "./vault.js";

const CREDENTIALS: CredentialSelectionView[] = [
  {
    credential_id: "a",
    label: "A",
    priority: 1,
    weight: 1,
    request_count: 4,
    cost_micros: 400,
    quota_limit: 100,
    quota_remaining: 20,
    quota_reset_at: "2030-01-02T00:00:00Z",
    last_selected_sequence: 9,
  },
  {
    credential_id: "b",
    label: "B",
    priority: 1,
    weight: 2,
    request_count: 2,
    cost_micros: 200,
    quota_limit: 100,
    quota_remaining: 80,
    quota_reset_at: "2030-01-01T00:00:00Z",
    last_selected_sequence: 3,
  },
  {
    credential_id: "c",
    label: "C",
    priority: 2,
    weight: 1,
    request_count: 0,
    cost_micros: 0,
    quota_limit: 100,
    quota_remaining: 100,
    quota_reset_at: "2030-01-03T00:00:00Z",
    last_selected_sequence: 0,
  },
];

function credentialAt(index: number): CredentialSelectionView {
  const credential = CREDENTIALS[index];
  if (!credential) throw new Error(`Credential fixture가 없습니다: ${String(index)}`);
  return credential;
}

describe("Credential 선택 policy", () => {
  it.each<[CredentialPolicy, string]>([
    ["priority", "b"],
    ["fill-first", "a"],
    ["round-robin", "c"],
    ["weighted", "c"],
    ["least-used", "c"],
    ["quota-headroom", "c"],
    ["reset-aware", "b"],
  ])("%s가 결정론적인 credential을 선택한다", (policy, expected) => {
    expect(selectCredential(policy, CREDENTIALS)?.credential_id).toBe(expected);
  });

  it("sticky는 같은 key에 같은 weighted credential을 선택한다", () => {
    const first = selectCredential("sticky", CREDENTIALS, "work-1:agent-1");
    expect(selectCredential("sticky", CREDENTIALS, "work-1:agent-1")?.credential_id).toBe(first?.credential_id);
    expect(() => selectCredential("sticky", CREDENTIALS)).toThrow("stickyKey");
  });

  it("adaptive는 곧 reset되며 잔여량이 큰 계정을 먼저 소진한다", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const candidates: CredentialSelectionView[] = [
      {
        ...credentialAt(0),
        credential_id: "weekly-soon",
        quota_windows: [
          {
            kind: "weekly",
            remainingRatio: 0.9,
            resetsAt: "2030-01-01T01:00:00.000Z",
            observedAt: now.toISOString(),
          },
        ],
      },
      {
        ...credentialAt(1),
        credential_id: "balanced-later",
        quota_windows: [
          {
            kind: "weekly",
            remainingRatio: 0.5,
            resetsAt: "2030-01-07T00:00:00.000Z",
            observedAt: now.toISOString(),
          },
        ],
      },
    ];

    expect(selectCredential("adaptive", candidates, undefined, now)?.credential_id).toBe("weekly-soon");
  });

  it("adaptive는 신선한 window 하나라도 소진된 계정을 제외하고 동률을 결정론적으로 고른다", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const exhausted: CredentialSelectionView = {
      ...credentialAt(0),
      credential_id: "exhausted",
      quota_windows: [
        { kind: "five-hour", remainingRatio: 0, observedAt: now.toISOString() },
        { kind: "weekly", remainingRatio: 0.8, observedAt: now.toISOString() },
      ],
    };
    const available: CredentialSelectionView = {
      ...credentialAt(1),
      credential_id: "available",
      quota_windows: [{ kind: "weekly", remainingRatio: 0.5, observedAt: now.toISOString() }],
    };

    expect(selectCredential("adaptive", [exhausted, available], undefined, now)?.credential_id).toBe("available");
    expect(selectCredential("adaptive", [exhausted], undefined, now)).toBeUndefined();
  });
});

describe("Model Route simulation과 reservation", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let providers: ProviderService;
  let router: ModelRouter;
  let endpoint: ProviderEndpoint;
  let profile: ModelProfile;
  let accounts: SubscriptionAccountService;
  let quota: SubscriptionQuotaService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    quota = await SubscriptionQuotaService.create(database, organizations);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      displayName: "OpenAI",
      adapterKind: "ai-sdk",
    });
    endpoint = (
      await providers.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai",
        name: "API",
        baseUrl: "https://api.openai.com/v1",
        local: false,
      })
    ).endpoint;
    for (const label of ["account-a", "account-b"]) {
      await providers.addCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai",
        endpointId: endpoint.endpoint_id,
        label,
        credentialType: "api_key",
        secret: `secret-${label}`,
        priority: 1,
        weight: 1,
      });
    }
    profile = (
      await router.registerModel(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai",
        endpointId: endpoint.endpoint_id,
        modelId: "gpt-coding",
        routeKind: "chat",
        contextWindow: 128_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "coding-balanced",
        evalScore: 0.9,
        inputCostMicrosPerMillion: 1_000_000,
        outputCostMicrosPerMillion: 1_000_000,
        verified: true,
      })
    ).profile;
  });

  afterEach(async () => database.close());

  async function route(policy: CredentialPolicy = "round-robin") {
    const created = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: `coding-${policy}-${crypto.randomUUID()}`,
      routeKind: "chat",
      credentialPolicy: policy,
      dataPolicy: "external-allowed",
      equivalenceGroup: "coding-balanced",
      minEvalScore: 0.8,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 64_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
    });
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: created.route.route_id,
      modelProfileId: profile.model_profile_id,
      priority: 1,
    });
    return created.route;
  }

  it("simulation과 실제 reservation이 같은 선택 이유를 사용하고 simulation에는 secret이 없다", async () => {
    const created = await route();
    const request = { routeName: created.name, estimatedTokens: 100, estimatedCostMicros: 1_000 };
    const simulated = await router.simulate(context, request);
    const reserved = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });

    expect(simulated.status).toBe("selected");
    expect(simulated.credential?.credential_id).toBe(reserved.credential?.credential_id);
    expect(JSON.stringify(simulated)).not.toContain("secret-account");
    expect(reserved.secret).toBe(`secret-${reserved.credential?.label ?? ""}`);
    expect(reserved.attempt.status).toBe("reserved");
  });

  it("조직에 설정된 route를 secret 없이 목록으로 조회한다", async () => {
    const created = await route("weighted");
    await expect(router.listModels(context)).resolves.toEqual([
      expect.objectContaining({ model_profile_id: profile.model_profile_id, model_id: "gpt-coding" }),
    ]);
    await expect(router.listCandidates(context, created.route_id)).resolves.toEqual([
      expect.objectContaining({ route_id: created.route_id, model_profile_id: profile.model_profile_id }),
    ]);
    await expect(router.listRoutes(context)).resolves.toEqual([
      expect.objectContaining({ route_id: created.route_id, name: created.name, credential_policy: "weighted" }),
    ]);
    expect(JSON.stringify(await router.listRoutes(context))).not.toContain("secret-account");
  });

  it("동시 round-robin reservation이 서로 다른 account를 선택한다", async () => {
    const created = await route();
    const results = await Promise.all([
      router.reserve(context, {
        commandId: crypto.randomUUID(),
        routeName: created.name,
        estimatedTokens: 10,
        estimatedCostMicros: 10,
      }),
      router.reserve(context, {
        commandId: crypto.randomUUID(),
        routeName: created.name,
        estimatedTokens: 10,
        estimatedCostMicros: 10,
      }),
    ]);

    expect(new Set(results.map((result) => result.credential?.credential_id)).size).toBe(2);
  });

  it("신선한 구독 quota window 하나라도 소진되면 Connector Credential을 실제 후보에서 제외한다", async () => {
    await database.query(
      `UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id;
       CREATE subscription_connector CONTENT {
         connector_id: 'router-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['openai'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Router Subscription",
      connectorId: "router-edge",
      profileLocator: "router-profile",
      billingKind: "consumer-subscription",
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      endpointId: endpoint.endpoint_id,
      label: "router-subscription",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    await quota.record(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      windows: [
        {
          kind: "five-hour",
          remainingRatio: 0,
          observedAt: new Date().toISOString(),
          source: "provider-reported",
          confidence: "reported",
        },
        {
          kind: "weekly",
          remainingRatio: 0.8,
          observedAt: new Date().toISOString(),
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });
    const created = await route("adaptive");

    await expect(
      router.simulate(context, { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 10 }),
    ).resolves.toMatchObject({ status: "blocked_model_unavailable" });

    await quota.record(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      windows: [
        {
          kind: "five-hour",
          remainingRatio: 0.5,
          observedAt: new Date().toISOString(),
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });
    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });
    expect(reservation.material).toEqual({
      kind: "connector_session",
      accountId: account.account_id,
      connectorId: "router-edge",
    });
    expect(reservation).not.toHaveProperty("secret");
  });

  it("capability·eval·equivalence와 local-private 위반 Candidate를 거부한다", async () => {
    const localRoute = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: "local-private",
      routeKind: "chat",
      credentialPolicy: "priority",
      dataPolicy: "local-private",
      equivalenceGroup: "coding-balanced",
      minEvalScore: 0.95,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: true,
      requireStreaming: true,
      maxContextTokens: 200_000,
      requestBudgetMicros: 1_000,
      totalBudgetMicros: 10_000,
    });

    await expect(
      router.addCandidate(context, {
        commandId: crypto.randomUUID(),
        routeId: localRoute.route.route_id,
        modelProfileId: profile.model_profile_id,
        priority: 1,
      }),
    ).rejects.toThrow("요구사항을 충족하지 않습니다");
  });

  it("request·total budget을 simulation과 reservation에서 차단한다", async () => {
    const created = await route();
    expect(
      (
        await router.simulate(context, {
          routeName: created.name,
          estimatedTokens: 10,
          estimatedCostMicros: 10_001,
        })
      ).status,
    ).toBe("blocked_model_unavailable");
    await expect(
      router.reserve(context, {
        commandId: crypto.randomUUID(),
        routeName: created.name,
        estimatedTokens: 10,
        estimatedCostMicros: 10_001,
      }),
    ).rejects.toThrow("요청 예산");
  });

  it("401 인증 실패는 해당 계정을 비활성화하고 다른 계정으로 안전하게 fallback한다", async () => {
    const created = await route();
    const request = { routeName: created.name, estimatedTokens: 100, estimatedCostMicros: 1_000 };
    const first = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });

    const outcome = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      actualInputTokens: 25,
      actualOutputTokens: 0,
      actualCostMicros: 100,
    });

    expect(outcome.attempt.status).toBe("failed");
    expect(outcome.attempt.failure_class).toBe("authentication");
    expect(outcome.attempt.fallback_allowed).toBe(true);
    expect(outcome.next?.credential?.credential_id).not.toBe(first.credential?.credential_id);

    const fallback = await router.reserve(context, {
      ...request,
      commandId: crypto.randomUUID(),
      fallbackFromAttemptId: first.attempt.attempt_id,
    });
    expect(fallback.credential?.credential_id).not.toBe(first.credential?.credential_id);
  });

  it("429 요청 제한은 Retry-After까지 계정을 cooldown하고 다른 계정을 제안한다", async () => {
    const created = await route();
    const request = { routeName: created.name, estimatedTokens: 100, estimatedCostMicros: 1_000 };
    const first = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    const before = Date.now();

    const outcome = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 429, retryAfter: "120" },
      emittedTokens: 0,
      actualInputTokens: 10,
      actualOutputTokens: 0,
      actualCostMicros: 50,
    });
    const [credentials] = await database.query<[Array<{ status: string; cooldown_until?: unknown }>]>(
      "SELECT status, cooldown_until FROM provider_credential WHERE credential_id = $credential_id;",
      { credential_id: first.credential?.credential_id },
    );

    expect(outcome.attempt.failure_class).toBe("quota");
    expect(outcome.next?.credential?.credential_id).not.toBe(first.credential?.credential_id);
    expect(credentials[0]?.status).toBe("cooldown");
    expect(new Date(String(credentials[0]?.cooldown_until)).getTime()).toBeGreaterThanOrEqual(before + 119_000);
  });

  it("429에 Retry-After가 없으면 저장된 quota reset까지 cooldown한다", async () => {
    const created = await route();
    const first = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const credential = first.credential;
    if (!credential) throw new Error("선택된 Credential이 없습니다");
    await providers.updateCredentialQuota(context, {
      commandId: crypto.randomUUID(),
      credentialId: credential.credential_id,
      expectedVersion: credential.version,
      limit: 100,
      remaining: 0,
      resetAt,
    });
    const outcome = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 429 },
      emittedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });

    expect(new Date(String(outcome.attempt.retry_at)).toISOString()).toBe(resetAt);
  });

  it("일부 토큰이 출력된 실패는 interrupted로 기록하고 자동 fallback하지 않는다", async () => {
    const created = await route();
    const first = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });
    const outcome = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 503 },
      emittedTokens: 1,
      actualInputTokens: 10,
      actualOutputTokens: 1,
      actualCostMicros: 100,
    });

    expect(outcome.attempt.status).toBe("interrupted");
    expect(outcome.attempt.fallback_allowed).toBe(false);
    expect(outcome.next).toBeUndefined();
  });

  it("동일 endpoint의 연속 upstream 실패가 3회면 circuit을 열어 신규 선택을 차단한다", async () => {
    const created = await route();
    const request = { routeName: created.name, estimatedTokens: 100, estimatedCostMicros: 100 };
    for (let index = 0; index < 3; index += 1) {
      const reserved = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
      await router.reportFailure(context, {
        commandId: crypto.randomUUID(),
        attemptId: reserved.attempt.attempt_id,
        signal: { kind: "http", statusCode: 503 },
        emittedTokens: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
      });
    }

    const simulated = await router.simulate(context, request);
    expect(simulated.status).toBe("blocked_model_unavailable");
    expect(simulated.explanation.excluded.join(" ")).toContain("circuit open");
  });

  it("upstream 실패를 credential·endpoint·model 세 범위 circuit에 기록한다", async () => {
    const created = await route();
    const reserved = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
    });
    await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: reserved.attempt.attempt_id,
      signal: { kind: "timeout" },
      emittedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const [circuits] = await database.query<[Array<{ scope_type: string }>]>(
      "SELECT scope_type FROM router_circuit ORDER BY scope_type ASC;",
    );

    expect(circuits.map((circuit) => circuit.scope_type)).toEqual(["credential", "endpoint", "model"]);
  });

  it("성공 완료는 실제 비용과 token 사용량을 정산한다", async () => {
    const created = await route();
    const reserved = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });

    const outcome = await router.reportSuccess(context, {
      commandId: crypto.randomUUID(),
      attemptId: reserved.attempt.attempt_id,
      actualInputTokens: 40,
      actualOutputTokens: 20,
      actualCostMicros: 600,
    });
    const [routes] = await database.query<[Array<{ spent_micros: number }>]>(
      "SELECT spent_micros FROM model_route WHERE route_id = $route_id;",
      { route_id: created.route_id },
    );

    expect(outcome.attempt.status).toBe("succeeded");
    expect(outcome.attempt.actual_input_tokens).toBe(40);
    expect(outcome.attempt.actual_output_tokens).toBe(20);
    expect(outcome.attempt.actual_cost_micros).toBe(600);
    expect(routes[0]?.spent_micros).toBe(600);
  });

  it("정상 성공은 credential·endpoint·model circuit의 실패 누적을 닫고 초기화한다", async () => {
    const created = await route("fill-first");
    const request = { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 10 };
    const failed = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: failed.attempt.attempt_id,
      signal: { kind: "network" },
      emittedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const succeeded = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    await router.reportSuccess(context, {
      commandId: crypto.randomUUID(),
      attemptId: succeeded.attempt.attempt_id,
      actualInputTokens: 1,
      actualOutputTokens: 1,
      actualCostMicros: 1,
    });
    const [circuits] = await database.query<[Array<{ state: string; failure_count: number; success_count: number }>]>(
      "SELECT state, failure_count, success_count FROM router_circuit;",
    );

    expect(circuits).toHaveLength(3);
    expect(circuits.every((circuit) => circuit.state === "closed" && circuit.failure_count === 0)).toBe(true);
    expect(circuits.every((circuit) => circuit.success_count >= 1)).toBe(true);
  });

  it("chat·embedding·local-private route의 제한 상태와 복구 조치를 집계한다", async () => {
    const chat = await route();
    const embedding = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: "embedding-default",
      routeKind: "embedding",
      credentialPolicy: "priority",
      dataPolicy: "external-allowed",
      equivalenceGroup: "embedding",
      minEvalScore: 0.8,
      requireTools: false,
      requireStructuredOutput: false,
      requireVision: false,
      requireStreaming: false,
      maxContextTokens: 8_000,
      requestBudgetMicros: 1_000,
      totalBudgetMicros: 10_000,
    });
    const local = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: "local-private-default",
      routeKind: "chat",
      credentialPolicy: "priority",
      dataPolicy: "local-private",
      equivalenceGroup: "local",
      minEvalScore: 0.8,
      requireTools: false,
      requireStructuredOutput: false,
      requireVision: false,
      requireStreaming: false,
      maxContextTokens: 8_000,
      requestBudgetMicros: 1_000,
      totalBudgetMicros: 10_000,
    });

    const diagnostic = await router.diagnose(context, [
      { routeName: chat.name, estimatedTokens: 1, estimatedCostMicros: 1 },
      { routeName: embedding.route.name, estimatedTokens: 1, estimatedCostMicros: 1 },
      { routeName: local.route.name, estimatedTokens: 1, estimatedCostMicros: 1 },
    ]);

    expect(diagnostic.status).toBe("degraded");
    expect(
      diagnostic.routes.find((item) => item.routeKind === "chat" && item.dataPolicy === "external-allowed")?.status,
    ).toBe("available");
    expect(diagnostic.routes.find((item) => item.routeKind === "embedding")?.recovery).toContain("Candidate");
    expect(diagnostic.routes.find((item) => item.dataPolicy === "local-private")?.recovery).toContain("local");
  });
});
