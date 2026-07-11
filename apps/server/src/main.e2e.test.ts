import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

describe("massion-server process", () => {
  it("준비 완료 뒤 SIGTERM에서 drain하고 종료 코드 0으로 끝난다", async () => {
    const child = spawn(process.execPath, ["dist/main.js"], {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        MASSION_TOKEN_KEY: Buffer.alloc(32, 11).toString("base64url"),
        MASSION_DATABASE_URL: "mem://",
        MASSION_HTTP_PORT: "32142",
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
      child.kill("SIGTERM");
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result).toEqual({ code: 0, signal: null });
      expect(events).toEqual(["server.ready", "server.shutdown.started", "server.shutdown.completed"]);
      expect(stderr).toEqual([]);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});
