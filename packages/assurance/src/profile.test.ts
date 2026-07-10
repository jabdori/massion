import { describe, expect, it } from "vitest";

import { selectAssuranceProfile } from "./profile.js";

describe("Assurance profile 합성", () => {
  it("일반 Work에는 acceptance profile만 적용한다", () => {
    const profile = selectAssuranceProfile(["research-report"]);

    expect(profile).toMatchObject({
      profileId: "massion.assurance.acceptance.v1",
      version: "1.0.0",
      allowedExclusionRules: ["cancelled-task-only"],
    });
    expect(profile.criteria.map((criterion) => criterion.key)).toEqual(["profile:acceptance:coverage"]);
  });

  it("code-change가 있으면 software profile과 고정 표준 version을 합성한다", () => {
    const profile = selectAssuranceProfile(["runbook", "code-change"]);

    expect(profile.profileId).toBe("massion.assurance.software-change.v1");
    expect(profile.criteria.map((criterion) => criterion.key)).toEqual([
      "profile:acceptance:coverage",
      "profile:software:correctness",
      "profile:software:security",
      "profile:software:reliability",
      "profile:software:operability",
      "profile:software:supply-chain",
    ]);
    expect(profile.controlVersions).toEqual({
      asvs: "5.0.0",
      aisvs: "1.0",
      slsa: "1.2",
      sarif: "2.1.0-errata-01",
    });
  });
});
