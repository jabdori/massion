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

export const WORK_COLLABORATION_MIGRATION = defineMigration(
  "0006-work-collaboration",
  `
DEFINE TABLE collaboration_room SCHEMAFULL;
DEFINE FIELD room_id ON collaboration_room TYPE string;
DEFINE FIELD organization_id ON collaboration_room TYPE string;
DEFINE FIELD work_id ON collaboration_room TYPE string;
DEFINE FIELD title ON collaboration_room TYPE string;
DEFINE FIELD coordinator_handle ON collaboration_room TYPE string;
DEFINE FIELD status ON collaboration_room TYPE string;
DEFINE FIELD revision ON collaboration_room TYPE int;
DEFINE FIELD next_sequence ON collaboration_room TYPE int;
DEFINE FIELD max_parallel ON collaboration_room TYPE int;
DEFINE FIELD max_tokens ON collaboration_room TYPE int;
DEFINE FIELD max_cost_micros ON collaboration_room TYPE int;
DEFINE FIELD max_rounds ON collaboration_room TYPE int;
DEFINE FIELD round_count ON collaboration_room TYPE int;
DEFINE FIELD deadline ON collaboration_room TYPE option<datetime>;
DEFINE FIELD created_at ON collaboration_room TYPE datetime;
DEFINE FIELD updated_at ON collaboration_room TYPE datetime;
DEFINE INDEX collaboration_room_id ON collaboration_room FIELDS room_id UNIQUE;
DEFINE INDEX collaboration_room_work ON collaboration_room FIELDS organization_id, work_id;

DEFINE TABLE collaboration_participant SCHEMAFULL;
DEFINE FIELD participant_id ON collaboration_participant TYPE string;
DEFINE FIELD organization_id ON collaboration_participant TYPE string;
DEFINE FIELD work_id ON collaboration_participant TYPE string;
DEFINE FIELD room_id ON collaboration_participant TYPE string;
DEFINE FIELD kind ON collaboration_participant TYPE string;
DEFINE FIELD subject_id ON collaboration_participant TYPE string;
DEFINE FIELD role ON collaboration_participant TYPE string;
DEFINE FIELD status ON collaboration_participant TYPE string;
DEFINE FIELD joined_at ON collaboration_participant TYPE datetime;
DEFINE INDEX collaboration_participant_id ON collaboration_participant FIELDS participant_id UNIQUE;
DEFINE INDEX collaboration_participant_subject ON collaboration_participant FIELDS organization_id, room_id, kind, subject_id UNIQUE;

DEFINE TABLE collaboration_message SCHEMAFULL;
DEFINE FIELD message_id ON collaboration_message TYPE string;
DEFINE FIELD organization_id ON collaboration_message TYPE string;
DEFINE FIELD work_id ON collaboration_message TYPE string;
DEFINE FIELD room_id ON collaboration_message TYPE string;
DEFINE FIELD sequence ON collaboration_message TYPE int;
DEFINE FIELD message_type ON collaboration_message TYPE string;
DEFINE FIELD author_kind ON collaboration_message TYPE string;
DEFINE FIELD author_id ON collaboration_message TYPE string;
DEFINE FIELD content ON collaboration_message TYPE string;
DEFINE FIELD reply_to_message_id ON collaboration_message TYPE option<string>;
DEFINE FIELD caused_by_message_id ON collaboration_message TYPE option<string>;
DEFINE FIELD task_id ON collaboration_message TYPE option<string>;
DEFINE FIELD context_version_id ON collaboration_message TYPE option<string>;
DEFINE FIELD execution_id ON collaboration_message TYPE option<string>;
DEFINE FIELD artifact_version_id ON collaboration_message TYPE option<string>;
DEFINE FIELD token_count ON collaboration_message TYPE int;
DEFINE FIELD cost_micros ON collaboration_message TYPE int;
DEFINE FIELD created_at ON collaboration_message TYPE datetime;
DEFINE INDEX collaboration_message_id ON collaboration_message FIELDS message_id UNIQUE;
DEFINE INDEX collaboration_message_sequence ON collaboration_message FIELDS organization_id, room_id, sequence UNIQUE;

DEFINE TABLE shared_context_reference SCHEMAFULL;
DEFINE FIELD shared_context_reference_id ON shared_context_reference TYPE string;
DEFINE FIELD organization_id ON shared_context_reference TYPE string;
DEFINE FIELD work_id ON shared_context_reference TYPE string;
DEFINE FIELD room_id ON shared_context_reference TYPE string;
DEFINE FIELD source_kind ON shared_context_reference TYPE string;
DEFINE FIELD source_id ON shared_context_reference TYPE string;
DEFINE FIELD version_id ON shared_context_reference TYPE string;
DEFINE FIELD checksum ON shared_context_reference TYPE string;
DEFINE FIELD created_at ON shared_context_reference TYPE datetime;
DEFINE INDEX shared_context_reference_id ON shared_context_reference FIELDS shared_context_reference_id UNIQUE;
DEFINE INDEX shared_context_reference_unique ON shared_context_reference FIELDS organization_id, room_id, source_kind, source_id, version_id UNIQUE;

DEFINE TABLE resource_lease SCHEMAFULL;
DEFINE FIELD lease_id ON resource_lease TYPE string;
DEFINE FIELD organization_id ON resource_lease TYPE string;
DEFINE FIELD work_id ON resource_lease TYPE string;
DEFINE FIELD resource_key ON resource_lease TYPE string;
DEFINE FIELD holder_id ON resource_lease TYPE string;
DEFINE FIELD status ON resource_lease TYPE string;
DEFINE FIELD version ON resource_lease TYPE int;
DEFINE FIELD expires_at ON resource_lease TYPE datetime;
DEFINE FIELD created_at ON resource_lease TYPE datetime;
DEFINE FIELD updated_at ON resource_lease TYPE datetime;
DEFINE INDEX resource_lease_id ON resource_lease FIELDS lease_id UNIQUE;
DEFINE INDEX resource_lease_resource ON resource_lease FIELDS organization_id, work_id, resource_key UNIQUE;
`,
);

export const WORK_RECORDS_MIGRATION = defineMigration(
  "0007-work-records",
  `
DEFINE TABLE work_artifact SCHEMAFULL;
DEFINE FIELD artifact_id ON work_artifact TYPE string;
DEFINE FIELD organization_id ON work_artifact TYPE string;
DEFINE FIELD work_id ON work_artifact TYPE string;
DEFINE FIELD kind ON work_artifact TYPE string;
DEFINE FIELD name ON work_artifact TYPE string;
DEFINE FIELD created_by ON work_artifact TYPE string;
DEFINE FIELD created_at ON work_artifact TYPE datetime;
DEFINE INDEX work_artifact_id ON work_artifact FIELDS artifact_id UNIQUE;
DEFINE INDEX work_artifact_name ON work_artifact FIELDS organization_id, work_id, name UNIQUE;

DEFINE TABLE artifact_version SCHEMAFULL;
DEFINE FIELD artifact_version_id ON artifact_version TYPE string;
DEFINE FIELD artifact_id ON artifact_version TYPE string;
DEFINE FIELD organization_id ON artifact_version TYPE string;
DEFINE FIELD work_id ON artifact_version TYPE string;
DEFINE FIELD version ON artifact_version TYPE int;
DEFINE FIELD checksum ON artifact_version TYPE string;
DEFINE FIELD media_type ON artifact_version TYPE string;
DEFINE FIELD content_json ON artifact_version TYPE string;
DEFINE FIELD source_artifact_version_id ON artifact_version TYPE option<string>;
DEFINE FIELD created_by ON artifact_version TYPE string;
DEFINE FIELD created_at ON artifact_version TYPE datetime;
DEFINE INDEX artifact_version_id ON artifact_version FIELDS artifact_version_id UNIQUE;
DEFINE INDEX artifact_version_number ON artifact_version FIELDS organization_id, artifact_id, version UNIQUE;

DEFINE TABLE work_verification SCHEMAFULL;
DEFINE FIELD verification_id ON work_verification TYPE string;
DEFINE FIELD organization_id ON work_verification TYPE string;
DEFINE FIELD work_id ON work_verification TYPE string;
DEFINE FIELD verifier_id ON work_verification TYPE string;
DEFINE FIELD passed ON work_verification TYPE bool;
DEFINE FIELD criteria_json ON work_verification TYPE string;
DEFINE FIELD evidence_artifact_version_ids ON work_verification TYPE array<string>;
DEFINE FIELD created_at ON work_verification TYPE datetime;
DEFINE INDEX work_verification_id ON work_verification FIELDS verification_id UNIQUE;
DEFINE INDEX work_verification_work ON work_verification FIELDS organization_id, work_id;

DEFINE TABLE work_record SCHEMAFULL;
DEFINE FIELD work_record_id ON work_record TYPE string;
DEFINE FIELD organization_id ON work_record TYPE string;
DEFINE FIELD work_id ON work_record TYPE string;
DEFINE FIELD version ON work_record TYPE int;
DEFINE FIELD recorded_work_revision ON work_record TYPE int;
DEFINE FIELD summary ON work_record TYPE string;
DEFINE FIELD event_start_sequence ON work_record TYPE int;
DEFINE FIELD event_end_sequence ON work_record TYPE int;
DEFINE FIELD decision_message_ids ON work_record TYPE array<string>;
DEFINE FIELD artifact_version_ids ON work_record TYPE array<string>;
DEFINE FIELD verification_ids ON work_record TYPE array<string>;
DEFINE FIELD finalized ON work_record TYPE bool;
DEFINE FIELD finalized_by ON work_record TYPE string;
DEFINE FIELD finalized_at ON work_record TYPE datetime;
DEFINE INDEX work_record_id ON work_record FIELDS work_record_id UNIQUE;
DEFINE INDEX work_record_work_version ON work_record FIELDS organization_id, work_id, version UNIQUE;

DEFINE TABLE work_merge_plan SCHEMAFULL;
DEFINE FIELD merge_plan_id ON work_merge_plan TYPE string;
DEFINE FIELD organization_id ON work_merge_plan TYPE string;
DEFINE FIELD parent_work_id ON work_merge_plan TYPE string;
DEFINE FIELD child_work_id ON work_merge_plan TYPE string;
DEFINE FIELD parent_revision ON work_merge_plan TYPE int;
DEFINE FIELD status ON work_merge_plan TYPE string;
DEFINE FIELD conflict_json ON work_merge_plan TYPE string;
DEFINE FIELD artifact_version_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD decision_message_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD verification_ids ON work_merge_plan TYPE array<string>;
DEFINE FIELD created_by ON work_merge_plan TYPE string;
DEFINE FIELD created_at ON work_merge_plan TYPE datetime;
DEFINE FIELD applied_at ON work_merge_plan TYPE option<datetime>;
DEFINE INDEX work_merge_plan_id ON work_merge_plan FIELDS merge_plan_id UNIQUE;
DEFINE INDEX work_merge_plan_works ON work_merge_plan FIELDS organization_id, parent_work_id, child_work_id;
`,
);

export const WORK_CONSTRAINTS_MIGRATION = defineMigration(
  "0008-work-constraints",
  `
DEFINE FIELD OVERWRITE status ON work TYPE string ASSERT $value IN ['draft', 'planned', 'ready', 'running', 'waiting_approval', 'verifying', 'completed', 'failed', 'retrying', 'replanning', 'cancelled'];
DEFINE FIELD OVERWRITE revision ON work TYPE int ASSERT $value >= 1;
DEFINE EVENT work_create_state ON work
  WHEN $event = 'CREATE' AND $after.status != 'draft'
  THEN { THROW 'Work는 draft 상태로만 생성할 수 있습니다'; };
DEFINE EVENT work_transition_state ON work
  WHEN $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'draft' AND $after.status IN ['planned', 'cancelled']) OR
    ($before.status = 'planned' AND $after.status IN ['ready', 'cancelled']) OR
    ($before.status = 'ready' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['waiting_approval', 'verifying', 'failed', 'cancelled']) OR
    ($before.status = 'waiting_approval' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'verifying' AND $after.status IN ['completed', 'failed', 'cancelled']) OR
    ($before.status = 'failed' AND $after.status IN ['retrying', 'replanning', 'cancelled']) OR
    ($before.status = 'retrying' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'replanning' AND $after.status IN ['planned', 'cancelled'])
  )
  THEN { THROW '허용되지 않은 Work 상태 전이입니다'; };

DEFINE FIELD OVERWRITE status ON work_task TYPE string ASSERT $value IN ['blocked', 'ready', 'running', 'completed', 'failed', 'cancelled'];
DEFINE FIELD OVERWRITE revision ON work_task TYPE int ASSERT $value >= 1;
DEFINE EVENT task_create_state ON work_task
  WHEN $event = 'CREATE' AND $after.status NOT IN ['blocked', 'ready']
  THEN { THROW 'Task는 blocked 또는 ready 상태로만 생성할 수 있습니다'; };
DEFINE EVENT task_transition_state ON work_task
  WHEN $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'blocked' AND $after.status IN ['ready', 'cancelled']) OR
    ($before.status = 'ready' AND $after.status IN ['running', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['completed', 'failed', 'cancelled']) OR
    ($before.status = 'failed' AND $after.status IN ['ready', 'cancelled'])
  )
  THEN { THROW '허용되지 않은 Task 상태 전이입니다'; };
`,
);
