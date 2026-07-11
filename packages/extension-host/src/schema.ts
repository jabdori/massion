import { defineMigration } from "@massion/storage";

export const EXTENSION_CATALOG_MIGRATION = defineMigration(
  "0061-extension-catalog",
  `
DEFINE TABLE extension_installation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD installation_id ON extension_installation TYPE string;
DEFINE FIELD organization_id ON extension_installation TYPE string;
DEFINE FIELD package_name ON extension_installation TYPE string;
DEFINE FIELD state ON extension_installation TYPE string ASSERT $value IN ['inactive', 'active', 'disabled', 'blocked'];
DEFINE FIELD active_version_id ON extension_installation TYPE option<string>;
DEFINE FIELD activation_generation ON extension_installation TYPE int ASSERT $value >= 0;
DEFINE FIELD created_at ON extension_installation TYPE datetime;
DEFINE FIELD updated_at ON extension_installation TYPE datetime;
DEFINE INDEX extension_installation_id ON extension_installation FIELDS organization_id, installation_id UNIQUE;
DEFINE INDEX extension_installation_package ON extension_installation FIELDS organization_id, package_name UNIQUE;
DEFINE EVENT extension_installation_invariant ON TABLE extension_installation
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' { THROW 'Extension installation은 삭제할 수 없습니다'; };
  IF $after.installation_id != $before.installation_id OR
     $after.organization_id != $before.organization_id OR
     $after.package_name != $before.package_name OR
     $after.created_at != $before.created_at {
    THROW 'Extension installation identity는 immutable입니다';
  };
  IF $after.activation_generation != $before.activation_generation + 1 {
    THROW 'Extension activation generation은 한 단계씩 증가해야 합니다';
  };
};

DEFINE TABLE extension_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD version_id ON extension_version TYPE string;
DEFINE FIELD organization_id ON extension_version TYPE string;
DEFINE FIELD installation_id ON extension_version TYPE string;
DEFINE FIELD package_name ON extension_version TYPE string;
DEFINE FIELD package_version ON extension_version TYPE string;
DEFINE FIELD artifact_digest ON extension_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD content_digest ON extension_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD artifact_size ON extension_version TYPE int ASSERT $value > 0;
DEFINE FIELD manifest_json ON extension_version TYPE string ASSERT string::len($value) <= 262144;
DEFINE FIELD manifest_digest ON extension_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD permission_json ON extension_version TYPE string ASSERT string::len($value) <= 131072;
DEFINE FIELD permission_digest ON extension_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD trust_level ON extension_version TYPE string ASSERT $value IN ['built-in', 'verified', 'community', 'untrusted-local'];
DEFINE FIELD source_kind ON extension_version TYPE string ASSERT $value IN ['bundled', 'registry', 'tarball', 'link'];
DEFINE FIELD command_id ON extension_version TYPE string;
DEFINE FIELD request_hash ON extension_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON extension_version TYPE string;
DEFINE FIELD created_at ON extension_version TYPE datetime;
DEFINE INDEX extension_version_id ON extension_version FIELDS organization_id, version_id UNIQUE;
DEFINE INDEX extension_version_package ON extension_version FIELDS organization_id, package_name, package_version UNIQUE;
DEFINE INDEX extension_version_command ON extension_version FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT extension_version_immutable ON TABLE extension_version
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Extension version content는 immutable입니다'; };
`,
);

export const EXTENSION_ACTIVATION_MIGRATION = defineMigration(
  "0062-extension-activation",
  `
DEFINE TABLE extension_activation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD activation_id ON extension_activation TYPE string;
DEFINE FIELD organization_id ON extension_activation TYPE string;
DEFINE FIELD installation_id ON extension_activation TYPE string;
DEFINE FIELD before_version_id ON extension_activation TYPE option<string>;
DEFINE FIELD after_version_id ON extension_activation TYPE string;
DEFINE FIELD before_generation ON extension_activation TYPE int ASSERT $value >= 0;
DEFINE FIELD after_generation ON extension_activation TYPE int ASSERT $value > 0;
DEFINE FIELD command_id ON extension_activation TYPE string;
DEFINE FIELD request_hash ON extension_activation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD governance_decision_ids ON extension_activation TYPE array<string>;
DEFINE FIELD health_receipt_json ON extension_activation TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD sandbox_receipt_json ON extension_activation TYPE option<string>;
DEFINE FIELD outcome ON extension_activation TYPE string ASSERT $value IN ['activated', 'rolled-back', 'disabled', 'failed'];
DEFINE FIELD activated_by_user_id ON extension_activation TYPE string;
DEFINE FIELD created_at ON extension_activation TYPE datetime;
DEFINE INDEX extension_activation_id ON extension_activation FIELDS organization_id, activation_id UNIQUE;
DEFINE INDEX extension_activation_command ON extension_activation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX extension_activation_generation ON extension_activation FIELDS organization_id, installation_id, after_generation UNIQUE;
DEFINE EVENT extension_activation_immutable ON TABLE extension_activation
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Extension activation은 immutable입니다'; };

DEFINE TABLE extension_capability_grant SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD grant_id ON extension_capability_grant TYPE string;
DEFINE FIELD organization_id ON extension_capability_grant TYPE string;
DEFINE FIELD installation_id ON extension_capability_grant TYPE string;
DEFINE FIELD version_id ON extension_capability_grant TYPE string;
DEFINE FIELD permission_digest ON extension_capability_grant TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD permission_json ON extension_capability_grant TYPE string ASSERT string::len($value) <= 131072;
DEFINE FIELD bindings_json ON extension_capability_grant TYPE string ASSERT string::len($value) <= 131072;
DEFINE FIELD governance_decision_ids ON extension_capability_grant TYPE array<string>;
DEFINE FIELD created_at ON extension_capability_grant TYPE datetime;
DEFINE INDEX extension_capability_grant_id ON extension_capability_grant FIELDS organization_id, grant_id UNIQUE;
DEFINE INDEX extension_capability_grant_version ON extension_capability_grant FIELDS organization_id, version_id UNIQUE;
DEFINE EVENT extension_capability_grant_immutable ON TABLE extension_capability_grant
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Extension capability grant는 immutable입니다'; };
`,
);

export const EXTENSION_WORKER_STORAGE_MIGRATION = defineMigration(
  "0063-extension-worker-storage",
  `
DEFINE TABLE extension_worker_session SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD session_id ON extension_worker_session TYPE string;
DEFINE FIELD organization_id ON extension_worker_session TYPE string;
DEFINE FIELD installation_id ON extension_worker_session TYPE string;
DEFINE FIELD version_id ON extension_worker_session TYPE string;
DEFINE FIELD activation_generation ON extension_worker_session TYPE int ASSERT $value > 0;
DEFINE FIELD state ON extension_worker_session TYPE string ASSERT $value IN ['starting', 'healthy', 'draining', 'stopped', 'failed', 'blocked'];
DEFINE FIELD protocol_version ON extension_worker_session TYPE string;
DEFINE FIELD process_id ON extension_worker_session TYPE option<int>;
DEFINE FIELD sandbox_receipt_json ON extension_worker_session TYPE option<string>;
DEFINE FIELD lease_expires_at ON extension_worker_session TYPE option<datetime>;
DEFINE FIELD exit_category ON extension_worker_session TYPE option<string>;
DEFINE FIELD error_hash ON extension_worker_session TYPE option<string>;
DEFINE FIELD started_at ON extension_worker_session TYPE datetime;
DEFINE FIELD updated_at ON extension_worker_session TYPE datetime;
DEFINE INDEX extension_worker_session_id ON extension_worker_session FIELDS organization_id, session_id UNIQUE;
DEFINE INDEX extension_worker_generation ON extension_worker_session FIELDS organization_id, installation_id, activation_generation, session_id UNIQUE;

DEFINE TABLE extension_storage SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON extension_storage TYPE string;
DEFINE FIELD installation_id ON extension_storage TYPE string;
DEFINE FIELD storage_key ON extension_storage TYPE string;
DEFINE FIELD value_json ON extension_storage TYPE string ASSERT string::len($value) <= 1048576;
DEFINE FIELD value_bytes ON extension_storage TYPE int ASSERT $value >= 0;
DEFINE FIELD version ON extension_storage TYPE int ASSERT $value >= 1;
DEFINE FIELD checksum ON extension_storage TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD updated_at ON extension_storage TYPE datetime;
DEFINE INDEX extension_storage_key ON extension_storage FIELDS organization_id, installation_id, storage_key UNIQUE;

DEFINE TABLE extension_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON extension_event TYPE string;
DEFINE FIELD organization_id ON extension_event TYPE string;
DEFINE FIELD installation_id ON extension_event TYPE string;
DEFINE FIELD version_id ON extension_event TYPE option<string>;
DEFINE FIELD activation_id ON extension_event TYPE option<string>;
DEFINE FIELD command_id ON extension_event TYPE string;
DEFINE FIELD event_type ON extension_event TYPE string;
DEFINE FIELD payload_json ON extension_event TYPE string ASSERT string::len($value) <= 131072;
DEFINE FIELD payload_hash ON extension_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON extension_event TYPE datetime;
DEFINE INDEX extension_event_id ON extension_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX extension_event_command ON extension_event FIELDS organization_id, command_id, event_type UNIQUE;
DEFINE EVENT extension_event_immutable ON TABLE extension_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Extension event는 immutable입니다'; };
`,
);

export const EXTENSION_RECOVERY_METRIC_MIGRATION = defineMigration(
  "0064-extension-recovery-metric",
  `
DEFINE TABLE extension_recovery_metric SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD metric_id ON extension_recovery_metric TYPE string;
DEFINE FIELD organization_id ON extension_recovery_metric TYPE string;
DEFINE FIELD source_event_id ON extension_recovery_metric TYPE string;
DEFINE FIELD metric_name ON extension_recovery_metric TYPE string;
DEFINE FIELD outcome ON extension_recovery_metric TYPE string;
DEFINE FIELD value ON extension_recovery_metric TYPE float ASSERT $value >= 0;
DEFINE FIELD unit ON extension_recovery_metric TYPE string;
DEFINE FIELD created_at ON extension_recovery_metric TYPE datetime;
DEFINE INDEX extension_recovery_metric_id ON extension_recovery_metric FIELDS organization_id, metric_id UNIQUE;
DEFINE INDEX extension_recovery_metric_source ON extension_recovery_metric FIELDS organization_id, source_event_id, metric_name UNIQUE;
DEFINE EVENT extension_recovery_metric_immutable ON TABLE extension_recovery_metric
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Extension recovery metric은 immutable입니다'; };
`,
);

export const EXTENSION_MIGRATIONS = [
  EXTENSION_CATALOG_MIGRATION,
  EXTENSION_ACTIVATION_MIGRATION,
  EXTENSION_WORKER_STORAGE_MIGRATION,
  EXTENSION_RECOVERY_METRIC_MIGRATION,
] as const;
