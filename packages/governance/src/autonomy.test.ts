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

  it("full 모드로 전환하고 저장된다", async () => {
    const full = await autonomy.set(ownerContext, { mode: "full-access", expectedRevision: 0 });
    expect(full).toEqual({ mode: "full-access", revision: 1 });
    await expect(autonomy.get(ownerContext)).resolves.toEqual({ mode: "full-access", revision: 1 });
  });

  it("admin은 조직 전체 권한 모드를 변경할 수 없다", async () => {
    const admin = await identity.registerPersonalUser({ email: "admin@example.com", displayName: "Admin" });
    const membership = await organizations.addMember(ownerContext, admin.user.user_id, "member");
    await organizations.updateMembershipRole(ownerContext, membership.membership_id, "admin", 0);
    const adminContext = await organizations.resolveTenantContext(admin.user.user_id, ownerContext.organizationId);

    await expect(autonomy.set(adminContext, { mode: "full-access", expectedRevision: 0 })).rejects.toThrow();
  });
});
