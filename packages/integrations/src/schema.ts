import { defineMigration } from "@massion/storage";

export const INTEGRATION_MIGRATION = defineMigration(
  "0074-official-integrations",
  `
DEFINE TABLE integration_installation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD installation_id ON integration_installation TYPE string;
DEFINE FIELD organization_id ON integration_installation TYPE string;
DEFINE FIELD platform ON integration_installation TYPE string ASSERT $value IN ['slack', 'discord', 'github'];
DEFINE FIELD external_tenant_id ON integration_installation TYPE string;
DEFINE FIELD credential_ref ON integration_installation TYPE string;
DEFINE FIELD scopes ON integration_installation TYPE array<string>;
DEFINE FIELD state ON integration_installation TYPE string ASSERT $value IN ['active', 'disabled', 'blocked'];
DEFINE FIELD revision ON integration_installation TYPE int ASSERT $value > 0;
DEFINE FIELD command_id ON integration_installation TYPE string;
DEFINE FIELD request_hash ON integration_installation TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_installation TYPE datetime;
DEFINE FIELD updated_at ON integration_installation TYPE datetime;
DEFINE INDEX integration_installation_id ON integration_installation FIELDS organization_id, installation_id UNIQUE;
DEFINE INDEX integration_installation_external ON integration_installation FIELDS organization_id, platform, external_tenant_id UNIQUE;
DEFINE INDEX integration_installation_command ON integration_installation FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE integration_user_binding SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD binding_id ON integration_user_binding TYPE string;
DEFINE FIELD organization_id ON integration_user_binding TYPE string;
DEFINE FIELD installation_id ON integration_user_binding TYPE string;
DEFINE FIELD external_user_id ON integration_user_binding TYPE string;
DEFINE FIELD user_id ON integration_user_binding TYPE string;
DEFINE FIELD state ON integration_user_binding TYPE string ASSERT $value IN ['active', 'revoked'];
DEFINE FIELD revision ON integration_user_binding TYPE int ASSERT $value > 0;
DEFINE FIELD command_id ON integration_user_binding TYPE string;
DEFINE FIELD request_hash ON integration_user_binding TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_user_binding TYPE datetime;
DEFINE FIELD updated_at ON integration_user_binding TYPE datetime;
DEFINE INDEX integration_user_binding_id ON integration_user_binding FIELDS organization_id, binding_id UNIQUE;
DEFINE INDEX integration_user_binding_external ON integration_user_binding FIELDS organization_id, installation_id, external_user_id UNIQUE;
DEFINE INDEX integration_user_binding_command ON integration_user_binding FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE integration_delivery SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD delivery_record_id ON integration_delivery TYPE string;
DEFINE FIELD organization_id ON integration_delivery TYPE string;
DEFINE FIELD installation_id ON integration_delivery TYPE string;
DEFINE FIELD delivery_id ON integration_delivery TYPE string;
DEFINE FIELD event_type ON integration_delivery TYPE string;
DEFINE FIELD body_hash ON integration_delivery TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD state ON integration_delivery TYPE string ASSERT $value IN ['accepted', 'processing', 'succeeded', 'failed', 'blocked'];
DEFINE FIELD attempt ON integration_delivery TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_owner ON integration_delivery TYPE option<string>;
DEFINE FIELD lease_generation ON integration_delivery TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_expires_at ON integration_delivery TYPE option<datetime>;
DEFINE FIELD result_hash ON integration_delivery TYPE option<string>;
DEFINE FIELD received_at ON integration_delivery TYPE datetime;
DEFINE FIELD updated_at ON integration_delivery TYPE datetime;
DEFINE INDEX integration_delivery_id ON integration_delivery FIELDS organization_id, delivery_record_id UNIQUE;
DEFINE INDEX integration_delivery_external ON integration_delivery FIELDS organization_id, installation_id, delivery_id UNIQUE;

DEFINE TABLE integration_outbox SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD outbox_id ON integration_outbox TYPE string;
DEFINE FIELD organization_id ON integration_outbox TYPE string;
DEFINE FIELD installation_id ON integration_outbox TYPE string;
DEFINE FIELD destination ON integration_outbox TYPE string;
DEFINE FIELD operation ON integration_outbox TYPE string;
DEFINE FIELD idempotency_key ON integration_outbox TYPE string;
DEFINE FIELD payload_json ON integration_outbox TYPE string ASSERT string::len($value) <= 262144;
DEFINE FIELD payload_hash ON integration_outbox TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD state ON integration_outbox TYPE string ASSERT $value IN ['pending', 'processing', 'retrying', 'succeeded', 'blocked'];
DEFINE FIELD attempt ON integration_outbox TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_owner ON integration_outbox TYPE option<string>;
DEFINE FIELD lease_generation ON integration_outbox TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_expires_at ON integration_outbox TYPE option<datetime>;
DEFINE FIELD next_attempt_at ON integration_outbox TYPE datetime;
DEFINE FIELD error_category ON integration_outbox TYPE option<string>;
DEFINE FIELD command_id ON integration_outbox TYPE string;
DEFINE FIELD request_hash ON integration_outbox TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_outbox TYPE datetime;
DEFINE FIELD updated_at ON integration_outbox TYPE datetime;
DEFINE INDEX integration_outbox_id ON integration_outbox FIELDS organization_id, outbox_id UNIQUE;
DEFINE INDEX integration_outbox_effect ON integration_outbox FIELDS organization_id, installation_id, idempotency_key UNIQUE;
DEFINE INDEX integration_outbox_command ON integration_outbox FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE integration_receipt SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD receipt_id ON integration_receipt TYPE string;
DEFINE FIELD organization_id ON integration_receipt TYPE string;
DEFINE FIELD outbox_id ON integration_receipt TYPE string;
DEFINE FIELD external_id ON integration_receipt TYPE string;
DEFINE FIELD external_url ON integration_receipt TYPE option<string>;
DEFINE FIELD payload_hash ON integration_receipt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_receipt TYPE datetime;
DEFINE INDEX integration_receipt_id ON integration_receipt FIELDS organization_id, receipt_id UNIQUE;
DEFINE INDEX integration_receipt_outbox ON integration_receipt FIELDS organization_id, outbox_id UNIQUE;
DEFINE EVENT integration_receipt_immutable ON TABLE integration_receipt WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Integration receipt는 immutable입니다'; };
`,
);

export const INTEGRATION_PAYLOAD_MIGRATION = defineMigration(
  "0075-integration-delivery-payload",
  `
DEFINE FIELD payload_json ON integration_delivery TYPE option<string> ASSERT $value = NONE OR string::len($value) <= 262144;
`,
);

export const INTEGRATION_INTERACTION_MIGRATION = defineMigration(
  "0076-integration-oauth-interaction",
  `
DEFINE TABLE integration_oauth_attempt SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD attempt_id ON integration_oauth_attempt TYPE string;
DEFINE FIELD organization_id ON integration_oauth_attempt TYPE string;
DEFINE FIELD platform ON integration_oauth_attempt TYPE string ASSERT $value IN ['slack', 'discord', 'github'];
DEFINE FIELD state_hash ON integration_oauth_attempt TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD redirect_uri ON integration_oauth_attempt TYPE string;
DEFINE FIELD expires_at ON integration_oauth_attempt TYPE datetime;
DEFINE FIELD consumed_at ON integration_oauth_attempt TYPE option<datetime>;
DEFINE FIELD created_by_user_id ON integration_oauth_attempt TYPE string;
DEFINE FIELD created_at ON integration_oauth_attempt TYPE datetime;
DEFINE INDEX integration_oauth_attempt_id ON integration_oauth_attempt FIELDS organization_id, attempt_id UNIQUE;
DEFINE INDEX integration_oauth_state ON integration_oauth_attempt FIELDS state_hash UNIQUE;

DEFINE TABLE integration_interaction_handle SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD interaction_id ON integration_interaction_handle TYPE string;
DEFINE FIELD organization_id ON integration_interaction_handle TYPE string;
DEFINE FIELD installation_id ON integration_interaction_handle TYPE string;
DEFINE FIELD external_user_id ON integration_interaction_handle TYPE string;
DEFINE FIELD handle_hash ON integration_interaction_handle TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD action ON integration_interaction_handle TYPE string;
DEFINE FIELD resource_id ON integration_interaction_handle TYPE string;
DEFINE FIELD payload_hash ON integration_interaction_handle TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD expires_at ON integration_interaction_handle TYPE datetime;
DEFINE FIELD consumed_at ON integration_interaction_handle TYPE option<datetime>;
DEFINE FIELD created_at ON integration_interaction_handle TYPE datetime;
DEFINE INDEX integration_interaction_id ON integration_interaction_handle FIELDS organization_id, interaction_id UNIQUE;
DEFINE INDEX integration_interaction_hash ON integration_interaction_handle FIELDS handle_hash UNIQUE;
`,
);

export const INTEGRATION_BINDING_MIGRATION = defineMigration(
  "0077-integration-channel-binding",
  `
DEFINE TABLE integration_channel_binding SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD channel_binding_id ON integration_channel_binding TYPE string;
DEFINE FIELD organization_id ON integration_channel_binding TYPE string;
DEFINE FIELD installation_id ON integration_channel_binding TYPE string;
DEFINE FIELD external_resource_id ON integration_channel_binding TYPE string;
DEFINE FIELD resource_kind ON integration_channel_binding TYPE string ASSERT $value IN ['channel', 'repository'];
DEFINE FIELD maximum_classification ON integration_channel_binding TYPE string ASSERT $value IN ['public'];
DEFINE FIELD events ON integration_channel_binding TYPE array<string>;
DEFINE FIELD state ON integration_channel_binding TYPE string ASSERT $value IN ['active', 'revoked'];
DEFINE FIELD revision ON integration_channel_binding TYPE int ASSERT $value > 0;
DEFINE FIELD command_id ON integration_channel_binding TYPE string;
DEFINE FIELD request_hash ON integration_channel_binding TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_channel_binding TYPE datetime;
DEFINE FIELD updated_at ON integration_channel_binding TYPE datetime;
DEFINE INDEX integration_channel_binding_id ON integration_channel_binding FIELDS organization_id, channel_binding_id UNIQUE;
DEFINE INDEX integration_channel_binding_external ON integration_channel_binding FIELDS organization_id, installation_id, external_resource_id UNIQUE;
DEFINE INDEX integration_channel_binding_command ON integration_channel_binding FIELDS organization_id, command_id UNIQUE;
`,
);

export const INTEGRATION_TELEMETRY_MIGRATION = defineMigration(
  "0078-integration-telemetry",
  `
DEFINE TABLE integration_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON integration_event TYPE string;
DEFINE FIELD organization_id ON integration_event TYPE string;
DEFINE FIELD installation_id ON integration_event TYPE option<string>;
DEFINE FIELD source_id ON integration_event TYPE string;
DEFINE FIELD event_type ON integration_event TYPE string;
DEFINE FIELD outcome ON integration_event TYPE string;
DEFINE FIELD payload_hash ON integration_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON integration_event TYPE datetime;
DEFINE INDEX integration_event_id ON integration_event FIELDS organization_id, event_id UNIQUE;
DEFINE INDEX integration_event_source ON integration_event FIELDS organization_id, source_id, event_type UNIQUE;
DEFINE EVENT integration_event_immutable ON TABLE integration_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Integration event는 immutable입니다'; };

DEFINE TABLE integration_metric SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD metric_id ON integration_metric TYPE string;
DEFINE FIELD organization_id ON integration_metric TYPE string;
DEFINE FIELD source_id ON integration_metric TYPE string;
DEFINE FIELD metric_name ON integration_metric TYPE string;
DEFINE FIELD platform ON integration_metric TYPE string ASSERT $value IN ['slack', 'discord', 'github'];
DEFINE FIELD outcome ON integration_metric TYPE string;
DEFINE FIELD value ON integration_metric TYPE float ASSERT $value >= 0;
DEFINE FIELD created_at ON integration_metric TYPE datetime;
DEFINE INDEX integration_metric_id ON integration_metric FIELDS organization_id, metric_id UNIQUE;
DEFINE INDEX integration_metric_source ON integration_metric FIELDS organization_id, source_id, metric_name UNIQUE;
DEFINE EVENT integration_metric_immutable ON TABLE integration_metric WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Integration metric은 immutable입니다'; };
`,
);

export const INTEGRATION_MIGRATIONS = [
  INTEGRATION_MIGRATION,
  INTEGRATION_PAYLOAD_MIGRATION,
  INTEGRATION_INTERACTION_MIGRATION,
  INTEGRATION_BINDING_MIGRATION,
  INTEGRATION_TELEMETRY_MIGRATION,
] as const;
