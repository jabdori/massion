import { describe, expect, it } from "vitest";

import { decidePublication } from "./publication-policy.js";

describe("Registry publication policy", () => {
  it("manual은 항상 승인, automatic은 검사 통과 시 자동 공개한다", () => {
    expect(decidePublication({ policy: "manual", assessmentPassed: true, risk: "low", trustChanged: false, permissionsIncreased: false })).toBe("approval-required");
    expect(decidePublication({ policy: "automatic", assessmentPassed: true, risk: "low", trustChanged: false, permissionsIncreased: false })).toBe("publish");
    expect(decidePublication({ policy: "automatic", assessmentPassed: false, risk: "low", trustChanged: false, permissionsIncreased: false })).toBe("blocked");
  });

  it("risk-based는 권한·trust 변경 또는 high risk만 승인을 요구한다", () => {
    expect(decidePublication({ policy: "risk-based", assessmentPassed: true, risk: "low", trustChanged: false, permissionsIncreased: false })).toBe("publish");
    expect(decidePublication({ policy: "risk-based", assessmentPassed: true, risk: "low", trustChanged: false, permissionsIncreased: true })).toBe("approval-required");
    expect(decidePublication({ policy: "risk-based", assessmentPassed: true, risk: "high", trustChanged: false, permissionsIncreased: false })).toBe("approval-required");
  });
});
