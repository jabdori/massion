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

  it("수신 전 초기화와 수신 후 운영 서비스를 의존성 순서대로 시작하고 역순으로 닫는다", async () => {
    const calls: string[] = [];
    const daemon = new MassionDaemon({
      application: {
        server: { beginDrain: () => calls.push("drain") },
        start: async () => {
          calls.push("application-start");
          return { host: "127.0.0.1", port: 3141, url: "http://127.0.0.1:3141" };
        },
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
      beforeListenServices: [
        {
          start: async () => {
            calls.push("before-first-start");
          },
          close: async () => {
            calls.push("before-first-close");
          },
        },
        {
          start: async () => {
            calls.push("before-second-start");
          },
          close: async () => {
            calls.push("before-second-close");
          },
        },
      ],
      afterListenServices: [
        {
          start: async () => {
            calls.push("after-first-start");
          },
          close: async () => {
            calls.push("after-first-close");
          },
        },
        {
          start: async () => {
            calls.push("after-second-start");
          },
          close: async () => {
            calls.push("after-second-close");
          },
        },
      ],
      shutdownTimeoutMs: 1_000,
    });

    await daemon.start();
    await daemon.close();

    expect(calls).toEqual([
      "before-first-start",
      "before-second-start",
      "application-start",
      "after-first-start",
      "after-second-start",
      "drain",
      "after-second-close",
      "after-first-close",
      "application-close",
      "before-second-close",
      "before-first-close",
      "database-close",
    ]);
  });

  it("HTTP 수신 차단 직후 Runtime을 비운 다음 연결·Application·Database를 닫는다", async () => {
    const calls: string[] = [];
    const daemon = new MassionDaemon({
      application: {
        server: { beginDrain: () => calls.push("http-drain") },
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
      drainServices: [
        {
          close: async () => {
            calls.push("runtime-drain");
          },
        },
      ],
      afterListenServices: [
        {
          start: async () => undefined,
          close: async () => {
            calls.push("connector-close");
          },
        },
      ],
      shutdownTimeoutMs: 1_000,
    });

    await daemon.start();
    await daemon.close();

    expect(calls).toEqual(["http-drain", "runtime-drain", "connector-close", "application-close", "database-close"]);
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

  it("실행 중 Database 단절은 process 생존과 분리해 readiness만 실패시킨다", async () => {
    const version = vi.fn().mockResolvedValueOnce("surrealdb-3.2.0").mockRejectedValue(new Error("disconnected"));
    const readinessFailure = vi.fn();
    const daemon = new MassionDaemon({
      application: {
        server: { beginDrain: () => undefined },
        start: async () => ({ host: "127.0.0.1", port: 3141, url: "http://127.0.0.1:3141" }),
        close: async () => undefined,
      },
      database: { version, close: async () => undefined },
      shutdownTimeoutMs: 1_000,
      onReadinessFailure: readinessFailure,
    });
    await daemon.start();
    await expect(daemon.readiness()).resolves.toEqual({ database: false, migrations: true });
    expect(daemon.state).toBe("ready");
    expect(readinessFailure).toHaveBeenCalledWith("database");
    await daemon.close();
  });
});
