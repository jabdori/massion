import { describe, expect, it } from "vitest";

import { collectOnboardingAnswers } from "./onboarding.js";

describe("interactive onboarding", () => {
  it("이메일과 표시명을 받아 기본 local endpoint를 반환한다", async () => {
    const answers = ["owner@example.com", "Owner"];
    const result = await collectOnboardingAnswers(async () => answers.shift() ?? "", {
      environment: { MASSION_LOCAL_PORT: "17431" },
    });
    expect(result).toEqual({
      endpoint: "http://127.0.0.1:17431",
      email: "owner@example.com",
      displayName: "Owner",
    });
  });

  it("필수 onboarding 답변이 비어 있으면 중단한다", async () => {
    await expect(collectOnboardingAnswers(async () => "", { environment: {} })).rejects.toThrow(
      "소유자 이메일을 입력해 주세요",
    );
  });
});
