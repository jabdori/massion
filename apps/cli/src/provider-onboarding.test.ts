import { cancel, isCancel, select } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectProviderOnboardingAnswers, type ProviderOnboardingOption } from "./provider-onboarding.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  isCancel: vi.fn(),
  select: vi.fn(),
}));

const options: readonly ProviderOnboardingOption[] = [
  { providerId: "openai-codex", displayName: "OpenAI Codex" },
  { providerId: "anthropic-claude-code", displayName: "Anthropic Claude Code" },
];

describe("Provider 온보딩", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("Clack 선택 UI로 Provider를 선택한다", async () => {
    vi.mocked(isCancel).mockReturnValue(false);
    vi.mocked(select).mockResolvedValueOnce("anthropic-claude-code");

    const result = await collectProviderOnboardingAnswers(options);

    expect(result.providerId).toBe("anthropic-claude-code");
    expect(select).toHaveBeenCalledWith({
      message: "연결할 Provider를 선택하세요",
      options: [
        { label: "OpenAI Codex", value: "openai-codex" },
        { label: "Anthropic Claude Code", value: "anthropic-claude-code" },
      ],
    });
  });

  it("선택 취소는 로그인 전에 중단한다", async () => {
    const cancelled = Symbol("cancelled");
    vi.mocked(select).mockResolvedValueOnce(cancelled);
    vi.mocked(isCancel).mockImplementation((value) => value === cancelled);

    await expect(collectProviderOnboardingAnswers(options)).rejects.toMatchObject({ name: "PromptCancelledError" });

    expect(cancel).toHaveBeenCalledWith("Provider 선택을 취소했습니다.");
  });

  it("선택 UI가 알 수 없는 Provider를 반환하면 거부한다", async () => {
    vi.mocked(isCancel).mockReturnValue(false);
    vi.mocked(select).mockResolvedValueOnce("unknown-provider");

    await expect(collectProviderOnboardingAnswers(options)).rejects.toThrow("Provider 선택이 유효하지 않습니다");
  });
});
