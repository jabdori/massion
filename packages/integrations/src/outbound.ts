import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { IntegrationPlatform } from "./contracts.js";
import type { IntegrationStore } from "./store.js";

interface OutboundNetworkResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 65_536): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function publicSummary(payload: unknown): string {
  const root = object(payload, "Integration response payload");
  const result = object(root.result, "Application result");
  const operation = typeof result.operation === "string" ? result.operation : "request";
  const outcome = typeof result.outcome === "string" ? result.outcome : "completed";
  const resource =
    result.resource && typeof result.resource === "object" ? (result.resource as Record<string, unknown>) : undefined;
  const suffix =
    typeof resource?.type === "string" && typeof resource.id === "string" ? ` · ${resource.type} ${resource.id}` : "";
  return `Massion ${operation}: ${outcome}${suffix}`.slice(0, 2_000);
}

function requestFromRendered(platform: IntegrationPlatform, destination: string, renderedValue: unknown) {
  const rendered = object(renderedValue, "Extension outbound request");
  if (platform === "slack") {
    if (rendered.method !== "chat.postMessage") throw new Error("Slack outbound method를 허용하지 않습니다");
    return {
      origin: "https://slack.com",
      method: "POST",
      path: "/api/chat.postMessage",
      headers: {},
      body: { ...object(rendered.body, "Slack message"), channel: destination },
    } as const;
  }
  if (platform === "discord") {
    if (rendered.method !== "POST") throw new Error("Discord outbound method를 허용하지 않습니다");
    return {
      origin: "https://discord.com",
      method: "POST",
      path: `/api/v10/channels/${encodeURIComponent(destination)}/messages`,
      headers: {},
      body: object(rendered.body, "Discord message"),
    } as const;
  }
  const method = text(rendered.method, "GitHub method", 8);
  if (!new Set(["GET", "POST", "PUT", "PATCH"]).has(method))
    throw new Error("GitHub outbound method를 허용하지 않습니다");
  const path = text(rendered.path, "GitHub path", 1_024);
  if (!path.startsWith("/repos/") || path.includes("..")) throw new Error("GitHub outbound path를 허용하지 않습니다");
  return {
    origin: "https://api.github.com",
    method,
    path,
    headers: object(rendered.headers ?? {}, "GitHub headers"),
    body: rendered.body,
  };
}

export class IntegrationOutboundDispatcher {
  public constructor(
    private readonly dependencies: {
      readonly store: IntegrationStore;
      readonly connectors: {
        invoke(platform: IntegrationPlatform, contribution: string, input: unknown): Promise<unknown>;
      };
      readonly network: {
        request(input: {
          readonly context: TenantContext;
          readonly credentialRef: string;
          readonly origin: string;
          readonly method: string;
          readonly path: string;
          readonly headers: Readonly<Record<string, unknown>>;
          readonly body: unknown;
          readonly idempotencyKey: string;
        }): Promise<OutboundNetworkResponse>;
      };
    },
  ) {}

  public async runOnce(context: TenantContext, workerId: string, now = new Date()): Promise<boolean> {
    const item = await this.dependencies.store.claimOutbox(context, { workerId, now, leaseMs: 30_000 });
    if (!item) return false;
    try {
      const installation = await this.dependencies.store.getInstallation(context, item.installationId);
      await this.dependencies.store.assertBoundResource(context, item.installationId, item.destination, item.operation);
      const contribution =
        installation.platform === "github"
          ? "eventConsumers:github-sync"
          : `eventConsumers:${installation.platform}-notification`;
      const connectorInput =
        installation.platform === "slack"
          ? { destination: item.destination, text: publicSummary(item.payload) }
          : installation.platform === "discord"
            ? { channelId: item.destination, text: publicSummary(item.payload) }
            : item.payload;
      const rendered = await this.dependencies.connectors.invoke(installation.platform, contribution, connectorInput);
      const request = requestFromRendered(installation.platform, item.destination, rendered);
      const response = await this.dependencies.network.request({
        context,
        credentialRef: installation.credentialRef,
        ...request,
        idempotencyKey: item.idempotencyKey,
      });
      if (response.status === 429 || response.status >= 500) {
        await this.retry(
          context,
          item,
          workerId,
          now,
          response.status === 429 ? response.headers["retry-after"] : undefined,
        );
        return true;
      }
      if (response.status < 200 || response.status >= 300) {
        await this.dependencies.store.blockOutbox(context, {
          outboxId: item.outboxId,
          workerId,
          leaseGeneration: item.leaseGeneration,
          errorCategory: `http-${String(response.status)}`,
        });
        return true;
      }
      const responseRecord =
        response.body && typeof response.body === "object" ? (response.body as Record<string, unknown>) : {};
      const externalId =
        [responseRecord.ts, responseRecord.id, responseRecord.number]
          .find((value) => typeof value === "string" || typeof value === "number")
          ?.toString() ?? sha256(canonical(response.body)).slice(0, 24);
      const candidateUrl = typeof responseRecord.html_url === "string" ? responseRecord.html_url : undefined;
      const externalUrl =
        candidateUrl && /^https:\/\/(?:github\.com|slack\.com|discord\.com)\//u.test(candidateUrl)
          ? candidateUrl
          : undefined;
      await this.dependencies.store.completeOutbox(context, {
        outboxId: item.outboxId,
        workerId,
        leaseGeneration: item.leaseGeneration,
        externalId,
        ...(externalUrl === undefined ? {} : { externalUrl }),
        responseHash: sha256(canonical(response.body)),
      });
    } catch {
      await this.retry(context, item, workerId, now);
    }
    return true;
  }

  private async retry(
    context: TenantContext,
    item: NonNullable<Awaited<ReturnType<IntegrationStore["claimOutbox"]>>>,
    workerId: string,
    now: Date,
    retryAfter?: string,
  ): Promise<void> {
    if (item.attempt >= 8) {
      await this.dependencies.store.blockOutbox(context, {
        outboxId: item.outboxId,
        workerId,
        leaseGeneration: item.leaseGeneration,
        errorCategory: "retry-exhausted",
      });
      return;
    }
    const officialDelay =
      retryAfter && /^[1-9][0-9]{0,3}$/u.test(retryAfter) ? Math.min(3_600, Number(retryAfter)) * 1_000 : undefined;
    const jitter = Number.parseInt(sha256(item.outboxId).slice(0, 4), 16) % 1_000;
    const delay = officialDelay ?? Math.min(60_000, 1_000 * 2 ** Math.max(0, item.attempt - 1)) + jitter;
    await this.dependencies.store.retryOutbox(context, {
      outboxId: item.outboxId,
      workerId,
      leaseGeneration: item.leaseGeneration,
      nextAttemptAt: new Date(now.getTime() + delay),
      errorCategory: officialDelay === undefined ? "transient" : "rate-limit",
    });
  }
}
