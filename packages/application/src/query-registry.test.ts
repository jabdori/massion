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
      } as never,
    });
    await expect(registry.query(context, ["growth:read"], "growth.suggestions", {})).resolves.toMatchObject({
      data: [{ suggestionId: "suggestion-1", summary: "검증 강화", status: "proposed" }],
    });
    expect(JSON.stringify(await registry.query(context, ["growth:read"], "growth.suggestions", {}))).not.toContain(
      "공개 금지",
    );
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
});
