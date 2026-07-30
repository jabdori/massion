import { describe, expect, it, vi } from "vitest";

import {
  createApplicationDesktopService,
  createFixtureDesktopService,
  projectRouteAttempts,
  type DesktopService,
} from "./desktop-service";
import type { NativeTransport } from "./native-transport";

const detail = {
  workId: "work-0001",
  title: "고객 이탈 원인 분석",
  status: "running",
  revision: 7,
  artifactVersionIds: [],
  artifactIds: [],
  updatedAt: "2026-07-22T00:24:00.000Z",
};
const run = {
  runId: "run-00001",
  workId: detail.workId,
  stage: "delivery",
  status: "running",
  leaseGeneration: 4,
};

function result(operation: string, data: unknown) {
  return { schemaVersion: "massion.application.v1", operation, data };
}

async function flushFixtureEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function transport(
  overrides: Record<string, unknown> = {},
): NativeTransport & { query: ReturnType<typeof vi.fn>; command: ReturnType<typeof vi.fn> } {
  const data: Record<string, unknown> = {
    "work.index": { items: [detail] },
    "work.detail": detail,
    "run.list": [run],
    "work.activity.list": {
      items: [
        {
          activityId: "activity-1",
          workId: detail.workId,
          kind: "message",
          title: "요청을 분석합니다",
          detail: "최근 90일 범위를 확인합니다.",
          createdAt: "2026-07-22T00:21:00.000Z",
        },
      ],
    },
    "work.tasks": [{ workId: detail.workId, taskId: "task-0001", title: "범위 확인", status: "running", revision: 2 }],
    "work.assignments": [
      {
        workId: detail.workId,
        taskId: "task-0001",
        agentHandle: "evidence",
        status: "active",
        revision: 1,
      },
    ],
    "work.executions": [
      {
        executionId: "execution-0001",
        workId: detail.workId,
        agentHandle: "evidence",
        modelRoute: "local/default",
        status: "running",
        inputTokens: 120,
        outputTokens: 48,
        costMicros: 810,
      },
    ],
    "work.artifacts": [],
    "work.verifications": [],
    "work.records": [
      {
        recordId: "record-0001",
        version: 1,
        summary: "Records run records-run-0001 finalized 0 document(s)",
        artifactIds: ["artifact-version-0001"],
        verificationIds: ["verification-0001"],
        finalizedAt: "2026-07-22T00:25:00.000Z",
      },
    ],
    "governance.approval.list": [
      {
        approvalId: "approval-0001",
        action: "crm.read",
        status: "pending",
        requestedBy: "agent:evidence",
        expiresAt: "2026-07-23T00:00:00.000Z",
        workId: detail.workId,
        revision: 3,
      },
    ],
    "work.directive.list": [],
    "router.catalog": { providers: [{ providerId: "openai", apiKey: "never-return-this" }] },
    "router.credentials": [{ credentialId: "credential-1", token: "never-return-this" }],
    "router.routes": [],
    "router.attempts": [],
    "subscription.providers": [],
    "subscription.accounts": [],
    "subscription.quota": [],
    "subscription.policy": [],
    "registry.search": [{ versionId: "version-1" }],
    "registry.info": { versionId: "version-1", secret: "never-return-this" },
    "registry.inventory": [{ packageName: "calendar" }],
    "extension.list": [],
    "growth.configuration.get": {
      reflectionEnabled: true,
      adoptionMode: "review",
      governanceDecisionId: "decision-growth-0001",
      activatedAt: "2026-07-22T00:00:00.000Z",
    },
    "growth.memories": [
      {
        memoryVersionId: "memory-0001",
        revision: 3,
        entries: [
          {
            key: "verification-required",
            kind: "procedure",
            value: "검증 근거를 남긴다",
            authority: "explicit",
          },
        ],
      },
    ],
    "growth.suggestions": [
      {
        suggestionId: "suggestion-0001",
        workId: "work-0001",
        targetKind: "memory",
        operation: "add-entry",
        summary: "검증 근거 보강",
        rationale: "기록된 검증 누락을 줄이기 위해",
        expectedEffect: "검증 계보 보강",
        riskSummary: "검토 필요",
        status: "awaiting-review",
      },
    ],
    "growth.effects": [{ effectEvaluationId: "effect-0001", adoptionId: "adoption-0001", result: "improved" }],
  };
  Object.assign(data, overrides);
  const query = vi.fn(async (operation: string) => result(operation, data[operation]));
  const command = vi.fn(async (input: unknown) => {
    const value = input as { commandId: string; correlationId: string; operation: string };
    return {
      schemaVersion: "massion.application.v1",
      commandId: value.commandId,
      correlationId: value.correlationId,
      operation: value.operation,
      outcome: "succeeded",
      ...(value.operation === "run.start" ? { data: { runId: "run-new-0001", status: "ready" } } : {}),
      ...(value.operation === "registry.install"
        ? { outcome: "awaiting-approval", data: { approvalId: "approval-install-1" } }
        : {}),
    };
  });
  return {
    bootstrap: async () => ({ connection: { status: "connected" } }),
    query,
    command,
    startStream: async () => async () => undefined,
  };
}

describe("Application desktop service", () => {
  it("개발 화면은 번들 공식 확장을 마켓플레이스 목록으로 제공한다", async () => {
    const capabilities = await createFixtureDesktopService().loadCapabilities();

    expect(capabilities.extensions).toEqual([]);
    expect(capabilities.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: "@massion-ext/slack", packageVersion: "1.0.0" }),
        expect.objectContaining({ packageName: "@massion-ext/github", packageVersion: "1.0.0" }),
        expect.objectContaining({ packageName: "@massion-ext/discord", packageVersion: "1.0.0" }),
      ]),
    );
  });

  it("없는 fixture Work 조회는 동기 throw 없이 rejected Promise를 반환한다", async () => {
    const promise = createFixtureDesktopService().loadWork("없는-id");
    await expect(promise).rejects.toThrow("Fixture Work를 찾을 수 없습니다");
  });

  it("fixture 재개는 차단을 풀고 다음 단계로 옮긴다", async () => {
    const service = createFixtureDesktopService();
    const blocked = await service.loadWork("partner-contract");
    expect(blocked.run).toMatchObject({ status: "blocked", stage: "evidence", leaseGeneration: 1 });

    await service.resumeRun(blocked);

    const resumed = await service.loadWork("partner-contract");
    expect(resumed.run).toEqual({
      runId: "run-partner",
      status: "ready",
      stage: "delivery",
      leaseGeneration: 2,
    });
  });

  it("fixture 취소는 실행을 terminal로 보낸다", async () => {
    const service = createFixtureDesktopService();
    const work = await service.loadWork("partner-contract");

    await service.cancelRun(work);

    const cancelled = await service.loadWork("partner-contract");
    expect(cancelled.run).toMatchObject({ status: "cancelled", stage: "terminal" });
  });

  it("fixture 지시는 활동 흐름에 남는다", async () => {
    const service = createFixtureDesktopService();
    const work = await service.loadWork("churn-q3");

    await service.submitDirective(work, "코호트를 계약 규모별로도 나눠줘", "next-stage");

    const updated = await service.loadWork("churn-q3");
    expect(updated.activities).toHaveLength(work.activities.length + 1);
    expect(updated.activities.at(-1)).toMatchObject({
      kind: "message",
      author: "사용자",
      content: "코호트를 계약 규모별로도 나눠줘",
    });
  });

  it("fixture 상태 변경은 서비스 인스턴스 밖으로 새지 않는다", async () => {
    const changed = createFixtureDesktopService();
    await changed.cancelRun(await changed.loadWork("partner-contract"));

    const fresh = await createFixtureDesktopService().loadWork("partner-contract");
    expect(fresh.run).toMatchObject({ status: "blocked" });
  });

  it("fixture 설정과 새 Work 상태는 서비스 인스턴스마다 독립적이다", async () => {
    const changed = createFixtureDesktopService();
    await changed.registerProvider({
      providerId: "isolated-provider",
      displayName: "격리 제공자",
      adapterKind: "test",
    });
    await changed.startWork({ text: "격리된 Work", workspaceId: "workspace-analytics" });

    const fresh = createFixtureDesktopService();
    expect(JSON.stringify(await changed.loadSettings())).toContain("isolated-provider");
    expect(JSON.stringify(await fresh.loadSettings())).not.toContain("isolated-provider");
    await expect(fresh.loadWork("work-fixture-0001")).rejects.toThrow("Fixture Work를 찾을 수 없습니다");
  });

  it("fixture Provider·route 설정 명령은 재조회에 반영하고 secret을 보존하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const before = await service.loadSettings();
    const credential = (before.credentials as Array<{ credentialId: string }>).find(
      (item) => item.credentialId === "credential-zai",
    );
    if (!credential) throw new Error("fixture credential이 필요합니다");

    await service.registerProvider({
      providerId: "fixture-provider",
      displayName: "Fixture Provider",
      adapterKind: "openai-compatible",
    });
    await service.registerEndpoint({
      providerId: "fixture-provider",
      name: "api",
      baseUrl: "https://fixture.example/v1",
      local: false,
    });
    await service.addCredential({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider",
      label: "기본 키",
      credentialType: "api_key",
      secret: "fixture-api-secret",
      priority: 0,
      weight: 100,
    });
    await service.registerEndpoint({
      providerId: "fixture-provider",
      name: "backup",
      baseUrl: "https://fixture.example/backup",
      local: false,
    });
    await service.addCredential({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider-backup",
      label: "기본 키",
      credentialType: "api_key",
      secret: "fixture-backup-secret",
      priority: 1,
      weight: 50,
    });
    await service.connectZaiCodingPlan({ alias: "개인 Coding Plan", secret: "fixture-secret" });
    await service.disableCredential(credential.credentialId, 1);
    await service.registerModel({
      providerId: "fixture-provider",
      endpointId: "ep-fixture-provider",
      modelId: "glm-fixture",
      routeKind: "reasoning",
      contextWindow: 128_000,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "reasoning",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1,
      outputCostMicrosPerMillion: 2,
      verified: true,
      token: "model-token",
    });
    await service.configureRoute({
      name: "Fixture 추론",
      routeKind: "reasoning",
      credentialPolicy: "required",
      dataPolicy: "cloud",
      equivalenceGroup: "reasoning",
      minEvalScore: 0.9,
      requireTools: true,
      requireStructuredOutput: false,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 128_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
      secret: "route-secret",
    });
    await service.addRouteCandidate({
      routeId: "route-fixture-",
      modelProfileId: "mp-glm-fixture",
      priority: 0,
      token: "candidate-token",
    });
    await service.configureSubscriptionPolicy({
      providerId: "zai-coding-plan",
      credentialPolicy: "round-robin",
      approvalMode: "automatic",
      secret: "policy-secret",
    });

    const changed = await service.loadSettings();
    expect(JSON.stringify(changed)).toContain("glm-fixture");
    expect(JSON.stringify(changed)).toContain("Fixture Provider");
    expect(JSON.stringify(changed)).toContain("Fixture 추론");
    expect(JSON.stringify(changed)).toContain("round-robin");
    expect(JSON.stringify(changed)).toContain("개인 Coding Plan");
    expect(JSON.stringify(changed)).not.toContain("fixture-secret");
    expect(JSON.stringify(changed)).not.toContain("fixture-api-secret");
    expect(JSON.stringify(changed)).not.toContain("model-token");
    expect(JSON.stringify(changed)).not.toContain("route-secret");
    expect(JSON.stringify(changed)).not.toContain("candidate-token");
    expect(JSON.stringify(changed)).not.toContain("policy-secret");
    expect(changed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: credential.credentialId, status: "revoked" }),
        expect.objectContaining({ providerId: "fixture-provider", label: "기본 키", status: "active" }),
        expect.objectContaining({
          providerId: "fixture-provider",
          endpointId: "ep-fixture-provider-backup",
          label: "기본 키",
          status: "active",
        }),
      ]),
    );
    const fixtureCredentials = (
      changed.credentials as Array<{ credentialId: string; endpointId: string; status: string }>
    ).filter((item) => item.endpointId.startsWith("ep-fixture-provider"));
    const primaryCredential = fixtureCredentials.find((item) => item.endpointId === "ep-fixture-provider");
    const backupCredential = fixtureCredentials.find((item) => item.endpointId === "ep-fixture-provider-backup");
    if (!primaryCredential || !backupCredential) throw new Error("endpoint별 fixture credential이 필요합니다");
    expect(primaryCredential.credentialId).not.toBe(backupCredential.credentialId);
    await service.disableCredential(primaryCredential.credentialId, 1);
    expect(await service.loadSettings()).toMatchObject({
      credentials: expect.arrayContaining([
        expect.objectContaining({ credentialId: primaryCredential.credentialId, status: "revoked" }),
        expect.objectContaining({ credentialId: backupCredential.credentialId, status: "active" }),
      ]),
    });
    expect(changed.catalog).toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ providerId: "zai-coding-plan" })]),
      endpoints: expect.arrayContaining([expect.objectContaining({ providerId: "zai-coding-plan" })]),
    });
    expect(changed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: "credential-account-zai", label: "개인 Coding Plan" }),
      ]),
    );
    expect(changed.policy).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "configured", updatedAt: expect.any(String) })]),
    );
    const returnedModel = (changed.catalog as { models: Array<{ modelId: string }> }).models.find(
      (model) => model.modelId === "glm-fixture",
    );
    if (!returnedModel) throw new Error("반환된 fixture model이 필요합니다");
    returnedModel.modelId = "외부 mutation";
    expect(JSON.stringify(await service.loadSettings())).not.toContain("외부 mutation");
    await expect(service.disableCredential(credential.credentialId, 1)).rejects.toThrow("version");
    expect(JSON.stringify(await createFixtureDesktopService().loadSettings())).not.toContain("glm-fixture");
  });

  it("fixture router 저장은 참조와 중복을 거부한다", async () => {
    const service = createFixtureDesktopService();
    const model = {
      providerId: "zai",
      endpointId: "ep-zai",
      modelId: "glm-conflict",
      routeKind: "reasoning",
      contextWindow: 128_000,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "reasoning",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1,
      outputCostMicrosPerMillion: 2,
      verified: true,
    };
    await expect(service.registerModel({ ...model, endpointId: "없는-endpoint" })).rejects.toThrow("Endpoint");
    await service.registerModel(model);
    await expect(service.registerModel(model)).rejects.toThrow("중복");
    await expect(service.configureRoute({ name: "추론", routeKind: "reasoning" })).rejects.toThrow("중복");
    await expect(
      service.addRouteCandidate({ routeId: "없는-route", modelProfileId: "mp-glm-conflict", priority: 0 }),
    ).rejects.toThrow("Route");
    await expect(
      service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "없는-policy" }),
    ).rejects.toThrow("정책");
    await expect(
      service.configureSubscriptionPolicy({
        providerId: "zai-coding-plan",
        credentialPolicy: "adaptive",
        approvalMode: "없는-mode",
      }),
    ).rejects.toThrow("승인");
  });

  it("fixture subscription policy는 기존 mode와 provider 기본 mode를 따른다", async () => {
    const service = createFixtureDesktopService();

    await service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: [expect.objectContaining({ providerId: "zai-coding-plan", approvalMode: "deny" })],
    });
    await service.configureSubscriptionPolicy({
      providerId: "zai-coding-plan",
      credentialPolicy: "priority",
      approvalMode: "review",
    });
    await service.configureSubscriptionPolicy({ providerId: "zai-coding-plan", credentialPolicy: "weighted" });
    expect(await service.loadSettings()).toMatchObject({
      policy: [expect.objectContaining({ providerId: "zai-coding-plan", approvalMode: "review" })],
    });

    await service.configureSubscriptionPolicy({ providerId: "openai-codex", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: expect.arrayContaining([
        expect.objectContaining({ providerId: "openai-codex", approvalMode: "automatic" }),
      ]),
    });
    await service.configureSubscriptionPolicy({ providerId: "xai-grok-build", credentialPolicy: "adaptive" });
    await service.configureSubscriptionPolicy({ providerId: "manifest-없는-provider", credentialPolicy: "adaptive" });
    expect(await service.loadSettings()).toMatchObject({
      policy: expect.arrayContaining([
        expect.objectContaining({ providerId: "xai-grok-build", approvalMode: "deny" }),
        expect.objectContaining({ providerId: "manifest-없는-provider", approvalMode: "deny" }),
      ]),
    });
  });

  it("fixture explicit memory는 revision CAS로 재조회되고 반환 mutation이 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const memory = initial.memories[0];
    if (!memory) throw new Error("fixture explicit memory가 필요합니다");

    await service.putExplicitMemory({
      key: "fixture-rule",
      kind: "procedure",
      value: "재조회로 확인합니다",
      revision: memory.revision,
    });
    const updated = (await service.loadGrowth()).memories[0];
    expect(updated?.memoryVersionId).not.toBe(memory.memoryVersionId);
    expect(updated?.revision).toBe(memory.revision + 1);
    expect(updated?.entries).toContainEqual(expect.objectContaining({ key: "fixture-rule" }));
    await expect(
      service.putExplicitMemory({ key: "stale", kind: "fact", value: "거부", revision: memory.revision }),
    ).rejects.toThrow("precondition");
    await service.forgetExplicitMemory({ key: "fixture-rule", revision: updated?.revision ?? 0 });
    expect((await service.loadGrowth()).memories[0]).toMatchObject({ revision: memory.revision + 2 });

    const returnedEntry = updated?.entries[0];
    if (!returnedEntry) throw new Error("반환된 explicit memory entry가 필요합니다");
    (returnedEntry as { value: string }).value = "외부 mutation";
    expect((await service.loadGrowth()).memories[0]?.entries[0]?.value).not.toBe("외부 mutation");
    expect(JSON.stringify(await createFixtureDesktopService().loadGrowth())).not.toContain("fixture-rule");
  });

  it("fixture Growth 설정은 CAS 갱신 뒤 재조회되고 새 서비스에는 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const configuration = initial.configuration;
    if (!configuration?.version || !configuration.checksum)
      throw new Error("초기 Growth 설정 version과 checksum이 필요합니다");

    await service.configureGrowth({
      reflectionEnabled: false,
      adoptionMode: "auto",
      expectedVersion: configuration.version,
    });

    await expect(service.loadGrowth()).resolves.toMatchObject({
      configuration: {
        reflectionEnabled: false,
        adoptionMode: "auto",
        version: configuration.version + 1,
        governanceDecisionId: "decision-growth-fixture-2",
        activatedAt: expect.any(String),
      },
    });
    expect((await service.loadGrowth()).configuration?.checksum).not.toBe(configuration.checksum);
    await expect(
      service.configureGrowth({ reflectionEnabled: false, adoptionMode: "auto", expectedVersion: 0 }),
    ).rejects.toThrow("version");
    await expect(
      service.configureGrowth({
        reflectionEnabled: true,
        adoptionMode: "review",
        expectedVersion: configuration.version,
      }),
    ).rejects.toThrow("version");
    await service.configureGrowth({ reflectionEnabled: false, adoptionMode: "auto" });
    await expect(service.loadGrowth()).resolves.toMatchObject({
      configuration: { version: configuration.version + 2, governanceDecisionId: "decision-growth-fixture-3" },
    });

    await expect(createFixtureDesktopService().loadGrowth()).resolves.toMatchObject({
      configuration: { reflectionEnabled: true, adoptionMode: "review", version: configuration.version },
    });
  });

  it("fixture Growth 승인는 eligible 대기 제안을 observing으로 옮기고 stale 재요청을 막는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const suggestion = initial.suggestions.find((item) => item.suggestionId === "suggestion-cohort-guard");
    if (!suggestion?.revision) throw new Error("승인 대기 Growth 제안 revision이 필요합니다");
    expect(suggestion).toMatchObject({
      evaluation: { outcome: "eligible", inputHash: expect.any(String) },
      adoption: {
        status: "awaiting-review",
        approvalId: expect.any(String),
        evaluationRunId: suggestion.evaluation?.evaluationRunId,
        beforeChecksum: expect.any(String),
      },
    });
    await expect(
      service.approveGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision + 1,
        reason: "오래된 revision입니다",
      }),
    ).rejects.toThrow("revision");

    await service.approveGrowthSuggestion({
      suggestionId: suggestion.suggestionId,
      expectedRevision: suggestion.revision,
      reason: "평가와 대상 checksum을 확인했습니다",
    });

    const approved = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === suggestion.suggestionId,
    );
    expect(approved).toMatchObject({
      status: "adopted",
      revision: suggestion.revision,
      adoption: { status: "observing" },
    });
    expect(approved).not.toHaveProperty("decisionReason");
    expect(approved).not.toHaveProperty("decidedAt");
    expect(
      (await service.loadGrowth()).suggestions.filter((item) => item.status === "awaiting-review"),
    ).not.toContainEqual(expect.objectContaining({ suggestionId: suggestion.suggestionId }));
    await expect(
      service.approveGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision,
        reason: "같은 승인 재시도",
      }),
    ).rejects.toThrow("승인 대기");
  });

  it("fixture Growth 거절은 CAS 사유를 보존하고 새 서비스와 다른 제안에 영향을 주지 않는다", async () => {
    const service = createFixtureDesktopService();
    const initial = await service.loadGrowth();
    const suggestion = initial.suggestions.find((item) => item.suggestionId === "suggestion-quant-persist");
    if (!suggestion?.revision) throw new Error("거절할 Growth 제안 revision이 필요합니다");
    expect(suggestion).toMatchObject({ status: "evaluated" });
    expect(suggestion).not.toHaveProperty("adoption");

    await service.rejectGrowthSuggestion({
      suggestionId: suggestion.suggestionId,
      expectedRevision: suggestion.revision,
      reason: "관측 표본이 아직 부족합니다",
    });
    await expect(
      service.rejectGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision + 1,
        reason: "오래된 revision입니다",
      }),
    ).rejects.toThrow("revision");

    const rejected = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === suggestion.suggestionId,
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      revision: suggestion.revision,
      decisionReason: "관측 표본이 아직 부족합니다",
      decidedAt: expect.any(String),
    });
    expect(
      (await service.loadGrowth()).suggestions.find((item) => item.suggestionId === "suggestion-cohort-guard"),
    ).toMatchObject({
      status: "awaiting-review",
    });
    await expect(
      service.rejectGrowthSuggestion({
        suggestionId: suggestion.suggestionId,
        expectedRevision: suggestion.revision,
        reason: "다시 거절",
      }),
    ).rejects.toThrow("거절");
    expect(
      (await createFixtureDesktopService().loadGrowth()).suggestions.find(
        (item) => item.suggestionId === suggestion.suggestionId,
      ),
    ).toMatchObject({ status: "evaluated" });
  });

  it("fixture Growth 대기 제안 거절은 adoption도 rejected로 전이하고 계보를 보존한다", async () => {
    const service = createFixtureDesktopService();
    const initial = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === "suggestion-cohort-guard",
    );
    if (!initial?.revision || !initial.adoption || !initial.evaluation)
      throw new Error("대기 Growth 제안 계보가 필요합니다");

    await service.rejectGrowthSuggestion({
      suggestionId: initial.suggestionId,
      expectedRevision: initial.revision,
      reason: "현재 변경은 보류합니다",
    });

    const rejected = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === initial.suggestionId,
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      decisionReason: "현재 변경은 보류합니다",
      adoption: {
        status: "rejected",
        adoptionId: initial.adoption.adoptionId,
        evaluationRunId: initial.evaluation.evaluationRunId,
        evaluationInputHash: initial.adoption.evaluationInputHash,
      },
    });
  });

  it("fixture Growth 반환의 nested 계보 mutation은 같은 서비스와 새 서비스에 새지 않는다", async () => {
    const service = createFixtureDesktopService();
    const returned = (await service.loadGrowth()).suggestions.find(
      (item) => item.suggestionId === "suggestion-cohort-guard",
    );
    if (!returned?.adoption || !returned.evaluation?.signals[0]) throw new Error("Growth nested 계보가 필요합니다");

    (returned.adoption as { status: string }).status = "observing";
    (returned.evaluation.signals[0] as { score: number }).score = 0;

    const reread = (await service.loadGrowth()).suggestions.find((item) => item.suggestionId === returned.suggestionId);
    const fresh = (await createFixtureDesktopService().loadGrowth()).suggestions.find(
      (item) => item.suggestionId === returned.suggestionId,
    );
    expect(reread?.adoption?.status).toBe("awaiting-review");
    expect(reread?.evaluation?.signals[0]?.score).toBe(0.75);
    expect(fresh?.adoption?.status).toBe("awaiting-review");
    expect(fresh?.evaluation?.signals[0]?.score).toBe(0.75);
  });

  it("fixture Growth 거절은 proposed와 evaluated 제안도 terminal 상태로 옮긴다", async () => {
    const service = createFixtureDesktopService();

    for (const suggestionId of ["suggestion-proposed-fixture", "suggestion-evaluated-fixture"]) {
      await service.rejectGrowthSuggestion({
        suggestionId,
        expectedRevision: 1,
        reason: "현재 범위에는 맞지 않습니다",
      });
    }

    const suggestions = await service.loadGrowth();
    expect(suggestions.suggestions.find((item) => item.suggestionId === "suggestion-proposed-fixture")).toMatchObject({
      status: "rejected",
      decisionReason: "현재 범위에는 맞지 않습니다",
    });
    expect(suggestions.suggestions.find((item) => item.suggestionId === "suggestion-evaluated-fixture")).toMatchObject({
      status: "rejected",
      decisionReason: "현재 범위에는 맞지 않습니다",
    });
  });

  it("fixture Growth 승인은 ineligible·종료·알 수 없는 제안을 거부한다", async () => {
    const service = createFixtureDesktopService();
    const reason = "승인 근거";

    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-quant-persist", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-target-drift-fixture", expectedRevision: 1, reason }),
    ).rejects.toThrow("checksum");
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-handoff-note", expectedRevision: 2, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-tone-brief", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "없는-suggestion", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.rejectGrowthSuggestion({ suggestionId: "없는-suggestion", expectedRevision: 1, reason }),
    ).rejects.toThrow();
    await expect(
      service.approveGrowthSuggestion({ suggestionId: "suggestion-cohort-guard", expectedRevision: 3, reason: " " }),
    ).rejects.toThrow("사유");
  });

  it("fixture startWork는 입력별 Work·실행 계보를 만들고 목록과 상세에서 다시 읽는다", async () => {
    const service = createFixtureDesktopService();
    const first = await service.startWork({ text: "첫 번째 계약 검토", workspaceId: "workspace-analytics" });
    const second = await service.startWork({ text: "두 번째 계약 검토", workspaceId: "workspace-ops" });

    expect(first.runId).not.toBe(second.runId);
    const works = await service.loadIndex({ filter: "active", search: "계약 검토" });
    expect(works.map((work) => work.id)).toEqual(["work-fixture-0001", "work-fixture-0002"]);
    await expect(service.loadWork("work-fixture-0001")).resolves.toMatchObject({
      title: "첫 번째 계약 검토",
      workspace: { name: "workspace-analytics", trusted: true },
      run: { runId: first.runId, status: "ready", stage: "intake", leaseGeneration: 0 },
      activeExecutionId: "execution-fixture-0001",
    });
    await expect(service.loadWork("work-fixture-0002")).resolves.toMatchObject({
      title: "두 번째 계약 검토",
      workspace: { name: "workspace-ops", trusted: true },
      run: { runId: second.runId, status: "ready", stage: "intake", leaseGeneration: 0 },
      activeExecutionId: "execution-fixture-0002",
    });
  });

  it("fixture 구독은 실행별 lifecycle을 비동기로 전달하고 중지·서비스 경계를 지킨다", async () => {
    const service = createFixtureDesktopService();
    const otherService = createFixtureDesktopService();
    const durable = vi.fn();
    const foreignDurable = vi.fn();
    const execution = vi.fn();
    const otherExecution = vi.fn();
    const stopDurable = await service.subscribeDurable(durable);
    const stopForeignDurable = await otherService.subscribeDurable(foreignDurable);
    const stopOtherExecution = await service.subscribeExecution("execution-fixture-0002", otherExecution);

    const first = await service.startWork({ text: "구독 Work" });
    await flushFixtureEvents();

    expect(durable).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "massion.application.event.v1",
        type: "work.created",
        resource: { type: "Work", id: "work-fixture-0001", revision: 1 },
      }),
    );
    const stopExecution = await service.subscribeExecution("execution-fixture-0001", execution);
    await flushFixtureEvents();

    expect(execution).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        executionId: "execution-fixture-0001",
        sequence: 1,
        kind: "lifecycle",
        summary: "started",
      }),
    );
    expect(execution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionId: "execution-fixture-0001",
        sequence: 2,
        kind: "lifecycle",
        summary: "finish",
      }),
    );
    expect(otherExecution).not.toHaveBeenCalled();
    expect(foreignDurable).not.toHaveBeenCalled();
    await expect(service.loadWork("work-fixture-0001")).resolves.toMatchObject({
      run: { runId: first.runId, status: "completed", stage: "terminal", leaseGeneration: 0 },
    });

    const durableCalls = durable.mock.calls.length;
    const executionCalls = execution.mock.calls.length;
    await stopDurable();
    await stopExecution();
    await service.startWork({ text: "중지 뒤 Work" });
    await flushFixtureEvents();

    expect(durable).toHaveBeenCalledTimes(durableCalls);
    expect(execution).toHaveBeenCalledTimes(executionCalls);
    await stopForeignDurable();
    await stopOtherExecution();
  });

  it("fixture 취소는 예약된 완료 lifecycle과 durable 완료 사건을 발행하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const durable = vi.fn();
    const execution = vi.fn();
    await service.subscribeDurable(durable);
    await service.startWork({ text: "취소 Work" });
    await flushFixtureEvents();
    const work = await service.loadWork("work-fixture-0001");

    await service.subscribeExecution("execution-fixture-0001", execution);
    await service.cancelRun(work);
    await flushFixtureEvents();

    await expect(service.loadWork(work.id)).resolves.toMatchObject({
      status: "cancelled",
      run: { status: "cancelled", stage: "terminal" },
    });
    expect(execution).toHaveBeenCalledWith(expect.objectContaining({ summary: "started" }));
    expect(execution).not.toHaveBeenCalledWith(expect.objectContaining({ summary: "finish" }));
    expect(durable).not.toHaveBeenCalledWith(expect.objectContaining({ type: "run.completed" }));
  });

  it("startWork 중 실행 구독도 lifecycle sequence를 한 번씩만 받는다", async () => {
    const service = createFixtureDesktopService();
    const received: unknown[] = [];

    const starting = service.startWork({ text: "경합 Work" });
    await service.subscribeExecution("execution-fixture-0001", (delta) => received.push(delta));
    await starting;
    await flushFixtureEvents();

    expect(received.map((delta) => (delta as { sequence: number }).sequence)).toEqual([1, 2]);
  });

  it("오래된 실행 중지는 새 구독자의 handler를 제거하지 않는다", async () => {
    const service = createFixtureDesktopService();
    const staleStop = await service.subscribeExecution("execution-fixture-0001", vi.fn());
    await staleStop();
    const received: unknown[] = [];
    await service.subscribeExecution("execution-fixture-0001", (delta) => received.push(delta));
    await staleStop();

    await service.startWork({ text: "수명 격리 Work" });
    await flushFixtureEvents();

    expect(received.map((delta) => (delta as { sequence: number }).sequence)).toEqual([1, 2]);
  });

  it("fixture index 입력 평가 오류도 rejected Promise로 전달한다", async () => {
    const input = {
      get filter(): "active" {
        throw new Error("fixture input error");
      },
      search: "",
    };
    const promise = createFixtureDesktopService().loadIndex(input);
    await expect(promise).rejects.toThrow("fixture input error");
  });

  it("bootstrap이 연결되지 않은 상태를 오류로 처리하고 Native stream 이름을 UI 계약으로 변환한다", async () => {
    const native = transport();
    native.bootstrap = async () => ({ connection: { status: "initialization-required" } });
    native.startStream = vi.fn(async () => async () => undefined);
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });
    const durableHandler = vi.fn();
    const executionHandler = vi.fn();

    expect(service.initialSnapshot).toBeUndefined();
    await expect(service.bootstrap()).rejects.toThrow("Desktop bootstrap 연결 상태가 유효하지 않습니다");
    await service.subscribeDurable(durableHandler, 12);
    await service.subscribeExecution("execution-0001", executionHandler);

    expect(native.startStream).toHaveBeenNthCalledWith(1, "events", { after: 12 }, durableHandler);
    expect(native.startStream).toHaveBeenNthCalledWith(
      2,
      "executions",
      { executionId: "execution-0001" },
      executionHandler,
    );
  });

  it("bootstrap 뒤 search를 work.index payload에 전달하고 종료 Work를 완료 목록으로 분류한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.bootstrap()).resolves.toBe("ready");
    await service.loadIndex({ filter: "active", search: "이탈" });

    expect(native.query).toHaveBeenCalledWith("work.index", { search: "이탈", limit: 50 });
  });

  it("개선 정책 변경은 조직 대상과 현재 version을 command에 전달한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await (
      service as DesktopService & {
        configureGrowth(input: {
          readonly reflectionEnabled: boolean;
          readonly adoptionMode: "review" | "auto";
          readonly expectedVersion?: number;
        }): Promise<void>;
      }
    ).configureGrowth({ reflectionEnabled: true, adoptionMode: "auto", expectedVersion: 1 });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.configure",
        payload: {
          subject: { type: "organization" },
          reflectionEnabled: true,
          adoptionMode: "auto",
          expectedVersion: 1,
        },
      }),
    );
  });

  it("조직 스냅샷에 노드나 버전이 없으면 빈 조직 화면용 데이터를 반환한다", async () => {
    const native = transport();
    native.query.mockImplementation(async (operation: string) =>
      result(operation, operation === "organization.graph.snapshot" ? {} : undefined),
    );
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadOrganization()).resolves.toEqual({ nodes: [] });
  });

  it("공개 조직 DTO의 ID·부모·범위·업무 소속을 화면 투영에 보존한다", async () => {
    const native = transport({
      "organization.graph.snapshot": {
        version: { version: 3 },
        nodes: [
          {
            node_id: "node-representative",
            handle: "representative",
            name: "Iris",
            responsibility: "사용자 요청 조정",
            status: "active",
            role: "orchestrator",
            capabilities: ["request-coordination"],
            scope: "persistent",
          },
          {
            node_id: "node-analysis",
            handle: "analysis",
            name: "Lyra",
            responsibility: "맥락 구성",
            parent_handle: "representative",
            status: "active",
            role: "coordinator",
            capabilities: ["analysis"],
            scope: "work",
            work_id: "work-0001",
          },
        ],
      },
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadOrganization()).resolves.toMatchObject({
      version: 3,
      nodes: [
        { id: "node-representative", scope: "persistent" },
        {
          id: "node-analysis",
          parentHandle: "representative",
          scope: "work",
          workId: "work-0001",
        },
      ],
    });
  });

  it("Work 선택 시 상세 투영을 독립 query로 병렬 조회한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const work = await service.loadWork(detail.workId);

    expect(new Set(native.query.mock.calls.map(([operation]) => operation))).toEqual(
      new Set([
        "work.detail",
        "run.list",
        "work.activity.list",
        "work.tasks",
        "work.assignments",
        "work.executions",
        "work.artifacts",
        "work.verifications",
        "work.records",
        "governance.approval.list",
        "work.directive.list",
      ]),
    );
    expect(work).toMatchObject({
      id: detail.workId,
      revision: 7,
      run: { runId: run.runId },
      activeExecutionId: "execution-0001",
      records: [
        {
          id: "record-0001",
          version: 1,
          summary: "업무 결과와 검증 기록을 확정했습니다.",
          artifactVersionIds: ["artifact-version-0001"],
          verificationIds: ["verification-0001"],
          finalizedAt: "2026-07-22T00:25:00.000Z",
        },
      ],
    });
  });

  it("실제 Work 산출물과 검증의 내부 식별자를 사람용 이름으로 투영한다", async () => {
    const taskId = "0b75e4fe-e3f1-4911-ba05-ea1eccea5a91";
    const native = transport({
      "work.tasks": [{ workId: detail.workId, taskId, title: "결과 생성", status: "completed", revision: 2 }],
      "work.artifacts": [
        {
          artifactId: "artifact-task-1",
          artifactVersionId: "artifact-version-task-1",
          workId: detail.workId,
          name: `task-${taskId}`,
          kind: "task-output",
          version: 1,
          mediaType: "application/json",
          checksum: "a".repeat(64),
          createdBy: "agent-1",
          createdAt: "2026-07-22T00:24:00.000Z",
        },
        {
          artifactId: "artifact-assurance-1",
          artifactVersionId: "artifact-version-assurance-1",
          workId: detail.workId,
          name: "assurance-dcc7fd56-8e0b-4677-8baa-247ef0cdcef7.json",
          kind: "verification-evidence",
          version: 1,
          mediaType: "application/vnd.massion.assurance-evidence+json",
          checksum: "b".repeat(64),
          createdBy: "assurance",
          createdAt: "2026-07-22T00:25:00.000Z",
        },
      ],
      "work.verifications": [
        {
          verificationId: "verification-1",
          workId: detail.workId,
          verifierId: "assurance",
          passed: true,
          criteria: [{ criterionKey: "exact-result", status: "passed" }],
          evidenceArtifactVersionIds: ["artifact-version-assurance-1"],
          createdAt: "2026-07-22T00:25:00.000Z",
        },
      ],
    });

    const work = await createApplicationDesktopService(native).loadWork(detail.workId);

    expect(work.artifacts.map((artifact) => artifact.name)).toEqual(["결과 생성 결과", "독립 검증 근거"]);
    expect(work.verifications).toEqual([
      expect.objectContaining({ verifier: "독립 검증", criteria: [{ key: "exact-result", status: "passed" }] }),
    ]);
  });

  it("Work의 사용한 지식은 typed work.knowledge 조회로 반환한다", async () => {
    const native = transport({
      "work.knowledge": {
        workId: detail.workId,
        status: "ready",
        freshnessStatus: "fresh",
        evidenceBriefId: "brief-0001",
        references: [
          {
            referenceId: "chunk-0001",
            kind: "chunk",
            relativePath: "src/order.ts",
            qualifiedName: "calculateTotal",
            startLine: 3,
            endLine: 6,
            contentHash: "a".repeat(64),
          },
        ],
      },
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadWorkKnowledge(detail.workId)).resolves.toMatchObject({
      status: "ready",
      references: [expect.objectContaining({ relativePath: "src/order.ts", qualifiedName: "calculateTotal" })],
    });
    expect(native.query).toHaveBeenCalledWith("work.knowledge", { workId: detail.workId });
  });

  it("실제 지식 표면은 typed index·graph·links query를 호출하고 canonical DTO를 보존한다", async () => {
    const native = transport({
      "knowledge.index": {
        workspaceId: "workspace-knowledge",
        status: "ready",
        indexVersionId: "index-knowledge",
        fileCount: 2,
        symbolCount: 1,
        relationCount: 1,
        indexedAt: "2026-07-29T01:00:00.000Z",
        excluded: ["dist", "node_modules"],
      },
      "knowledge.graph": {
        lens: "work",
        nodes: [
          { nodeId: "work:work-alpha", kind: "work", label: "Alpha 점검", detail: "completed" },
          { nodeId: "work:work-zeta", kind: "work", label: "Zeta 점검", detail: "running" },
        ],
        edges: [
          {
            kind: "documents",
            sourceId: "work:work-alpha",
            targetId: "work:work-zeta",
            derivedVia: "src/payment.ts",
          },
        ],
      },
      "knowledge.links": [
        {
          node: {
            nodeId: "file:file-payment",
            kind: "file",
            label: "payment.ts",
            detail: "src/payment.ts",
            group: "src",
          },
          kind: "documents",
          direction: "outgoing",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.loadKnowledgeIndex("workspace-knowledge")).resolves.toMatchObject({
      status: "ready",
      indexVersionId: "index-knowledge",
      excluded: ["dist", "node_modules"],
    });
    await expect(service.loadKnowledgeGraph("workspace-knowledge", "work")).resolves.toMatchObject({
      lens: "work",
      nodes: [{ nodeId: "work:work-alpha" }, { nodeId: "work:work-zeta" }],
      edges: [{ kind: "documents", derivedVia: "src/payment.ts" }],
    });
    await expect(service.loadKnowledgeLinks("workspace-knowledge", "work:work-alpha")).resolves.toMatchObject([
      { node: { nodeId: "file:file-payment" }, kind: "documents", direction: "outgoing" },
    ]);
    expect(native.query).toHaveBeenCalledWith("knowledge.index", { workspaceId: "workspace-knowledge" });
    expect(native.query).toHaveBeenCalledWith("knowledge.graph", {
      workspaceId: "workspace-knowledge",
      lens: "work",
    });
    expect(native.query).toHaveBeenCalledWith("knowledge.links", {
      workspaceId: "workspace-knowledge",
      nodeId: "work:work-alpha",
    });
  });

  it("실제 지식 투영은 6개 렌즈의 정상 empty state를 validation 오류로 바꾸지 않는다", async () => {
    for (const lens of ["work", "document", "file", "symbol", "artifact", "agent"] as const) {
      const native = transport({ "knowledge.graph": { lens, nodes: [], edges: [] } });
      const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

      await expect(service.loadKnowledgeGraph("workspace-knowledge", lens)).resolves.toEqual({
        lens,
        nodes: [],
        edges: [],
      });
      expect(native.query).toHaveBeenCalledWith("knowledge.graph", { workspaceId: "workspace-knowledge", lens });
    }
  });

  it("실제 지식 투영은 손상된 상태·렌즈·노드·dangling edge를 빈 그래프로 숨기지 않는다", async () => {
    const invalidIndex = createApplicationDesktopService(
      transport({
        "knowledge.index": {
          workspaceId: "workspace-knowledge",
          status: "complete",
          fileCount: 0,
          symbolCount: 0,
          relationCount: 0,
          excluded: [],
        },
      }),
    );
    const mismatchedGraph = createApplicationDesktopService(
      transport({
        "knowledge.graph": {
          lens: "file",
          nodes: [{ nodeId: "work:work-alpha", kind: "work", label: "Alpha", secret: "must-not-pass" }],
          edges: [],
        },
      }),
    );
    const danglingGraph = createApplicationDesktopService(
      transport({
        "knowledge.graph": {
          lens: "work",
          nodes: [{ nodeId: "work:work-alpha", kind: "work", label: "Alpha" }],
          edges: [{ kind: "documents", sourceId: "work:work-alpha", targetId: "work:missing" }],
        },
      }),
    );
    const invalidLinks = createApplicationDesktopService(
      transport({
        "knowledge.links": [
          {
            node: { nodeId: "file:file-payment", kind: "file", label: "payment.ts" },
            kind: "documents",
            direction: "sideways",
          },
        ],
      }),
    );

    await expect(invalidIndex.loadKnowledgeIndex("workspace-knowledge")).rejects.toThrow();
    await expect(mismatchedGraph.loadKnowledgeGraph("workspace-knowledge", "work")).rejects.toThrow();
    await expect(danglingGraph.loadKnowledgeGraph("workspace-knowledge", "work")).rejects.toThrow();
    await expect(invalidLinks.loadKnowledgeLinks("workspace-knowledge", "file:file-payment")).rejects.toThrow();
  });

  it("현재 run과 종료 Work 상태 및 병합 활동의 시간순을 보존한다", async () => {
    const native = transport({
      "work.detail": { ...detail, status: "failed" },
      "run.list": [
        { ...run, runId: "run-finished", status: "completed", updatedAt: "2026-07-22T00:30:00.000Z" },
        { ...run, runId: "run-current", status: "running", updatedAt: "2026-07-22T00:20:00.000Z" },
      ],
      "work.activity.list": {
        items: [
          {
            activityId: "activity-new",
            workId: detail.workId,
            kind: "message",
            title: "새 활동",
            createdAt: "2026-07-22T00:30:00.000Z",
          },
          {
            activityId: "activity-old",
            workId: detail.workId,
            kind: "message",
            title: "이전 활동",
            createdAt: "2026-07-22T00:10:00.000Z",
          },
        ],
      },
      "work.directive.list": [
        {
          directiveId: "directive-1",
          workId: detail.workId,
          runId: run.runId,
          content: "중간 지시",
          createdAt: "2026-07-22T00:20:00.000Z",
        },
      ],
      "work.artifacts": [
        {
          artifactVersionId: "artifact-version-1",
          artifactId: "artifact-1",
          workId: detail.workId,
          name: "결과.txt",
          kind: "text",
          mediaType: "text/plain",
          checksum: "a".repeat(64),
          version: 1,
          createdAt: "2026-07-22T00:40:00.000Z",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const work = await service.loadWork(detail.workId);

    expect(work).toMatchObject({ status: "failed", run: { runId: "run-current", status: "running" } });
    expect(work.activities.map((activity) => activity.id)).toEqual([
      "activity-old",
      "directive:directive-1",
      "activity-new",
      "artifacts:current",
      "approval:approval-0001",
    ]);
  });

  it("지시·승인·run 제어에 실제 식별자와 revision을 보낸다", async () => {
    const native = transport();
    let id = 0;
    const service = createApplicationDesktopService(native, {
      createId: () => `request-${String(++id).padStart(4, "0")}`,
    });
    const work = await service.loadWork(detail.workId);
    const approval = work.approvals[0];
    if (!approval) throw new Error("승인 fixture가 없습니다");

    await service.submitDirective(work, "산업군별 이탈률도 분리해줘", "next-stage");
    await service.decideApproval(approval, "approve", "데스크톱에서 검토 완료");
    await service.cancelRun(work);
    await service.resumeRun({ ...work, run: { ...run, status: "blocked" } });

    const commands = native.command.mock.calls.map(([input]) => input);
    expect(commands).toEqual([
      expect.objectContaining({
        operation: "work.directive.submit",
        expectedRevision: 7,
        payload: {
          workId: detail.workId,
          runId: run.runId,
          content: "산업군별 이탈률도 분리해줘",
          mode: "next-stage",
        },
      }),
      expect.objectContaining({
        operation: "approval.decide",
        payload: {
          approvalId: "approval-0001",
          expectedApprovalRevision: 3,
          vote: "approve",
          reason: "데스크톱에서 검토 완료",
        },
      }),
      expect.objectContaining({ operation: "run.cancel", payload: { runId: run.runId } }),
      expect.objectContaining({
        operation: "run.resume",
        payload: { runId: run.runId, retryBlocked: true },
      }),
    ]);
  });

  it("새 Work 요청을 desktop surface의 run.start로 시작한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(
      service.startWork({ text: "파트너 계약 위험을 검토해줘", workspaceId: "workspace-0001" }),
    ).resolves.toEqual({
      runId: "run-new-0001",
    });
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "run.start",
        payload: {
          request: {
            text: "파트너 계약 위험을 검토해줘",
            surface: "desktop",
            workspaceId: "workspace-0001",
          },
        },
      }),
    );
  });

  it("Workspace 유무별 Work team 표시값은 내부 ID를 노출하지 않는다", async () => {
    const native = transport({
      "work.index": {
        items: [{ ...detail }, { ...detail, workId: "work-0002", workspaceId: "workspace-secret-0001" }],
      },
    });
    const service = createApplicationDesktopService(native);

    await expect(service.loadIndex({ filter: "active", search: "" })).resolves.toEqual([
      expect.objectContaining({ team: "Massion" }),
      expect.objectContaining({ team: "워크스페이스" }),
    ]);
  });

  it("잘못된 workspace 목록 항목을 runtime 경계에서 거부한다", async () => {
    const service = createApplicationDesktopService(
      transport({ "workspace.list": [{ workspaceId: "workspace-invalid" }] }),
    );

    await expect(service.loadWorkspaces()).rejects.toThrow("Workspace 응답이 유효하지 않습니다");
  });

  it("Settings 읽기와 변경 command가 실제 operation을 사용하며 secret을 view에 노출하지 않는다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const settings = await service.loadSettings();
    await service.addCredential({
      providerId: "openai",
      endpointId: "endpoint-1",
      label: "기본",
      credentialType: "api-key",
      secret: "input-only",
      priority: 1,
      weight: 1,
    });
    await service.configureRoute({ name: "default", routeKind: "chat" });

    expect(JSON.stringify(settings)).not.toContain("never-return-this");
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining([
        "router.catalog",
        "router.credentials",
        "router.routes",
        "subscription.providers",
        "subscription.accounts",
        "subscription.quota",
        "subscription.policy",
      ]),
    );
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "router.credential.add",
        payload: expect.objectContaining({ secret: "input-only" }),
      }),
    );
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "router.route.configure", payload: { name: "default", routeKind: "chat" } }),
    );
  });

  it("실제 Desktop service가 최근 모델 호출 기록을 조회하고 사람용 view로 투영한다", async () => {
    const native = transport({
      "router.attempts": [
        {
          attemptId: "attempt-live-1",
          at: "2026-07-30T01:00:00.000Z",
          routeId: "route-reasoning",
          modelId: "gpt-coding",
          providerId: "openai",
          optimizationRunId: "optimization-run-live-1",
          optimizationBatchId: "batch-live-1",
          status: "interrupted",
          failureClass: "network",
          inputTokens: 13,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          costMicros: 21,
          fallbackFrom: "attempt-live-0",
          workId: "work-0001",
          workTitle: "고객 이탈 원인 분석",
          credentialSecretVersion: 9,
          explanation: "never-return-this",
        },
      ],
    });
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    const attempts = await service.loadRouteAttempts();

    expect(native.query).toHaveBeenCalledWith("router.attempts", { limit: 50 });
    expect(attempts).toEqual([
      {
        attemptId: "attempt-live-1",
        at: "2026-07-30T01:00:00.000Z",
        routeId: "route-reasoning",
        modelId: "gpt-coding",
        providerId: "openai",
        optimizationRunId: "optimization-run-live-1",
        optimizationBatchId: "batch-live-1",
        status: "interrupted",
        failureClass: "network",
        inputTokens: 13,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costMicros: 21,
        fallbackFrom: "attempt-live-0",
        workId: "work-0001",
        workTitle: "고객 이탈 원인 분석",
      },
    ]);
    expect(JSON.stringify(attempts)).not.toContain("never-return-this");
  });

  it("모델 호출 기록 응답이 손상되면 호출 없음으로 숨기지 않는다", async () => {
    const service = createApplicationDesktopService(
      transport({ "router.attempts": [{ attemptId: "attempt-malformed" }] }),
    );

    await expect(service.loadRouteAttempts()).rejects.toThrow("Route Attempt");
  });

  it("모델 호출 기록 시각은 canonical ISO instant만 허용한다", () => {
    const attempt = (at: unknown) => ({
      attemptId: "attempt-time",
      at,
      routeId: "route-1",
      modelId: "gpt",
      providerId: "openai",
      status: "succeeded",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costMicros: 1,
    });

    expect(() => projectRouteAttempts([attempt(0)])).toThrow("at");
    expect(() => projectRouteAttempts([attempt("2026-02-30T00:00:00.000Z")])).toThrow("at");
    expect(() => projectRouteAttempts([attempt(new Date(Number.NaN))])).toThrow("at");
    expect(projectRouteAttempts([attempt("2026-07-30T01:02:03.004Z")])).toMatchObject([
      { at: "2026-07-30T01:02:03.004Z" },
    ]);
  });

  it("Capabilities registry 조회·설치 결과에서 awaiting-approval 식별자를 보존한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect(service.searchRegistry("calendar")).resolves.toEqual([{ versionId: "version-1" }]);
    await expect(service.loadRegistryInfo("version-1")).resolves.toEqual({ versionId: "version-1" });
    await expect(service.loadCapabilities()).resolves.toEqual({
      extensions: [],
      inventory: [{ packageName: "calendar" }],
    });
    await expect(
      service.installRegistry({
        versionId: "version-1",
        environment: "production",
        riskClass: "medium",
        executionId: "execution-1",
      }),
    ).resolves.toEqual({ outcome: "awaiting-approval", approvalId: "approval-install-1" });
    expect(native.query).toHaveBeenCalledWith("registry.search", { query: "calendar", limit: 20 });
    expect(native.query).toHaveBeenCalledWith("registry.info", { versionId: "version-1" });
    expect(native.query).toHaveBeenCalledWith("registry.inventory", {});
    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "registry.install",
        payload: { versionId: "version-1", environment: "production", riskClass: "medium", executionId: "execution-1" },
      }),
    );
  });

  it("승인 대기 Registry 설치는 같은 명령·상관관계 식별자와 승인 ID로 재개한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "generated-id" });
    const request = {
      versionId: "version-1",
      environment: "production",
      riskClass: "medium",
      executionId: "execution-1",
    };
    const identity = { commandId: "registry-install-command-1", correlationId: "registry-install-correlation-1" };

    await service.installRegistry(request, identity);
    await service.installRegistry({ ...request, installApprovalId: "approval-install-1" }, identity);

    expect(native.command).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandId: "registry-install-command-1",
        correlationId: "registry-install-correlation-1",
        operation: "registry.install",
        payload: request,
      }),
    );
    expect(native.command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandId: "registry-install-command-1",
        correlationId: "registry-install-correlation-1",
        operation: "registry.install",
        payload: { ...request, installApprovalId: "approval-install-1" },
      }),
    );
  });

  it("성장 기록은 기존 읽기 전용 query 네 개로만 조회한다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await expect((service as DesktopService & { loadGrowth(): Promise<unknown> }).loadGrowth()).resolves.toMatchObject({
      configuration: { governanceDecisionId: "decision-growth-0001" },
      memories: [{ memoryVersionId: "memory-0001", revision: 3, entries: [{ key: "verification-required" }] }],
      suggestions: [{ status: "awaiting-review" }],
      effects: [{ result: "improved" }],
    });
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining(["growth.configuration.get", "growth.memories", "growth.suggestions", "growth.effects"]),
    );
  });

  it("개선 상세의 거절은 revision과 사유를 typed command로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.rejectGrowthSuggestion({
      suggestionId: "suggestion-0001",
      expectedRevision: 2,
      reason: "현재 근거가 부족합니다",
    });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.suggestion.reject",
        payload: {
          suggestionId: "suggestion-0001",
          expectedRevision: 2,
          reason: "현재 근거가 부족합니다",
        },
      }),
    );
  });

  it("개선 상세의 승인은 revision과 사유를 typed command로 보낸다", async () => {
    const native = transport();
    const service = createApplicationDesktopService(native, { createId: () => "request-0001" });

    await service.approveGrowthSuggestion({
      suggestionId: "suggestion-0001",
      expectedRevision: 2,
      reason: "평가와 대상 checksum을 확인했습니다",
    });

    expect(native.command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "growth.suggestion.approve",
        payload: {
          suggestionId: "suggestion-0001",
          expectedRevision: 2,
          reason: "평가와 대상 checksum을 확인했습니다",
        },
      }),
    );
  });
});
