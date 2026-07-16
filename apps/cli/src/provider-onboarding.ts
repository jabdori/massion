import { createInterface, type Interface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

export interface ProviderOnboardingOption {
  readonly providerId: string;
  readonly displayName: string;
}

export interface ProviderOnboardingAnswers {
  readonly providerId: string;
}

function providerNumber(value: string, maximum: number): number {
  const normalized = value.trim();
  if (normalized === "") return 1;
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw new Error("Provider 선택 번호가 유효하지 않습니다");
  const selected = Number(normalized);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error("Provider 선택 번호가 유효하지 않습니다");
  }
  return selected;
}

export async function collectProviderOnboardingAnswers(
  options: readonly ProviderOnboardingOption[],
  question: (prompt: string) => Promise<string>,
): Promise<ProviderOnboardingAnswers> {
  if (options.length === 0) throw new Error("현재 연결할 수 있는 Provider가 없습니다");
  const menu = options
    .map((option, index) => `  ${String(index + 1)}. ${option.displayName} (${option.providerId})`)
    .join("\n");
  const selected = providerNumber(
    await question(`연결할 Provider를 선택하세요.\n${menu}\n연결할 Provider 번호 [1]: `),
    options.length,
  );
  const option = options[selected - 1];
  if (!option) throw new Error("Provider 선택 번호가 유효하지 않습니다");
  return { providerId: option.providerId };
}

export function createProviderOnboardingPrompt(input: {
  readonly options: readonly ProviderOnboardingOption[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}): { readonly readline: Interface; readonly collect: () => Promise<ProviderOnboardingAnswers> } {
  const readline = createInterface({ input: input.input ?? defaultInput, output: input.output ?? defaultOutput });
  return {
    readline,
    collect: async () => await collectProviderOnboardingAnswers(input.options, (prompt) => readline.question(prompt)),
  };
}
