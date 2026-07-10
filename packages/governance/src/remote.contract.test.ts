import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { PolicyStore } from "./policy-store.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Governance contract", () => {
  remoteTest("SurrealDB 3에서 Policy Version을 원자 활성화한다", async () => {
    const databaseName = `governance_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "governance@example.com", displayName: "Governance" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await PolicyStore.create(database, organizations);
    const draft = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: {
        schema: {
          Massion: {
            entityTypes: { Principal: {}, Resource: {} },
            actions: { Read: { appliesTo: { principalTypes: ["Principal"], resourceTypes: ["Resource"] } } },
          },
        },
        policies: { allow: "permit(principal, action, resource);" },
      },
      requirements: [],
    });

    const active = await store.activate(context, {
      commandId: crypto.randomUUID(),
      policyVersionId: draft.policy_version_id,
    });

    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    expect(active.status).toBe("active");
    expect((await store.getActive(context))?.policy_version_id).toBe(active.policy_version_id);
  });
});
