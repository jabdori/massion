import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  type ContextClassification,
  type ContextVersion,
  type StrategyPlan,
} from "./index.js";

const VALID_STRATEGY_PLAN: StrategyPlan = {
  objective: "Massion 완제품을 구현한다",
  summary: "설계와 검증을 수행한다",
  scopeIn: ["strategy"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "산출물이 생성된다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "verify",
      title: "검증",
      objective: "산출물을 생성한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: [],
      requiredCapabilities: ["testing"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

describe("Strategy Generator", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let work: WorkService;
  let workId: string;
  let contextStore: ContextStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "strategy@example.com", displayName: "Strategy" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    work = await WorkService.create(database, organizations);
    workId = (
      await work.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "계획을 만들어주세요",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    contextStore = await ContextStore.create(database, organizations, work);
  });

  async function contextVersion(classification: ContextClassification = "internal"): Promise<ContextVersion> {
    const content = "계획을 만들어주세요";
    return await contextStore.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "계획 생성",
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
          classification,
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
  }

  it("ContextVersion을 structured Runtime으로 생성하고 plan checksum을 저장한다", async () => {
    const version = await contextVersion();
    const runner: StructuredAgentRunner = {
      executeStructured: vi.fn().mockResolvedValue({
        executionId: "execution-1",
        status: "succeeded",
        output: VALID_STRATEGY_PLAN,
      }),
    };
    const generator = await StrategyGenerator.create(database, organizations, runner, contextStore, work);

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated).toMatchObject({ status: "generated", runtimeExecutionId: "execution-1" });
    expect(generated.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(generated.plan).toEqual(VALID_STRATEGY_PLAN);
    expect(runner.executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ agentHandle: "context-strategy", modelRoute: "planning-quality" }),
      expect.objectContaining({ name: "massion-strategy-plan", validate: expect.any(Function) }),
    );
  });

  it("local-private Context는 local-private Route만 사용한다", async () => {
    const version = await contextVersion("local-private");
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-local",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelRoute: "local-private" }),
      expect.any(Object),
    );
  });

  it("자동 Core Office 계획은 자동 검증 가능한 산출물 증거만 허용한다", async () => {
    const version = await contextVersion();
    const nonAutomaticPlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      acceptanceCriteria: [
        {
          key: "criterion-tests",
          statement: "기록을 검사한다",
          method: "inspection",
          evidenceKinds: ["text-record"],
          planLevel: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-non-automatic",
      status: "succeeded",
      output: nonAutomaticPlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated.status).toBe("failed");
    const output = executeStructured.mock.calls[0]?.[2];
    expect(output?.validate?.(nonAutomaticPlan)).toMatchObject({ success: false });
  });

  it("자동 Core Office 계획은 실제 Core Office 담당자만 Task에 추천한다", async () => {
    const version = await contextVersion();
    const unknownAgentPlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      tasks: [
        {
          key: "verify",
          title: "검증",
          objective: "산출물을 생성한다",
          criterionKeys: ["criterion-tests"],
          dependencyKeys: [],
          requiredCapabilities: ["testing"],
          recommendedAgentHandles: ["zai-agent"],
          parallelizable: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-unknown-agent",
      status: "succeeded",
      output: unknownAgentPlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );

    const generated = await generator.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(generated.status).toBe("failed");
    const output = executeStructured.mock.calls[0]?.[2];
    expect(output?.validate?.(unknownAgentPlan)).toMatchObject({ success: false });
  });

  it("활성 Software Engineering 전문 담당자를 자동 계획에 추천할 수 있다", async () => {
    const version = await contextVersion();
    const softwarePlan: StrategyPlan = {
      ...VALID_STRATEGY_PLAN,
      tasks: [
        {
          key: "implement-backend-change",
          title: "Backend 변경 구현",
          objective: "테스트 우선으로 작은 Backend 변경을 구현한다",
          criterionKeys: ["criterion-tests"],
          dependencyKeys: [],
          requiredCapabilities: ["backend-engineering"],
          recommendedAgentHandles: ["software-engineering.backend-specialist"],
          parallelizable: false,
        },
      ],
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-software-specialist",
      status: "succeeded",
      output: softwarePlan,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
      {
        listNodes: async () => [
          {
            handle: "software-engineering.backend-specialist",
            status: "active",
            capabilities: ["backend-engineering"],
          },
        ],
      } as never,
    );

    await expect(
      generator.generate(context, {
        commandId: crypto.randomUUID(),
        workId,
        expectedWorkRevision: 1,
        contextVersionId: version.contextVersionId,
      }),
    ).resolves.toMatchObject({ status: "generated", plan: softwarePlan });
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        input: expect.objectContaining({
          availableAgents: [
            expect.objectContaining({
              handle: "software-engineering.backend-specialist",
              capabilities: ["backend-engineering"],
            }),
          ],
        }),
      }),
      expect.any(Object),
    );
  });

  it("모델 부재와 invalid output은 Work를 변경하지 않고 secret 없는 상태를 남긴다", async () => {
    const version = await contextVersion();
    const blocked = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "execution-blocked",
          status: "blocked_model_unavailable",
        }),
      },
      contextStore,
      work,
    );
    const blockedResult = await blocked.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });
    expect(blockedResult.status).toBe("blocked_model_unavailable");

    const invalid = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: "execution-invalid",
          status: "succeeded",
          output: { apiKey: "secret-value" },
        }),
      },
      contextStore,
      work,
    );
    const invalidResult = await invalid.generate(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });

    expect(invalidResult.status).toBe("failed");
    expect(JSON.stringify(await invalid.get(context, invalidResult.strategyGenerationId))).not.toContain(
      "secret-value",
    );
    expect((await work.getWork(context, workId)).status).toBe("draft");
  });

  it("같은 command를 멱등 재생하고 Work revision 변경을 모델 호출 전에 거부한다", async () => {
    const version = await contextVersion();
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-idempotent",
      status: "succeeded",
      output: VALID_STRATEGY_PLAN,
    });
    const generator = await StrategyGenerator.create(
      database,
      organizations,
      { executeStructured },
      contextStore,
      work,
    );
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    };

    const first = await generator.generate(context, input);
    const repeated = await generator.generate(context, input);

    expect(repeated).toEqual(first);
    expect(executeStructured).toHaveBeenCalledTimes(1);
    await expect(
      generator.generate(context, { ...input, commandId: crypto.randomUUID(), expectedWorkRevision: 2 }),
    ).rejects.toThrow("Work revision");
    expect(executeStructured).toHaveBeenCalledTimes(1);
  });
});
