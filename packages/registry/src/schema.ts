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

export const REGISTRY_MIGRATIONS = [REGISTRY_MIGRATION] as const;
