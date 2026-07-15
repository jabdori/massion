import { afterEach, describe, expect, it } from "vitest";
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
