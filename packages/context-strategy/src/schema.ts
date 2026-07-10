import { defineMigration } from "@massion/storage";

export const CONTEXT_STRATEGY_MIGRATION = defineMigration(
  "0021-context-strategy",
  `
DEFINE TABLE context_version SCHEMAFULL;
DEFINE FIELD context_version_id ON context_version TYPE string;
DEFINE FIELD organization_id ON context_version TYPE string;
DEFINE FIELD work_id ON context_version TYPE string;
DEFINE FIELD project_id ON context_version TYPE option<string>;
DEFINE FIELD version ON context_version TYPE int;
DEFINE FIELD parent_context_version_id ON context_version TYPE option<string>;
DEFINE FIELD package_json ON context_version TYPE string;
DEFINE FIELD selected_sources_json ON context_version TYPE string;
DEFINE FIELD excluded_sources_json ON context_version TYPE string;
DEFINE FIELD token_budget ON context_version TYPE int;
DEFINE FIELD token_total ON context_version TYPE int;
DEFINE FIELD checksum ON context_version TYPE string;
DEFINE FIELD created_by_user_id ON context_version TYPE string;
DEFINE FIELD created_at ON context_version TYPE datetime;
DEFINE INDEX context_version_id ON context_version FIELDS context_version_id UNIQUE;
DEFINE INDEX context_version_number ON context_version FIELDS organization_id, work_id, version UNIQUE;

DEFINE TABLE context_event SCHEMAFULL;
DEFINE FIELD event_id ON context_event TYPE string;
DEFINE FIELD organization_id ON context_event TYPE string;
DEFINE FIELD work_id ON context_event TYPE string;
DEFINE FIELD context_version_id ON context_event TYPE option<string>;
DEFINE FIELD command_id ON context_event TYPE string;
DEFINE FIELD event_type ON context_event TYPE string ASSERT $value IN ['context_version_created', 'context_budget_blocked'];
DEFINE FIELD request_hash ON context_event TYPE string;
DEFINE FIELD payload_json ON context_event TYPE string;
DEFINE FIELD created_at ON context_event TYPE datetime;
DEFINE INDEX context_event_id ON context_event FIELDS event_id UNIQUE;
DEFINE INDEX context_event_command ON context_event FIELDS organization_id, command_id UNIQUE;
`,
);
