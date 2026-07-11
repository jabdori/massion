import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalDaemonManager, ensureLocalTokenKey, resolveLocalPaths } from "./local.js";

describe("local daemon lifecycle", () => {
  it("XDG user directory를 사용하고 token key를 owner-only로 한 번만 만든다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-paths-"));
    try {
      const paths = resolveLocalPaths({ HOME: root });
      expect(paths.dataDirectory).toBe(join(root, ".local", "share", "massion"));
      const first = await ensureLocalTokenKey(paths);
      const second = await ensureLocalTokenKey(paths);
      expect(second).toBe(first);
      expect(Buffer.from(first, "base64url")).toHaveLength(32);
      expect((await stat(paths.tokenKey)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("실제 server command identity를 확인한 process만 정상 종료한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-stop-"));
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    try {
      const paths = resolveLocalPaths({ HOME: root });
      const manager = new LocalDaemonManager({
        environment: { HOME: root, MASSION_SERVER_BIN: "/opt/massion/server/dist/main.js" },
        processExists: () => alive,
        processCommand: () => Promise.resolve("node /opt/massion/server/dist/main.js"),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          alive = false;
        },
        wait: () => Promise.resolve(),
      });
      await manager.initializeStateForTest({ pid: 42, endpoint: "http://127.0.0.1:7331" });
      await expect(manager.stop()).resolves.toMatchObject({ status: "stopped", pid: 42 });
      expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
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
        processCommand: () => Promise.resolve("node /tmp/unrelated.js"),
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
