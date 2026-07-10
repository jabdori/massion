import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { RECORDS_DOCUMENTATION_MIGRATION } from "./schema.js";

describe("Records documentation migration", () => {
  let database: MassionDatabase | undefined;

  afterEach(async () => database?.close());

  it("0047 schema와 checksum을 한 번만 적용한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });

    expect(RECORDS_DOCUMENTATION_MIGRATION.id).toBe("0047-records-documentation");
    expect(RECORDS_DOCUMENTATION_MIGRATION.checksum).toBe(
      "49f183a8494bfdd66ec6fb08c61f67ba3a0e95925a32184e2aba0ecf827ec55c",
    );
    expect(await applyMigrations(database, [RECORDS_DOCUMENTATION_MIGRATION])).toEqual(["0047-records-documentation"]);
    expect(await applyMigrations(database, [RECORDS_DOCUMENTATION_MIGRATION])).toEqual([]);
    expect(await listAppliedMigrations(database)).toEqual([
      {
        migration_id: "0047-records-documentation",
        checksum: RECORDS_DOCUMENTATION_MIGRATION.checksum,
      },
    ]);

    for (const table of [
      "records_run",
      "records_event",
      "documentation_impact_proposal",
      "documentation_impact_assessment",
      "records_document",
      "records_metric_event",
    ]) {
      await expect(database.query(`INFO FOR TABLE ${table};`)).resolves.toBeDefined();
    }
  });

  it("확정 Records document의 수정과 삭제를 거부한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [RECORDS_DOCUMENTATION_MIGRATION]);
    await database.query(
      "CREATE records_document CONTENT { document_id: 'document-1', organization_id: 'organization-1', work_id: 'work-1', records_run_id: 'records-run-1', kind: 'adr', schema_version: 'massion.records.adr.v1', renderer_version: 'massion.records.markdown.v1', source_json: '{}', source_checksum: $source_checksum, markdown_checksum: $markdown_checksum, artifact_version_id: 'artifact-version-1', created_at: time::now() };",
      { source_checksum: "a".repeat(64), markdown_checksum: "b".repeat(64) },
    );

    await expect(database.query("UPDATE records_document SET schema_version = 'tampered';")).rejects.toThrow(
      "immutable",
    );
    await expect(database.query("DELETE records_document;")).rejects.toThrow("immutable");
  });
});
