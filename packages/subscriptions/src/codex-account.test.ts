import { describe, expect, it } from "vitest";

import { CODEX_PLAN_TYPES, isPaidCodexPlanType } from "./codex-account.js";

describe("Codex ChatGPT planType 계약", () => {
  it("설치된 app-server 0.144.1 생성 schema의 정확한 enum에서 free와 unknown만 유료 증명에서 제외한다", () => {
    expect(CODEX_PLAN_TYPES).toEqual([
      "free",
      "go",
      "plus",
      "pro",
      "prolite",
      "team",
      "self_serve_business_usage_based",
      "business",
      "enterprise_cbp_usage_based",
      "enterprise",
      "edu",
      "unknown",
    ]);
    for (const planType of CODEX_PLAN_TYPES) {
      expect(isPaidCodexPlanType(planType)).toBe(planType !== "free" && planType !== "unknown");
    }
    expect(isPaidCodexPlanType(undefined)).toBe(false);
    expect(isPaidCodexPlanType("future-unverified-plan")).toBe(false);
  });
});
