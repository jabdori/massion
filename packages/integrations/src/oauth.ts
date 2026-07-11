import type { TenantContext } from "@massion/identity";

import type { IntegrationStore } from "./store.js";
import type { IntegrationTokenService } from "./tokens.js";

function value(input: Readonly<Record<string, string | undefined>>, name: string, pattern: RegExp): string {
  const result = input[name];
  if (!result || !pattern.test(result)) throw new Error(`OAuth ${name}이 유효하지 않습니다`);
  return result;
}

export class IntegrationOAuthCoordinator {
  public constructor(
    private readonly dependencies: {
      readonly tokens: IntegrationTokenService;
      readonly store: IntegrationStore;
      readonly slack: {
        readonly clientId: string;
        exchange(input: { readonly code: string; readonly redirectUri: string }): Promise<unknown>;
      };
      readonly github: { readonly appSlug: string };
      readonly credentials: {
        storeSlack(input: {
          readonly context: TenantContext;
          readonly teamId: string;
          readonly accessToken: string;
          readonly scopes: readonly string[];
        }): Promise<string>;
        githubInstallationReference(input: {
          readonly context: TenantContext;
          readonly installationId: string;
        }): Promise<string>;
      };
    },
  ) {}

  public async startSlack(context: TenantContext, input: { redirectUri: string; scopes: readonly string[] }) {
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0 || scopes.length !== input.scopes.length)
      throw new Error("Slack OAuth scope가 유효하지 않습니다");
    const issued = await this.dependencies.tokens.issueOAuthState(context, {
      platform: "slack",
      redirectUri: input.redirectUri,
    });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", this.dependencies.slack.clientId);
    url.searchParams.set("scope", scopes.join(","));
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", issued.state);
    return { authorizeUrl: url.toString(), expiresAt: issued.expiresAt };
  }

  public async startGitHub(context: TenantContext, input: { redirectUri: string }) {
    const issued = await this.dependencies.tokens.issueOAuthState(context, {
      platform: "github",
      redirectUri: input.redirectUri,
    });
    const url = new URL(`https://github.com/apps/${this.dependencies.github.appSlug}/installations/new`);
    url.searchParams.set("state", issued.state);
    return { authorizeUrl: url.toString(), expiresAt: issued.expiresAt };
  }

  public async callback(platform: "slack" | "github", query: Readonly<Record<string, string | undefined>>) {
    const state = value(query, "state", /^[A-Za-z0-9_-]{43}$/u);
    const consumed = await this.dependencies.tokens.consumeOAuthState(state);
    if (consumed.platform !== platform) throw new Error("OAuth state platform이 일치하지 않습니다");
    const returnTo = new URL("/extensions", consumed.redirectUri).toString();
    if (platform === "slack") {
      const code = value(query, "code", /^[A-Za-z0-9._-]{8,512}$/u);
      const response = await this.dependencies.slack.exchange({ code, redirectUri: consumed.redirectUri });
      if (!response || typeof response !== "object" || Array.isArray(response))
        throw new Error("Slack OAuth 응답이 유효하지 않습니다");
      const record = response as Record<string, unknown>;
      const team = record.team;
      const teamId =
        team && typeof team === "object" && !Array.isArray(team) ? (team as Record<string, unknown>).id : undefined;
      if (record.ok !== true || typeof record.access_token !== "string" || typeof teamId !== "string")
        throw new Error("Slack OAuth grant가 유효하지 않습니다");
      const scopes = typeof record.scope === "string" ? record.scope.split(",").filter(Boolean).sort() : [];
      const credentialRef = await this.dependencies.credentials.storeSlack({
        context: consumed.context,
        teamId,
        accessToken: record.access_token,
        scopes,
      });
      const installation = await this.dependencies.store.connect(consumed.context, {
        commandId: `oauth:${consumed.attemptId}:connect`,
        platform: "slack",
        externalTenantId: teamId,
        credentialRef,
        scopes,
      });
      return { connected: true, platform, installationId: installation.installationId, returnTo };
    }
    const installationId = value(query, "installation_id", /^[0-9]{1,20}$/u);
    const setupAction = value(query, "setup_action", /^(?:install|update)$/u);
    const credentialRef = await this.dependencies.credentials.githubInstallationReference({
      context: consumed.context,
      installationId,
    });
    const installation = await this.dependencies.store.connect(consumed.context, {
      commandId: `oauth:${consumed.attemptId}:${setupAction}`,
      platform: "github",
      externalTenantId: installationId,
      credentialRef,
      scopes: ["metadata:read"],
    });
    return { connected: true, platform, installationId: installation.installationId, returnTo };
  }
}
