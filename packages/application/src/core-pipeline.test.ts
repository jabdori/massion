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

  it("context-strategy가 실제 StrategyService contract에 정본 request source를 전달한다", async () => {
    const captured: any[] = [];
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
          captured.push(input);
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
    expect(captured[0].context.sources[0].contentHash).toBe(
      createHash("sha256")
        .update(JSON.stringify({ text: "계획" }))
        .digest("hex"),
    );
  });

  it("어느 단계에서 취소해도 현재 실행을 drain한 뒤 실제 Work를 cancelled로 전이한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "pipeline-cancel@example.com", displayName: "Cancel" });
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
      representative: { execute: async () => ({ executionId: "unused", status: "succeeded" }), cancel: async () => undefined },
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
