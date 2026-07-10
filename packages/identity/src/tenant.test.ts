import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type MassionDatabase } from "@massion/storage";

import { IdentityService, type PersonalRegistration } from "./identity.js";
import { OrganizationService } from "./tenant.js";

describe("팀 조직과 TenantContext 격리", () => {
  let database: MassionDatabase;
  let owner: PersonalRegistration;
  let member: PersonalRegistration;
  let identity: IdentityService;
  let organizations: OrganizationService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    member = await identity.registerPersonalUser({ email: "member@example.com", displayName: "Member" });
  });

  afterEach(async () => {
    await database.close();
  });

  it("팀 생성자를 owner로 등록하고 TenantContext를 발급한다", async () => {
    const team = await organizations.createTeam(owner.user.user_id, "Massion Team");

    expect(team.organization.kind).toBe("team");
    expect(team.membership.role).toBe("owner");
    expect(await organizations.resolveTenantContext(owner.user.user_id, team.organization.organization_id)).toEqual({
      userId: owner.user.user_id,
      organizationId: team.organization.organization_id,
      membershipId: team.membership.membership_id,
      role: "owner",
    });
  });

  it("owner와 admin은 member를 추가하지만 member는 추가할 수 없다", async () => {
    const team = await organizations.createTeam(owner.user.user_id, "Massion Team");
    const ownerContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      team.organization.organization_id,
    );
    const added = await organizations.addMember(ownerContext, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(
      member.user.user_id,
      team.organization.organization_id,
    );
    const third = await identity.registerPersonalUser({ email: "third@example.com", displayName: "Third" });

    expect(added.role).toBe("member");
    await expect(organizations.addMember(memberContext, third.user.user_id, "member")).rejects.toThrow(
      "조직 Membership을 변경할 권한이 없습니다",
    );
  });

  it("suspended Membership은 Context를 발급하지 않는다", async () => {
    const team = await organizations.createTeam(owner.user.user_id, "Massion Team");
    const ownerContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      team.organization.organization_id,
    );
    const added = await organizations.addMember(ownerContext, member.user.user_id, "member");

    await organizations.suspendMembership(ownerContext, added.membership_id);

    await expect(
      organizations.resolveTenantContext(member.user.user_id, team.organization.organization_id),
    ).rejects.toThrow("활성 Membership이 없습니다");
  });

  it("다른 조직 Context로 target 조직을 읽지 못한다", async () => {
    const team = await organizations.createTeam(owner.user.user_id, "Massion Team");
    const personalContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );

    await expect(organizations.getOrganization(personalContext, team.organization.organization_id)).rejects.toThrow(
      "TenantContext 조직과 대상 조직이 다릅니다",
    );
  });
});
