import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import type { ApplicationEventV1 } from "./contracts.js";
import { ApplicationEventCursorExpiredError } from "./event-store.js";
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
        async refreshLocalAccess(authorization, audience, requiredScopes, input) {
          if (authorization !== "Bearer expired-token") throw new Error("invalid refresh token");
          expect(audience).toBe("massion-api");
          expect(requiredScopes).toEqual([]);
          expect(input.commandId).toBe("refresh-http-token-0001");
          return {
            tokenId: "refreshed-http-token",
            organizationId: context.organizationId,
            userId: context.userId,
            audience,
            scopes: ["application:*"],
            issuedAt: "2026-07-11T00:00:00.000Z",
            expiresAt: "2026-07-11T01:00:00.000Z",
            replayed: false,
            token: "mat_refreshed-token",
          };
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
          if (input.after === 99) throw new ApplicationEventCursorExpiredError(100);
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
      registryPublisher: {
        publish: async (_context, input) => ({
          commandId: input.commandId,
          size: input.archive.length,
          metadata: input.metadata,
        }),
      },
      connectorEnrollments: {
        issue: async (_context, input) => ({
          enrollmentId: "enrollment-http-1",
          enrollmentCode: "one-time-enrollment-code",
          challengeNonce: "one-time-challenge",
          expiresAt: "2030-01-01T00:10:00.000Z",
          ...input,
        }),
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
      health: {
        async readiness() {
          return { database: true, migrations: true };
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

  it("인증 없이 생존·준비 상태를 공개하고 drain 중 일반 traffic을 거부한다", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "live" });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ components: { database: "ready", migrations: "ready" }, status: "ready" });

    server.beginDrain();
    const draining = await fetch(`${baseUrl}/health/ready`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({ status: "not-ready" });
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/status`, {
          headers: { authorization: "Bearer test-token", accept: "application/json" },
        })
      ).status,
    ).toBe(503);
  });

  it("drain이 활성 SSE 연결을 닫아 server close가 완료된다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE body가 없습니다");
    await reader.read();

    const closing = server.close();
    await expect(Promise.race([closing.then(() => true), delay(250).then(() => false)])).resolves.toBe(true);
    await reader.cancel().catch(() => undefined);
    await closing;
  });

  it("component readiness 오류 원문을 숨기고 고정 상태만 반환한다", async () => {
    await server.close();
    server = new ApplicationHttpServer({
      auth: { authenticateAccess: async () => ({ context, tokenId: "token", scopes: ["application:*"] }) },
      queries: { query: async () => ({}) },
      commands: { dispatch: async () => ({}) },
      events: { read: async () => ({ events: [], cursor: 0 }) },
      health: { readiness: async () => Promise.reject(new Error("secret database URL")) },
    });
    baseUrl = (await server.start()).url;

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready" });
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

  it("loopback access refresh는 만료된 Bearer 원문으로만 새 token을 발급한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/access/refresh`, {
      method: "POST",
      headers: {
        authorization: "Bearer expired-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "refresh-http-token-0001" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ access: { token: "mat_refreshed-token", replayed: false } });
  });

  it("loopback access refresh의 잘못된 token은 내부 오류 대신 인증 오류로 반환한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/access/refresh`, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "refresh-http-token-0002" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ category: "authentication", operatorCode: "APP_HTTP_AUTH" });
  });

  it("Connector enrollment code는 인증된 전용 non-cache HTTP 응답으로만 발급한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "connector-enrollment-command-0001",
        location: "edge",
        executionKind: "agent-runtime",
        ttlMs: 60_000,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      enrollmentId: "enrollment-http-1",
      enrollmentCode: "one-time-enrollment-code",
      challengeNonce: "one-time-challenge",
    });
    const serverEnrollment = await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "server-enrollment-must-use-provisioning",
        location: "server",
        executionKind: "agent-runtime",
      }),
    });
    expect(serverEnrollment.status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/subscriptions/connectors/enrollments`, {
          headers: { authorization: "Bearer test-token" },
        })
      ).status,
    ).toBe(405);
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

  it("Registry publish metadata와 artifact를 versioned binary frame으로 분리한다", async () => {
    const metadata = Buffer.from(JSON.stringify({ uploadGrant: "grant-reference", visibility: "public" }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    const response = await fetch(`${baseUrl}/api/v1/registry/publish`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json",
        "content-type": "application/vnd.massion.registry-publish.v1",
        "x-massion-command-id": "registry-publish-command-1",
      },
      body: Buffer.concat([prefix, metadata, Buffer.from("artifact")]),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      commandId: "registry-publish-command-1",
      size: 8,
      metadata: { uploadGrant: "grant-reference", visibility: "public" },
    });
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

  it("SSE header를 열기 전에 만료 cursor를 공개 409 오류로 반환한다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/stream?after=99`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      category: "conflict",
      operatorCode: "APP_EVENT_CURSOR_EXPIRED",
      retryable: true,
    });
  });

  it("loopback 밖 bind는 trusted proxy allowlist 없이는 생성부터 거부한다", () => {
    expect(() => new ApplicationHttpServer({} as ApplicationHttpDependencies, { host: "0.0.0.0" })).toThrow(
      "trusted TLS proxy",
    );
  });
});
