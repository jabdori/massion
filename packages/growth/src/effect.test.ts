import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";

import { compareGrowthEffect, GrowthEffectStore, type GrowthEffectSample } from "./effect.js";
import { GROWTH_ADOPTION_MIGRATION, GROWTH_EFFECT_REVERT_MIGRATION } from "./schema.js";

function sample(score: number, caseSetChecksum = "case-v1", observationCount = 10): GrowthEffectSample {
  return {
    score,
    observationCount,
    contract: {
      strategyVersionId: "strategy-v1",
      caseSetChecksum,
      metricSourceId: "assurance-pass-rate",
      metricSourceVersion: "1.0.0",
      unit: "ratio",
      windowChecksum: "window-v1",
      direction: "higher",
      stableTolerance: 0.02,
      degradationThreshold: 0.1,
      minimumObservations: 5,
    },
  };
}

describe("Growth effect comparison", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it("0059 effect·revert migration checksum을 고정한다", () => {
    expect(GROWTH_EFFECT_REVERT_MIGRATION.id).toBe("0059-growth-effect-revert");
    expect(GROWTH_EFFECT_REVERT_MIGRATION.checksum).toBe(
      "e0add5d0ce465fd3dfa759ec8bb63f278bb7e4bb617f7ecc115726bb991b2e57",
    );
  });

  it("동일 계약의 개선·안정·악화를 결정론적으로 분류한다", () => {
    expect(compareGrowthEffect(sample(0.7), sample(0.82))).toMatchObject({ result: "improved" });
    expect(compareGrowthEffect(sample(0.7), sample(0.69))).toMatchObject({ result: "stable" });
    expect(compareGrowthEffect(sample(0.7), sample(0.41))).toMatchObject({ result: "degraded" });
  });

  it("관찰 수가 부족하면 inconclusive이고 다른 측정 계약은 거부한다", () => {
    expect(compareGrowthEffect(sample(0.7), sample(0.8, "case-v1", 2))).toMatchObject({ result: "inconclusive" });
    expect(() => compareGrowthEffect(sample(0.7), sample(0.8, "case-v2"))).toThrow("동일");
    expect(() =>
      compareGrowthEffect(sample(0.7), { ...sample(0.8), contract: { ...sample(0.8).contract, unit: "count" } }),
    ).toThrow("동일");
  });

  it("degraded 관찰을 immutable evidence로 남기고 target 노출을 먼저 중단한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "effect@example.com", displayName: "Effect" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await applyMigrations(database, [GROWTH_ADOPTION_MIGRATION]);
    await database.query(
      "CREATE growth_adoption_run CONTENT { adoption_id: 'adoption-1', organization_id: $organization_id, suggestion_id: 'suggestion-1', target_kind: 'prompt', evaluation_run_id: 'evaluation-1', evaluation_input_hash: $hash, configuration_version_id: 'config-1', runtime_execution_id: 'runtime-1', before_version_id: 'prompt-v1', before_checksum: $hash, after_version_id: 'prompt-v2', after_checksum: $hash, governance_decision_id: 'decision-1', approval_id: NONE, status: 'observing', command_id: 'adopt-1', request_hash: $hash, created_by_user_id: $user_id, active_target_guard: $guard, created_at: time::now(), updated_at: time::now() }; CREATE growth_effect_baseline CONTENT { baseline_id: 'baseline-1', organization_id: $organization_id, adoption_id: 'adoption-1', suggestion_id: 'suggestion-1', target_kind: 'prompt', target_version_id: 'prompt-v2', status: 'pending', metrics_json: '{}', checksum: $hash, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        user_id: context.userId,
        hash: "a".repeat(64),
        guard: `${context.organizationId}:prompt`,
      },
    );
    const store = await GrowthEffectStore.create(database, organizations);
    await store.captureBaseline(context, { commandId: "baseline-1", adoptionId: "adoption-1", sample: sample(0.7) });
    const evaluation = await store.observe(context, {
      commandId: "observe-1",
      adoptionId: "adoption-1",
      sample: sample(0.41),
    });

    expect(evaluation.result).toBe("degraded");
    const [adoptions] = await database.query<[Array<{ exposure_status?: string }>]>(
      "SELECT exposure_status FROM growth_adoption_run WHERE organization_id = $organization_id AND adoption_id = 'adoption-1';",
      { organization_id: context.organizationId },
    );
    expect(adoptions[0]?.exposure_status).toBe("suspended");
    await expect(database.query("DELETE growth_effect_observation;")).rejects.toThrow("immutable");
  });
});
