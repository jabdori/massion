import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { GROWTH_CONFIGURATION_MIGRATION } from "./schema.js";

describe("Growth configuration migration", () => {
  let database: MassionDatabase | undefined;

  afterEach(async () => database?.close());

  it("0051 schema와 checksum을 한 번만 적용한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });

    expect(GROWTH_CONFIGURATION_MIGRATION.id).toBe("0051-growth-configuration");
    expect(GROWTH_CONFIGURATION_MIGRATION.checksum).toBe(
      "2d8f76e44e840896d6ccf4917e7b5f7f7af18d0c14245e55cf3d10f7c45f1094",
    );
    expect(await applyMigrations(database, [GROWTH_CONFIGURATION_MIGRATION])).toEqual(["0051-growth-configuration"]);
    expect(await applyMigrations(database, [GROWTH_CONFIGURATION_MIGRATION])).toEqual([]);
    expect(await listAppliedMigrations(database)).toEqual([
      {
        migration_id: "0051-growth-configuration",
        checksum: GROWTH_CONFIGURATION_MIGRATION.checksum,
      },
    ]);

    await expect(database.query("INFO FOR TABLE growth_configuration_version;")).resolves.toBeDefined();
    await expect(database.query("INFO FOR TABLE growth_configuration_event;")).resolves.toBeDefined();
  });

  it("설정 event의 수정과 삭제를 거부한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [GROWTH_CONFIGURATION_MIGRATION]);
    await database.query(
      "CREATE growth_configuration_event CONTENT { event_id: 'event-1', organization_id: 'organization-1', configuration_version_id: 'configuration-1', command_id: 'command-1', event_type: 'configured', request_hash: $request_hash, payload_json: '{}', actor_user_id: 'user-1', created_at: time::now() };",
      { request_hash: "a".repeat(64) },
    );

    await expect(database.query("UPDATE growth_configuration_event SET event_type = 'superseded';")).rejects.toThrow(
      "immutable",
    );
    await expect(database.query("DELETE growth_configuration_event;")).rejects.toThrow("immutable");
  });
});
