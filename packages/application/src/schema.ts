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

export const APPLICATION_MIGRATIONS = [APPLICATION_AUTH_MIGRATION] as const;
