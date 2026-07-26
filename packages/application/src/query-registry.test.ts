import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import { ApplicationEventCursorExpiredError } from "./event-store.js";
import type { ApplicationReadModel } from "./read-model.js";
import { ApplicationQueryRegistry, registerApplicationQueries } from "./query-registry.js";
import { CollaborationGraphSnapshotProjector } from "./snapshot.js";

const context: TenantContext = {
  userId: "query-user",
  organizationId: "query-organization",
  membershipId: "query-membership",
  role: "member",
};

const readModel: ApplicationReadModel = {
  watermarks: async () => ({ work: 1 }),
  organization: async () => ({
    organizationId: context.organizationId,
    version: 1,
    nodes: [
      {
        nodeId: "node-representative",
        handle: "representative",
        name: "Iris",
        responsibility: "사용자 요청 조정",
        capabilities: ["request-coordination"],
        status: "active",
        role: "orchestrator",
        scope: "persistent",
      },
      {
        nodeId: "node-strategy",
        handle: "strategy",
        name: "Lyra",
        responsibility: "맥락 구성",
        capabilities: ["analysis"],
        parentHandle: "representative",
        status: "active",
        role: "coordinator",
        scope: "persistent",
      },
    ],
  }),
  works: async () => [
    { organizationId: context.organizationId, workId: "query-work", status: "running", revision: 2, artifactIds: [] },
    {
      organizationId: context.organizationId,
      workId: "workspace-work",
      status: "running",
      revision: 1,
      artifactIds: [],
      workspaceId: "workspace-shop-api",
    },
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
      data: [
        { workId: "query-work", status: "running", revision: 2, artifactIds: [] },
        {
          workId: "workspace-work",
          status: "running",
          revision: 1,
          artifactIds: [],
          workspaceId: "workspace-shop-api",
        },
      ],
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

  it("조직 graph snapshot을 안정된 공개 DTO로 투영한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      snapshot: new CollaborationGraphSnapshotProjector(readModel),
    });

    const result = await registry.query(context, ["organization:read"], "organization.graph.snapshot", {});

    expect(result.data).toMatchObject({
      version: { version: 1 },
      nodes: [
        { node_id: "node-representative", scope: "persistent" },
        {
          node_id: "node-strategy",
          handle: "strategy",
          parent_handle: "representative",
          scope: "persistent",
        },
      ],
    });
  });

  it("work.provenance는 코드 변경 계보(브랜치·commit)를 반환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      provenance: {
        listByWork: async () => [
          {
            deliveryId: "delivery-1",
            taskId: "task-1",
            agentHandle: "backend-specialist",
            status: "committed",
            branchRef: "massion/work-1",
            commitSha: "abc1234def",
            createdAt: "2026-07-21T09:00:00.000Z",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.provenance", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [{ deliveryId: "delivery-1", commitSha: "abc1234def", branchRef: "massion/work-1", status: "committed" }],
    });
  });

  it("work.timeline은 event·메시지를 병합한 셀 목록을 반환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workTimeline: {
        events: async () => [
          {
            event_id: "event-1",
            sequence: 1,
            event_type: "work_created",
            actor_user_id: "query-user",
            payload_json: "{}",
            created_at: "2026-07-21T09:00:00.000Z",
          },
        ],
        rooms: async () => [{ room_id: "room-1" }],
        messages: async () => [
          {
            message_id: "message-1",
            room_id: "room-1",
            sequence: 1,
            author_kind: "user" as const,
            author_id: "query-user",
            content: "진행 상황 알려주세요",
            created_at: "2026-07-21T09:01:00.000Z",
          },
        ],
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.timeline", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        { cellId: "event:event-1", kind: "stage" },
        { cellId: "message:message-1", kind: "user-message", detail: "진행 상황 알려주세요" },
      ],
    });
  });

  it("workspace.list와 workspace.get을 workspace:read scope로 제공한다", async () => {
    const registry = new ApplicationQueryRegistry();
    const workspaceView = {
      workspaceId: "workspace-shop-api",
      organizationId: context.organizationId,
      name: "shop-api",
      path: "/home/owner/projects/shop-api",
      kind: "local-directory",
      trust: "trusted",
      status: "active",
      revision: 1,
      createdAt: "2026-07-21T00:00:00.000Z",
      lastUsedAt: "2026-07-21T00:00:00.000Z",
    } as const;
    registerApplicationQueries(registry, {
      readModel,
      workspaces: {
        list: async () => [workspaceView],
        get: async () => workspaceView,
      } as never,
    });
    await expect(registry.query(context, ["workspace:read"], "workspace.list", {})).resolves.toMatchObject({
      data: [{ workspaceId: "workspace-shop-api", path: "/home/owner/projects/shop-api", trust: "trusted" }],
    });
    const got = await registry.query(context, ["workspace:read"], "workspace.get", {
      workspaceId: "workspace-shop-api",
    });
    expect((got as { data: { organizationId?: string } }).data.organizationId).toBeUndefined();
    await expect(registry.query(context, ["work:read"], "workspace.list", {})).rejects.toMatchObject({
      category: "authorization",
    });
  });

  it("work.list는 workspaceId filter를 지원하고 응답에 workspaceId를 포함한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(
      registry.query(context, ["work:read"], "work.list", { workspaceId: "workspace-shop-api" }),
    ).resolves.toMatchObject({
      data: [{ workId: "workspace-work", workspaceId: "workspace-shop-api" }],
    });
    const unfiltered = await registry.query(context, ["work:read"], "work.list", {});
    expect((unfiltered as { data: unknown[] }).data).toHaveLength(2);
  });

  it("work.index를 검색·상태·cursor로 페이지하고 Work detail을 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        works: async () => [
          {
            organizationId: context.organizationId,
            workId: "work-retention",
            title: "고객 이탈 원인 분석",
            status: "running",
            revision: 3,
            artifactIds: ["artifact-version-1"],
            workspaceId: "workspace-shop-api",
            createdAt: "2026-07-21T09:00:00.000Z",
            updatedAt: "2026-07-21T10:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            workId: "work-contract",
            title: "파트너 계약서 검토",
            status: "running",
            revision: 2,
            artifactIds: [],
            createdAt: "2026-07-21T08:00:00.000Z",
            updatedAt: "2026-07-21T09:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            workId: "work-complete",
            title: "주간 운영 보고서",
            status: "completed",
            revision: 5,
            artifactIds: [],
            createdAt: "2026-07-20T08:00:00.000Z",
            updatedAt: "2026-07-20T09:00:00.000Z",
          },
        ],
      },
    } as never);

    const first = await registry.query(context, ["work:read"], "work.index", {
      status: "running",
      limit: 1,
    });
    expect(first).toMatchObject({
      data: {
        items: [{ workId: "work-retention", title: "고객 이탈 원인 분석", status: "running" }],
        nextCursor: "1",
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.index", {
        status: "running",
        cursor: "1",
        limit: 1,
      }),
    ).resolves.toMatchObject({ data: { items: [{ workId: "work-contract" }] } });
    await expect(registry.query(context, ["work:read"], "work.index", { search: "이탈" })).resolves.toMatchObject({
      data: { items: [{ workId: "work-retention" }] },
    });
    await expect(
      registry.query(context, ["work:read"], "work.detail", { workId: "work-retention" }),
    ).resolves.toMatchObject({
      data: {
        workId: "work-retention",
        title: "고객 이탈 원인 분석",
        artifactIds: ["artifact-version-1"],
        artifactVersionIds: ["artifact-version-1"],
        createdAt: "2026-07-21T09:00:00.000Z",
      },
    });
  });

  it("Work inspector 조회는 연결 필드만 공개하고 artifact content는 노출하지 않는다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...readModel,
        executions: async () => [
          {
            organizationId: context.organizationId,
            executionId: "execution-work-1",
            workId: "query-work",
            taskId: "query-task",
            agentHandle: "representative",
            modelRoute: "balanced",
            status: "running",
            inputTokens: 10,
            outputTokens: 20,
            costMicros: 30,
            createdAt: "2026-07-21T09:02:00.000Z",
          },
        ],
        artifacts: async () => [
          {
            organizationId: context.organizationId,
            artifactId: "artifact-1",
            artifactVersionId: "artifact-version-1",
            workId: "query-work",
            name: "이탈 분석 보고서",
            kind: "report",
            version: 1,
            mediaType: "application/pdf",
            checksum: "a".repeat(64),
            createdBy: "analysis",
            createdAt: "2026-07-21T09:03:00.000Z",
            contentJson: '{"secret":"노출 금지"}',
          },
        ],
        verifications: async () => [
          {
            organizationId: context.organizationId,
            verificationId: "verification-1",
            workId: "query-work",
            verifierId: "assurance",
            passed: true,
            criteria: ["통계 유의성"],
            evidenceArtifactVersionIds: ["artifact-version-1"],
            createdAt: "2026-07-21T09:04:00.000Z",
          },
        ],
        directives: async () => [
          {
            organizationId: context.organizationId,
            directiveId: "directive-1",
            workId: "query-work",
            runId: "run-work-1",
            sequence: 1,
            content: "표본 구간을 추가해 주세요",
            mode: "next-stage",
            submittedStage: "delivery",
            status: "queued",
            createdAt: "2026-07-21T09:05:00.000Z",
            updatedAt: "2026-07-21T09:05:00.000Z",
          },
        ],
        approvals: async () => [
          {
            organizationId: context.organizationId,
            approvalId: "approval-work-1",
            workId: "query-work",
            executionId: "execution-work-1",
            action: "tool.call",
            status: "pending",
            requestedBy: "representative",
            revision: 2,
            expiresAt: "2026-07-21T10:00:00.000Z",
          },
          {
            organizationId: context.organizationId,
            approvalId: "approval-other",
            workId: "other-work",
            action: "tool.call",
            status: "pending",
            requestedBy: "representative",
            revision: 1,
            expiresAt: "2026-07-21T10:00:00.000Z",
          },
        ],
      },
      runs: {
        get: async () => {
          throw new Error("사용하지 않음");
        },
        listByWork: async () => [
          {
            runId: "run-work-1",
            organizationId: context.organizationId,
            commandId: "command-run-work-1",
            correlationId: "correlation-run-work-1",
            request: { text: "원문 노출 금지" },
            workId: "query-work",
            stage: "delivery",
            status: "running",
            leaseGeneration: 2,
            createdAt: "2026-07-21T09:00:00.000Z",
            updatedAt: "2026-07-21T09:01:00.000Z",
          },
        ],
      },
    } as never);

    const results = await Promise.all([
      registry.query(context, ["work:read"], "run.list", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.executions", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.artifacts", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.artifact.get", {
        workId: "query-work",
        artifactVersionId: "artifact-version-1",
      }),
      registry.query(context, ["work:read"], "work.verifications", { workId: "query-work" }),
      registry.query(context, ["work:read"], "work.directive.list", { workId: "query-work" }),
      registry.query(context, ["approval:read"], "governance.approval.list", {
        workId: "query-work",
        status: "pending",
      }),
    ]);
    expect(results[0]).toMatchObject({ data: [{ runId: "run-work-1", workId: "query-work" }] });
    expect(results[1]).toMatchObject({ data: [{ executionId: "execution-work-1" }] });
    expect(results[2]).toMatchObject({ data: [{ artifactVersionId: "artifact-version-1", name: "이탈 분석 보고서" }] });
    expect(results[3]).toMatchObject({ data: { artifactId: "artifact-1" } });
    expect(results[4]).toMatchObject({ data: [{ verificationId: "verification-1", passed: true }] });
    expect(results[5]).toMatchObject({ data: [{ directiveId: "directive-1", status: "queued" }] });
    expect(results[6]).toMatchObject({
      data: [
        {
          approvalId: "approval-work-1",
          workId: "query-work",
          executionId: "execution-work-1",
          revision: 2,
        },
      ],
    });
    expect(JSON.stringify(results)).not.toContain("원문 노출 금지");
    expect(JSON.stringify(results)).not.toContain("contentJson");
    expect(JSON.stringify(results)).not.toContain("노출 금지");
  });

  it("work.activity.list는 최신 활동부터 cursor로 이전 활동을 페이지한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workTimeline: {
        events: async () => [
          {
            event_id: "event-1",
            sequence: 1,
            event_type: "work_created",
            actor_user_id: "query-user",
            payload_json: "{}",
            created_at: "2026-07-21T09:00:00.000Z",
          },
          {
            event_id: "event-2",
            sequence: 2,
            event_type: "task_created",
            actor_user_id: "query-user",
            payload_json: '{"title":"원인 분석"}',
            created_at: "2026-07-21T09:01:00.000Z",
          },
        ],
        rooms: async () => [{ room_id: "room-1" }],
        messages: async () => [
          {
            message_id: "message-1",
            room_id: "room-1",
            sequence: 1,
            author_kind: "agent" as const,
            author_id: "analysis",
            content: "분석을 시작했습니다",
            created_at: "2026-07-21T09:02:00.000Z",
          },
        ],
      },
    });

    const latest = await registry.query(context, ["work:read"], "work.activity.list", {
      workId: "query-work",
      limit: 2,
    });
    expect(latest).toMatchObject({
      data: {
        items: [
          { activityId: "message:message-1", kind: "message" },
          { activityId: "event:event-2", kind: "task" },
        ],
        nextCursor: "2",
      },
    });
    await expect(
      registry.query(context, ["work:read"], "work.activity.list", {
        workId: "query-work",
        cursor: "2",
        limit: 2,
      }),
    ).resolves.toMatchObject({ data: { items: [{ activityId: "event:event-1" }] } });
  });

  it("unknown operation·payload field와 role을 거부한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["application:*"], "unknown.read", {})).rejects.toMatchObject({
      category: "validation",
    });
    await expect(registry.query(context, ["work:read"], "work.list", { injected: true })).rejects.toThrow("알 수 없는");
  });

  it("진행 중인 Application run은 요청 원문 없이 현재 Work 연결만 공개한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      runs: {
        get: async () => ({
          runId: "query-run-0001",
          organizationId: context.organizationId,
          commandId: "query-run-command-0001",
          correlationId: "query-run-correlation-0001",
          request: { text: "공개하면 안 되는 요청 원문" },
          workId: "query-work",
          stage: "delivery",
          status: "running",
          leaseGeneration: 3,
        }),
      },
    } as never);

    const result = await registry.query(context, ["work:read"], "run.get", { runId: "query-run-0001" });

    expect(result).toMatchObject({
      operation: "run.get",
      data: {
        runId: "query-run-0001",
        workId: "query-work",
        stage: "delivery",
        status: "running",
        leaseGeneration: 3,
      },
    });
    expect(JSON.stringify(result)).not.toContain("공개하면 안 되는 요청 원문");
  });

  it("감사 사건 cursor가 보존 범위 밖이면 snapshot 재동기화가 가능한 공개 오류로 변환한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      audit: {
        read: async () => {
          throw new ApplicationEventCursorExpiredError(50);
        },
      },
    });

    await expect(
      registry.query(context, ["audit:read"], "application.audit", { after: 1, limit: 1000 }),
    ).rejects.toMatchObject({
      category: "conflict",
      operatorCode: "APP_EVENT_CURSOR_EXPIRED",
      retryable: true,
    });
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

  it("모델 최적화 조회는 adapter가 덧붙인 prompt·credential 필드를 redaction한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      optimization: {
        evaluations: {
          getActivePolicy: async () => ({
            policyVersionId: "policy-1",
            organizationId: context.organizationId,
            version: 1,
            policy: "quality",
            autoOptimize: false,
            productionLearning: false,
            shadowEnabled: false,
            minimumSampleCount: 3,
            improvementThreshold: 0.05,
            observationBudgetMicros: 100,
            observationRetentionDays: 7,
            status: "active",
            checksum: "a".repeat(64),
            prompt: "prompt-secret",
          }),
          listReceipts: async () => [
            {
              receiptId: "receipt-1",
              runId: "run-1",
              organizationId: context.organizationId,
              roleKey: "assurance",
              modelProfileId: "profile-1",
              bundleVersion: 1,
              sampleCount: 1,
              qualityScore: 0.9,
              latencyMs: 10,
              costMicros: 1,
              privacyAllowed: true,
              completed: true,
              inputChecksum: "b".repeat(64),
              receiptChecksum: "c".repeat(64),
              credential: "credential-secret",
            },
          ],
          listRecommendations: async () => [],
        } as never,
        batches: { getActiveBatch: async () => undefined, listObservations: async () => [] } as never,
      },
    });

    const policy = await registry.query(context, ["optimization:read"], "optimization.policy", {});
    const receipts = await registry.query(context, ["optimization:read"], "optimization.receipts", {});
    expect(JSON.stringify(policy)).not.toContain("prompt-secret");
    expect(JSON.stringify(receipts)).not.toContain("credential-secret");
    expect(policy.data).toEqual([expect.objectContaining({ policyVersionId: "policy-1", checksum: "a".repeat(64) })]);
  });

  it("웹 운영 화면용 구성원·개인 기억·감사·session을 필요한 범위로 조회한다", async () => {
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
        getActiveExplicitMemory: async () => ({
          memoryVersionId: "memory-1",
          organizationId: context.organizationId,
          scope: "user",
          subjectId: context.userId,
          version: 1,
          status: "active",
          entries: [{ kind: "preference", key: "answer-style", value: "결론부터 답한다", sourceReferenceIds: ["command-1"] }],
          checksum: "a".repeat(64),
        }),
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
    expect(memories).toMatchObject({
      data: [
        {
          memoryVersionId: "memory-1",
          revision: 1,
          entries: [{ key: "answer-style", kind: "preference", value: "결론부터 답한다", authority: "explicit" }],
        },
      ],
    });
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
    expect((accounts.data as Array<Record<string, unknown>>)[1]).toMatchObject({
      profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
    });
    expect((accounts.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty("profileHandle");
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

describe("협업방 조회", () => {
  const roomReadModel: ApplicationReadModel = {
    ...readModel,
    rooms: async () => [
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        name: "3분기 이탈 분석",
        kind: "work",
        status: "active",
        participantIds: ["representative", "evidence-research", "assurance"],
        lastMessageSequence: 3,
      },
    ],
    messages: async () => [
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-question",
        sequence: 1,
        messageType: "question",
        authorKind: "agent",
        authorId: "delivery-coordination",
        content: "라벨링 기준이 뭔가요?",
        createdAt: "2026-07-21T09:01:00.000Z",
      },
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-answer",
        sequence: 2,
        messageType: "answer",
        authorKind: "agent",
        authorId: "evidence-research",
        content: "5축입니다.",
        createdAt: "2026-07-21T09:02:00.000Z",
        replyToMessageId: "message-question",
      },
      {
        organizationId: context.organizationId,
        workId: "query-work",
        roomId: "room-1",
        messageId: "message-challenge",
        sequence: 3,
        messageType: "challenge",
        authorKind: "agent",
        authorId: "assurance",
        content: "분기 간 비교가 성립하지 않습니다.",
        createdAt: "2026-07-21T09:03:00.000Z",
        replyToMessageId: "message-answer",
        causedByMessageId: "message-question",
      },
      {
        organizationId: context.organizationId,
        workId: "other-work",
        roomId: "room-9",
        messageId: "message-other",
        sequence: 1,
        messageType: "status",
        authorKind: "agent",
        authorId: "representative",
        content: "다른 Work의 메시지",
        createdAt: "2026-07-21T09:04:00.000Z",
      },
    ],
  };

  it("방 예산 소비량을 메시지 합으로 계산한다", async () => {
    // 소비량은 방 레코드에 없고 메시지의 token_count·cost_micros 합입니다.
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...roomReadModel,
        rooms: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            name: "3분기 이탈 분석",
            kind: "work",
            status: "active",
            participantIds: ["representative"],
            lastMessageSequence: 2,
            coordinatorHandle: "representative",
            roundCount: 4,
            maxRounds: 12,
            maxTokens: 200_000,
            maxCostMicros: 2_000_000,
          },
        ],
        messages: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            messageId: "m1",
            sequence: 1,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "하나",
            createdAt: "2026-07-21T09:01:00.000Z",
            tokenCount: 30_000,
            costMicros: 200_000,
          },
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            messageId: "m2",
            sequence: 2,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "둘",
            createdAt: "2026-07-21T09:02:00.000Z",
            tokenCount: 18_200,
            costMicros: 110_000,
          },
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-other",
            messageId: "m3",
            sequence: 1,
            messageType: "evidence",
            authorKind: "agent",
            authorId: "representative",
            content: "다른 방",
            createdAt: "2026-07-21T09:03:00.000Z",
            tokenCount: 99_999,
            costMicros: 999_999,
          },
        ],
      },
    });

    await expect(
      registry.query(context, ["collaboration:read"], "work.rooms", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        {
          roundCount: 4,
          maxRounds: 12,
          // 다른 방의 메시지는 합에 들어가지 않습니다.
          usedTokens: 48_200,
          maxTokens: 200_000,
          usedCostMicros: 310_000,
          coordinatorHandle: "representative",
        },
      ],
    });
  });

  it("공유 컨텍스트는 checksum과 함께 Work 범위로 준다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {
        ...roomReadModel,
        sharedContexts: async () => [
          {
            organizationId: context.organizationId,
            workId: "query-work",
            roomId: "room-1",
            sharedContextReferenceId: "ref-1",
            sourceKind: "evidence-brief",
            sourceId: "brief-1",
            versionId: "v3",
            checksum: "a3f1c8",
          },
          {
            organizationId: context.organizationId,
            workId: "other-work",
            roomId: "room-9",
            sharedContextReferenceId: "ref-2",
            sourceKind: "evidence-brief",
            sourceId: "brief-2",
            versionId: "v1",
            checksum: "ffffff",
          },
        ],
      },
    });

    const result = await registry.query(context, ["collaboration:read"], "work.shared-contexts", {
      workId: "query-work",
    });
    expect(result.data).toEqual([
      {
        sharedContextReferenceId: "ref-1",
        roomId: "room-1",
        sourceKind: "evidence-brief",
        sourceId: "brief-1",
        versionId: "v3",
        checksum: "a3f1c8",
      },
    ]);
  });

  it("Work 지식은 read scope 뒤에 metadata만 ready·no-match·blocked 상태로 투영한다", async () => {
    const calls: string[] = [];
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel,
      workKnowledge: {
        get: async (_context, workId) => {
          calls.push(workId);
          if (workId === "ready-work") {
            return {
              workId,
              status: "ready" as const,
              repositoryId: "repository-1",
              repositoryRevisionId: "revision-1",
              indexVersionId: "index-1",
              evidenceBriefId: "brief-1",
              freshnessStatus: "fresh" as const,
              query: "결제 검증",
              references: [
                {
                  referenceId: "chunk-1",
                  kind: "chunk" as const,
                  relativePath: "src/payment.ts",
                  startLine: 3,
                  endLine: 8,
                  contentHash: "a".repeat(64),
                  content: "sk-this-must-never-leave-the-server",
                },
              ],
              prompt: "비공개 prompt",
            } as never;
          }
          if (workId === "no-match-work") return { workId, status: "no-match", references: [] };
          return { workId, status: "blocked", references: [], failureReason: "knowledge-integrity-check-failed" };
        },
      },
    });

    await expect(registry.query(context, [], "work.knowledge", { workId: "ready-work" })).rejects.toMatchObject({
      category: "authorization",
    });
    expect(calls).toEqual([]);

    const ready = await registry.query(context, ["work:read"], "work.knowledge", { workId: "ready-work" });
    expect(ready.data).toEqual({
      workId: "ready-work",
      status: "ready",
      repositoryId: "repository-1",
      repositoryRevisionId: "revision-1",
      indexVersionId: "index-1",
      evidenceBriefId: "brief-1",
      freshnessStatus: "fresh",
      query: "결제 검증",
      references: [
        {
          referenceId: "chunk-1",
          kind: "chunk",
          relativePath: "src/payment.ts",
          startLine: 3,
          endLine: 8,
          contentHash: "a".repeat(64),
        },
      ],
    });
    expect(JSON.stringify(ready.data)).not.toMatch(/prompt|sk-this/u);
    await expect(
      registry.query(context, ["work:read"], "work.knowledge", { workId: "no-match-work" }),
    ).resolves.toMatchObject({ data: { status: "no-match", references: [] } });
    await expect(
      registry.query(context, ["work:read"], "work.knowledge", { workId: "blocked-work" }),
    ).resolves.toMatchObject({
      data: { status: "blocked", references: [], failureReason: "knowledge-integrity-check-failed" },
    });
  });

  it("방 목록이 참가자와 마지막 sequence를 함께 준다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    await expect(
      registry.query(context, ["collaboration:read"], "work.rooms", { workId: "query-work" }),
    ).resolves.toMatchObject({
      data: [
        {
          roomId: "room-1",
          participantIds: ["representative", "evidence-research", "assurance"],
          lastMessageSequence: 3,
        },
      ],
    });
  });

  it("메시지는 타입과 인과 계보를 잃지 않는다", async () => {
    // 반론이 무엇을 반박하는지 없이 오면 화면이 인용을 그릴 수 없습니다.
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    const result = await registry.query(context, ["collaboration:read"], "work.messages", {
      workId: "query-work",
      roomId: "room-1",
    });

    expect(result.data).toMatchObject([
      { messageId: "message-question", messageType: "question", authorId: "delivery-coordination" },
      { messageId: "message-answer", messageType: "answer", replyToMessageId: "message-question" },
      {
        messageId: "message-challenge",
        messageType: "challenge",
        replyToMessageId: "message-answer",
        causedByMessageId: "message-question",
      },
    ]);
  });

  it("다른 Work·다른 방의 메시지는 섞이지 않는다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel: roomReadModel });

    const result = await registry.query(context, ["collaboration:read"], "work.messages", {
      workId: "query-work",
      roomId: "room-1",
    });

    expect(result.data).toHaveLength(3);
    expect(JSON.stringify(result.data)).not.toContain("다른 Work의 메시지");
  });
});
