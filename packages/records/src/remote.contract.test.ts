import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase, listAppliedMigrations } from "@massion/storage";
import { WorkService } from "@massion/work";

import { RecordsBootstrap } from "./bootstrap.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

async function provision(databaseName: string): Promise<void> {
  await using admin = await createDatabase({
    url: remoteUrl ?? "",
    namespace: "main",
    database: "main",
    authentication: { username: "root", password: "root" },
  });
  await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
}

describe("remote Records contract", () => {
  remoteTest("SurrealDB 3.2에서 N+1→N+2→N+3·recovery·tenant·record permission을 보존한다", async () => {
    const databaseName = `records_${crypto.randomUUID().replaceAll("-", "")}`;
    await provision(databaseName);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: `records-owner-${crypto.randomUUID()}@example.com`,
      displayName: "Records Owner",
    });
    const outsider = await identity.registerPersonalUser({
      email: `records-outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Records Outsider",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const otherContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    const works = await WorkService.create(database, organizations);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "Remote Records completion",
      surface: "remote-contract",
      organizationVersionId: "organization-version-1",
    });
    const workId = created.work.work_id;
    await database.query(
      `
UPDATE work SET status = 'planned', revision = 2 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'ready', revision = 3 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'running', revision = 4 WHERE organization_id = $organization_id AND work_id = $work_id;
UPDATE work SET status = 'verifying', revision = 5 WHERE organization_id = $organization_id AND work_id = $work_id;
DEFINE FIELD assurance_run_id ON work_verification TYPE string;
DEFINE FIELD projected_work_revision ON work_verification TYPE int;
CREATE work_verification CONTENT { verification_id: 'verification-remote', organization_id: $organization_id, work_id: $work_id, verifier_id: 'assurance', passed: true, criteria_json: '{}', evidence_artifact_version_ids: [], assurance_run_id: 'assurance-run-remote', projected_work_revision: 5, created_at: time::now() };
DEFINE TABLE assurance_run SCHEMALESS;
CREATE assurance_run CONTENT { organization_id: $organization_id, work_id: $work_id, assurance_run_id: 'assurance-run-remote', status: 'passed', projected_work_revision: 5 };
REMOVE EVENT IF EXISTS work_assurance_completion_guard ON TABLE work;
`,
      { organization_id: context.organizationId, work_id: workId },
    );
    const bootstrap = await RecordsBootstrap.create(database, organizations, {
      continuation: { resume: vi.fn(async () => undefined) },
    });
    const started = await bootstrap.service.start(context, {
      commandId: "records-remote:start",
      workId,
      targetWorkRevision: 5,
      verificationId: "verification-remote",
      assuranceRunId: "assurance-run-remote",
      snapshotHash: "a".repeat(64),
      rendererVersion: "massion.records.markdown.v1",
    });
    await bootstrap.service.proposeImpacts(context, {
      commandId: "records-remote:impact",
      recordsRunId: started.recordsRunId,
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      proposals: [],
      sources: [
        {
          referenceId: "verification-remote",
          organizationId: context.organizationId,
          workId,
          sourceType: "verification",
        },
      ],
    });
    const finalized = await bootstrap.service.finalize(context, {
      commandId: `${started.recordsRunId}:finalize`,
      recordsRunId: started.recordsRunId,
      expectedWorkRevision: 5,
      documentSources: [],
    });
    expect(finalized.work.revision).toBe(6);
    const completed = await bootstrap.service.complete(context, { recordsRunId: started.recordsRunId });
    expect(completed.projection?.work).toMatchObject({ status: "completed", revision: 7 });
    expect(completed.run.status).toBe("completed");
    const recovered = await bootstrap.recovery.recover(context, {
      commandId: `${started.recordsRunId}:recovery`,
      recordsRunId: started.recordsRunId,
    });
    expect(recovered.result).toBe("terminal-unchanged");
    await expect(
      bootstrap.service.start(otherContext, {
        ...{
          commandId: "records-other:start",
          workId,
          targetWorkRevision: 5,
          verificationId: "verification-remote",
          assuranceRunId: "assurance-run-remote",
          snapshotHash: "a".repeat(64),
          rendererVersion: "massion.records.markdown.v1",
        },
      }),
    ).rejects.toThrow();

    await Promise.all([
      bootstrap.metrics.recordOnce(context, "remote:run", {
        name: "records_run_total",
        value: 1,
        dimensions: { result: "completed" },
      }),
      bootstrap.metrics.recordOnce(context, "remote:run", {
        name: "records_run_total",
        value: 1,
        dimensions: { result: "completed" },
      }),
    ]);
    expect(await bootstrap.metrics.aggregate(context)).toContainEqual({
      name: "records_run_total",
      value: 1,
      dimensions: { result: "completed" },
    });
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toEqual(
      expect.arrayContaining([
        "0047-records-documentation",
        "0048-work-records-link",
        "0049-work-records-completion",
        "0050-records-recovery-metric",
      ]),
    );

    await database.query(`
      DEFINE TABLE records_security_user SCHEMAFULL PERMISSIONS FOR create FULL, FOR select WHERE id = $auth.id;
      DEFINE FIELD email ON records_security_user TYPE string;
      DEFINE FIELD pass ON records_security_user TYPE string;
      DEFINE ACCESS records_record ON DATABASE TYPE RECORD
        SIGNUP (CREATE records_security_user SET email = $email, pass = crypto::argon2::generate($pass))
        SIGNIN (SELECT * FROM records_security_user WHERE email = $email AND crypto::argon2::compare(pass, $pass));
    `);
    const httpBase = (remoteUrl ?? "")
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/rpc$/u, "");
    const signup = await fetch(`${httpBase}/signup`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        ns: "massion",
        db: databaseName,
        ac: "records_record",
        email: "record@example.com",
        pass: "safe-pass-123",
      }),
    });
    const body = (await signup.json()) as { readonly token?: unknown };
    if (typeof body.token !== "string") throw new Error(`record user token이 없습니다: ${JSON.stringify(body)}`);
    const directWrite = await fetch(`${httpBase}/sql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.token}`,
        "content-type": "text/plain",
        "surreal-ns": "massion",
        "surreal-db": databaseName,
      },
      body: "CREATE records_run SET records_run_id = 'forged';",
    });
    expect(directWrite.ok).toBe(true);
    const [forged] = await database.query<[unknown[]]>("SELECT * FROM records_run WHERE records_run_id = 'forged';");
    expect(forged).toHaveLength(0);
    const [info] = await database.query<[{ tables: Record<string, string> }]>("INFO FOR DB;");
    for (const table of ["records_run", "records_event", "records_document", "records_metric_event"]) {
      expect(info.tables[table]).toContain("PERMISSIONS NONE");
    }
  });
});
