import { defineMigration } from "@massion/storage";

// prettier-ignore -- 이미 배포된 migration SQL의 공백도 checksum에 포함됩니다.
export const SUBSCRIPTION_MIGRATION = defineMigration(
  "0083-subscription-core",
  `
DEFINE TABLE subscription_connector SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD connector_id ON subscription_connector TYPE string;
DEFINE FIELD organization_id ON subscription_connector TYPE string;
DEFINE FIELD owner_user_id ON subscription_connector TYPE string;
DEFINE FIELD location ON subscription_connector TYPE string ASSERT $value IN ['server', 'edge'];
DEFINE FIELD execution_kind ON subscription_connector TYPE string ASSERT $value IN ['model', 'agent-runtime'];
DEFINE FIELD protocol ON subscription_connector TYPE string;
DEFINE FIELD version ON subscription_connector TYPE string;
DEFINE FIELD public_key ON subscription_connector TYPE string;
DEFINE FIELD capabilities ON subscription_connector TYPE array<string>;
DEFINE FIELD status ON subscription_connector TYPE string ASSERT $value IN ['enrolling', 'ready', 'offline', 'incompatible', 'revoked'];
DEFINE FIELD last_heartbeat_at ON subscription_connector TYPE option<datetime>;
DEFINE FIELD expires_at ON subscription_connector TYPE option<datetime>;
DEFINE FIELD created_at ON subscription_connector TYPE datetime;
DEFINE FIELD updated_at ON subscription_connector TYPE datetime;
DEFINE INDEX subscription_connector_id ON subscription_connector FIELDS organization_id, connector_id UNIQUE;
DEFINE INDEX subscription_connector_owner ON subscription_connector FIELDS organization_id, owner_user_id, connector_id;

DEFINE TABLE subscription_account SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD account_id ON subscription_account TYPE string;
DEFINE FIELD organization_id ON subscription_account TYPE string;
DEFINE FIELD owner_user_id ON subscription_account TYPE string;
DEFINE FIELD provider_id ON subscription_account TYPE string;
DEFINE FIELD alias ON subscription_account TYPE string;
DEFINE FIELD scope ON subscription_account TYPE string ASSERT $value IN ['personal', 'organization'];
DEFINE FIELD connector_id ON subscription_account TYPE string;
DEFINE FIELD profile_fingerprint ON subscription_account TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD billing_kind ON subscription_account TYPE string;
DEFINE FIELD status ON subscription_account TYPE string ASSERT $value IN ['active', 'offline', 'cooldown', 'needs-reauth', 'revoked'];
DEFINE FIELD consent_version ON subscription_account TYPE int ASSERT $value >= 0;
DEFINE FIELD version ON subscription_account TYPE int ASSERT $value > 0;
DEFINE FIELD cooldown_until ON subscription_account TYPE option<datetime>;
DEFINE FIELD created_at ON subscription_account TYPE datetime;
DEFINE FIELD updated_at ON subscription_account TYPE datetime;
DEFINE INDEX subscription_account_id ON subscription_account FIELDS organization_id, account_id UNIQUE;
DEFINE INDEX subscription_account_profile ON subscription_account FIELDS organization_id, provider_id, profile_fingerprint UNIQUE;
DEFINE INDEX subscription_account_owner ON subscription_account FIELDS organization_id, owner_user_id, account_id;

DEFINE TABLE subscription_consent SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD consent_id ON subscription_consent TYPE string;
DEFINE FIELD organization_id ON subscription_consent TYPE string;
DEFINE FIELD account_id ON subscription_consent TYPE string;
DEFINE FIELD owner_user_id ON subscription_consent TYPE string;
DEFINE FIELD version ON subscription_consent TYPE int ASSERT $value > 0;
DEFINE FIELD action ON subscription_consent TYPE string ASSERT $value IN ['shared', 'unshared'];
DEFINE FIELD policy_version ON subscription_consent TYPE string;
DEFINE FIELD command_id ON subscription_consent TYPE string;
DEFINE FIELD created_at ON subscription_consent TYPE datetime;
DEFINE INDEX subscription_consent_id ON subscription_consent FIELDS organization_id, consent_id UNIQUE;
DEFINE INDEX subscription_consent_version ON subscription_consent FIELDS organization_id, account_id, version UNIQUE;
DEFINE INDEX subscription_consent_command ON subscription_consent FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT subscription_consent_immutable ON TABLE subscription_consent WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Subscription consent는 immutable입니다'; };

DEFINE TABLE subscription_quota_snapshot SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD snapshot_id ON subscription_quota_snapshot TYPE string;
DEFINE FIELD organization_id ON subscription_quota_snapshot TYPE string;
DEFINE FIELD account_id ON subscription_quota_snapshot TYPE string;
DEFINE FIELD windows_json ON subscription_quota_snapshot TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD checksum ON subscription_quota_snapshot TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD exhausted ON subscription_quota_snapshot TYPE bool;
DEFINE FIELD observed_at ON subscription_quota_snapshot TYPE datetime;
DEFINE FIELD created_at ON subscription_quota_snapshot TYPE datetime;
DEFINE INDEX subscription_quota_snapshot_id ON subscription_quota_snapshot FIELDS organization_id, snapshot_id UNIQUE;
DEFINE INDEX subscription_quota_snapshot_checksum ON subscription_quota_snapshot FIELDS organization_id, account_id, checksum UNIQUE;
DEFINE EVENT subscription_quota_snapshot_immutable ON TABLE subscription_quota_snapshot WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Subscription quota snapshot은 immutable입니다'; };

DEFINE TABLE subscription_quota_current SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON subscription_quota_current TYPE string;
DEFINE FIELD account_id ON subscription_quota_current TYPE string;
DEFINE FIELD snapshot_id ON subscription_quota_current TYPE string;
DEFINE FIELD minimum_remaining_ratio ON subscription_quota_current TYPE option<float>;
DEFINE FIELD earliest_reset_at ON subscription_quota_current TYPE option<datetime>;
DEFINE FIELD exhausted ON subscription_quota_current TYPE bool;
DEFINE FIELD observed_at ON subscription_quota_current TYPE datetime;
DEFINE FIELD updated_at ON subscription_quota_current TYPE datetime;
DEFINE INDEX subscription_quota_current_account ON subscription_quota_current FIELDS organization_id, account_id UNIQUE;

DEFINE TABLE subscription_session_lease SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD lease_id ON subscription_session_lease TYPE string;
DEFINE FIELD organization_id ON subscription_session_lease TYPE string;
DEFINE FIELD account_id ON subscription_session_lease TYPE string;
DEFINE FIELD connector_id ON subscription_session_lease TYPE string;
DEFINE FIELD work_id ON subscription_session_lease TYPE string;
DEFINE FIELD agent_handle ON subscription_session_lease TYPE string;
DEFINE FIELD route_attempt_id ON subscription_session_lease TYPE string;
DEFINE FIELD quota_snapshot_id ON subscription_session_lease TYPE option<string>;
DEFINE FIELD status ON subscription_session_lease TYPE string ASSERT $value IN ['active', 'completed', 'failed', 'expired', 'revoked'];
DEFINE FIELD expires_at ON subscription_session_lease TYPE datetime;
DEFINE FIELD created_at ON subscription_session_lease TYPE datetime;
DEFINE FIELD updated_at ON subscription_session_lease TYPE datetime;
DEFINE INDEX subscription_session_lease_id ON subscription_session_lease FIELDS organization_id, lease_id UNIQUE;
DEFINE INDEX subscription_session_route_attempt ON subscription_session_lease FIELDS organization_id, route_attempt_id UNIQUE;

DEFINE TABLE subscription_audit_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON subscription_audit_event TYPE string;
DEFINE FIELD organization_id ON subscription_audit_event TYPE string;
DEFINE FIELD actor_user_id ON subscription_audit_event TYPE string;
DEFINE FIELD command_id ON subscription_audit_event TYPE string;
DEFINE FIELD event_type ON subscription_audit_event TYPE string;
DEFINE FIELD resource_id ON subscription_audit_event TYPE string;
DEFINE FIELD request_hash ON subscription_audit_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD result_json ON subscription_audit_event TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD created_at ON subscription_audit_event TYPE datetime;
DEFINE INDEX subscription_audit_event_id ON subscription_audit_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX subscription_audit_command ON subscription_audit_event FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT subscription_audit_immutable ON TABLE subscription_audit_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Subscription audit event는 immutable입니다'; };
`,
);

// prettier-ignore -- 새 migration도 생성 시점의 SQL 바이트를 고정합니다.
export const SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION = defineMigration(
  "0084-subscription-connector-enrollment",
  `
DEFINE TABLE subscription_connector_enrollment SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD enrollment_id ON subscription_connector_enrollment TYPE string;
DEFINE FIELD organization_id ON subscription_connector_enrollment TYPE string;
DEFINE FIELD owner_user_id ON subscription_connector_enrollment TYPE string;
DEFINE FIELD command_id ON subscription_connector_enrollment TYPE string;
DEFINE FIELD code_hash ON subscription_connector_enrollment TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD challenge_nonce ON subscription_connector_enrollment TYPE string;
DEFINE FIELD location ON subscription_connector_enrollment TYPE string ASSERT $value IN ['server', 'edge'];
DEFINE FIELD execution_kind ON subscription_connector_enrollment TYPE string ASSERT $value IN ['model', 'agent-runtime'];
DEFINE FIELD status ON subscription_connector_enrollment TYPE string ASSERT $value IN ['pending', 'used', 'expired'];
DEFINE FIELD expires_at ON subscription_connector_enrollment TYPE datetime;
DEFINE FIELD used_at ON subscription_connector_enrollment TYPE option<datetime>;
DEFINE FIELD created_at ON subscription_connector_enrollment TYPE datetime;
DEFINE INDEX subscription_connector_enrollment_id ON subscription_connector_enrollment FIELDS enrollment_id UNIQUE;
DEFINE INDEX subscription_connector_enrollment_code ON subscription_connector_enrollment FIELDS code_hash UNIQUE;
DEFINE INDEX subscription_connector_enrollment_command ON subscription_connector_enrollment FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE subscription_connector_nonce SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD nonce_id ON subscription_connector_nonce TYPE string;
DEFINE FIELD organization_id ON subscription_connector_nonce TYPE string;
DEFINE FIELD connector_id ON subscription_connector_nonce TYPE string;
DEFINE FIELD nonce_hash ON subscription_connector_nonce TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD observed_at ON subscription_connector_nonce TYPE datetime;
DEFINE FIELD created_at ON subscription_connector_nonce TYPE datetime;
DEFINE INDEX subscription_connector_nonce_id ON subscription_connector_nonce FIELDS organization_id, nonce_id UNIQUE;
DEFINE INDEX subscription_connector_nonce_replay ON subscription_connector_nonce FIELDS organization_id, connector_id, nonce_hash UNIQUE;
DEFINE EVENT subscription_connector_nonce_immutable ON TABLE subscription_connector_nonce WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Connector nonce는 immutable입니다'; };
`,
);

// prettier-ignore -- 새 migration도 생성 시점의 SQL 바이트를 고정합니다.
export const SUBSCRIPTION_POLICY_MIGRATION = defineMigration(
  "0087-subscription-routing-policy",
  `
DEFINE TABLE subscription_routing_policy_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD policy_version_id ON subscription_routing_policy_version TYPE string;
DEFINE FIELD organization_id ON subscription_routing_policy_version TYPE string;
DEFINE FIELD provider_id ON subscription_routing_policy_version TYPE string;
DEFINE FIELD credential_policy ON subscription_routing_policy_version TYPE string ASSERT $value IN ['adaptive', 'priority', 'fill-first', 'round-robin', 'weighted', 'least-used', 'quota-headroom', 'reset-aware', 'sticky'];
DEFINE FIELD version ON subscription_routing_policy_version TYPE int ASSERT $value > 0;
DEFINE FIELD command_id ON subscription_routing_policy_version TYPE string;
DEFINE FIELD actor_user_id ON subscription_routing_policy_version TYPE string;
DEFINE FIELD request_hash ON subscription_routing_policy_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON subscription_routing_policy_version TYPE datetime;
DEFINE INDEX subscription_routing_policy_version_id ON subscription_routing_policy_version FIELDS organization_id, policy_version_id UNIQUE;
DEFINE INDEX subscription_routing_policy_provider_version ON subscription_routing_policy_version FIELDS organization_id, provider_id, version UNIQUE;
DEFINE INDEX subscription_routing_policy_command ON subscription_routing_policy_version FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT subscription_routing_policy_immutable ON TABLE subscription_routing_policy_version WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Subscription routing policy version은 immutable입니다'; };

DEFINE TABLE subscription_routing_policy_active SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON subscription_routing_policy_active TYPE string;
DEFINE FIELD provider_id ON subscription_routing_policy_active TYPE string;
DEFINE FIELD policy_version_id ON subscription_routing_policy_active TYPE string;
DEFINE FIELD credential_policy ON subscription_routing_policy_active TYPE string ASSERT $value IN ['adaptive', 'priority', 'fill-first', 'round-robin', 'weighted', 'least-used', 'quota-headroom', 'reset-aware', 'sticky'];
DEFINE FIELD version ON subscription_routing_policy_active TYPE int ASSERT $value > 0;
DEFINE FIELD updated_at ON subscription_routing_policy_active TYPE datetime;
DEFINE INDEX subscription_routing_policy_active_provider ON subscription_routing_policy_active FIELDS organization_id, provider_id UNIQUE;
`,
);
