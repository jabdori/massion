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

// prettier-ignore -- 새 migration도 생성 시점의 SQL 바이트를 고정합니다.
export const SUBSCRIPTION_ACCOUNT_POLICY_MIGRATION = defineMigration(
  "0089-subscription-account-policy",
  `
DEFINE TABLE subscription_provider_account_guard SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON subscription_provider_account_guard TYPE string;
DEFINE FIELD provider_id ON subscription_provider_account_guard TYPE string;
DEFINE FIELD account_id ON subscription_provider_account_guard TYPE string;
DEFINE FIELD policy ON subscription_provider_account_guard TYPE string ASSERT $value IN ['no-quota-circumvention'];
DEFINE FIELD created_at ON subscription_provider_account_guard TYPE datetime;
DEFINE INDEX subscription_provider_account_guard_provider ON subscription_provider_account_guard FIELDS organization_id, provider_id UNIQUE;
DEFINE INDEX subscription_provider_account_guard_account ON subscription_provider_account_guard FIELDS organization_id, account_id UNIQUE;
`,
);

// prettier-ignore -- Runtime과 Session Lease의 crash-safe join 계보를 고정합니다.
export const SUBSCRIPTION_LEASE_EXECUTION_MIGRATION = defineMigration(
  "0091-subscription-lease-execution",
  `
DEFINE FIELD execution_id ON subscription_session_lease TYPE option<string>;
UPDATE subscription_session_lease SET status = 'expired', updated_at = time::now()
WHERE execution_id = NONE AND status = 'active';
DEFINE INDEX subscription_session_execution ON subscription_session_lease FIELDS organization_id, execution_id;
`,
);

// prettier-ignore -- Edge 장치 신뢰와 서버 관리형 Runtime 계보를 분리해 고정합니다.
export const SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION = defineMigration(
  "0093-subscription-server-connector",
  `
DEFINE FIELD trust_origin ON subscription_connector TYPE option<string>;
UPDATE subscription_connector SET trust_origin = 'edge-device' WHERE trust_origin = NONE;
UPDATE subscription_connector SET status = 'offline', expires_at = NONE, updated_at = time::now()
WHERE location = 'server' AND trust_origin = 'edge-device';
UPDATE subscription_account SET status = 'offline', version += 1, updated_at = time::now()
WHERE status = 'active' AND [organization_id, connector_id] IN (
  SELECT VALUE [organization_id, connector_id] FROM subscription_connector
  WHERE location = 'server' AND trust_origin = 'edge-device'
);
DEFINE FIELD OVERWRITE trust_origin ON subscription_connector TYPE string DEFAULT 'edge-device' ASSERT $value IN ['edge-device', 'server-managed'];
DEFINE FIELD OVERWRITE public_key ON subscription_connector TYPE option<string>;
DEFINE FIELD provider_id ON subscription_connector TYPE option<string>;
DEFINE FIELD runtime_id ON subscription_connector TYPE option<string>;
DEFINE FIELD runtime_artifact_digest ON subscription_connector TYPE option<string> ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD process_generation ON subscription_connector TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD last_health_at ON subscription_connector TYPE option<datetime>;
DEFINE INDEX subscription_connector_trust ON subscription_connector FIELDS organization_id, trust_origin, connector_id;
DEFINE EVENT subscription_connector_trust_invariant ON TABLE subscription_connector
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF $after.trust_origin = 'edge-device' AND $after.public_key = NONE {
    THROW 'Connector 신뢰 불변식: Edge 장치 공개 key가 필요합니다';
  };
  IF $after.trust_origin = 'server-managed' AND (
    $after.location != 'server' OR
    $after.protocol != 'massion.connector.v1' OR
    $after.public_key != NONE OR
    $after.last_heartbeat_at != NONE OR
    $after.expires_at != NONE OR
    $after.provider_id = NONE OR
    $after.runtime_id = NONE OR
    $after.runtime_artifact_digest = NONE OR
    array::len($after.capabilities) != 1 OR
    $after.capabilities[0] != $after.provider_id OR
    ($after.status = 'ready' AND ($after.process_generation = NONE OR $after.last_health_at = NONE))
  ) {
    THROW 'Connector 신뢰 불변식: 서버 Runtime 계보가 유효하지 않습니다';
  };
};
`,
);

// prettier-ignore -- 실제 Edge 연결 확인 이전의 조기 ready 상태를 append-only로 차단합니다.
export const SUBSCRIPTION_EDGE_READY_MIGRATION = defineMigration(
  "0095-subscription-edge-ready-lineage",
  `
UPDATE subscription_account SET status = 'offline', version += 1, updated_at = time::now()
WHERE status = 'active' AND [organization_id, connector_id] IN (
  SELECT VALUE [organization_id, connector_id] FROM subscription_connector
  WHERE trust_origin = 'edge-device' AND status = 'ready' AND (
    location != 'edge' OR last_heartbeat_at = NONE OR expires_at = NONE OR
    (last_heartbeat_at != NONE AND expires_at != NONE AND expires_at <= last_heartbeat_at)
  )
);
UPDATE subscription_connector SET status = 'offline', expires_at = NONE, updated_at = time::now()
WHERE trust_origin = 'edge-device' AND location != 'edge' AND status = 'ready';
UPDATE subscription_connector SET status = 'enrolling', last_heartbeat_at = NONE, expires_at = NONE, updated_at = time::now()
WHERE trust_origin = 'edge-device' AND location = 'edge' AND status = 'ready' AND (
  last_heartbeat_at = NONE OR expires_at = NONE OR
  (last_heartbeat_at != NONE AND expires_at != NONE AND expires_at <= last_heartbeat_at)
);
DEFINE EVENT OVERWRITE subscription_connector_trust_invariant ON TABLE subscription_connector
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF $after.trust_origin = 'edge-device' AND (
    $after.public_key = NONE OR
    ($after.status = 'ready' AND (
      $after.location != 'edge' OR
      $after.last_heartbeat_at = NONE OR
      $after.expires_at = NONE OR
      ($after.last_heartbeat_at != NONE AND $after.expires_at != NONE AND $after.expires_at <= $after.last_heartbeat_at)
    ))
  ) {
    THROW 'Connector 신뢰 불변식: Edge ready에는 실제 heartbeat 계보가 필요합니다';
  };
  IF $after.trust_origin = 'server-managed' AND (
    $after.location != 'server' OR
    $after.protocol != 'massion.connector.v1' OR
    $after.public_key != NONE OR
    $after.last_heartbeat_at != NONE OR
    $after.expires_at != NONE OR
    $after.provider_id = NONE OR
    $after.runtime_id = NONE OR
    $after.runtime_artifact_digest = NONE OR
    array::len($after.capabilities) != 1 OR
    $after.capabilities[0] != $after.provider_id OR
    ($after.status = 'ready' AND ($after.process_generation = NONE OR $after.last_health_at = NONE))
  ) {
    THROW 'Connector 신뢰 불변식: 서버 Runtime 계보가 유효하지 않습니다';
  };
};
`,
);

// prettier-ignore -- replay 방지 nonce는 허용 시각 창 뒤에 삭제할 수 있어야 하며 UPDATE는 계속 금지합니다.
export const SUBSCRIPTION_NONCE_RETENTION_MIGRATION = defineMigration(
  "0096-subscription-nonce-retention",
  `
DEFINE EVENT OVERWRITE subscription_connector_nonce_immutable ON TABLE subscription_connector_nonce
WHEN $event = 'UPDATE'
THEN { THROW 'Connector nonce는 갱신할 수 없습니다'; };
`,
);

// prettier-ignore -- 승인 방식은 기존 제공자별 routing 정책 version과 함께 append-only로 고정합니다.
export const SUBSCRIPTION_APPROVAL_MODE_MIGRATION = defineMigration(
  "0098-subscription-approval-mode",
  `
DEFINE FIELD approval_mode ON subscription_routing_policy_version TYPE option<string>;
DEFINE FIELD approval_mode ON subscription_routing_policy_active TYPE option<string>;
UPDATE subscription_routing_policy_version SET approval_mode = 'review' WHERE approval_mode = NONE;
UPDATE subscription_routing_policy_active SET approval_mode = 'review' WHERE approval_mode = NONE;
DEFINE FIELD OVERWRITE approval_mode ON subscription_routing_policy_version TYPE string DEFAULT 'review' ASSERT $value IN ['automatic', 'review', 'deny'];
DEFINE FIELD OVERWRITE approval_mode ON subscription_routing_policy_active TYPE string DEFAULT 'review' ASSERT $value IN ['automatic', 'review', 'deny'];
`,
);

// prettier-ignore -- crash 복구가 Connector ID를 runtime adapter로 오인하지 않도록 실행 계보를 lease에 고정합니다.
export const SUBSCRIPTION_LEASE_RUNTIME_LINEAGE_MIGRATION = defineMigration(
  "0100-subscription-lease-runtime-lineage",
  `
DEFINE FIELD adapter_id ON subscription_session_lease TYPE option<string>;
UPDATE subscription_session_lease SET status = 'expired', updated_at = time::now()
WHERE status = 'active' AND adapter_id = NONE;
DEFINE INDEX subscription_session_adapter ON subscription_session_lease FIELDS organization_id, adapter_id, lease_id;
`,
);

// prettier-ignore -- 하나의 Edge 장치 profile을 여러 논리 계정으로 오인하지 않도록 물리 계정 점유를 고정합니다.
export const SUBSCRIPTION_EDGE_ACCOUNT_GUARD_MIGRATION = defineMigration(
  "0101-subscription-edge-account-guard",
  `
DEFINE TABLE subscription_edge_account_guard SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON subscription_edge_account_guard TYPE string;
DEFINE FIELD connector_id ON subscription_edge_account_guard TYPE string;
DEFINE FIELD account_id ON subscription_edge_account_guard TYPE string;
DEFINE FIELD created_at ON subscription_edge_account_guard TYPE datetime;
DEFINE INDEX subscription_edge_account_guard_connector ON subscription_edge_account_guard FIELDS organization_id, connector_id UNIQUE;
DEFINE INDEX subscription_edge_account_guard_account ON subscription_edge_account_guard FIELDS organization_id, account_id UNIQUE;
`,
);

// prettier-ignore -- 제공자 데이터 처리 고지 동의는 개인별·버전별로 append-only로 보존합니다.
export const SUBSCRIPTION_DATA_DISCLOSURE_MIGRATION = defineMigration(
  "0102-subscription-data-disclosure",
  `
DEFINE TABLE subscription_data_disclosure_acknowledgement SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD acknowledgement_id ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD organization_id ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD user_id ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD provider_id ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD disclosure_version ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD command_id ON subscription_data_disclosure_acknowledgement TYPE string;
DEFINE FIELD created_at ON subscription_data_disclosure_acknowledgement TYPE datetime;
DEFINE INDEX subscription_data_disclosure_acknowledgement_id ON subscription_data_disclosure_acknowledgement FIELDS acknowledgement_id UNIQUE;
DEFINE INDEX subscription_data_disclosure_acknowledgement_version ON subscription_data_disclosure_acknowledgement FIELDS organization_id, user_id, provider_id, disclosure_version UNIQUE;
DEFINE EVENT subscription_data_disclosure_acknowledgement_immutable ON TABLE subscription_data_disclosure_acknowledgement WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW '제공자 데이터 처리 고지 동의는 변경하거나 삭제할 수 없습니다'; };
`,
);
