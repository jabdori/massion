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
});
