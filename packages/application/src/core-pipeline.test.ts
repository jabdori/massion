import { createHash } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { createCoreWorkPipelineExecutors } from "./core-pipeline.js";

describe("actual Core Work pipeline adapters", () => {
  it("intake가 실제 Work·Representative Runtime을 만들고 model unavailable을 명시 차단한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "pipeline@example.com", displayName: "Pipeline" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const calls: string[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context, input) => {
          calls.push(input.agentHandle);
          return { executionId: "execution-representative", status: "blocked_model_unavailable" };
        },
        cancel: async () => undefined,
      },
      strategy: {
        plan: async () => {
          throw new Error("blocked intake 뒤 strategy를 실행하면 안 됩니다");
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    const result = await stages.intake.execute(context, {
      runId: "pipeline-run-0001",
      commandId: "pipeline-run-0001:intake",
      correlationId: "pipeline-correlation-0001",
      request: { text: "제품화" },
    });
    expect(result).toMatchObject({ outcome: "blocked", reason: "model-unavailable", workId: expect.any(String) });
    expect(calls).toEqual(["representative"]);
    expect(await works.getWork(context, (result as { workId: string }).workId)).toMatchObject({ status: "draft" });
  });

  it("재시도 intake는 기존 Work를 만들지 않고 같은 Work로 Representative를 다시 실행한다", async () => {
    const createWorkCalls: string[] = [];
    const representativeCalls: Array<{ workId: string; commandId: string }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async (_context: unknown, input: { commandId: string }) => {
          createWorkCalls.push(input.commandId);
          return { work: { work_id: "new-work-should-not-exist" } };
        },
        getWork: async () => ({ revision: 1, status: "draft" }),
        transition: async () => ({}) as never,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context: unknown, input: { workId: string; commandId: string }) => {
          representativeCalls.push({ workId: input.workId, commandId: input.commandId });
          return { executionId: "retry-representative-execution", status: "succeeded" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    await expect(
      stages.intake.execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-retry-run-0001",
          workId: "pipeline-existing-work-0001",
          commandId: "pipeline-retry-run-0001:intake:retry:run-resume-retry-command-0001",
          correlationId: "pipeline-retry-correlation-0001",
          request: { text: "기존 Work 재시도" },
        },
      ),
    ).resolves.toMatchObject({ outcome: "advanced", workId: "pipeline-existing-work-0001" });
    expect(createWorkCalls).toEqual([]);
    expect(representativeCalls).toEqual([
      {
        workId: "pipeline-existing-work-0001",
        commandId: "pipeline-retry-run-0001:intake:retry:run-resume-retry-command-0001:representative",
      },
    ]);
  });

  it("Work 생성 직후 취소되면 Work를 cancelled로 정리하고 Representative를 시작하지 않는다", async () => {
    const controller = new AbortController();
    const transitions: unknown[] = [];
    let representativeCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          controller.abort();
          return { work: { work_id: "pipeline-cancelled-work", revision: 1, status: "draft" } };
        },
        getWork: async () => ({ work_id: "pipeline-cancelled-work", revision: 1, status: "draft" }),
        transition: async (_context: unknown, value: unknown) => {
          transitions.push(value);
          return {} as never;
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => {
          representativeCalls += 1;
          return { executionId: "representative-should-not-start", status: "succeeded" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    await expect(
      stages.intake.execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-cancel-after-work-0001",
          commandId: "pipeline-cancel-after-work-0001:intake",
          correlationId: "pipeline-cancel-after-work-correlation-0001",
          request: { text: "Work 생성 뒤 취소" },
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("Application run cancelled");
    expect(transitions).toEqual([
      {
        commandId: "pipeline-cancel-after-work-0001:work-cancel",
        workId: "pipeline-cancelled-work",
        expectedRevision: 1,
        target: "cancelled",
      },
    ]);
    expect(representativeCalls).toBe(0);
  });

  it("intake가 실행 레코드 생성 중 취소된 Representative에 signal을 전달해 Provider 시작을 막는다", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () =>
          ({ work: { work_id: "pipeline-intake-signal-work", revision: 1, status: "draft" } }) as never,
        getWork: async () => ({ work_id: "pipeline-intake-signal-work", revision: 1, status: "draft" }) as never,
        transition: async () => ({}) as never,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async (_context, runtimeInput) => {
          receivedSignal = runtimeInput.signal;
          // 실행 레코드를 만든 직후 coordinator가 취소한 상황을 재현합니다.
          controller.abort("application-run-cancelled");
          if (!runtimeInput.signal?.aborted) providerCalls += 1;
          return { executionId: "representative-cancelled-before-provider", status: "cancelled" };
        },
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    await stages.intake.execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-intake-signal-0001",
        commandId: "pipeline-intake-signal-0001:intake",
        correlationId: "pipeline-intake-signal-correlation-0001",
        request: { text: "Representative 취소 신호 전달" },
        signal: controller.signal,
      },
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(providerCalls).toBe(0);
  });

  it("context-strategy는 Work 조회 중 취소되면 Provider 계획을 시작하지 않는다", async () => {
    const controller = new AbortController();
    let releaseWork!: (value: { readonly revision: number }) => void;
    let enteredWork!: () => void;
    const workRead = new Promise<void>((resolve) => {
      enteredWork = resolve;
    });
    const work = new Promise<{ readonly revision: number }>((resolve) => {
      releaseWork = resolve;
    });
    let planCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => {
          enteredWork();
          return await work;
        },
        transition: async () => ({}) as never,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async () => {
          planCalls += 1;
          return { contextVersion: {}, generation: { status: "applied" }, projection: {} } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);

    const executing = stages["context-strategy"].execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-strategy-cancel-0001",
        workId: "pipeline-strategy-work-0001",
        commandId: "pipeline-strategy-cancel-0001:context-strategy",
        correlationId: "pipeline-strategy-cancel-correlation-0001",
        request: { text: "계획 취소" },
        signal: controller.signal,
      },
    );
    await workRead;
    controller.abort();
    releaseWork({ revision: 3 });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(planCalls).toBe(0);
  });

  it("context-strategy가 실행 레코드 생성 중 취소 신호를 Strategy plan에 전달한다", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) as never },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3, status: "draft" }) as never,
        transition: async () => ({}) as never,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context, planInput) => {
          receivedSignal = planInput.signal;
          // StrategyGenerator가 실행 레코드를 만든 직후 취소된 경우를 재현합니다.
          controller.abort("application-run-cancelled");
          if (!planInput.signal?.aborted) providerCalls += 1;
          return { contextVersion: {}, generation: { status: "failed" } } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });

    await stages["context-strategy"].execute(
      { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
      {
        runId: "pipeline-strategy-signal-0001",
        workId: "pipeline-strategy-signal-work-0001",
        commandId: "pipeline-strategy-signal-0001:context-strategy",
        correlationId: "pipeline-strategy-signal-correlation-0001",
        request: { text: "Strategy 취소 신호 전달" },
        signal: controller.signal,
      },
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(providerCalls).toBe(0);
  });

  it("context-strategy 취소는 진행 중인 strategy runtime을 정리한다", async () => {
    const lookups: string[] = [];
    const cancelled: Array<{ readonly executionId: string; readonly reason: string }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3, status: "draft" }),
        transition: async () => ({}) as never,
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async (_context: unknown, commandId: string) => {
          lookups.push(commandId);
          return "strategy-runtime-execution-0001";
        },
      },
      representative: {
        execute: async () => ({ executionId: "representative-unused", status: "succeeded" }),
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          cancelled.push({ executionId, reason });
        },
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);
    const context = { userId: "user", organizationId: "org", membershipId: "member", role: "owner" as const };

    await stages["context-strategy"].cancel?.(context, {
      runId: "pipeline-strategy-cancel-0002",
      workId: "pipeline-strategy-work-0002",
      commandId: "pipeline-strategy-cancel-0002:context-strategy:cancel",
      correlationId: "pipeline-strategy-cancel-correlation-0002",
      request: {},
    });

    expect(lookups).toEqual(["pipeline-strategy-cancel-0002:context-strategy:generate:runtime"]);
    expect(cancelled).toEqual([
      { executionId: "strategy-runtime-execution-0001", reason: "Application run cancelled" },
    ]);
  });

  it("context-strategy가 실제 StrategyService contract에 정본 request source를 전달한다", async () => {
    const captured: Array<{
      workId: string;
      expectedWorkRevision: number;
      context: {
        objective: string;
        constraints: readonly string[];
        sources: ReadonlyArray<{ kind: string; content: { text: string }; contentHash: string }>;
      };
    }> = [];
    const stages = createCoreWorkPipelineExecutors({
      graph: { getCurrentSnapshot: async () => ({ version: { version_id: "org-version" } }) },
      works: {
        createWork: async () => {
          throw new Error("not used");
        },
        getWork: async () => ({ revision: 3 }),
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "execution", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: {
        plan: async (_context: unknown, input: unknown) => {
          captured.push(input as (typeof captured)[number]);
          return { contextVersion: {}, generation: { status: "applied" }, projection: {} } as never;
        },
      },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: { execute: async () => ({ outcome: "advanced" }) },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    } as never);
    await expect(
      stages["context-strategy"].execute(
        { userId: "user", organizationId: "org", membershipId: "member", role: "owner" },
        {
          runId: "pipeline-run-0002",
          workId: "pipeline-work-0002",
          commandId: "pipeline-run-0002:context-strategy",
          correlationId: "pipeline-correlation-0002",
          request: { text: "계획", constraints: ["근거"] },
        },
      ),
    ).resolves.toMatchObject({ outcome: "advanced" });
    expect(captured[0]).toMatchObject({
      workId: "pipeline-work-0002",
      expectedWorkRevision: 3,
      context: { objective: "계획", constraints: ["근거"], sources: [{ kind: "request", content: { text: "계획" } }] },
    });
    const capturedInput = captured[0];
    const source = capturedInput?.context.sources[0];
    if (!source) throw new Error("Strategy source가 capture되지 않았습니다");
    expect(source.contentHash).toBe(
      createHash("sha256")
        .update(JSON.stringify({ text: "계획" }))
        .digest("hex"),
    );
  });

  it("어느 단계에서 취소해도 현재 실행을 drain한 뒤 실제 Work를 cancelled로 전이한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "pipeline-cancel@example.com",
      displayName: "Cancel",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "pipeline-cancel-create-0001",
      text: "취소할 작업",
      surface: "test",
      organizationVersionId: core.version.version_id,
    });
    const drains: string[] = [];
    const stages = createCoreWorkPipelineExecutors({
      graph,
      works,
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      representative: {
        execute: async () => ({ executionId: "unused", status: "succeeded" }),
        cancel: async () => undefined,
      },
      strategy: { plan: async () => ({}) as never },
      evidence: { execute: async () => ({ outcome: "advanced" }) },
      delivery: {
        execute: async () => ({ outcome: "advanced" }),
        cancel: async (_context, input) => {
          drains.push(input.commandId);
        },
      },
      assurance: { execute: async () => ({ outcome: "advanced" }) },
      records: { execute: async () => ({ outcome: "advanced" }) },
    });
    await stages.delivery.cancel?.(context, {
      runId: "pipeline-cancel-run-0001",
      workId: created.work.work_id,
      commandId: "pipeline-cancel-run-0001:delivery:cancel",
      correlationId: "pipeline-cancel-correlation-0001",
      request: {},
    });
    expect(drains).toEqual(["pipeline-cancel-run-0001:delivery:cancel"]);
    await expect(works.getWork(context, created.work.work_id)).resolves.toMatchObject({ status: "cancelled" });
  });
});
