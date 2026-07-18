import { describe, expect, it, vi } from "vitest";

import * as localSurrealRuntime from "./local-surreal-runtime.js";

interface RuntimeProcess {
  readonly pid?: number | undefined;
  unref(): void;
}

interface RuntimeState {
  readonly pid: number;
  readonly endpoint: string;
  readonly executable: string;
  readonly startedAt: string;
}

interface RuntimeManagerDependencies {
  readonly runtime: {
    readonly binaryPath: string;
    readonly dataDirectory: string;
  };
  readonly credential: {
    readonly user: string;
    readonly password: string;
  };
  readonly port: number;
  readonly attest: () => Promise<{
    readonly executable: string;
    readonly digest: string;
    readonly version: "3.2.1";
  }>;
  readonly prepareDataDirectory: () => Promise<void>;
  readonly readState: () => Promise<RuntimeState | undefined>;
  readonly writeState: (state: RuntimeState) => Promise<void>;
  readonly removeState: () => Promise<void>;
  readonly spawn: (
    command: string,
    arguments_: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => RuntimeProcess;
  readonly processExists: (pid: number) => boolean;
  readonly processCommand: (pid: number) => Promise<string>;
  readonly ready: (endpoint: string) => Promise<boolean>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: (milliseconds: number) => Promise<void>;
}

interface RuntimeManager {
  start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }>;
  stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }>;
}

type RuntimeManagerConstructor = new (dependencies: RuntimeManagerDependencies) => RuntimeManager;

function createManager(dependencies: RuntimeManagerDependencies): RuntimeManager {
  const Constructor = (
    localSurrealRuntime as unknown as {
      readonly LocalSurrealRuntimeManager?: RuntimeManagerConstructor;
    }
  ).LocalSurrealRuntimeManager;
  if (!Constructor) throw new Error("LocalSurrealRuntimeManager가 export되지 않았습니다");
  return new Constructor(dependencies);
}

function dependencies(overrides: Partial<RuntimeManagerDependencies> = {}): RuntimeManagerDependencies {
  const runtime = {
    binaryPath: "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal",
    dataDirectory: "/Users/massion/.local/share/massion/surrealdb/3/database",
  };
  return {
    runtime,
    credential: { user: "massion", password: "local-secret-must-never-be-an-argument" },
    port: 17_431,
    attest: async () => ({ executable: runtime.binaryPath, digest: "a".repeat(64), version: "3.2.1" }),
    prepareDataDirectory: async () => undefined,
    readState: async () => undefined,
    writeState: async () => undefined,
    removeState: async () => undefined,
    spawn: () => ({ pid: 741, unref() {} }),
    processExists: () => true,
    processCommand: async () => runtime.binaryPath,
    ready: async () => true,
    signal: () => undefined,
    wait: async () => undefined,
    ...overrides,
  };
}

describe("local SurrealDB sidecar lifecycle", () => {
  it("증명된 native binary를 loopback RocksDB로 시작하고 credential은 환경 변수로만 전달한다", async () => {
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => ({ pid: 741, unref() {} }));
    const credential = { user: "massion", password: "local-secret-must-never-be-an-argument" };
    const manager = createManager(dependencies({ credential, spawn }));

    await expect(manager.start()).resolves.toEqual({
      status: "started",
      pid: 741,
      endpoint: "http://127.0.0.1:17431",
    });

    expect(spawn).toHaveBeenCalledWith(
      "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal",
      [
        "start",
        "--bind",
        "127.0.0.1:17431",
        "--no-banner",
        "rocksdb:///Users/massion/.local/share/massion/surrealdb/3/database?sync=every",
      ],
      expect.objectContaining({
        cwd: "/Users/massion/.local/share/massion/surrealdb/3/database",
        env: expect.objectContaining({ SURREAL_USER: "massion", SURREAL_PASS: credential.password }),
      }),
    );
    expect(spawn.mock.calls[0]?.[1]).not.toContain(credential.password);
  });

  it("동일한 증명된 sidecar PID가 준비되었으면 새 process를 만들지 않고 재사용한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("이미 준비된 process에는 spawn하면 안 됩니다");
    });
    const writeState = vi.fn<RuntimeManagerDependencies["writeState"]>(async () => undefined);
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>();
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 812,
          endpoint: "http://127.0.0.1:17431",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => `${executable} start --bind 127.0.0.1:17431`,
        spawn,
        writeState,
        removeState,
        signal,
      }),
    );

    await expect(manager.start()).resolves.toEqual({
      status: "already-running",
      pid: 812,
      endpoint: "http://127.0.0.1:17431",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("소유한 sidecar가 시작 중이면 준비될 때까지 기다린 뒤 재사용한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    let readyChecks = 0;
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("시작 중인 process에는 spawn하면 안 됩니다");
    });
    const wait = vi.fn<RuntimeManagerDependencies["wait"]>(async () => undefined);
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 813,
          endpoint: "http://127.0.0.1:17431",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => `${executable} start --bind 127.0.0.1:17431`,
        ready: async () => {
          readyChecks += 1;
          return readyChecks === 2;
        },
        spawn,
        wait,
      }),
    );

    await expect(manager.start()).resolves.toEqual({
      status: "already-running",
      pid: 813,
      endpoint: "http://127.0.0.1:17431",
    });
    expect(wait).toHaveBeenCalledExactlyOnceWith(250);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("소유한 sidecar가 준비 시간 안에 응답하지 않으면 종료하고 state를 정리한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("준비되지 않은 기존 process에는 spawn하면 안 됩니다");
    });
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>();
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const wait = vi.fn<RuntimeManagerDependencies["wait"]>(async () => undefined);
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 814,
          endpoint: "http://127.0.0.1:17431",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => `${executable} start --bind 127.0.0.1:17431`,
        ready: async () => false,
        spawn,
        signal,
        removeState,
        wait,
      }),
    );

    await expect(manager.start()).rejects.toThrow(/준비|ready/u);
    expect(wait).toHaveBeenCalledTimes(120);
    expect(signal).toHaveBeenCalledWith(814, "SIGTERM");
    expect(removeState).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("관련 없는 PID 기록은 종료하거나 덮어쓰지 않고 fail-closed로 중단한다", async () => {
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("관련 없는 process 뒤에 spawn하면 안 됩니다");
    });
    const writeState = vi.fn<RuntimeManagerDependencies["writeState"]>(async () => undefined);
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>();
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 915,
          endpoint: "http://127.0.0.1:17431",
          executable: "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal",
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => "/usr/bin/unrelated-service --serve",
        spawn,
        writeState,
        removeState,
        signal,
      }),
    );

    await expect(manager.start()).rejects.toThrow(/다른 process|다른 프로세스|덮어쓰지/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("실행 파일 경로가 command argument에만 있으면 관련 없는 PID로 fail-closed한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("관련 없는 process 뒤에 spawn하면 안 됩니다");
    });
    const writeState = vi.fn<RuntimeManagerDependencies["writeState"]>(async () => undefined);
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>();
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 916,
          endpoint: "http://127.0.0.1:17431",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => `/usr/bin/env --ignore-environment ${executable} start --bind 127.0.0.1:17431`,
        spawn,
        writeState,
        removeState,
        signal,
      }),
    );

    await expect(manager.start()).rejects.toThrow(/다른 process|다른 프로세스|덮어쓰지/u);
    expect(spawn).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("기록된 endpoint가 예상한 loopback endpoint와 다르면 재사용하지 않고 fail-closed한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      throw new Error("endpoint가 다른 process 뒤에 spawn하면 안 됩니다");
    });
    const writeState = vi.fn<RuntimeManagerDependencies["writeState"]>(async () => undefined);
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>();
    const ready = vi.fn<RuntimeManagerDependencies["ready"]>(async () => true);
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 917,
          endpoint: "http://127.0.0.1:17432",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processCommand: async () => `${executable} start --bind 127.0.0.1:17431`,
        spawn,
        writeState,
        removeState,
        signal,
        ready,
      }),
    );

    await expect(manager.start()).rejects.toThrow(/endpoint|loopback|다른 process|다른 프로세스|덮어쓰지/u);
    expect(ready).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("data directory 준비 뒤 state 기록이 실패하면 소유한 새 PID를 종료하고 state를 정리한다", async () => {
    const order: string[] = [];
    const prepareDataDirectory = vi.fn<RuntimeManagerDependencies["prepareDataDirectory"]>(async () => {
      order.push("prepare-data-directory");
    });
    const spawn = vi.fn<RuntimeManagerDependencies["spawn"]>(() => {
      order.push("spawn");
      return { pid: 918, unref() {} };
    });
    const writeState = vi.fn<RuntimeManagerDependencies["writeState"]>(async () => {
      order.push("write-state");
      throw new Error("state 기록에 실패했습니다");
    });
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>((_pid, receivedSignal) => {
      order.push(`signal:${receivedSignal}`);
    });
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => {
      order.push("remove-state");
    });
    const manager = createManager(
      dependencies({
        prepareDataDirectory,
        spawn,
        writeState,
        signal,
        removeState,
        processCommand: async () =>
          "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal start --bind 127.0.0.1:17431",
      }),
    );

    await expect(manager.start()).rejects.toThrow("state 기록에 실패했습니다");
    expect(prepareDataDirectory).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith(918, "SIGTERM");
    expect(removeState).toHaveBeenCalledOnce();
    expect(order).toEqual(["prepare-data-directory", "spawn", "write-state", "signal:SIGTERM", "remove-state"]);
  });

  it("소유한 sidecar만 종료하고 종료 뒤 state를 정리한다", async () => {
    const executable = "/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal";
    let alive = true;
    const signal = vi.fn<RuntimeManagerDependencies["signal"]>((_pid, receivedSignal) => {
      expect(receivedSignal).toBe("SIGTERM");
      alive = false;
    });
    const removeState = vi.fn<RuntimeManagerDependencies["removeState"]>(async () => undefined);
    const manager = createManager(
      dependencies({
        readState: async () => ({
          pid: 919,
          endpoint: "http://127.0.0.1:17431",
          executable,
          startedAt: "2026-07-19T00:00:00.000Z",
        }),
        processExists: () => alive,
        processCommand: async () => `${executable} start --bind 127.0.0.1:17431`,
        signal,
        removeState,
      }),
    );

    await expect(manager.stop()).resolves.toEqual({ status: "stopped", pid: 919 });
    expect(signal).toHaveBeenCalledWith(919, "SIGTERM");
    expect(removeState).toHaveBeenCalledOnce();
  });
});
