import { defineMigration } from "@massion/storage";

export const GOVERNANCE_POLICY_MIGRATION = defineMigration(
  "0016-governance-policy",
  `
DEFINE TABLE governance_policy_version SCHEMAFULL;
DEFINE FIELD policy_version_id ON governance_policy_version TYPE string;
DEFINE FIELD organization_id ON governance_policy_version TYPE string;
DEFINE FIELD version ON governance_policy_version TYPE int;
DEFINE FIELD status ON governance_policy_version TYPE string ASSERT $value IN ['draft', 'active', 'superseded'];
DEFINE FIELD schema_json ON governance_policy_version TYPE string;
DEFINE FIELD policies_json ON governance_policy_version TYPE string;
DEFINE FIELD requirements_json ON governance_policy_version TYPE string;
DEFINE FIELD checksum ON governance_policy_version TYPE string;
DEFINE FIELD created_at ON governance_policy_version TYPE datetime;
DEFINE FIELD activated_at ON governance_policy_version TYPE option<datetime>;
DEFINE FIELD superseded_at ON governance_policy_version TYPE option<datetime>;
DEFINE INDEX governance_policy_version_id ON governance_policy_version FIELDS policy_version_id UNIQUE;
DEFINE INDEX governance_policy_org_version ON governance_policy_version FIELDS organization_id, version UNIQUE;

DEFINE TABLE governance_policy_event SCHEMAFULL;
DEFINE FIELD event_id ON governance_policy_event TYPE string;
DEFINE FIELD organization_id ON governance_policy_event TYPE string;
DEFINE FIELD policy_version_id ON governance_policy_event TYPE string;
DEFINE FIELD command_id ON governance_policy_event TYPE string;
DEFINE FIELD event_type ON governance_policy_event TYPE string;
DEFINE FIELD request_json ON governance_policy_event TYPE string;
DEFINE FIELD result_json ON governance_policy_event TYPE string;
DEFINE FIELD created_at ON governance_policy_event TYPE datetime;
DEFINE INDEX governance_policy_event_id ON governance_policy_event FIELDS event_id UNIQUE;
DEFINE INDEX governance_policy_command ON governance_policy_event FIELDS organization_id, command_id UNIQUE;
`,
);

export const GOVERNANCE_DECISION_MIGRATION = defineMigration(
  "0017-governance-decision",
  `
DEFINE TABLE governance_policy_decision SCHEMAFULL;
DEFINE FIELD decision_id ON governance_policy_decision TYPE string;
DEFINE FIELD organization_id ON governance_policy_decision TYPE string;
DEFINE FIELD command_id ON governance_policy_decision TYPE string;
DEFINE FIELD policy_version_id ON governance_policy_decision TYPE option<string>;
DEFINE FIELD request_hash ON governance_policy_decision TYPE string;
DEFINE FIELD request_summary_json ON governance_policy_decision TYPE string;
DEFINE FIELD outcome ON governance_policy_decision TYPE string ASSERT $value IN ['allow', 'deny', 'require_approval'];
DEFINE FIELD reasons_json ON governance_policy_decision TYPE string;
DEFINE FIELD errors_json ON governance_policy_decision TYPE string;
DEFINE FIELD requirement_json ON governance_policy_decision TYPE option<string>;
DEFINE FIELD request_json ON governance_policy_decision TYPE string;
DEFINE FIELD created_at ON governance_policy_decision TYPE datetime;
DEFINE INDEX governance_policy_decision_id ON governance_policy_decision FIELDS decision_id UNIQUE;
DEFINE INDEX governance_policy_decision_command ON governance_policy_decision FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX governance_policy_decision_hash ON governance_policy_decision FIELDS organization_id, request_hash;
`,
);

export const GOVERNANCE_APPROVAL_MIGRATION = defineMigration(
  "0018-governance-approval",
  `
DEFINE TABLE governance_approval SCHEMAFULL;
DEFINE FIELD approval_id ON governance_approval TYPE string;
DEFINE FIELD organization_id ON governance_approval TYPE string;
DEFINE FIELD decision_id ON governance_approval TYPE string;
DEFINE FIELD request_hash ON governance_approval TYPE string;
DEFINE FIELD policy_version_id ON governance_approval TYPE string;
DEFINE FIELD resource_revision ON governance_approval TYPE option<int>;
DEFINE FIELD requester_user_id ON governance_approval TYPE string;
DEFINE FIELD work_id ON governance_approval TYPE option<string>;
DEFINE FIELD execution_id ON governance_approval TYPE option<string>;
DEFINE FIELD status ON governance_approval TYPE string ASSERT $value IN ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'consumed'];
DEFINE FIELD requirement_json ON governance_approval TYPE string;
DEFINE FIELD revision ON governance_approval TYPE int;
DEFINE FIELD event_sequence ON governance_approval TYPE int;
DEFINE FIELD expires_at ON governance_approval TYPE datetime;
DEFINE FIELD created_at ON governance_approval TYPE datetime;
DEFINE FIELD updated_at ON governance_approval TYPE datetime;
DEFINE INDEX governance_approval_id ON governance_approval FIELDS approval_id UNIQUE;
DEFINE INDEX governance_approval_decision ON governance_approval FIELDS organization_id, decision_id UNIQUE;
DEFINE INDEX governance_approval_status ON governance_approval FIELDS organization_id, status, expires_at;

DEFINE TABLE governance_approval_vote SCHEMAFULL;
DEFINE FIELD vote_id ON governance_approval_vote TYPE string;
DEFINE FIELD organization_id ON governance_approval_vote TYPE string;
DEFINE FIELD approval_id ON governance_approval_vote TYPE string;
DEFINE FIELD approver_user_id ON governance_approval_vote TYPE string;
DEFINE FIELD approver_membership_id ON governance_approval_vote TYPE string;
DEFINE FIELD approver_role ON governance_approval_vote TYPE string;
DEFINE FIELD vote ON governance_approval_vote TYPE string ASSERT $value IN ['approve', 'reject'];
DEFINE FIELD reason ON governance_approval_vote TYPE string;
DEFINE FIELD created_at ON governance_approval_vote TYPE datetime;
DEFINE INDEX governance_approval_vote_id ON governance_approval_vote FIELDS vote_id UNIQUE;
DEFINE INDEX governance_approval_voter ON governance_approval_vote FIELDS organization_id, approval_id, approver_user_id UNIQUE;

DEFINE TABLE governance_approval_event SCHEMAFULL;
DEFINE FIELD event_id ON governance_approval_event TYPE string;
DEFINE FIELD organization_id ON governance_approval_event TYPE string;
DEFINE FIELD approval_id ON governance_approval_event TYPE string;
DEFINE FIELD command_id ON governance_approval_event TYPE string;
DEFINE FIELD sequence ON governance_approval_event TYPE int;
DEFINE FIELD event_type ON governance_approval_event TYPE string;
DEFINE FIELD request_json ON governance_approval_event TYPE string;
DEFINE FIELD payload_json ON governance_approval_event TYPE string;
DEFINE FIELD created_at ON governance_approval_event TYPE datetime;
DEFINE INDEX governance_approval_event_id ON governance_approval_event FIELDS event_id UNIQUE;
DEFINE INDEX governance_approval_event_command ON governance_approval_event FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX governance_approval_event_sequence ON governance_approval_event FIELDS organization_id, approval_id, sequence UNIQUE;
`,
);
