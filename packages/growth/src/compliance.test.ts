import { describe, expect, it } from "vitest";

import { assertGrowthLineageCompliant, type GrowthLineageSnapshot } from "./compliance.js";

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
});
