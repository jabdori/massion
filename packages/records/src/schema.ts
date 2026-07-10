import { defineMigration } from "@massion/storage";

export const RECORDS_DOCUMENTATION_MIGRATION = defineMigration(
  "0047-records-documentation",
  `
DEFINE TABLE records_run SCHEMAFULL;
DEFINE FIELD records_run_id ON records_run TYPE string;
DEFINE FIELD organization_id ON records_run TYPE string;
DEFINE FIELD work_id ON records_run TYPE string;
DEFINE FIELD target_work_revision ON records_run TYPE int ASSERT $value >= 1;
DEFINE FIELD verification_id ON records_run TYPE string;
DEFINE FIELD assurance_run_id ON records_run TYPE string;
DEFINE FIELD snapshot_hash ON records_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD renderer_version ON records_run TYPE string;
DEFINE FIELD status ON records_run TYPE string ASSERT $value IN ['planned', 'rendering', 'finalized', 'completed', 'blocked', 'cancelled'];
DEFINE FIELD version ON records_run TYPE int ASSERT $value >= 1;
DEFINE FIELD attempt ON records_run TYPE int ASSERT $value >= 1;
DEFINE FIELD command_id ON records_run TYPE string;
DEFINE FIELD request_hash ON records_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD active_guard_key ON records_run TYPE option<string>;
DEFINE FIELD failure_json ON records_run TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 4000;
DEFINE FIELD created_by_user_id ON records_run TYPE string;
DEFINE FIELD started_at ON records_run TYPE datetime;
DEFINE FIELD completed_at ON records_run TYPE option<datetime>;
DEFINE FIELD updated_at ON records_run TYPE datetime;
DEFINE INDEX records_run_id ON records_run FIELDS records_run_id UNIQUE;
DEFINE INDEX records_run_active_guard ON records_run FIELDS active_guard_key UNIQUE;
DEFINE INDEX records_run_command ON records_run FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX records_run_attempt ON records_run FIELDS organization_id, work_id, target_work_revision, attempt UNIQUE;
DEFINE INDEX records_run_work ON records_run FIELDS organization_id, work_id, target_work_revision;
DEFINE EVENT records_run_state_invariant ON TABLE records_run
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.status IN ['planned', 'rendering', 'finalized'] AND $after.active_guard_key != NONE AND $after.completed_at = NONE AND $after.failure_json = NONE) OR
    ($after.status IN ['completed', 'cancelled'] AND $after.active_guard_key = NONE AND $after.completed_at != NONE AND $after.failure_json = NONE) OR
    ($after.status = 'blocked' AND $after.active_guard_key = NONE AND $after.completed_at != NONE AND $after.failure_json != NONE)
  ) {
    THROW 'Records run 상태 metadata 불변식 위반';
  };
  IF $event = 'CREATE' AND $after.version != 1 {
    THROW 'Records run은 version 1로 생성해야 합니다';
  };
  IF $event = 'UPDATE' AND $after.version != $before.version + 1 {
    THROW 'Records run version은 한 번에 1만 증가해야 합니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['completed', 'blocked', 'cancelled'] {
    THROW 'Terminal Records run은 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND (
    $after.records_run_id != $before.records_run_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.target_work_revision != $before.target_work_revision OR
    $after.verification_id != $before.verification_id OR
    $after.assurance_run_id != $before.assurance_run_id OR
    $after.snapshot_hash != $before.snapshot_hash OR
    $after.renderer_version != $before.renderer_version OR
    $after.attempt != $before.attempt OR
    $after.command_id != $before.command_id OR
    $after.request_hash != $before.request_hash OR
    $after.created_by_user_id != $before.created_by_user_id OR
    $after.started_at != $before.started_at
  ) {
    THROW 'Records run identity field는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'planned' AND $after.status IN ['rendering', 'blocked', 'cancelled']) OR
    ($before.status = 'rendering' AND $after.status IN ['finalized', 'blocked', 'cancelled']) OR
    ($before.status = 'finalized' AND $after.status IN ['completed', 'blocked', 'cancelled'])
  ) {
    THROW '허용되지 않은 Records run 상태 전이';
  };
};

DEFINE TABLE records_event SCHEMAFULL;
DEFINE FIELD event_id ON records_event TYPE string;
DEFINE FIELD organization_id ON records_event TYPE string;
DEFINE FIELD work_id ON records_event TYPE string;
DEFINE FIELD records_run_id ON records_event TYPE string;
DEFINE FIELD command_id ON records_event TYPE string;
DEFINE FIELD sequence ON records_event TYPE int ASSERT $value >= 1;
DEFINE FIELD event_type ON records_event TYPE string;
DEFINE FIELD request_hash ON records_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD payload_json ON records_event TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD actor_user_id ON records_event TYPE string;
DEFINE FIELD created_at ON records_event TYPE datetime;
DEFINE INDEX records_event_id ON records_event FIELDS event_id UNIQUE;
DEFINE INDEX records_event_sequence ON records_event FIELDS organization_id, records_run_id, sequence UNIQUE;
DEFINE INDEX records_event_command ON records_event FIELDS organization_id, records_run_id, command_id, event_type UNIQUE;
DEFINE EVENT records_event_immutable ON TABLE records_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'Records event는 immutable입니다';
};

DEFINE TABLE documentation_impact_proposal SCHEMAFULL;
DEFINE FIELD proposal_id ON documentation_impact_proposal TYPE string;
DEFINE FIELD organization_id ON documentation_impact_proposal TYPE string;
DEFINE FIELD work_id ON documentation_impact_proposal TYPE string;
DEFINE FIELD records_run_id ON documentation_impact_proposal TYPE string;
DEFINE FIELD kind ON documentation_impact_proposal TYPE string ASSERT $value IN ['decision', 'user-visible', 'operational', 'reference'];
DEFINE FIELD rule_hint ON documentation_impact_proposal TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD reason ON documentation_impact_proposal TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 2000;
DEFINE FIELD source_reference_ids ON documentation_impact_proposal TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD created_at ON documentation_impact_proposal TYPE datetime;
DEFINE INDEX documentation_impact_proposal_id ON documentation_impact_proposal FIELDS proposal_id UNIQUE;
DEFINE INDEX documentation_impact_proposal_run ON documentation_impact_proposal FIELDS organization_id, records_run_id;
DEFINE EVENT documentation_impact_proposal_immutable ON TABLE documentation_impact_proposal
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'Documentation impact proposal은 immutable입니다';
};

DEFINE TABLE documentation_impact_assessment SCHEMAFULL;
DEFINE FIELD assessment_id ON documentation_impact_assessment TYPE string;
DEFINE FIELD organization_id ON documentation_impact_assessment TYPE string;
DEFINE FIELD work_id ON documentation_impact_assessment TYPE string;
DEFINE FIELD records_run_id ON documentation_impact_assessment TYPE string;
DEFINE FIELD kind ON documentation_impact_assessment TYPE string ASSERT $value IN ['work-record', 'adr', 'changelog', 'runbook'];
DEFINE FIELD outcome ON documentation_impact_assessment TYPE string ASSERT $value IN ['required', 'not-applicable'];
DEFINE FIELD rule_id ON documentation_impact_assessment TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD reason ON documentation_impact_assessment TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 2000;
DEFINE FIELD source_reference_ids ON documentation_impact_assessment TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD evaluator_version ON documentation_impact_assessment TYPE string;
DEFINE FIELD created_at ON documentation_impact_assessment TYPE datetime;
DEFINE INDEX documentation_impact_assessment_id ON documentation_impact_assessment FIELDS assessment_id UNIQUE;
DEFINE INDEX documentation_impact_assessment_kind ON documentation_impact_assessment FIELDS organization_id, records_run_id, kind UNIQUE;
DEFINE EVENT documentation_impact_assessment_invariant ON TABLE documentation_impact_assessment
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'Documentation impact assessment는 immutable입니다';
  };
  IF $after.kind = 'work-record' AND $after.outcome != 'required' {
    THROW 'WorkRecord impact assessment는 항상 required입니다';
  };
  IF $after.outcome = 'required' AND array::len($after.source_reference_ids) = 0 {
    THROW 'Required documentation에는 source reference가 필요합니다';
  };
};

DEFINE TABLE records_document SCHEMAFULL;
DEFINE FIELD document_id ON records_document TYPE string;
DEFINE FIELD organization_id ON records_document TYPE string;
DEFINE FIELD work_id ON records_document TYPE string;
DEFINE FIELD records_run_id ON records_document TYPE string;
DEFINE FIELD kind ON records_document TYPE string ASSERT $value IN ['adr', 'changelog', 'runbook'];
DEFINE FIELD schema_version ON records_document TYPE string;
DEFINE FIELD renderer_version ON records_document TYPE string;
DEFINE FIELD source_json ON records_document TYPE string ASSERT string::len($value) <= 1048576;
DEFINE FIELD source_checksum ON records_document TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD markdown_checksum ON records_document TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD artifact_version_id ON records_document TYPE string;
DEFINE FIELD created_at ON records_document TYPE datetime;
DEFINE INDEX records_document_identity ON records_document FIELDS organization_id, document_id UNIQUE;
DEFINE INDEX records_document_run_kind ON records_document FIELDS organization_id, records_run_id, kind UNIQUE;
DEFINE EVENT records_document_immutable ON TABLE records_document
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'Records document는 immutable입니다';
};

DEFINE TABLE records_metric_event SCHEMAFULL;
DEFINE FIELD metric_event_id ON records_metric_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD organization_id ON records_metric_event TYPE string;
DEFINE FIELD metric_name ON records_metric_event TYPE string ASSERT $value IN ['records_run_duration_ms', 'records_run_total', 'records_document_total', 'records_blocked_total', 'records_recovery_total'];
DEFINE FIELD dimensions_json ON records_metric_event TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 1000;
DEFINE FIELD numeric_value ON records_metric_event TYPE number ASSERT $value >= 0;
DEFINE FIELD occurred_at ON records_metric_event TYPE datetime;
DEFINE INDEX records_metric_event_id ON records_metric_event FIELDS metric_event_id UNIQUE;
DEFINE INDEX records_metric_event_org ON records_metric_event FIELDS organization_id, metric_name;
DEFINE EVENT records_metric_event_immutable ON TABLE records_metric_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  THROW 'Records metric event는 immutable입니다';
};
`,
);

export const RECORDS_RECOVERY_METRIC_MIGRATION = defineMigration(
  "0050-records-recovery-metric",
  `
DEFINE FIELD OVERWRITE metric_name ON records_metric_event TYPE string ASSERT $value IN ['records_run_duration_ms', 'records_run_total', 'records_document_total', 'documentation_impact_total', 'records_blocked_total', 'records_recovery_total'];
`,
);
