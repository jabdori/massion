import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { ContextBudgetBlockedError, ContextStore, hashContextContent, type ContextSource } from "./index.js";

describe("ContextVersion Store", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let work: WorkService;
  let workId: string;
  let store: ContextStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "context@example.com", displayName: "Context" });
    const other = await identity.registerPersonalUser({ email: "context-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    work = await WorkService.create(database, organizations);
    workId = (
      await work.createWork(context, {
        commandId: crypto.randomUUID(),
        text: "완제품을 구현해주세요",
        surface: "test",
        organizationVersionId: "organization-v1",
        projectId: "project-a",
      })
    ).work.work_id;
    store = await ContextStore.create(database, organizations, work);
  });

  function source(sourceId: string, content: unknown, options: Partial<ContextSource> = {}): ContextSource {
    return {
      kind: "request",
      sourceId,
      revision: "1",
      contentHash: hashContextContent(content),
      observedAt: "2026-07-10T00:00:00.000Z",
      classification: "internal",
      priority: 100,
      estimatedTokens: 100,
      mandatory: true,
      content,
      ...options,
    };
  }

  function input(commandId = crypto.randomUUID()) {
    return {
      commandId,
      workId,
      projectId: "project-a",
      tokenBudget: 200,
      objective: "Massion 완제품 구현",
      scopeIn: ["ContextPackage"],
      scopeOut: ["Repository index"],
      constraints: ["SurrealDB 단일 정본"],
      assumptions: [],
      unknowns: ["외부 근거 조사 필요"],
      decisions: [],
      sources: [
        source("request-1", "완제품을 구현해주세요"),
        source("manual-optional", "선택 참고", {
          kind: "manual",
          mandatory: false,
          priority: 10,
          estimatedTokens: 150,
        }),
      ],
    } as const;
  }

  it("immutable ContextVersion과 checksum을 만들고 optional source를 결정론적으로 제외한다", async () => {
    const created = await store.create(context, input());

    expect(created).toMatchObject({ version: 1, workId, projectId: "project-a", tokenTotal: 100 });
    expect(created.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.selectedSources.map((candidate) => candidate.sourceId)).toEqual(["request-1"]);
    expect(created.excludedSources).toEqual([
      expect.objectContaining({ sourceId: "manual-optional", reason: "token_budget" }),
    ]);
  });

  it("command 멱등과 parent version 선행조건을 강제한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.create(context, input(commandId));
    const repeated = await store.create(context, input(commandId));
    const next = await store.create(context, {
      ...input(),
      expectedParentContextVersionId: first.contextVersionId,
      sources: [source("follow-up", "검증도 포함해주세요", { kind: "follow_up" })],
    });

    expect(repeated).toEqual(first);
    expect(next).toMatchObject({ version: 2, parentContextVersionId: first.contextVersionId });
    await expect(store.create(context, { ...input(commandId), objective: "다른 목적" })).rejects.toThrow(
      "같은 commandId",
    );
    await expect(store.create(context, { ...input(), expectedParentContextVersionId: "wrong-parent" })).rejects.toThrow(
      "parent ContextVersion precondition",
    );
  });

  it("source hash 변조와 secret-ref 원문을 거부하고 mandatory budget 초과를 기록한다", async () => {
    await expect(
      store.create(context, {
        ...input(),
        sources: [{ ...source("tampered", "원문"), contentHash: "0".repeat(64) }],
      }),
    ).rejects.toThrow("content hash");
    await expect(
      store.create(context, {
        ...input(),
        sources: [source("secret-1", "secret-value", { classification: "secret-ref" })],
      }),
    ).rejects.toThrow("secret-ref");
    await expect(
      store.create(context, { ...input(), tokenBudget: 99, sources: [source("required", "필수")] }),
    ).rejects.toBeInstanceOf(ContextBudgetBlockedError);
    expect((await store.listEvents(context, workId)).at(-1)?.eventType).toBe("context_budget_blocked");
  });

  it("다른 조직은 ContextVersion과 Work를 읽을 수 없다", async () => {
    const created = await store.create(context, input());

    await expect(store.get(otherContext, created.contextVersionId)).rejects.toThrow(
      "ContextVersion을 찾을 수 없습니다",
    );
    await expect(store.create(otherContext, { ...input(), commandId: crypto.randomUUID() })).rejects.toThrow(
      "Work를 찾을 수 없습니다",
    );
  });

  it("저장된 ContextVersion package 변조를 checksum으로 탐지한다", async () => {
    const created = await store.create(context, input());
    await database.query(
      "UPDATE context_version SET package_json = $package_json WHERE organization_id = $organization_id AND context_version_id = $context_version_id;",
      {
        organization_id: context.organizationId,
        context_version_id: created.contextVersionId,
        package_json: JSON.stringify({ objective: "변조됨", sources: [] }),
      },
    );

    await expect(store.get(context, created.contextVersionId)).rejects.toThrow("checksum");
  });
});
