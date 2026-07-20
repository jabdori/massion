import { defineMigration } from "@massion/storage";

export const WORKSPACE_MIGRATION = defineMigration(
  "0106-workspace",
  `
DEFINE TABLE workspace SCHEMAFULL;
DEFINE FIELD workspace_id ON workspace TYPE string;
DEFINE FIELD organization_id ON workspace TYPE string;
DEFINE FIELD name ON workspace TYPE string;
DEFINE FIELD path ON workspace TYPE string;
DEFINE FIELD kind ON workspace TYPE string ASSERT $value IN ["local-directory"];
DEFINE FIELD trust ON workspace TYPE string ASSERT $value IN ["pending", "trusted", "blocked"];
DEFINE FIELD status ON workspace TYPE string ASSERT $value IN ["active", "archived"];
DEFINE FIELD revision ON workspace TYPE int ASSERT $value >= 0;
DEFINE FIELD created_at ON workspace TYPE datetime;
DEFINE FIELD last_used_at ON workspace TYPE datetime;
DEFINE INDEX workspace_id ON workspace FIELDS workspace_id UNIQUE;
DEFINE INDEX workspace_organization_path ON workspace FIELDS organization_id, path UNIQUE;
DEFINE INDEX workspace_by_organization ON workspace FIELDS organization_id;
`,
);
