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
