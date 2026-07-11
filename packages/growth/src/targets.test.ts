import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { PromptMemoryStore } from "./prompt-memory.js";
import { applyGrowthPatch, growthTargetChecksum, MemoryGrowthTarget, PromptGrowthTarget } from "./targets.js";

describe("Growth target projection", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it.each([
    [
      "prompt",
      { sections: [{ agentHandle: "assurance", instruction: "검증", capabilityReferences: [] }] },
      { agentHandle: "assurance", instruction: "검증과 회귀 테스트" },
    ],
    [
      "memory",
      { entries: [] },
      { kind: "procedure", key: "regression", value: "회귀 테스트", sourceReferenceIds: ["record-1"] },
    ],
    [
      "policy",
      { policies: { base: "permit(principal, action, resource);" } },
      { policyId: "base", policyText: "forbid(principal, action, resource);" },
    ],
    [
      "organization",
      { nodes: [{ handle: "specialist", responsibility: "개발" }] },
      { handle: "specialist", responsibility: "개발과 검증" },
    ],
  ] as const)("%s patch는 정본 snapshot을 결정론적으로 바꾼다", (kind, before, patch) => {
    const after = applyGrowthPatch(kind, before, patch);
    expect(growthTargetChecksum(after)).not.toBe(growthTargetChecksum(before));
  });

  it("지원하지 않는 필드와 자기 권한 확대 policy를 거부한다", () => {
    expect(() => applyGrowthPatch("prompt", { sections: [] }, { raw: "unchecked" })).toThrow("patch");
    expect(() =>
      applyGrowthPatch(
        "policy",
        { policies: { base: "permit(principal, action, resource);" } },
        { policyId: "growth", policyText: 'permit(principal, action == Massion::Action::"growth.adopt", resource);' },
      ),
    ).toThrow("self-amplification");
  });

  it("Prompt와 Memory target은 같은 transaction에서 새 immutable version을 만든다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "growth-target@example.com", displayName: "Target" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    const store = await PromptMemoryStore.create(database, organizations);
    await store.bootstrap(context, bootstrapped.nodes);
    const prompt = new PromptGrowthTarget(store);
    const memory = new MemoryGrowthTarget(store);

    let promptV1 = "";
    let promptV2 = "";
    await database.transaction(async (executor) => {
      const before = await prompt.inspect(context, { suggestionId: "prompt-1", patch: {} }, executor);
      promptV1 = before.versionId;
      const section = (before.snapshot.sections as Array<{ agentHandle: string }>)[0];
      if (!section) throw new Error("Prompt section이 없습니다");
      const result = await prompt.apply(
        context,
        {
          commandId: "adopt-prompt",
          suggestionId: "prompt-1",
          suggestionRevision: 1,
          patch: { agentHandle: section.agentHandle, instruction: "개선된 지시" },
          expectedVersionId: before.versionId,
          expectedChecksum: before.checksum,
          governanceDecisionId: "decision-1",
        },
        executor,
      );
      expect(result.after.versionId).not.toBe(result.before.versionId);
      promptV2 = result.after.versionId;
    });
    await database.transaction(async (executor) => {
      const reverted = await prompt.revert(
        context,
        {
          commandId: "revert-prompt",
          suggestionId: "prompt-1",
          suggestionRevision: 1,
          expectedVersionId: promptV2,
          targetVersionId: promptV1,
          governanceDecisionId: "decision-revert",
        },
        executor,
      );
      expect(reverted.after.versionId).not.toBe(promptV1);
      expect(
        (reverted.after.snapshot.sections as Array<{ instruction: string }>).some((section) =>
          section.instruction.includes("주요 산출물"),
        ),
      ).toBe(true);
    });
    const [original] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM prompt_definition_version WHERE organization_id = $organization_id AND prompt_definition_version_id = $version_id;",
      { organization_id: context.organizationId, version_id: promptV1 },
    );
    expect(original[0]?.status).toBe("superseded");
    await database.transaction(async (executor) => {
      const before = await memory.inspect(context, { suggestionId: "memory-1", patch: {} }, executor);
      const result = await memory.apply(
        context,
        {
          commandId: "adopt-memory",
          suggestionId: "memory-1",
          suggestionRevision: 1,
          patch: { kind: "procedure", key: "verify", value: "항상 검증", sourceReferenceIds: ["record-1"] },
          expectedVersionId: before.versionId,
          expectedChecksum: before.checksum,
          governanceDecisionId: "decision-2",
        },
        executor,
      );
      expect(result.after.versionId).not.toBe(result.before.versionId);
    });
  });
});
