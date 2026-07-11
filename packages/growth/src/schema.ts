import { defineMigration } from "@massion/storage";

export const GROWTH_CONFIGURATION_MIGRATION = defineMigration(
  "0051-growth-configuration",
  `
DEFINE TABLE growth_configuration_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD configuration_version_id ON growth_configuration_version TYPE string;
DEFINE FIELD organization_id ON growth_configuration_version TYPE string;
DEFINE FIELD subject_type ON growth_configuration_version TYPE string ASSERT $value IN ['organization', 'user'];
DEFINE FIELD subject_id ON growth_configuration_version TYPE option<string>;
DEFINE FIELD subject_key ON growth_configuration_version TYPE string;
DEFINE FIELD version ON growth_configuration_version TYPE int ASSERT $value >= 1;
DEFINE FIELD previous_version_id ON growth_configuration_version TYPE option<string>;
DEFINE FIELD status ON growth_configuration_version TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD reflection_enabled ON growth_configuration_version TYPE bool;
DEFINE FIELD adoption_mode ON growth_configuration_version TYPE string ASSERT $value IN ['review', 'auto'];
DEFINE FIELD command_id ON growth_configuration_version TYPE string;
DEFINE FIELD request_hash ON growth_configuration_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD governance_decision_id ON growth_configuration_version TYPE string;
DEFINE FIELD checksum ON growth_configuration_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD active_guard_key ON growth_configuration_version TYPE option<string>;
DEFINE FIELD created_by_user_id ON growth_configuration_version TYPE string;
DEFINE FIELD created_at ON growth_configuration_version TYPE datetime;
DEFINE FIELD activated_at ON growth_configuration_version TYPE datetime;
DEFINE FIELD superseded_at ON growth_configuration_version TYPE option<datetime>;
DEFINE INDEX growth_configuration_id ON growth_configuration_version FIELDS organization_id, configuration_version_id UNIQUE;
DEFINE INDEX growth_configuration_command ON growth_configuration_version FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_configuration_version ON growth_configuration_version FIELDS organization_id, subject_key, version UNIQUE;
DEFINE INDEX growth_configuration_active ON growth_configuration_version FIELDS active_guard_key UNIQUE;
DEFINE EVENT growth_configuration_invariant ON TABLE growth_configuration_version
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' {
    THROW 'Growth configuration version은 삭제할 수 없습니다';
  };
  IF $event = 'CREATE' AND !(
    $after.status = 'active' AND $after.active_guard_key != NONE AND $after.superseded_at = NONE
  ) {
    THROW 'Growth configuration은 active 상태로 생성해야 합니다';
  };
  IF $event = 'UPDATE' AND !(
    $before.status = 'active' AND $after.status = 'superseded' AND
    $after.active_guard_key = NONE AND $after.superseded_at != NONE
  ) {
    THROW 'Growth configuration은 active에서 superseded로만 변경할 수 있습니다';
  };
  IF $event = 'UPDATE' AND (
    $after.configuration_version_id != $before.configuration_version_id OR
    $after.organization_id != $before.organization_id OR
    $after.subject_type != $before.subject_type OR
    $after.subject_id != $before.subject_id OR
    $after.subject_key != $before.subject_key OR
    $after.version != $before.version OR
    $after.previous_version_id != $before.previous_version_id OR
    $after.reflection_enabled != $before.reflection_enabled OR
    $after.adoption_mode != $before.adoption_mode OR
    $after.command_id != $before.command_id OR
    $after.request_hash != $before.request_hash OR
    $after.governance_decision_id != $before.governance_decision_id OR
    $after.checksum != $before.checksum OR
    $after.created_by_user_id != $before.created_by_user_id OR
    $after.created_at != $before.created_at OR
    $after.activated_at != $before.activated_at
  ) {
    THROW 'Growth configuration version의 내용은 immutable입니다';
  };
};

DEFINE TABLE growth_configuration_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON growth_configuration_event TYPE string;
DEFINE FIELD organization_id ON growth_configuration_event TYPE string;
DEFINE FIELD configuration_version_id ON growth_configuration_event TYPE string;
DEFINE FIELD command_id ON growth_configuration_event TYPE string;
DEFINE FIELD event_type ON growth_configuration_event TYPE string ASSERT $value IN ['configured', 'superseded'];
DEFINE FIELD request_hash ON growth_configuration_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD payload_json ON growth_configuration_event TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD actor_user_id ON growth_configuration_event TYPE string;
DEFINE FIELD created_at ON growth_configuration_event TYPE datetime;
DEFINE INDEX growth_configuration_event_id ON growth_configuration_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX growth_configuration_event_command ON growth_configuration_event FIELDS organization_id, command_id, event_type UNIQUE;
DEFINE EVENT growth_configuration_event_immutable ON TABLE growth_configuration_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'Growth configuration event는 immutable입니다';
};
`,
);

export const GROWTH_PROMPT_MEMORY_MIGRATION = defineMigration(
  "0052-growth-prompt-memory",
  `
DEFINE TABLE prompt_definition_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD prompt_definition_version_id ON prompt_definition_version TYPE string;
DEFINE FIELD organization_id ON prompt_definition_version TYPE string;
DEFINE FIELD version ON prompt_definition_version TYPE int ASSERT $value >= 1;
DEFINE FIELD parent_version_id ON prompt_definition_version TYPE option<string>;
DEFINE FIELD status ON prompt_definition_version TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD sections_json ON prompt_definition_version TYPE string ASSERT string::len($value) <= 1048576;
DEFINE FIELD checksum ON prompt_definition_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON prompt_definition_version TYPE string;
DEFINE FIELD request_hash ON prompt_definition_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD active_guard_key ON prompt_definition_version TYPE option<string>;
DEFINE FIELD created_by_user_id ON prompt_definition_version TYPE string;
DEFINE FIELD created_at ON prompt_definition_version TYPE datetime;
DEFINE FIELD superseded_at ON prompt_definition_version TYPE option<datetime>;
DEFINE INDEX prompt_definition_id ON prompt_definition_version FIELDS organization_id, prompt_definition_version_id UNIQUE;
DEFINE INDEX prompt_definition_number ON prompt_definition_version FIELDS organization_id, version UNIQUE;
DEFINE INDEX prompt_definition_command ON prompt_definition_version FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX prompt_definition_active ON prompt_definition_version FIELDS active_guard_key UNIQUE;
DEFINE EVENT prompt_definition_invariant ON TABLE prompt_definition_version
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' { THROW 'PromptDefinitionVersion은 immutable입니다'; };
  IF !(
    $before.status = 'active' AND $after.status = 'superseded' AND
    $after.active_guard_key = NONE AND $after.superseded_at != NONE AND
    $after.prompt_definition_version_id = $before.prompt_definition_version_id AND
    $after.organization_id = $before.organization_id AND $after.version = $before.version AND
    $after.parent_version_id = $before.parent_version_id AND $after.sections_json = $before.sections_json AND
    $after.checksum = $before.checksum AND $after.command_id = $before.command_id AND
    $after.request_hash = $before.request_hash AND $after.created_by_user_id = $before.created_by_user_id AND
    $after.created_at = $before.created_at
  ) { THROW 'PromptDefinitionVersion의 내용은 immutable입니다'; };
};

DEFINE TABLE memory_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD memory_version_id ON memory_version TYPE string;
DEFINE FIELD organization_id ON memory_version TYPE string;
DEFINE FIELD scope ON memory_version TYPE string ASSERT $value IN ['organization', 'user', 'agent'];
DEFINE FIELD subject_id ON memory_version TYPE string;
DEFINE FIELD subject_key ON memory_version TYPE string;
DEFINE FIELD version ON memory_version TYPE int ASSERT $value >= 1;
DEFINE FIELD parent_version_id ON memory_version TYPE option<string>;
DEFINE FIELD status ON memory_version TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD entries_json ON memory_version TYPE string ASSERT string::len($value) <= 1048576;
DEFINE FIELD checksum ON memory_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON memory_version TYPE string;
DEFINE FIELD request_hash ON memory_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD active_guard_key ON memory_version TYPE option<string>;
DEFINE FIELD created_by_user_id ON memory_version TYPE string;
DEFINE FIELD created_at ON memory_version TYPE datetime;
DEFINE FIELD superseded_at ON memory_version TYPE option<datetime>;
DEFINE INDEX memory_version_id ON memory_version FIELDS organization_id, memory_version_id UNIQUE;
DEFINE INDEX memory_version_number ON memory_version FIELDS organization_id, subject_key, version UNIQUE;
DEFINE INDEX memory_version_command ON memory_version FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX memory_version_active ON memory_version FIELDS active_guard_key UNIQUE;
DEFINE EVENT memory_version_invariant ON TABLE memory_version
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' { THROW 'MemoryVersion은 immutable입니다'; };
  IF !(
    $before.status = 'active' AND $after.status = 'superseded' AND
    $after.active_guard_key = NONE AND $after.superseded_at != NONE AND
    $after.memory_version_id = $before.memory_version_id AND $after.organization_id = $before.organization_id AND
    $after.scope = $before.scope AND $after.subject_id = $before.subject_id AND $after.subject_key = $before.subject_key AND
    $after.version = $before.version AND $after.parent_version_id = $before.parent_version_id AND
    $after.entries_json = $before.entries_json AND $after.checksum = $before.checksum AND
    $after.command_id = $before.command_id AND $after.request_hash = $before.request_hash AND
    $after.created_by_user_id = $before.created_by_user_id AND $after.created_at = $before.created_at
  ) { THROW 'MemoryVersion의 내용은 immutable입니다'; };
};

DEFINE TABLE prompt_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD prompt_version_id ON prompt_version TYPE string;
DEFINE FIELD organization_id ON prompt_version TYPE string;
DEFINE FIELD work_id ON prompt_version TYPE string;
DEFINE FIELD requester_user_id ON prompt_version TYPE string;
DEFINE FIELD schema_version ON prompt_version TYPE string ASSERT $value = 'massion.work.prompt.v1';
DEFINE FIELD composer_version ON prompt_version TYPE string;
DEFINE FIELD prompt_definition_version_id ON prompt_version TYPE string;
DEFINE FIELD prompt_definition_checksum ON prompt_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD organization_version_id ON prompt_version TYPE string;
DEFINE FIELD organization_checksum ON prompt_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD context_version_id ON prompt_version TYPE option<string>;
DEFINE FIELD context_checksum ON prompt_version TYPE option<string>;
DEFINE FIELD policy_version_id ON prompt_version TYPE option<string>;
DEFINE FIELD policy_checksum ON prompt_version TYPE option<string>;
DEFINE FIELD memory_version_ids ON prompt_version TYPE array<string>;
DEFINE FIELD memory_checksums ON prompt_version TYPE array<string>;
DEFINE FIELD agent_sections_json ON prompt_version TYPE string ASSERT string::len($value) <= 1048576;
DEFINE FIELD checksum ON prompt_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON prompt_version TYPE datetime;
DEFINE INDEX prompt_version_id ON prompt_version FIELDS organization_id, prompt_version_id UNIQUE;
DEFINE INDEX prompt_version_work ON prompt_version FIELDS organization_id, work_id UNIQUE;
DEFINE EVENT prompt_version_immutable ON TABLE prompt_version WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'PromptVersion은 immutable입니다'; };

DEFINE TABLE prompt_definition_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON prompt_definition_event TYPE string;
DEFINE FIELD organization_id ON prompt_definition_event TYPE string;
DEFINE FIELD version_id ON prompt_definition_event TYPE string;
DEFINE FIELD command_id ON prompt_definition_event TYPE string;
DEFINE FIELD event_type ON prompt_definition_event TYPE string;
DEFINE FIELD created_at ON prompt_definition_event TYPE datetime;
DEFINE INDEX prompt_definition_event_id ON prompt_definition_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT prompt_definition_event_immutable ON TABLE prompt_definition_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'PromptDefinition event는 immutable입니다'; };

DEFINE TABLE memory_version_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON memory_version_event TYPE string;
DEFINE FIELD organization_id ON memory_version_event TYPE string;
DEFINE FIELD version_id ON memory_version_event TYPE string;
DEFINE FIELD command_id ON memory_version_event TYPE string;
DEFINE FIELD event_type ON memory_version_event TYPE string;
DEFINE FIELD created_at ON memory_version_event TYPE datetime;
DEFINE INDEX memory_version_event_id ON memory_version_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT memory_version_event_immutable ON TABLE memory_version_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'MemoryVersion event는 immutable입니다'; };

DEFINE TABLE prompt_version_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON prompt_version_event TYPE string;
DEFINE FIELD organization_id ON prompt_version_event TYPE string;
DEFINE FIELD version_id ON prompt_version_event TYPE string;
DEFINE FIELD command_id ON prompt_version_event TYPE string;
DEFINE FIELD event_type ON prompt_version_event TYPE string;
DEFINE FIELD created_at ON prompt_version_event TYPE datetime;
DEFINE INDEX prompt_version_event_id ON prompt_version_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT prompt_version_event_immutable ON TABLE prompt_version_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'PromptVersion event는 immutable입니다'; };
`,
);

export const GROWTH_REFLECTION_MIGRATION = defineMigration(
  "0056-growth-reflection",
  `
DEFINE TABLE growth_trigger SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD trigger_id ON growth_trigger TYPE string;
DEFINE FIELD organization_id ON growth_trigger TYPE string;
DEFINE FIELD work_id ON growth_trigger TYPE string;
DEFINE FIELD records_run_id ON growth_trigger TYPE string;
DEFINE FIELD work_record_id ON growth_trigger TYPE string;
DEFINE FIELD verification_id ON growth_trigger TYPE string;
DEFINE FIELD assurance_run_id ON growth_trigger TYPE string;
DEFINE FIELD requester_user_id ON growth_trigger TYPE string;
DEFINE FIELD status ON growth_trigger TYPE string ASSERT $value IN ['pending', 'claimed', 'completed', 'skipped', 'blocked'];
DEFINE FIELD configuration_version_id ON growth_trigger TYPE option<string>;
DEFINE FIELD worker_id ON growth_trigger TYPE option<string>;
DEFINE FIELD lease_expires_at ON growth_trigger TYPE option<datetime>;
DEFINE FIELD skip_reason ON growth_trigger TYPE option<string>;
DEFINE FIELD created_at ON growth_trigger TYPE datetime;
DEFINE FIELD updated_at ON growth_trigger TYPE datetime;
DEFINE INDEX growth_trigger_id ON growth_trigger FIELDS organization_id, trigger_id UNIQUE;
DEFINE INDEX growth_trigger_records_run ON growth_trigger FIELDS organization_id, records_run_id UNIQUE;
DEFINE INDEX growth_trigger_status ON growth_trigger FIELDS organization_id, status, created_at;

DEFINE TABLE reflection_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD reflection_run_id ON reflection_run TYPE string;
DEFINE FIELD organization_id ON reflection_run TYPE string;
DEFINE FIELD work_id ON reflection_run TYPE string;
DEFINE FIELD records_run_id ON reflection_run TYPE string;
DEFINE FIELD trigger_id ON reflection_run TYPE string;
DEFINE FIELD configuration_version_id ON reflection_run TYPE string;
DEFINE FIELD runtime_execution_id ON reflection_run TYPE option<string>;
DEFINE FIELD snapshot_hash ON reflection_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD status ON reflection_run TYPE string ASSERT $value IN ['planned', 'generating', 'validated', 'completed', 'blocked', 'cancelled'];
DEFINE FIELD version ON reflection_run TYPE int ASSERT $value >= 1;
DEFINE FIELD attempt ON reflection_run TYPE int ASSERT $value >= 1;
DEFINE FIELD command_id ON reflection_run TYPE string;
DEFINE FIELD request_hash ON reflection_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD failure_json ON reflection_run TYPE option<string>;
DEFINE FIELD created_at ON reflection_run TYPE datetime;
DEFINE FIELD updated_at ON reflection_run TYPE datetime;
DEFINE INDEX reflection_run_id ON reflection_run FIELDS organization_id, reflection_run_id UNIQUE;
DEFINE INDEX reflection_run_trigger ON reflection_run FIELDS organization_id, trigger_id, attempt UNIQUE;

DEFINE TABLE growth_suggestion SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD suggestion_id ON growth_suggestion TYPE string;
DEFINE FIELD organization_id ON growth_suggestion TYPE string;
DEFINE FIELD work_id ON growth_suggestion TYPE string;
DEFINE FIELD reflection_run_id ON growth_suggestion TYPE string;
DEFINE FIELD target_kind ON growth_suggestion TYPE string ASSERT $value IN ['prompt', 'memory', 'policy', 'organization'];
DEFINE FIELD operation ON growth_suggestion TYPE string;
DEFINE FIELD patch_json ON growth_suggestion TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD summary ON growth_suggestion TYPE string ASSERT string::len($value) <= 2000;
DEFINE FIELD rationale ON growth_suggestion TYPE string ASSERT string::len($value) <= 2000;
DEFINE FIELD expected_effect ON growth_suggestion TYPE string ASSERT string::len($value) <= 2000;
DEFINE FIELD risk_summary ON growth_suggestion TYPE string ASSERT string::len($value) <= 2000;
DEFINE FIELD source_reference_ids ON growth_suggestion TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD status ON growth_suggestion TYPE string ASSERT $value IN ['proposed', 'evaluated', 'awaiting-review', 'adopted', 'rejected', 'superseded'];
DEFINE FIELD created_at ON growth_suggestion TYPE datetime;
DEFINE INDEX growth_suggestion_id ON growth_suggestion FIELDS organization_id, suggestion_id UNIQUE;
DEFINE EVENT growth_suggestion_invariant ON TABLE growth_suggestion
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' { THROW 'Growth Suggestion은 삭제할 수 없습니다'; };
  IF $after.suggestion_id != $before.suggestion_id OR $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR $after.reflection_run_id != $before.reflection_run_id OR
    $after.target_kind != $before.target_kind OR $after.operation != $before.operation OR
    $after.patch_json != $before.patch_json OR $after.summary != $before.summary OR
    $after.rationale != $before.rationale OR $after.expected_effect != $before.expected_effect OR
    $after.risk_summary != $before.risk_summary OR $after.source_reference_ids != $before.source_reference_ids OR
    $after.created_at != $before.created_at {
    THROW 'Growth Suggestion 내용은 immutable입니다';
  };
};

DEFINE TABLE growth_source_reference SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD source_reference_id ON growth_source_reference TYPE string;
DEFINE FIELD organization_id ON growth_source_reference TYPE string;
DEFINE FIELD work_id ON growth_source_reference TYPE string;
DEFINE FIELD suggestion_id ON growth_source_reference TYPE string;
DEFINE FIELD source_kind ON growth_source_reference TYPE string;
DEFINE FIELD source_id ON growth_source_reference TYPE string;
DEFINE FIELD source_checksum ON growth_source_reference TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD captured_revision ON growth_source_reference TYPE string;
DEFINE FIELD created_at ON growth_source_reference TYPE datetime;
DEFINE INDEX growth_source_reference_id ON growth_source_reference FIELDS organization_id, source_reference_id UNIQUE;
DEFINE INDEX growth_source_reference_unique ON growth_source_reference FIELDS organization_id, suggestion_id, source_kind, source_id UNIQUE;
DEFINE EVENT growth_source_reference_immutable ON TABLE growth_source_reference WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth source reference는 immutable입니다'; };

DEFINE TABLE growth_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON growth_event TYPE string;
DEFINE FIELD organization_id ON growth_event TYPE string;
DEFINE FIELD aggregate_type ON growth_event TYPE string;
DEFINE FIELD aggregate_id ON growth_event TYPE string;
DEFINE FIELD event_type ON growth_event TYPE string;
DEFINE FIELD payload_json ON growth_event TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD created_at ON growth_event TYPE datetime;
DEFINE INDEX growth_event_id ON growth_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT growth_event_immutable ON TABLE growth_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth event는 immutable입니다'; };

DEFINE EVENT growth_trigger_on_records_completed ON TABLE records_run
WHEN $event = 'UPDATE' AND $before.status != 'completed' AND $after.status = 'completed'
THEN {
  LET $records = (SELECT work_record_id FROM work_record WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND records_run_id = $after.records_run_id AND finalized = true AND schema_version = 'massion.work-record.v1' LIMIT 1);
  LET $works = (SELECT request_id FROM work WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND status = 'completed' LIMIT 1);
  IF array::len($records) = 1 AND array::len($works) = 1 {
    LET $requests = (SELECT requester_user_id FROM work_request WHERE organization_id = $after.organization_id AND request_id = $works[0].request_id LIMIT 1);
    IF array::len($requests) = 1 {
      CREATE growth_trigger CONTENT {
        trigger_id: crypto::sha256(string::concat($after.organization_id, '|', $after.records_run_id)),
        organization_id: $after.organization_id,
        work_id: $after.work_id,
        records_run_id: $after.records_run_id,
        work_record_id: $records[0].work_record_id,
        verification_id: $after.verification_id,
        assurance_run_id: $after.assurance_run_id,
        requester_user_id: $requests[0].requester_user_id,
        status: 'pending',
        created_at: time::now(),
        updated_at: time::now()
      };
    };
  };
};
`,
);

export const GROWTH_EVALUATION_MIGRATION = defineMigration(
  "0057-growth-evaluation",
  `
DEFINE TABLE growth_evaluation_strategy_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD strategy_version_id ON growth_evaluation_strategy_version TYPE string;
DEFINE FIELD organization_id ON growth_evaluation_strategy_version TYPE string;
DEFINE FIELD version ON growth_evaluation_strategy_version TYPE int ASSERT $value >= 1;
DEFINE FIELD parent_version_id ON growth_evaluation_strategy_version TYPE option<string>;
DEFINE FIELD status ON growth_evaluation_strategy_version TYPE string ASSERT $value IN ['active', 'superseded'];
DEFINE FIELD strategy_json ON growth_evaluation_strategy_version TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD checksum ON growth_evaluation_strategy_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD governance_decision_id ON growth_evaluation_strategy_version TYPE string;
DEFINE FIELD command_id ON growth_evaluation_strategy_version TYPE string;
DEFINE FIELD request_hash ON growth_evaluation_strategy_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD active_guard_key ON growth_evaluation_strategy_version TYPE option<string>;
DEFINE FIELD created_at ON growth_evaluation_strategy_version TYPE datetime;
DEFINE FIELD superseded_at ON growth_evaluation_strategy_version TYPE option<datetime>;
DEFINE INDEX growth_strategy_id ON growth_evaluation_strategy_version FIELDS organization_id, strategy_version_id UNIQUE;
DEFINE INDEX growth_strategy_version ON growth_evaluation_strategy_version FIELDS organization_id, version UNIQUE;
DEFINE INDEX growth_strategy_command ON growth_evaluation_strategy_version FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_strategy_active ON growth_evaluation_strategy_version FIELDS active_guard_key UNIQUE;
DEFINE EVENT growth_evaluation_strategy_invariant ON TABLE growth_evaluation_strategy_version
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' { THROW 'Growth EvaluationStrategy는 삭제할 수 없습니다'; };
  IF !($before.status = 'active' AND $after.status = 'superseded' AND $after.active_guard_key = NONE AND $after.superseded_at != NONE) {
    THROW 'Growth EvaluationStrategy 상태 전이가 유효하지 않습니다';
  };
  IF $after.strategy_version_id != $before.strategy_version_id OR $after.organization_id != $before.organization_id OR
    $after.version != $before.version OR $after.parent_version_id != $before.parent_version_id OR
    $after.strategy_json != $before.strategy_json OR $after.checksum != $before.checksum OR
    $after.governance_decision_id != $before.governance_decision_id OR $after.command_id != $before.command_id OR
    $after.request_hash != $before.request_hash OR $after.created_at != $before.created_at {
    THROW 'Growth EvaluationStrategy 내용은 immutable입니다';
  };
};

DEFINE TABLE growth_signal_receipt SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD receipt_id ON growth_signal_receipt TYPE string;
DEFINE FIELD organization_id ON growth_signal_receipt TYPE string;
DEFINE FIELD suggestion_id ON growth_signal_receipt TYPE string;
DEFINE FIELD signal_id ON growth_signal_receipt TYPE string;
DEFINE FIELD signal_group ON growth_signal_receipt TYPE string ASSERT $value IN ['required', 'supporting', 'conflict'];
DEFINE FIELD origin ON growth_signal_receipt TYPE string ASSERT $value IN ['deterministic', 'independent', 'model-self'];
DEFINE FIELD adapter_id ON growth_signal_receipt TYPE string;
DEFINE FIELD adapter_version ON growth_signal_receipt TYPE string;
DEFINE FIELD outcome ON growth_signal_receipt TYPE string ASSERT $value IN ['passed', 'failed', 'unavailable'];
DEFINE FIELD score ON growth_signal_receipt TYPE number;
DEFINE FIELD unit ON growth_signal_receipt TYPE string;
DEFINE FIELD source_id ON growth_signal_receipt TYPE string;
DEFINE FIELD source_checksum ON growth_signal_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD fresh ON growth_signal_receipt TYPE bool;
DEFINE FIELD evidence_json ON growth_signal_receipt TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD command_id ON growth_signal_receipt TYPE string;
DEFINE FIELD request_hash ON growth_signal_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON growth_signal_receipt TYPE datetime;
DEFINE INDEX growth_signal_receipt_id ON growth_signal_receipt FIELDS organization_id, receipt_id UNIQUE;
DEFINE INDEX growth_signal_command ON growth_signal_receipt FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_signal_identity ON growth_signal_receipt FIELDS organization_id, suggestion_id, signal_id, adapter_id, adapter_version UNIQUE;
DEFINE EVENT growth_signal_receipt_immutable ON TABLE growth_signal_receipt WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth signal receipt는 immutable입니다'; };

DEFINE TABLE growth_evaluation_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD evaluation_run_id ON growth_evaluation_run TYPE string;
DEFINE FIELD organization_id ON growth_evaluation_run TYPE string;
DEFINE FIELD suggestion_id ON growth_evaluation_run TYPE string;
DEFINE FIELD strategy_version_id ON growth_evaluation_run TYPE string;
DEFINE FIELD receipt_ids ON growth_evaluation_run TYPE array<string>;
DEFINE FIELD input_hash ON growth_evaluation_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD outcome ON growth_evaluation_run TYPE string ASSERT $value IN ['eligible', 'ineligible', 'blocked'];
DEFINE FIELD reason_json ON growth_evaluation_run TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD command_id ON growth_evaluation_run TYPE string;
DEFINE FIELD request_hash ON growth_evaluation_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON growth_evaluation_run TYPE datetime;
DEFINE INDEX growth_evaluation_run_id ON growth_evaluation_run FIELDS organization_id, evaluation_run_id UNIQUE;
DEFINE INDEX growth_evaluation_command ON growth_evaluation_run FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_evaluation_suggestion ON growth_evaluation_run FIELDS organization_id, suggestion_id, strategy_version_id;
DEFINE EVENT growth_evaluation_run_immutable ON TABLE growth_evaluation_run WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth evaluation run은 immutable입니다'; };
`,
);

export const GROWTH_ADOPTION_MIGRATION = defineMigration(
  "0058-growth-adoption",
  `
DEFINE TABLE growth_adoption_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD adoption_id ON growth_adoption_run TYPE string;
DEFINE FIELD organization_id ON growth_adoption_run TYPE string;
DEFINE FIELD suggestion_id ON growth_adoption_run TYPE string;
DEFINE FIELD target_kind ON growth_adoption_run TYPE string ASSERT $value IN ['prompt', 'memory', 'policy', 'organization'];
DEFINE FIELD evaluation_run_id ON growth_adoption_run TYPE string;
DEFINE FIELD evaluation_input_hash ON growth_adoption_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD configuration_version_id ON growth_adoption_run TYPE string;
DEFINE FIELD runtime_execution_id ON growth_adoption_run TYPE string;
DEFINE FIELD before_version_id ON growth_adoption_run TYPE string;
DEFINE FIELD before_checksum ON growth_adoption_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD after_version_id ON growth_adoption_run TYPE option<string>;
DEFINE FIELD after_checksum ON growth_adoption_run TYPE option<string>;
DEFINE FIELD governance_decision_id ON growth_adoption_run TYPE option<string>;
DEFINE FIELD approval_id ON growth_adoption_run TYPE option<string>;
DEFINE FIELD status ON growth_adoption_run TYPE string ASSERT $value IN ['awaiting-review', 'observing', 'rejected', 'reverted'];
DEFINE FIELD command_id ON growth_adoption_run TYPE string;
DEFINE FIELD request_hash ON growth_adoption_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON growth_adoption_run TYPE string;
DEFINE FIELD active_target_guard ON growth_adoption_run TYPE option<string>;
DEFINE FIELD created_at ON growth_adoption_run TYPE datetime;
DEFINE FIELD updated_at ON growth_adoption_run TYPE datetime;
DEFINE INDEX growth_adoption_id ON growth_adoption_run FIELDS organization_id, adoption_id UNIQUE;
DEFINE INDEX growth_adoption_command ON growth_adoption_run FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_adoption_suggestion ON growth_adoption_run FIELDS organization_id, suggestion_id UNIQUE;
DEFINE INDEX growth_adoption_active_target ON growth_adoption_run FIELDS active_target_guard UNIQUE;

DEFINE TABLE growth_adoption_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON growth_adoption_event TYPE string;
DEFINE FIELD organization_id ON growth_adoption_event TYPE string;
DEFINE FIELD adoption_id ON growth_adoption_event TYPE string;
DEFINE FIELD event_type ON growth_adoption_event TYPE string;
DEFINE FIELD payload_json ON growth_adoption_event TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD created_at ON growth_adoption_event TYPE datetime;
DEFINE INDEX growth_adoption_event_id ON growth_adoption_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT growth_adoption_event_immutable ON TABLE growth_adoption_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth Adoption event는 immutable입니다'; };

DEFINE TABLE growth_effect_baseline SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD baseline_id ON growth_effect_baseline TYPE string;
DEFINE FIELD organization_id ON growth_effect_baseline TYPE string;
DEFINE FIELD adoption_id ON growth_effect_baseline TYPE string;
DEFINE FIELD suggestion_id ON growth_effect_baseline TYPE string;
DEFINE FIELD target_kind ON growth_effect_baseline TYPE string ASSERT $value IN ['prompt', 'memory', 'policy', 'organization'];
DEFINE FIELD target_version_id ON growth_effect_baseline TYPE string;
DEFINE FIELD status ON growth_effect_baseline TYPE string ASSERT $value IN ['pending', 'captured', 'closed'];
DEFINE FIELD metrics_json ON growth_effect_baseline TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD checksum ON growth_effect_baseline TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON growth_effect_baseline TYPE datetime;
DEFINE INDEX growth_effect_baseline_id ON growth_effect_baseline FIELDS organization_id, baseline_id UNIQUE;
DEFINE INDEX growth_effect_baseline_adoption ON growth_effect_baseline FIELDS organization_id, adoption_id UNIQUE;
`,
);

export const GROWTH_EFFECT_REVERT_MIGRATION = defineMigration(
  "0059-growth-effect-revert",
  `
DEFINE FIELD contract_json ON growth_effect_baseline TYPE option<string>;
DEFINE FIELD captured_at ON growth_effect_baseline TYPE option<datetime>;
DEFINE FIELD exposure_status ON growth_adoption_run TYPE option<string> ASSERT $value = NONE OR $value IN ['active', 'suspended', 'reverted'];

DEFINE TABLE growth_effect_observation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD observation_id ON growth_effect_observation TYPE string;
DEFINE FIELD organization_id ON growth_effect_observation TYPE string;
DEFINE FIELD adoption_id ON growth_effect_observation TYPE string;
DEFINE FIELD score ON growth_effect_observation TYPE number;
DEFINE FIELD observation_count ON growth_effect_observation TYPE int ASSERT $value >= 0;
DEFINE FIELD contract_json ON growth_effect_observation TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD contract_checksum ON growth_effect_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON growth_effect_observation TYPE string;
DEFINE FIELD request_hash ON growth_effect_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON growth_effect_observation TYPE datetime;
DEFINE INDEX growth_effect_observation_id ON growth_effect_observation FIELDS organization_id, observation_id UNIQUE;
DEFINE INDEX growth_effect_observation_command ON growth_effect_observation FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT growth_effect_observation_immutable ON TABLE growth_effect_observation WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth effect observation은 immutable입니다'; };

DEFINE TABLE growth_effect_evaluation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD effect_evaluation_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD organization_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD adoption_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD baseline_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD observation_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD result ON growth_effect_evaluation TYPE string ASSERT $value IN ['improved', 'stable', 'degraded', 'inconclusive'];
DEFINE FIELD comparison_json ON growth_effect_evaluation TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD command_id ON growth_effect_evaluation TYPE string;
DEFINE FIELD request_hash ON growth_effect_evaluation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON growth_effect_evaluation TYPE datetime;
DEFINE INDEX growth_effect_evaluation_id ON growth_effect_evaluation FIELDS organization_id, effect_evaluation_id UNIQUE;
DEFINE INDEX growth_effect_evaluation_command ON growth_effect_evaluation FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT growth_effect_evaluation_immutable ON TABLE growth_effect_evaluation WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Growth effect evaluation은 immutable입니다'; };

DEFINE TABLE growth_revert_operation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD revert_operation_id ON growth_revert_operation TYPE string;
DEFINE FIELD organization_id ON growth_revert_operation TYPE string;
DEFINE FIELD adoption_id ON growth_revert_operation TYPE string;
DEFINE FIELD suggestion_id ON growth_revert_operation TYPE string;
DEFINE FIELD target_kind ON growth_revert_operation TYPE string ASSERT $value IN ['prompt', 'memory', 'policy', 'organization'];
DEFINE FIELD mode ON growth_revert_operation TYPE string ASSERT $value IN ['auto', 'review', 'explicit'];
DEFINE FIELD before_version_id ON growth_revert_operation TYPE string;
DEFINE FIELD expected_after_version_id ON growth_revert_operation TYPE string;
DEFINE FIELD expected_after_checksum ON growth_revert_operation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD reverted_version_id ON growth_revert_operation TYPE option<string>;
DEFINE FIELD preview_json ON growth_revert_operation TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD preview_checksum ON growth_revert_operation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD governance_decision_id ON growth_revert_operation TYPE option<string>;
DEFINE FIELD approval_id ON growth_revert_operation TYPE option<string>;
DEFINE FIELD status ON growth_revert_operation TYPE string ASSERT $value IN ['awaiting-review', 'completed', 'rejected', 'blocked'];
DEFINE FIELD command_id ON growth_revert_operation TYPE string;
DEFINE FIELD request_hash ON growth_revert_operation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_by_user_id ON growth_revert_operation TYPE string;
DEFINE FIELD created_at ON growth_revert_operation TYPE datetime;
DEFINE FIELD updated_at ON growth_revert_operation TYPE datetime;
DEFINE INDEX growth_revert_operation_id ON growth_revert_operation FIELDS organization_id, revert_operation_id UNIQUE;
DEFINE INDEX growth_revert_operation_command ON growth_revert_operation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX growth_revert_operation_adoption ON growth_revert_operation FIELDS organization_id, adoption_id UNIQUE;
`,
);
