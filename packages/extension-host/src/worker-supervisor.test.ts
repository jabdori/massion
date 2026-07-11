import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionWorkerSupervisor } from "./worker-supervisor.js";

const roots: string[] = [];
const manifestDigest = "a".repeat(64);

function workerSource(
  options: { readonly digest?: string; readonly pollution?: boolean; readonly ignoreHealth?: boolean } = {},
) {
  return `
import { createInterface } from "node:readline";
${options.pollution ? 'process.stdout.write("worker started\\n");' : ""}
let outputSequence = 0;
const send = (request, operation, payload) => process.stdout.write(JSON.stringify({
  protocol: "massion.extension.rpc.v1",
  requestId: request.requestId,
  sequence: ++outputSequence,
  operation,
  payload,
}) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.operation === "host.handshake") {
    send(request, "worker.handshake", {
      nonce: request.payload.nonce,
      manifestDigest: "${options.digest ?? manifestDigest}",
      sdkVersion: "1.0.0",
      contributions: ["runtimeTool:probe"],
    });
  } else if (request.operation === "health.check") {
    ${options.ignoreHealth ? "continue;" : 'send(request, "health.result", { status: "healthy" });'}
  } else if (request.operation === "contribution.invoke") {
    const result = { databaseUrl: process.env.MASSION_DATABASE_URL ?? null };
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(new URL("blocked.txt", import.meta.url), "blocked");
      result.fileWrite = "allowed";
    } catch (error) { result.fileWrite = error.code ?? error.name; }
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync(process.execPath, ["--version"]);
      result.childProcess = "allowed";
    } catch (error) { result.childProcess = error.code ?? error.name; }
    try {
      const { Worker } = await import("node:worker_threads");
      new Worker("", { eval: true });
      result.workerThread = "allowed";
    } catch (error) { result.workerThread = error.code ?? error.name; }
    send(request, "contribution.result", result);
  } else if (request.operation === "host.stop") {
    send(request, "worker.stopped", {});
    process.exitCode = 0;
    break;
  }
}`;
}

async function fixture(options: Parameters<typeof workerSource>[0] = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "massion-worker-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "dist", "worker.js"), workerSource(options));
  return root;
}

afterEach(async () => {
  delete process.env.MASSION_DATABASE_URL;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("ExtensionWorkerSupervisor", () => {
  it("nonce handshake·health·invoke·stop을 수행하고 Host credential을 상속하지 않는다", async () => {
    const versionDirectory = await fixture();
    process.env.MASSION_DATABASE_URL = "ws://secret-database/rpc";
    const supervisor = new ExtensionWorkerSupervisor();
    const worker = await supervisor.start({
      trustLevel: "built-in",
      versionDirectory,
      entrypoint: "dist/worker.js",
      manifestDigest,
      sdkVersion: "1.0.0",
      contributions: ["runtimeTool:probe"],
      healthTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
    });

    const result = (await worker.invoke("runtimeTool:probe", { action: "probe" }, 2_000)) as Record<string, unknown>;

    expect(result.databaseUrl).toBeNull();
    expect(result.fileWrite).toBe("ERR_ACCESS_DENIED");
    expect(result.childProcess).toBe("ERR_ACCESS_DENIED");
    expect(result.workerThread).toBe("ERR_ACCESS_DENIED");
    await worker.stop();
  });

  it("manifest mismatch·stdout 오염·health timeout을 fail closed한다", async () => {
    const supervisor = new ExtensionWorkerSupervisor();
    await expect(
      supervisor.start({
        trustLevel: "built-in",
        versionDirectory: await fixture({ digest: "b".repeat(64) }),
        entrypoint: "dist/worker.js",
        manifestDigest,
        sdkVersion: "1.0.0",
        contributions: ["runtimeTool:probe"],
        healthTimeoutMs: 500,
        stopTimeoutMs: 500,
      }),
    ).rejects.toThrow("manifest digest");
    await expect(
      supervisor.start({
        trustLevel: "built-in",
        versionDirectory: await fixture({ pollution: true }),
        entrypoint: "dist/worker.js",
        manifestDigest,
        sdkVersion: "1.0.0",
        contributions: ["runtimeTool:probe"],
        healthTimeoutMs: 500,
        stopTimeoutMs: 500,
      }),
    ).rejects.toThrow("JSON");
    await expect(
      supervisor.start({
        trustLevel: "built-in",
        versionDirectory: await fixture({ ignoreHealth: true }),
        entrypoint: "dist/worker.js",
        manifestDigest,
        sdkVersion: "1.0.0",
        contributions: ["runtimeTool:probe"],
        healthTimeoutMs: 100,
        stopTimeoutMs: 100,
      }),
    ).rejects.toThrow("timeout");
  });

  it("외부 package는 sandbox backend 없이 process를 시작하지 않는다", async () => {
    const supervisor = new ExtensionWorkerSupervisor();
    await expect(
      supervisor.start({
        trustLevel: "verified",
        versionDirectory: await fixture(),
        entrypoint: "dist/worker.js",
        manifestDigest,
        sdkVersion: "1.0.0",
        contributions: ["runtimeTool:probe"],
        healthTimeoutMs: 500,
        stopTimeoutMs: 500,
      }),
    ).rejects.toThrow("sandbox");
  });
});
