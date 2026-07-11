import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { GrowthConfigurationStore } from "./configuration.js";
import type { ConfigureGrowthInput, GrowthConfigurationAuthorizer } from "./contracts.js";

class AllowConfigurationAuthorizer implements GrowthConfigurationAuthorizer {
  public calls: ConfigureGrowthInput[] = [];

  public async authorizeConfiguration(_context: TenantContext, input: ConfigureGrowthInput) {
    this.calls.push(input);
    return { governanceDecisionId: `decision-${input.commandId}` };
  }
}

describe("GrowthConfigurationStore", () => {
  let database: MassionDatabase;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let ownerContext: TenantContext;
  let memberContext: TenantContext;
  let otherContext: TenantContext;
  let memberId: string;
  let authorizer: AllowConfigurationAuthorizer;
  let store: GrowthConfigurationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "growth-owner@example.com", displayName: "Owner" });
    const member = await identity.registerPersonalUser({
      email: "growth-member@example.com",
      displayName: "Member",
    });
    const other = await identity.registerPersonalUser({ email: "growth-other@example.com", displayName: "Other" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const membership = await organizations.addMember(ownerContext, member.user.user_id, "member");
    memberId = membership.membership_id;
    memberContext = await organizations.resolveTenantContext(member.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    authorizer = new AllowConfigurationAuthorizer();
    store = await GrowthConfigurationStore.create(database, organizations, authorizer);
  });

  afterEach(async () => database.close());

  it("기존 조직에 enabled와 review 기본 설정을 한 번 생성한다", async () => {
    const resolved = await store.resolve(ownerContext);

    expect(resolved).toMatchObject({
      organizationId: ownerContext.organizationId,
      subject: { type: "organization" },
      version: 1,
      reflectionEnabled: true,
      adoptionMode: "review",
      status: "active",
      governanceDecisionId: "system-bootstrap",
    });
    expect(resolved.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("Growth 서비스 시작 뒤 생성된 조직에도 기본 설정을 만든다", async () => {
    const late = await identity.registerPersonalUser({ email: "growth-late@example.com", displayName: "Late" });
    const lateContext = await organizations.resolveTenantContext(late.user.user_id, late.organization.organization_id);

    expect(await store.resolve(lateContext)).toMatchObject({
      organizationId: lateContext.organizationId,
      subject: { type: "organization" },
      version: 1,
      reflectionEnabled: true,
      adoptionMode: "review",
    });
  });

  it("같은 조직의 활성 사용자 설정을 조직 기본보다 먼저 해석한다", async () => {
    const configured = await store.configure(ownerContext, {
      commandId: "member-auto",
      subject: { type: "user", userId: memberContext.userId },
      reflectionEnabled: true,
      adoptionMode: "auto",
    });

    expect(await store.resolve(memberContext, memberContext.userId)).toEqual(configured);
    expect((await store.resolve(ownerContext)).adoptionMode).toBe("review");
    expect(authorizer.calls).toHaveLength(1);
  });

  it("다른 조직 사용자 설정을 거부하고 탈퇴 사용자의 설정은 조직 기본으로 되돌린다", async () => {
    await expect(
      store.configure(ownerContext, {
        commandId: "other-user",
        subject: { type: "user", userId: otherContext.userId },
        reflectionEnabled: true,
        adoptionMode: "auto",
      }),
    ).rejects.toThrow("활성 Membership");

    await store.configure(ownerContext, {
      commandId: "member-review",
      subject: { type: "user", userId: memberContext.userId },
      reflectionEnabled: false,
      adoptionMode: "review",
    });
    await organizations.suspendMembership(ownerContext, memberId);

    expect((await store.resolve(ownerContext, memberContext.userId)).subject).toEqual({ type: "organization" });
  });

  it("다른 tenant의 설정을 읽지 않는다", async () => {
    const other = await store.resolve(otherContext);

    expect(other.organizationId).toBe(otherContext.organizationId);
    expect(other.organizationId).not.toBe(ownerContext.organizationId);
  });

  it("같은 command와 payload는 재생하고 payload 충돌은 거부한다", async () => {
    const input = {
      commandId: "organization-auto",
      subject: { type: "organization" as const },
      reflectionEnabled: true,
      adoptionMode: "auto" as const,
      expectedVersion: 1,
    };
    const first = await store.configure(ownerContext, input);
    const repeated = await store.configure(ownerContext, input);

    expect(repeated).toEqual(first);
    await expect(store.configure(ownerContext, { ...input, adoptionMode: "review" })).rejects.toThrow("같은 commandId");
  });

  it("command 재생 전에도 TenantContext를 검증한다", async () => {
    const input = {
      commandId: "protected-replay",
      subject: { type: "organization" as const },
      reflectionEnabled: true,
      adoptionMode: "auto" as const,
      expectedVersion: 1,
    };
    await store.configure(ownerContext, input);

    await expect(
      store.configure({ ...otherContext, organizationId: ownerContext.organizationId }, input),
    ).rejects.toThrow("유효하지 않은 TenantContext");
  });

  it("이전 version 선행조건과 활성 version 한 건을 강제한다", async () => {
    await expect(
      store.configure(ownerContext, {
        commandId: "wrong-version",
        subject: { type: "organization" },
        reflectionEnabled: false,
        adoptionMode: "review",
        expectedVersion: 9,
      }),
    ).rejects.toThrow("version precondition");

    await store.configure(ownerContext, {
      commandId: "next-version",
      subject: { type: "organization" },
      reflectionEnabled: false,
      adoptionMode: "review",
      expectedVersion: 1,
    });
    const [active] = await database.query<[Array<{ count: number }>]>(
      "SELECT count() FROM growth_configuration_version WHERE organization_id = $organization_id AND subject_key = $subject_key AND status = 'active' GROUP ALL;",
      { organization_id: ownerContext.organizationId, subject_key: "organization" },
    );

    expect(active[0]?.count).toBe(1);
    expect((await store.resolve(ownerContext)).version).toBe(2);
  });

  it("동시 설정 변경에서도 활성 version을 한 건만 유지한다", async () => {
    const results = await Promise.allSettled([
      store.configure(ownerContext, {
        commandId: "concurrent-a",
        subject: { type: "organization" },
        reflectionEnabled: false,
        adoptionMode: "review",
        expectedVersion: 1,
      }),
      store.configure(ownerContext, {
        commandId: "concurrent-b",
        subject: { type: "organization" },
        reflectionEnabled: true,
        adoptionMode: "auto",
        expectedVersion: 1,
      }),
    ]);
    const [active] = await database.query<[Array<{ count: number }>]>(
      "SELECT count() FROM growth_configuration_version WHERE active_guard_key = $active_guard_key GROUP ALL;",
      { active_guard_key: `${ownerContext.organizationId}:organization` },
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(active[0]?.count).toBe(1);
  });
});
