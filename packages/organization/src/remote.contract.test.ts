import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { OrganizationGraphService } from "./organization.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Organization Graph contract", () => {
  remoteTest("인증된 SurrealDB server에서 bootstrap과 version 명령을 원자 적용한다", async () => {
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: `organization_${crypto.randomUUID().replaceAll("-", "")}`,
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
