export const EXTENSION_SCHEMA_VERSION = "massion.extension.v1" as const;
export const EXTENSION_RPC_PROTOCOL = "massion.extension.rpc.v1" as const;

export type ExtensionTrustLevel = "built-in" | "verified" | "community" | "untrusted-local";

export interface ExtensionToolPermission {
  readonly id: string;
  readonly operations: readonly string[];
}

export interface ExtensionNetworkPermission {
  readonly origin: string;
  readonly methods: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
}

export interface ExtensionPermissionDeclaration {
  readonly tools: readonly ExtensionToolPermission[];
  readonly network: readonly ExtensionNetworkPermission[];
  readonly files: readonly { readonly mount: string; readonly access: "read" | "write" }[];
  readonly secrets: readonly { readonly slot: string; readonly purpose: string }[];
  readonly process: readonly string[];
  readonly mcp: readonly string[];
  readonly storage: { readonly quotaBytes: number; readonly maxValueBytes: number };
  readonly events: readonly string[];
}

export interface ExtensionContributionDeclaration {
  readonly runtimeTools: readonly { readonly id: string; readonly handler: string }[];
  readonly organizationTemplates: readonly { readonly id: string; readonly handler: string }[];
  readonly growthSignals: readonly { readonly id: string; readonly handler: string }[];
  readonly growthTargets: readonly { readonly id: string; readonly handler: string }[];
  readonly surfaceConnectors: readonly { readonly id: string; readonly handler: string }[];
  readonly eventConsumers: readonly { readonly id: string; readonly handler: string }[];
  readonly skills: readonly { readonly id: string; readonly path: string }[];
}

export interface ExtensionManifestV1 {
  readonly schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  readonly name: `@massion-ext/${string}`;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly license: string;
  readonly compatibility: {
    readonly agentOS: string;
    readonly node: string;
    readonly surrealDB?: string;
  };
  readonly runtime: {
    readonly entrypoint: string;
    readonly protocol: typeof EXTENSION_RPC_PROTOCOL;
    readonly healthTimeoutMs: number;
    readonly stopTimeoutMs: number;
  };
  readonly permissions: ExtensionPermissionDeclaration;
  readonly contributions: ExtensionContributionDeclaration;
  readonly migration?: {
    readonly schemaVersion: string;
    readonly operations: readonly Readonly<Record<string, unknown>>[];
  };
  readonly uninstall: { readonly retention: "retain" | "delete-after-export" };
}

export interface ExtensionRpcFrame {
  readonly protocol: typeof EXTENSION_RPC_PROTOCOL;
  readonly requestId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly payload: unknown;
}

export interface ExtensionHandshake {
  readonly nonce: string;
  readonly manifestDigest: string;
  readonly sdkVersion: string;
  readonly contributions: readonly string[];
}
