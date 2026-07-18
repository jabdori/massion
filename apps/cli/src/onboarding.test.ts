import { cancel, isCancel, text } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectOnboardingAnswers } from "./onboarding.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  isCancel: vi.fn(),
  text: vi.fn(),
}));

describe("interactive onboarding", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("Clack 입력으로 이메일과 표시명을 받아 기본 local endpoint를 반환한다", async () => {
    vi.mocked(isCancel).mockReturnValue(false);
    vi.mocked(text).mockResolvedValueOnce(" owner@example.com ").mockResolvedValueOnce(" Owner ");

    const result = await collectOnboardingAnswers({
      environment: { MASSION_LOCAL_PORT: "17431" },
    });

    expect(result).toEqual({
      endpoint: "http://127.0.0.1:17431",
      email: "owner@example.com",
      displayName: "Owner",
    });
    expect(text).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: "소유자 이메일" }));
    expect(text).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: "표시 이름" }));
  });

  it("Clack 취소는 다음 질문과 초기화 전에 중단한다", async () => {
    const cancelled = Symbol("cancelled");
    vi.mocked(text).mockResolvedValueOnce(cancelled);
    vi.mocked(isCancel).mockImplementation((value) => value === cancelled);

    await expect(collectOnboardingAnswers()).rejects.toMatchObject({ name: "PromptCancelledError" });

    expect(cancel).toHaveBeenCalledWith("온보딩을 취소했습니다.");
    expect(text).toHaveBeenCalledTimes(1);
  });
});
