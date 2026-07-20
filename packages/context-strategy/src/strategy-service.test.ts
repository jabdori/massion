import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  StrategyService,
  type PlanStrategyInput,
  type StrategyPlan,
} from "./index.js";

const PLAN: StrategyPlan = {
  objective: "완제품을 구현한다",
  summary: "구현하고 검증한다",
  scopeIn: ["strategy"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "테스트가 통과한다",
      method: "test",
      evidenceKinds: ["test-report"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "verify",
      title: "검증",
      objective: "테스트를 실행한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: [],
      requiredCapabilities: ["testing"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

describe("Context부터 Work projection까지의 StrategyService", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let works: WorkService;
  let contexts: ContextStore;
  let workId: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "service@example.com", displayName: "Service" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    works = await WorkService.create(database, organizations);
    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "계획을 세워주세요",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    contexts = await ContextStore.create(database, organizations, works);
  });

  afterEach(async () => database.close());

  function input(commandId = crypto.randomUUID()): PlanStrategyInput {
    const content = "계획을 세워주세요";
    return {
      commandId,
      workId,
      expectedWorkRevision: 1,
      tokenBudget: 4_000,
      context: {
        objective: "제품 계획",
        scopeIn: ["strategy"],
        scopeOut: [],
        constraints: [],
        assumptions: [],
        unknowns: [],
        decisions: [],
        sources: [
          {
            kind: "request",
            sourceId: "request-1",
            revision: "1",
            contentHash: hashContextContent(content),
            observedAt: "2026-07-10T00:00:00.000Z",
            classification: "internal",
            priority: 100,
            estimatedTokens: 100,
            mandatory: true,
            content,
          },
        ],
      },
    };
  }

  async function service(runner: StructuredAgentRunner, beforeProjection?: () => Promise<void>) {
    const generator = await StrategyGenerator.create(database, organizations, runner, contexts, works);
    return StrategyService.create(contexts, generator, works, beforeProjection ? { beforeProjection } : undefined);
  }

  it("ContextVersion, structured generation과 Work projection을 연결하고 같은 command를 재생한다", async () => {
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-service",
      status: "succeeded",
      output: PLAN,
    });
    const strategy = await service({ executeStructured });
    const request = input();

    const first = await strategy.plan(context, request);
    const repeated = await strategy.plan(context, request);

    expect(first.contextVersion.version).toBe(1);
    expect(first.generation.status).toBe("applied");
    expect(first.projection?.work.active_plan_version_id).toBe(first.projection?.plan.plan_version_id);
    expect(repeated.contextVersion.contextVersionId).toBe(first.contextVersion.contextVersionId);
    expect(repeated.projection?.plan.plan_version_id).toBe(first.projection?.plan.plan_version_id);
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });

  it("실행 레코드 생성 중 취소되면 StrategyGenerator가 structured Provider를 시작하지 않는다", async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    const executeStructured = vi.fn(
      async (_context: TenantContext, runtimeInput: Parameters<StructuredAgentRunner["executeStructured"]>[1]) => {
        // Runtime execution record가 만들어진 직후 coordinator가 취소한 상황을 재현합니다.
        controller.abort("application-run-cancelled");
        if (!runtimeInput.signal?.aborted) providerCalls += 1;
        if (runtimeInput.signal?.aborted) {
          return { executionId: "strategy-cancelled-before-provider", status: "cancelled" as const };
        }
        return { executionId: "strategy-provider-started", status: "succeeded" as const, output: PLAN };
      },
    );
    const strategy = await service({ executeStructured });

    await strategy.plan(context, {
      ...input(),
      signal: controller.signal,
    });

    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ signal: controller.signal }),
      expect.any(Object),
    );
    expect(providerCalls).toBe(0);
  });

  it("모델 부재와 잘못된 structured output은 Work를 변경하거나 계획을 꾸며내지 않는다", async () => {
    const blocked = await service({
      executeStructured: vi.fn().mockResolvedValue({
        executionId: "execution-blocked",
        status: "blocked_model_unavailable",
      }),
    });
    const blockedResult = await blocked.plan(context, input());
    expect(blockedResult).toMatchObject({ generation: { status: "blocked_model_unavailable" } });
    expect(blockedResult.projection).toBeUndefined();
    expect((await works.getWork(context, workId)).status).toBe("draft");

    const invalidWork = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "잘못된 출력을 거부해주세요",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work;
    workId = invalidWork.work_id;
    const invalid = await service({
      executeStructured: vi.fn().mockResolvedValue({
        executionId: "execution-invalid",
        status: "succeeded",
        output: { tasks: [] },
      }),
    });
    const invalidResult = await invalid.plan(context, input());
    expect(invalidResult.generation.status).toBe("failed");
    expect(invalidResult.projection).toBeUndefined();
    expect((await works.getWork(context, workId)).status).toBe("draft");
  });

  it("generation 뒤 Work revision이 바뀌면 projection하지 않고 conflicted로 종료한다", async () => {
    const strategy = await service(
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "execution-conflict",
          status: "succeeded",
          output: PLAN,
        }),
      },
      async () => {
        await works.addPlan(context, {
          commandId: crypto.randomUUID(),
          workId,
          expectedRevision: 1,
          content: { objective: "경쟁 계획" },
        });
      },
    );

    const result = await strategy.plan(context, input());
    expect(result.generation.status).toBe("conflicted");
    expect(result.projection).toBeUndefined();
    expect((await works.getWork(context, workId)).revision).toBe(2);
  });
});
