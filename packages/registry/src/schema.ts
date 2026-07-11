import { defineMigration } from "@massion/storage";

export const REGISTRY_MIGRATION = defineMigration(
  "0079-registry-marketplace",
  `
DEFINE TABLE registry_version SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD version_id ON registry_version TYPE string;
DEFINE FIELD package_name ON registry_version TYPE string;
DEFINE FIELD package_version ON registry_version TYPE string;
DEFINE FIELD artifact_digest ON registry_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD content_digest ON registry_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD visibility ON registry_version TYPE string ASSERT $value IN ['public', 'private'];
DEFINE FIELD owner_organization_id ON registry_version TYPE string;
DEFINE FIELD manifest_json ON registry_version TYPE string ASSERT string::len($value) <= 65536;
DEFINE FIELD state ON registry_version TYPE string ASSERT $value IN ['staged', 'published', 'recalled'];
DEFINE FIELD assessment_json ON registry_version TYPE option<string>;
DEFINE FIELD published_by_decision_id ON registry_version TYPE option<string>;
DEFINE FIELD command_id ON registry_version TYPE string;
DEFINE FIELD request_hash ON registry_version TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON registry_version TYPE datetime;
DEFINE FIELD published_at ON registry_version TYPE option<datetime>;
DEFINE INDEX registry_version_id ON registry_version FIELDS version_id UNIQUE;
DEFINE INDEX registry_version_identity ON registry_version FIELDS package_name, package_version UNIQUE;
DEFINE INDEX registry_version_command ON registry_version FIELDS owner_organization_id, command_id UNIQUE;

DEFINE TABLE registry_recall SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD recall_id ON registry_recall TYPE string;
DEFINE FIELD version_id ON registry_recall TYPE string;
DEFINE FIELD package_name ON registry_recall TYPE string;
DEFINE FIELD package_version ON registry_recall TYPE string;
DEFINE FIELD category ON registry_recall TYPE string ASSERT $value IN ['security', 'malware', 'publisher-compromise', 'policy', 'compatibility'];
DEFINE FIELD severity ON registry_recall TYPE string ASSERT $value IN ['low', 'medium', 'high', 'critical'];
DEFINE FIELD reason ON registry_recall TYPE string ASSERT string::len($value) >= 3 AND string::len($value) <= 2048;
DEFINE FIELD created_by_organization_id ON registry_recall TYPE string;
DEFINE FIELD created_at ON registry_recall TYPE datetime;
DEFINE INDEX registry_recall_id ON registry_recall FIELDS recall_id UNIQUE;
DEFINE INDEX registry_recall_version ON registry_recall FIELDS version_id, recall_id UNIQUE;
DEFINE EVENT registry_recall_immutable ON TABLE registry_recall WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Registry recall은 immutable입니다'; };
`,
);

export const REGISTRY_TELEMETRY_MIGRATION = defineMigration(
  "0080-registry-telemetry",
  `
DEFINE TABLE registry_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON registry_event TYPE string;
DEFINE FIELD organization_id ON registry_event TYPE string;
DEFINE FIELD source_id ON registry_event TYPE string;
DEFINE FIELD event_type ON registry_event TYPE string;
DEFINE FIELD outcome ON registry_event TYPE string;
DEFINE FIELD package_name ON registry_event TYPE string;
DEFINE FIELD package_version ON registry_event TYPE string;
DEFINE FIELD created_at ON registry_event TYPE datetime;
DEFINE INDEX registry_event_id ON registry_event FIELDS event_id UNIQUE;
DEFINE INDEX registry_event_source ON registry_event FIELDS organization_id, source_id, event_type UNIQUE;
DEFINE EVENT registry_event_immutable ON TABLE registry_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Registry event는 immutable입니다'; };

DEFINE TABLE registry_metric SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD metric_id ON registry_metric TYPE string;
DEFINE FIELD organization_id ON registry_metric TYPE string;
DEFINE FIELD source_id ON registry_metric TYPE string;
DEFINE FIELD metric_name ON registry_metric TYPE string;
DEFINE FIELD outcome ON registry_metric TYPE string;
DEFINE FIELD value ON registry_metric TYPE float ASSERT $value >= 0;
DEFINE FIELD created_at ON registry_metric TYPE datetime;
DEFINE INDEX registry_metric_id ON registry_metric FIELDS metric_id UNIQUE;
DEFINE INDEX registry_metric_source ON registry_metric FIELDS organization_id, source_id, metric_name UNIQUE;
DEFINE EVENT registry_metric_immutable ON TABLE registry_metric WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'Registry metric은 immutable입니다'; };
`,
);

export const REGISTRY_MIGRATIONS = [REGISTRY_MIGRATION, REGISTRY_TELEMETRY_MIGRATION] as const;
