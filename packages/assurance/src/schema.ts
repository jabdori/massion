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

export const ASSURANCE_BINDING_MIGRATION = defineMigration(
  "0041-assurance-binding",
  `
DEFINE FIELD OVERWRITE binding_version_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE organization_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE work_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE plan_version_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD revision ON assurance_binding_version TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE profile_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE profile_version ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD OVERWRITE bindings_json ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 5000000;
DEFINE FIELD criteria_checksum ON assurance_binding_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD OVERWRITE checksum ON assurance_binding_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD author_handle ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD OVERWRITE created_by_user_id ON assurance_binding_version TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 200;
DEFINE FIELD active_guard_key ON assurance_binding_version TYPE option<string>;
DEFINE INDEX assurance_binding_active_guard ON assurance_binding_version FIELDS active_guard_key UNIQUE;
DEFINE EVENT assurance_binding_state_invariant ON TABLE assurance_binding_version
WHEN $event IN ['CREATE', 'UPDATE']
THEN {
  IF $event = 'CREATE' AND $after.status != 'draft' {
    THROW 'Assurance binding은 draft로 생성해야 합니다';
  };
  IF !(
    ($after.status = 'draft' AND $after.revision = 1 AND $after.active_guard_key = NONE AND $after.governance_decision_id = NONE AND $after.governance_approval_id = NONE AND $after.activated_at = NONE AND $after.superseded_at = NONE) OR
    ($after.status = 'active' AND $after.active_guard_key != NONE AND $after.governance_decision_id != NONE AND $after.activated_at != NONE AND $after.superseded_at = NONE) OR
    ($after.status = 'superseded' AND $after.active_guard_key = NONE AND $after.governance_decision_id != NONE AND $after.activated_at != NONE AND $after.superseded_at != NONE)
  ) {
    THROW 'Assurance binding 상태 metadata 불변식 위반';
  };
  IF $event = 'UPDATE' AND $after.revision != $before.revision + 1 {
    THROW 'Assurance binding revision은 한 번에 1만 증가해야 합니다';
  };
  IF $event = 'UPDATE' AND (
    $after.binding_version_id != $before.binding_version_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.plan_version_id != $before.plan_version_id OR
    $after.version != $before.version OR
    $after.profile_id != $before.profile_id OR
    $after.profile_version != $before.profile_version OR
    $after.bindings_json != $before.bindings_json OR
    $after.criteria_checksum != $before.criteria_checksum OR
    $after.checksum != $before.checksum OR
    $after.author_handle != $before.author_handle OR
    $after.created_by_user_id != $before.created_by_user_id OR
    $after.created_at != $before.created_at
  ) {
    THROW 'Assurance binding immutable field는 변경할 수 없습니다';
  };
  IF $event = 'UPDATE' AND $before.status = 'active' AND (
    $after.governance_decision_id != $before.governance_decision_id OR
    $after.governance_approval_id != $before.governance_approval_id OR
    $after.activated_at != $before.activated_at
  ) {
    THROW 'Assurance binding activation metadata는 immutable입니다';
  };
  IF $event = 'UPDATE' AND $after.status = 'active' {
    LET $decisions = (SELECT outcome FROM governance_policy_decision WHERE organization_id = $after.organization_id AND decision_id = $after.governance_decision_id AND action = 'work.execute' AND resource_type = 'AssuranceBindingVersion' AND resource_id = $after.binding_version_id AND resource_revision = $before.revision AND risk_class = 'assurance-binding-activation');
    IF array::len($decisions) != 1 OR $decisions[0].outcome = 'deny' {
      THROW 'Assurance binding activation Governance decision이 유효하지 않습니다';
    };
    IF $decisions[0].outcome = 'allow' AND $after.governance_approval_id != NONE {
      THROW 'Allow decision에는 Governance approval을 연결할 수 없습니다';
    };
    IF $decisions[0].outcome = 'require_approval' {
      LET $approvals = (SELECT approval_id FROM governance_approval WHERE organization_id = $after.organization_id AND approval_id = $after.governance_approval_id AND decision_id = $after.governance_decision_id AND resource_revision = $before.revision AND status = 'consumed');
      IF array::len($approvals) != 1 {
        THROW 'Assurance binding activation Governance approval이 소비되지 않았습니다';
      };
    };
  };
  IF $event = 'UPDATE' AND !(
    ($before.status = 'draft' AND $after.status = 'active') OR
    ($before.status = 'active' AND $after.status = 'superseded')
  ) {
    THROW '허용되지 않은 Assurance binding 상태 전이';
  };
  IF $event = 'UPDATE' AND $before.status = 'superseded' {
    THROW 'Superseded Assurance binding은 변경할 수 없습니다';
  };
};

DEFINE TABLE assurance_binding_event SCHEMAFULL;
DEFINE FIELD event_id ON assurance_binding_event TYPE string;
DEFINE FIELD organization_id ON assurance_binding_event TYPE string;
DEFINE FIELD binding_version_id ON assurance_binding_event TYPE string;
DEFINE FIELD command_id ON assurance_binding_event TYPE string;
DEFINE FIELD sequence ON assurance_binding_event TYPE int ASSERT $value >= 1;
DEFINE FIELD event_type ON assurance_binding_event TYPE string;
DEFINE FIELD request_hash ON assurance_binding_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD actor_user_id ON assurance_binding_event TYPE string;
DEFINE FIELD created_at ON assurance_binding_event TYPE datetime;
DEFINE INDEX assurance_binding_event_id ON assurance_binding_event FIELDS event_id UNIQUE;
DEFINE INDEX assurance_binding_event_command ON assurance_binding_event FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX assurance_binding_event_sequence ON assurance_binding_event FIELDS organization_id, binding_version_id, sequence UNIQUE;
`,
);

export const ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION = defineMigration(
  "0043-assurance-evidence-integrity",
  `
DEFINE TABLE assurance_binding_check SCHEMAFULL;
DEFINE FIELD binding_version_id ON assurance_binding_check TYPE string;
DEFINE FIELD organization_id ON assurance_binding_check TYPE string;
DEFINE FIELD work_id ON assurance_binding_check TYPE string;
DEFINE FIELD binding_key ON assurance_binding_check TYPE string;
DEFINE FIELD criterion_key ON assurance_binding_check TYPE string;
DEFINE FIELD kind ON assurance_binding_check TYPE string ASSERT $value IN ['test', 'inspection', 'evidence', 'metric', 'human'];
DEFINE FIELD executor_kind ON assurance_binding_check TYPE string ASSERT $value IN ['runtime_agent', 'system_adapter'];
DEFINE FIELD executor_id ON assurance_binding_check TYPE string;
DEFINE FIELD source_kind ON assurance_binding_check TYPE option<string>;
DEFINE FIELD metric_operator ON assurance_binding_check TYPE option<string>;
DEFINE FIELD metric_threshold ON assurance_binding_check TYPE option<number>;
DEFINE FIELD metric_unit ON assurance_binding_check TYPE option<string>;
DEFINE FIELD metric_max_age_ms ON assurance_binding_check TYPE option<int>;
DEFINE FIELD eligible_roles ON assurance_binding_check TYPE array<string> DEFAULT [];
DEFINE FIELD minimum_attestations ON assurance_binding_check TYPE option<int>;
DEFINE FIELD identity_checksum ON assurance_binding_check TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON assurance_binding_check TYPE datetime;
DEFINE INDEX assurance_binding_check_key ON assurance_binding_check FIELDS organization_id, binding_version_id, binding_key UNIQUE;

DEFINE TABLE assurance_binding_check_manifest SCHEMAFULL;
DEFINE FIELD binding_version_id ON assurance_binding_check_manifest TYPE string;
DEFINE FIELD organization_id ON assurance_binding_check_manifest TYPE string;
DEFINE FIELD work_id ON assurance_binding_check_manifest TYPE string;
DEFINE FIELD identity_checksum ON assurance_binding_check_manifest TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON assurance_binding_check_manifest TYPE datetime;
DEFINE INDEX assurance_binding_check_manifest_identity ON assurance_binding_check_manifest FIELDS organization_id, binding_version_id, identity_checksum UNIQUE;
DEFINE EVENT assurance_binding_check_manifest_integrity ON TABLE assurance_binding_check_manifest
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'Assurance binding check manifest는 immutable입니다';
  };
  LET $versions = (SELECT binding_version_id FROM assurance_binding_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $after.binding_version_id);
  IF array::len($versions) != 1 {
    THROW 'Assurance binding check manifest의 binding이 유효하지 않습니다';
  };
};
DEFINE EVENT assurance_binding_check_integrity ON TABLE assurance_binding_check
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'Assurance binding check projection은 immutable입니다';
  };
  LET $expected = crypto::sha256(string::concat($after.binding_key, '|', $after.criterion_key, '|', $after.kind, '|', $after.executor_kind, '|', $after.executor_id));
  LET $versions = (SELECT binding_version_id FROM assurance_binding_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $after.binding_version_id);
  LET $manifests = (SELECT identity_checksum FROM assurance_binding_check_manifest WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $after.binding_version_id AND identity_checksum = $after.identity_checksum);
  IF $after.identity_checksum != $expected OR array::len($versions) != 1 OR array::len($manifests) != 1 {
    THROW 'Assurance binding check projection identity가 binding manifest와 일치하지 않습니다';
  };
};

DEFINE FIELD source_checksum ON assurance_metric_observation TYPE string ASSERT string::len($value) = 64;
DEFINE EVENT assurance_metric_observation_integrity ON TABLE assurance_metric_observation
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'MetricObservation은 immutable입니다';
  };
  LET $works = (SELECT work_id FROM work WHERE organization_id = $after.organization_id AND work_id = $after.work_id);
  IF array::len($works) != 1 {
    THROW 'MetricObservation Work가 유효하지 않습니다';
  };
  IF $after.source_kind = 'artifact_version' {
    LET $sources = (SELECT checksum FROM artifact_version WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND artifact_version_id = $after.source_id AND checksum = $after.source_checksum);
    IF array::len($sources) != 1 {
      THROW 'MetricObservation ArtifactVersion source와 checksum이 유효하지 않습니다';
    };
  } ELSE {
    LET $sources = (SELECT output_json FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $after.source_id AND status = 'succeeded');
    IF array::len($sources) != 1 OR crypto::sha256($sources[0].output_json) != $after.source_checksum {
      THROW 'MetricObservation Runtime source와 checksum이 유효하지 않습니다';
    };
  };
  IF $after.producer_kind = 'runtime_execution' {
    LET $producers = (SELECT execution_id FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $after.producer_id AND status = 'succeeded');
    IF array::len($producers) != 1 {
      THROW 'MetricObservation Runtime producer가 유효하지 않습니다';
    };
  };
};

DEFINE EVENT assurance_human_attestation_integrity ON TABLE assurance_human_attestation
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'HumanAttestation은 immutable입니다';
  };
  LET $runs = (SELECT assurance_run_id, binding_version_id, snapshot_hash FROM assurance_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND status IN ['planned', 'running'] AND snapshot_hash = $after.snapshot_hash);
  LET $criteria = (SELECT criterion_key, statement FROM assurance_criterion WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id AND method = 'human' AND status = 'pending');
  LET $members = (SELECT role FROM membership WHERE organization_id = $after.organization_id AND user_id = $after.attestor_user_id AND status = 'active');
  IF array::len($runs) != 1 OR array::len($criteria) != 1 OR array::len($members) != 1 OR crypto::sha256($criteria[0].statement) != $after.statement_hash {
    THROW 'HumanAttestation run·criterion·statement·Membership이 유효하지 않습니다';
  };
  LET $matches = (SELECT binding_key FROM assurance_binding_check WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $runs[0].binding_version_id AND criterion_key = $criteria[0].criterion_key AND kind = 'human' AND $members[0].role IN eligible_roles);
  IF array::len($matches) = 0 {
    THROW 'HumanAttestation attestor가 eligible binding role이 아닙니다';
  };
};

DEFINE EVENT assurance_finding_create_integrity ON TABLE assurance_finding
WHEN $event = 'CREATE' AND $after.status != 'open'
THEN { THROW 'AssuranceFinding은 open 상태로만 생성할 수 있습니다'; };

DEFINE EVENT assurance_finding_resolution_invariant ON TABLE assurance_finding
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' {
    THROW 'AssuranceFinding은 immutable identity이며 삭제할 수 없습니다';
  };
  IF $before.status != 'open' OR $after.status NOT IN ['resolved', 'accepted'] {
    THROW 'AssuranceFinding terminal resolution은 immutable입니다';
  };
  LET $actors = (SELECT membership_id FROM membership WHERE organization_id = $after.organization_id AND user_id = $after.resolution_actor_id AND status = 'active');
  IF array::len($actors) != 1 {
    THROW 'AssuranceFinding resolution actor의 활성 Membership이 없습니다';
  };
  IF $after.status = 'accepted' {
    IF $after.severity IN ['critical', 'major'] {
      THROW 'Critical 또는 major AssuranceFinding은 수용할 수 없습니다';
    };
    LET $runs = (SELECT profile_id, profile_version FROM assurance_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id);
    IF array::len($runs) != 1 OR $runs[0].profile_version != '1.0.0' OR
      ($after.severity = 'minor' AND $runs[0].profile_id != 'massion.assurance.software-change.v1') OR
      ($after.severity = 'info' AND $runs[0].profile_id NOT IN ['massion.assurance.software-change.v1', 'massion.assurance.acceptance.v1'])
    {
      THROW 'Assurance profile이 Finding 수용을 허용하지 않습니다';
    };
  };
  IF
    $after.finding_id != $before.finding_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.assurance_run_id != $before.assurance_run_id OR
    $after.criterion_id != $before.criterion_id OR
    $after.fingerprint != $before.fingerprint OR
    $after.category != $before.category OR
    $after.severity != $before.severity OR
    $after.message != $before.message OR
    $after.location_json != $before.location_json OR
    $after.evidence_reference_ids != $before.evidence_reference_ids OR
    $after.source_tool != $before.source_tool OR
    $after.source_rule != $before.source_rule OR
    $after.control_references != $before.control_references OR
    $after.created_at != $before.created_at
  {
    THROW 'AssuranceFinding identity와 evidence는 immutable입니다';
  };
};

DEFINE EVENT assurance_check_immutable_result ON TABLE assurance_check
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'AssuranceCheck result는 immutable입니다';
  };
  IF $after.status NOT IN ['passed', 'failed', 'blocked', 'cancelled'] OR $after.completed_at = NONE {
    THROW 'AssuranceCheck은 완료 상태로 한 번만 생성해야 합니다';
  };
  LET $runs = (SELECT assurance_run_id, binding_version_id, snapshot_hash FROM assurance_run WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND status IN ['planned', 'running']);
  LET $criteria = (SELECT criterion_id, criterion_key, method FROM assurance_criterion WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id AND status = 'pending');
  IF array::len($runs) != 1 OR array::len($criteria) != 1 {
    THROW 'AssuranceCheck의 active run과 pending criterion 연결이 유효하지 않습니다';
  };
  LET $matches = (SELECT * FROM assurance_binding_check WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND binding_version_id = $runs[0].binding_version_id AND binding_key = $after.command_key AND criterion_key = $criteria[0].criterion_key AND kind = $criteria[0].method);
  IF array::len($matches) != 1 OR
    ($matches[0].kind = 'test' AND $after.kind != 'command') OR
    ($matches[0].kind != 'test' AND $after.kind != $matches[0].kind)
  {
    THROW 'AssuranceCheck command key와 criterion binding이 일치하지 않습니다';
  };
  IF $matches[0].executor_kind = 'system_adapter' AND ($after.system_adapter_id != $matches[0].executor_id OR $after.executor_handle != NONE OR $after.executor_execution_id != NONE) {
    THROW 'AssuranceCheck system adapter executor가 binding과 일치하지 않습니다';
  };
  IF $matches[0].executor_kind = 'runtime_agent' {
    LET $executions = (SELECT execution_id FROM runtime_execution WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND execution_id = $after.executor_execution_id AND agent_handle = $matches[0].executor_id AND status = 'succeeded');
    IF $after.executor_handle != $matches[0].executor_id OR $after.system_adapter_id != NONE OR array::len($executions) != 1 {
      THROW 'AssuranceCheck Runtime executor가 binding과 일치하지 않습니다';
    };
  };
  IF $after.status = 'passed' AND $matches[0].kind = 'metric' {
    LET $observations = (SELECT * FROM assurance_metric_observation WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND observation_id IN $after.metric_observation_ids AND source_kind = $matches[0].source_kind AND unit = $matches[0].metric_unit AND measured_at <= time::now() AND measured_at >= time::now() - duration::from_millis($matches[0].metric_max_age_ms) AND (($matches[0].executor_kind = 'system_adapter' AND producer_kind = 'system_adapter' AND producer_id = $matches[0].executor_id) OR ($matches[0].executor_kind = 'runtime_agent' AND producer_kind = 'runtime_execution' AND producer_id = $after.executor_execution_id)));
    LET $threshold_pass = $observations.any(|$observation| ($matches[0].metric_operator = '>' AND $observation.numeric_value > $matches[0].metric_threshold) OR ($matches[0].metric_operator = '>=' AND $observation.numeric_value >= $matches[0].metric_threshold) OR ($matches[0].metric_operator = '=' AND $observation.numeric_value = $matches[0].metric_threshold) OR ($matches[0].metric_operator = '<=' AND $observation.numeric_value <= $matches[0].metric_threshold) OR ($matches[0].metric_operator = '<' AND $observation.numeric_value < $matches[0].metric_threshold));
    IF array::len($observations) = 0 OR array::len($observations) != array::len($after.metric_observation_ids) {
      THROW 'Passed Metric Check의 observation evidence가 유효하지 않습니다';
    };
    IF !$threshold_pass {
      THROW 'Passed Metric Check의 threshold evidence가 거짓입니다';
    };
  };
  IF $after.status = 'passed' AND $matches[0].kind = 'human' {
    LET $attestations = (SELECT attestation_id, attestor_user_id, accepted FROM assurance_human_attestation WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id AND snapshot_hash = $runs[0].snapshot_hash);
    LET $rejects = $attestations.filter(|$attestation| $attestation.accepted = false);
    LET $members = (SELECT user_id FROM membership WHERE organization_id = $after.organization_id AND user_id IN $attestations.attestor_user_id AND role IN $matches[0].eligible_roles AND status = 'active');
    IF array::len($rejects) != 0 OR array::len($attestations) < $matches[0].minimum_attestations OR array::len($members) != array::len($attestations) OR array::len($after.human_attestation_ids) != array::len($attestations) {
      THROW 'Passed Human Check의 attestation evidence가 유효하지 않습니다';
    };
  };
};

DEFINE EVENT assurance_criterion_result_integrity ON TABLE assurance_criterion
WHEN $event IN ['UPDATE', 'DELETE']
THEN {
  IF $event = 'DELETE' {
    THROW 'AssuranceCriterion은 immutable identity이며 삭제할 수 없습니다';
  };
  IF $before.status != 'pending' OR $after.status NOT IN ['passed', 'failed', 'blocked'] {
    THROW 'AssuranceCriterion result는 한 번만 투영할 수 있습니다';
  };
  IF
    $after.criterion_id != $before.criterion_id OR
    $after.organization_id != $before.organization_id OR
    $after.work_id != $before.work_id OR
    $after.assurance_run_id != $before.assurance_run_id OR
    $after.criterion_key != $before.criterion_key OR
    $after.source != $before.source OR
    $after.statement != $before.statement OR
    $after.method != $before.method OR
    $after.required_evidence_kinds != $before.required_evidence_kinds OR
    $after.control_references != $before.control_references OR
    $after.exclusion_rule != $before.exclusion_rule OR
    $after.exclusion_reason != $before.exclusion_reason OR
    $after.exclusion_actor_id != $before.exclusion_actor_id OR
    $after.created_at != $before.created_at
  {
    THROW 'AssuranceCriterion identity와 policy는 immutable입니다';
  };
  LET $checks = (SELECT status, output_hash FROM assurance_check WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id);
  LET $passed_violations = (SELECT check_id FROM assurance_check WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id AND status != 'passed');
  LET $failed_checks = (SELECT check_id FROM assurance_check WHERE organization_id = $after.organization_id AND work_id = $after.work_id AND assurance_run_id = $after.assurance_run_id AND criterion_id = $after.criterion_id AND status = 'failed');
  IF $after.status = 'passed' AND (array::len($checks) = 0 OR array::len($passed_violations) != 0) {
    THROW 'Passed AssuranceCriterion에는 모두 통과한 Check evidence가 필요합니다';
  };
  IF $after.status = 'failed' AND array::len($failed_checks) = 0 {
    THROW 'Failed AssuranceCriterion에는 failed Check evidence가 필요합니다';
  };
};

DEFINE EVENT assurance_event_immutable ON TABLE assurance_event
WHEN $event IN ['CREATE', 'UPDATE', 'DELETE']
THEN {
  IF $event IN ['UPDATE', 'DELETE'] {
    THROW 'AssuranceEvent audit ledger는 immutable입니다';
  };
  IF $after.event_type NOT IN ['assurance_run_started', 'assurance_run_running', 'assurance_run_passed', 'assurance_run_failed', 'assurance_run_blocked', 'assurance_run_cancelled', 'assurance_check_recorded', 'assurance_check_deduplicated', 'assurance_finding_recorded', 'assurance_finding_deduplicated', 'assurance_finding_resolved', 'assurance_finding_accepted', 'assurance_attestation_recorded', 'assurance_run_recovered'] {
    THROW '허용되지 않은 AssuranceEvent type입니다';
  };
  LET $runs = (SELECT status, start_command_id FROM assurance_run WHERE organization_id = $after.organization_id AND assurance_run_id = $after.assurance_run_id);
  LET $actors = (SELECT membership_id FROM membership WHERE organization_id = $after.organization_id AND user_id = $after.actor_user_id AND status = 'active');
  LET $previous = (SELECT sequence FROM assurance_event WHERE organization_id = $after.organization_id AND assurance_run_id = $after.assurance_run_id AND event_id != $after.event_id);
  LET $expected_sequence = IF array::len($previous) = 0 { 1 } ELSE { math::max($previous.sequence) + 1 };
  IF array::len($runs) != 1 OR array::len($actors) != 1 OR $after.sequence != $expected_sequence {
    THROW 'AssuranceEvent run·actor·sequence가 유효하지 않습니다';
  };
  IF $after.event_type = 'assurance_run_started' AND ($after.command_id != $runs[0].start_command_id OR $after.sequence != 1) {
    THROW 'Assurance run started Event가 run identity와 일치하지 않습니다';
  };
};
`,
);
