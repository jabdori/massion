import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION, SUBSCRIPTION_MIGRATION } from "./schema.js";

describe("구독 계정 schema", () => {
  let database: MassionDatabase;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
  });

  afterEach(async () => database.close());

  it("구독 계정·연결기·할당량·실행 임대 schema를 멱등 적용한다", async () => {
    expect(SUBSCRIPTION_MIGRATION.checksum).toBe("0a6d43756b5464f162bac61dc4c2160fee15e01a0bad37540165606ac92ac79c");
    await expect(
      applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION]),
    ).resolves.toEqual([SUBSCRIPTION_MIGRATION.id, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.id]);
    await expect(
      applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION]),
    ).resolves.toEqual([]);

    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_MIGRATION.id,
      checksum: SUBSCRIPTION_MIGRATION.checksum,
    });
    await expect(listAppliedMigrations(database)).resolves.toContainEqual({
      migration_id: SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.id,
      checksum: SUBSCRIPTION_CONNECTOR_ENROLLMENT_MIGRATION.checksum,
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
      "subscription_connector_enrollment",
      "subscription_connector_nonce",
    ]) {
      expect(schema).toContain(table);
    }
  });
});
