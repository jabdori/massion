import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { PromptMemoryStore } from "./prompt-memory.js";
import { GrowthWorkPromptAdapter } from "./work-prompt-adapter.js";

describe("Growth Work PromptVersion adapter", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: PromptMemoryStore;
  let adapter: GrowthWorkPromptAdapter;
  let work: WorkService;
  let organizationVersionId: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "prompt-work-owner@example.com", displayName: "Owner" });
    const other = await identity.registerPersonalUser({ email: "prompt-work-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    organizationVersionId = bootstrapped.version.version_id;
    store = await PromptMemoryStore.create(database, organizations);
    await store.bootstrap(context, bootstrapped.nodes);
    adapter = new GrowthWorkPromptAdapter(database, organizations, store);
    work = await WorkService.create(database, organizations, graph, undefined, adapter);
  });

  afterEach(async () => database.close());

  async function createWork(commandId: string) {
    return await work.createWork(context, {
      commandId,
      text: "프롬프트 버전 테스트",
      surface: "test",
      organizationVersionId,
    });
  }

  function promptVersionId(created: Awaited<ReturnType<typeof createWork>>): string {
    const id = created.work.prompt_version_id;
    if (!id) throw new Error("테스트 Work에 PromptVersion ID가 없습니다");
    return id;
  }

  it("정의와 Memory가 바뀌면 새 Work의 effective Prompt checksum만 바뀐다", async () => {
    const first = await createWork("effective-first");
    const definition = await store.getActivePromptDefinition(context);
    await store.activatePromptDefinition(context, {
      commandId: "effective-definition-2",
      expectedVersion: definition.version,
      sections: definition.sections.map((section) =>
        section.agentHandle === "assurance"
          ? { ...section, instruction: `${section.instruction}\n설정 파일을 확인한다` }
          : section,
      ),
    });
    await store.activateMemory(context, {
      commandId: "effective-memory-2",
      scope: "organization",
      expectedVersion: 1,
      entries: [{ kind: "fact", key: "style", value: "검증 우선", sourceReferenceIds: ["record-1"] }],
    });
    const second = await createWork("effective-second");
    const firstPrompt = await store.getPromptVersion(context, promptVersionId(first));
    const secondPrompt = await store.getPromptVersion(context, promptVersionId(second));

    expect(firstPrompt.promptVersionId).not.toBe(secondPrompt.promptVersionId);
    expect(firstPrompt.checksum).not.toBe(secondPrompt.checksum);
    expect((await work.getWork(context, first.work.work_id)).prompt_version_id).toBe(firstPrompt.promptVersionId);
  });

  it("다른 tenant와 저장된 bundle 변조를 거부한다", async () => {
    const created = await createWork("effective-protected");

    await expect(adapter.verify(otherContext, promptVersionId(created), database)).rejects.toThrow(
      "PromptVersion을 찾을 수 없습니다",
    );
    const tamperQuery =
      "UPDATE prompt_version SET agent_sections_json = '[]' WHERE organization_id = $organization_id AND prompt_version_id = $prompt_version_id;";
    const tamperBindings = {
      organization_id: context.organizationId,
      prompt_version_id: created.work.prompt_version_id,
    };
    await expect(database.query(tamperQuery, tamperBindings)).rejects.toThrow("immutable");
    await database.query("REMOVE EVENT prompt_version_immutable ON TABLE prompt_version;");
    await database.query(tamperQuery, tamperBindings);
    await expect(adapter.verify(context, promptVersionId(created), database)).rejects.toThrow("checksum");
  });
});
