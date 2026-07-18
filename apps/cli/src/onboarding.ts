import { cancel, isCancel, text } from "@clack/prompts";

import { defaultLocalEndpoint } from "./local-entrypoint.js";
import { PromptCancelledError } from "./prompt-cancelled.js";

export interface OnboardingAnswers {
  readonly endpoint: string;
  readonly email: string;
  readonly displayName: string;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}을 입력해 주세요`);
  return normalized;
}

async function askRequired(label: string): Promise<string> {
  const value = await text({
    message: label,
    validate: (candidate) => (candidate?.trim() ? undefined : `${label}을 입력해 주세요`),
  });
  if (isCancel(value)) {
    cancel("온보딩을 취소했습니다.");
    throw new PromptCancelledError();
  }
  return required(value, label);
}

export async function collectOnboardingAnswers(
  input: { readonly environment?: Readonly<Record<string, string | undefined>> } = {},
): Promise<OnboardingAnswers> {
  const email = await askRequired("소유자 이메일");
  const displayName = await askRequired("표시 이름");
  return { endpoint: defaultLocalEndpoint(input.environment), email, displayName };
}
