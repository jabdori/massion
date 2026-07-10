import { defineMigration } from "@massion/storage";

export const WORK_CORE_MIGRATION = defineMigration(
  "0004-work-core",
  `
DEFINE TABLE work_request SCHEMAFULL;
DEFINE FIELD request_id ON work_request TYPE string;
DEFINE FIELD organization_id ON work_request TYPE string;
DEFINE FIELD requester_user_id ON work_request TYPE string;
DEFINE FIELD text ON work_request TYPE string;
DEFINE FIELD surface ON work_request TYPE string;
DEFINE FIELD created_at ON work_request TYPE datetime;
DEFINE INDEX work_request_id ON work_request FIELDS request_id UNIQUE;
DEFINE INDEX work_request_tenant ON work_request FIELDS organization_id;

DEFINE TABLE work SCHEMAFULL;
DEFINE FIELD work_id ON work TYPE string;
DEFINE FIELD organization_id ON work TYPE string;
DEFINE FIELD request_id ON work TYPE string;
DEFINE FIELD parent_work_id ON work TYPE option<string>;
DEFINE FIELD project_id ON work TYPE option<string>;
DEFINE FIELD status ON work TYPE string;
DEFINE FIELD revision ON work TYPE int;
DEFINE FIELD organization_version_id ON work TYPE string;
DEFINE FIELD context_version_id ON work TYPE option<string>;
DEFINE FIELD policy_version_id ON work TYPE option<string>;
DEFINE FIELD prompt_version_id ON work TYPE option<string>;
DEFINE FIELD artifact_version_ids ON work TYPE array<string>;
DEFINE FIELD created_at ON work TYPE datetime;
DEFINE FIELD updated_at ON work TYPE datetime;
DEFINE INDEX work_id ON work FIELDS work_id UNIQUE;
DEFINE INDEX work_tenant ON work FIELDS organization_id;
DEFINE INDEX work_request_unique ON work FIELDS organization_id, request_id UNIQUE;

DEFINE TABLE work_event SCHEMAFULL;
DEFINE FIELD event_id ON work_event TYPE string;
DEFINE FIELD organization_id ON work_event TYPE string;
DEFINE FIELD work_id ON work_event TYPE string;
DEFINE FIELD sequence ON work_event TYPE int;
DEFINE FIELD command_id ON work_event TYPE string;
DEFINE FIELD event_type ON work_event TYPE string;
DEFINE FIELD actor_user_id ON work_event TYPE string;
DEFINE FIELD caused_by_event_id ON work_event TYPE option<string>;
DEFINE FIELD request_json ON work_event TYPE string;
DEFINE FIELD payload_json ON work_event TYPE string;
DEFINE FIELD result_json ON work_event TYPE string;
DEFINE FIELD created_at ON work_event TYPE datetime;
DEFINE INDEX work_event_id ON work_event FIELDS event_id UNIQUE;
DEFINE INDEX work_event_sequence ON work_event FIELDS organization_id, work_id, sequence UNIQUE;
DEFINE INDEX work_event_command ON work_event FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE plan_version SCHEMAFULL;
DEFINE FIELD plan_version_id ON plan_version TYPE string;
DEFINE FIELD organization_id ON plan_version TYPE string;
DEFINE FIELD work_id ON plan_version TYPE string;
DEFINE FIELD version ON plan_version TYPE int;
DEFINE FIELD content_json ON plan_version TYPE string;
DEFINE FIELD valid ON plan_version TYPE bool;
DEFINE FIELD created_by ON plan_version TYPE string;
DEFINE FIELD created_at ON plan_version TYPE datetime;
DEFINE INDEX plan_version_id ON plan_version FIELDS plan_version_id UNIQUE;
DEFINE INDEX plan_version_number ON plan_version FIELDS organization_id, work_id, version UNIQUE;
`,
);

export const WORK_DELIVERY_MIGRATION = defineMigration(
  "0005-work-delivery",
  `
DEFINE TABLE work_task SCHEMAFULL;
DEFINE FIELD task_id ON work_task TYPE string;
DEFINE FIELD organization_id ON work_task TYPE string;
DEFINE FIELD work_id ON work_task TYPE string;
DEFINE FIELD title ON work_task TYPE string;
DEFINE FIELD objective ON work_task TYPE string;
DEFINE FIELD acceptance_criteria_json ON work_task TYPE string;
DEFINE FIELD dependency_ids ON work_task TYPE array<string>;
DEFINE FIELD status ON work_task TYPE string;
DEFINE FIELD revision ON work_task TYPE int;
DEFINE FIELD created_at ON work_task TYPE datetime;
DEFINE FIELD updated_at ON work_task TYPE datetime;
DEFINE INDEX work_task_id ON work_task FIELDS task_id UNIQUE;
DEFINE INDEX work_task_work ON work_task FIELDS organization_id, work_id;

DEFINE TABLE task_assignment SCHEMAFULL;
DEFINE FIELD assignment_id ON task_assignment TYPE string;
DEFINE FIELD organization_id ON task_assignment TYPE string;
DEFINE FIELD work_id ON task_assignment TYPE string;
DEFINE FIELD task_id ON task_assignment TYPE string;
DEFINE FIELD agent_handle ON task_assignment TYPE string;
DEFINE FIELD status ON task_assignment TYPE string;
DEFINE FIELD revision ON task_assignment TYPE int;
DEFINE FIELD supersedes_assignment_id ON task_assignment TYPE option<string>;
DEFINE FIELD created_by ON task_assignment TYPE string;
DEFINE FIELD created_at ON task_assignment TYPE datetime;
DEFINE FIELD updated_at ON task_assignment TYPE datetime;
DEFINE INDEX task_assignment_id ON task_assignment FIELDS assignment_id UNIQUE;
DEFINE INDEX task_assignment_task ON task_assignment FIELDS organization_id, work_id, task_id;

DEFINE TABLE work_session SCHEMAFULL;
DEFINE FIELD session_id ON work_session TYPE string;
DEFINE FIELD organization_id ON work_session TYPE string;
DEFINE FIELD work_id ON work_session TYPE string;
DEFINE FIELD agent_handle ON work_session TYPE string;
DEFINE FIELD status ON work_session TYPE string;
DEFINE FIELD revision ON work_session TYPE int;
DEFINE FIELD created_at ON work_session TYPE datetime;
DEFINE FIELD updated_at ON work_session TYPE datetime;
DEFINE INDEX work_session_id ON work_session FIELDS session_id UNIQUE;
DEFINE INDEX work_session_agent ON work_session FIELDS organization_id, work_id, agent_handle UNIQUE;

DEFINE TABLE session_checkpoint SCHEMAFULL;
DEFINE FIELD checkpoint_id ON session_checkpoint TYPE string;
DEFINE FIELD organization_id ON session_checkpoint TYPE string;
DEFINE FIELD work_id ON session_checkpoint TYPE string;
DEFINE FIELD session_id ON session_checkpoint TYPE string;
DEFINE FIELD version ON session_checkpoint TYPE int;
DEFINE FIELD data_json ON session_checkpoint TYPE string;
DEFINE FIELD checksum ON session_checkpoint TYPE string;
DEFINE FIELD created_at ON session_checkpoint TYPE datetime;
DEFINE INDEX session_checkpoint_id ON session_checkpoint FIELDS checkpoint_id UNIQUE;
DEFINE INDEX session_checkpoint_version ON session_checkpoint FIELDS organization_id, session_id, version UNIQUE;
`,
);
