import { describe, expect, it } from "vitest";

import { collectProviderOnboardingAnswers, type ProviderOnboardingOption } from "./provider-onboarding.js";

const options: readonly ProviderOnboardingOption[] = [
  { providerId: "openai-codex", displayName: "OpenAI Codex" },
  { providerId: "anthropic-claude-code", displayName: "Anthropic Claude Agent" },
];

describe("Provider 온보딩", () => {
  it("번호로 공급자를 선택한다", async () => {
    const prompts: string[] = [];
    const result = await collectProviderOnboardingAnswers(options, async (prompt) => {
      prompts.push(prompt);
      return "2";
    });

    expect(result.providerId).toBe("anthropic-claude-code");
    expect(prompts[0]).toContain("연결할 Provider 번호");
  });

  it("입력이 비어 있으면 첫 번째 공급자를 선택한다", async () => {
    await expect(collectProviderOnboardingAnswers(options, async () => "")).resolves.toEqual({
      providerId: "openai-codex",
    });
  });

  it("잘못된 번호는 다시 묻지 않고 오류로 종료한다", async () => {
    await expect(collectProviderOnboardingAnswers(options, async () => "3")).rejects.toThrow(
      "Provider 선택 번호가 유효하지 않습니다",
    );
  });
});
