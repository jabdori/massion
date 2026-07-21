import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { AutonomyStore } from "./autonomy.js";

describe("Governance 자율성 모드", () => {
  let database: MassionDatabase;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let autonomy: AutonomyStore;
  let ownerContext: TenantContext;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    autonomy = await AutonomyStore.create(database, organizations);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  });

  afterEach(async () => {
    await database.close();
  });

  it("기본 모드는 automatic이고 revision 0이다", async () => {
    await expect(autonomy.get(ownerContext)).resolves.toEqual({ mode: "automatic", revision: 0 });
  });

  it("expectedRevision이 일치할 때만 모드를 바꾸고 revision을 올린다", async () => {
    const reviewed = await autonomy.set(ownerContext, { mode: "review", expectedRevision: 0 });
    expect(reviewed).toEqual({ mode: "review", revision: 1 });
    await expect(autonomy.get(ownerContext)).resolves.toEqual({ mode: "review", revision: 1 });

    await expect(autonomy.set(ownerContext, { mode: "automatic", expectedRevision: 0 })).rejects.toThrow(
      "자율성 모드 revision이 일치하지 않습니다",
    );
    await expect(autonomy.set(ownerContext, { mode: "automatic", expectedRevision: 1 })).resolves.toEqual({
      mode: "automatic",
      revision: 2,
    });
  });

  it("다른 조직의 설정을 보거나 바꿀 수 없다", async () => {
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await autonomy.set(ownerContext, { mode: "review", expectedRevision: 0 });
    await expect(autonomy.get(otherContext)).resolves.toEqual({ mode: "automatic", revision: 0 });
  });
});
