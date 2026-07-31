import { describe, expect, it } from "vitest";

import { applyMigrations, createDatabase, listAppliedMigrations } from "@massion/storage";

import {
  SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
  SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
  SOFTWARE_ENGINEERING_PROPOSAL_EXECUTION_LINEAGE_MIGRATION,
  SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
  SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
} from "./schema.js";

describe("Software Engineering schema upgrade", () => {
  it("기존 Delivery와 command evidence를 보존한 채 optional 실행 계보를 추가한다", async () => {
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
    await database.query(
      "CREATE engineering_delivery CONTENT { delivery_id: 'legacy-delivery', organization_id: 'organization-1', work_id: 'work-1', task_id: 'task-1', assignment_id: 'assignment-1', repository_id: 'repository-1', repository_revision_id: 'revision-1', base_revision: 'base', repository_root_real_path_hash: $root_hash, agent_handle: 'software-engineering.backend-specialist', profile_version: '1.0.0', status: 'preparing', version: 1, start_command_id: 'legacy-start', validation_evidence_ids: [], created_by_user_id: 'user-1', created_at: time::now(), updated_at: time::now() };",
      { root_hash: "a".repeat(64) },
    );

    await applyMigrations(database, [
      SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
      SOFTWARE_ENGINEERING_PROPOSAL_EXECUTION_LINEAGE_MIGRATION,
    ]);

    const [records] = await database.query<[{ command_evidence_id: string; environment_hash?: string }[]]>(
      "SELECT command_evidence_id, environment_hash FROM engineering_command_evidence WHERE command_evidence_id = 'legacy-command';",
    );
    expect(records[0]).toMatchObject({ command_evidence_id: "legacy-command" });
    expect(records[0]?.environment_hash).toBeUndefined();
    const [deliveries] = await database.query<[{ proposal_execution_id?: string }[]]>(
      "SELECT proposal_execution_id FROM engineering_delivery WHERE delivery_id = 'legacy-delivery';",
    );
    expect(deliveries[0]?.proposal_execution_id).toBeUndefined();
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toContain(
      "0044-software-engineering-command-environment",
    );
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toContain(
      "0119-software-engineering-proposal-execution-lineage",
    );
  });
});
