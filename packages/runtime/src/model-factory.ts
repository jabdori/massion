import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { TenantContext } from "@massion/identity";
import {
  type FailureSignal,
  type ModelProvider,
  type ModelRouter,
  type ProviderEndpoint,
  type ProviderService,
  type RouteAttempt,
} from "@massion/router";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const GPT_56_RESPONSES_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export interface ProviderModelSelection {
  readonly provider: ModelProvider;
  readonly endpoint: ProviderEndpoint;
  readonly modelId: string;
  readonly credentialId: string;
  readonly secret: string;
}

export interface ProviderModelBuilder {
  build(selection: ProviderModelSelection): LanguageModel;
}

export interface AcquireModelInput {
  readonly commandId: string;
  readonly routeName: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly stickyKey?: string;
  readonly fallbackFromAttemptId?: string;
}

export interface ModelCompletionUsage {
  readonly commandId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelFailureUsage extends ModelCompletionUsage {
  readonly signal: FailureSignal;
  readonly emittedTokens: number;
}

export interface ModelFailureOutcome {
  readonly status: RouteAttempt["status"];
  readonly failureClass?: string;
  readonly fallbackAllowed: boolean;
}

export interface RoutedModelLease {
  readonly attemptId: string;
  readonly credentialId: string;
  readonly model: LanguageModel;
  complete(usage: ModelCompletionUsage): Promise<RouteAttempt>;
  fail(usage: ModelFailureUsage): Promise<ModelFailureOutcome>;
}

export interface RoutedModelFactory {
  acquire(context: TenantContext, input: AcquireModelInput): Promise<RoutedModelLease>;
}

function isOfficialOpenAiApi(endpoint: ProviderEndpoint): boolean {
  try {
    const href = new URL(endpoint.base_url).href;
    return href === OPENAI_API_BASE_URL || href === `${OPENAI_API_BASE_URL}/`;
  } catch {
    return false;
  }
}

function usesGpt56Responses(selection: ProviderModelSelection): boolean {
  return (
    selection.provider.adapter_kind === "ai-sdk" &&
    isOfficialOpenAiApi(selection.endpoint) &&
    GPT_56_RESPONSES_MODEL_IDS.has(selection.modelId)
  );
}

export class OpenAICompatibleModelBuilder implements ProviderModelBuilder {
  public build(selection: ProviderModelSelection): LanguageModel {
    const root = selection.endpoint.base_url.replace(/\/$/u, "");
    const useResponses = usesGpt56Responses(selection);
    const baseURL = useResponses
      ? OPENAI_API_BASE_URL
      : selection.provider.adapter_kind === "ollama"
        ? `${root}/v1`
        : root;
    const provider = createOpenAI({
      name: selection.provider.provider_id,
      apiKey: selection.secret,
      baseURL,
    });
    return useResponses ? provider.responses(selection.modelId) : provider.chat(selection.modelId);
  }
}

export class MassionModelFactory implements RoutedModelFactory {
  public constructor(
    private readonly router: ModelRouter,
    private readonly providers: ProviderService,
    private readonly builder: ProviderModelBuilder,
  ) {}

  public async acquire(context: TenantContext, input: AcquireModelInput): Promise<RoutedModelLease> {
    const reservation = await this.router
      .reserve(context, {
        commandId: input.commandId,
        routeName: input.routeName,
        estimatedTokens: input.estimatedTokens,
        estimatedCostMicros: input.estimatedCostMicros,
        ...(input.stickyKey ? { stickyKey: input.stickyKey } : {}),
        ...(input.fallbackFromAttemptId ? { fallbackFromAttemptId: input.fallbackFromAttemptId } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("Model Route를 찾을 수 없습니다")) {
          throw new Error(`blocked_model_unavailable: ${input.routeName} Route가 구성되지 않았습니다`, {
            cause: error,
          });
        }
        throw error;
      });
    const endpoint = reservation.endpoint;
    const profile = reservation.profile;
    const credential = reservation.credential;
    if (!endpoint || !profile || !credential) throw new Error("Model reservation 선택 정보가 없습니다");
    if (reservation.material.kind !== "encrypted_secret") {
      throw new Error("Connector session은 구독 Runtime 연결기를 통해 실행해야 합니다");
    }
    const provider = await this.providers.getProvider(context, profile.provider_id);
    const model = this.builder.build({
      provider,
      endpoint,
      modelId: profile.model_id,
      credentialId: credential.credential_id,
      secret: reservation.material.secret,
    });
    const attemptId = reservation.attempt.attempt_id;
    const costFor = (usage: ModelCompletionUsage) =>
      Math.ceil(
        (usage.inputTokens * profile.input_cost_micros_per_million +
          usage.outputTokens * profile.output_cost_micros_per_million) /
          1_000_000,
      );
    return {
      attemptId,
      credentialId: credential.credential_id,
      model,
      complete: async (usage) => {
        const outcome = await this.router.reportSuccess(context, {
          commandId: usage.commandId,
          attemptId,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          actualCostMicros: costFor(usage),
        });
        return outcome.attempt;
      },
      fail: async (usage) => {
        const outcome = await this.router.reportFailure(context, {
          commandId: usage.commandId,
          attemptId,
          signal: usage.signal,
          emittedTokens: usage.emittedTokens,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          actualCostMicros: costFor(usage),
        });
        return {
          status: outcome.attempt.status,
          ...(outcome.attempt.failure_class ? { failureClass: outcome.attempt.failure_class } : {}),
          fallbackAllowed: outcome.attempt.fallback_allowed,
        };
      },
    };
  }
}
