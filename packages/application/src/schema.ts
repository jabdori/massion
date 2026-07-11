import { defineMigration } from "@massion/storage";

export const APPLICATION_AUTH_MIGRATION = defineMigration(
  "0065-application-auth",
  `
DEFINE TABLE application_access_token SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD token_id ON application_access_token TYPE string;
DEFINE FIELD organization_id ON application_access_token TYPE string;
DEFINE FIELD user_id ON application_access_token TYPE string;
DEFINE FIELD key_id ON application_access_token TYPE string;
DEFINE FIELD audience ON application_access_token TYPE string;
DEFINE FIELD scopes ON application_access_token TYPE array<string>;
DEFINE FIELD token_hash ON application_access_token TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD command_id ON application_access_token TYPE string;
DEFINE FIELD request_hash ON application_access_token TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD issued_at ON application_access_token TYPE datetime;
DEFINE FIELD expires_at ON application_access_token TYPE datetime;
DEFINE FIELD revoked_at ON application_access_token TYPE option<datetime>;
DEFINE INDEX application_access_token_id ON application_access_token FIELDS token_id UNIQUE;
DEFINE INDEX application_access_token_command ON application_access_token FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE application_token_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_token_event TYPE string;
DEFINE FIELD organization_id ON application_token_event TYPE string;
DEFINE FIELD token_id ON application_token_event TYPE string;
DEFINE FIELD actor_user_id ON application_token_event TYPE string;
DEFINE FIELD command_id ON application_token_event TYPE string;
DEFINE FIELD event_type ON application_token_event TYPE string ASSERT $value IN ['issued', 'revoked'];
DEFINE FIELD request_hash ON application_token_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_token_event TYPE datetime;
DEFINE INDEX application_token_event_id ON application_token_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_token_event_command ON application_token_event FIELDS organization_id, command_id UNIQUE;
DEFINE EVENT application_token_event_immutable ON TABLE application_token_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application token event는 immutable입니다'; };
`,
);

export const APPLICATION_COMMAND_MIGRATION = defineMigration(
  "0066-application-command",
  `
DEFINE TABLE application_command SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD command_record_id ON application_command TYPE string;
DEFINE FIELD organization_id ON application_command TYPE string;
DEFINE FIELD actor_user_id ON application_command TYPE string;
DEFINE FIELD command_id ON application_command TYPE string;
DEFINE FIELD correlation_id ON application_command TYPE string;
DEFINE FIELD operation ON application_command TYPE string;
DEFINE FIELD request_hash ON application_command TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD state ON application_command TYPE string ASSERT $value IN ['running', 'succeeded', 'accepted', 'awaiting-approval', 'blocked', 'failed'];
DEFINE FIELD result_json ON application_command TYPE option<string>;
DEFINE FIELD result_hash ON application_command TYPE option<string>;
DEFINE FIELD error_json ON application_command TYPE option<string>;
DEFINE FIELD error_hash ON application_command TYPE option<string>;
DEFINE FIELD lease_generation ON application_command TYPE int ASSERT $value > 0;
DEFINE FIELD lease_expires_at ON application_command TYPE option<datetime>;
DEFINE FIELD created_at ON application_command TYPE datetime;
DEFINE FIELD updated_at ON application_command TYPE datetime;
DEFINE INDEX application_command_id ON application_command FIELDS organization_id, command_record_id UNIQUE;
DEFINE INDEX application_command_request ON application_command FIELDS organization_id, operation, command_id UNIQUE;

DEFINE TABLE application_command_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_command_event TYPE string;
DEFINE FIELD organization_id ON application_command_event TYPE string;
DEFINE FIELD command_record_id ON application_command_event TYPE string;
DEFINE FIELD lease_generation ON application_command_event TYPE int ASSERT $value > 0;
DEFINE FIELD event_type ON application_command_event TYPE string ASSERT $value IN ['claimed', 'reclaimed', 'completed', 'failed'];
DEFINE FIELD detail_hash ON application_command_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_command_event TYPE datetime;
DEFINE INDEX application_command_event_id ON application_command_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_command_event_transition ON application_command_event FIELDS organization_id, command_record_id, lease_generation, event_type UNIQUE;
DEFINE EVENT application_command_event_immutable ON TABLE application_command_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application command event는 immutable입니다'; };
`,
);

export const APPLICATION_OUTBOX_MIGRATION = defineMigration(
  "0067-application-outbox",
  `
DEFINE TABLE application_outbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD outbox_id ON application_outbox TYPE string;
DEFINE FIELD organization_id ON application_outbox TYPE string;
DEFINE FIELD source_kind ON application_outbox TYPE string;
DEFINE FIELD source_id ON application_outbox TYPE string;
DEFINE FIELD aggregate_id ON application_outbox TYPE option<string>;
DEFINE FIELD correlation_id ON application_outbox TYPE option<string>;
DEFINE FIELD causation_id ON application_outbox TYPE option<string>;
DEFINE FIELD occurred_at ON application_outbox TYPE datetime;
DEFINE FIELD state ON application_outbox TYPE string ASSERT $value IN ['pending', 'projected'];
DEFINE FIELD public_event_id ON application_outbox TYPE option<string>;
DEFINE FIELD created_at ON application_outbox TYPE datetime;
DEFINE FIELD updated_at ON application_outbox TYPE datetime;
DEFINE INDEX application_outbox_id ON application_outbox FIELDS organization_id, outbox_id UNIQUE;
DEFINE INDEX application_outbox_source ON application_outbox FIELDS organization_id, source_kind, source_id UNIQUE;

DEFINE EVENT application_outbox_from_work ON TABLE work_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('work-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'work-event', source_id: $after.event_id, aggregate_id: $after.work_id, correlation_id: $after.command_id, causation_id: $after.caused_by_event_id, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_collaboration ON TABLE collaboration_message
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('collaboration-message:', $after.message_id), organization_id: $after.organization_id, source_kind: 'collaboration-message', source_id: $after.message_id, aggregate_id: $after.work_id, correlation_id: $after.execution_id, causation_id: $after.caused_by_message_id, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_runtime ON TABLE runtime_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('runtime-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'runtime-event', source_id: $after.event_id, aggregate_id: $after.execution_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_approval ON TABLE governance_approval_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('approval-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'approval-event', source_id: $after.event_id, aggregate_id: $after.approval_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_organization ON TABLE organization_version
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('organization-version:', $after.version_id), organization_id: $after.organization_id, source_kind: 'organization-version', source_id: $after.version_id, aggregate_id: $after.organization_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_extension ON TABLE extension_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('extension-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'extension-event', source_id: $after.event_id, aggregate_id: $after.installation_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_growth ON TABLE growth_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('growth-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'growth-event', source_id: $after.event_id, aggregate_id: $after.aggregate_id, correlation_id: NONE, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_token ON TABLE application_token_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('token-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'token-event', source_id: $after.event_id, aggregate_id: $after.token_id, correlation_id: $after.command_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
DEFINE EVENT application_outbox_from_command ON TABLE application_command_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('command-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'command-event', source_id: $after.event_id, aggregate_id: $after.command_record_id, correlation_id: NONE, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
`,
);

export const APPLICATION_EVENT_MIGRATION = defineMigration(
  "0068-application-event",
  `
DEFINE TABLE application_event_stream SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD organization_id ON application_event_stream TYPE string;
DEFINE FIELD current_sequence ON application_event_stream TYPE int ASSERT $value >= 0;
DEFINE FIELD retention_floor ON application_event_stream TYPE int ASSERT $value >= 0;
DEFINE FIELD updated_at ON application_event_stream TYPE datetime;
DEFINE INDEX application_event_stream_org ON application_event_stream FIELDS organization_id UNIQUE;

DEFINE TABLE application_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_event TYPE string;
DEFINE FIELD organization_id ON application_event TYPE string;
DEFINE FIELD sequence ON application_event TYPE int ASSERT $value > 0;
DEFINE FIELD source_kind ON application_event TYPE string;
DEFINE FIELD source_id ON application_event TYPE string;
DEFINE FIELD event_type ON application_event TYPE string;
DEFINE FIELD author_kind ON application_event TYPE string ASSERT $value IN ['user', 'agent', 'system'];
DEFINE FIELD author_id ON application_event TYPE string;
DEFINE FIELD correlation_id ON application_event TYPE option<string>;
DEFINE FIELD causation_id ON application_event TYPE option<string>;
DEFINE FIELD resource_type ON application_event TYPE option<string>;
DEFINE FIELD resource_id ON application_event TYPE option<string>;
DEFINE FIELD resource_revision ON application_event TYPE option<int>;
DEFINE FIELD occurred_at ON application_event TYPE datetime;
DEFINE FIELD payload_json ON application_event TYPE string;
DEFINE FIELD payload_hash ON application_event TYPE string ASSERT string::len($value) = 64;
DEFINE INDEX application_event_id ON application_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX application_event_sequence ON application_event FIELDS organization_id, sequence UNIQUE;
DEFINE INDEX application_event_source ON application_event FIELDS organization_id, source_kind, source_id UNIQUE;
DEFINE EVENT application_event_immutable ON TABLE application_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application event는 immutable입니다'; };
`,
);

export const APPLICATION_MIGRATIONS = [
  APPLICATION_AUTH_MIGRATION,
  APPLICATION_COMMAND_MIGRATION,
  APPLICATION_OUTBOX_MIGRATION,
  APPLICATION_EVENT_MIGRATION,
] as const;
