import { createInterface, type Interface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

import { defaultLocalEndpoint } from "./local-entrypoint.js";

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

export async function collectOnboardingAnswers(
  question: (prompt: string) => Promise<string>,
  input: { readonly environment?: Readonly<Record<string, string | undefined>> } = {},
): Promise<OnboardingAnswers> {
  const email = required(await question("소유자 이메일: "), "소유자 이메일");
  const displayName = required(await question("표시 이름: "), "표시 이름");
  return { endpoint: defaultLocalEndpoint(input.environment), email, displayName };
}

export function createOnboardingPrompt(
  input: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): { readonly readline: Interface; readonly collect: () => Promise<OnboardingAnswers> } {
  const readline = createInterface({ input: input.input ?? defaultInput, output: input.output ?? defaultOutput });
  return {
    readline,
    collect: async () =>
      await collectOnboardingAnswers((prompt) => readline.question(prompt), {
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }),
  };
}
