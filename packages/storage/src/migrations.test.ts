import { describe, expect, it } from "vitest";

import { createDatabase } from "./database.js";
import { applyMigrations, defineMigration, listAppliedMigrations } from "./migrations.js";

describe("SurrealDB migration", () => {
  it("migration을 순서대로 한 번만 적용한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "migration" });
    const migrations = [
      defineMigration("0001-probe", "DEFINE TABLE migration_probe SCHEMAFULL;"),
      defineMigration("0002-field", "DEFINE FIELD payload ON migration_probe TYPE string;"),
    ];

    expect(await applyMigrations(db, migrations)).toEqual(["0001-probe", "0002-field"]);
    expect(await applyMigrations(db, migrations)).toEqual([]);
    expect((await listAppliedMigrations(db)).map((record) => record.migration_id)).toEqual([
      "0001-probe",
      "0002-field",
    ]);
  });

  it("이미 적용된 migration의 checksum 변경을 거부한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "checksum" });
    await applyMigrations(db, [defineMigration("0001-probe", "DEFINE TABLE checksum_probe SCHEMAFULL;")]);

    await expect(
      applyMigrations(db, [defineMigration("0001-probe", "DEFINE TABLE changed_probe SCHEMAFULL;")]),
    ).rejects.toThrow("적용된 migration checksum 불일치: 0001-probe");
  });

  it("명시적으로 승인한 이전 checksum은 호환 migration으로 인정한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "compatible-checksum" });
    const previous = defineMigration("0001-probe", "DEFINE TABLE compatibility_probe SCHEMAFULL;");
    await applyMigrations(db, [previous]);

    const compatible = defineMigration(
      "0001-probe",
      "DEFINE TABLE OVERWRITE compatibility_probe SCHEMAFULL;",
      { compatibleChecksums: [previous.checksum] },
    );
    await expect(applyMigrations(db, [compatible])).resolves.toEqual([]);
  });

  it("migration 실패 시 schema와 적용 기록을 rollback한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "rollback" });
    const broken = defineMigration(
      "0001-broken",
      "DEFINE TABLE failed_migration_probe SCHEMAFULL; THIS IS NOT VALID SURREALQL;",
    );

    await expect(applyMigrations(db, [broken])).rejects.toThrow();
    expect(await listAppliedMigrations(db)).toEqual([]);
    await expect(db.query("SELECT * FROM failed_migration_probe;")).rejects.toThrow("does not exist");
  });
});
