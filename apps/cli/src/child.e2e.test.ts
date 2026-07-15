import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveCliConfigPath } from "./config.js";

describe("massion child E2E", () => {
  let root: string;
  let endpoint: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "massion-cli-child-"));
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== "Bearer child-token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ category: "authentication" }));
        return;
      }
      if (request.url === "/api/v1/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            schemaVersion: "massion.application.v1",
            operation: "system.status",
            data: { status: "ready" },
          }),
        );
        return;
      }
      if (request.url === "/api/v1/commands") {
        for await (const chunk of request) {
          void chunk;
        }
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ outcome: "accepted", data: { runId: "run-child-0001" } }));
        return;
      }
      if (request.url?.startsWith("/api/v1/events/stream")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'id: 1\nevent: run.completed\ndata: {"sequence":1,"type":"run.completed","correlationId":"other"}\n\n',
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address가 없습니다");
    endpoint = `http://127.0.0.1:${String(address.port)}`;
    close = async () =>
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    const configPath = resolveCliConfigPath({ home: root, xdgConfigHome: root });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "massion.cli.config.v1",
        selectedProfile: "test",
        profiles: { test: { endpoint, tokenReference: "env:MASSION_TOKEN" } },
      }),
      { mode: 0o600 },
    );
  });
  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [resolve("dist/main.js"), ...args], {
      cwd: resolve("."),
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, MASSION_TOKEN: "child-token", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    return { code, stdout, stderr };
  }

  it("status JSON stdout purity와 run detach exit code를 보장한다", async () => {
    const status = await run(["status", "--json"]);
    expect(status).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(status.stdout)).toMatchObject({ data: { status: "ready" } });
    const detached = await run(["run", "제품화", "--detach", "--json"]);
    expect(detached).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(detached.stdout)).toMatchObject({ type: "accepted", runId: "run-child-0001" });
  });
});
