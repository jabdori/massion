import { defineMigration } from "@massion/storage";

export const SOFTWARE_ENGINEERING_DELIVERY_MIGRATION = defineMigration(
  "0033-software-engineering-delivery",
  `
DEFINE TABLE engineering_delivery SCHEMAFULL;
DEFINE FIELD delivery_id ON engineering_delivery TYPE string;
DEFINE FIELD organization_id ON engineering_delivery TYPE string;
DEFINE FIELD work_id ON engineering_delivery TYPE string;
DEFINE FIELD task_id ON engineering_delivery TYPE string;
DEFINE FIELD assignment_id ON engineering_delivery TYPE string;
DEFINE FIELD repository_id ON engineering_delivery TYPE string;
DEFINE FIELD repository_revision_id ON engineering_delivery TYPE string;
DEFINE FIELD base_revision ON engineering_delivery TYPE string;
DEFINE FIELD agent_handle ON engineering_delivery TYPE string;
DEFINE FIELD profile_version ON engineering_delivery TYPE string;
DEFINE FIELD status ON engineering_delivery TYPE string ASSERT $value IN ['preparing', 'test_applied', 'red_verified', 'implementation_applied', 'green_verified', 'committed', 'failed', 'cancelled'];
DEFINE FIELD version ON engineering_delivery TYPE int;
DEFINE FIELD start_command_id ON engineering_delivery TYPE string;
DEFINE FIELD workspace_id ON engineering_delivery TYPE option<string>;
DEFINE FIELD branch_ref ON engineering_delivery TYPE option<string>;
DEFINE FIELD commit_sha ON engineering_delivery TYPE option<string>;
DEFINE FIELD test_patch_hash ON engineering_delivery TYPE option<string>;
DEFINE FIELD implementation_patch_hash ON engineering_delivery TYPE option<string>;
DEFINE FIELD change_set_hash ON engineering_delivery TYPE option<string>;
DEFINE FIELD red_evidence_id ON engineering_delivery TYPE option<string>;
DEFINE FIELD green_evidence_id ON engineering_delivery TYPE option<string>;
DEFINE FIELD validation_evidence_ids ON engineering_delivery TYPE array<string>;
DEFINE FIELD artifact_version_id ON engineering_delivery TYPE option<string>;
DEFINE FIELD error_json ON engineering_delivery TYPE option<string>;
DEFINE FIELD created_by_user_id ON engineering_delivery TYPE string;
DEFINE FIELD created_at ON engineering_delivery TYPE datetime;
DEFINE FIELD updated_at ON engineering_delivery TYPE datetime;
DEFINE INDEX engineering_delivery_id ON engineering_delivery FIELDS delivery_id UNIQUE;
DEFINE INDEX engineering_delivery_start_command ON engineering_delivery FIELDS organization_id, start_command_id UNIQUE;
DEFINE INDEX engineering_delivery_task ON engineering_delivery FIELDS organization_id, work_id, task_id;
DEFINE INDEX engineering_delivery_repository ON engineering_delivery FIELDS organization_id, repository_id, status;

DEFINE TABLE engineering_command_evidence SCHEMAFULL;
DEFINE FIELD command_evidence_id ON engineering_command_evidence TYPE string;
DEFINE FIELD organization_id ON engineering_command_evidence TYPE string;
DEFINE FIELD delivery_id ON engineering_command_evidence TYPE string;
DEFINE FIELD stage ON engineering_command_evidence TYPE string ASSERT $value IN ['red', 'green', 'validation'];
DEFINE FIELD executable ON engineering_command_evidence TYPE string;
DEFINE FIELD arguments_hash ON engineering_command_evidence TYPE string;
DEFINE FIELD cwd ON engineering_command_evidence TYPE string;
DEFINE FIELD exit_code ON engineering_command_evidence TYPE option<int>;
DEFINE FIELD stdout_hash ON engineering_command_evidence TYPE string;
DEFINE FIELD stderr_hash ON engineering_command_evidence TYPE string;
DEFINE FIELD output_excerpt ON engineering_command_evidence TYPE string;
DEFINE FIELD duration_ms ON engineering_command_evidence TYPE int;
DEFINE FIELD timed_out ON engineering_command_evidence TYPE bool;
DEFINE FIELD created_at ON engineering_command_evidence TYPE datetime;
DEFINE INDEX engineering_command_evidence_id ON engineering_command_evidence FIELDS command_evidence_id UNIQUE;
DEFINE INDEX engineering_command_evidence_delivery ON engineering_command_evidence FIELDS organization_id, delivery_id, stage;

DEFINE TABLE engineering_file_change SCHEMAFULL;
DEFINE FIELD file_change_id ON engineering_file_change TYPE string;
DEFINE FIELD organization_id ON engineering_file_change TYPE string;
DEFINE FIELD delivery_id ON engineering_file_change TYPE string;
DEFINE FIELD relative_path ON engineering_file_change TYPE string;
DEFINE FIELD kind ON engineering_file_change TYPE string ASSERT $value IN ['added', 'modified', 'deleted', 'renamed'];
DEFINE FIELD before_hash ON engineering_file_change TYPE option<string>;
DEFINE FIELD after_hash ON engineering_file_change TYPE option<string>;
DEFINE FIELD test_file ON engineering_file_change TYPE bool;
DEFINE FIELD created_at ON engineering_file_change TYPE datetime;
DEFINE INDEX engineering_file_change_id ON engineering_file_change FIELDS file_change_id UNIQUE;
DEFINE INDEX engineering_file_change_path ON engineering_file_change FIELDS organization_id, delivery_id, relative_path UNIQUE;

DEFINE TABLE engineering_delivery_event SCHEMAFULL;
DEFINE FIELD event_id ON engineering_delivery_event TYPE string;
DEFINE FIELD organization_id ON engineering_delivery_event TYPE string;
DEFINE FIELD delivery_id ON engineering_delivery_event TYPE string;
DEFINE FIELD command_id ON engineering_delivery_event TYPE string;
DEFINE FIELD event_type ON engineering_delivery_event TYPE string;
DEFINE FIELD request_hash ON engineering_delivery_event TYPE string;
DEFINE FIELD payload_json ON engineering_delivery_event TYPE string;
DEFINE FIELD result_json ON engineering_delivery_event TYPE string;
DEFINE FIELD actor_user_id ON engineering_delivery_event TYPE string;
DEFINE FIELD created_at ON engineering_delivery_event TYPE datetime;
DEFINE INDEX engineering_delivery_event_id ON engineering_delivery_event FIELDS event_id UNIQUE;
DEFINE INDEX engineering_delivery_event_command ON engineering_delivery_event FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX engineering_delivery_event_delivery ON engineering_delivery_event FIELDS organization_id, delivery_id;
`,
);

export const SOFTWARE_ENGINEERING_PATH_LEASE_MIGRATION = defineMigration(
  "0035-software-engineering-path-lease",
  `
DEFINE TABLE engineering_repository_lease_clock SCHEMAFULL;
DEFINE FIELD clock_key ON engineering_repository_lease_clock TYPE string;
DEFINE FIELD organization_id ON engineering_repository_lease_clock TYPE string;
DEFINE FIELD repository_id ON engineering_repository_lease_clock TYPE string;
DEFINE FIELD version ON engineering_repository_lease_clock TYPE int;
DEFINE FIELD updated_at ON engineering_repository_lease_clock TYPE datetime;
DEFINE INDEX engineering_repository_lease_clock_key ON engineering_repository_lease_clock FIELDS clock_key UNIQUE;
DEFINE INDEX engineering_repository_lease_clock_repository ON engineering_repository_lease_clock FIELDS organization_id, repository_id UNIQUE;

DEFINE TABLE engineering_path_lease SCHEMAFULL;
DEFINE FIELD lease_id ON engineering_path_lease TYPE string;
DEFINE FIELD organization_id ON engineering_path_lease TYPE string;
DEFINE FIELD repository_id ON engineering_path_lease TYPE string;
DEFINE FIELD delivery_id ON engineering_path_lease TYPE string;
DEFINE FIELD path_prefixes ON engineering_path_lease TYPE array<string>;
DEFINE FIELD status ON engineering_path_lease TYPE string ASSERT $value IN ['active', 'released', 'expired'];
DEFINE FIELD version ON engineering_path_lease TYPE int;
DEFINE FIELD expires_at ON engineering_path_lease TYPE datetime;
DEFINE FIELD acquire_command_id ON engineering_path_lease TYPE string;
DEFINE FIELD acquire_request_hash ON engineering_path_lease TYPE string;
DEFINE FIELD release_command_id ON engineering_path_lease TYPE option<string>;
DEFINE FIELD release_request_hash ON engineering_path_lease TYPE option<string>;
DEFINE FIELD created_at ON engineering_path_lease TYPE datetime;
DEFINE FIELD updated_at ON engineering_path_lease TYPE datetime;
DEFINE INDEX engineering_path_lease_id ON engineering_path_lease FIELDS lease_id UNIQUE;
DEFINE INDEX engineering_path_lease_acquire_command ON engineering_path_lease FIELDS organization_id, acquire_command_id UNIQUE;
DEFINE INDEX engineering_path_lease_release_command ON engineering_path_lease FIELDS organization_id, release_command_id UNIQUE;
DEFINE INDEX engineering_path_lease_delivery ON engineering_path_lease FIELDS organization_id, delivery_id UNIQUE;
DEFINE INDEX engineering_path_lease_repository ON engineering_path_lease FIELDS organization_id, repository_id, status;
`,
);

export const SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION = defineMigration(
  "0036-software-engineering-tdd-evidence",
  `
DEFINE FIELD credential_redacted ON engineering_command_evidence TYPE bool DEFAULT false;
DEFINE FIELD evidence_hash ON engineering_command_evidence TYPE option<string>;
DEFINE FIELD change_hash ON engineering_file_change TYPE option<string>;
`,
);

export const SOFTWARE_ENGINEERING_METRIC_MIGRATION = defineMigration(
  "0037-software-engineering-metric",
  `
DEFINE TABLE engineering_metric_event SCHEMAFULL;
DEFINE FIELD metric_event_id ON engineering_metric_event TYPE string;
DEFINE FIELD organization_id ON engineering_metric_event TYPE string;
DEFINE FIELD metric_name ON engineering_metric_event TYPE string;
DEFINE FIELD dimensions_json ON engineering_metric_event TYPE string;
DEFINE FIELD value ON engineering_metric_event TYPE number;
DEFINE FIELD occurred_at ON engineering_metric_event TYPE datetime;
DEFINE INDEX engineering_metric_event_id ON engineering_metric_event FIELDS metric_event_id UNIQUE;
DEFINE INDEX engineering_metric_event_org ON engineering_metric_event FIELDS organization_id, metric_name;
  `,
);

export const SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION = defineMigration(
  "0038-software-engineering-root-binding",
  `
DEFINE FIELD repository_root_real_path_hash ON engineering_delivery TYPE option<string>;
`,
);

export const SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION = defineMigration(
  "0044-software-engineering-command-environment",
  `
DEFINE FIELD environment_hash ON engineering_command_evidence TYPE option<string> ASSERT $value = NONE OR string::len($value) = 64;
`,
);
