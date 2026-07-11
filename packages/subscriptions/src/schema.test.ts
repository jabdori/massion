import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { SUBSCRIPTION_MIGRATION } from "./schema.js";

describe("구독 계정 schema", () => {
  let database: MassionDatabase;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
  });

  afterEach(async () => database.close());

  it("구독 계정·연결기·할당량·실행 임대 schema를 멱등 적용한다", async () => {
    await expect(applyMigrations(database, [SUBSCRIPTION_MIGRATION])).resolves.toEqual([SUBSCRIPTION_MIGRATION.id]);
    await expect(applyMigrations(database, [SUBSCRIPTION_MIGRATION])).resolves.toEqual([]);

    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_MIGRATION.id,
      checksum: SUBSCRIPTION_MIGRATION.checksum,
    });
    const schema = JSON.stringify(await database.query("INFO FOR DB;"));
    for (const table of [
      "subscription_account",
      "subscription_consent",
      "subscription_connector",
      "subscription_quota_snapshot",
      "subscription_quota_current",
      "subscription_session_lease",
      "subscription_audit_event",
    ]) {
      expect(schema).toContain(table);
    }
  });
});
