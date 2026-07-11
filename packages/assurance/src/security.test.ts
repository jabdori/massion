import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import * as publicApi from "./index.js";
import {
  AssuranceBootstrap,
  containsAssuranceCredential,
  decideAssuranceVerdict,
  normalizeRepositoryUri,
} from "./index.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("Assurance security regression", () => {
  it("공개 API에서 내부 transition·test harness·DB·시스템 자격 증명을 노출하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "assurance-boundary@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const gateway = await AssuranceBootstrap.create(database, organizations);

    for (const privateName of [
      "AssuranceRunStore",
      "AssuranceService",
      "createAssuranceServiceTestHarness",
      "createAssuranceRecoveryTestHarness",
    ]) {
      expect(privateName in publicApi).toBe(false);
    }
    expect(Object.keys(gateway).sort()).toEqual([
      "assertRestoredCompliance",
      "auditCompletedWorks",
      "decide",
      "get",
      "listCriteria",
      "listEvents",
      "prepareSnapshot",
      "recover",
      "start",
    ]);
    expect("transition" in gateway).toBe(false);
    expect(JSON.stringify({ context, gateway: Object.keys(gateway) })).not.toMatch(
      /root:root|password|credential|database/u,
    );
  });

  it("caller verdict 주입과 SARIF 경로·credential 입력을 side effect 전에 거부한다", () => {
    expect(() =>
      decideAssuranceVerdict({
        cancellationRequested: false,
        snapshotStatus: "fresh",
        identityValid: true,
        bindingValid: true,
        independenceValid: true,
        verifierSucceeded: true,
        requiredEvidenceComplete: true,
        criteria: [],
        checks: [],
        findings: [],
        verdict: "passed",
      } as never),
    ).toThrow("caller verdict 주입");
    for (const uri of ["../secret", "/etc/passwd", "file:///etc/passwd", "src/%2e%2e/secret", "src\\secret.ts"]) {
      expect(() => normalizeRepositoryUri(uri)).toThrow();
    }
    expect(containsAssuranceCredential("api_key='supersecretvalue'")).toBe(true);
  });

  remoteTest("인증 없는 연결과 record user의 Assurance 직접 쓰기를 기본 PERMISSIONS NONE으로 차단한다", async () => {
    const databaseName = `assurance_security_${crypto.randomUUID().replaceAll("-", "")}`;
    await using admin = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "main",
      database: "main",
      authentication: { username: "root", password: "root" },
    });
    await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    await AssuranceBootstrap.create(database, organizations);
    await database.query(`
      DEFINE TABLE assurance_security_user SCHEMAFULL PERMISSIONS FOR create FULL, FOR select WHERE id = $auth.id;
      DEFINE FIELD email ON assurance_security_user TYPE string;
      DEFINE FIELD pass ON assurance_security_user TYPE string;
      DEFINE INDEX assurance_security_user_email ON assurance_security_user FIELDS email UNIQUE;
      DEFINE ACCESS assurance_record ON DATABASE TYPE RECORD
        SIGNUP (CREATE assurance_security_user SET email = $email, pass = crypto::argon2::generate($pass))
        SIGNIN (SELECT * FROM assurance_security_user WHERE email = $email AND crypto::argon2::compare(pass, $pass))
        DURATION FOR TOKEN 15m, FOR SESSION 1h;
    `);
    const httpBase = (remoteUrl ?? "")
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/rpc$/u, "");
    const unauthenticated = await fetch(`${httpBase}/sql`, {
      method: "POST",
      headers: { "content-type": "text/plain", "surreal-ns": "massion", "surreal-db": databaseName },
      body: "SELECT * FROM assurance_run;",
    });
    expect(unauthenticated.status).toBeGreaterThanOrEqual(400);

    const email = `record-${crypto.randomUUID()}@example.com`;
    const signup = await fetch(`${httpBase}/signup`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ns: "massion", db: databaseName, ac: "assurance_record", email, pass: "safe-pass-123" }),
    });
    const signupBody = (await signup.json()) as { readonly token?: unknown };
    if (typeof signupBody.token !== "string") {
      throw new Error(`record user signup token이 없습니다: ${JSON.stringify(signupBody)}`);
    }
    const forgedRunId = crypto.randomUUID();
    const directWrite = await fetch(`${httpBase}/sql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signupBody.token}`,
        accept: "application/json",
        "content-type": "text/plain",
        "surreal-ns": "massion",
        "surreal-db": databaseName,
      },
      body: `CREATE assurance_run SET assurance_run_id = '${forgedRunId}';`,
    });
    expect(directWrite.ok).toBe(true);
    const [forged] = await database.query<[unknown[]]>(
      "SELECT assurance_run_id FROM assurance_run WHERE assurance_run_id = $assurance_run_id;",
      { assurance_run_id: forgedRunId },
    );
    expect(forged).toHaveLength(0);

    const [tableInfo] = await database.query<[{ tables: Record<string, string> }]>("INFO FOR DB;");
    expect(tableInfo.tables.assurance_run).toContain("PERMISSIONS NONE");
    expect(tableInfo.tables.assurance_metric_observation).toContain("PERMISSIONS NONE");
  });
});
