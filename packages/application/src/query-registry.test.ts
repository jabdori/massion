import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import type { ApplicationReadModel } from "./read-model.js";
import { ApplicationQueryRegistry, registerApplicationQueries } from "./query-registry.js";

const context: TenantContext = {
  userId: "query-user",
  organizationId: "query-organization",
  membershipId: "query-membership",
  role: "member",
};

const readModel: ApplicationReadModel = {
  watermarks: async () => ({ work: 1 }),
  organization: async () => ({ organizationId: context.organizationId, version: 1, nodes: [] }),
  works: async () => [
    { organizationId: context.organizationId, workId: "query-work", status: "running", revision: 2, artifactIds: [] },
  ],
  tasks: async () => [
    {
      organizationId: context.organizationId,
      workId: "query-work",
      taskId: "query-task",
      title: "조회",
      status: "ready",
      revision: 1,
    },
  ],
  assignments: async () => [],
  executions: async () => [],
  rooms: async () => [],
  approvals: async () => [
    {
      organizationId: context.organizationId,
      approvalId: "query-approval",
      action: "tool.call",
      status: "pending",
      requestedBy: "agent",
      expiresAt: "2026-07-11T05:00:00.000Z",
      displayPreview: {
        kind: "command",
        title: "명령 실행",
        executable: "git",
        arguments: ["status", "--short"],
        cwd: "/workspace/project",
      },
    },
  ],
  extensions: async () => [],
};

describe("ApplicationQueryRegistry", () => {
  it("공개 read model 조회를 allowlist·scope로 제공한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["work:read"], "work.list", {})).resolves.toMatchObject({
      operation: "work.list",
      data: [{ workId: "query-work", status: "running", revision: 2, artifactIds: [] }],
    });
    await expect(registry.query(context, ["work:read"], "work.tasks", { workId: "query-work" })).resolves.toMatchObject(
      {
        data: [{ taskId: "query-task" }],
      },
    );
    await expect(registry.query(context, ["work:read"], "governance.approval.list", {})).rejects.toMatchObject({
      category: "authorization",
    });
  });

  it("unknown operation·payload field와 role을 거부한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["application:*"], "unknown.read", {})).rejects.toMatchObject({
      category: "validation",
    });
    await expect(registry.query(context, ["work:read"], "work.list", { injected: true })).rejects.toThrow("알 수 없는");
  });

  it("승인 목록과 단건 조회에 비밀 제거 표시 미리보기만 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });

    await expect(registry.query(context, ["approval:read"], "governance.approval.list", {})).resolves.toMatchObject({
      data: [
        {
          approvalId: "query-approval",
          displayPreview: {
            kind: "command",
            title: "명령 실행",
            executable: "git",
            arguments: ["status", "--short"],
            cwd: "/workspace/project",
          },
        },
      ],
    });
    await expect(
      registry.query(context, ["approval:read"], "governance.approval.get", { approvalId: "query-approval" }),
    ).resolves.toMatchObject({
      data: {
        approvalId: "query-approval",
        displayPreview: {
          kind: "command",
          executable: "git",
          arguments: ["status", "--short"],
        },
      },
    });
  });

  it("성장 제안 목록을 secret patch 없이 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      growth: {
        resolveConfiguration: async () => ({}),
        getActiveEvaluationStrategy: async () => ({}),
        listSuggestions: async () => [
          {
            suggestion_id: "suggestion-1",
            work_id: "query-work",
            target_kind: "prompt",
            operation: "replace-instruction",
            summary: "검증 강화",
            rationale: "반복 오류 감소",
            expected_effect: "회귀 감소",
            risk_summary: "지시문 증가",
            status: "proposed",
            patch_json: '{"secret":"공개 금지"}',
          },
        ],
        listEffectEvaluations: async () => [
          {
            effectEvaluationId: "effect-1",
            adoptionId: "adoption-1",
            result: "improved",
            rawDelta: 0.1,
            directionalDelta: 0.1,
            contractChecksum: "a".repeat(64),
          },
        ],
      } as never,
    });
    await expect(registry.query(context, ["growth:read"], "growth.suggestions", {})).resolves.toMatchObject({
      data: [{ suggestionId: "suggestion-1", summary: "검증 강화", status: "proposed" }],
    });
    expect(JSON.stringify(await registry.query(context, ["growth:read"], "growth.suggestions", {}))).not.toContain(
      "공개 금지",
    );
    await expect(registry.query(context, ["growth:read"], "growth.effects", { limit: 10 })).resolves.toMatchObject({
      data: [{ effectEvaluationId: "effect-1", result: "improved" }],
    });
  });

  it("모델 route의 운영 상태와 예산만 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      router: {
        listRoutes: async () => [
          {
            route_id: "route-1",
            name: "coding-balanced",
            route_kind: "chat",
            credential_policy: "weighted",
            data_policy: "external-allowed",
            equivalence_group: "coding",
            spent_micros: 10,
            total_budget_micros: 100,
            enabled: true,
          },
        ],
      } as never,
    });
    await expect(registry.query(context, ["router:read"], "router.routes", {})).resolves.toMatchObject({
      data: [{ routeId: "route-1", name: "coding-balanced", credentialPolicy: "weighted" }],
    });
  });

  it("제공자·endpoint·model·candidate 구성 목록을 secret 없이 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      providers: {
        listProviders: async () => [
          { provider_id: "openai", display_name: "OpenAI", adapter_kind: "openai-compatible", enabled: true },
        ],
        listEndpoints: async () => [
          {
            endpoint_id: "endpoint-1",
            provider_id: "openai",
            name: "API",
            base_url: "https://api.openai.com/v1",
            local: false,
            enabled: true,
          },
        ],
      },
      router: {
        listModels: async () => [
          {
            model_profile_id: "profile-1",
            provider_id: "openai",
            endpoint_id: "endpoint-1",
            model_id: "gpt",
            route_kind: "chat",
            equivalence_group: "general",
            verified: true,
            enabled: true,
          },
        ],
        listCandidates: async () => [
          {
            candidate_id: "candidate-1",
            route_id: "route-1",
            model_profile_id: "profile-1",
            priority: 1,
            enabled: true,
          },
        ],
      },
    } as never);
    await expect(registry.query(context, ["router:read"], "router.catalog", {})).resolves.toMatchObject({
      data: {
        providers: [{ providerId: "openai" }],
        endpoints: [{ endpointId: "endpoint-1" }],
        models: [{ modelProfileId: "profile-1" }],
        candidates: [{ candidateId: "candidate-1" }],
      },
    });
  });

  it("웹 운영 화면용 구성원·기억·감사·session을 secret 없이 조회한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      memberships: {
        listMembers: async () => [
          {
            membershipId: "query-membership",
            userId: "query-user",
            email: "member@example.com",
            displayName: "Member",
            role: "member",
            status: "active",
            revision: 0,
            createdAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      },
      growth: {
        getActiveMemories: async () => [
          {
            memoryVersionId: "memory-1",
            organizationId: context.organizationId,
            scope: "organization",
            subjectId: "organization",
            version: 1,
            status: "active",
            entries: [{ kind: "fact", key: "release", value: "공개하면 안 되는 값", sourceReferenceIds: ["record-1"] }],
            checksum: "a".repeat(64),
          },
        ],
        resolveConfiguration: async () => ({}),
        getActiveEvaluationStrategy: async () => ({}),
        listSuggestions: async () => [],
        listEffectEvaluations: async () => [],
      } as never,
      audit: {
        read: async () => ({ events: [{ type: "work.created", sequence: 1 }], cursor: 1, snapshotRequired: false }),
      } as never,
      webSessions: {
        list: async () => [
          {
            sessionId: "session-1",
            status: "active",
            issuedAt: "2026-07-11T00:00:00.000Z",
            expiresAt: "2026-07-11T08:00:00.000Z",
            idleExpiresAt: "2026-07-11T00:30:00.000Z",
            lastSeenAt: "2026-07-11T00:00:00.000Z",
            revision: 0,
          },
        ],
      },
    });

    const members = await registry.query(context, ["identity:read"], "identity.memberships", {});
    expect(members).toMatchObject({ data: [{ userId: "query-user", displayName: "Member" }] });
    expect(JSON.stringify(members)).not.toContain("member@example.com");
    const memories = await registry.query(context, ["growth:read"], "growth.memories", {});
    expect(memories).toMatchObject({ data: [{ memoryVersionId: "memory-1", entryKeys: ["release"] }] });
    expect(JSON.stringify(memories)).not.toContain("공개하면 안 되는 값");
    await expect(registry.query(context, ["audit:read"], "application.audit", {})).resolves.toMatchObject({
      data: { events: [{ type: "work.created" }], cursor: 1 },
    });
    await expect(registry.query(context, ["identity:read"], "application.sessions", {})).resolves.toMatchObject({
      data: [{ sessionId: "session-1", status: "active" }],
    });
  });

  it("구독 제공자·계정·Quota·정책·진단을 공개 필드만으로 조회한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      subscriptionProviders: {
        list: async () => [
          {
            providerId: "verified-provider",
            displayName: "검증된 제공자",
            authKinds: ["device-code"],
            executionKind: "agent-runtime",
            connectionSurface: "edge-only",
            billingKinds: ["subscription"],
            modelDiscovery: "protocol",
            quotaDiscovery: "none",
            protocol: "acp",
            protocols: ["acp"],
            availability: "supported",
            officialDocumentation: "https://example.com/provider",
            credentialPolicies: ["adaptive", "quota-headroom"],
            verified: true,
            runtimeCapabilities: {
              accountIsolation: "single-os-keyring-account",
              output: "final-text-only",
              cancellation: "protocol",
              session: "protocol",
              permissionBridge: "protocol",
              multipleAccounts: "one-account-per-connector",
              maturity: "experimental",
              approvalModes: ["automatic", "deny"],
              approvalModesBySurface: {
                server: ["automatic", "review", "deny"],
                edge: ["automatic", "deny"],
              },
            },
            clientSecret: "provider-client-secret",
          },
        ],
      },
      subscriptionAccounts: {
        list: async () => [
          {
            account_id: "subscription-account-1",
            organization_id: "organization-secret",
            owner_user_id: context.userId,
            provider_id: "verified-provider",
            alias: "업무 계정",
            scope: "personal",
            connector_id: "connector-1",
            profile_fingerprint: "profile-fingerprint-secret",
            billing_kind: "subscription",
            status: "active",
            consent_version: 0,
            version: 3,
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          },
          {
            account_id: "shared-account-1",
            organization_id: "organization-secret",
            owner_user_id: "owner-secret",
            provider_id: "verified-provider",
            alias: "공유 계정",
            scope: "organization",
            connector_id: "connector-shared",
            profile_fingerprint: "shared-profile-fingerprint-secret",
            billing_kind: "subscription",
            status: "active",
            consent_version: 1,
            version: 2,
            created_at: "2026-07-12T00:00:00.000Z",
            updated_at: "2026-07-12T00:00:00.000Z",
          },
        ],
      },
      subscriptionConnectors: {
        get: async (_context: unknown, connectorId: string) => ({
          connector_id: connectorId,
          organization_id: "organization-secret",
          owner_user_id: "owner-secret",
          location: connectorId === "connector-1" ? "edge" : "server",
          execution_kind: "agent-runtime",
          protocol: "massion-connector-v1",
          version: "1.0.0",
          public_key: "connector-public-key-secret",
          capabilities: ["session.execute"],
          status: "ready",
          expires_at: "2026-07-12T00:05:00.000Z",
          created_at: "2026-07-12T00:00:00.000Z",
          updated_at: "2026-07-12T00:00:00.000Z",
        }),
      },
      subscriptionQuota: {
        current: async (_context: unknown, accountId: string) => {
          if (accountId === "shared-account-1") throw new Error("다른 소유자의 공유 계정 Quota 조회 금지");
          return {
            accountId,
            snapshotId: "quota-snapshot-secret",
            windows: [
              {
                kind: "monthly",
                limit: 100,
                remaining: 75,
                remainingRatio: 0.75,
                resetsAt: "2026-08-01T00:00:00.000Z",
                observedAt: "2026-07-12T00:00:00.000Z",
                source: "private-quota-endpoint",
                confidence: "reported",
              },
            ],
            minimumRemainingRatio: 0.75,
            earliestResetAt: "2026-08-01T00:00:00.000Z",
            exhausted: false,
            observedAt: "2026-07-12T00:00:00.000Z",
          };
        },
      },
      subscriptionPolicy: {
        configure: async () => ({
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          version: 2,
          source: "configured",
        }),
        list: async () => [
          {
            providerId: "verified-provider",
            credentialPolicy: "quota-headroom",
            approvalMode: "deny",
            version: 2,
            source: "configured",
            updatedAt: "2026-07-12T00:00:00.000Z",
            token: "policy-token-secret",
          },
        ],
      },
    } as never);

    const providers = await registry.query(context, ["subscription:read"], "subscription.providers", {});
    const accounts = await registry.query(context, ["subscription:read"], "subscription.accounts", {});
    const quota = await registry.query(context, ["subscription:read"], "subscription.quota", {});
    const policy = await registry.query(context, ["subscription:read"], "subscription.policy", {
      providerId: "verified-provider",
    });
    expect(policy).toMatchObject({
      data: [expect.objectContaining({ providerId: "verified-provider", approvalMode: "deny" })],
    });
    const doctor = await registry.query(context, ["subscription:read"], "subscription.doctor", {
      accountId: "subscription-account-1",
    });

    expect(providers).toMatchObject({
      data: [
        {
          providerId: "verified-provider",
          displayName: "검증된 제공자",
          connectionSurface: "edge-only",
          modelDiscovery: "protocol",
          protocol: "acp",
          protocols: ["acp"],
          availability: "supported",
          officialDocumentation: "https://example.com/provider",
          credentialPolicies: ["adaptive", "quota-headroom"],
          verified: true,
          runtimeCapabilities: {
            accountIsolation: "single-os-keyring-account",
            approvalModes: ["automatic", "deny"],
            approvalModesBySurface: {
              server: ["automatic", "review", "deny"],
              edge: ["automatic", "deny"],
            },
          },
        },
      ],
    });
    expect(accounts).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          alias: "업무 계정",
          canManage: true,
          connectorLocation: "edge",
          minimumRemainingRatio: 0.75,
          version: 3,
        },
        {
          accountId: "shared-account-1",
          alias: "공유 계정",
          canManage: false,
          connectorLocation: "server",
          version: 2,
        },
      ],
    });
    expect((accounts.data as Array<Record<string, unknown>>)[1]).not.toHaveProperty("minimumRemainingRatio");
    expect(quota).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          exhausted: false,
          windows: [{ kind: "monthly", remainingRatio: 0.75 }],
        },
      ],
    });
    expect(policy).toMatchObject({
      data: [
        {
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          version: 2,
          source: "configured",
        },
      ],
    });
    expect(doctor).toMatchObject({
      data: [
        {
          accountId: "subscription-account-1",
          accountStatus: "active",
          connectorStatus: "ready",
          quotaStatus: "available",
          action: "none",
        },
      ],
    });
    const serialized = JSON.stringify([providers, accounts, quota, policy, doctor]);
    for (const forbidden of [
      "organization-secret",
      "owner-secret",
      "profile-fingerprint-secret",
      "shared-profile-fingerprint-secret",
      "connector-public-key-secret",
      "provider-client-secret",
      "policy-token-secret",
      "quota-snapshot-secret",
      "private-quota-endpoint",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
