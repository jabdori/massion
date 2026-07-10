import { describe, expect, it } from "vitest";

import { validateGrowthConfigurationInput } from "./contracts.js";

describe("Growth configuration contracts", () => {
  const organizationInput = {
    commandId: "growth-config-1",
    subject: { type: "organization" as const },
    reflectionEnabled: true,
    adoptionMode: "review" as const,
  };

  it("조직 설정의 공개 입력을 허용한다", () => {
    expect(validateGrowthConfigurationInput(organizationInput)).toEqual(organizationInput);
  });

  it("지원하지 않는 자동화 모드와 caller projection을 거부한다", () => {
    expect(() => validateGrowthConfigurationInput({ ...organizationInput, adoptionMode: "full-auto" })).toThrow(
      "review 또는 auto",
    );
    expect(() => validateGrowthConfigurationInput({ ...organizationInput, status: "active" })).toThrow("caller");
  });

  it("사용자 설정에는 비어 있지 않은 사용자 식별자가 필요하다", () => {
    expect(() =>
      validateGrowthConfigurationInput({
        ...organizationInput,
        subject: { type: "user", userId: "" },
      }),
    ).toThrow("사용자 식별자");
  });
});
