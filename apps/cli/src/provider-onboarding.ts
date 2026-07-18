import { cancel, isCancel, select } from "@clack/prompts";

import { PromptCancelledError } from "./prompt-cancelled.js";

export interface ProviderOnboardingOption {
  readonly providerId: string;
  readonly displayName: string;
}

export interface ProviderOnboardingAnswers {
  readonly providerId: string;
}

export async function collectProviderOnboardingAnswers(
  options: readonly ProviderOnboardingOption[],
): Promise<ProviderOnboardingAnswers> {
  if (options.length === 0) throw new Error("현재 연결할 수 있는 Provider가 없습니다");
  const selected = await select({
    message: "연결할 Provider를 선택하세요",
    options: options.map((option) => ({ value: option.providerId, label: option.displayName })),
  });
  if (isCancel(selected)) {
    cancel("Provider 선택을 취소했습니다.");
    throw new PromptCancelledError();
  }
  if (!options.some((option) => option.providerId === selected)) {
    throw new Error("Provider 선택이 유효하지 않습니다");
  }
  return { providerId: selected };
}
