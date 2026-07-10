import { defineMigration } from "@massion/storage";

export const IDENTITY_MIGRATION = defineMigration(
  "0002-identity",
  `
DEFINE TABLE identity_user SCHEMAFULL;
DEFINE FIELD user_id ON identity_user TYPE string;
DEFINE FIELD email ON identity_user TYPE string;
DEFINE FIELD display_name ON identity_user TYPE string;
DEFINE FIELD created_at ON identity_user TYPE datetime;
DEFINE INDEX identity_user_id ON identity_user FIELDS user_id UNIQUE;
DEFINE INDEX identity_user_email ON identity_user FIELDS email UNIQUE;

DEFINE TABLE organization SCHEMAFULL;
DEFINE FIELD organization_id ON organization TYPE string;
DEFINE FIELD kind ON organization TYPE string;
DEFINE FIELD name ON organization TYPE string;
DEFINE FIELD created_at ON organization TYPE datetime;
DEFINE INDEX organization_id ON organization FIELDS organization_id UNIQUE;

DEFINE TABLE membership SCHEMAFULL;
DEFINE FIELD membership_id ON membership TYPE string;
DEFINE FIELD user_id ON membership TYPE string;
DEFINE FIELD organization_id ON membership TYPE string;
DEFINE FIELD role ON membership TYPE string;
DEFINE FIELD status ON membership TYPE string;
DEFINE FIELD created_at ON membership TYPE datetime;
DEFINE INDEX membership_id ON membership FIELDS membership_id UNIQUE;
DEFINE INDEX membership_user_organization ON membership FIELDS user_id, organization_id UNIQUE;
DEFINE INDEX membership_by_user ON membership FIELDS user_id;
DEFINE INDEX membership_by_organization ON membership FIELDS organization_id;
`,
);
