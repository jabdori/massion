import type { ConnectorExecutionKind, ConnectorLocation } from "./contracts.js";

export type SubscriptionAuthKind = "oauth" | "device-code" | "api-key" | "subscription-key" | "cli-profile" | "acp";
export type SubscriptionProviderProtocol =
  "openai" | "anthropic" | "gemini" | "acp" | "cli-process" | "codex-app-server" | "claude-agent-sdk";
export type AgentApprovalMode = "automatic" | "review" | "deny";

export interface AgentRuntimeCapabilities {
  readonly minimumVersion?: string;
  readonly accountIsolation: "profile-root" | "single-os-keyring-account";
  readonly output: "structured-stream" | "final-text-only";
  readonly cancellation: "protocol" | "best-effort-process-tree";
  readonly session: "protocol" | "explicit-existing-id-only";
  readonly permissionBridge: "protocol" | "unsupported";
  readonly multipleAccounts: "profile-isolated" | "one-account-per-connector";
  readonly maturity: "contract-tested" | "experimental";
  /** 모든 공개 연결 표면에서 공통으로 지원하는 승인 방식입니다. */
  readonly approvalModes?: readonly AgentApprovalMode[];
  /** 서버와 Edge 실행 표면별로 실제 지원하는 승인 방식입니다. */
  readonly approvalModesBySurface?: Readonly<Partial<Record<ConnectorLocation, readonly AgentApprovalMode[]>>>;
}

export interface SubscriptionProviderManifest {
  readonly id: string;
  readonly displayName: string;
  readonly authKinds: readonly SubscriptionAuthKind[];
  readonly executionKind: ConnectorExecutionKind;
  readonly connectionSurface: "server-and-edge" | "server-only" | "edge-only" | "unavailable";
  readonly billingKinds: readonly string[];
  readonly modelDiscovery: "protocol" | "endpoint" | "documented-allowlist" | "command" | "none";
  readonly quotaDiscovery: "protocol" | "headers" | "command" | "endpoint" | "none";
  readonly protocol: SubscriptionProviderProtocol;
  readonly endpointAllowlist: readonly string[];
  readonly officialDocumentation: string;
  readonly availability: "supported" | "experimental" | "requires-provider-approval";
  readonly runtimeCapabilities?: AgentRuntimeCapabilities;
  readonly verified: false;
}

const MANIFESTS = [
  {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    authKinds: ["device-code", "cli-profile", "api-key"],
    executionKind: "agent-runtime",
    connectionSurface: "server-and-edge",
    billingKinds: ["consumer-subscription", "api-usage"],
    modelDiscovery: "protocol",
    quotaDiscovery: "protocol",
    protocol: "codex-app-server",
    endpointAllowlist: [],
    officialDocumentation: "https://developers.openai.com/codex/auth",
    availability: "supported",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "final-text-only",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "contract-tested",
      approvalModes: ["automatic", "deny"],
      approvalModesBySurface: {
        server: ["automatic", "review", "deny"],
        edge: ["automatic", "deny"],
      },
    },
    verified: false,
  },
  {
    id: "anthropic-claude-code",
    displayName: "Anthropic Claude Agent",
    authKinds: ["cli-profile", "api-key"],
    executionKind: "agent-runtime",
    connectionSurface: "server-and-edge",
    billingKinds: ["consumer-subscription", "api-usage"],
    modelDiscovery: "none",
    quotaDiscovery: "none",
    protocol: "claude-agent-sdk",
    endpointAllowlist: [],
    officialDocumentation: "https://platform.claude.com/docs/en/agent-sdk/overview",
    availability: "requires-provider-approval",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "final-text-only",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "contract-tested",
      approvalModes: ["automatic", "review", "deny"],
    },
    verified: false,
  },
  {
    id: "google-gemini-cli-enterprise",
    displayName: "Google Gemini CLI Enterprise",
    authKinds: ["cli-profile"],
    executionKind: "agent-runtime",
    connectionSurface: "edge-only",
    billingKinds: ["enterprise-subscription"],
    modelDiscovery: "none",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md",
    availability: "experimental",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "final-text-only",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "experimental",
      approvalModes: ["automatic", "deny"],
    },
    verified: false,
  },
  {
    id: "google-antigravity-cli",
    displayName: "Google Antigravity CLI",
    authKinds: ["cli-profile"],
    executionKind: "agent-runtime",
    connectionSurface: "unavailable",
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
    authKinds: ["cli-profile"],
    executionKind: "agent-runtime",
    connectionSurface: "edge-only",
    billingKinds: ["consumer-subscription", "organization-subscription"],
    modelDiscovery: "protocol",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
    availability: "experimental",
    runtimeCapabilities: {
      accountIsolation: "single-os-keyring-account",
      output: "final-text-only",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "one-account-per-connector",
      maturity: "experimental",
      approvalModes: ["automatic", "deny"],
    },
    verified: false,
  },
  {
    id: "minimax-token-plan",
    displayName: "MiniMax Token Plan",
    authKinds: ["subscription-key"],
    executionKind: "model",
    connectionSurface: "server-only",
    billingKinds: ["token-plan", "api-credits", "team-seat"],
    modelDiscovery: "endpoint",
    quotaDiscovery: "endpoint",
    protocol: "openai",
    endpointAllowlist: ["https://api.minimax.io/v1"],
    officialDocumentation: "https://platform.minimax.io/docs/token-plan/quickstart",
    availability: "supported",
    verified: false,
  },
  {
    id: "xai-grok-build",
    displayName: "xAI Grok Build",
    authKinds: ["cli-profile"],
    executionKind: "agent-runtime",
    connectionSurface: "edge-only",
    billingKinds: ["consumer-subscription"],
    modelDiscovery: "command",
    quotaDiscovery: "none",
    protocol: "acp",
    endpointAllowlist: [],
    officialDocumentation: "https://docs.x.ai/build/cli/headless-scripting",
    availability: "experimental",
    runtimeCapabilities: {
      accountIsolation: "profile-root",
      output: "final-text-only",
      cancellation: "protocol",
      session: "protocol",
      permissionBridge: "protocol",
      multipleAccounts: "profile-isolated",
      maturity: "experimental",
      approvalModes: ["automatic", "deny"],
    },
    verified: false,
  },
  {
    id: "xai-api",
    displayName: "xAI API",
    authKinds: ["api-key"],
    executionKind: "model",
    connectionSurface: "unavailable",
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
    connectionSurface: "unavailable",
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
    connectionSurface: "unavailable",
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

const AGENT_APPROVAL_MODES: readonly AgentApprovalMode[] = ["automatic", "review", "deny"];

/**
 * 연결 표면이 주어지면 그 표면의 실제 승인 범위를 반환하고, 생략하면 Provider 정책에
 * 저장할 수 있는 모든 표면의 합집합을 반환합니다.
 */
export function subscriptionProviderApprovalModes(
  manifest: SubscriptionProviderManifest,
  surface?: ConnectorLocation,
): readonly AgentApprovalMode[] | undefined {
  const capabilities = manifest.runtimeCapabilities;
  if (!capabilities) return undefined;
  if (surface !== undefined) {
    return capabilities.approvalModesBySurface?.[surface] ?? capabilities.approvalModes;
  }
  if (!capabilities.approvalModesBySurface) return capabilities.approvalModes;
  return AGENT_APPROVAL_MODES.filter(
    (mode) =>
      capabilities.approvalModesBySurface?.server?.includes(mode) === true ||
      capabilities.approvalModesBySurface?.edge?.includes(mode) === true,
  );
}
