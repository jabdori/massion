import { createHash } from "node:crypto";

import type { MassionDatabase } from "./database.js";

export interface BackupManifest {
  readonly format: "massion-surrealql";
  readonly format_version: 1;
  readonly created_at: string;
  readonly engine_version: string;
  readonly sql_sha256: string;
}

export interface DatabaseBackup {
  readonly manifest: BackupManifest;
  readonly sql: string;
}

interface DatabaseInfo {
  readonly tables: Record<string, unknown>;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function isDatabaseBackup(value: unknown): value is DatabaseBackup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { manifest?: unknown; sql?: unknown };
  if (typeof candidate.sql !== "string" || !candidate.manifest || typeof candidate.manifest !== "object") return false;
  const manifest = candidate.manifest as Partial<BackupManifest>;
  return (
    manifest.format === "massion-surrealql" &&
    manifest.format_version === 1 &&
    typeof manifest.created_at === "string" &&
    typeof manifest.engine_version === "string" &&
    typeof manifest.sql_sha256 === "string"
  );
}

export async function createBackup(database: MassionDatabase): Promise<DatabaseBackup> {
  const sql = await database.exportSql();
  return {
    manifest: {
      format: "massion-surrealql",
      format_version: 1,
      created_at: new Date().toISOString(),
      engine_version: await database.version(),
      sql_sha256: checksum(sql),
    },
    sql,
  };
}

export async function restoreBackup(database: MassionDatabase, backup: unknown): Promise<void> {
  if (!isDatabaseBackup(backup)) throw new Error("지원하지 않는 backup format");
  if (checksum(backup.sql) !== backup.manifest.sql_sha256) throw new Error("backup checksum 불일치");

  const [info] = await database.query<[DatabaseInfo?]>("INFO FOR DB;");
  if (!info || Object.keys(info.tables).length > 0) throw new Error("restore 대상 DB가 비어 있지 않습니다");
  await database.importSql(backup.sql);
}
