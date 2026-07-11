import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { IdentityService, OrganizationService } from "@massion/identity";

import { decideAdoptionTransition, GrowthAdoptionService } from "./adoption.js";
import { applyGrowthPatch, growthTargetChecksum, GrowthTargetRegistry, type GrowthTargetPort } from "./targets.js";
import { GROWTH_ADOPTION_MIGRATION } from "./schema.js";

describe("Growth Adoption 상태 전이", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it("0058 Adoption·event·baseline schema와 checksum을 고정한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    expect(GROWTH_ADOPTION_MIGRATION.id).toBe("0058-growth-adoption");
    expect(GROWTH_ADOPTION_MIGRATION.checksum).toBe("15eb161ce7936c7203c922fb0cabf54ad9a5a8c346e2892750f5ee883efd9445");
    await expect(applyMigrations(database, [GROWTH_ADOPTION_MIGRATION])).resolves.toEqual(["0058-growth-adoption"]);
    for (const table of ["growth_adoption_run", "growth_adoption_event", "growth_effect_baseline"]) {
      await expect(database.query(`INFO FOR TABLE ${table};`)).resolves.toBeDefined();
    }
  });
  it("review는 승인을 기다리고 auto allow는 관찰을 시작한다", () => {
    expect(decideAdoptionTransition({ mode: "review", authorization: "require-approval" })).toBe("awaiting-review");
    expect(decideAdoptionTransition({ mode: "auto", authorization: "allow" })).toBe("observing");
  });

  it("deny와 승인 없는 review 실행을 fail-closed로 거부한다", () => {
    expect(() => decideAdoptionTransition({ mode: "auto", authorization: "deny" })).toThrow("거부");
    expect(() => decideAdoptionTransition({ mode: "review", authorization: "allow" })).toThrow("승인");
  });

  it("target version·Adoption event·baseline을 한 transaction에서 함께 확정한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "adoption@example.com", displayName: "Adoption" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await database.query(
      "DEFINE TABLE growth_configuration_version SCHEMALESS; DEFINE TABLE reflection_run SCHEMALESS; DEFINE TABLE growth_suggestion SCHEMALESS; DEFINE TABLE growth_evaluation_run SCHEMALESS; DEFINE TABLE runtime_execution SCHEMALESS; DEFINE TABLE test_growth_target SCHEMALESS;",
    );
    const beforeSnapshot = { sections: [{ agentHandle: "assurance", instruction: "검증", capabilityReferences: [] }] };
    const beforeChecksum = growthTargetChecksum(beforeSnapshot);
    await database.query(
      "CREATE growth_configuration_version CONTENT { configuration_version_id: 'config-1', organization_id: $organization_id, adoption_mode: 'auto', status: 'active', checksum: $checksum }; CREATE reflection_run CONTENT { reflection_run_id: 'reflection-1', organization_id: $organization_id, configuration_version_id: 'config-1', runtime_execution_id: 'runtime-growth-1' }; CREATE growth_suggestion CONTENT { suggestion_id: 'suggestion-1', organization_id: $organization_id, work_id: 'work-1', reflection_run_id: 'reflection-1', target_kind: 'prompt', operation: 'replace-instruction', patch_json: $patch, status: 'evaluated' }; CREATE growth_evaluation_run CONTENT { evaluation_run_id: 'evaluation-1', organization_id: $organization_id, suggestion_id: 'suggestion-1', input_hash: $input_hash, outcome: 'eligible' }; CREATE runtime_execution CONTENT { organization_id: $organization_id, work_id: 'work-1', execution_id: 'runtime-growth-1', agent_handle: 'growth', status: 'succeeded' }; CREATE test_growth_target CONTENT { organization_id: $organization_id, version_id: 'prompt-v1', revision: 1, checksum: $before_checksum, snapshot_json: $snapshot_json, active: true };",
      {
        organization_id: context.organizationId,
        checksum: "c".repeat(64),
        patch: JSON.stringify({ agentHandle: "assurance", instruction: "검증과 회귀 테스트" }),
        input_hash: "e".repeat(64),
        before_checksum: beforeChecksum,
        snapshot_json: JSON.stringify(beforeSnapshot),
      },
    );

    const target: GrowthTargetPort = {
      inspect: async (_context, _input, executor) => {
        const [rows] = await executor.query<
          [Array<{ version_id: string; revision: number; checksum: string; snapshot_json: string }>]
        >("SELECT * FROM test_growth_target WHERE organization_id = $organization_id AND active = true LIMIT 1;", {
          organization_id: context.organizationId,
        });
        const row = rows[0];
        if (!row) throw new Error("test target이 없습니다");
        return {
          targetKind: "prompt",
          versionId: row.version_id,
          revision: row.revision,
          checksum: row.checksum,
          snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
        };
      },
      validate: async (_context, input, executor) => {
        const current = await target.inspect(context, input, executor);
        if (current.versionId !== input.expectedVersionId || current.checksum !== input.expectedChecksum)
          throw new Error("stale target");
      },
      apply: async (_context, input, executor) => {
        await target.validate(context, input, executor);
        const before = await target.inspect(context, input, executor);
        const snapshot = applyGrowthPatch("prompt", before.snapshot, input.patch);
        const checksum = growthTargetChecksum(snapshot);
        await executor.query(
          "UPDATE test_growth_target SET active = false WHERE organization_id = $organization_id AND active = true; CREATE test_growth_target CONTENT { organization_id: $organization_id, version_id: 'prompt-v2', revision: 2, checksum: $checksum, snapshot_json: $snapshot_json, active: true };",
          { organization_id: context.organizationId, checksum, snapshot_json: JSON.stringify(snapshot) },
        );
        return { before, after: { targetKind: "prompt", versionId: "prompt-v2", revision: 2, checksum, snapshot } };
      },
      revert: async () => {
        throw new Error("not used");
      },
    };
    const service = await GrowthAdoptionService.create(
      database,
      organizations,
      {
        authorizeAdoption: async () => ({
          outcome: "allow",
          decision: {
            decisionId: "decision-1",
            organizationId: context.organizationId,
            requestHash: "a".repeat(64),
            outcome: "allow",
            reasons: [],
            errors: [],
            automationMode: "auto",
            createdAt: new Date(),
          },
        }),
      },
      new GrowthTargetRegistry({ prompt: target, memory: target, policy: target, organization: target }),
    );
    const result = await service.adopt(context, {
      commandId: "adopt-1",
      suggestionId: "suggestion-1",
      suggestionRevision: 1,
      evaluationRunId: "evaluation-1",
      expectedEvaluationInputHash: "e".repeat(64),
      expectedTargetChecksum: beforeChecksum,
    });

    expect(result.adoption.status).toBe("observing");
    expect(result.afterVersionId).toBe("prompt-v2");
    const [events] = await database.query<[unknown[]]>(
      "SELECT * FROM growth_adoption_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const [baselines] = await database.query<[unknown[]]>(
      "SELECT * FROM growth_effect_baseline WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(events).toHaveLength(1);
    expect(baselines).toHaveLength(1);
  });
});
