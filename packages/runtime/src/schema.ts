import { defineMigration } from "@massion/storage";

export const RUNTIME_EXECUTION_MIGRATION = defineMigration(
  "0012-runtime-execution",
  `
DEFINE TABLE runtime_execution SCHEMAFULL;
DEFINE FIELD execution_id ON runtime_execution TYPE string;
DEFINE FIELD organization_id ON runtime_execution TYPE string;
DEFINE FIELD work_id ON runtime_execution TYPE string;
DEFINE FIELD task_id ON runtime_execution TYPE option<string>;
DEFINE FIELD agent_handle ON runtime_execution TYPE string;
DEFINE FIELD model_route ON runtime_execution TYPE string;
DEFINE FIELD correlation_id ON runtime_execution TYPE string;
DEFINE FIELD input_json ON runtime_execution TYPE string;
DEFINE FIELD status ON runtime_execution TYPE string;
DEFINE FIELD version ON runtime_execution TYPE int;
DEFINE FIELD event_sequence ON runtime_execution TYPE int;
DEFINE FIELD output_json ON runtime_execution TYPE option<string>;
DEFINE FIELD error_json ON runtime_execution TYPE option<string>;
DEFINE FIELD started_at ON runtime_execution TYPE option<datetime>;
DEFINE FIELD ended_at ON runtime_execution TYPE option<datetime>;
DEFINE FIELD created_at ON runtime_execution TYPE datetime;
DEFINE FIELD updated_at ON runtime_execution TYPE datetime;
DEFINE INDEX runtime_execution_id ON runtime_execution FIELDS execution_id UNIQUE;
DEFINE INDEX runtime_execution_correlation ON runtime_execution FIELDS organization_id, correlation_id;

DEFINE TABLE runtime_event SCHEMAFULL;
DEFINE FIELD event_id ON runtime_event TYPE string;
DEFINE FIELD organization_id ON runtime_event TYPE string;
DEFINE FIELD execution_id ON runtime_event TYPE string;
DEFINE FIELD command_id ON runtime_event TYPE string;
DEFINE FIELD sequence ON runtime_event TYPE int;
DEFINE FIELD event_type ON runtime_event TYPE string;
DEFINE FIELD request_json ON runtime_event TYPE string;
DEFINE FIELD payload_json ON runtime_event TYPE string;
DEFINE FIELD result_json ON runtime_event TYPE string;
DEFINE FIELD created_at ON runtime_event TYPE datetime;
DEFINE INDEX runtime_event_id ON runtime_event FIELDS event_id UNIQUE;
DEFINE INDEX runtime_event_sequence ON runtime_event FIELDS organization_id, execution_id, sequence UNIQUE;
DEFINE INDEX runtime_event_command ON runtime_event FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE runtime_workflow_binding SCHEMAFULL;
DEFINE FIELD binding_id ON runtime_workflow_binding TYPE string;
DEFINE FIELD organization_id ON runtime_workflow_binding TYPE string;
DEFINE FIELD execution_id ON runtime_workflow_binding TYPE string;
DEFINE FIELD workflow_id ON runtime_workflow_binding TYPE string;
DEFINE FIELD workflow_execution_id ON runtime_workflow_binding TYPE string;
DEFINE FIELD created_at ON runtime_workflow_binding TYPE datetime;
DEFINE FIELD updated_at ON runtime_workflow_binding TYPE datetime;
DEFINE INDEX runtime_workflow_binding_id ON runtime_workflow_binding FIELDS binding_id UNIQUE;
DEFINE INDEX runtime_workflow_execution ON runtime_workflow_binding FIELDS organization_id, workflow_execution_id UNIQUE;
DEFINE INDEX runtime_execution_binding ON runtime_workflow_binding FIELDS organization_id, execution_id UNIQUE;

DEFINE EVENT runtime_execution_transition_guard ON runtime_execution
WHEN $event = "UPDATE" AND $before.status != $after.status
THEN {
  IF !(
    ($before.status = "queued" AND $after.status IN ["running", "blocked_model_unavailable", "cancelled"]) OR
    ($before.status = "running" AND $after.status IN ["suspended", "succeeded", "failed", "cancelled", "interrupted"]) OR
    ($before.status = "suspended" AND $after.status IN ["running", "cancelled"])
  ) { THROW "허용되지 않는 Runtime 전이"; };
};
`,
);

export const RUNTIME_MEMORY_MIGRATION = defineMigration(
  "0013-runtime-memory",
  `
DEFINE TABLE runtime_conversation SCHEMAFULL;
DEFINE FIELD conversation_id ON runtime_conversation TYPE string;
DEFINE FIELD organization_id ON runtime_conversation TYPE string;
DEFINE FIELD resource_id ON runtime_conversation TYPE string;
DEFINE FIELD user_id ON runtime_conversation TYPE string;
DEFINE FIELD title ON runtime_conversation TYPE string;
DEFINE FIELD metadata_json ON runtime_conversation TYPE string;
DEFINE FIELD created_at ON runtime_conversation TYPE datetime;
DEFINE FIELD updated_at ON runtime_conversation TYPE datetime;
DEFINE INDEX runtime_conversation_id ON runtime_conversation FIELDS organization_id, conversation_id UNIQUE;
DEFINE INDEX runtime_conversation_resource ON runtime_conversation FIELDS organization_id, resource_id, updated_at;

DEFINE TABLE runtime_message SCHEMAFULL;
DEFINE FIELD message_id ON runtime_message TYPE string;
DEFINE FIELD organization_id ON runtime_message TYPE string;
DEFINE FIELD user_id ON runtime_message TYPE string;
DEFINE FIELD conversation_id ON runtime_message TYPE string;
DEFINE FIELD role ON runtime_message TYPE string;
DEFINE FIELD message_json ON runtime_message TYPE string;
DEFINE FIELD created_at ON runtime_message TYPE datetime;
DEFINE INDEX runtime_message_id ON runtime_message FIELDS organization_id, conversation_id, message_id UNIQUE;
DEFINE INDEX runtime_message_time ON runtime_message FIELDS organization_id, conversation_id, created_at;

DEFINE TABLE runtime_conversation_step SCHEMAFULL;
DEFINE FIELD step_id ON runtime_conversation_step TYPE string;
DEFINE FIELD organization_id ON runtime_conversation_step TYPE string;
DEFINE FIELD user_id ON runtime_conversation_step TYPE string;
DEFINE FIELD conversation_id ON runtime_conversation_step TYPE string;
DEFINE FIELD operation_id ON runtime_conversation_step TYPE string;
DEFINE FIELD step_index ON runtime_conversation_step TYPE int;
DEFINE FIELD step_json ON runtime_conversation_step TYPE string;
DEFINE FIELD created_at ON runtime_conversation_step TYPE datetime;
DEFINE INDEX runtime_conversation_step_id ON runtime_conversation_step FIELDS organization_id, step_id UNIQUE;
DEFINE INDEX runtime_conversation_step_order ON runtime_conversation_step FIELDS organization_id, conversation_id, operation_id, step_index;

DEFINE TABLE runtime_working_memory SCHEMAFULL;
DEFINE FIELD memory_id ON runtime_working_memory TYPE string;
DEFINE FIELD organization_id ON runtime_working_memory TYPE string;
DEFINE FIELD scope ON runtime_working_memory TYPE string;
DEFINE FIELD user_id ON runtime_working_memory TYPE option<string>;
DEFINE FIELD conversation_id ON runtime_working_memory TYPE option<string>;
DEFINE FIELD content ON runtime_working_memory TYPE string;
DEFINE FIELD created_at ON runtime_working_memory TYPE datetime;
DEFINE FIELD updated_at ON runtime_working_memory TYPE datetime;
DEFINE INDEX runtime_working_memory_id ON runtime_working_memory FIELDS organization_id, memory_id UNIQUE;

DEFINE TABLE runtime_workflow_state SCHEMAFULL;
DEFINE FIELD workflow_execution_id ON runtime_workflow_state TYPE string;
DEFINE FIELD organization_id ON runtime_workflow_state TYPE string;
DEFINE FIELD workflow_id ON runtime_workflow_state TYPE string;
DEFINE FIELD workflow_name ON runtime_workflow_state TYPE string;
DEFINE FIELD status ON runtime_workflow_state TYPE string;
DEFINE FIELD user_id ON runtime_workflow_state TYPE option<string>;
DEFINE FIELD metadata_json ON runtime_workflow_state TYPE string;
DEFINE FIELD state_json ON runtime_workflow_state TYPE string;
DEFINE FIELD created_at ON runtime_workflow_state TYPE datetime;
DEFINE FIELD updated_at ON runtime_workflow_state TYPE datetime;
DEFINE INDEX runtime_workflow_state_id ON runtime_workflow_state FIELDS organization_id, workflow_execution_id UNIQUE;
DEFINE INDEX runtime_workflow_state_query ON runtime_workflow_state FIELDS organization_id, workflow_id, status, updated_at;
`,
);
