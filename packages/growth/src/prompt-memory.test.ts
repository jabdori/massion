import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { PromptMemoryStore } from "./prompt-memory.js";

describe("PromptDefinitionVersion과 MemoryVersion", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let store: PromptMemoryStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "prompt-memory@example.com", displayName: "Prompt" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    store = await PromptMemoryStore.create(database, organizations);
    await store.bootstrap(context, bootstrapped.nodes);
  });

  afterEach(async () => database.close());

  it("활성 Organization node에서 초기 PromptDefinition과 빈 Memory를 만든다", async () => {
    const definition = await store.getActivePromptDefinition(context);
    const memories = await store.getActiveMemories(context, context.userId);

    expect(definition.version).toBe(1);
    expect(definition.sections.find((section) => section.agentHandle === "assurance")?.instruction).toContain(
      "독립 리뷰",
    );
    expect(definition.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(memories).toEqual([expect.objectContaining({ scope: "organization", version: 1, entries: [] })]);
  });

  it("새 PromptDefinition과 MemoryVersion을 활성화하고 이전 version을 보존한다", async () => {
    const first = await store.getActivePromptDefinition(context);
    const adopted = await store.activatePromptDefinition(context, {
      commandId: "prompt-definition-2",
      expectedVersion: 1,
      sections: first.sections.map((section) =>
        section.agentHandle === "assurance"
          ? { ...section, instruction: `${section.instruction}\n항상 설정 파일 변경을 검사한다` }
          : section,
      ),
    });
    const memory = await store.activateMemory(context, {
      commandId: "memory-2",
      scope: "organization",
      expectedVersion: 1,
      entries: [
        {
          kind: "procedure",
          key: "configuration-review",
          value: "설정 파일 변경 여부를 항상 확인한다",
          sourceReferenceIds: ["work-record-1"],
        },
      ],
    });

    expect(adopted.version).toBe(2);
    expect(adopted.parentVersionId).toBe(first.promptDefinitionVersionId);
    expect(memory.version).toBe(2);
    expect(memory.entries).toHaveLength(1);
    const [definitions] = await database.query<[Array<{ status: string; version: number }>]>(
      "SELECT status, version FROM prompt_definition_version WHERE organization_id = $organization_id ORDER BY version ASC;",
      { organization_id: context.organizationId },
    );
    expect(definitions.map((record) => record.status)).toEqual(["superseded", "active"]);
  });

  it("version 활성화 command를 멱등 재생하고 payload 충돌을 거부한다", async () => {
    const first = await store.getActivePromptDefinition(context);
    const input = {
      commandId: "idempotent-definition",
      expectedVersion: 1,
      sections: first.sections.map((section) =>
        section.agentHandle === "growth" ? { ...section, instruction: `${section.instruction}\n재시도 안전` } : section,
      ),
    };
    const activated = await store.activatePromptDefinition(context, input);

    await expect(store.activatePromptDefinition(context, input)).resolves.toEqual(activated);
    await expect(
      store.activatePromptDefinition(context, {
        ...input,
        sections: input.sections.map((section) =>
          section.agentHandle === "growth" ? { ...section, instruction: "다른 payload" } : section,
        ),
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("PromptDefinition의 일반 수정과 복구 원장 변조를 이중으로 탐지한다", async () => {
    const tamper =
      "UPDATE prompt_definition_version SET sections_json = '[]' WHERE organization_id = $organization_id AND status = 'active';";
    const bindings = { organization_id: context.organizationId };

    await expect(database.query(tamper, bindings)).rejects.toThrow("immutable");
    await database.query("REMOVE EVENT prompt_definition_invariant ON TABLE prompt_definition_version;");
    await database.query(tamper, bindings);
    await expect(store.getActivePromptDefinition(context)).rejects.toThrow("checksum");
  });

  it("개인 기억은 최초 생성·CAS 갱신·사용 중지를 version 이력으로 남긴다", async () => {
    const firstInput = {
      commandId: "explicit-memory-first",
      expectedRevision: 0,
      key: "answer-style",
      kind: "preference" as const,
      value: "답변은 먼저 결론을 말한다",
    };

    const first = await store.putExplicitMemory(context, firstInput);
    expect(first).toMatchObject({
      scope: "user",
      subjectId: context.userId,
      version: 1,
      entries: [{ key: "answer-style", kind: "preference", value: "답변은 먼저 결론을 말한다" }],
    });
    await expect(store.putExplicitMemory(context, firstInput)).resolves.toEqual(first);
    await expect(
      store.putExplicitMemory(context, {
        ...firstInput,
        commandId: "explicit-memory-stale",
        value: "다른 값",
      }),
    ).rejects.toThrow("precondition");

    const replaced = await store.putExplicitMemory(context, {
      ...firstInput,
      commandId: "explicit-memory-replace",
      expectedRevision: 1,
      value: "답변은 짧게 결론부터 말한다",
    });
    const forgotten = await store.forgetExplicitMemory(context, {
      commandId: "explicit-memory-forget",
      expectedRevision: 2,
      key: "answer-style",
    });

    expect(replaced).toMatchObject({ version: 2, parentVersionId: first.memoryVersionId });
    expect(forgotten).toMatchObject({ version: 3, parentVersionId: replaced.memoryVersionId, entries: [] });
  });
});
