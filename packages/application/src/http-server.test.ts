import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationEventV1 } from "./contracts.js";
import { ApplicationHttpServer, type ApplicationHttpDependencies } from "./http-server.js";

const context = {
  userId: "http-user",
  organizationId: "http-organization",
  membershipId: "http-membership",
  role: "owner" as const,
};

function event(sequence: number): ApplicationEventV1 {
  return {
    schemaVersion: "massion.application.event.v1",
    eventId: `event-http-${String(sequence).padStart(4, "0")}`,
    organizationId: context.organizationId,
    sequence,
    type: "work.changed",
    author: { kind: "system", id: "test" },
    occurredAt: "2026-07-11T00:00:00.000Z",
    payload: { sequence },
  };
}

describe("ApplicationHttpServer", () => {
  let server: ApplicationHttpServer;
  let baseUrl: string;
  let events: ApplicationEventV1[];
  let calls: string[];

  beforeEach(async () => {
    events = [];
    calls = [];
    const dependencies: ApplicationHttpDependencies = {
      auth: {
        async authenticateAccess(authorization) {
          if (authorization !== "Bearer test-token") throw new Error("invalid token");
          return { context, tokenId: "token-http", scopes: ["application:*"] };
        },
      },
      queries: {
        async query(_context, _scopes, operation, payload) {
          calls.push(`query:${operation}`);
          return { schemaVersion: "massion.application.v1", operation, data: payload };
        },
      },
      commands: {
        async dispatch(_context, _scopes, input) {
          calls.push("command");
          return { outcome: (input as { outcome?: string }).outcome ?? "succeeded" };
        },
      },
      events: {
        async read(_context, input) {
          const selected = events.filter((item) => item.sequence > input.after).slice(0, input.limit);
          return { events: selected, cursor: selected.at(-1)?.sequence ?? input.after };
        },
      },
      tokens: {
        issue: async (_context, input) => ({ tokenId: "issued", ...input }),
        revoke: async () => undefined,
      },
      artifacts: {
        inspect: async (_context, archive) => ({ size: archive.length }),
        install: async (_context, input) => ({ commandId: input.commandId, size: input.archive.length }),
      },
      bootstrap: {
        initialize: async (input) => ({ access: { token: "one-time" }, email: input.email }),
      },
      integrations: {
        async handle(input) {
          calls.push(`integration:${input.path}`);
          return { status: 202, body: { accepted: true, bytes: input.body.length } };
        },
      },
    };
    server = new ApplicationHttpServer(dependencies, { pollMs: 5, heartbeatMs: 20 });
    baseUrl = (await server.start()).url;
  });

  afterEach(async () => server.close());

  it("인증된 status·query·command와 method/content negotiation을 제공한다", async () => {
    const headers = { authorization: "Bearer test-token", accept: "application/json" };
    expect((await fetch(`${baseUrl}/api/v1/status`, { headers })).status).toBe(200);
    const query = await fetch(`${baseUrl}/api/v1/query`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operation: "work.list", payload: {} }),
    });
    expect(query.status).toBe(200);
    const accepted = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "accepted" }),
    });
    expect(accepted.status).toBe(202);
    const wrongMethod = await fetch(`${baseUrl}/api/v1/status`, { method: "POST", headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(calls).toEqual(["query:system.status", "query:work.list", "command"]);
  });

  it("Authorization header만 받고 CORS와 JSON byte 상한을 fail-closed한다", async () => {
    expect((await fetch(`${baseUrl}/api/v1/status?token=test-token`)).status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/status`, {
          headers: { origin: "https://evil.example", authorization: "Bearer test-token" },
        })
      ).status,
    ).toBe(403);
    const oversized = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(400);
  });

  it("loopback bootstrap만 인증 전 일회성 token 발급 경계에 접근한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ commandId: "bootstrap-command-0001", email: "owner@example.com", displayName: "Owner" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ access: { token: "one-time" } });
  });

  it("binary artifact를 JSON envelope와 분리해 inspect·install한다", async () => {
    const inspect = await fetch(`${baseUrl}/api/v1/artifacts/inspect`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/octet-stream",
      },
      body: Buffer.from("artifact"),
    });
    expect(await inspect.json()).toEqual({ size: 8 });
    const install = await fetch(`${baseUrl}/api/v1/artifacts/install`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/octet-stream",
        "x-massion-command-id": "artifact-command-0001",
      },
      body: Buffer.from("artifact"),
    });
    expect(await install.json()).toEqual({ commandId: "artifact-command-0001", size: 8 });
  });

  it("외부 Integration webhook은 Application bearer 인증 전에 전용 gateway로만 전달한다", async () => {
    const response = await fetch(`${baseUrl}/integrations/github/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: JSON.stringify({ installation: { id: 1 } }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, bytes: 25 });
    expect(calls).toEqual(["integration:/integrations/github/webhooks"]);
  });

  it("SSE가 after를 replay하고 Last-Event-ID 재연결을 우선한다", async () => {
    events.push(event(1), event(2), event(3));
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events/stream?after=1`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream", "last-event-id": "2" },
      signal: abort.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body가 없습니다");
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 2");
    abort.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("loopback 밖 bind는 trusted proxy allowlist 없이는 생성부터 거부한다", () => {
    expect(() => new ApplicationHttpServer({} as ApplicationHttpDependencies, { host: "0.0.0.0" })).toThrow(
      "trusted TLS proxy",
    );
  });
});
