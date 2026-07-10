import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  StrategyRecovery,
  type ContextVersion,
  type StrategyPlan,
} from "./index.js";

const PLAN: StrategyPlan = {
  objective: "복구 가능한 계획",
  summary: "투영 상태를 조정한다",
  scopeIn: ["recovery"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-recovered",
      statement: "계획이 한 번만 투영된다",
      method: "inspection",
      evidenceKinds: ["work-event"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "recover",
      title: "복구",
      objective: "생성 상태를 조정한다",
      criterionKeys: ["criterion-recovered"],
      dependencyKeys: [],
      requiredCapabilities: ["recovery"],
      recommendedAgentHandles: ["delivery-coordination"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

describe("Strategy generation crash recovery", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let works: WorkService;
  let contexts: ContextStore;
  let generator: StrategyGenerator;
  let workId: string;
  let version: ContextVersion;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    works = await WorkService.create(database, organizations);
    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "복구할 계획",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    contexts = await ContextStore.create(database, organizations, works);
    const content = "복구할 계획";
    version = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "복구",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-recovery",
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
    });
    generator = await StrategyGenerator.create(
      database,
      organizations,
      {
        executeStructured: vi.fn().mockResolvedValue({
          executionId: crypto.randomUUID(),
          status: "succeeded",
          output: PLAN,
        }),
      },
      contexts,
      works,
    );
  });

  afterEach(async () => database.close());

  async function generated(commandId = crypto.randomUUID()) {
    return await generator.generate(context, {
      commandId: `${commandId}:generate`,
      workId,
      expectedWorkRevision: 1,
      contextVersionId: version.contextVersionId,
    });
  }

  it("projection commit 뒤 applied 기록 전 crash를 active plan 근거로 조정한다", async () => {
    const rootCommandId = crypto.randomUUID();
    const generation = await generated(rootCommandId);
    let projectedPlanId: string | undefined;
    await expect(
      (async () => {
        const projection = await works.applyStrategyProjection(context, {
          commandId: `${rootCommandId}:project`,
          workId,
          expectedRevision: 1,
          contextVersionId: version.contextVersionId,
          strategyGenerationId: generation.strategyGenerationId,
          strategyChecksum: generation.checksum!,
          plan: generation.plan!,
        });
        projectedPlanId = projection.plan.plan_version_id;
        throw new Error("injected-after-projection-commit");
      })(),
    ).rejects.toThrow("injected-after-projection-commit");
    const recovery = StrategyRecovery.create(generator, works);

    const recovered = await recovery.recover(context);

    expect(recovered).toEqual([
      expect.objectContaining({ strategyGenerationId: generation.strategyGenerationId, status: "applied" }),
    ]);
    expect((await works.getWork(context, workId)).active_plan_version_id).toBe(projectedPlanId);
    expect((await works.listEvents(context, workId)).filter((event) => event.event_type === "strategy_projection_applied"))
      .toHaveLength(1);
  });

  it("projection 전 crash는 같은 revision에서 한 번 투영하고 revision 변경 시 conflicted로 종료한다", async () => {
    const retryGeneration = await generated();
    const recovery = StrategyRecovery.create(generator, works);
    expect((await recovery.recover(context))[0]?.status).toBe("applied");
    expect((await works.listTasks(context, workId)).map((task) => task.task_key)).toEqual(["recover"]);

    workId = (
      await works.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "충돌할 계획",
        surface: "test",
        organizationVersionId: "organization-v1",
      })
    ).work.work_id;
    const content = "충돌할 계획";
    version = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId,
      tokenBudget: 1_000,
      objective: "충돌",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "request-conflict",
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
    });
    const conflictGeneration = await generated();
    await works.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: 1,
      content: { objective: "경쟁 변경" },
    });

    const results = await recovery.recover(context);
    expect(results.find((candidate) => candidate.strategyGenerationId === conflictGeneration.strategyGenerationId))
      .toMatchObject({ status: "conflicted" });
    expect(await generator.get(context, retryGeneration.strategyGenerationId)).toMatchObject({ status: "applied" });
  });
});
