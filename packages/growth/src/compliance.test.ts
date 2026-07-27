import { describe, expect, it, vi } from "vitest";

import { GrowthComplianceAuditor, assertGrowthLineageCompliant, type GrowthLineageSnapshot } from "./compliance.js";

const valid: GrowthLineageSnapshot = {
  reflectionCompleted: true,
  configurationMatches: true,
  runtimeSucceeded: true,
  evaluationOutcome: "eligible",
  evaluationHashMatches: true,
  governanceScopeMatches: true,
  targetVersionMatches: true,
  baselineMatches: true,
  effectSequenceMatches: true,
  revertSequenceMatches: true,
};

describe("Growth restore compliance", () => {
  it("완전한 계보만 허용한다", () => expect(() => assertGrowthLineageCompliant(valid)).not.toThrow());
  it.each(Object.keys(valid) as Array<keyof GrowthLineageSnapshot>)("%s 변조를 fail-closed로 거부한다", (key) => {
    const corrupted = { ...valid, [key]: key === "evaluationOutcome" ? "blocked" : false } as GrowthLineageSnapshot;
    expect(() => assertGrowthLineageCompliant(corrupted)).toThrow("Growth 준수");
  });

  it("observing adoption의 pending baseline은 before version 기준으로 재시작을 허용한다", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("growth_adoption_run"))
        return [
          [
            {
              adoption_id: "adoption-1",
              organization_id: "organization-1",
              suggestion_id: "suggestion-1",
              target_kind: "prompt",
              configuration_version_id: "configuration-1",
              evaluation_run_id: "evaluation-1",
              evaluation_input_hash: "e".repeat(64),
              runtime_execution_id: "runtime-1",
              before_version_id: "prompt-before",
              before_checksum: "b".repeat(64),
              after_version_id: "prompt-after",
              after_checksum: "a".repeat(64),
              governance_decision_id: "decision-1",
              status: "observing",
            },
          ],
        ];
      if (sql.includes("growth_suggestion")) return [[{ reflection_run_id: "reflection-1" }]];
      if (sql.includes("reflection_run")) return [[{ status: "completed", runtime_execution_id: "runtime-1" }]];
      if (sql.includes("runtime_execution")) return [[{ status: "succeeded", agent_handle: "growth" }]];
      if (sql.includes("growth_configuration_version")) return [[{ checksum: "c".repeat(64), status: "active" }]];
      if (sql.includes("growth_evaluation_run"))
        return [[{ outcome: "eligible", input_hash: "e".repeat(64), suggestion_id: "suggestion-1" }]];
      if (sql.includes("governance_policy_decision"))
        return [[{ action: "growth.adopt", resource_id: "suggestion-1" }]];
      if (sql.includes("growth_effect_baseline")) return [[{ target_version_id: "prompt-before", status: "pending" }]];
      if (sql.includes("growth_effect_evaluation")) return [[]];
      if (sql.includes("prompt_definition_version")) return [[{ checksum: "a".repeat(64) }]];
      return [[]];
    });
    const auditor = new GrowthComplianceAuditor(
      { query } as never,
      { verifyTenantContext: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      auditor.assertDatabaseCompliant({
        userId: "user-1",
        organizationId: "organization-1",
        membershipId: "membership-1",
        role: "owner",
      }),
    ).resolves.toBeUndefined();
  });
});
