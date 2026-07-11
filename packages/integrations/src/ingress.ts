import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import { decodeExternalJson, type IntegrationPlatform } from "./contracts.js";
import { verifyDiscordRequest, verifyGitHubRequest, verifySlackRequest } from "./signatures.js";
import type { IntegrationStore } from "./store.js";

export interface IntegrationHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
  readonly receivedAt?: Date;
}

export interface IntegrationHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface IngressSecrets {
  slackSigningSecret(): Promise<string>;
  discordPublicKey(): Promise<string>;
  githubWebhookSecret(): Promise<string>;
}

interface ConnectorInvoker {
  invoke(platform: IntegrationPlatform, contribution: string, input: unknown): Promise<unknown>;
}

function field(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 65_536)
    throw new Error(`Integration ${name}이 유효하지 않습니다`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function form(body: Buffer): Record<string, string> {
  if (body.length === 0 || body.length > 1024 * 1024)
    throw new Error("Integration form body byte 상한이 유효하지 않습니다");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const params = new URLSearchParams(source);
  const output: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in output) throw new Error("Integration form field가 중복됐습니다");
    output[key] = value;
  }
  return output;
}

function hash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function unauthorized(): IntegrationHttpResponse {
  return { status: 401, body: { error: "외부 요청 인증에 실패했습니다" } };
}

export class IntegrationIngress {
  public constructor(
    private readonly dependencies: {
      readonly store: IntegrationStore;
      readonly secrets: IngressSecrets;
      readonly connectors: ConnectorInvoker;
      readonly oauth?: {
        callback(platform: "slack" | "github", query: Readonly<Record<string, string | undefined>>): Promise<unknown>;
      };
      readonly schedule?: (context: TenantContext) => void;
    },
  ) {}

  public async handle(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
    const callbackPlatform =
      request.path === "/integrations/slack/oauth/callback"
        ? "slack"
        : request.path === "/integrations/github/setup/callback"
          ? "github"
          : undefined;
    if (callbackPlatform) {
      if (request.method !== "GET") return { status: 405, headers: { allow: "GET" } };
      if (!this.dependencies.oauth) return { status: 503, body: { error: "OAuth callback을 사용할 수 없습니다" } };
      try {
        return { status: 200, body: await this.dependencies.oauth.callback(callbackPlatform, request.query ?? {}) };
      } catch (error) {
        return {
          status: 400,
          body: { error: error instanceof Error ? error.message.slice(0, 512) : "OAuth callback을 처리할 수 없습니다" },
        };
      }
    }
    if (request.method !== "POST") return { status: 405, headers: { allow: "POST" } };
    if (request.body.length === 0 || request.body.length > 1024 * 1024)
      return { status: 413, body: { error: "외부 request body 상한을 초과했습니다" } };
    try {
      if (request.path === "/integrations/slack/events" || request.path === "/integrations/slack/interactions")
        return await this.slack(request);
      if (request.path === "/integrations/discord/interactions") return await this.discord(request);
      if (request.path === "/integrations/github/webhooks") return await this.github(request);
      return { status: 404, body: { error: "Integration route를 찾을 수 없습니다" } };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message.slice(0, 512) : "외부 요청을 처리할 수 없습니다" },
      };
    }
  }

  private async slack(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
    const timestamp = request.headers["x-slack-request-timestamp"] ?? "";
    const signature = request.headers["x-slack-signature"] ?? "";
    if (
      !verifySlackRequest({
        signingSecret: await this.dependencies.secrets.slackSigningSecret(),
        timestamp,
        signature,
        body: request.body,
        ...(request.receivedAt === undefined ? {} : { now: request.receivedAt }),
      })
    )
      return unauthorized();
    if (request.path.endsWith("/events")) {
      const payload = object(decodeExternalJson(request.body), "Slack event");
      if (payload.type === "url_verification") return { status: 200, body: { challenge: field(payload, "challenge") } };
      const event = object(payload.event, "Slack event payload");
      const externalTenantId = field(payload, "team_id");
      const externalUserId = field(event, "user");
      const actor = await this.dependencies.store.resolveVerifiedActor("slack", externalTenantId, externalUserId);
      const channelId = field(event, "channel");
      await this.dependencies.store.assertBoundResource(
        actor.context,
        actor.installation.installationId,
        channelId,
        field(event, "type"),
      );
      const normalized = await this.dependencies.connectors.invoke("slack", "surfaceConnectors:slack", {
        kind: "command",
        userId: externalUserId,
        channelId,
        text: field(event, "text").replace(/^<@[A-Z0-9]+>\s*/u, ""),
      });
      await this.accept(
        actor.context,
        actor.installation.installationId,
        field(payload, "event_id"),
        field(event, "type"),
        request,
        normalized,
      );
      return { status: 200, body: {} };
    }
    const values = form(request.body);
    const payload = values.payload ? object(JSON.parse(values.payload) as unknown, "Slack interaction") : undefined;
    const externalTenantId = payload ? field(object(payload.team, "Slack team"), "id") : field(values, "team_id");
    const externalUserId = payload ? field(object(payload.user, "Slack user"), "id") : field(values, "user_id");
    const channelId = payload ? field(object(payload.channel, "Slack channel"), "id") : field(values, "channel_id");
    const deliveryId = payload ? field(payload, "trigger_id") : field(values, "trigger_id");
    const slackAction: unknown = payload && Array.isArray(payload.actions) ? payload.actions[0] : undefined;
    const connectorInput = payload
      ? {
          kind: "interaction",
          userId: externalUserId,
          channelId,
          actionId: field(object(slackAction, "Slack action"), "action_id"),
        }
      : { kind: "command", userId: externalUserId, channelId, text: field(values, "text") };
    const actor = await this.dependencies.store.resolveVerifiedActor("slack", externalTenantId, externalUserId);
    await this.dependencies.store.assertBoundResource(
      actor.context,
      actor.installation.installationId,
      channelId,
      payload ? "interaction" : "slash-command",
    );
    const normalized = await this.dependencies.connectors.invoke("slack", "surfaceConnectors:slack", connectorInput);
    await this.accept(
      actor.context,
      actor.installation.installationId,
      deliveryId,
      payload ? "interaction" : "slash-command",
      request,
      normalized,
    );
    return { status: 200, body: { response_type: "ephemeral", text: "요청을 접수했습니다." } };
  }

  private async discord(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
    if (
      !verifyDiscordRequest({
        publicKeyHex: await this.dependencies.secrets.discordPublicKey(),
        timestamp: request.headers["x-signature-timestamp"] ?? "",
        signature: request.headers["x-signature-ed25519"] ?? "",
        body: request.body,
        ...(request.receivedAt === undefined ? {} : { now: request.receivedAt }),
      })
    )
      return unauthorized();
    const payload = object(decodeExternalJson(request.body), "Discord interaction");
    if (payload.type === 1) return { status: 200, body: { type: 1 } };
    const member = object(payload.member, "Discord member");
    const user = object(member.user ?? payload.user, "Discord user");
    const data = object(payload.data, "Discord command data");
    const externalTenantId = field(payload, "guild_id");
    const externalUserId = field(user, "id");
    const options = Array.isArray(data.options) ? data.options.map((value) => object(value, "Discord option")) : [];
    const first = options[0];
    const nested = Array.isArray(first?.options)
      ? first.options.map((value) => object(value, "Discord nested option"))
      : options;
    const optionRecord = Object.fromEntries(nested.map((option) => [String(option.name), option.value]));
    const actor = await this.dependencies.store.resolveVerifiedActor("discord", externalTenantId, externalUserId);
    const channelId = field(payload, "channel_id");
    await this.dependencies.store.assertBoundResource(
      actor.context,
      actor.installation.installationId,
      channelId,
      `interaction.${String(payload.type)}`,
    );
    const normalized = await this.dependencies.connectors.invoke("discord", "surfaceConnectors:discord", {
      kind: payload.type === 3 ? "component" : "command",
      name: data.name,
      subcommand: first?.name,
      customId: data.custom_id,
      userId: externalUserId,
      channelId,
      options: optionRecord,
    });
    await this.accept(
      actor.context,
      actor.installation.installationId,
      field(payload, "id"),
      `interaction.${String(payload.type)}`,
      request,
      normalized,
    );
    return { status: 200, body: { type: 5, data: { flags: 64 } } };
  }

  private async github(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
    if (
      !verifyGitHubRequest({
        webhookSecret: await this.dependencies.secrets.githubWebhookSecret(),
        signature: request.headers["x-hub-signature-256"] ?? "",
        body: request.body,
      })
    )
      return unauthorized();
    const payload = object(decodeExternalJson(request.body), "GitHub webhook");
    const installation = object(payload.installation, "GitHub installation");
    const sender = object(payload.sender, "GitHub sender");
    const externalTenantId = String(installation.id);
    const externalUserId = String(sender.id);
    const actor = await this.dependencies.store.resolveVerifiedActor("github", externalTenantId, externalUserId);
    const event = request.headers["x-github-event"] ?? "";
    const action = typeof payload.action === "string" ? payload.action : "unknown";
    const repository = object(payload.repository, "GitHub repository");
    await this.dependencies.store.assertBoundResource(
      actor.context,
      actor.installation.installationId,
      field(repository, "full_name"),
      event,
    );
    const normalized = await this.dependencies.connectors.invoke("github", "surfaceConnectors:github", {
      ...payload,
      event,
      action,
    });
    await this.accept(
      actor.context,
      actor.installation.installationId,
      request.headers["x-github-delivery"] ?? "",
      `${event}.${action}`,
      request,
      normalized,
    );
    return { status: 202, body: { accepted: true } };
  }

  private async accept(
    context: TenantContext,
    installationId: string,
    deliveryId: string,
    eventType: string,
    request: IntegrationHttpRequest,
    normalizedPayload: unknown,
  ): Promise<void> {
    await this.dependencies.store.acceptDelivery(context, {
      installationId,
      deliveryId,
      eventType,
      bodyHash: hash(request.body),
      normalizedPayload,
      receivedAt: request.receivedAt ?? new Date(),
    });
    this.dependencies.schedule?.(context);
  }
}
