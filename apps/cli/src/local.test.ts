import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LocalDaemonManager, ensureLocalCredentialKey, ensureLocalTokenKey, resolveLocalPaths } from "./local.js";

describe("local daemon lifecycle", () => {
  it("XDG user directory를 사용하고 token key를 owner-only로 한 번만 만든다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-paths-"));
    try {
      const paths = resolveLocalPaths({ HOME: root });
      expect(paths.dataDirectory).toBe(join(root, ".local", "share", "massion-v1"));
      expect(paths.connectorDirectory).toBe(join(root, ".local", "share", "massion-v1", "connectors"));
      const first = await ensureLocalTokenKey(paths);
      const second = await ensureLocalTokenKey(paths);
      const credential = await ensureLocalCredentialKey(paths);
      expect(second).toBe(first);
      expect(credential).not.toBe(first);
      expect(Buffer.from(first, "base64url")).toHaveLength(32);
      expect(Buffer.from(credential, "base64url")).toHaveLength(32);
      expect((await stat(paths.tokenKey)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.credentialKey)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("개인 서버는 native sidecar를 먼저 시작하고 인증된 loopback database를 전달한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-connectors-"));
    const serverScript = join(root, "server.js");
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    let childWorkingDirectory: string | undefined;
    const order: string[] = [];
    try {
      await writeFile(serverScript, "", { mode: 0o600 });
      const paths = resolveLocalPaths({ HOME: root });
      const surrealRuntime = {
        start: vi.fn(async () => {
          order.push("surreal-start");
          return { status: "started" as const, pid: 41, endpoint: "http://127.0.0.1:7330" };
        }),
        stop: vi.fn(async () => ({ status: "stopped" as const, pid: 41 })),
      };
      const manager = new LocalDaemonManager({
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          MASSION_SERVER_BIN: serverScript,
          MASSION_EDGE_CONNECTOR_ENABLED: "true",
          MASSION_CONNECTOR_HEARTBEAT_MS: "45000",
        },
        fetcher: async () => Response.json({ status: "ready" }),
        processExists: () => true,
        processCommand: () => Promise.resolve(`${process.execPath} ${serverScript}`),
        spawnProcess: (_command, _arguments, options) => {
          order.push("application-start");
          childEnvironment = options.env;
          childWorkingDirectory = options.cwd;
          return { pid: 42, unref() {} };
        },
        surrealRuntime,
      });

      await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 42 });
      expect(order).toEqual(["surreal-start", "application-start"]);
      expect(surrealRuntime.start).toHaveBeenCalledOnce();
      expect(childEnvironment?.MASSION_CONNECTOR_ROOT).toBe(paths.connectorDirectory);
      expect(childEnvironment?.MASSION_DATABASE_URL).toBe("ws://127.0.0.1:7330");
      expect(childEnvironment?.MASSION_DATABASE_USER).toBe("massion");
      expect(childEnvironment?.MASSION_DATABASE_PASSWORD_FILE).toBe(
        join(root, ".config", "massion-v1", "database-password"),
      );
      expect(childWorkingDirectory).toBe(paths.dataDirectory);
      expect(childEnvironment?.MASSION_EDGE_CONNECTOR_ENABLED).toBe("true");
      expect(childEnvironment?.MASSION_CONNECTOR_HEARTBEAT_MS).toBe("45000");
      expect((await stat(paths.connectorDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, ".config", "massion-v1", "database-password"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("실제 server command identity를 확인한 process만 정상 종료한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-stop-"));
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const surrealRuntime = {
      start: vi.fn(async () => ({ status: "already-running" as const, pid: 41, endpoint: "http://127.0.0.1:7330" })),
      stop: vi.fn(async () => ({ status: "stopped" as const, pid: 41 })),
    };
    try {
      const paths = resolveLocalPaths({ HOME: root });
      const manager = new LocalDaemonManager({
        environment: { HOME: root, MASSION_SERVER_BIN: "/opt/massion/server/dist/main.js" },
        processExists: () => alive,
        processCommand: () => Promise.resolve(`${process.execPath} /opt/massion/server/dist/main.js`),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          alive = false;
        },
        wait: () => Promise.resolve(),
        surrealRuntime,
      });
      await manager.initializeStateForTest({ pid: 42, endpoint: "http://127.0.0.1:7331" });
      await expect(manager.stop()).resolves.toMatchObject({ status: "stopped", pid: 42 });
      expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
      expect(surrealRuntime.stop).toHaveBeenCalledOnce();
      await expect(readFile(paths.pidFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("PID가 다른 command를 가리키면 종료하지 않고 fail closed한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-foreign-"));
    let signalled = false;
    try {
      const manager = new LocalDaemonManager({
        environment: { HOME: root, MASSION_SERVER_BIN: "/opt/massion/server/dist/main.js" },
        processExists: () => true,
        processCommand: () => Promise.resolve(`/usr/bin/env ${process.execPath} /opt/massion/server/dist/main.js`),
        signal: () => {
          signalled = true;
        },
      });
      await manager.initializeStateForTest({ pid: 42, endpoint: "http://127.0.0.1:7331" });
      await expect(manager.stop()).rejects.toThrow("Massion server가 아닙니다");
      expect(signalled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("살아있지만 준비되지 못한 우리 서버는 정리하고 새로 띄워 self-heal한다", async () => {
    // SurrealDB 사이드카가 죽어 서버가 not-ready로 고착된 상황을 재현한다.
    const root = await mkdtemp(join(tmpdir(), "massion-local-selfheal-"));
    const serverScript = join(root, "server.js");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let oldAlive = true;
    let spawned = false;
    try {
      await writeFile(serverScript, "", { mode: 0o600 });
      const surrealRuntime = {
        start: vi.fn(async () => ({ status: "started" as const, pid: 41, endpoint: "http://127.0.0.1:7330" })),
        stop: vi.fn(async () => ({ status: "stopped" as const, pid: 41 })),
      };
      const manager = new LocalDaemonManager({
        environment: { HOME: root, PATH: process.env.PATH, MASSION_SERVER_BIN: serverScript },
        // 새 서버(pid 99)가 뜨기 전에는 not-ready, 뜬 뒤에는 ready를 돌려준다.
        fetcher: async () => Response.json({ status: spawned ? "ready" : "starting" }),
        processExists: (pid) => (pid === 99 ? true : oldAlive),
        processCommand: () => Promise.resolve(`${process.execPath} ${serverScript}`),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          if (pid === 42) oldAlive = false;
        },
        wait: () => Promise.resolve(),
        spawnProcess: () => {
          spawned = true;
          return { pid: 99, unref() {} };
        },
        surrealRuntime,
      });
      await manager.initializeStateForTest({ pid: 42, endpoint: "http://127.0.0.1:7331" });

      await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 99 });
      // 고착된 옛 서버는 SIGTERM으로 정리되고, 사이드카를 포함해 새로 기동된다.
      expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
      expect(surrealRuntime.start).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("start 시 PID가 우리 서버가 아니면 종료·재기동하지 않고 fail closed한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-start-foreign-"));
    const serverScript = join(root, "server.js");
    let signalled = false;
    let spawned = false;
    try {
      await writeFile(serverScript, "", { mode: 0o600 });
      const manager = new LocalDaemonManager({
        environment: { HOME: root, PATH: process.env.PATH, MASSION_SERVER_BIN: serverScript },
        processExists: () => true,
        processCommand: () => Promise.resolve("node /tmp/unrelated.js"),
        signal: () => {
          signalled = true;
        },
        wait: () => Promise.resolve(),
        spawnProcess: () => {
          spawned = true;
          return { pid: 99, unref() {} };
        },
      });
      await manager.initializeStateForTest({ pid: 42, endpoint: "http://127.0.0.1:7331" });

      await expect(manager.start()).rejects.toThrow("Massion server가 아니므로");
      expect(signalled).toBe(false);
      expect(spawned).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("공개된 token key를 재사용하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-secret-"));
    try {
      const paths = resolveLocalPaths({ HOME: root });
      await ensureLocalTokenKey(paths);
      await chmod(paths.tokenKey, 0o644);
      await expect(ensureLocalTokenKey(paths)).rejects.toThrow("owner-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
