import { defineMigration } from "@massion/storage";

export const EVIDENCE_INDEX_MIGRATION = defineMigration(
  "0025-evidence-index",
  `
DEFINE TABLE evidence_repository SCHEMAFULL;
DEFINE FIELD repository_id ON evidence_repository TYPE string;
DEFINE FIELD organization_id ON evidence_repository TYPE string;
DEFINE FIELD project_id ON evidence_repository TYPE option<string>;
DEFINE FIELD name ON evidence_repository TYPE string;
DEFINE FIELD provider_kind ON evidence_repository TYPE string ASSERT $value IN ['git', 'filesystem', 'external'];
DEFINE FIELD root_ref ON evidence_repository TYPE string;
DEFINE FIELD root_real_path_hash ON evidence_repository TYPE string;
DEFINE FIELD default_branch ON evidence_repository TYPE option<string>;
DEFINE FIELD status ON evidence_repository TYPE string ASSERT $value IN ['active', 'inactive'];
DEFINE FIELD current_index_version_id ON evidence_repository TYPE option<string>;
DEFINE FIELD created_by_user_id ON evidence_repository TYPE string;
DEFINE FIELD created_at ON evidence_repository TYPE datetime;
DEFINE FIELD updated_at ON evidence_repository TYPE datetime;
DEFINE INDEX evidence_repository_id ON evidence_repository FIELDS repository_id UNIQUE;
DEFINE INDEX evidence_repository_name ON evidence_repository FIELDS organization_id, name UNIQUE;
DEFINE INDEX evidence_repository_tenant ON evidence_repository FIELDS organization_id;

DEFINE TABLE repository_revision SCHEMAFULL;
DEFINE FIELD repository_revision_id ON repository_revision TYPE string;
DEFINE FIELD organization_id ON repository_revision TYPE string;
DEFINE FIELD repository_id ON repository_revision TYPE string;
DEFINE FIELD version ON repository_revision TYPE int;
DEFINE FIELD provider_revision ON repository_revision TYPE string;
DEFINE FIELD revision ON repository_revision TYPE string;
DEFINE FIELD dirty ON repository_revision TYPE bool;
DEFINE FIELD dirty_fingerprint ON repository_revision TYPE option<string>;
DEFINE FIELD manifest_checksum ON repository_revision TYPE string;
DEFINE FIELD root_real_path_hash ON repository_revision TYPE string;
DEFINE FIELD collector_version ON repository_revision TYPE string;
DEFINE FIELD captured_by_user_id ON repository_revision TYPE string;
DEFINE FIELD captured_at ON repository_revision TYPE datetime;
DEFINE INDEX repository_revision_id ON repository_revision FIELDS repository_revision_id UNIQUE;
DEFINE INDEX repository_revision_version ON repository_revision FIELDS organization_id, repository_id, version UNIQUE;
DEFINE INDEX repository_revision_snapshot ON repository_revision FIELDS organization_id, repository_id, revision, manifest_checksum UNIQUE;

DEFINE TABLE index_configuration SCHEMAFULL;
DEFINE FIELD configuration_id ON index_configuration TYPE string;
DEFINE FIELD organization_id ON index_configuration TYPE string;
DEFINE FIELD repository_id ON index_configuration TYPE string;
DEFINE FIELD version ON index_configuration TYPE int;
DEFINE FIELD checksum ON index_configuration TYPE string;
DEFINE FIELD parser_bundle_version ON index_configuration TYPE string;
DEFINE FIELD schema_version ON index_configuration TYPE string;
DEFINE FIELD embedding_version ON index_configuration TYPE option<string>;
DEFINE FIELD embedding_status ON index_configuration TYPE string ASSERT $value IN ['unavailable', 'pending', 'complete', 'failed'];
DEFINE FIELD settings_json ON index_configuration TYPE string;
DEFINE FIELD created_by_user_id ON index_configuration TYPE string;
DEFINE FIELD created_at ON index_configuration TYPE datetime;
DEFINE INDEX index_configuration_id ON index_configuration FIELDS configuration_id UNIQUE;
DEFINE INDEX index_configuration_version ON index_configuration FIELDS organization_id, repository_id, version UNIQUE;
DEFINE INDEX index_configuration_checksum ON index_configuration FIELDS organization_id, repository_id, checksum UNIQUE;

DEFINE TABLE index_version SCHEMAFULL;
DEFINE FIELD index_version_id ON index_version TYPE string;
DEFINE FIELD organization_id ON index_version TYPE string;
DEFINE FIELD repository_id ON index_version TYPE string;
DEFINE FIELD repository_revision_id ON index_version TYPE string;
DEFINE FIELD configuration_id ON index_version TYPE string;
DEFINE FIELD version ON index_version TYPE int;
DEFINE FIELD mode ON index_version TYPE string ASSERT $value IN ['full', 'incremental', 'reconcile'];
DEFINE FIELD parent_index_version_id ON index_version TYPE option<string>;
DEFINE FIELD status ON index_version TYPE string ASSERT $value IN ['building', 'complete', 'partial', 'failed', 'superseded'];
DEFINE FIELD current ON index_version TYPE bool;
DEFINE FIELD parser_bundle_version ON index_version TYPE string;
DEFINE FIELD schema_version ON index_version TYPE string;
DEFINE FIELD embedding_version ON index_version TYPE option<string>;
DEFINE FIELD embedding_status ON index_version TYPE string ASSERT $value IN ['unavailable', 'pending', 'complete', 'failed'];
DEFINE FIELD configuration_checksum ON index_version TYPE string;
DEFINE FIELD snapshot_checksum ON index_version TYPE option<string>;
DEFINE FIELD file_count ON index_version TYPE int;
DEFINE FIELD symbol_count ON index_version TYPE int;
DEFINE FIELD relation_count ON index_version TYPE int;
DEFINE FIELD chunk_count ON index_version TYPE int;
DEFINE FIELD error_json ON index_version TYPE option<string>;
DEFINE FIELD created_by_user_id ON index_version TYPE string;
DEFINE FIELD created_at ON index_version TYPE datetime;
DEFINE FIELD completed_at ON index_version TYPE option<datetime>;
DEFINE FIELD updated_at ON index_version TYPE datetime;
DEFINE INDEX index_version_id ON index_version FIELDS index_version_id UNIQUE;
DEFINE INDEX index_version_number ON index_version FIELDS organization_id, repository_id, version UNIQUE;
DEFINE INDEX index_version_current ON index_version FIELDS organization_id, repository_id, current;

DEFINE TABLE evidence_index_event SCHEMAFULL;
DEFINE FIELD event_id ON evidence_index_event TYPE string;
DEFINE FIELD organization_id ON evidence_index_event TYPE string;
DEFINE FIELD repository_id ON evidence_index_event TYPE string;
DEFINE FIELD repository_revision_id ON evidence_index_event TYPE option<string>;
DEFINE FIELD index_version_id ON evidence_index_event TYPE option<string>;
DEFINE FIELD command_id ON evidence_index_event TYPE string;
DEFINE FIELD event_type ON evidence_index_event TYPE string;
DEFINE FIELD request_hash ON evidence_index_event TYPE string;
DEFINE FIELD payload_json ON evidence_index_event TYPE string;
DEFINE FIELD result_json ON evidence_index_event TYPE string;
DEFINE FIELD actor_user_id ON evidence_index_event TYPE string;
DEFINE FIELD created_at ON evidence_index_event TYPE datetime;
DEFINE INDEX evidence_index_event_id ON evidence_index_event FIELDS event_id UNIQUE;
DEFINE INDEX evidence_index_event_command ON evidence_index_event FIELDS organization_id, command_id UNIQUE;
DEFINE INDEX evidence_index_event_repository ON evidence_index_event FIELDS organization_id, repository_id;
`,
);

export const EVIDENCE_CONTENT_MIGRATION = defineMigration(
  "0026-evidence-content",
  `
DEFINE FIELD dedupe_key ON index_version TYPE option<string>;
DEFINE INDEX index_version_dedupe ON index_version FIELDS dedupe_key UNIQUE;

DEFINE TABLE source_file SCHEMAFULL;
DEFINE FIELD source_file_id ON source_file TYPE string;
DEFINE FIELD source_file_key ON source_file TYPE string;
DEFINE FIELD organization_id ON source_file TYPE string;
DEFINE FIELD repository_id ON source_file TYPE string;
DEFINE FIELD index_version_id ON source_file TYPE string;
DEFINE FIELD relative_path ON source_file TYPE string;
DEFINE FIELD language ON source_file TYPE string;
DEFINE FIELD size ON source_file TYPE int;
DEFINE FIELD content_hash ON source_file TYPE string;
DEFINE FIELD status ON source_file TYPE string ASSERT $value IN ['complete', 'partial'];
DEFINE FIELD parser_kind ON source_file TYPE string ASSERT $value IN ['tree-sitter', 'lexical'];
DEFINE FIELD grammar_version ON source_file TYPE string;
DEFINE FIELD parse_error_count ON source_file TYPE int;
DEFINE FIELD created_at ON source_file TYPE datetime;
DEFINE INDEX source_file_id ON source_file FIELDS source_file_id UNIQUE;
DEFINE INDEX source_file_path ON source_file FIELDS organization_id, index_version_id, relative_path UNIQUE;
DEFINE INDEX source_file_content ON source_file FIELDS organization_id, repository_id, content_hash;

DEFINE TABLE evidence_symbol SCHEMAFULL;
DEFINE FIELD symbol_id ON evidence_symbol TYPE string;
DEFINE FIELD symbol_key ON evidence_symbol TYPE string;
DEFINE FIELD organization_id ON evidence_symbol TYPE string;
DEFINE FIELD repository_id ON evidence_symbol TYPE string;
DEFINE FIELD index_version_id ON evidence_symbol TYPE string;
DEFINE FIELD source_file_id ON evidence_symbol TYPE string;
DEFINE FIELD relative_path ON evidence_symbol TYPE string;
DEFINE FIELD name ON evidence_symbol TYPE string;
DEFINE FIELD qualified_name ON evidence_symbol TYPE string;
DEFINE FIELD kind ON evidence_symbol TYPE string;
DEFINE FIELD start_byte ON evidence_symbol TYPE int;
DEFINE FIELD end_byte ON evidence_symbol TYPE int;
DEFINE FIELD start_line ON evidence_symbol TYPE int;
DEFINE FIELD end_line ON evidence_symbol TYPE int;
DEFINE FIELD content_hash ON evidence_symbol TYPE string;
DEFINE FIELD created_at ON evidence_symbol TYPE datetime;
DEFINE INDEX evidence_symbol_id ON evidence_symbol FIELDS symbol_id UNIQUE;
DEFINE INDEX evidence_symbol_key ON evidence_symbol FIELDS organization_id, index_version_id, symbol_key UNIQUE;
DEFINE INDEX evidence_symbol_name ON evidence_symbol FIELDS organization_id, index_version_id, qualified_name;

DEFINE TABLE evidence_chunk SCHEMAFULL;
DEFINE FIELD chunk_id ON evidence_chunk TYPE string;
DEFINE FIELD chunk_key ON evidence_chunk TYPE string;
DEFINE FIELD organization_id ON evidence_chunk TYPE string;
DEFINE FIELD repository_id ON evidence_chunk TYPE string;
DEFINE FIELD index_version_id ON evidence_chunk TYPE string;
DEFINE FIELD source_file_id ON evidence_chunk TYPE string;
DEFINE FIELD relative_path ON evidence_chunk TYPE string;
DEFINE FIELD symbol_key ON evidence_chunk TYPE option<string>;
DEFINE FIELD start_byte ON evidence_chunk TYPE int;
DEFINE FIELD end_byte ON evidence_chunk TYPE int;
DEFINE FIELD start_line ON evidence_chunk TYPE int;
DEFINE FIELD end_line ON evidence_chunk TYPE int;
DEFINE FIELD content ON evidence_chunk TYPE string;
DEFINE FIELD content_hash ON evidence_chunk TYPE string;
DEFINE FIELD language ON evidence_chunk TYPE string;
DEFINE FIELD created_at ON evidence_chunk TYPE datetime;
DEFINE INDEX evidence_chunk_id ON evidence_chunk FIELDS chunk_id UNIQUE;
DEFINE INDEX evidence_chunk_key ON evidence_chunk FIELDS organization_id, index_version_id, chunk_key UNIQUE;
DEFINE INDEX evidence_chunk_file ON evidence_chunk FIELDS organization_id, index_version_id, source_file_id;

DEFINE TABLE evidence_relation SCHEMAFULL;
DEFINE FIELD relation_id ON evidence_relation TYPE string;
DEFINE FIELD relation_key ON evidence_relation TYPE string;
DEFINE FIELD organization_id ON evidence_relation TYPE string;
DEFINE FIELD repository_id ON evidence_relation TYPE string;
DEFINE FIELD index_version_id ON evidence_relation TYPE string;
DEFINE FIELD source_file_id ON evidence_relation TYPE string;
DEFINE FIELD relative_path ON evidence_relation TYPE string;
DEFINE FIELD kind ON evidence_relation TYPE string ASSERT $value IN ['contains', 'imports', 'calls', 'implements', 'documents'];
DEFINE FIELD source_symbol_key ON evidence_relation TYPE option<string>;
DEFINE FIELD target_symbol_key ON evidence_relation TYPE option<string>;
DEFINE FIELD target_text ON evidence_relation TYPE string;
DEFINE FIELD resolved ON evidence_relation TYPE bool;
DEFINE FIELD start_line ON evidence_relation TYPE int;
DEFINE FIELD created_at ON evidence_relation TYPE datetime;
DEFINE INDEX evidence_relation_id ON evidence_relation FIELDS relation_id UNIQUE;
DEFINE INDEX evidence_relation_key ON evidence_relation FIELDS organization_id, index_version_id, relation_key UNIQUE;
DEFINE INDEX evidence_relation_source ON evidence_relation FIELDS organization_id, index_version_id, source_symbol_key;
DEFINE INDEX evidence_relation_target ON evidence_relation FIELDS organization_id, index_version_id, target_symbol_key;
`,
);

export const EVIDENCE_SEARCH_MIGRATION = defineMigration(
  "0027-evidence-search",
  `
DEFINE ANALYZER evidence_code TOKENIZERS class, camel, blank FILTERS lowercase, ascii;
`,
);

export const EVIDENCE_SEARCH_INDEX_MIGRATION = defineMigration(
  "0028-evidence-search-index",
  `
DEFINE INDEX evidence_chunk_content_search ON evidence_chunk FIELDS content FULLTEXT ANALYZER evidence_code BM25;
`,
);

export const EVIDENCE_BRIEF_MIGRATION = defineMigration(
  "0029-evidence-brief",
  `
DEFINE TABLE evidence_brief SCHEMAFULL;
DEFINE FIELD evidence_brief_id ON evidence_brief TYPE string;
DEFINE FIELD organization_id ON evidence_brief TYPE string;
DEFINE FIELD work_id ON evidence_brief TYPE string;
DEFINE FIELD repository_id ON evidence_brief TYPE string;
DEFINE FIELD repository_revision_id ON evidence_brief TYPE string;
DEFINE FIELD index_version_id ON evidence_brief TYPE string;
DEFINE FIELD configuration_checksum ON evidence_brief TYPE string;
DEFINE FIELD query ON evidence_brief TYPE string;
DEFINE FIELD status ON evidence_brief TYPE string ASSERT $value IN ['ready', 'stale_warning', 'blocked', 'failed'];
DEFINE FIELD references_json ON evidence_brief TYPE string;
DEFINE FIELD claims_json ON evidence_brief TYPE string;
DEFINE FIELD checksum ON evidence_brief TYPE string;
DEFINE FIELD created_by_user_id ON evidence_brief TYPE string;
DEFINE FIELD created_at ON evidence_brief TYPE datetime;
DEFINE INDEX evidence_brief_id ON evidence_brief FIELDS evidence_brief_id UNIQUE;
DEFINE INDEX evidence_brief_work ON evidence_brief FIELDS organization_id, work_id;
DEFINE INDEX evidence_brief_index ON evidence_brief FIELDS organization_id, index_version_id;

DEFINE TABLE evidence_brief_event SCHEMAFULL;
DEFINE FIELD event_id ON evidence_brief_event TYPE string;
DEFINE FIELD organization_id ON evidence_brief_event TYPE string;
DEFINE FIELD evidence_brief_id ON evidence_brief_event TYPE string;
DEFINE FIELD repository_id ON evidence_brief_event TYPE string;
DEFINE FIELD command_id ON evidence_brief_event TYPE string;
DEFINE FIELD request_hash ON evidence_brief_event TYPE string;
DEFINE FIELD event_type ON evidence_brief_event TYPE string;
DEFINE FIELD payload_json ON evidence_brief_event TYPE string;
DEFINE FIELD result_json ON evidence_brief_event TYPE string;
DEFINE FIELD actor_user_id ON evidence_brief_event TYPE string;
DEFINE FIELD created_at ON evidence_brief_event TYPE datetime;
DEFINE INDEX evidence_brief_event_id ON evidence_brief_event FIELDS event_id UNIQUE;
DEFINE INDEX evidence_brief_event_command ON evidence_brief_event FIELDS organization_id, command_id UNIQUE;
`,
);

export const EVIDENCE_RESEARCH_MIGRATION = defineMigration(
  "0030-evidence-research",
  `
DEFINE TABLE external_research_source SCHEMAFULL;
DEFINE FIELD external_source_id ON external_research_source TYPE string;
DEFINE FIELD organization_id ON external_research_source TYPE string;
DEFINE FIELD canonical_url ON external_research_source TYPE string;
DEFINE FIELD provider_kind ON external_research_source TYPE string;
DEFINE FIELD etag ON external_research_source TYPE option<string>;
DEFINE FIELD last_modified ON external_research_source TYPE option<string>;
DEFINE FIELD fetched_at ON external_research_source TYPE datetime;
DEFINE FIELD media_type ON external_research_source TYPE string;
DEFINE FIELD content_hash ON external_research_source TYPE string;
DEFINE FIELD content ON external_research_source TYPE string;
DEFINE FIELD created_by_user_id ON external_research_source TYPE string;
DEFINE FIELD created_at ON external_research_source TYPE datetime;
DEFINE INDEX external_research_source_id ON external_research_source FIELDS external_source_id UNIQUE;
DEFINE INDEX external_research_source_snapshot ON external_research_source FIELDS organization_id, canonical_url, content_hash UNIQUE;

DEFINE TABLE external_research_event SCHEMAFULL;
DEFINE FIELD event_id ON external_research_event TYPE string;
DEFINE FIELD organization_id ON external_research_event TYPE string;
DEFINE FIELD external_source_id ON external_research_event TYPE string;
DEFINE FIELD command_id ON external_research_event TYPE string;
DEFINE FIELD request_hash ON external_research_event TYPE string;
DEFINE FIELD event_type ON external_research_event TYPE string;
DEFINE FIELD payload_json ON external_research_event TYPE string;
DEFINE FIELD result_json ON external_research_event TYPE string;
DEFINE FIELD actor_user_id ON external_research_event TYPE string;
DEFINE FIELD created_at ON external_research_event TYPE datetime;
DEFINE INDEX external_research_event_id ON external_research_event FIELDS event_id UNIQUE;
DEFINE INDEX external_research_event_command ON external_research_event FIELDS organization_id, command_id UNIQUE;
`,
);

export const EVIDENCE_METRIC_MIGRATION = defineMigration(
  "0031-evidence-metric",
  `
DEFINE TABLE evidence_metric_event SCHEMAFULL;
DEFINE FIELD metric_event_id ON evidence_metric_event TYPE string;
DEFINE FIELD organization_id ON evidence_metric_event TYPE string;
DEFINE FIELD metric_name ON evidence_metric_event TYPE string;
DEFINE FIELD dimensions_json ON evidence_metric_event TYPE string;
DEFINE FIELD value ON evidence_metric_event TYPE number;
DEFINE FIELD occurred_at ON evidence_metric_event TYPE datetime;
DEFINE INDEX evidence_metric_event_id ON evidence_metric_event FIELDS metric_event_id UNIQUE;
DEFINE INDEX evidence_metric_event_org ON evidence_metric_event FIELDS organization_id, metric_name;
`,
);
