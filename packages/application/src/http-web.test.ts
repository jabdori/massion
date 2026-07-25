import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ApplicationHttpServer, type ApplicationHttpDependencies } from "./http-server.js";

const context = {
  userId: "web-user",
  organizationId: "web-organization",
  membershipId: "web-membership",
  role: "owner" as const,
};

describe("ApplicationHttpServer local Web assets", () => {
  const servers: ApplicationHttpServer[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("index·asset·SPA route를 제공하면서 API와 path traversal을 분리한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-web-root-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html>Massion</html>\n");
    await writeFile(join(root, "assets", "app.js"), "console.log('massion');\n");
    const outside = join(root, "..", "massion-web-private.txt");
    await writeFile(outside, "do not serve\n");
    const dependencies: ApplicationHttpDependencies = {
      auth: {
        async authenticateAccess(authorization) {
          if (authorization !== "Bearer web-token") throw new Error("invalid token");
          return { context, tokenId: "web-token-id", scopes: ["application:*"] };
        },
      },
      queries: {
        async query(_context, _scopes, operation, payload) {
          return { operation, data: payload };
        },
      },
      commands: {
        async dispatch() {
          return { outcome: "succeeded" };
        },
      },
      events: {
        async read(_context, input) {
          return { events: [], cursor: input.after };
        },
      },
      health: {
        async readiness() {
          return { database: true };
        },
      },
    };
    const server = new ApplicationHttpServer(dependencies, { host: "127.0.0.1", webRoot: root });
    servers.push(server);
    const baseUrl = (await server.start()).url;

    const index = await fetch(`${baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("Massion");

    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const spa = await fetch(`${baseUrl}/organization`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("Massion");

    const traversal = await fetch(`${baseUrl}/../private.txt`);
    expect(traversal.status).toBe(404);

    const api = await fetch(`${baseUrl}/api/v1/status`, { headers: { authorization: "Bearer web-token" } });
    expect(api.status).toBe(200);
    await rm(outside, { force: true });
  });
});

describe("ApplicationHttpServer frictionless local session", () => {
  const servers: ApplicationHttpServer[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  // 로컬 access 토큰 → 세션 쿠키를 1단계로 발급하고, 시스템 브라우저 첫 GET에
  // 자동으로 쿠키를 내려주는 bootstrap 흐름을 검증합니다 (일회성 코드 노출 없음).
  it("local-session으로 세션을 예약하고 브라우저 첫 GET에 자동 쿠키를 내려준다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-web-frictionless-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<html>Massion</html>\n");
    const dependencies: ApplicationHttpDependencies = {
      auth: {
        async authenticateAccess(authorization) {
          if (authorization !== "Bearer web-token") throw new Error("invalid token");
          return { context, tokenId: "web-token-id", scopes: ["application:*"] };
        },
      },
      queries: {
        async query() {
          return { data: {} };
        },
      },
      commands: {
        async dispatch() {
          return { outcome: "succeeded" };
        },
      },
      events: {
        async read(_c, input) {
          return { events: [], cursor: input.after };
        },
      },
      health: {
        async readiness() {
          return { database: true };
        },
      },
      webSessions: {
        async issueLoginTicket() {
          throw new Error("unused");
        },
        async exchangeLoginTicket() {
          throw new Error("unused");
        },
        async issueLocalSession(access) {
          return {
            sessionId: "local-1",
            sessionToken: "mws_local.abc",
            csrfToken: "csrf-xyz",
            context: access.context,
            scopes: access.scopes,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          };
        },
        async authenticate() {
          throw new Error("unused");
        },
        async verifyCsrf() {
          return false;
        },
        async rotateCsrf() {
          return "unused";
        },
        async revoke() {},
      },
    };
    const server = new ApplicationHttpServer(dependencies, { host: "127.0.0.1", webRoot: root });
    servers.push(server);
    const baseUrl = (await server.start()).url;

    // 1) CLI가 access 토큰으로 세션을 예약합니다 (브라우저는 access 토큰을 가질 수 없으므로 CLI가 대신).
    const issue = await fetch(`${baseUrl}/api/v1/web/local-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer web-token",
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ commandId: randomUUID() }),
    });
    expect(issue.status).toBe(201);
    expect(issue.headers.get("set-cookie")).toContain("massion_session=");

    // 2) 시스템 브라우저가 콘솔 root를 열면 서버가 예약된 세션 쿠키를 자동으로 내려줍니다.
    const browse = await fetch(`${baseUrl}/`);
    expect(browse.status).toBe(200);
    expect(browse.headers.get("set-cookie")).toContain("massion_session=");

    // 3) 예약은 1회 소비되므로 두 번째 GET에는 자동 쿠키가 더 이상 내려가지 않습니다.
    const again = await fetch(`${baseUrl}/`);
    expect(again.headers.get("set-cookie")).toBeNull();
  });
});
