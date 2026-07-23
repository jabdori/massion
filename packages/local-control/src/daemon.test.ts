import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureLocalDataEpoch, LocalDaemonManager, resolveLocalPaths, resolveLocalSurrealRuntime } from "./daemon.js";

describe("공용 local daemon 제어", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it("v1 전용 root를 사용하고 이전 legacy root는 재사용하거나 변경하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-root-"));
    roots.push(root);
    const legacy = join(root, ".local", "share", "massion", "surrealdb", "3", "database", "legacy.db");
    await mkdir(join(legacy, ".."), { recursive: true, mode: 0o700 });
    await writeFile(legacy, "legacy data", { mode: 0o600 });

    const paths = resolveLocalPaths({ HOME: root });

    expect(paths.dataDirectory).toBe(join(root, ".local", "share", "massion-v1"));
    expect(paths.configDirectory).toBe(join(root, ".config", "massion-v1"));
    expect(paths.stateDirectory).toBe(join(root, ".local", "state", "massion-v1"));
    expect(resolveLocalSurrealRuntime({ home: root }).dataDirectory).toBe(
      join(root, ".local", "share", "massion-v1", "surrealdb", "3", "database"),
    );
    await ensureLocalDataEpoch(paths);

    expect(await readFile(legacy, "utf8")).toBe("legacy data");
    await expect(stat(paths.epochFile)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("v1 data epoch이 바뀌면 Massion 소유 세 root를 모두 비운 뒤 새 marker를 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-epoch-"));
    roots.push(root);
    const paths = resolveLocalPaths({ HOME: root });
    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "stale"), "stale", { mode: 0o600 });
        await writeFile(join(directory, ".massion-data-epoch"), "obsolete\n", { mode: 0o600 });
      }),
    );

    await ensureLocalDataEpoch(paths);

    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await expect(stat(join(directory, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(directory, ".massion-data-epoch"), "utf8")).resolves.toBe("massion-v1-data-epoch-1\n");
      }),
    );
  });

  it("주입된 Node·server script·runtime version으로 실행하고 PID schema v2에 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const spawnProcess = vi.fn(() => ({ pid: 42, unref() {} }));
    const bundledExtensionsRoot = join(root, "extensions");
    const manager = new LocalDaemonManager({
      environment: { HOME: root, MASSION_REGISTRY_BUNDLED_EXTENSIONS: bundledExtensionsRoot },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess,
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 42 });
    expect(spawnProcess).toHaveBeenCalledWith(nodeExecutable, [serverScript], expect.any(Object));
    expect(spawnProcess.mock.calls[0]?.[2].env.MASSION_REGISTRY_BUNDLED_EXTENSIONS).toBe(bundledExtensionsRoot);
    expect(spawnProcess.mock.calls[0]?.[2].env.MASSION_REGISTRY_ARTIFACT_ROOT).toBe(
      join(resolveLocalPaths({ HOME: root }).dataDirectory, "registry"),
    );
    const state = JSON.parse(await readFile(resolveLocalPaths({ HOME: root }).pidFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      schema: "massion.local-process.v2",
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
    });
    expect((await stat(resolveLocalPaths({ HOME: root }).pidFile)).mode & 0o777).toBe(0o600);
  });

  it("세 runtime identity와 endpoint가 일치하는 준비된 v2 process를 재사용한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-reuse-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    const spawnProcess = vi.fn(() => ({ pid: 42, unref() {} }));
    const signal = vi.fn();
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      signal,
      spawnProcess,
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });
    await manager.initializeStateForTest({ pid: 41, endpoint: "http://127.0.0.1:7331" });

    await expect(manager.start()).resolves.toEqual({
      status: "already-running",
      pid: 41,
      endpoint: "http://127.0.0.1:7331",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it.each([
    ["v1", { schema: "massion.local-process.v1" }],
    ["Node 불일치", { schema: "massion.local-process.v2", nodeExecutable: "/old/node", runtimeVersion: "2.4.0" }],
    ["server 불일치", { schema: "massion.local-process.v2", serverScript: "/old/server.js", runtimeVersion: "2.4.0" }],
    ["runtime 불일치", { schema: "massion.local-process.v2", runtimeVersion: "1.0.0" }],
    ["endpoint 불일치", { schema: "massion.local-process.v2", endpoint: "http://127.0.0.1:7441" }],
  ])("소유가 확인된 %s PID 상태를 종료한 뒤 현재 runtime으로 교체한다", async (_label, mismatch) => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-replace-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const paths = resolveLocalPaths({ HOME: root });
    await ensureLocalDataEpoch(paths);
    await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
    const record =
      mismatch.schema === "massion.local-process.v1"
        ? {
            schema: "massion.local-process.v1",
            pid: 41,
            endpoint: "http://127.0.0.1:7331",
            serverScript,
            startedAt: new Date(0).toISOString(),
          }
        : {
            schema: "massion.local-process.v2",
            pid: 41,
            endpoint: "http://127.0.0.1:7331",
            nodeExecutable,
            serverScript,
            runtimeVersion: "2.4.0",
            startedAt: new Date(0).toISOString(),
            ...mismatch,
          };
    await writeFile(paths.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    let oldAlive = true;
    let spawned = false;
    const signal = vi.fn((pid: number) => {
      if (pid === 41) oldAlive = false;
    });
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: spawned ? "ready" : "starting" }),
      processExists: (pid) => (pid === 41 ? oldAlive : true),
      processCommand: async () => {
        const recordedNode = "nodeExecutable" in record ? record.nodeExecutable : nodeExecutable;
        return `${recordedNode} ${record.serverScript}`;
      },
      signal,
      wait: async () => undefined,
      spawnProcess: () => {
        spawned = true;
        return { pid: 42, unref() {} };
      },
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 40, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 40 }),
      },
    });

    await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 42 });
    expect(signal).toHaveBeenCalledWith(41, "SIGTERM");
  });
});
