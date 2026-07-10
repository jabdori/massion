import { createHash } from "node:crypto";

import type { MassionDatabase } from "./database.js";

const MIGRATION_SCHEMA = `
DEFINE TABLE IF NOT EXISTS system_migration SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS migration_id ON system_migration TYPE string;
DEFINE FIELD IF NOT EXISTS checksum ON system_migration TYPE string;
DEFINE FIELD IF NOT EXISTS applied_at ON system_migration TYPE datetime;
DEFINE INDEX IF NOT EXISTS system_migration_id ON system_migration FIELDS migration_id UNIQUE;
`;

export interface Migration {
  readonly id: string;
  readonly checksum: string;
  readonly surql: string;
}

export interface AppliedMigration {
  readonly migration_id: string;
  readonly checksum: string;
}

export function defineMigration(id: string, surql: string): Migration {
  if (!/^\d{4}-[a-z0-9-]+$/.test(id)) throw new Error(`잘못된 migration ID: ${id}`);
  return {
    id,
    surql,
    checksum: createHash("sha256").update(surql).digest("hex"),
  };
}

async function ensureMigrationSchema(database: MassionDatabase): Promise<void> {
  await database.query(MIGRATION_SCHEMA);
}

export async function listAppliedMigrations(database: MassionDatabase): Promise<AppliedMigration[]> {
  await ensureMigrationSchema(database);
  const [records] = await database.query<[AppliedMigration[]]>(
    "SELECT migration_id, checksum FROM system_migration ORDER BY migration_id ASC;",
  );
  return records;
}

export async function applyMigrations(database: MassionDatabase, migrations: readonly Migration[]): Promise<string[]> {
  await ensureMigrationSchema(database);
  const ids = migrations.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length) throw new Error("중복 migration ID");

  const ordered = [...migrations].sort((left, right) => left.id.localeCompare(right.id));
  const applied = new Map(
    (await listAppliedMigrations(database)).map((record) => [record.migration_id, record.checksum]),
  );
  const completed: string[] = [];

  for (const migration of ordered) {
    const existing = applied.get(migration.id);
    if (existing) {
      if (existing !== migration.checksum) throw new Error(`적용된 migration checksum 불일치: ${migration.id}`);
      continue;
    }

    await database.transaction(async (transaction) => {
      await transaction.query(migration.surql);
      await transaction.query(
        "CREATE system_migration CONTENT { migration_id: $migration_id, checksum: $checksum, applied_at: time::now() };",
        { migration_id: migration.id, checksum: migration.checksum },
      );
    });
    completed.push(migration.id);
  }
  return completed;
}
