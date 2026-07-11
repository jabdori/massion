import { connect } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationHttpServer } from "./http-server.js";

const context = {
  userId: "security-user",
  organizationId: "security-org",
  membershipId: "security-member",
  role: "owner" as const,
};

describe("Application HTTP security regression", () => {
  let server: ApplicationHttpServer;
  let baseUrl: string;
  let port: number;
  beforeEach(async () => {
    server = new ApplicationHttpServer({
      auth: { authenticateAccess: async () => ({ context, tokenId: "token", scopes: ["application:*"] }) },
      queries: {
        query: async () => {
          throw new Error("secret-database-path-/private/root");
        },
      },
      commands: { dispatch: async () => ({ outcome: "succeeded" }) },
      events: { read: async (_context, input) => ({ events: [], cursor: input.after }) },
    });
    const address = await server.start();
    baseUrl = address.url;
    port = address.port;
  });
  afterEach(async () => server.close());

  it("invalid UTF-8·JSON depth·prototype key를 domain 호출 전에 거부한다", async () => {
    const invalid = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    expect(invalid.status).toBe(400);
    let deep: unknown = "end";
    for (let index = 0; index < 22; index += 1) deep = { child: deep };
    expect(
      (
        await fetch(`${baseUrl}/api/v1/commands`, {
          method: "POST",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify(deep),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/commands`, {
          method: "POST",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: '{"__proto__":{"polluted":true}}',
        })
      ).status,
    ).toBe(400);
  });

  it("내부 cause·path를 500 응답에 노출하지 않는다", async () => {
    const response = await fetch(`${baseUrl}/api/v1/status`, { headers: { authorization: "Bearer token" } });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("private/root");
    expect(text).not.toContain("database-path");
  });

  it("conflicting Content-Length request smuggling과 oversized header를 Node parser에서 차단한다", async () => {
    const raw = async (request: string) =>
      await new Promise<string>((resolveResponse, reject) => {
        const socket = connect({ host: "127.0.0.1", port }, () => socket.write(request));
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          response += chunk;
        });
        socket.on("end", () => resolveResponse(response));
        socket.on("error", reject);
        socket.setTimeout(2000, () => socket.destroy());
      });
    const smuggled = await raw(
      "POST /api/v1/commands HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
    );
    expect(smuggled).toMatch(/^HTTP\/1\.1 400/u);
    const oversized = await raw(
      `GET /api/v1/status HTTP/1.1\r\nHost: localhost\r\nX-Large: ${"x".repeat(20 * 1024)}\r\n\r\n`,
    );
    expect(oversized).toMatch(/^HTTP\/1\.1 431/u);
  });
});
