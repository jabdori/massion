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
