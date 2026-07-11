import { randomUUID } from "node:crypto";
import { link, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createBackup,
  listAppliedMigrations,
  restoreBackup,
  type DatabaseBackup,
  type MassionDatabase,
} from "@massion/storage";

const MAXIMUM_BACKUP_BYTES = 512 * 1024 * 1024;

export interface OperationalBackupBundle {
  readonly format: "massion-operational-backup";
  readonly formatVersion: 1;
  readonly agentVersion: string;
  readonly migrations: readonly { readonly id: string; readonly checksum: string }[];
  readonly backup: DatabaseBackup;
}

export interface OperationalBackupReceipt {
  readonly path: string;
  readonly checksum: string;
  readonly bytes: number;
  readonly engineVersion: string;
  readonly agentVersion: string;
  readonly migrations: readonly { readonly id: string; readonly checksum: string }[];
  readonly createdAt: string;
}

function bundle(value: unknown): OperationalBackupBundle {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("backup bundle 형식이 유효하지 않습니다");
  const input = value as Partial<OperationalBackupBundle>;
  if (
    input.format !== "massion-operational-backup" ||
    input.formatVersion !== 1 ||
    typeof input.agentVersion !== "string" ||
    !Array.isArray(input.migrations) ||
    !input.backup
  ) {
    throw new Error("backup bundle 형식이 유효하지 않습니다");
  }
  if (
    input.migrations.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof (item as { id?: unknown }).id !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String((item as { checksum?: unknown }).checksum)),
    )
  ) {
    throw new Error("backup migration manifest가 유효하지 않습니다");
  }
  return input as OperationalBackupBundle;
}

export async function writeOperationalBackup(
  database: MassionDatabase,
  path: string,
  agentVersion: string,
): Promise<OperationalBackupReceipt> {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(agentVersion)) throw new Error("AgentOS version이 유효하지 않습니다");
  const backup = await createBackup(database);
  const migrations = (await listAppliedMigrations(database)).map((item) => ({
    id: item.migration_id,
    checksum: item.checksum,
  }));
  const value: OperationalBackupBundle = {
    format: "massion-operational-backup",
    formatVersion: 1,
    agentVersion,
    migrations,
    backup,
  };
  const encoded = Buffer.from(JSON.stringify(value));
  if (encoded.length > MAXIMUM_BACKUP_BYTES) throw new Error("backup bundle byte 상한을 초과했습니다");
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("backup target이 이미 존재합니다");
      throw error;
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return {
    path,
    checksum: backup.manifest.sql_sha256,
    bytes: encoded.length,
    engineVersion: backup.manifest.engine_version,
    agentVersion,
    migrations,
    createdAt: backup.manifest.created_at,
  };
}

export async function restoreOperationalBackup(
  database: MassionDatabase,
  path: string,
): Promise<OperationalBackupReceipt> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error("backup은 owner-only regular file이어야 합니다");
  if (metadata.size < 1 || metadata.size > MAXIMUM_BACKUP_BYTES)
    throw new Error("backup bundle byte 길이가 유효하지 않습니다");
  const parsed = bundle(JSON.parse(await readFile(path, "utf8")) as unknown);
  await restoreBackup(database, parsed.backup);
  const restored = (await listAppliedMigrations(database)).map((item) => ({
    id: item.migration_id,
    checksum: item.checksum,
  }));
  if (JSON.stringify(restored) !== JSON.stringify(parsed.migrations))
    throw new Error("복구된 migration 계보가 backup manifest와 일치하지 않습니다");
  return {
    path,
    checksum: parsed.backup.manifest.sql_sha256,
    bytes: metadata.size,
    engineVersion: parsed.backup.manifest.engine_version,
    agentVersion: parsed.agentVersion,
    migrations: parsed.migrations,
    createdAt: parsed.backup.manifest.created_at,
  };
}
