import { generateKeyPairSync, sign } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationIngress } from "./ingress.js";
import { signGitHubFixture, signSlackFixture } from "./signatures.js";
import { IntegrationStore } from "./store.js";

describe("IntegrationIngress", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: IntegrationStore;
  const slackSecret = "slack-signing-secret";
  const githubSecret = "github-webhook-secret";
  const discordKeys = generateKeyPairSync("ed25519");
  const discordPublicKey = discordKeys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const now = new Date("2026-07-11T12:00:00.000Z");
  const connector = vi.fn(async (_platform: string, _contribution: string, input: unknown) => ({
    kind: "application-command",
    source: input,
  }));
  const scheduled = vi.fn();
  const oauthCallback = vi.fn(async (platform: "slack" | "github") => ({ connected: true, platform }));
  let ingress: IntegrationIngress;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "integration@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await IntegrationStore.create(database, organizations);
    connector.mockClear();
    scheduled.mockClear();
    oauthCallback.mockClear();
    ingress = new IntegrationIngress({
      store,
      secrets: {
        async slackSigningSecret() {
          return slackSecret;
        },
        async discordPublicKey() {
          return discordPublicKey;
        },
        async githubWebhookSecret() {
          return githubSecret;
        },
      },
      connectors: { invoke: connector },
      oauth: { callback: oauthCallback },
      schedule: scheduled,
    });
  });

  afterEach(async () => database.close());

  async function install(platform: "slack" | "discord" | "github", tenant: string, user: string) {
    const installation = await store.connect(context, {
      commandId: `connect-${platform}`,
      platform,
      externalTenantId: tenant,
      credentialRef: `credential:${platform}:primary`,
      scopes: ["surface:write"],
    });
    await store.bindUser(context, {
      commandId: `bind-${platform}`,
      installationId: installation.installationId,
      externalUserId: user,
      userId: context.userId,
    });
    const resource =
      platform === "slack" ? "C012ABCDEF" : platform === "discord" ? "423456789012345678" : "massion/project";
    await store.bindChannel(context, {
      commandId: `bind-channel-${platform}`,
      installationId: installation.installationId,
      externalResourceId: resource,
      resourceKind: platform === "github" ? "repository" : "channel",
      events: ["*"],
    });
    return installation;
  }

  it("Slack slash command를 raw HMAC 검증 후 영속 수락하고 3초용 ACK를 반환한다", async () => {
    const installation = await install("slack", "T012ABCDEF", "U012ABCDEF");
    const body = Buffer.from(
      new URLSearchParams({
        team_id: "T012ABCDEF",
        user_id: "U012ABCDEF",
        channel_id: "C012ABCDEF",
        trigger_id: "12345678.12345678.abcd",
        text: "work create 결제 오류 조사",
      }).toString(),
    );
    const timestamp = String(now.getTime() / 1000);
    const response = await ingress.handle({
      method: "POST",
      path: "/integrations/slack/interactions",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlackFixture(slackSecret, timestamp, body),
      },
      body,
      receivedAt: now,
    });

    expect(response).toMatchObject({ status: 200, body: { response_type: "ephemeral" } });
    expect(connector).toHaveBeenCalledWith(
      "slack",
      "surfaceConnectors:slack",
      expect.objectContaining({ kind: "command" }),
    );
    const claimed = await store.claimDelivery(context, { workerId: "worker", now, leaseMs: 1_000 });
    expect(claimed).toMatchObject({
      installationId: installation.installationId,
      payload: { kind: "application-command" },
    });
    expect(scheduled).toHaveBeenCalledWith(context);
  });

  it("Discord PING은 저장하지 않고 PONG하며 command는 Ed25519 검증 후 ephemeral defer한다", async () => {
    await install("discord", "123456789012345678", "223456789012345678");
    const timestamp = String(now.getTime() / 1000);
    const request = async (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      return await ingress.handle({
        method: "POST",
        path: "/integrations/discord/interactions",
        headers: {
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": sign(
            null,
            Buffer.concat([Buffer.from(timestamp), body]),
            discordKeys.privateKey,
          ).toString("hex"),
        },
        body,
        receivedAt: now,
      });
    };

    await expect(request({ type: 1 })).resolves.toEqual({ status: 200, body: { type: 1 } });
    await expect(
      request({
        id: "323456789012345678",
        type: 2,
        guild_id: "123456789012345678",
        channel_id: "423456789012345678",
        member: { user: { id: "223456789012345678" } },
        data: {
          name: "massion",
          options: [{ name: "work-create", options: [{ name: "request", value: "오류 조사" }] }],
        },
      }),
    ).resolves.toEqual({ status: 200, body: { type: 5, data: { flags: 64 } } });
  });

  it("GitHub webhook을 HMAC·delivery ID·설치 사용자에 결속하고 202를 반환한다", async () => {
    await install("github", "98765432", "12345678");
    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        installation: { id: 98765432 },
        sender: { id: 12345678 },
        repository: { full_name: "massion/project" },
        issue: { number: 42, title: "실패 수정", body: "재현" },
      }),
    );
    const response = await ingress.handle({
      method: "POST",
      path: "/integrations/github/webhooks",
      headers: {
        "x-hub-signature-256": signGitHubFixture(githubSecret, body),
        "x-github-delivery": "b2d3f7c0-90aa-11ee-b9d1-0242ac120002",
        "x-github-event": "issues",
      },
      body,
      receivedAt: now,
    });
    expect(response).toEqual({ status: 202, body: { accepted: true } });
    expect(connector).toHaveBeenCalledWith(
      "github",
      "surfaceConnectors:github",
      expect.objectContaining({ event: "issues", action: "opened" }),
    );
  });

  it("서명 실패는 payload·사용자 존재 여부를 공개하지 않고 401로 거부한다", async () => {
    const response = await ingress.handle({
      method: "POST",
      path: "/integrations/github/webhooks",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: Buffer.from("{}"),
      receivedAt: now,
    });
    expect(response).toEqual({ status: 401, body: { error: "외부 요청 인증에 실패했습니다" } });
    expect(connector).not.toHaveBeenCalled();
  });

  it("Slack·GitHub callback GET만 OAuth coordinator로 전달한다", async () => {
    const response = await ingress.handle({
      method: "GET",
      path: "/integrations/github/setup/callback",
      query: { state: "state", installation_id: "123" },
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(response).toEqual({ status: 200, body: { connected: true, platform: "github" } });
    expect(oauthCallback).toHaveBeenCalledWith("github", { state: "state", installation_id: "123" });
  });
});
