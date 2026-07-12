export type CodingPlanAuthKind = "api-key" | "subscription-key";

export type CodingPlanBillingKind =
  | "coding-plan"
  | "membership-subscription"
  | "step-plan"
  | "go-subscription"
  | "token-plan"
  | "api-credits"
  | "pay-as-you-go"
  | "byok"
  | "credit-subscription"
  | "team-seat";

export interface CodingPlanRoute {
  readonly protocol: "openai" | "anthropic";
  readonly baseUrl: string;
  /**
   * 제공자가 모델별 protocol을 고정해 공개한 경우에만 선언합니다.
   * 목록에 없는 모델은 protocol이 검증될 때까지 활성화하지 않습니다.
   */
  readonly modelIds?: readonly string[];
}

export interface CodingPlanPreset {
  readonly id: string;
  readonly displayName: string;
  readonly connectionSurface: "server-only" | "unavailable";
  readonly authKinds: readonly CodingPlanAuthKind[];
  readonly routes: readonly CodingPlanRoute[];
  readonly billingKinds: readonly CodingPlanBillingKind[];
  readonly modelDiscovery: "endpoint" | "documented-allowlist" | "none";
  readonly modelDiscoveryEndpoint?: string;
  readonly quotaDiscovery: "endpoint" | "command" | "none";
  readonly quotaEndpoint?: string;
  readonly accountPolicy: "standard" | "no-quota-circumvention";
  readonly usageScope: "interactive-coding" | "agent-api" | "api-gateway";
  readonly availability: "supported" | "requires-provider-approval";
  readonly requiresAuthentication: true;
  readonly blockedModelIdSuffixes: readonly string[];
  readonly officialDocumentation: string;
  readonly verified: false;
}

const OPENCODE_OPENAI_MODELS = [
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
] as const;

const OPENCODE_ANTHROPIC_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
] as const;

const ZAI_CODING_MODELS = ["glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.5-air"] as const;
const KIMI_CODING_MODELS = ["kimi-for-coding", "kimi-for-coding-highspeed"] as const;
const STEPFUN_STEP_MODELS = ["step-3.7-flash", "step-3.5-flash-2603", "step-3.5-flash"] as const;
const ALIBABA_CODING_MODELS = [
  "qwen3.7-plus",
  "qwen3.6-plus",
  "kimi-k2.5",
  "glm-5",
  "MiniMax-M2.5",
  "qwen3.5-plus",
  "qwen3-max-2026-01-23",
  "qwen3-coder-next",
  "qwen3-coder-plus",
  "glm-4.7",
] as const;

export const MINIMAX_OPENAI_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
] as const;

const PRESETS = [
  {
    id: "zai-coding-plan",
    displayName: "Z.AI GLM Coding Plan",
    connectionSurface: "unavailable",
    authKinds: ["api-key"],
    routes: [{ protocol: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4", modelIds: ZAI_CODING_MODELS }],
    billingKinds: ["coding-plan"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    accountPolicy: "standard",
    usageScope: "interactive-coding",
    availability: "requires-provider-approval",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [],
    officialDocumentation: "https://docs.z.ai/devpack/quick-start",
    verified: false,
  },
  {
    id: "kimi-coding-plan",
    displayName: "Kimi Code",
    connectionSurface: "unavailable",
    authKinds: ["api-key"],
    routes: [{ protocol: "openai", baseUrl: "https://api.kimi.com/coding/v1", modelIds: KIMI_CODING_MODELS }],
    billingKinds: ["membership-subscription"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    accountPolicy: "standard",
    usageScope: "interactive-coding",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [],
    officialDocumentation: "https://www.kimi.com/code/docs/en/",
    verified: false,
  },
  {
    id: "stepfun-step-plan",
    displayName: "StepFun Step Plan",
    connectionSurface: "unavailable",
    authKinds: ["api-key"],
    routes: [{ protocol: "openai", baseUrl: "https://api.stepfun.ai/step_plan/v1", modelIds: STEPFUN_STEP_MODELS }],
    billingKinds: ["step-plan"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    accountPolicy: "no-quota-circumvention",
    usageScope: "interactive-coding",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [],
    officialDocumentation: "https://platform.stepfun.ai/docs/en/step-plan/quick-start",
    verified: false,
  },
  {
    id: "alibaba-coding-plan",
    displayName: "Alibaba Cloud Coding Plan",
    connectionSurface: "unavailable",
    authKinds: ["subscription-key"],
    routes: [
      {
        protocol: "openai",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
        modelIds: ALIBABA_CODING_MODELS,
      },
    ],
    billingKinds: ["coding-plan"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    accountPolicy: "standard",
    usageScope: "interactive-coding",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [],
    officialDocumentation: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
    verified: false,
  },
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    connectionSurface: "unavailable",
    authKinds: ["api-key"],
    routes: [
      {
        protocol: "openai",
        baseUrl: "https://opencode.ai/zen/go/v1",
        modelIds: OPENCODE_OPENAI_MODELS,
      },
      {
        protocol: "anthropic",
        baseUrl: "https://opencode.ai/zen/go/v1",
        modelIds: OPENCODE_ANTHROPIC_MODELS,
      },
    ],
    billingKinds: ["go-subscription"],
    modelDiscovery: "endpoint",
    modelDiscoveryEndpoint: "https://opencode.ai/zen/go/v1/models",
    quotaDiscovery: "none",
    accountPolicy: "standard",
    usageScope: "agent-api",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [":free"],
    officialDocumentation: "https://opencode.ai/docs/go/",
    verified: false,
  },
  {
    id: "minimax-token-plan",
    displayName: "MiniMax Token Plan",
    connectionSurface: "server-only",
    authKinds: ["subscription-key"],
    routes: [
      { protocol: "anthropic", baseUrl: "https://api.minimax.io/anthropic" },
      { protocol: "openai", baseUrl: "https://api.minimax.io/v1", modelIds: MINIMAX_OPENAI_MODELS },
    ],
    billingKinds: ["token-plan", "api-credits", "team-seat"],
    modelDiscovery: "endpoint",
    modelDiscoveryEndpoint: "https://api.minimax.io/v1/models",
    quotaDiscovery: "endpoint",
    quotaEndpoint: "https://www.minimax.io/v1/token_plan/remains",
    accountPolicy: "standard",
    usageScope: "agent-api",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [],
    officialDocumentation: "https://platform.minimax.io/docs/token-plan/quickstart",
    verified: false,
  },
  {
    id: "kilo-gateway",
    displayName: "Kilo AI Gateway",
    connectionSurface: "unavailable",
    authKinds: ["api-key"],
    routes: [{ protocol: "openai", baseUrl: "https://api.kilo.ai/api/gateway" }],
    billingKinds: ["api-credits", "pay-as-you-go", "byok", "credit-subscription"],
    modelDiscovery: "endpoint",
    modelDiscoveryEndpoint: "https://api.kilo.ai/api/gateway/models",
    quotaDiscovery: "none",
    accountPolicy: "standard",
    usageScope: "api-gateway",
    availability: "supported",
    requiresAuthentication: true,
    blockedModelIdSuffixes: [":free"],
    officialDocumentation: "https://kilo.ai/docs/gateway/api-reference",
    verified: false,
  },
] as const satisfies readonly CodingPlanPreset[];

export function listCodingPlanPresets(): readonly CodingPlanPreset[] {
  return PRESETS;
}

export function codingPlanPreset(id: string): CodingPlanPreset {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Coding Plan preset을 찾을 수 없습니다: ${id}`);
  return preset;
}

export function codingPlanRouteForModel(id: string, modelId: string): CodingPlanRoute {
  const preset = codingPlanPreset(id);
  const explicitlyMappedRoutes = preset.routes.filter((route) => route.modelIds !== undefined);
  if (explicitlyMappedRoutes.length === 0) {
    const onlyRoute = preset.routes[0];
    if (preset.routes.length === 1 && onlyRoute) return onlyRoute;
    throw new Error(`모델 ${modelId}에 대한 검증된 route를 찾을 수 없습니다`);
  }
  const route = explicitlyMappedRoutes.find((candidate) => candidate.modelIds?.includes(modelId));
  if (!route) throw new Error(`모델 ${modelId}에 대한 검증된 route를 찾을 수 없습니다`);
  return route;
}

export interface VerifiedCodingPlanPreset extends Omit<CodingPlanPreset, "verified"> {
  readonly verified: true;
  readonly modelIds: readonly string[];
  readonly capabilities: readonly string[];
}

export type CodingPlanCapabilityProbe = (endpoint: string) => Promise<{
  readonly endpoint: string;
  readonly modelIds: readonly string[];
  readonly capabilities: readonly string[];
}>;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/u, "");
}

export async function verifyCodingPlanPreset(
  id: string,
  probe: CodingPlanCapabilityProbe,
): Promise<VerifiedCodingPlanPreset> {
  const preset = codingPlanPreset(id);
  if (!preset.modelDiscoveryEndpoint) {
    throw new Error("공식 model discovery endpoint가 없는 Coding Plan입니다");
  }
  const result = await probe(preset.modelDiscoveryEndpoint);
  if (normalizeEndpoint(result.endpoint) !== normalizeEndpoint(preset.modelDiscoveryEndpoint)) {
    throw new Error("Coding Plan capability probe endpoint가 preset과 일치하지 않습니다");
  }
  const blockedSuffixes = preset.blockedModelIdSuffixes;
  const documentedModelIds = new Set(preset.routes.flatMap((route) => route.modelIds ?? []));
  const enforceDocumentedRoutes = documentedModelIds.size > 0;
  const modelIds = [...new Set(result.modelIds)].filter(
    (modelId) =>
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(modelId) &&
      !blockedSuffixes.some((suffix) => modelId.endsWith(suffix)) &&
      (!enforceDocumentedRoutes || documentedModelIds.has(modelId)),
  );
  const capabilities = [...new Set(result.capabilities)].filter((capability) =>
    ["chat", "tools", "structured-output", "streaming", "vision"].includes(capability),
  );
  if (modelIds.length === 0 || !capabilities.includes("chat")) {
    throw new Error("Coding Plan capability probe 결과가 충분하지 않습니다");
  }
  return { ...preset, verified: true, modelIds: modelIds.sort(), capabilities: capabilities.sort() };
}
