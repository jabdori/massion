import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { SubscriptionAccountService, SubscriptionPolicyStore, SubscriptionQuotaService } from "@massion/subscriptions";

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

  it("adaptive는 오래된 quota snapshot을 제외 조건으로 쓰지 않고 weighted 순서로 고른다", () => {
    const now = new Date("2030-01-01T00:10:00.000Z");
    const staleExhausted: CredentialSelectionView = {
      ...credentialAt(0),
      credential_id: "stale-exhausted",
      request_count: 1,
      weight: 2,
      quota_windows: [
        {
          kind: "five-hour",
          remainingRatio: 0,
          observedAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    };
    const weightedSecond: CredentialSelectionView = {
      ...credentialAt(1),
      credential_id: "weighted-second",
      request_count: 2,
      weight: 1,
    };

    expect(selectCredential("adaptive", [weightedSecond, staleExhausted], undefined, now)?.credential_id).toBe(
      "stale-exhausted",
    );
  });
});

describe("Model Route simulation과 reservation", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let providers: ProviderService;
  let router: ModelRouter;
  let endpoint: ProviderEndpoint;
  let profile: ModelProfile;
  let accounts: SubscriptionAccountService;
  let quota: SubscriptionQuotaService;
  let policies: SubscriptionPolicyStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32), {
      authorize: () => Promise.resolve({ policyVersion: "router-test-sharing-v1" }),
    });
    quota = await SubscriptionQuotaService.create(database, organizations);
    policies = await SubscriptionPolicyStore.create(database, organizations);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    router = await ModelRouter.create(database, organizations, providers, { accounts, quota, policies });
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

  it("Codex 검증 profile은 runtime 가용성·공식 능력·attested runtime 근거를 append-only로 각각 보존한다", async () => {
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      adapterKind: "subscription-agent",
    });
    const codexEndpoint = (
      await providers.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai-codex",
        name: "Codex app-server",
        baseUrl: "http://127.0.0.1/codex-app-server",
        local: true,
      })
    ).endpoint;
    await database.query(
      `CREATE subscription_connector CONTENT {
         connector_id: 'codex-evidence-connector', organization_id: $organization_id,
         owner_user_id: $owner_user_id, location: 'edge',
         execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['openai-codex'], status: 'ready',
         created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const codexAccount = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      alias: "Codex Evidence",
      connectorId: "codex-evidence-connector",
      profileLocator: "codex-evidence-profile",
      billingKind: "consumer-subscription",
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      endpointId: codexEndpoint.endpoint_id,
      label: "codex-evidence-credential",
      accountId: codexAccount.account_id,
      connectorId: codexAccount.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    const base = {
      providerId: "openai-codex",
      endpointId: codexEndpoint.endpoint_id,
      modelId: "gpt-5.6-sol",
      routeKind: "chat" as const,
      contextWindow: 1_050_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: false,
      equivalenceGroup: "massion-core-general",
      evalScore: 1,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
    };

    await expect(router.registerModel(context, { commandId: crypto.randomUUID(), ...base })).rejects.toThrow(
      /근거|evidence/iu,
    );

    const registered = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      ...base,
      verificationEvidence: [
        {
          kind: "runtime-availability",
          source: "codex-app-server:model/list",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:00.000Z",
          subscriptionAccountId: codexAccount.account_id,
          claim: { modelId: "gpt-5.6-sol", hidden: false, actualAvailable: true },
        },
        {
          kind: "provider-capability-contract",
          source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
          sourceVersion: "retrieved-2026-07-12",
          observedAt: "2026-07-12T00:00:01.000Z",
          claim: { contextWindow: 1_050_000, tools: true, structuredOutput: true, vision: true, streaming: true },
        },
        {
          kind: "runtime-capability-contract",
          source: "massion:bundled-codex-runtime-attestation",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:02.000Z",
          subscriptionAccountId: codexAccount.account_id,
          claim: {
            runtimeArtifactDigest: "a".repeat(64),
            agentRuntime: true,
            contextWindow: 1_050_000,
            tools: true,
            structuredOutput: true,
            vision: false,
            streaming: false,
          },
        },
      ],
    });

    expect(registered.profile).toMatchObject({ verified: true, enabled: true, model_id: "gpt-5.6-sol" });
    await expect(router.listModelEvidence(context, registered.profile.model_profile_id)).resolves.toEqual([
      expect.objectContaining({ evidence_kind: "provider-capability-contract" }),
      expect.objectContaining({ evidence_kind: "runtime-availability" }),
      expect.objectContaining({ evidence_kind: "runtime-capability-contract" }),
    ]);
    await expect(
      database.query(
        "UPDATE model_verification_evidence SET source = 'tampered' WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
    ).rejects.toThrow(/immutable|불변/iu);
  });

  it("Codex review 정책은 Edge credential을 후보에서 제외하고 서버 credential만 선택한다", async () => {
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      adapterKind: "subscription-agent",
    });
    const codexEndpoint = (
      await providers.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai-codex",
        name: "Codex app-server",
        baseUrl: "http://127.0.0.1/codex-app-server",
        local: true,
      })
    ).endpoint;
    await database.query(
      `CREATE subscription_connector CONTENT {
         connector_id: 'codex-review-server', organization_id: $organization_id,
         owner_user_id: $owner_user_id, location: 'server',
         execution_kind: 'agent-runtime', protocol: 'codex-app-server', version: '0.144.1',
         public_key: 'server-fixture', capabilities: ['openai-codex'], status: 'ready',
         created_at: time::now(), updated_at: time::now()
       };
       CREATE subscription_connector CONTENT {
         connector_id: 'codex-review-edge', organization_id: $organization_id,
         owner_user_id: $owner_user_id, location: 'edge',
         execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['openai-codex'], status: 'ready',
         created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const serverAccount = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      alias: "Codex Server",
      connectorId: "codex-review-server",
      profileLocator: "codex-review-server-profile",
      billingKind: "consumer-subscription",
    });
    const edgeAccount = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      alias: "Codex Edge",
      connectorId: "codex-review-edge",
      profileLocator: "codex-review-edge-profile",
      billingKind: "consumer-subscription",
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      endpointId: codexEndpoint.endpoint_id,
      label: "codex-review-edge-credential",
      accountId: edgeAccount.account_id,
      connectorId: edgeAccount.connector_id,
      scope: "personal",
      priority: 0,
      weight: 1,
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      endpointId: codexEndpoint.endpoint_id,
      label: "codex-review-server-credential",
      accountId: serverAccount.account_id,
      connectorId: serverAccount.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    const registered = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      endpointId: codexEndpoint.endpoint_id,
      modelId: "gpt-5.6-sol",
      routeKind: "chat",
      contextWindow: 1_050_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: false,
      equivalenceGroup: "codex-review",
      evalScore: 1,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
      verificationEvidence: [
        {
          kind: "runtime-availability",
          source: "codex-app-server:model/list",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:00.000Z",
          subscriptionAccountId: serverAccount.account_id,
          claim: { modelId: "gpt-5.6-sol", actualAvailable: true },
        },
        {
          kind: "provider-capability-contract",
          source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
          sourceVersion: "retrieved-2026-07-12",
          observedAt: "2026-07-12T00:00:01.000Z",
          claim: { contextWindow: 1_050_000, tools: true, structuredOutput: true },
        },
        {
          kind: "runtime-capability-contract",
          source: "massion:bundled-codex-runtime-attestation",
          sourceVersion: "0.144.1",
          observedAt: "2026-07-12T00:00:02.000Z",
          subscriptionAccountId: serverAccount.account_id,
          claim: {
            runtimeArtifactDigest: "b".repeat(64),
            agentRuntime: true,
            contextWindow: 1_050_000,
            tools: true,
            structuredOutput: true,
            vision: false,
            streaming: false,
          },
        },
      ],
    });
    const created = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: `codex-review-${crypto.randomUUID()}`,
      routeKind: "chat",
      credentialPolicy: "priority",
      dataPolicy: "external-allowed",
      equivalenceGroup: "codex-review",
      minEvalScore: 0,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: false,
      maxContextTokens: 100,
      requestBudgetMicros: 10,
      totalBudgetMicros: 100,
    });
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: created.route.route_id,
      modelProfileId: registered.profile.model_profile_id,
      priority: 1,
    });
    await policies.configure(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      credentialPolicy: "priority",
      approvalMode: "review",
    });

    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.route.name,
      estimatedTokens: 10,
      estimatedCostMicros: 0,
    });

    expect(reservation.credential?.subscription_connector_id).toBe("codex-review-server");
    expect(reservation.explanation.excluded.join(" ")).toMatch(/Edge 연결 표면.*review/u);
  });

  it("제공자별 구독 정책을 실제 credential 선택에 적용하고 사용한 version을 Attempt에 고정한다", async () => {
    const created = await route("round-robin");
    const [credentials] = await database.query<[Array<{ credential_id: string; label: string }>]>(
      `SELECT credential_id, label FROM provider_credential
       WHERE organization_id = $organization_id AND provider_id = 'openai' ORDER BY label ASC;`,
      { organization_id: context.organizationId },
    );
    const second = credentials.find((credential) => credential.label === "account-b");
    if (!second) throw new Error("두 번째 Credential fixture가 없습니다");
    await database.query(
      `UPDATE provider_credential SET priority = 0, last_selected_sequence = 100
       WHERE organization_id = $organization_id AND credential_id = $credential_id;`,
      { organization_id: context.organizationId, credential_id: second.credential_id },
    );
    const configured = await policies.configure(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      credentialPolicy: "priority",
    });

    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });

    expect(reservation.credential?.label).toBe("account-b");
    expect(reservation.attempt).toMatchObject({
      effective_credential_policy: "priority",
      subscription_policy_version_id: configured.policyVersionId,
      subscription_policy_version: 1,
      routing_policy_version: 2,
    });
    expect(reservation.explanation.selected).toContain("policy=priority");
    expect(reservation.explanation.selected).toContain(`subscription-policy-version=${configured.policyVersionId}`);
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

  it("Route Attempt 정본 reader는 현재 조직의 예약 실행자에게만 원문을 반환한다", async () => {
    const created = await route();
    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });
    const other = await identity.registerPersonalUser({
      email: `other-${crypto.randomUUID()}@example.com`,
      displayName: "Other",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await organizations.addMember(context, other.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(other.user.user_id, context.organizationId);
    const memberReservation = await router.reserve(memberContext, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });

    await expect(router.readAttempt(context, reservation.attempt.attempt_id)).resolves.toMatchObject({
      attempt_id: reservation.attempt.attempt_id,
      organization_id: context.organizationId,
      status: "reserved",
    });
    await expect(router.readAttempt(memberContext, memberReservation.attempt.attempt_id)).resolves.toMatchObject({
      attempt_id: memberReservation.attempt.attempt_id,
      organization_id: context.organizationId,
      status: "reserved",
    });
    await expect(router.readAttempt(context, memberReservation.attempt.attempt_id)).rejects.toThrow(/예약|사용자/iu);
    await expect(router.readAttempt(memberContext, reservation.attempt.attempt_id)).rejects.toThrow(/예약|사용자/iu);
    await expect(router.readAttempt(otherContext, reservation.attempt.attempt_id)).rejects.toThrow("Route Attempt");
    await expect(
      router.readAttempt({ ...otherContext, organizationId: context.organizationId }, reservation.attempt.attempt_id),
    ).rejects.toThrow("TenantContext");
  });

  it("같은 조직의 다른 사용자는 기존 reservation commandId를 재사용할 수 없다", async () => {
    const created = await route();
    const member = await identity.registerPersonalUser({
      email: `member-${crypto.randomUUID()}@example.com`,
      displayName: "Member",
    });
    await organizations.addMember(context, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    const commandId = crypto.randomUUID();
    const request = {
      commandId,
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    };

    await router.reserve(context, request);

    await expect(router.reserve(memberContext, request)).rejects.toThrow(
      "같은 commandId를 다른 사용자가 재사용할 수 없습니다",
    );
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
      scope: "personal",
    });
    expect(reservation).not.toHaveProperty("secret");
  });

  it("조직에 공유된 구독 계정은 다른 구성원이 사용하고 공유 철회 즉시 신규 선택에서 제외한다", async () => {
    await database.query(
      `UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id;
       CREATE subscription_connector CONTENT {
         connector_id: 'shared-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['openai'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Shared Router Subscription",
      connectorId: "shared-edge",
      profileLocator: "shared-router-profile",
      billingKind: "consumer-subscription",
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      endpointId: endpoint.endpoint_id,
      label: "shared-router-subscription",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    const created = await route("round-robin");
    const member = await identity.registerPersonalUser({
      email: `shared-member-${crypto.randomUUID()}@example.com`,
      displayName: "Shared Member",
    });
    await organizations.addMember(context, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    const request = { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 10 };

    await expect(router.simulate(memberContext, request)).resolves.toMatchObject({
      status: "blocked_model_unavailable",
    });
    const shared = await accounts.share(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      expectedVersion: 1,
    });
    const memberReservation = await router.reserve(memberContext, {
      ...request,
      commandId: crypto.randomUUID(),
    });
    expect(memberReservation.material).toEqual({
      kind: "connector_session",
      accountId: account.account_id,
      connectorId: "shared-edge",
      scope: "organization",
    });
    await expect(
      router.reportSuccess(memberContext, {
        commandId: crypto.randomUUID(),
        attemptId: memberReservation.attempt.attempt_id,
        actualInputTokens: 3,
        actualOutputTokens: 1,
        actualCostMicros: 0,
      }),
    ).resolves.toMatchObject({ attempt: { status: "succeeded" } });

    const memberFailureReservation = await router.reserve(memberContext, {
      ...request,
      commandId: crypto.randomUUID(),
    });
    await expect(
      router.reportSuccess(context, {
        commandId: crypto.randomUUID(),
        attemptId: memberFailureReservation.attempt.attempt_id,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
      }),
    ).rejects.toThrow(/예약|사용자|commandId/iu);
    await expect(
      router.reportFailure(memberContext, {
        commandId: crypto.randomUUID(),
        attemptId: memberFailureReservation.attempt.attempt_id,
        signal: { kind: "input" },
        emittedTokens: 0,
        sideEffectsStarted: false,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
      }),
    ).resolves.toMatchObject({ attempt: { status: "failed" } });

    await accounts.unshare(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      expectedVersion: shared.version,
    });
    await expect(router.simulate(memberContext, request)).resolves.toMatchObject({
      status: "blocked_model_unavailable",
    });
    const ownerReservation = await router.reserve(context, {
      ...request,
      commandId: crypto.randomUUID(),
    });
    expect(ownerReservation.material).toMatchObject({ kind: "connector_session", scope: "personal" });
  });

  it("encrypted 구독 Credential도 계정·Connector·scope와 신선한 quota를 검증한 뒤 direct model secret을 반환한다", async () => {
    await database.query(
      `UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id;
       CREATE subscription_connector CONTENT {
         connector_id: 'encrypted-model', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'server', execution_kind: 'model', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['minimax-token-plan'], status: 'ready',
         created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const ensured = await providers.ensureSubscriptionProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "MiniMax Token Plan",
      connectorId: "encrypted-model",
      profileLocator: "encrypted-profile",
      billingKind: "token-plan",
      requiredExecutionKind: "model",
      requiredCapability: "minimax-token-plan",
    });
    const added = await providers.addSubscriptionCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      endpointId: ensured.endpoint.endpoint_id,
      label: "MiniMax encrypted subscription",
      authKind: "subscription-key",
      secret: "minimax-test-subscription-key",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    const subscriptionProfile = (
      await router.registerModel(context, {
        commandId: crypto.randomUUID(),
        providerId: "minimax-token-plan",
        endpointId: ensured.endpoint.endpoint_id,
        modelId: "MiniMax-M2.7",
        routeKind: "chat",
        contextWindow: 128_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "coding-balanced",
        evalScore: 0.9,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      })
    ).profile;
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
      ],
    });
    const created = await route("adaptive");
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: created.route_id,
      modelProfileId: subscriptionProfile.model_profile_id,
      priority: 2,
    });

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
      kind: "encrypted_secret",
      secret: "minimax-test-subscription-key",
      secretVersion: 1,
    });
    expect(reservation.credential?.credential_id).toBe(added.credential.credential_id);
    expect(reservation.quotaSnapshotId).toBeDefined();

    const rateLimitCommandId = crypto.randomUUID();
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    await router.reportFailure(context, {
      commandId: rateLimitCommandId,
      attemptId: reservation.attempt.attempt_id,
      signal: { kind: "http", statusCode: 429, retryAfter: retryAt },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const rateLimitedQuota = await quota.current(context, account.account_id);
    expect(rateLimitedQuota).toMatchObject({
      accountId: account.account_id,
      exhausted: true,
      windows: [
        {
          kind: "rate-limit",
          remainingRatio: 0,
          resetsAt: retryAt,
          source: "router-http-429",
          confidence: "derived",
        },
      ],
    });
    expect(rateLimitedQuota?.snapshotId).not.toBe(reservation.quotaSnapshotId);
    const [quotaEvents] = await database.query<
      [Array<{ event_type: string; resource_id: string; result_json: string }>]
    >(
      `SELECT event_type, resource_id, result_json FROM subscription_audit_event
       WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: context.organizationId, command_id: `${rateLimitCommandId}:subscription-quota` },
    );
    expect(quotaEvents[0]).toMatchObject({
      event_type: "subscription_quota_observed",
      resource_id: account.account_id,
    });
    expect(quotaEvents[0]?.result_json).not.toContain("minimax-test-subscription-key");

    await database.query(
      `UPDATE provider_credential SET status = 'active', cooldown_until = NONE
       WHERE organization_id = $organization_id AND credential_id = $credential_id;`,
      { organization_id: context.organizationId, credential_id: added.credential.credential_id },
    );
    await quota.record(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      windows: [
        {
          kind: "rate-limit",
          remainingRatio: 0,
          resetsAt: new Date(Date.now() - 1_000).toISOString(),
          observedAt: new Date().toISOString(),
          source: "router-http-429",
          confidence: "derived",
        },
      ],
    });
    const recoveredAfterReset = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });
    expect(recoveredAfterReset.credential?.credential_id).toBe(added.credential.credential_id);

    await database.query(
      `UPDATE subscription_connector SET status = 'offline'
       WHERE organization_id = $organization_id AND connector_id = 'encrypted-model';`,
      { organization_id: context.organizationId },
    );
    await expect(
      router.simulate(context, { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 10 }),
    ).resolves.toMatchObject({ status: "blocked_model_unavailable" });
  });

  it("구독 Route Attempt는 선택에 사용한 quota snapshot과 routing policy version을 직접 기록한다", async () => {
    await database.query(
      `UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id;
       CREATE subscription_connector CONTENT {
         connector_id: 'lineage-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['openai'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const account = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Lineage Subscription",
      connectorId: "lineage-edge",
      profileLocator: "lineage-profile",
      billingKind: "consumer-subscription",
    });
    await providers.addConnectorCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      endpointId: endpoint.endpoint_id,
      label: "lineage-subscription",
      accountId: account.account_id,
      connectorId: account.connector_id,
      scope: "personal",
      priority: 1,
      weight: 1,
    });
    const recorded = await quota.record(context, {
      commandId: crypto.randomUUID(),
      accountId: account.account_id,
      windows: [
        {
          kind: "weekly",
          remainingRatio: 0.7,
          observedAt: new Date().toISOString(),
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });
    const created = await route("adaptive");

    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
      stickyKey: "work-1:agent-1",
    });
    const [stored] = await database.query<[Array<{ quota_snapshot_id?: string; routing_policy_version: number }>]>(
      `SELECT quota_snapshot_id, routing_policy_version FROM route_attempt
       WHERE organization_id = $organization_id AND attempt_id = $attempt_id LIMIT 1;`,
      { organization_id: context.organizationId, attempt_id: reservation.attempt.attempt_id },
    );
    const [events] = await database.query<[Array<{ event_type: string; request_json: string; result_json: string }>]>(
      `SELECT event_type, request_json, result_json FROM router_audit_event
       WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: context.organizationId, command_id: reservation.attempt.command_id },
    );

    expect(reservation.attempt.quota_snapshot_id).toBe(recorded.snapshotId);
    expect(reservation.attempt.routing_policy_version).toBe(2);
    expect(stored[0]).toEqual({
      quota_snapshot_id: recorded.snapshotId,
      routing_policy_version: 2,
    });
    expect(events[0]?.event_type).toBe("route_attempt_recorded");
    expect(JSON.parse(events[0]?.result_json ?? "null")).toEqual({
      attemptId: reservation.attempt.attempt_id,
      candidateId: reservation.attempt.candidate_id,
      credentialId: reservation.attempt.credential_id,
      effectiveCredentialPolicy: "adaptive",
      modelProfileId: reservation.attempt.model_profile_id,
      quotaSnapshotId: recorded.snapshotId,
      routeId: reservation.attempt.route_id,
      routingPolicyVersion: 2,
    });
    expect(events[0]?.request_json).not.toContain("work-1:agent-1");
    expect(JSON.stringify(reservation.attempt)).not.toContain("work-1:agent-1");
    await expect(
      database.query(
        `UPDATE route_attempt SET quota_snapshot_id = 'tampered', routing_policy_version = 999
         WHERE organization_id = $organization_id AND attempt_id = $attempt_id;`,
        { organization_id: context.organizationId, attempt_id: reservation.attempt.attempt_id },
      ),
    ).rejects.toThrow(/read.?only|readonly/iu);
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
      sideEffectsStarted: false,
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

  it("구독 401은 계정을 needs-reauth로 전이하고 검증 복구 전까지 Credential을 제외한다", async () => {
    await database.query(
      `UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id;
       CREATE subscription_connector CONTENT {
         connector_id: 'reauth-edge-a', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
         public_key: 'fixture-a', capabilities: ['openai'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };
       CREATE subscription_connector CONTENT {
         connector_id: 'reauth-edge-b', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion.connector.v1', version: '1.0.0',
         public_key: 'fixture-b', capabilities: ['openai'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    const accountA = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Reauth A",
      connectorId: "reauth-edge-a",
      profileLocator: "reauth-profile-a",
      billingKind: "consumer-subscription",
    });
    const accountB = await accounts.register(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      alias: "Reauth B",
      connectorId: "reauth-edge-b",
      profileLocator: "reauth-profile-b",
      billingKind: "consumer-subscription",
    });
    const credentialA = (
      await providers.addConnectorCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai",
        endpointId: endpoint.endpoint_id,
        label: "reauth-account-a",
        accountId: accountA.account_id,
        connectorId: accountA.connector_id,
        scope: "personal",
        priority: 0,
        weight: 1,
      })
    ).credential;
    const credentialB = (
      await providers.addConnectorCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai",
        endpointId: endpoint.endpoint_id,
        label: "reauth-account-b",
        accountId: accountB.account_id,
        connectorId: accountB.connector_id,
        scope: "personal",
        priority: 1,
        weight: 1,
      })
    ).credential;
    const created = await route("fill-first");
    const request = { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 0 };
    const first = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    expect(first.credential?.credential_id).toBe(credentialA.credential_id);

    const failed = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const [failedAccounts, failedCredentials] = await database.query<
      [
        Array<{ status: string; version: number }>,
        Array<{ credential_id: string; status: string; reauth_required?: boolean }>,
      ]
    >(
      `SELECT status, version FROM subscription_account
       WHERE organization_id = $organization_id AND account_id = $account_id;
       SELECT credential_id, status, reauth_required FROM provider_credential
       WHERE organization_id = $organization_id AND credential_id IN [$credential_a, $credential_b]
       ORDER BY credential_id ASC;`,
      {
        organization_id: context.organizationId,
        account_id: accountA.account_id,
        credential_a: credentialA.credential_id,
        credential_b: credentialB.credential_id,
      },
    );
    expect(failedAccounts).toEqual([{ status: "needs-reauth", version: 2 }]);
    expect(
      failedCredentials.find((credential) => credential.credential_id === credentialA.credential_id),
    ).toMatchObject({
      status: "disabled",
      reauth_required: true,
    });
    expect(failed.next?.credential?.credential_id).toBe(credentialB.credential_id);

    const fallback = await router.reserve(context, {
      ...request,
      commandId: crypto.randomUUID(),
      fallbackFromAttemptId: first.attempt.attempt_id,
    });
    expect(fallback.credential?.credential_id).toBe(credentialB.credential_id);

    await database.query(
      `UPDATE subscription_account SET status = 'active', version += 1, updated_at = time::now()
       WHERE organization_id = $organization_id AND account_id = $account_id;
       UPDATE provider_credential SET status = 'disabled'
       WHERE organization_id = $organization_id AND credential_id = $credential_b;`,
      {
        organization_id: context.organizationId,
        account_id: accountA.account_id,
        credential_b: credentialB.credential_id,
      },
    );
    const recovered = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    const [recoveredCredential] = await database.query<[Array<{ status: string; reauth_required?: boolean }>]>(
      `SELECT status, reauth_required FROM provider_credential
       WHERE organization_id = $organization_id AND credential_id = $credential_id;`,
      { organization_id: context.organizationId, credential_id: credentialA.credential_id },
    );
    expect(recovered.credential?.credential_id).toBe(credentialA.credential_id);
    expect(recoveredCredential).toEqual([{ status: "active", reauth_required: false }]);
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
      sideEffectsStarted: false,
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
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });

    expect(new Date(String(outcome.attempt.retry_at)).toISOString()).toBe(resetAt);
  });

  it("cooldown 종료 시각이 지나면 계정을 다시 활성화하고 제한 시각을 제거한다", async () => {
    const created = await route("fill-first");
    const [credentials] = await database.query<[Array<{ credential_id: string; label: string }>]>(
      "SELECT credential_id, label FROM provider_credential WHERE organization_id = $organization_id ORDER BY label ASC;",
      { organization_id: context.organizationId },
    );
    const recovering = credentials[0];
    const unavailable = credentials[1];
    if (!recovering || !unavailable) throw new Error("Credential fixture가 부족합니다");
    await database.query(
      `UPDATE provider_credential SET status = 'cooldown', cooldown_until = $expired_at
       WHERE organization_id = $organization_id AND credential_id = $recovering_id;
       UPDATE provider_credential SET status = 'disabled'
       WHERE organization_id = $organization_id AND credential_id = $unavailable_id;`,
      {
        organization_id: context.organizationId,
        recovering_id: recovering.credential_id,
        unavailable_id: unavailable.credential_id,
        expired_at: new Date(Date.now() - 1_000),
      },
    );

    const reservation = await router.reserve(context, {
      commandId: crypto.randomUUID(),
      routeName: created.name,
      estimatedTokens: 10,
      estimatedCostMicros: 10,
    });
    const [updated] = await database.query<[Array<{ status: string; cooldown_until?: unknown }>]>(
      "SELECT status, cooldown_until FROM provider_credential WHERE credential_id = $credential_id;",
      { credential_id: recovering.credential_id },
    );

    expect(reservation.credential?.credential_id).toBe(recovering.credential_id);
    expect(updated[0]?.status).toBe("active");
    expect(updated[0]?.cooldown_until).toBeUndefined();
  });

  it("같은 제공자의 계정이 모두 불가하면 동급 모델의 다음 제공자로 fallback한다", async () => {
    const created = await route("fill-first");
    const [openAiCredentials] = await database.query<[Array<{ credential_id: string; label: string }>]>(
      "SELECT credential_id, label FROM provider_credential WHERE organization_id = $organization_id AND provider_id = 'openai' ORDER BY label ASC;",
      { organization_id: context.organizationId },
    );
    const unavailable = openAiCredentials[1];
    if (!unavailable) throw new Error("두 번째 OpenAI Credential fixture가 없습니다");
    await database.query(
      "UPDATE provider_credential SET status = 'disabled' WHERE organization_id = $organization_id AND credential_id = $credential_id;",
      { organization_id: context.organizationId, credential_id: unavailable.credential_id },
    );
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "anthropic",
      displayName: "Anthropic",
      adapterKind: "ai-sdk",
    });
    const anthropicEndpoint = (
      await providers.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "anthropic",
        name: "Anthropic API",
        baseUrl: "https://api.anthropic.com",
        local: false,
      })
    ).endpoint;
    await providers.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "anthropic",
      endpointId: anthropicEndpoint.endpoint_id,
      label: "anthropic-account",
      credentialType: "api_key",
      secret: "secret-anthropic-account",
      priority: 1,
      weight: 1,
    });
    const anthropicProfile = (
      await router.registerModel(context, {
        commandId: crypto.randomUUID(),
        providerId: "anthropic",
        endpointId: anthropicEndpoint.endpoint_id,
        modelId: "claude-coding",
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
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: created.route_id,
      modelProfileId: anthropicProfile.model_profile_id,
      priority: 2,
    });
    const request = { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 10 };
    const first = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    const outcome = await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "http", statusCode: 503 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const fallback = await router.reserve(context, {
      ...request,
      commandId: crypto.randomUUID(),
      fallbackFromAttemptId: first.attempt.attempt_id,
    });

    expect(first.profile?.provider_id).toBe("openai");
    expect(outcome.next?.profile?.provider_id).toBe("anthropic");
    expect(fallback.profile?.provider_id).toBe("anthropic");
    expect(fallback.attempt.fallback_from_attempt_id).toBe(first.attempt.attempt_id);
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
      sideEffectsStarted: false,
      actualInputTokens: 10,
      actualOutputTokens: 1,
      actualCostMicros: 100,
    });

    expect(outcome.attempt.status).toBe("interrupted");
    expect(outcome.attempt.fallback_allowed).toBe(false);
    expect(outcome.next).toBeUndefined();
  });

  it("출력 전이라도 외부 부작용이 시작됐으면 interrupted로 기록하고 fallback을 금지한다", async () => {
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
      emittedTokens: 0,
      sideEffectsStarted: true,
      actualInputTokens: 10,
      actualOutputTokens: 0,
      actualCostMicros: 100,
    });

    expect(outcome.attempt).toMatchObject({
      status: "interrupted",
      emitted_tokens: 0,
      side_effects_started: true,
      fallback_allowed: false,
    });
    expect(outcome.next).toBeUndefined();
    await expect(
      router.reserve(context, {
        commandId: crypto.randomUUID(),
        routeName: created.name,
        estimatedTokens: 100,
        estimatedCostMicros: 1_000,
        fallbackFromAttemptId: first.attempt.attempt_id,
      }),
    ).rejects.toThrow("fallback");
  });

  it("fallback 전체 Attempt 체인의 Credential을 제외해 A→B→C 뒤 A로 순환하지 않는다", async () => {
    await providers.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      endpointId: endpoint.endpoint_id,
      label: "account-c",
      credentialType: "api_key",
      secret: "secret-account-c",
      priority: 1,
      weight: 1,
    });
    const created = await route("fill-first");
    const request = { routeName: created.name, estimatedTokens: 10, estimatedCostMicros: 0 };
    const attempts = [];
    let fallbackFromAttemptId: string | undefined;

    for (let index = 0; index < 3; index += 1) {
      const reserved = await router.reserve(context, {
        ...request,
        commandId: crypto.randomUUID(),
        ...(fallbackFromAttemptId ? { fallbackFromAttemptId } : {}),
      });
      attempts.push(reserved);
      const outcome = await router.reportFailure(context, {
        commandId: crypto.randomUUID(),
        attemptId: reserved.attempt.attempt_id,
        signal: { kind: "network" },
        emittedTokens: 0,
        sideEffectsStarted: false,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
      });
      fallbackFromAttemptId = reserved.attempt.attempt_id;
      if (index < 2) expect(outcome.next?.status).toBe("selected");
      else expect(outcome.next?.status).toBe("blocked_model_unavailable");
    }

    expect(new Set(attempts.map((attempt) => attempt.credential?.credential_id)).size).toBe(3);
    await expect(
      router.reserve(context, {
        ...request,
        commandId: crypto.randomUUID(),
        fallbackFromAttemptId,
      }),
    ).rejects.toThrow("blocked_model_unavailable");
  });

  it("fallback 체인의 순환·다른 Route·다른 예약 사용자를 fail-closed한다", async () => {
    const firstRoute = await route("fill-first");
    const request = { routeName: firstRoute.name, estimatedTokens: 10, estimatedCostMicros: 0 };
    const first = await router.reserve(context, { ...request, commandId: crypto.randomUUID() });
    await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: first.attempt.attempt_id,
      signal: { kind: "network" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    const second = await router.reserve(context, {
      ...request,
      commandId: crypto.randomUUID(),
      fallbackFromAttemptId: first.attempt.attempt_id,
    });
    await router.reportFailure(context, {
      commandId: crypto.randomUUID(),
      attemptId: second.attempt.attempt_id,
      signal: { kind: "network" },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });

    const otherRoute = await route("priority");
    await expect(
      router.reserve(context, {
        commandId: crypto.randomUUID(),
        routeName: otherRoute.name,
        estimatedTokens: 10,
        estimatedCostMicros: 0,
        fallbackFromAttemptId: second.attempt.attempt_id,
      }),
    ).rejects.toThrow(/Route|fallback/iu);

    const member = await identity.registerPersonalUser({
      email: `fallback-member-${crypto.randomUUID()}@example.com`,
      displayName: "Fallback Member",
    });
    await organizations.addMember(context, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    await expect(
      router.reserve(memberContext, {
        ...request,
        commandId: crypto.randomUUID(),
        fallbackFromAttemptId: second.attempt.attempt_id,
      }),
    ).rejects.toThrow(/사용자|commandId/iu);

    await database.query(
      `UPDATE route_attempt SET fallback_from_attempt_id = $second_attempt_id
       WHERE organization_id = $organization_id AND attempt_id = $first_attempt_id;`,
      {
        organization_id: context.organizationId,
        first_attempt_id: first.attempt.attempt_id,
        second_attempt_id: second.attempt.attempt_id,
      },
    );
    await expect(
      router.reserve(context, {
        ...request,
        commandId: crypto.randomUUID(),
        fallbackFromAttemptId: second.attempt.attempt_id,
      }),
    ).rejects.toThrow(/순환|fallback/iu);
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
        sideEffectsStarted: false,
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
      sideEffectsStarted: false,
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
      sideEffectsStarted: false,
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
