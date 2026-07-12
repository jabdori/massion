import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

describe("massion-server process", () => {
  it("backup 일회성 command가 owner-only artifact를 만들고 종료한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-server-backup-command-"));
    const path = join(directory, "backup.json");
    try {
      const child = spawnSync(process.execPath, ["dist/main.js", "backup", path], {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          MASSION_TOKEN_KEY: Buffer.alloc(32, 12).toString("base64url"),
          MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 13).toString("base64url"),
          MASSION_SOFTWARE_WORKSPACE_ROOT: `/tmp/massion-main-e2e-${String(process.pid)}-a`,
          MASSION_CONNECTOR_ROOT: `/tmp/massion-main-e2e-${String(process.pid)}-a/connectors`,
          MASSION_DATABASE_URL: "mem://",
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout) as { event: string }).toMatchObject({ event: "server.backup.completed" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { signal: "SIGTERM" as const, httpPort: "32142", metricsPort: "32145", registryPort: "32148" },
    { signal: "SIGINT" as const, httpPort: "32146", metricsPort: "32147", registryPort: "32149" },
  ])(
    "준비 완료 뒤 $signal에서 drain하고 종료 코드 0으로 끝난다",
    async ({ signal, httpPort, metricsPort, registryPort }) => {
      const softwareWorkspaceRoot = `/tmp/massion-main-e2e-${String(process.pid)}-${signal.toLowerCase()}`;
      const child = spawn(process.execPath, ["dist/main.js"], {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          MASSION_TOKEN_KEY: Buffer.alloc(32, 11).toString("base64url"),
          MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 14).toString("base64url"),
          MASSION_SOFTWARE_WORKSPACE_ROOT: softwareWorkspaceRoot,
          MASSION_CONNECTOR_ROOT: join(softwareWorkspaceRoot, "connectors"),
          MASSION_DATABASE_URL: "mem://",
          MASSION_HTTP_PORT: httpPort,
          MASSION_METRICS_PORT: metricsPort,
          MASSION_REGISTRY_PORT: registryPort,
          MASSION_SHUTDOWN_TIMEOUT_MS: "5000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const events: string[] = [];
      const stderr: string[] = [];
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderr.push(chunk));
      const lines = createInterface({ input: child.stdout });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server.ready 대기 시간을 초과했습니다")), 15_000);
        child.once("exit", (code, exitSignal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `server.ready 전에 종료됐습니다: code=${String(code)}, signal=${String(exitSignal)}, stderr=${stderr.join("")}`,
            ),
          );
        });
        lines.on("line", (line) => {
          const parsed = JSON.parse(line) as { event?: string };
          if (parsed.event) events.push(parsed.event);
          if (parsed.event === "server.ready") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      try {
        await ready;
        child.kill(signal);
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        expect(result).toEqual({ code: 0, signal: null });
        expect(events).toEqual(["server.ready", "server.shutdown.started", "server.shutdown.completed"]);
        expect(stderr).toEqual([]);
      } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(softwareWorkspaceRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
