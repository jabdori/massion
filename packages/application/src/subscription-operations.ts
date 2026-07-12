import type { TenantContext } from "@massion/identity";
import {
  listCodingPlanPresets,
  listSubscriptionProviderManifests,
  SUBSCRIPTION_CREDENTIAL_POLICIES,
  SUBSCRIPTION_APPROVAL_MODES,
  type AgentRuntimeCapabilities,
  type CodingPlanPreset,
  type ConfigureSubscriptionPolicyInput as DomainConfigureSubscriptionPolicyInput,
  type ConnectorRegistry,
  type SubscriptionDataDisclosureService,
  type ServerConnectorView,
  type SubscriptionAccountService,
  type SubscriptionAuthKind,
  type SubscriptionCredentialPolicy,
  type SubscriptionPolicyStore as DomainSubscriptionPolicyStore,
  type SubscriptionPolicyView as DomainSubscriptionPolicyView,
  type SubscriptionProviderManifest,
  type SubscriptionProviderProtocol,
  type SubscriptionQuotaService,
} from "@massion/subscriptions";

import type { ConnectedSubscription, SubscriptionConnectionService } from "./subscription-connection.js";

export { SUBSCRIPTION_APPROVAL_MODES, SUBSCRIPTION_CREDENTIAL_POLICIES };
export type ConfigureSubscriptionPolicyInput = DomainConfigureSubscriptionPolicyInput;
export type SubscriptionPolicyView = DomainSubscriptionPolicyView;
export type SubscriptionPolicyStore = Pick<DomainSubscriptionPolicyStore, "configure" | "list">;

export type SubscriptionAccountCommands = Pick<
  SubscriptionAccountService,
  "register" | "share" | "unshare" | "disconnect"
>;

export type SubscriptionAccountQueries = Pick<SubscriptionAccountService, "list">;
export type SubscriptionConnectionCommands = Pick<SubscriptionConnectionService, "connect" | "disconnect">;
export interface SubscriptionServerConnectionCommands {
  connectModel(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly providerId: string;
      readonly alias: string;
      readonly authKind: Extract<SubscriptionAuthKind, "api-key" | "subscription-key">;
      readonly billingKind: string;
      readonly secret: string;
      readonly endpointUrl?: string;
      readonly protocol?: SubscriptionProviderProtocol;
      readonly acceptExperimental?: boolean;
      readonly priority?: number;
      readonly weight?: number;
    },
  ): Promise<ConnectedSubscription & { readonly connector: ServerConnectorView }>;
  prepare(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly providerId: string;
      readonly alias: string;
      readonly authKind: SubscriptionAuthKind;
      readonly billingKind: string;
      readonly priority?: number;
      readonly weight?: number;
    },
  ): Promise<
    ConnectedSubscription & {
      readonly connector: ServerConnectorView;
      readonly profileHandle: string;
    }
  >;
  attest(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly connectorId: string;
      readonly accountId?: string;
      readonly modelId?: string;
    },
  ): Promise<
    ServerConnectorView & {
      readonly modelRuntime?: {
        readonly modelId: string;
        readonly modelProfileId: string;
        readonly routeNames: readonly string[];
      };
    }
  >;
  offline(
    context: TenantContext,
    input: { readonly commandId: string; readonly connectorId: string },
  ): Promise<ServerConnectorView>;
}
export type SubscriptionConnectorCommands = Pick<ConnectorRegistry, "enroll" | "revoke">;
export type SubscriptionConnectorQueries = Pick<ConnectorRegistry, "get">;
export type SubscriptionDataDisclosureCommands = Pick<
  SubscriptionDataDisclosureService,
  "acknowledge" | "requireAcknowledgement"
>;
export type SubscriptionQuotaQueries = Pick<SubscriptionQuotaService, "current">;

export interface SubscriptionProviderView {
  readonly providerId: string;
  readonly displayName: string;
  readonly authKinds: readonly SubscriptionAuthKind[];
  readonly executionKind: "model" | "agent-runtime";
  readonly connectionSurface: "server-and-edge" | "server-only" | "edge-only" | "unavailable";
  readonly billingKinds: readonly string[];
  readonly modelDiscovery: "protocol" | "endpoint" | "documented-allowlist" | "command" | "none";
  readonly quotaDiscovery: "protocol" | "headers" | "command" | "endpoint" | "none";
  readonly protocols: readonly SubscriptionProviderProtocol[];
  readonly protocol?: SubscriptionProviderProtocol;
  readonly availability: "supported" | "experimental" | "requires-provider-approval";
  readonly officialDocumentation: string;
  readonly credentialPolicies: readonly SubscriptionCredentialPolicy[];
  readonly verified: boolean;
  readonly runtimeCapabilities?: AgentRuntimeCapabilities;
}

export interface SubscriptionProviderDirectory {
  list(context: TenantContext): Promise<readonly SubscriptionProviderView[]>;
}

function unique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}

function publicManifest(manifest: SubscriptionProviderManifest): SubscriptionProviderView {
  return {
    providerId: manifest.id,
    displayName: manifest.displayName,
    authKinds: manifest.authKinds,
    executionKind: manifest.executionKind,
    connectionSurface: manifest.connectionSurface,
    billingKinds: manifest.billingKinds,
    modelDiscovery: manifest.modelDiscovery,
    quotaDiscovery: manifest.quotaDiscovery,
    protocols: [manifest.protocol],
    protocol: manifest.protocol,
    availability: manifest.availability,
    officialDocumentation: manifest.officialDocumentation,
    credentialPolicies: SUBSCRIPTION_CREDENTIAL_POLICIES,
    verified: manifest.verified,
    ...(manifest.runtimeCapabilities ? { runtimeCapabilities: manifest.runtimeCapabilities } : {}),
  };
}

function publicPreset(preset: CodingPlanPreset): SubscriptionProviderView {
  const protocols = unique(preset.routes.map((route) => route.protocol));
  return {
    providerId: preset.id,
    displayName: preset.displayName,
    authKinds: preset.authKinds,
    executionKind: "model",
    connectionSurface: preset.connectionSurface,
    billingKinds: preset.billingKinds,
    modelDiscovery: preset.modelDiscovery,
    quotaDiscovery: preset.quotaDiscovery,
    protocols,
    ...(protocols.length === 1 && protocols[0] !== undefined ? { protocol: protocols[0] } : {}),
    availability: preset.availability,
    officialDocumentation: preset.officialDocumentation,
    credentialPolicies: SUBSCRIPTION_CREDENTIAL_POLICIES,
    verified: preset.verified,
  };
}

function mergeProvider(manifest: SubscriptionProviderView, preset: SubscriptionProviderView): SubscriptionProviderView {
  const protocols = unique([...manifest.protocols, ...preset.protocols]);
  const merged = {
    providerId: manifest.providerId,
    displayName: manifest.displayName,
    authKinds: unique([...manifest.authKinds, ...preset.authKinds]),
    executionKind: manifest.executionKind,
    connectionSurface: manifest.connectionSurface,
    billingKinds: unique([...manifest.billingKinds, ...preset.billingKinds]),
    modelDiscovery: manifest.modelDiscovery,
    quotaDiscovery: manifest.quotaDiscovery,
    protocols,
    availability: manifest.availability,
    officialDocumentation: manifest.officialDocumentation,
    credentialPolicies: manifest.credentialPolicies,
    verified: manifest.verified || preset.verified,
    ...(manifest.runtimeCapabilities ? { runtimeCapabilities: manifest.runtimeCapabilities } : {}),
  };
  return protocols.length === 1 && protocols[0] !== undefined ? { ...merged, protocol: protocols[0] } : merged;
}

function builtinProviders(): readonly SubscriptionProviderView[] {
  const providers = new Map(
    listSubscriptionProviderManifests().map((manifest) => [manifest.id, publicManifest(manifest)] as const),
  );
  for (const preset of listCodingPlanPresets()) {
    const view = publicPreset(preset);
    const existing = providers.get(preset.id);
    providers.set(preset.id, existing ? mergeProvider(existing, view) : view);
  }
  return [...providers.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
}

const BUILTIN_PROVIDERS = builtinProviders();

export class BuiltinSubscriptionProviderDirectory implements SubscriptionProviderDirectory {
  public list(context: TenantContext): Promise<readonly SubscriptionProviderView[]> {
    void context;
    return Promise.resolve(BUILTIN_PROVIDERS);
  }
}
