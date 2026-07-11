import { createHash } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IntegrationTokenService } from "./tokens.js";

describe("Integration OAuth·interaction token", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: IntegrationTokenService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "token@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await IntegrationTokenService.create(database, organizations, Buffer.alloc(32, 7));
  });

  afterEach(async () => database.close());

  it("OAuth state를 HMAC으로만 저장하고 정확히 한 번 소비한다", async () => {
    const issued = await service.issueOAuthState(context, {
      platform: "slack",
      redirectUri: "https://massion.example/integrations/slack/oauth/callback",
    });
    const [rows] = await database.query<[Array<{ state_hash: string }>]>(
      "SELECT state_hash FROM integration_oauth_attempt;",
    );
    expect(rows[0]?.state_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(rows)).not.toContain(issued.state);
    await expect(service.consumeOAuthState(issued.state)).resolves.toMatchObject({
      context,
      platform: "slack",
    });
    await expect(service.consumeOAuthState(issued.state)).rejects.toThrow("소비");
  });

  it("OAuth redirect의 HTTP·fragment·10분 초과 TTL을 거부한다", async () => {
    await expect(
      service.issueOAuthState(context, { platform: "github", redirectUri: "http://massion.example/callback" }),
    ).rejects.toThrow("redirect");
    await expect(
      service.issueOAuthState(context, {
        platform: "github",
        redirectUri: "https://massion.example/callback#token",
      }),
    ).rejects.toThrow("redirect");
  });

  it("제한 승인 handle을 사용자·설치·action·payload에 결속해 한 번만 소비한다", async () => {
    const payloadHash = createHash("sha256").update("approval:approve").digest("hex");
    const issued = await service.issueInteraction(context, {
      installationId: "installation-12345678",
      externalUserId: "U012ABCDEF",
      action: "approval.decide",
      resourceId: "approval-12345678",
      payloadHash,
    });
    await expect(
      service.consumeInteraction(context, {
        installationId: "installation-12345678",
        externalUserId: "U012ABCDEF",
        handle: issued.handle,
        action: "approval.decide",
        payloadHash,
      }),
    ).resolves.toMatchObject({ resourceId: "approval-12345678" });
    await expect(
      service.consumeInteraction(context, {
        installationId: "installation-12345678",
        externalUserId: "U012ABCDEF",
        handle: issued.handle,
        action: "approval.decide",
        payloadHash,
      }),
    ).rejects.toThrow("binding");
  });

  it("다른 외부 사용자와 변조 decision payload는 handle을 소비하지 못한다", async () => {
    const payloadHash = "a".repeat(64);
    const issued = await service.issueInteraction(context, {
      installationId: "installation-12345678",
      externalUserId: "U012ABCDEF",
      action: "approval.decide",
      resourceId: "approval-12345678",
      payloadHash,
    });
    await expect(
      service.consumeInteraction(context, {
        installationId: "installation-12345678",
        externalUserId: "U999999999",
        handle: issued.handle,
        action: "approval.decide",
        payloadHash,
      }),
    ).rejects.toThrow("binding");
    await expect(
      service.consumeInteraction(context, {
        installationId: "installation-12345678",
        externalUserId: "U012ABCDEF",
        handle: issued.handle,
        action: "approval.decide",
        payloadHash: "b".repeat(64),
      }),
    ).rejects.toThrow("binding");
  });
});
