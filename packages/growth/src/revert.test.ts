import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";

import { PromptMemoryStore } from "./prompt-memory.js";
import { decideGrowthRevertTransition, GrowthRevertService } from "./revert.js";
import { GROWTH_ADOPTION_MIGRATION } from "./schema.js";
import { GrowthTargetRegistry, PromptGrowthTarget } from "./targets.js";

describe("Growth Revert 상태 전이", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it("auto allow는 즉시 되돌리고 review approval은 대기한다", () => {
    expect(decideGrowthRevertTransition({ mode: "auto", authorization: "allow" })).toBe("reverted");
    expect(decideGrowthRevertTransition({ mode: "review", authorization: "require-approval" })).toBe("awaiting-review");
  });

  it("deny와 승인 없는 review 실행을 거부한다", () => {
    expect(() => decideGrowthRevertTransition({ mode: "auto", authorization: "deny" })).toThrow("거부");
    expect(() => decideGrowthRevertTransition({ mode: "review", authorization: "allow" })).toThrow("승인");
  });

  it("degraded auto Revert는 exact before 내용을 새 version으로 만들고 과거 version을 재활성화하지 않는다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "revert@example.com", displayName: "Revert" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    const promptStore = await PromptMemoryStore.create(database, organizations);
    await promptStore.bootstrap(context, bootstrapped.nodes);
    const target = new PromptGrowthTarget(promptStore);
    const before = await database.transaction(
      async (executor) => await target.inspect(context, { suggestionId: "suggestion-revert", patch: {} }, executor),
    );
    const firstSection = (before.snapshot.sections as Array<{ agentHandle: string }>)[0];
    if (!firstSection) throw new Error("Prompt section이 없습니다");
    const adopted = await database.transaction(
      async (executor) =>
        await target.apply(
          context,
          {
            commandId: "prompt-adopt-before-revert",
            suggestionId: "suggestion-revert",
            suggestionRevision: 1,
            patch: { agentHandle: firstSection.agentHandle, instruction: "성능이 나빠진 지시" },
            expectedVersionId: before.versionId,
            expectedChecksum: before.checksum,
            governanceDecisionId: "decision-adopt",
          },
          executor,
        ),
    );
    await applyMigrations(database, [GROWTH_ADOPTION_MIGRATION]);
    await database.query(
      "DEFINE TABLE growth_configuration_version SCHEMALESS; DEFINE TABLE growth_suggestion SCHEMALESS;",
    );
    const registry = new GrowthTargetRegistry({ prompt: target, memory: target, policy: target, organization: target });
    const service = await GrowthRevertService.create(
      database,
      organizations,
      {
        authorizeRevert: async () => ({
          outcome: "allow",
          decision: {
            decisionId: "decision-revert",
            organizationId: context.organizationId,
            requestHash: "d".repeat(64),
            outcome: "allow",
            reasons: [],
            errors: [],
            automationMode: "auto",
            createdAt: new Date(),
          },
        }),
      },
      registry,
    );
    await database.query(
      "CREATE growth_configuration_version CONTENT { configuration_version_id: 'config-auto', organization_id: $organization_id, adoption_mode: 'auto', status: 'active' }; CREATE growth_suggestion CONTENT { suggestion_id: 'suggestion-revert', organization_id: $organization_id, work_id: 'work-revert' }; CREATE growth_adoption_run CONTENT { adoption_id: 'adoption-revert', organization_id: $organization_id, suggestion_id: 'suggestion-revert', target_kind: 'prompt', evaluation_run_id: 'evaluation-revert', evaluation_input_hash: $hash, configuration_version_id: 'config-auto', runtime_execution_id: 'runtime-revert', before_version_id: $before_version_id, before_checksum: $before_checksum, after_version_id: $after_version_id, after_checksum: $after_checksum, governance_decision_id: 'decision-adopt', approval_id: NONE, status: 'observing', command_id: 'adopt-revert', request_hash: $hash, created_by_user_id: $user_id, active_target_guard: $guard, exposure_status: 'active', created_at: time::now(), updated_at: time::now() }; CREATE growth_effect_baseline CONTENT { baseline_id: 'baseline-revert', organization_id: $organization_id, adoption_id: 'adoption-revert', suggestion_id: 'suggestion-revert', target_kind: 'prompt', target_version_id: $after_version_id, status: 'captured', metrics_json: '{}', checksum: $hash, created_at: time::now() }; CREATE growth_effect_observation CONTENT { observation_id: 'observation-revert', organization_id: $organization_id, adoption_id: 'adoption-revert', score: 0.1, observation_count: 10, contract_json: '{}', contract_checksum: $hash, command_id: 'observe-revert', request_hash: $hash, created_at: time::now() }; CREATE growth_effect_evaluation CONTENT { effect_evaluation_id: 'effect-revert', organization_id: $organization_id, adoption_id: 'adoption-revert', baseline_id: 'baseline-revert', observation_id: 'observation-revert', result: 'degraded', comparison_json: '{}', command_id: 'effect-revert', request_hash: $hash, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        user_id: context.userId,
        hash: "a".repeat(64),
        before_version_id: before.versionId,
        before_checksum: before.checksum,
        after_version_id: adopted.after.versionId,
        after_checksum: adopted.after.checksum,
        guard: `${context.organizationId}:prompt`,
      },
    );
    const operation = await service.revert(context, {
      commandId: "revert-auto",
      adoptionId: "adoption-revert",
      suggestionRevision: 1,
      reason: "degraded",
    });

    expect(operation.status).toBe("completed");
    expect(operation.reverted_version_id).not.toBe(before.versionId);
    const active = await promptStore.getActivePromptDefinition(context);
    expect(active.sections).toEqual(before.snapshot.sections);
    const [original] = await database.query<[Array<{ status: string }>]>(
      "SELECT status FROM prompt_definition_version WHERE organization_id = $organization_id AND prompt_definition_version_id = $version_id;",
      { organization_id: context.organizationId, version_id: before.versionId },
    );
    expect(original[0]?.status).toBe("superseded");
  });
});
