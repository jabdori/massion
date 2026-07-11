import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { applyMigrations, createDatabase } from "@massion/storage";

import { GrowthMetricStore } from "./metrics.js";
import { GROWTH_ADOPTION_MIGRATION, GROWTH_PROMPT_MEMORY_MIGRATION } from "./schema.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Growth contract", () => {
  remoteTest("SurrealDB 3.2.x에서 권한·migration·metric 경쟁 계약을 지킨다", async () => {
    const databaseName = `growth_${crypto.randomUUID().replaceAll("-", "")}`;
    const sqlUrl = (remoteUrl ?? "")
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
    if (!provisioned.ok) throw new Error(`SurrealDB 원격 테스트 프로비저닝 실패: ${String(provisioned.status)}`);
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
      email: `growth-${databaseName}@example.com`,
      displayName: "Growth Remote",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await applyMigrations(database, [GROWTH_PROMPT_MEMORY_MIGRATION, GROWTH_ADOPTION_MIGRATION]);
    const metrics = await GrowthMetricStore.create(database, organizations);
    const metric = {
      name: "growth_recovery_total",
      value: 1,
      unit: "count",
      dimensions: { stage: "adoption", result: "recovered" },
    } as const;
    const concurrent = await Promise.allSettled([
      metrics.recordOnce(context, "remote-concurrent", metric),
      metrics.recordOnce(context, "remote-concurrent", {
        ...metric,
        dimensions: { stage: "revert", result: "recovered" },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [stored] = await database.query<[unknown[]]>(
      "SELECT * FROM growth_metric WHERE organization_id = $organization_id AND idempotency_key = 'remote-concurrent';",
      { organization_id: context.organizationId },
    );
    expect(stored).toHaveLength(1);

    await database.query(`
      DEFINE TABLE growth_security_user SCHEMAFULL PERMISSIONS FOR create FULL, FOR select WHERE id = $auth.id;
      DEFINE FIELD email ON growth_security_user TYPE string;
      DEFINE FIELD pass ON growth_security_user TYPE string;
      DEFINE ACCESS growth_record ON DATABASE TYPE RECORD
        SIGNUP (CREATE growth_security_user SET email = $email, pass = crypto::argon2::generate($pass))
        SIGNIN (SELECT * FROM growth_security_user WHERE email = $email AND crypto::argon2::compare(pass, $pass));
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
        ac: "growth_record",
        email: "record@example.com",
        pass: "safe-pass-123",
      }),
    });
    const body = (await signup.json()) as { readonly token?: unknown };
    if (typeof body.token !== "string") throw new Error(`record user token이 없습니다: ${JSON.stringify(body)}`);
    for (const statement of [
      "CREATE growth_adoption_run SET adoption_id = 'forged';",
      "CREATE prompt_definition_version SET prompt_definition_version_id = 'forged';",
      "CREATE memory_version SET memory_version_id = 'forged';",
    ]) {
      const response = await fetch(`${httpBase}/sql`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.token}`,
          "content-type": "text/plain",
          "surreal-ns": "massion",
          "surreal-db": databaseName,
        },
        body: statement,
      });
      expect(response.ok).toBe(true);
    }
    const [info] = await database.query<[{ tables: Record<string, string> }]>("INFO FOR DB;");
    for (const table of ["growth_adoption_run", "prompt_definition_version", "memory_version", "growth_metric"])
      expect(info.tables[table]).toContain("PERMISSIONS NONE");
  });
});
