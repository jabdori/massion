import { describe, expect, it } from "vitest";

import { createBackup, restoreBackup } from "./backup.js";
import { createDatabase } from "./database.js";
import { DeclarationStore } from "./declaration-store.js";
import { listAppliedMigrations } from "./migrations.js";

describe("SurrealDB backup과 restore", () => {
  it("SQL export를 빈 DB에 복구하고 migration과 선언 hash를 보존한다", async () => {
    await using source = await createDatabase({ url: "mem://", namespace: "massion", database: "backup_source" });
    const sourceStore = await DeclarationStore.create(source);
    const applied = await sourceStore.apply("project-a", { name: "Massion" });
    const backup = await createBackup(source);

    await using target = await createDatabase({ url: "mem://", namespace: "massion", database: "backup_target" });
    await restoreBackup(target, backup);
    const targetStore = await DeclarationStore.create(target);
    const restored = await targetStore.list("project-a");

    expect(restored).toHaveLength(1);
    expect(restored[0]?.content_hash).toBe(applied.declaration.content_hash);
    expect((await listAppliedMigrations(target)).map((migration) => migration.migration_id)).toContain(
      "0001-declaration-version",
    );
  });

  it("checksum이 손상된 backup을 import 전에 거부한다", async () => {
    await using source = await createDatabase({ url: "mem://", namespace: "massion", database: "backup_corrupt" });
    const backup = await createBackup(source);
    await using target = await createDatabase({ url: "mem://", namespace: "massion", database: "backup_empty" });

    await expect(restoreBackup(target, { ...backup, sql: `${backup.sql}\n-- corrupted` })).rejects.toThrow(
      "backup checksum 불일치",
    );
  });

  it("비어 있지 않은 target DB에 restore하지 않는다", async () => {
    await using source = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: "backup_nonempty_source",
    });
    const backup = await createBackup(source);
    await using target = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: "backup_nonempty_target",
    });
    await target.query("DEFINE TABLE existing SCHEMAFULL;");

    await expect(restoreBackup(target, backup)).rejects.toThrow("restore 대상 DB가 비어 있지 않습니다");
  });
});
