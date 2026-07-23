import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BridgeAdapter } from "./bridge.js";
import { runEntry } from "./entry.js";

const adapter: BridgeAdapter = {
  connect: async () => ({ status: "connected" }),
  query: async () => ({}),
  command: async () => ({}),
  events: async function* () {},
  executions: async function* () {},
  shutdown: async () => undefined,
};

describe("desktop bridge executable entry", () => {
  it("production 환경을 준비한 뒤 실제 stdio bridge를 종료 요청까지 실행한다", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    let stdout = "";
    let exitCode: number | undefined;
    output.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const running = runEntry({
      environment: { MASSION_SERVER_BIN: "/Applications/Massion/server.js" },
      prepareEnvironment: async (environment) => ({ ...environment, PREPARED: "true" }),
      createAdapter: (environment) => {
        expect(environment.PREPARED).toBe("true");
        return adapter;
      },
      stdio: { input, output, error, exit: (code) => (exitCode = code) },
    });

    input.write('{"id":"hello-1","method":"hello","params":{}}\n');
    input.write('{"id":"shutdown-1","method":"shutdown","params":{}}\n');
    await running;

    expect(stdout).toContain('"id":"hello-1","ok":true');
    expect(stdout).toContain('"id":"shutdown-1","ok":true');
    expect(exitCode).toBe(0);
  });

  it("빌드된 entry.js를 단독 실행해 hello 응답 후 shutdown 0으로 종료한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-bridge-entry-"));
    try {
      const bundledRuntime = join(root, "bundle", "surreal");
      const bytes = Buffer.from("surreal-runtime-entry-test");
      await mkdir(dirname(bundledRuntime), { recursive: true });
      await writeFile(bundledRuntime, bytes, { mode: 0o700 });
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/entry.js", import.meta.url))], {
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          MASSION_SERVER_BIN: join(root, "server.js"),
          MASSION_SURREAL_BINARY: bundledRuntime,
          MASSION_SURREAL_SHA256: createHash("sha256").update(bytes).digest("hex"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.stdin.write('{"id":"hello-child","method":"hello","params":{}}\n');
      child.stdin.write('{"id":"shutdown-child","method":"shutdown","params":{}}\n');

      const code = await new Promise<number | null>((resolveCode, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("desktop bridge child 종료 시간을 초과했습니다"));
        }, 5_000);
        child.once("error", reject);
        child.once("close", (value) => {
          clearTimeout(timeout);
          resolveCode(value);
        });
      });
      const responses = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { readonly id: string; readonly ok: boolean });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(responses.map(({ id, ok }) => ({ id, ok }))).toEqual([
        { id: "hello-child", ok: true },
        { id: "shutdown-child", ok: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
