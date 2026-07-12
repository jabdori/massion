import type { ConnectorExecutionKind } from "./contracts.js";

export type SubscriptionAuthKind = "oauth" | "device-code" | "api-key" | "subscription-key" | "cli-profile" | "acp";
export type SubscriptionProviderProtocol =
  "openai" | "anthropic" | "gemini" | "acp" | "cli-process" | "codex-app-server" | "claude-agent-sdk";

export interface AgentRuntimeCapabilities {
  readonly minimumVersion?: string;
  readonly accountIsolation: "profile-root" | "single-os-keyring-account";
  readonly output: "structured-stream" | "final-text-only";
  readonly cancellation: "protocol" | "best-effort-process-tree";
  readonly session: "protocol" | "explicit-existing-id-only";
  readonly permissionBridge: "protocol" | "unsupported";
  readonly multipleAccounts: "profile-isolated" | "one-account-per-connector";
  readonly maturity: "contract-tested" | "experimental";
}

export interface SubscriptionProviderManifest {
  readonly id: string;
  readonly displayName: string;
  readonly authKinds: readonly SubscriptionAuthKind[];
  readonly executionKind: ConnectorExecutionKind;
  readonly billingKinds: readonly string[];
  readonly modelDiscovery: "protocol" | "endpoint" | "documented-allowlist" | "command" | "none";
  readonly quotaDiscovery: "headers" | "command" | "endpoint" | "none";
  readonly protocol: SubscriptionProviderProtocol;
  readonly endpointAllowlist: readonly string[];
  readonly officialDocumentation: string;
  readonly availability: "supported" | "experimental" | "requires-provider-approval";
  readonly runtimeCapabilities?: AgentRuntimeCapabilities;
  readonly verified: false;
}

const MANIFESTS = [
  {
    id: "google-gemini-cli-enterprise",
    displayName: "Google Gemini CLI Enterprise",
    authKinds: ["acp", "cli-profile", "api-key"],
    executionKind: "agent-runtime",
    billingKinds: ["enterprise-subscription", "api-usage"],
    modelDiscovery: "protocol",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md",
    availability: "supported",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "structured-stream",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "contract-tested",
    },
    verified: false,
  },
  {
    id: "google-antigravity-cli",
    displayName: "Google Antigravity CLI",
    authKinds: ["cli-profile"],
    executionKind: "agent-runtime",
    billingKinds: ["consumer-subscription"],
    modelDiscovery: "none",
    quotaDiscovery: "none",
    protocol: "cli-process",
    endpointAllowlist: [],
    officialDocumentation: "https://antigravity.google/docs/cli-overview",
    availability: "experimental",
    runtimeCapabilities: {
      minimumVersion: "1.1.1",
      accountIsolation: "single-os-keyring-account",
      output: "final-text-only",
      cancellation: "best-effort-process-tree",
      session: "explicit-existing-id-only",
      permissionBridge: "unsupported",
      multipleAccounts: "one-account-per-connector",
      maturity: "experimental",
    },
    verified: false,
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot ACP",
    authKinds: ["acp", "device-code", "cli-profile"],
    executionKind: "agent-runtime",
    billingKinds: ["consumer-subscription", "organization-subscription"],
    modelDiscovery: "protocol",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
    availability: "supported",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "structured-stream",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "contract-tested",
    },
    verified: false,
  },
  {
    id: "minimax-token-plan",
    displayName: "MiniMax Token Plan",
    authKinds: ["subscription-key"],
    executionKind: "model",
    billingKinds: ["token-plan", "api-credits", "team-seat"],
    modelDiscovery: "endpoint",
    quotaDiscovery: "endpoint",
    protocol: "anthropic",
    endpointAllowlist: ["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"],
    officialDocumentation: "https://platform.minimax.io/docs/token-plan/quickstart",
    availability: "supported",
    verified: false,
  },
  {
    id: "xai-grok-build",
    displayName: "xAI Grok Build",
    authKinds: ["acp", "oauth", "device-code", "cli-profile", "api-key"],
    executionKind: "agent-runtime",
    billingKinds: ["consumer-subscription", "api-usage"],
    modelDiscovery: "protocol",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://docs.x.ai/build/cli/headless-scripting",
    availability: "supported",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "structured-stream",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "contract-tested",
    },
    verified: false,
  },
  {
    id: "xai-api",
    displayName: "xAI API",
    authKinds: ["api-key"],
    executionKind: "model",
    billingKinds: ["api-usage"],
    modelDiscovery: "endpoint",
    quotaDiscovery: "headers",
    protocol: "openai",
    endpointAllowlist: ["https://api.x.ai/v1"],
    officialDocumentation: "https://docs.x.ai/docs/overview",
    availability: "supported",
    verified: false,
  },
  {
    id: "nous-portal",
    displayName: "Nous Portal",
    authKinds: ["api-key"],
    executionKind: "model",
    billingKinds: ["consumer-subscription", "api-credits", "x402"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    protocol: "openai",
    endpointAllowlist: ["https://inference-api.nousresearch.com/v1"],
    officialDocumentation: "https://portal.nousresearch.com/api-docs",
    availability: "supported",
    verified: false,
  },
  {
    id: "zai-coding-plan",
    displayName: "Z.AI GLM Coding Plan",
    authKinds: ["api-key"],
    executionKind: "model",
    billingKinds: ["coding-plan"],
    modelDiscovery: "documented-allowlist",
    quotaDiscovery: "none",
    protocol: "openai",
    endpointAllowlist: ["https://api.z.ai/api/coding/paas/v4"],
    officialDocumentation: "https://docs.z.ai/devpack/quick-start",
    availability: "requires-provider-approval",
    verified: false,
  },
] as const satisfies readonly SubscriptionProviderManifest[];

export type SubscriptionProviderId = (typeof MANIFESTS)[number]["id"];

export function listSubscriptionProviderManifests(): readonly SubscriptionProviderManifest[] {
  return MANIFESTS;
}

export function providerManifest(id: string): SubscriptionProviderManifest {
  const manifest = MANIFESTS.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`구독 Provider manifest를 찾을 수 없습니다: ${id}`);
  return manifest;
}
