import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationAccessTokenService, type ApplicationTokenClock } from "./auth.js";
import { APPLICATION_AUTH_MIGRATION } from "./schema.js";

class MutableClock implements ApplicationTokenClock {
  public constructor(public now: Date) {}
}

describe("ApplicationAccessTokenService", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let clock: MutableClock;
  let tokens: ApplicationAccessTokenService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "surface@example.com", displayName: "Surface" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    clock = new MutableClock(new Date("2026-07-11T00:00:00.000Z"));
    tokens = await ApplicationAccessTokenService.create(database, organizations, {
      keyId: "surface-hmac-v1",
      key: Buffer.alloc(32, 7),
      clock,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it("0065 migration과 checksum을 고정한다", () => {
    expect(APPLICATION_AUTH_MIGRATION.id).toBe("0065-application-auth");
    expect(APPLICATION_AUTH_MIGRATION.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("32-byte token 원문은 최초 한 번만 반환하고 keyed hash·metadata만 저장한다", async () => {
    const first = await tokens.issue(context, {
      commandId: "issue-surface-token-0001",
      audience: "massion-api",
      scopes: ["work:read", "work:write"],
      ttlSeconds: 3_600,
    });
    expect(first.replayed).toBe(false);
    expect(first.token).toMatch(/^mat_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    const repeated = await tokens.issue(context, {
      commandId: "issue-surface-token-0001",
      audience: "massion-api",
      scopes: ["work:read", "work:write"],
      ttlSeconds: 3_600,
    });
    expect(repeated).toMatchObject({ tokenId: first.tokenId, replayed: true });
    expect(repeated).not.toHaveProperty("token");
    await expect(
      tokens.issue(context, {
        commandId: "issue-surface-token-0001",
        audience: "other-api",
        scopes: ["work:read"],
        ttlSeconds: 3_600,
      }),
    ).rejects.toThrow("같은 commandId");

    const [stored] = await database.query<
      [Array<{ token_hash: string; key_id: string; scopes: string[]; request_hash: string }>]
    >("SELECT token_hash, key_id, scopes, request_hash FROM application_access_token;");
    expect(stored[0]).toMatchObject({ key_id: "surface-hmac-v1", scopes: ["work:read", "work:write"] });
    expect(stored[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(first.token);
  });

  it("Bearer header의 hash·audience·scope·expiry·revoke와 Membership을 매 요청 검증한다", async () => {
    const issued = await tokens.issue(context, {
      commandId: "issue-auth-token-0001",
      audience: "massion-api",
      scopes: ["work:read"],
      ttlSeconds: 60,
    });
    if (!issued.token) throw new Error("최초 token 원문이 없습니다");

    await expect(tokens.authenticate(`Bearer ${issued.token}`, "massion-api", ["work:read"])).resolves.toEqual(context);
    await expect(tokens.authenticateAccess(`Bearer ${issued.token}`, "massion-api", [])).resolves.toMatchObject({
      context,
      tokenId: issued.tokenId,
      scopes: ["work:read"],
    });
    await expect(tokens.authenticate(`Bearer ${issued.token}`, "other-api", ["work:read"])).rejects.toThrow("audience");
    await expect(tokens.authenticate(`Bearer ${issued.token}`, "massion-api", ["work:write"])).rejects.toThrow("scope");
    await expect(tokens.authenticate(issued.token, "massion-api", ["work:read"])).rejects.toThrow("Bearer");
    await expect(tokens.authenticate(`Bearer ${issued.token} extra`, "massion-api", ["work:read"])).rejects.toThrow(
      "Bearer",
    );
    await expect(
      tokens.authenticate(`Bearer ${issued.token.slice(0, -1)}x`, "massion-api", ["work:read"]),
    ).rejects.toThrow("token");

    clock.now = new Date("2026-07-11T00:01:01.000Z");
    await expect(tokens.authenticate(`Bearer ${issued.token}`, "massion-api", ["work:read"])).rejects.toThrow("만료");
    clock.now = new Date("2026-07-11T00:00:30.000Z");
    await tokens.revoke(context, { commandId: "revoke-auth-token-0001", tokenId: issued.tokenId });
    await expect(tokens.authenticate(`Bearer ${issued.token}`, "massion-api", ["work:read"])).rejects.toThrow("폐기");
  });

  it("다른 조직 token과 suspended Membership을 tenant context로 사용할 수 없다", async () => {
    const identities = await IdentityService.create(database);
    const other = await identities.registerPersonalUser({ email: "other-surface@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const issued = await tokens.issue(otherContext, {
      commandId: "issue-other-token-0001",
      audience: "massion-api",
      scopes: ["work:read"],
      ttlSeconds: 60,
    });
    if (!issued.token) throw new Error("최초 token 원문이 없습니다");
    expect((await tokens.authenticate(`Bearer ${issued.token}`, "massion-api", ["work:read"])).organizationId).toBe(
      otherContext.organizationId,
    );
    await expect(
      tokens.revoke(context, { commandId: "cross-revoke-token-0001", tokenId: issued.tokenId }),
    ).rejects.toThrow("token");

    const member = await identities.registerPersonalUser({ email: "member@example.com", displayName: "Member" });
    const membership = await organizations.addMember(context, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(member.user.user_id, context.organizationId);
    const memberToken = await tokens.issue(memberContext, {
      commandId: "issue-member-token-0001",
      audience: "massion-api",
      scopes: ["work:read"],
      ttlSeconds: 60,
    });
    if (!memberToken.token) throw new Error("최초 token 원문이 없습니다");
    await organizations.suspendMembership(context, membership.membership_id, membership.revision);
    await expect(tokens.authenticate(`Bearer ${memberToken.token}`, "massion-api", ["work:read"])).rejects.toThrow(
      "Membership",
    );
  });
});
