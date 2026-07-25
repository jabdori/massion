import { describe, expect, it, vi } from "vitest";

import { createApplicationDesktopService, createFixtureDesktopService, type DesktopService } from "./desktop-service";
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
        scope: "organization",
        subjectId: "organization",
        version: 3,
        status: "active",
        entryKeys: ["verification-required"],
        sourceReferenceIds: ["record-work-0001"],
        checksum: "a".repeat(64),
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
        "governance.approval.list",
        "work.directive.list",
      ]),
    );
    expect(work).toMatchObject({
      id: detail.workId,
      revision: 7,
      run: { runId: run.runId },
      activeExecutionId: "execution-0001",
    });
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
      memories: [{ sourceReferenceIds: ["record-work-0001"] }],
      suggestions: [{ status: "awaiting-review" }],
      effects: [{ result: "improved" }],
    });
    expect(native.query.mock.calls.map(([operation]) => operation)).toEqual(
      expect.arrayContaining(["growth.configuration.get", "growth.memories", "growth.suggestions", "growth.effects"]),
    );
  });
});
