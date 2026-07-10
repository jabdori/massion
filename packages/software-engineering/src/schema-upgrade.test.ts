import { describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations } from "@massion/storage";

import {
  SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
  SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
  SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
  SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
} from "./schema.js";

describe("Software Engineering schema upgrade", () => {
  it("0038 command evidence를 보존한 채 0044 optional environment hash를 추가한다", async () => {
    const remoteUrl = process.env.SURREAL_TEST_URL;
    const databaseName = `engineering_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    if (remoteUrl) {
      const sqlUrl = remoteUrl
        .replace(/^ws:/u, "http:")
        .replace(/^wss:/u, "https:")
        .replace(/\/rpc$/u, "/sql");
      const provisioned = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
          accept: "application/json",
          "content-type": "text/plain",
        },
        body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
      });
      if (!provisioned.ok) throw new Error(`Software Engineering upgrade DB provisioning 실패: ${provisioned.status}`);
    }
    await using database = await createDatabase({
      url: remoteUrl ?? "mem://",
      namespace: "massion",
      database: databaseName,
      ...(remoteUrl ? { authentication: { username: "root", password: "root" } } : {}),
    });
    await applyMigrations(database, [
      SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
      SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
      SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
    ]);
    await database.query(
      "CREATE engineering_command_evidence CONTENT { command_evidence_id: 'legacy-command', organization_id: 'organization-1', delivery_id: 'delivery-1', stage: 'green', executable: 'node', arguments_hash: $arguments_hash, cwd: '.', exit_code: 0, stdout_hash: $stdout_hash, stderr_hash: $stderr_hash, output_excerpt: '', duration_ms: 1, timed_out: false, credential_redacted: false, evidence_hash: $evidence_hash, created_at: time::now() };",
      {
        arguments_hash: "a".repeat(64),
        stdout_hash: "b".repeat(64),
        stderr_hash: "c".repeat(64),
        evidence_hash: "d".repeat(64),
      },
    );

    await applyMigrations(database, [SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION]);

    const [records] = await database.query<[{ command_evidence_id: string; environment_hash?: string }[]]>(
      "SELECT command_evidence_id, environment_hash FROM engineering_command_evidence WHERE command_evidence_id = 'legacy-command';",
    );
    expect(records[0]).toMatchObject({ command_evidence_id: "legacy-command" });
    expect(records[0]?.environment_hash).toBeUndefined();
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toContain(
      "0044-software-engineering-command-environment",
    );
  });
});
