import { defineMigration } from "@massion/storage";

export const ASSURANCE_RUN_MIGRATION = defineMigration(
  "0039-assurance-run",
  `
DEFINE TABLE assurance_binding_version SCHEMAFULL;
DEFINE FIELD binding_version_id ON assurance_binding_version TYPE string;
DEFINE FIELD organization_id ON assurance_binding_version TYPE string;
DEFINE FIELD work_id ON assurance_binding_version TYPE string;
DEFINE FIELD plan_version_id ON assurance_binding_version TYPE string;
DEFINE FIELD version ON assurance_binding_version TYPE int ASSERT $value >= 1;
DEFINE FIELD status ON assurance_binding_version TYPE string ASSERT $value IN ['draft', 'active', 'superseded'];
DEFINE FIELD profile_id ON assurance_binding_version TYPE string;
DEFINE FIELD profile_version ON assurance_binding_version TYPE string;
DEFINE FIELD bindings_json ON assurance_binding_version TYPE string;
DEFINE FIELD checksum ON assurance_binding_version TYPE string;
DEFINE FIELD created_by_user_id ON assurance_binding_version TYPE string;
DEFINE FIELD governance_decision_id ON assurance_binding_version TYPE option<string>;
DEFINE FIELD governance_approval_id ON assurance_binding_version TYPE option<string>;
DEFINE FIELD created_at ON assurance_binding_version TYPE datetime;
DEFINE FIELD activated_at ON assurance_binding_version TYPE option<datetime>;
DEFINE FIELD superseded_at ON assurance_binding_version TYPE option<datetime>;
DEFINE INDEX assurance_binding_version_id ON assurance_binding_version FIELDS binding_version_id UNIQUE;
DEFINE INDEX assurance_binding_work_version ON assurance_binding_version FIELDS organization_id, work_id, version UNIQUE;
DEFINE INDEX assurance_binding_work_status ON assurance_binding_version FIELDS organization_id, work_id, status;

DEFINE TABLE assurance_run SCHEMAFULL;
DEFINE FIELD assurance_run_id ON assurance_run TYPE string;
DEFINE FIELD organization_id ON assurance_run TYPE string;
DEFINE FIELD work_id ON assurance_run TYPE string;
DEFINE FIELD target_work_revision ON assurance_run TYPE int ASSERT $value >= 1;
DEFINE FIELD plan_version_id ON assurance_run TYPE string;
DEFINE FIELD binding_version_id ON assurance_run TYPE string;
DEFINE FIELD profile_id ON assurance_run TYPE string;
DEFINE FIELD profile_version ON assurance_run TYPE string;
DEFINE FIELD verifier_handle ON assurance_run TYPE string;
DEFINE FIELD verifier_execution_id ON assurance_run TYPE string;
DEFINE FIELD snapshot_hash ON assurance_run TYPE string;
DEFINE FIELD status ON assurance_run TYPE string ASSERT $value IN ['planned', 'running', 'passed', 'failed', 'blocked', 'cancelled'];
DEFINE FIELD version ON assurance_run TYPE int ASSERT $value >= 1;
DEFINE FIELD attempt ON assurance_run TYPE int ASSERT $value >= 1;
DEFINE FIELD start_command_id ON assurance_run TYPE string;
DEFINE FIELD active_guard_key ON assurance_run TYPE option<string>;
DEFINE FIELD verdict ON assurance_run TYPE option<string> ASSERT $value = NONE OR $value IN ['passed', 'failed', 'blocked'];
DEFINE FIELD projected_work_revision ON assurance_run TYPE option<int>;
DEFINE FIELD failure_json ON assurance_run TYPE option<string>;
DEFINE FIELD created_by_user_id ON assurance_run TYPE string;
DEFINE FIELD expires_at ON assurance_run TYPE datetime;
DEFINE FIELD started_at ON assurance_run TYPE datetime;
DEFINE FIELD completed_at ON assurance_run TYPE option<datetime>;
DEFINE FIELD updated_at ON assurance_run TYPE datetime;
DEFINE INDEX assurance_run_id ON assurance_run FIELDS assurance_run_id UNIQUE;
DEFINE INDEX assurance_run_start_command ON assurance_run FIELDS organization_id, start_command_id UNIQUE;
DEFINE INDEX assurance_run_active_guard ON assurance_run FIELDS active_guard_key UNIQUE;
DEFINE INDEX assurance_run_work ON assurance_run FIELDS organization_id, work_id, target_work_revision;
DEFINE INDEX assurance_run_attempt ON assurance_run FIELDS organization_id, work_id, target_work_revision, profile_id, profile_version, attempt UNIQUE;
DEFINE EVENT assurance_run_state_invariant ON TABLE assurance_run
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.status IN ['planned', 'running'] AND $after.active_guard_key != NONE AND $after.verdict = NONE AND $after.projected_work_revision = NONE AND $after.completed_at = NONE AND $after.failure_json = NONE) OR
    ($after.status = 'passed' AND $after.active_guard_key = NONE AND $after.verdict = 'passed' AND $after.completed_at != NONE AND $after.failure_json = NONE) OR
    ($after.status = 'failed' AND $after.active_guard_key = NONE AND $after.verdict = 'failed' AND $after.completed_at != NONE AND $after.failure_json != NONE) OR
    ($after.status = 'blocked' AND $after.active_guard_key = NONE AND $after.verdict = 'blocked' AND $after.projected_work_revision = NONE AND $after.completed_at != NONE AND $after.failure_json != NONE) OR
    ($after.status = 'cancelled' AND $after.active_guard_key = NONE AND $after.verdict = NONE AND $after.projected_work_revision = NONE AND $after.completed_at != NONE AND $after.failure_json = NONE)
  ) {
    THROW 'Assurance run 상태 metadata 불변식 위반';
  };
  IF $event = 'CREATE' AND $after.version != 1 {
    THROW 'Assurance run은 version 1로 생성해야 합니다';
  };
  IF $event = 'UPDATE' AND $after.version != $before.version + 1 {
    THROW 'Assurance run version은 한 번에 1만 증가해야 합니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['passed', 'failed', 'blocked', 'cancelled'] {
    THROW 'Terminal Assurance run은 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND (
    $after.assurance_run_id != $before.assurance_run_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.target_work_revision != $before.target_work_revision OR
    $after.plan_version_id != $before.plan_version_id OR
    $after.binding_version_id != $before.binding_version_id OR
    $after.profile_id != $before.profile_id OR
    $after.profile_version != $before.profile_version OR
    $after.verifier_handle != $before.verifier_handle OR
    $after.verifier_execution_id != $before.verifier_execution_id OR
    $after.snapshot_hash != $before.snapshot_hash OR
    $after.attempt != $before.attempt OR
    $after.start_command_id != $before.start_command_id OR
    $after.created_by_user_id != $before.created_by_user_id OR
    $after.expires_at != $before.expires_at OR
    $after.started_at != $before.started_at
  ) {
    THROW 'Assurance run identity field는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status IN ['planned', 'running'] AND $after.status IN ['planned', 'running'] AND $after.active_guard_key != $before.active_guard_key {
    THROW 'Active Assurance run guard key는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status != $after.status AND !(
    ($before.status = 'planned' AND $after.status IN ['running', 'blocked', 'cancelled']) OR
    ($before.status = 'running' AND $after.status IN ['passed', 'failed', 'blocked', 'cancelled'])
  ) {
    THROW '허용되지 않은 Assurance run 상태 전이';
  };
};

DEFINE TABLE assurance_criterion SCHEMAFULL;
DEFINE FIELD criterion_id ON assurance_criterion TYPE string;
DEFINE FIELD organization_id ON assurance_criterion TYPE string;
DEFINE FIELD work_id ON assurance_criterion TYPE string;
DEFINE FIELD assurance_run_id ON assurance_criterion TYPE string;
DEFINE FIELD criterion_key ON assurance_criterion TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD source ON assurance_criterion TYPE string ASSERT $value IN ['plan', 'task', 'profile'];
DEFINE FIELD statement ON assurance_criterion TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 2000;
DEFINE FIELD method ON assurance_criterion TYPE string ASSERT $value IN ['test', 'inspection', 'evidence', 'metric', 'human'];
DEFINE FIELD required_evidence_kinds ON assurance_criterion TYPE array<string> ASSERT array::len($value) <= 20;
DEFINE FIELD control_references ON assurance_criterion TYPE array<string> ASSERT array::len($value) <= 50;
DEFINE FIELD status ON assurance_criterion TYPE string ASSERT $value IN ['pending', 'passed', 'failed', 'blocked', 'excluded'];
DEFINE FIELD exclusion_rule ON assurance_criterion TYPE option<string>;
DEFINE FIELD exclusion_reason ON assurance_criterion TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 1000;
DEFINE FIELD exclusion_actor_id ON assurance_criterion TYPE option<string>;
DEFINE FIELD created_at ON assurance_criterion TYPE datetime;
DEFINE FIELD updated_at ON assurance_criterion TYPE datetime;
DEFINE INDEX assurance_criterion_id ON assurance_criterion FIELDS criterion_id UNIQUE;
DEFINE INDEX assurance_criterion_key ON assurance_criterion FIELDS organization_id, assurance_run_id, criterion_key UNIQUE;
DEFINE EVENT assurance_criterion_state_invariant ON TABLE assurance_criterion
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.status = 'excluded' AND $after.exclusion_rule != NONE AND $after.exclusion_reason != NONE AND $after.exclusion_actor_id != NONE) OR
    ($after.status != 'excluded' AND $after.exclusion_rule = NONE AND $after.exclusion_reason = NONE AND $after.exclusion_actor_id = NONE)
  ) {
    THROW 'Assurance criterion exclusion metadata 불변식 위반';
  };
};

DEFINE TABLE assurance_check SCHEMAFULL;
DEFINE FIELD check_id ON assurance_check TYPE string;
DEFINE FIELD organization_id ON assurance_check TYPE string;
DEFINE FIELD work_id ON assurance_check TYPE string;
DEFINE FIELD assurance_run_id ON assurance_check TYPE string;
DEFINE FIELD criterion_id ON assurance_check TYPE string;
DEFINE FIELD kind ON assurance_check TYPE string ASSERT $value IN ['command', 'inspection', 'evidence', 'metric', 'human'];
DEFINE FIELD executor_handle ON assurance_check TYPE option<string>;
DEFINE FIELD executor_execution_id ON assurance_check TYPE option<string>;
DEFINE FIELD system_adapter_id ON assurance_check TYPE option<string>;
DEFINE FIELD command_key ON assurance_check TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD input_hash ON assurance_check TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD status ON assurance_check TYPE string ASSERT $value IN ['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled'];
DEFINE FIELD tool_name ON assurance_check TYPE option<string>;
DEFINE FIELD tool_version ON assurance_check TYPE option<string>;
DEFINE FIELD output_hash ON assurance_check TYPE option<string> ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD output_summary ON assurance_check TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 4000;
DEFINE FIELD artifact_version_ids ON assurance_check TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD evidence_brief_ids ON assurance_check TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD metric_observation_ids ON assurance_check TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD human_attestation_ids ON assurance_check TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD duration_ms ON assurance_check TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD created_at ON assurance_check TYPE datetime;
DEFINE FIELD started_at ON assurance_check TYPE option<datetime>;
DEFINE FIELD completed_at ON assurance_check TYPE option<datetime>;
DEFINE INDEX assurance_check_id ON assurance_check FIELDS check_id UNIQUE;
DEFINE INDEX assurance_check_command ON assurance_check FIELDS organization_id, assurance_run_id, command_key UNIQUE;
DEFINE INDEX assurance_check_criterion ON assurance_check FIELDS organization_id, assurance_run_id, criterion_id;
DEFINE EVENT assurance_check_state_invariant ON TABLE assurance_check
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.executor_handle != NONE AND $after.executor_execution_id != NONE AND $after.system_adapter_id = NONE) OR
    ($after.executor_handle = NONE AND $after.executor_execution_id = NONE AND $after.system_adapter_id != NONE)
  ) {
    THROW 'Assurance check executor 불변식 위반';
  };
  IF (($after.status IN ['pending', 'running']) = ($after.completed_at != NONE)) {
    THROW 'Assurance check terminal metadata 불변식 위반';
  };
  IF $after.status IN ['passed', 'failed'] AND $after.output_hash = NONE {
    THROW '판정된 Assurance check에는 output hash가 필요합니다';
  };
};

DEFINE TABLE assurance_finding SCHEMAFULL;
DEFINE FIELD finding_id ON assurance_finding TYPE string;
DEFINE FIELD organization_id ON assurance_finding TYPE string;
DEFINE FIELD work_id ON assurance_finding TYPE string;
DEFINE FIELD assurance_run_id ON assurance_finding TYPE string;
DEFINE FIELD criterion_id ON assurance_finding TYPE option<string>;
DEFINE FIELD fingerprint ON assurance_finding TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD category ON assurance_finding TYPE string ASSERT $value IN ['correctness', 'security', 'reliability', 'operability', 'supply-chain'];
DEFINE FIELD severity ON assurance_finding TYPE string ASSERT $value IN ['critical', 'major', 'minor', 'info'];
DEFINE FIELD status ON assurance_finding TYPE string ASSERT $value IN ['open', 'resolved', 'accepted'];
DEFINE FIELD message ON assurance_finding TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 4000;
DEFINE FIELD location_json ON assurance_finding TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 4000;
DEFINE FIELD evidence_reference_ids ON assurance_finding TYPE array<string> ASSERT array::len($value) <= 100;
DEFINE FIELD source_tool ON assurance_finding TYPE option<string>;
DEFINE FIELD source_rule ON assurance_finding TYPE option<string>;
DEFINE FIELD control_references ON assurance_finding TYPE array<string> ASSERT array::len($value) <= 50;
DEFINE FIELD resolution_reason ON assurance_finding TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 2000;
DEFINE FIELD resolution_actor_id ON assurance_finding TYPE option<string>;
DEFINE FIELD resolved_at ON assurance_finding TYPE option<datetime>;
DEFINE FIELD created_at ON assurance_finding TYPE datetime;
DEFINE INDEX assurance_finding_id ON assurance_finding FIELDS finding_id UNIQUE;
DEFINE INDEX assurance_finding_fingerprint ON assurance_finding FIELDS organization_id, assurance_run_id, fingerprint UNIQUE;
DEFINE INDEX assurance_finding_status ON assurance_finding FIELDS organization_id, assurance_run_id, status, severity;
DEFINE EVENT assurance_finding_state_invariant ON TABLE assurance_finding
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF !(
    ($after.status = 'open' AND $after.resolution_reason = NONE AND $after.resolution_actor_id = NONE AND $after.resolved_at = NONE) OR
    ($after.status IN ['resolved', 'accepted'] AND $after.resolution_reason != NONE AND $after.resolution_actor_id != NONE AND $after.resolved_at != NONE)
  ) {
    THROW 'Assurance finding resolution metadata 불변식 위반';
  };
};

DEFINE TABLE assurance_human_attestation SCHEMAFULL;
DEFINE FIELD attestation_id ON assurance_human_attestation TYPE string;
DEFINE FIELD organization_id ON assurance_human_attestation TYPE string;
DEFINE FIELD work_id ON assurance_human_attestation TYPE string;
DEFINE FIELD assurance_run_id ON assurance_human_attestation TYPE string;
DEFINE FIELD criterion_id ON assurance_human_attestation TYPE string;
DEFINE FIELD attestor_user_id ON assurance_human_attestation TYPE string;
DEFINE FIELD statement_hash ON assurance_human_attestation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD snapshot_hash ON assurance_human_attestation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD accepted ON assurance_human_attestation TYPE bool;
DEFINE FIELD command_id ON assurance_human_attestation TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD request_hash ON assurance_human_attestation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON assurance_human_attestation TYPE datetime;
DEFINE INDEX assurance_human_attestation_id ON assurance_human_attestation FIELDS attestation_id UNIQUE;
DEFINE INDEX assurance_human_attestation_command ON assurance_human_attestation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX assurance_human_attestation_user ON assurance_human_attestation FIELDS organization_id, assurance_run_id, criterion_id, attestor_user_id UNIQUE;

DEFINE TABLE assurance_metric_observation SCHEMAFULL;
DEFINE FIELD observation_id ON assurance_metric_observation TYPE string;
DEFINE FIELD organization_id ON assurance_metric_observation TYPE string;
DEFINE FIELD work_id ON assurance_metric_observation TYPE string;
DEFINE FIELD producer_kind ON assurance_metric_observation TYPE string ASSERT $value IN ['runtime_execution', 'system_adapter'];
DEFINE FIELD producer_id ON assurance_metric_observation TYPE string;
DEFINE FIELD source_kind ON assurance_metric_observation TYPE string ASSERT $value IN ['artifact_version', 'runtime_execution'];
DEFINE FIELD source_id ON assurance_metric_observation TYPE string;
DEFINE FIELD numeric_value ON assurance_metric_observation TYPE number ASSERT $value > -9000000000000000000 AND $value < 9000000000000000000;
DEFINE FIELD unit ON assurance_metric_observation TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD checksum ON assurance_metric_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON assurance_metric_observation TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD request_hash ON assurance_metric_observation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD measured_at ON assurance_metric_observation TYPE datetime;
DEFINE FIELD created_at ON assurance_metric_observation TYPE datetime;
DEFINE INDEX assurance_metric_observation_id ON assurance_metric_observation FIELDS observation_id UNIQUE;
DEFINE INDEX assurance_metric_observation_command ON assurance_metric_observation FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX assurance_metric_observation_work ON assurance_metric_observation FIELDS organization_id, work_id, measured_at;

DEFINE TABLE assurance_event SCHEMAFULL;
DEFINE FIELD event_id ON assurance_event TYPE string;
DEFINE FIELD organization_id ON assurance_event TYPE string;
DEFINE FIELD assurance_run_id ON assurance_event TYPE string;
DEFINE FIELD command_id ON assurance_event TYPE string;
DEFINE FIELD sequence ON assurance_event TYPE int;
DEFINE FIELD event_type ON assurance_event TYPE string;
DEFINE FIELD request_hash ON assurance_event TYPE string;
DEFINE FIELD payload_json ON assurance_event TYPE string;
DEFINE FIELD actor_user_id ON assurance_event TYPE string;
DEFINE FIELD created_at ON assurance_event TYPE datetime;
DEFINE INDEX assurance_event_id ON assurance_event FIELDS event_id UNIQUE;
DEFINE INDEX assurance_event_command ON assurance_event FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX assurance_event_sequence ON assurance_event FIELDS organization_id, assurance_run_id, sequence UNIQUE;
`,
);
