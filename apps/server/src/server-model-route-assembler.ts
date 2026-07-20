import type { TenantContext } from "@massion/identity";
import type {
  CredentialPolicy,
  ModelProfile,
  ModelRoute,
  ModelRouter,
  ModelVerificationEvidence,
  RegisterModelVerificationEvidenceInput,
  RouteKind,
} from "@massion/router";
import { codingPlanRouteForModel } from "@massion/subscriptions";

import type { CodexGpt56ModelId, ObservedCodexGpt56Model } from "./codex-subscription-observer.js";
import type { ObservedMiniMaxSubscriptionModel } from "./minimax-subscription-verifier.js";
import type { ObservedZaiCodingPlanModel } from "./zai-coding-plan-subscription-verifier.js";

export interface BuiltinCoreModelRouteContract {
  readonly name:
    | "orchestration-balanced"
    | "planning-quality"
    | "delivery-quality"
    | "assurance-independent"
    | "software-engineering-quality";
  readonly routeKind: RouteKind;
  readonly credentialPolicy: CredentialPolicy;
  readonly dataPolicy: "external-allowed";
  readonly equivalenceGroup: "massion-core-general";
  readonly minEvalScore: number;
  readonly requireTools: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireVision: boolean;
  readonly requireStreaming: boolean;
  readonly maxContextTokens: number;
  readonly requestBudgetMicros: number;
  readonly totalBudgetMicros: number;
}

const CORE_ROUTE_NAMES = [
  "orchestration-balanced",
  "planning-quality",
  "delivery-quality",
  "assurance-independent",
  "software-engineering-quality",
] as const;

export const BUILTIN_CORE_MODEL_ROUTES: readonly BuiltinCoreModelRouteContract[] = CORE_ROUTE_NAMES.map((name) => ({
  name,
  routeKind: "chat",
  credentialPolicy: "adaptive",
  dataPolicy: "external-allowed",
  equivalenceGroup: "massion-core-general",
  minEvalScore: 0.8,
  requireTools: true,
  requireStructuredOutput: false,
  requireVision: false,
  requireStreaming: false,
  maxContextTokens: 200_000,
  requestBudgetMicros: 0,
  totalBudgetMicros: 0,
}));

export interface AssembleBuiltinModelRoutesInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly endpointId: string;
  readonly accountId: string;
  readonly observed: ObservedMiniMaxSubscriptionModel | ObservedZaiCodingPlanModel;
}

export interface AssembledBuiltinModelRoutes {
  readonly modelId: "MiniMax-M2.7" | "glm-5.2" | CodexGpt56ModelId;
  readonly modelProfileId: string;
  readonly routeNames: readonly BuiltinCoreModelRouteContract["name"][];
}

type RouterCommands = Pick<
  ModelRouter,
  | "listModels"
  | "registerModel"
  | "recordModelEvidence"
  | "listModelEvidence"
  | "resolveSubscriptionModelEndpoint"
  | "listRoutes"
  | "createRoute"
  | "listCandidates"
  | "addCandidate"
>;

const MINIMAX_MODEL_ID = "MiniMax-M2.7" as const;
const MINIMAX_PROVIDER_CONTRACT = "https://platform.minimax.io/docs/api-reference/api-overview";
const ZAI_CODING_PLAN_MODEL_ID = "glm-5.2" as const;
const ZAI_CODING_PLAN_PROVIDER_CONTRACT = "https://docs.z.ai/devpack/tool/others";

function miniMaxEvidence(
  accountId: string,
  observed: ObservedMiniMaxSubscriptionModel,
): readonly RegisterModelVerificationEvidenceInput[] {
  return [
    {
      kind: "runtime-availability",
      source: observed.source,
      sourceVersion: "openai-model-list-v1",
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        modelId: observed.modelId,
        availableModelIds: observed.availableModelIds,
        actualAvailable: true,
        bearerAuthenticated: true,
      },
    },
    {
      kind: "provider-capability-contract",
      source: MINIMAX_PROVIDER_CONTRACT,
      sourceVersion: "retrieved-2026-07-12",
      observedAt: observed.observedAt,
      claim: {
        modelId: observed.modelId,
        contextWindow: 204_800,
        tools: true,
        structuredOutput: false,
        vision: false,
        streaming: true,
      },
    },
    {
      kind: "runtime-capability-contract",
      source: "massion:openai-compatible-runtime-contract",
      sourceVersion: "massion-server-1.0.0",
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        modelId: observed.modelId,
        protocol: "openai",
        contextWindow: 204_800,
        tools: true,
        structuredOutput: false,
        vision: false,
        streaming: true,
      },
    },
  ];
}

function currentMiniMaxEvidence(
  evidence: readonly ModelVerificationEvidence[],
  accountId: string,
  observed: ObservedMiniMaxSubscriptionModel,
): boolean {
  const claim = (item: ModelVerificationEvidence): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(item.claim_json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "runtime-availability" &&
        item.source === observed.source &&
        item.subscription_account_id === accountId &&
        value?.modelId === observed.modelId &&
        value.actualAvailable === true &&
        value.bearerAuthenticated === true
      );
    }) &&
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "provider-capability-contract" &&
        item.source === MINIMAX_PROVIDER_CONTRACT &&
        value?.modelId === observed.modelId &&
        value.contextWindow === 204_800 &&
        value.tools === true &&
        value.streaming === true
      );
    }) &&
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "runtime-capability-contract" &&
        item.source === "massion:openai-compatible-runtime-contract" &&
        item.subscription_account_id === accountId &&
        value?.modelId === observed.modelId &&
        value.protocol === "openai"
      );
    })
  );
}

function profileCompatible(profile: ModelProfile, input: AssembleBuiltinModelRoutesInput): boolean {
  return (
    profile.provider_id === input.providerId &&
    profile.endpoint_id === input.endpointId &&
    profile.model_id === MINIMAX_MODEL_ID &&
    profile.route_kind === "chat" &&
    profile.context_window >= 204_800 &&
    profile.supports_tools &&
    !profile.supports_vision &&
    profile.supports_streaming &&
    profile.equivalence_group === "massion-core-general" &&
    profile.eval_score >= 1 &&
    profile.input_cost_micros_per_million === 0 &&
    profile.output_cost_micros_per_million === 0 &&
    profile.verified &&
    profile.enabled
  );
}

function zaiCodingPlanEvidence(
  accountId: string,
  observed: ObservedZaiCodingPlanModel,
): readonly RegisterModelVerificationEvidenceInput[] {
  return [
    {
      kind: "runtime-availability",
      source: observed.source,
      sourceVersion: "openai-chat-completion-v1",
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        modelId: observed.modelId,
        actualAvailable: true,
        bearerAuthenticated: true,
      },
    },
    {
      kind: "provider-capability-contract",
      source: ZAI_CODING_PLAN_PROVIDER_CONTRACT,
      sourceVersion: "retrieved-2026-07-20",
      observedAt: observed.observedAt,
      claim: {
        modelId: observed.modelId,
        contextWindow: 1_000_000,
        tools: true,
        structuredOutput: false,
        vision: false,
        streaming: true,
      },
    },
    {
      kind: "runtime-capability-contract",
      source: "massion:openai-compatible-runtime-contract",
      sourceVersion: "massion-server-1.0.0",
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        modelId: observed.modelId,
        protocol: "openai",
        contextWindow: 1_000_000,
        tools: true,
        structuredOutput: false,
        vision: false,
        streaming: true,
      },
    },
  ];
}

function currentZaiCodingPlanEvidence(
  evidence: readonly ModelVerificationEvidence[],
  accountId: string,
  observed: ObservedZaiCodingPlanModel,
): boolean {
  const claim = (item: ModelVerificationEvidence): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(item.claim_json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "runtime-availability" &&
        item.source === observed.source &&
        item.subscription_account_id === accountId &&
        value?.modelId === observed.modelId &&
        value.actualAvailable === true &&
        value.bearerAuthenticated === true
      );
    }) &&
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "provider-capability-contract" &&
        item.source === ZAI_CODING_PLAN_PROVIDER_CONTRACT &&
        value?.modelId === observed.modelId &&
        value.contextWindow === 1_000_000 &&
        value.tools === true &&
        value.streaming === true
      );
    }) &&
    evidence.some((item) => {
      const value = claim(item);
      return (
        item.evidence_kind === "runtime-capability-contract" &&
        item.source === "massion:openai-compatible-runtime-contract" &&
        item.subscription_account_id === accountId &&
        value?.modelId === observed.modelId &&
        value.protocol === "openai"
      );
    })
  );
}

function zaiCodingPlanProfileCompatible(profile: ModelProfile, input: AssembleBuiltinModelRoutesInput): boolean {
  return (
    profile.provider_id === input.providerId &&
    profile.endpoint_id === input.endpointId &&
    profile.model_id === ZAI_CODING_PLAN_MODEL_ID &&
    profile.route_kind === "chat" &&
    profile.context_window >= 1_000_000 &&
    profile.supports_tools &&
    !profile.supports_vision &&
    profile.supports_streaming &&
    profile.equivalence_group === "massion-core-general" &&
    profile.eval_score >= 1 &&
    profile.input_cost_micros_per_million === 0 &&
    profile.output_cost_micros_per_million === 0 &&
    profile.verified &&
    profile.enabled
  );
}

function routeCompatible(route: ModelRoute, contract: BuiltinCoreModelRouteContract, profile: ModelProfile): boolean {
  return (
    route.enabled &&
    route.name === contract.name &&
    route.route_kind === profile.route_kind &&
    route.data_policy === "external-allowed" &&
    route.equivalence_group === profile.equivalence_group &&
    route.min_eval_score <= profile.eval_score &&
    route.max_context_tokens <= profile.context_window &&
    (!route.require_tools || profile.supports_tools) &&
    (!route.require_structured_output || profile.supports_structured_output) &&
    (!route.require_vision || profile.supports_vision) &&
    (!route.require_streaming || profile.supports_streaming)
  );
}

function codexProfileCompatible(
  profile: ModelProfile,
  input: { readonly endpointId: string; readonly observed: ObservedCodexGpt56Model },
): boolean {
  return (
    profile.provider_id === "openai-codex" &&
    profile.endpoint_id === input.endpointId &&
    profile.model_id === input.observed.modelId &&
    profile.route_kind === "chat" &&
    profile.context_window === 1_050_000 &&
    profile.supports_tools &&
    profile.supports_structured_output &&
    !profile.supports_vision &&
    !profile.supports_streaming &&
    profile.equivalence_group === "massion-core-general" &&
    profile.eval_score >= 1 &&
    profile.input_cost_micros_per_million === 0 &&
    profile.output_cost_micros_per_million === 0 &&
    profile.verified &&
    profile.enabled
  );
}

function officialCodexModelSource(modelId: CodexGpt56ModelId): string {
  return modelId === "gpt-5.6"
    ? "https://developers.openai.com/api/docs/guides/latest-model"
    : `https://developers.openai.com/api/docs/models/${modelId}`;
}

function codexEvidence(
  accountId: string,
  observed: ObservedCodexGpt56Model,
): readonly RegisterModelVerificationEvidenceInput[] {
  return [
    {
      kind: "runtime-availability",
      source: "codex-app-server:model/list",
      sourceVersion: observed.runtimeVersion,
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        modelId: observed.modelId,
        catalogId: observed.catalogId,
        hidden: observed.hidden,
        isDefault: observed.isDefault,
        inputModalities: observed.inputModalities,
        actualAvailable: true,
      },
    },
    {
      kind: "provider-capability-contract",
      source: officialCodexModelSource(observed.modelId),
      sourceVersion: "retrieved-2026-07-12",
      observedAt: observed.observedAt,
      claim: {
        contextWindow: 1_050_000,
        tools: true,
        structuredOutput: true,
        vision: true,
        streaming: true,
      },
    },
    {
      kind: "runtime-capability-contract",
      source: "massion:bundled-codex-runtime-attestation",
      sourceVersion: observed.runtimeVersion,
      observedAt: observed.observedAt,
      subscriptionAccountId: accountId,
      claim: {
        runtimeArtifactDigest: observed.runtimeArtifactDigest,
        agentRuntime: true,
        protocol: "codex-app-server",
        contextWindow: 1_050_000,
        tools: true,
        structuredOutput: true,
        vision: false,
        streaming: false,
      },
    },
  ];
}

function currentCodexEvidence(
  evidence: readonly ModelVerificationEvidence[],
  accountId: string,
  observed: ObservedCodexGpt56Model,
): boolean {
  const matching = evidence.filter((item) => item.subscription_account_id === accountId);
  const hasClaim = (
    candidates: readonly ModelVerificationEvidence[],
    kind: ModelVerificationEvidence["evidence_kind"],
    matches: (claim: Record<string, unknown>) => boolean,
  ): boolean =>
    candidates.some((item) => {
      if (item.evidence_kind !== kind) return false;
      try {
        const claim = JSON.parse(item.claim_json) as unknown;
        return Boolean(
          claim && typeof claim === "object" && !Array.isArray(claim) && matches(claim as Record<string, unknown>),
        );
      } catch {
        return false;
      }
    });
  return (
    hasClaim(
      matching,
      "runtime-availability",
      (claim) => claim.modelId === observed.modelId && claim.actualAvailable === true,
    ) &&
    hasClaim(
      matching,
      "runtime-capability-contract",
      (claim) =>
        claim.runtimeArtifactDigest === observed.runtimeArtifactDigest &&
        claim.agentRuntime === true &&
        claim.vision === false &&
        claim.streaming === false,
    ) &&
    hasClaim(
      evidence.filter((item) => item.source === officialCodexModelSource(observed.modelId)),
      "provider-capability-contract",
      (claim) =>
        claim.contextWindow === 1_050_000 &&
        claim.tools === true &&
        claim.structuredOutput === true &&
        claim.vision === true &&
        claim.streaming === true,
    )
  );
}

export class BuiltinModelRouteAssembler {
  public constructor(private readonly router: RouterCommands) {}

  public async assemble(
    context: TenantContext,
    input: AssembleBuiltinModelRoutesInput,
  ): Promise<AssembledBuiltinModelRoutes> {
    if (input.providerId === "zai-coding-plan") return await this.assembleZaiCodingPlan(context, input);
    if (input.providerId !== "minimax-token-plan") {
      throw new Error("현재 내장 Core model route 조립은 MiniMax Token Plan 또는 Z.AI Coding Plan만 지원합니다");
    }
    if (
      !("availableModelIds" in input.observed) ||
      input.observed.modelId !== MINIMAX_MODEL_ID ||
      !input.observed.availableModelIds.includes(MINIMAX_MODEL_ID)
    ) {
      throw new Error("MiniMax Core model의 실인증 관측 계보가 일치하지 않습니다");
    }
    const observed = input.observed;
    const officialRoute = codingPlanRouteForModel(input.providerId, MINIMAX_MODEL_ID);
    if (officialRoute.protocol !== "openai" || officialRoute.baseUrl !== "https://api.minimax.io/v1") {
      throw new Error("MiniMax Core model의 공식 OpenAI route 계보가 일치하지 않습니다");
    }

    const matchingProfiles = (await this.router.listModels(context)).filter(
      (profile) =>
        profile.provider_id === input.providerId &&
        profile.endpoint_id === input.endpointId &&
        profile.model_id === MINIMAX_MODEL_ID,
    );
    if (matchingProfiles.length > 1) throw new Error("MiniMax Core model profile 계보가 하나로 확정되지 않았습니다");
    let profile = matchingProfiles[0];
    if (profile && !profileCompatible(profile, input)) {
      throw new Error("기존 MiniMax Core model profile 계약이 충돌합니다");
    }
    const verificationEvidence = miniMaxEvidence(input.accountId, observed);
    if (!profile) {
      profile = (
        await this.router.registerModel(context, {
          commandId: `${input.commandId}:model-profile`,
          providerId: input.providerId,
          endpointId: input.endpointId,
          modelId: MINIMAX_MODEL_ID,
          routeKind: "chat",
          contextWindow: 204_800,
          supportsTools: true,
          supportsStructuredOutput: false,
          supportsVision: false,
          supportsStreaming: true,
          equivalenceGroup: "massion-core-general",
          evalScore: 1,
          inputCostMicrosPerMillion: 0,
          outputCostMicrosPerMillion: 0,
          verified: true,
          verificationEvidence,
        })
      ).profile;
    } else {
      const existingEvidence = await this.router.listModelEvidence(context, profile.model_profile_id);
      if (!currentMiniMaxEvidence(existingEvidence, input.accountId, observed)) {
        await this.router.recordModelEvidence(context, {
          commandId: `${input.commandId}:model-evidence`,
          modelProfileId: profile.model_profile_id,
          verificationEvidence,
        });
      }
    }
    if (!profileCompatible(profile, input))
      throw new Error("생성된 MiniMax Core model profile 계약이 일치하지 않습니다");

    await this.assembleCoreRoutes(context, input.commandId, profile);

    return {
      modelId: MINIMAX_MODEL_ID,
      modelProfileId: profile.model_profile_id,
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
    };
  }

  private async assembleZaiCodingPlan(
    context: TenantContext,
    input: AssembleBuiltinModelRoutesInput,
  ): Promise<AssembledBuiltinModelRoutes> {
    if ("availableModelIds" in input.observed || input.observed.modelId !== ZAI_CODING_PLAN_MODEL_ID) {
      throw new Error("Z.AI GLM-5.2 Core model의 실인증 관측 계보가 일치하지 않습니다");
    }
    const observed = input.observed;
    const officialRoute = codingPlanRouteForModel(input.providerId, ZAI_CODING_PLAN_MODEL_ID);
    if (officialRoute.protocol !== "openai" || officialRoute.baseUrl !== "https://api.z.ai/api/coding/paas/v4") {
      throw new Error("Z.AI GLM-5.2 Core model의 공식 OpenAI route 계보가 일치하지 않습니다");
    }

    const matchingProfiles = (await this.router.listModels(context)).filter(
      (profile) =>
        profile.provider_id === input.providerId &&
        profile.endpoint_id === input.endpointId &&
        profile.model_id === ZAI_CODING_PLAN_MODEL_ID,
    );
    if (matchingProfiles.length > 1) throw new Error("Z.AI GLM-5.2 Core model profile 계보가 하나로 확정되지 않았습니다");
    let profile = matchingProfiles[0];
    if (profile && !zaiCodingPlanProfileCompatible(profile, input)) {
      throw new Error("기존 Z.AI GLM-5.2 Core model profile 계약이 충돌합니다");
    }
    const verificationEvidence = zaiCodingPlanEvidence(input.accountId, observed);
    if (!profile) {
      profile = (
        await this.router.registerModel(context, {
          commandId: `${input.commandId}:model-profile`,
          providerId: input.providerId,
          endpointId: input.endpointId,
          modelId: ZAI_CODING_PLAN_MODEL_ID,
          routeKind: "chat",
          contextWindow: 1_000_000,
          supportsTools: true,
          supportsStructuredOutput: false,
          supportsVision: false,
          supportsStreaming: true,
          equivalenceGroup: "massion-core-general",
          evalScore: 1,
          inputCostMicrosPerMillion: 0,
          outputCostMicrosPerMillion: 0,
          verified: true,
          verificationEvidence,
        })
      ).profile;
    } else {
      const existingEvidence = await this.router.listModelEvidence(context, profile.model_profile_id);
      if (!currentZaiCodingPlanEvidence(existingEvidence, input.accountId, observed)) {
        await this.router.recordModelEvidence(context, {
          commandId: `${input.commandId}:model-evidence`,
          modelProfileId: profile.model_profile_id,
          verificationEvidence,
        });
      }
    }
    if (!zaiCodingPlanProfileCompatible(profile, input)) {
      throw new Error("생성된 Z.AI GLM-5.2 Core model profile 계약이 일치하지 않습니다");
    }

    await this.assembleCoreRoutes(context, input.commandId, profile);
    return {
      modelId: ZAI_CODING_PLAN_MODEL_ID,
      modelProfileId: profile.model_profile_id,
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
    };
  }

  public async assembleCodex(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly accountId: string;
      readonly observed: ObservedCodexGpt56Model;
    },
  ): Promise<AssembledBuiltinModelRoutes> {
    const endpointId = await this.router.resolveSubscriptionModelEndpoint(context, input.accountId, "openai-codex");
    const matchingProfiles = (await this.router.listModels(context)).filter(
      (profile) =>
        profile.provider_id === "openai-codex" &&
        profile.endpoint_id === endpointId &&
        profile.model_id === input.observed.modelId,
    );
    if (matchingProfiles.length > 1) throw new Error("Codex GPT-5.6 model profile 계보가 하나로 확정되지 않았습니다");
    let profile = matchingProfiles[0];
    if (profile && !codexProfileCompatible(profile, { endpointId, observed: input.observed })) {
      throw new Error("기존 Codex GPT-5.6 model profile 계약이 충돌합니다");
    }
    const verificationEvidence = codexEvidence(input.accountId, input.observed);
    if (!profile) {
      profile = (
        await this.router.registerModel(context, {
          commandId: `${input.commandId}:model-profile`,
          providerId: "openai-codex",
          endpointId,
          modelId: input.observed.modelId,
          routeKind: "chat",
          contextWindow: 1_050_000,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsVision: false,
          supportsStreaming: false,
          equivalenceGroup: "massion-core-general",
          evalScore: 1,
          inputCostMicrosPerMillion: 0,
          outputCostMicrosPerMillion: 0,
          verified: true,
          verificationEvidence,
        })
      ).profile;
    } else {
      const existingEvidence = await this.router.listModelEvidence(context, profile.model_profile_id);
      if (!currentCodexEvidence(existingEvidence, input.accountId, input.observed)) {
        await this.router.recordModelEvidence(context, {
          commandId: `${input.commandId}:model-evidence`,
          modelProfileId: profile.model_profile_id,
          verificationEvidence,
        });
      }
    }
    if (!codexProfileCompatible(profile, { endpointId, observed: input.observed })) {
      throw new Error("생성된 Codex GPT-5.6 model profile 계약이 일치하지 않습니다");
    }
    await this.assembleCoreRoutes(context, input.commandId, profile);

    return {
      modelId: input.observed.modelId,
      modelProfileId: profile.model_profile_id,
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
    };
  }

  private async assembleCoreRoutes(context: TenantContext, commandId: string, profile: ModelProfile): Promise<void> {
    const existingRoutes = await this.router.listRoutes(context);
    for (const [index, contract] of BUILTIN_CORE_MODEL_ROUTES.entries()) {
      const matchingRoutes = existingRoutes.filter((route) => route.name === contract.name);
      if (matchingRoutes.length > 1) throw new Error(`Core model route 계보가 중복됐습니다: ${contract.name}`);
      let route = matchingRoutes[0];
      if (route && !routeCompatible(route, contract, profile)) {
        throw new Error(`기존 Core model route 계약이 충돌합니다: ${contract.name}`);
      }
      if (!route) {
        route = (
          await this.router.createRoute(context, {
            commandId: `${commandId}:core-route:${String(index)}`,
            ...contract,
          })
        ).route;
      }
      if (!routeCompatible(route, contract, profile)) {
        throw new Error(`생성된 Core model route 계약이 일치하지 않습니다: ${contract.name}`);
      }
      const candidates = await this.router.listCandidates(context, route.route_id);
      const matchingCandidates = candidates.filter(
        (candidate) => candidate.model_profile_id === profile.model_profile_id && candidate.enabled,
      );
      if (matchingCandidates.length > 1) {
        throw new Error(`Core model route candidate 계보가 중복됐습니다: ${contract.name}`);
      }
      if (matchingCandidates.length === 0) {
        await this.router.addCandidate(context, {
          commandId: `${commandId}:core-candidate:${String(index)}`,
          routeId: route.route_id,
          modelProfileId: profile.model_profile_id,
          priority: 1,
        });
      }
    }
  }
}
