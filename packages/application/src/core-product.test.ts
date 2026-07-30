import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { CoreWorkCoordinator } from "./core-work-coordinator.js";
import { createCoreProductExecutors } from "./core-product.js";
import type { DynamicStaffingCoordinator } from "./core-staffing.js";
import { ApplicationRunStore } from "./run-store.js";
import { WorkDirectiveStore } from "./work-directive-store.js";

const readyStaffing = {
  prepare: async () => ({ outcome: "ready" as const }),
} satisfies Pick<DynamicStaffingCoordinator, "prepare">;

describe("Core product composition", () => {
  it("Core Office의 여섯 단계를 실제 전용 adapter로 빠짐없이 조립한다", () => {
    const executors = createCoreProductExecutors({
      graph: {},
      works: {},
      runner: {},
      runtimeExecutions: {},
      strategy: {},
      briefs: {},
      assurance: {},
      assuranceBindings: {},
      assuranceChecks: {},
      records: {},
      recordDocuments: {},
      software: {},
      staffing: readyStaffing,
    } as never);
    expect(Object.keys(executors)).toEqual([
      "intake",
      "context-strategy",
      "evidence",
      "delivery",
      "assurance",
      "records",
    ]);
    expect(Object.values(executors).every((executor) => typeof executor.execute === "function")).toBe(true);
  });

  it("공개 조립 경로는 지식 의존성이 제공된 Workspace Work를 구성 누락으로 차단하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "core-product-knowledge@example.com",
      displayName: "Core Product Knowledge",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const prepare = async () => ({ brief: { status: "no_match" } }) as never;
    const executors = createCoreProductExecutors({
      graph,
      works,
      runner: {
        execute: async () => ({
          executionId: "core-product-knowledge-representative",
          status: "blocked_model_unavailable",
        }),
        cancel: async () => undefined,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      strategy: {},
      briefs: {},
      assurance: {},
      assuranceBindings: {},
      assuranceChecks: {},
      records: {},
      software: {},
      staffing: readyStaffing,
      knowledge: {
        workspaces: {
          get: async () =>
            ({
              workspaceId: "core-product-knowledge-workspace",
              name: "Core Product Knowledge",
              path: "/workspace/core-product-knowledge",
              status: "active",
              trust: "trusted",
            }) as never,
        },
        workspaceKnowledge: { prepare },
        evidencePromptMaterializer: { materialize: async () => ({}) as never },
        evidenceContextBinder: { bind: async () => ({}) as never },
        contexts: { get: async () => ({}) as never },
      },
    } as never);

    await expect(
      executors.intake.execute(context, {
        runId: "core-product-knowledge-run-0001",
        commandId: "core-product-knowledge-run-0001:intake",
        correlationId: "core-product-knowledge-correlation-0001",
        request: { text: "no-match 지식 경로", workspaceId: "core-product-knowledge-workspace" },
      }),
    ).resolves.toMatchObject({ outcome: "blocked", reason: "model-unavailable", workId: expect.any(String) });
  });

  it("표준 Evidence adapter가 자유 지시를 소비하지 않으면 applied로 오인하지 않고 실패 폐쇄한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "core-product-directive@example.com",
      displayName: "Core Product Directive",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "core-product-directive-work-command-0001",
      text: "표준 제품 지시 실패 폐쇄",
      surface: "desktop",
      organizationVersionId: "core-product-directive-org-version-0001",
    });
    const runs = await ApplicationRunStore.create(database, organizations);
    const started = await runs.start(context, {
      commandId: "core-product-directive-run-command-0001",
      correlationId: "core-product-directive-run-correlation-0001",
      request: { text: "기존 요청" },
    });
    const intake = await runs.claim(context, started.runId);
    if (intake.outcome !== "claimed") throw new Error("Evidence 준비용 run lease를 얻지 못했습니다");
    await runs.advance(context, started.runId, intake.leaseGeneration, {
      stage: "evidence",
      workId: work.work.work_id,
    });
    const directives = await WorkDirectiveStore.create(database, organizations);
    const directive = await directives.submit(context, {
      commandId: "core-product-directive-submit-command-0001",
      correlationId: "core-product-directive-submit-correlation-0001",
      expectedRevision: work.work.revision,
      workId: work.work.work_id,
      runId: started.runId,
      content: "개인정보를 제외하고 근거를 다시 구성해주세요",
      mode: "now",
    });
    const executors = createCoreProductExecutors({
      graph: {},
      works: { getActivePlan: async () => undefined },
      runner: {},
      runtimeExecutions: {},
      strategy: {},
      briefs: {},
      assurance: {},
      assuranceBindings: {},
      assuranceChecks: {},
      records: {},
      software: {},
      staffing: readyStaffing,
    } as never);
    const coordinator = new CoreWorkCoordinator(runs, executors, {}, directives);

    await expect(coordinator.recover(context, started.runId)).resolves.toMatchObject({
      status: "blocked",
      stage: "evidence",
      blockedReason: "evidence-directive-unsupported",
    });
    await expect(directives.listByRun(context, started.runId)).resolves.toEqual([
      expect.objectContaining({
        directiveId: directive.directiveId,
        status: "failed",
        failureReason: "evidence-directive-unsupported",
      }),
    ]);
  });

  it("표준 Context & Strategy adapter가 지시 내용을 필수 재계획 source로 전달한 뒤에만 applied 처리한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "core-product-strategy-directive@example.com",
      displayName: "Core Product Strategy Directive",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "core-product-strategy-directive-work-command-0001",
      text: "표준 제품 전략 지시 적용",
      surface: "desktop",
      organizationVersionId: "core-product-strategy-directive-org-version-0001",
    });
    const runs = await ApplicationRunStore.create(database, organizations);
    const started = await runs.start(context, {
      commandId: "core-product-strategy-directive-run-command-0001",
      correlationId: "core-product-strategy-directive-run-correlation-0001",
      request: { text: "기존 전략을 작성해주세요" },
    });
    const intake = await runs.claim(context, started.runId);
    if (intake.outcome !== "claimed") throw new Error("Context & Strategy 준비용 run lease를 얻지 못했습니다");
    await runs.advance(context, started.runId, intake.leaseGeneration, {
      stage: "context-strategy",
      workId: work.work.work_id,
    });
    const directives = await WorkDirectiveStore.create(database, organizations);
    const directive = await directives.submit(context, {
      commandId: "core-product-strategy-directive-submit-command-0001",
      correlationId: "core-product-strategy-directive-submit-correlation-0001",
      expectedRevision: work.work.revision,
      workId: work.work.work_id,
      runId: started.runId,
      content: "개인정보를 수집하지 않는 방향으로 전략을 다시 세워주세요",
      mode: "now",
    });
    const capturedPlans: unknown[] = [];
    const executors = createCoreProductExecutors({
      graph: {
        getCurrentSnapshot: async () => ({
          version: { version_id: "core-product-strategy-directive-org-version-0001", version: 1 },
          nodes: [],
        }),
      },
      works,
      runner: {},
      runtimeExecutions: {},
      strategy: {
        plan: async (_context: unknown, input: unknown) => {
          capturedPlans.push(input);
          return {
            contextVersion: { contextVersionId: "directive-context-version" },
            generation: { status: "applied", strategyGenerationId: "directive-strategy-generation" },
            projection: {},
          } as never;
        },
      },
      briefs: {},
      assurance: {},
      assuranceBindings: {},
      assuranceChecks: {},
      records: {},
      software: {},
      staffing: readyStaffing,
    } as never);
    const coordinator = new CoreWorkCoordinator(runs, executors, {}, directives);

    await expect(coordinator.recover(context, started.runId)).resolves.toMatchObject({
      status: "blocked",
      stage: "evidence",
      blockedReason: "strategy-plan-missing",
    });
    expect(capturedPlans).toHaveLength(1);
    const capturedPlan = capturedPlans[0] as { readonly context: { readonly sources: readonly unknown[] } };
    expect(capturedPlan.context.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "manual",
          sourceId: directive.directiveId,
          mandatory: true,
          content: {
            directiveId: directive.directiveId,
            content: "개인정보를 수집하지 않는 방향으로 전략을 다시 세워주세요",
            mode: "now",
          },
        }),
      ]),
    );
    await expect(directives.listByRun(context, started.runId)).resolves.toEqual([
      expect.objectContaining({
        directiveId: directive.directiveId,
        status: "applied",
      }),
    ]);
    expect((await directives.listByRun(context, started.runId))[0]).not.toHaveProperty("failureReason");
  });
});
