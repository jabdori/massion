export type SubscriptionScope = "personal" | "organization";
export type ConnectorLocation = "server" | "edge";
export type ConnectorTrustOrigin = "edge-device" | "server-managed";
export type ConnectorExecutionKind = "model" | "agent-runtime";
export type SubscriptionAccountStatus = "active" | "offline" | "cooldown" | "needs-reauth" | "revoked";
export type ConnectorStatus = "enrolling" | "ready" | "offline" | "incompatible" | "revoked";
export type QuotaConfidence = "reported" | "derived" | "unknown";

export interface SubscriptionAccount {
  readonly account_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly provider_id: string;
  readonly alias: string;
  readonly scope: SubscriptionScope;
  readonly connector_id: string;
  readonly profile_fingerprint: string;
  readonly billing_kind: string;
  readonly status: SubscriptionAccountStatus;
  readonly consent_version: number;
  readonly version: number;
  readonly cooldown_until?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface SubscriptionConnector {
  readonly connector_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly location: ConnectorLocation;
  readonly trust_origin?: ConnectorTrustOrigin;
  readonly provider_id?: string;
  readonly execution_kind: ConnectorExecutionKind;
  readonly protocol: string;
  readonly version: string;
  readonly public_key?: string;
  readonly runtime_id?: string;
  readonly runtime_artifact_digest?: string;
  readonly process_generation?: number;
  readonly last_health_at?: unknown;
  readonly capabilities: readonly string[];
  readonly status: ConnectorStatus;
  readonly last_heartbeat_at?: unknown;
  readonly expires_at?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface QuotaWindow {
  readonly kind: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly remainingRatio?: number;
  readonly resetsAt?: string;
  readonly observedAt: string;
  readonly source: string;
  readonly confidence: QuotaConfidence;
}

export interface SubscriptionSessionLease {
  readonly lease_id: string;
  readonly organization_id: string;
  readonly account_id: string;
  readonly connector_id: string;
  readonly adapter_id?: string;
  readonly execution_id?: string;
  readonly work_id: string;
  readonly agent_handle: string;
  readonly route_attempt_id: string;
  readonly quota_snapshot_id?: string;
  readonly status: "active" | "completed" | "failed" | "expired" | "revoked";
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
