import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService } from "@massion/identity";
import { createDatabase, listAppliedMigrations } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { restoreOperationalBackup, writeOperationalBackup } from "./backup.js";

describe("operational backup", () => {
  it("원자 owner-only bundle을 clean DB에 복구하고 migration 계보를 검증한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-backup-"));
    const path = join(directory, "backup.json");
    await using source = await createDatabase({ url: "mem://", namespace: "massion", database: "backup-source" });
    const identities = await IdentityService.create(source);
    await identities.registerPersonalUser({ email: "backup@example.com", displayName: "Backup" });
    try {
      const receipt = await writeOperationalBackup(source, path, "1.0.0");
      expect(receipt.path).toBe(path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(receipt.migrations.length).toBeGreaterThan(0);
      await using target = await createDatabase({ url: "mem://", namespace: "massion", database: "backup-target" });
      await expect(restoreOperationalBackup(target, path)).resolves.toMatchObject({ agentVersion: "1.0.0" });
      expect((await listAppliedMigrations(target)).map((item) => item.migration_id)).toEqual(
        receipt.migrations.map((item) => item.id),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("손상·과도한 권한·기존 target path를 fail closed한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-backup-invalid-"));
    const path = join(directory, "backup.json");
    await using source = await createDatabase({ url: "mem://", namespace: "massion", database: "invalid-source" });
    await IdentityService.create(source);
    try {
      await writeOperationalBackup(source, path, "1.0.0");
      await expect(writeOperationalBackup(source, path, "1.0.0")).rejects.toThrow("이미 존재");
      const value = JSON.parse(await readFile(path, "utf8")) as { backup: { sql: string } };
      value.backup.sql += "\n-- tampered";
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      await using target = await createDatabase({ url: "mem://", namespace: "massion", database: "invalid-target" });
      await expect(restoreOperationalBackup(target, path)).rejects.toThrow("checksum");
      await chmod(path, 0o644);
      await using other = await createDatabase({ url: "mem://", namespace: "massion", database: "invalid-mode" });
      await expect(restoreOperationalBackup(other, path)).rejects.toThrow("owner-only");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
