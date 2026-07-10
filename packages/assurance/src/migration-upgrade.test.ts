import { afterEach, describe, expect, it } from "vitest";

import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { ASSURANCE_BINDING_MIGRATION, ASSURANCE_RUN_MIGRATION } from "./schema.js";

describe("Assurance binding 순방향 migration", () => {
  let database: MassionDatabase | undefined;

  afterEach(async () => database?.close());

  it("기존 0017·0039 checksum을 고정하고 적용된 Task 1 DB를 0040·0041로 upgrade한다", async () => {
    expect(GOVERNANCE_DECISION_MIGRATION.checksum).toBe(
      "9994f399ff45ead2a1455f33f47e3982cac0e8d35dad93a58dec49af64eaf740",
    );
    expect(ASSURANCE_RUN_MIGRATION.checksum).toBe("ac01528f69d5bd4b2cb125a2ac1955f043889f737d55600c09755c3bd8948076");
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    expect(await applyMigrations(database, [GOVERNANCE_DECISION_MIGRATION, ASSURANCE_RUN_MIGRATION])).toEqual([
      "0017-governance-decision",
      "0039-assurance-run",
    ]);

    expect(
      await applyMigrations(database, [
        GOVERNANCE_DECISION_MIGRATION,
        ASSURANCE_RUN_MIGRATION,
        GOVERNANCE_DECISION_CONTEXT_MIGRATION,
        ASSURANCE_BINDING_MIGRATION,
      ]),
    ).toEqual(["0040-governance-decision-context", "0041-assurance-binding"]);
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toEqual([
      "0017-governance-decision",
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
    ]);
    await expect(database.query("INFO FOR TABLE assurance_binding_event;")).resolves.toBeDefined();
  });
});
