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
