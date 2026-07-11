import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationOAuthCoordinator } from "./oauth.js";
import { IntegrationStore } from "./store.js";
import { IntegrationTokenService } from "./tokens.js";

describe("Integration OAuth coordinator", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let coordinator: IntegrationOAuthCoordinator;
  const exchange = vi.fn(async () => ({
    ok: true,
    access_token: "xoxb-test-token-that-must-not-enter-database",
    scope: "commands,chat:write",
    team: { id: "T012ABCDEF" },
  }));
  const storeSlack = vi.fn(async () => "credential:slack:T012ABCDEF");

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "oauth@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await IntegrationStore.create(database, organizations);
    const tokens = await IntegrationTokenService.create(database, organizations, Buffer.alloc(32, 9));
    exchange.mockClear();
    storeSlack.mockClear();
    coordinator = new IntegrationOAuthCoordinator({
      tokens,
      store,
      slack: { clientId: "123456789.987654321", exchange },
      github: { appSlug: "massion-agentos" },
      credentials: {
        storeSlack,
        async githubInstallationReference({ installationId }) {
          return `credential:github:${installationId}`;
        },
      },
    });
  });

  afterEach(async () => database.close());

  it("Slack OAuth v2 authorize→state 소비→token vault→installation을 연결한다", async () => {
    const started = await coordinator.startSlack(context, {
      redirectUri: "https://massion.example/integrations/slack/oauth/callback",
      scopes: ["commands", "chat:write"],
    });
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorize.searchParams.get("scope")).toBe("chat:write,commands");
    const state = authorize.searchParams.get("state");
    if (!state) throw new Error("Slack OAuth state가 없습니다");
    const result = await coordinator.callback("slack", { state, code: "temporary-code-123" });
    expect(result).toMatchObject({ connected: true, platform: "slack" });
    expect(exchange).toHaveBeenCalledWith({
      code: "temporary-code-123",
      redirectUri: "https://massion.example/integrations/slack/oauth/callback",
    });
    expect(storeSlack).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T012ABCDEF" }));
    const dump = await database.exportSql();
    expect(dump).not.toContain("xoxb-test-token-that-must-not-enter-database");
    await expect(coordinator.callback("slack", { state, code: "temporary-code-123" })).rejects.toThrow("소비");
  });

  it("GitHub App setup callback을 installation credential reference에 연결한다", async () => {
    const started = await coordinator.startGitHub(context, {
      redirectUri: "https://massion.example/integrations/github/setup/callback",
    });
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.pathname).toBe("/apps/massion-agentos/installations/new");
    const state = authorize.searchParams.get("state");
    if (!state) throw new Error("GitHub state가 없습니다");
    await expect(
      coordinator.callback("github", { state, installation_id: "98765432", setup_action: "install" }),
    ).resolves.toMatchObject({ connected: true, platform: "github" });
  });

  it("Slack state를 GitHub callback에서 교차 소비하지 않는다", async () => {
    const started = await coordinator.startSlack(context, {
      redirectUri: "https://massion.example/integrations/slack/oauth/callback",
      scopes: ["commands"],
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("state가 없습니다");
    await expect(
      coordinator.callback("github", { state, installation_id: "98765432", setup_action: "install" }),
    ).rejects.toThrow("platform");
  });
});
