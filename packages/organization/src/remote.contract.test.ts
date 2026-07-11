import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { OrganizationGraphService } from "./organization.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

async function provision(database: string): Promise<void> {
  const sqlUrl = (remoteUrl ?? "")
    .replace(/^ws:/u, "http:")
    .replace(/^wss:/u, "https:")
    .replace(/\/rpc$/u, "/sql");
  const response = await fetch(sqlUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
      accept: "application/json",
      "content-type": "text/plain",
    },
    body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${database};`,
  });
  const results = (await response.json()) as readonly { readonly status?: unknown }[];
  if (!response.ok || results.length !== 3 || results.some((result) => result.status !== "OK"))
    throw new Error("SurrealDB 원격 계약 database 준비가 실패했습니다");
}

describe("remote Organization Graph contract", () => {
  remoteTest("인증된 SurrealDB server에서 bootstrap과 version 명령을 원자 적용한다", async () => {
    const databaseName = `organization_${crypto.randomUUID().replaceAll("-", "")}`;
    await provision(databaseName);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);

    const bootstrap = await graph.bootstrap(context);
    const changed = await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create",
      handle: "engineering",
      name: "Engineering",
      responsibility: "소프트웨어 개발",
      parentHandle: "delivery-coordination",
      scope: "persistent",
    });

    expect(bootstrap.nodes).toHaveLength(8);
    expect(changed.version.version).toBe(2);
    expect(changed.nodes).toHaveLength(9);
  });
});
