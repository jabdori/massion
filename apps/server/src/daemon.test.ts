import { describe, expect, it, vi } from "vitest";

import { MassionDaemon } from "./daemon.js";

describe("MassionDaemon", () => {
  it("starting→ready→draining→stopped와 종료 소유권 순서를 강제한다", async () => {
    const calls: string[] = [];
    const daemon = new MassionDaemon({
      application: {
        server: { beginDrain: () => calls.push("drain") },
        start: async () => ({ host: "127.0.0.1", port: 3141, url: "http://127.0.0.1:3141" }),
        close: async () => {
          calls.push("application-close");
        },
      },
      database: {
        version: async () => "surrealdb-3.2.0",
        close: async () => {
          calls.push("database-close");
        },
      },
      shutdownTimeoutMs: 1_000,
    });

    await expect(daemon.start()).resolves.toMatchObject({ port: 3141 });
    expect(daemon.state).toBe("ready");
    await expect(daemon.readiness()).resolves.toEqual({ database: true, migrations: true });
    await daemon.close();
    expect(daemon.state).toBe("stopped");
    expect(calls).toEqual(["drain", "application-close", "database-close"]);
    await daemon.close();
    expect(calls).toHaveLength(3);
  });

  it("종료 기한을 넘기면 failed가 되고 Database close를 계속 시도한다", async () => {
    vi.useFakeTimers();
    const databaseClose = vi.fn(async () => undefined);
    const daemon = new MassionDaemon({
      application: {
        server: { beginDrain: () => undefined },
        start: async () => ({ host: "127.0.0.1", port: 3141, url: "http://127.0.0.1:3141" }),
        close: async () => await new Promise<void>(() => undefined),
      },
      database: { version: async () => "surrealdb-3.2.0", close: databaseClose },
      shutdownTimeoutMs: 100,
    });
    await daemon.start();
    const closing = daemon.close();
    const rejected = expect(closing).rejects.toThrow("shutdown deadline");
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(daemon.state).toBe("failed");
    expect(databaseClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
