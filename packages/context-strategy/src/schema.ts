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

export const STRATEGY_GENERATION_MIGRATION = defineMigration(
  "0022-strategy-generation",
  `
DEFINE TABLE strategy_generation SCHEMAFULL;
DEFINE FIELD strategy_generation_id ON strategy_generation TYPE string;
DEFINE FIELD organization_id ON strategy_generation TYPE string;
DEFINE FIELD work_id ON strategy_generation TYPE string;
DEFINE FIELD context_version_id ON strategy_generation TYPE string;
DEFINE FIELD command_id ON strategy_generation TYPE string;
DEFINE FIELD request_hash ON strategy_generation TYPE string;
DEFINE FIELD expected_work_revision ON strategy_generation TYPE int;
DEFINE FIELD status ON strategy_generation TYPE string ASSERT $value IN ['pending', 'generated', 'blocked_model_unavailable', 'failed', 'applied', 'conflicted'];
DEFINE FIELD runtime_execution_id ON strategy_generation TYPE option<string>;
DEFINE FIELD plan_json ON strategy_generation TYPE option<string>;
DEFINE FIELD checksum ON strategy_generation TYPE option<string>;
DEFINE FIELD error_json ON strategy_generation TYPE option<string>;
DEFINE FIELD created_by_user_id ON strategy_generation TYPE string;
DEFINE FIELD created_at ON strategy_generation TYPE datetime;
DEFINE FIELD updated_at ON strategy_generation TYPE datetime;
DEFINE INDEX strategy_generation_id ON strategy_generation FIELDS strategy_generation_id UNIQUE;
DEFINE INDEX strategy_generation_command ON strategy_generation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX strategy_generation_context ON strategy_generation FIELDS organization_id, context_version_id;

DEFINE TABLE strategy_event SCHEMAFULL;
DEFINE FIELD event_id ON strategy_event TYPE string;
DEFINE FIELD organization_id ON strategy_event TYPE string;
DEFINE FIELD work_id ON strategy_event TYPE string;
DEFINE FIELD strategy_generation_id ON strategy_event TYPE string;
DEFINE FIELD command_id ON strategy_event TYPE string;
DEFINE FIELD event_type ON strategy_event TYPE string;
DEFINE FIELD payload_json ON strategy_event TYPE string;
DEFINE FIELD created_at ON strategy_event TYPE datetime;
DEFINE INDEX strategy_event_id ON strategy_event FIELDS event_id UNIQUE;
DEFINE INDEX strategy_event_command ON strategy_event FIELDS organization_id, command_id UNIQUE;
`,
);

export const CONTINUATION_STAFFING_MIGRATION = defineMigration(
  "0024-continuation-staffing",
  `
DEFINE TABLE continuation_decision SCHEMAFULL;
DEFINE FIELD decision_id ON continuation_decision TYPE string;
DEFINE FIELD organization_id ON continuation_decision TYPE string;
DEFINE FIELD work_id ON continuation_decision TYPE string;
DEFINE FIELD command_id ON continuation_decision TYPE string;
DEFINE FIELD request_hash ON continuation_decision TYPE string;
DEFINE FIELD request_text ON continuation_decision TYPE string;
DEFINE FIELD decision ON continuation_decision TYPE string ASSERT $value IN ['extend_current', 'create_follow_up', 'create_independent'];
DEFINE FIELD confidence ON continuation_decision TYPE float;
DEFINE FIELD reason_codes_json ON continuation_decision TYPE string;
DEFINE FIELD context_delta_json ON continuation_decision TYPE string;
DEFINE FIELD replan_required ON continuation_decision TYPE bool;
DEFINE FIELD source ON continuation_decision TYPE string ASSERT $value IN ['model', 'human_override'];
DEFINE FIELD actor_user_id ON continuation_decision TYPE string;
DEFINE FIELD actor_reason ON continuation_decision TYPE option<string>;
DEFINE FIELD status ON continuation_decision TYPE string ASSERT $value IN ['decided', 'applied', 'failed'];
DEFINE FIELD applied_work_id ON continuation_decision TYPE option<string>;
DEFINE FIELD applied_context_version_id ON continuation_decision TYPE option<string>;
DEFINE FIELD error_json ON continuation_decision TYPE option<string>;
DEFINE FIELD created_at ON continuation_decision TYPE datetime;
DEFINE FIELD updated_at ON continuation_decision TYPE datetime;
DEFINE INDEX continuation_decision_id ON continuation_decision FIELDS decision_id UNIQUE;
DEFINE INDEX continuation_decision_command ON continuation_decision FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX continuation_decision_work ON continuation_decision FIELDS organization_id, work_id;

DEFINE TABLE continuation_event SCHEMAFULL;
DEFINE FIELD event_id ON continuation_event TYPE string;
DEFINE FIELD organization_id ON continuation_event TYPE string;
DEFINE FIELD work_id ON continuation_event TYPE string;
DEFINE FIELD decision_id ON continuation_event TYPE string;
DEFINE FIELD command_id ON continuation_event TYPE string;
DEFINE FIELD event_type ON continuation_event TYPE string;
DEFINE FIELD payload_json ON continuation_event TYPE string;
DEFINE FIELD created_at ON continuation_event TYPE datetime;
DEFINE INDEX continuation_event_id ON continuation_event FIELDS event_id UNIQUE;
DEFINE INDEX continuation_event_command ON continuation_event FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE staffing_assessment SCHEMAFULL;
DEFINE FIELD assessment_id ON staffing_assessment TYPE string;
DEFINE FIELD organization_id ON staffing_assessment TYPE string;
DEFINE FIELD work_id ON staffing_assessment TYPE string;
DEFINE FIELD strategy_generation_id ON staffing_assessment TYPE string;
DEFINE FIELD command_id ON staffing_assessment TYPE string;
DEFINE FIELD request_hash ON staffing_assessment TYPE string;
DEFINE FIELD status ON staffing_assessment TYPE string ASSERT $value IN ['verified', 'gaps'];
DEFINE FIELD recommendations_json ON staffing_assessment TYPE string;
DEFINE FIELD created_by_user_id ON staffing_assessment TYPE string;
DEFINE FIELD created_at ON staffing_assessment TYPE datetime;
DEFINE INDEX staffing_assessment_id ON staffing_assessment FIELDS assessment_id UNIQUE;
DEFINE INDEX staffing_assessment_command ON staffing_assessment FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE staffing_gap SCHEMAFULL;
DEFINE FIELD gap_id ON staffing_gap TYPE string;
DEFINE FIELD assessment_id ON staffing_gap TYPE string;
DEFINE FIELD organization_id ON staffing_gap TYPE string;
DEFINE FIELD work_id ON staffing_gap TYPE string;
DEFINE FIELD strategy_generation_id ON staffing_gap TYPE string;
DEFINE FIELD task_key ON staffing_gap TYPE string;
DEFINE FIELD reason ON staffing_gap TYPE string ASSERT $value IN ['missing_recommendation', 'unavailable_recommendation'];
DEFINE FIELD capability ON staffing_gap TYPE option<string>;
DEFINE FIELD agent_handle ON staffing_gap TYPE option<string>;
DEFINE FIELD created_at ON staffing_gap TYPE datetime;
DEFINE INDEX staffing_gap_id ON staffing_gap FIELDS gap_id UNIQUE;
DEFINE INDEX staffing_gap_assessment ON staffing_gap FIELDS organization_id, assessment_id;
`,
);
