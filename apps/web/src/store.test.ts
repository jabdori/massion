import { describe, expect, it, vi } from "vitest";

import { createQueryResourceIdentity, WebConsoleStore } from "./store.js";

function envelope(operation: string, data: unknown) {
  return { schemaVersion: "massion.application.v1", operation, data };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("WebConsoleStore", () => {
  it("초기 query를 병렬로 읽고 event sequence gap에서 snapshot을 다시 읽는다", async () => {
    let resolveMe: ((value: unknown) => void) | undefined;
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    let auditCalls = 0;
    const query = vi.fn(
      (operation: string) =>
        new Promise((resolve) => {
          if (operation === "identity.me") resolveMe = resolve;
          else
            resolve({
              schemaVersion: "massion.application.v1",
              operation,
              data:
                operation === "application.audit"
                  ? { events: [], cursor: ++auditCalls === 1 ? 2 : 4, snapshotRequired: false }
                  : [],
            });
        }),
    );
    const snapshot = vi.fn(() => {
      if (snapshot.mock.calls.length > 1)
        return Promise.resolve({
          schemaVersion: "massion.application.v1",
          operation: "organization.graph.snapshot",
          data: { cursor: 4 },
        });
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    const store = new WebConsoleStore({ query, snapshot } as never);
    const loading = store.load();
    expect(query).toHaveBeenCalledWith("identity.me", {});
    expect(snapshot).toHaveBeenCalledTimes(1);
    resolveMe?.({ schemaVersion: "massion.application.v1", operation: "identity.me", data: { role: "owner" } });
    resolveSnapshot?.({
      schemaVersion: "massion.application.v1",
      operation: "organization.graph.snapshot",
      data: { cursor: 2 },
    });
    await loading;
    expect(store.getSnapshot().status).toBe("ready");

    await store.acceptEvent({ sequence: 4, type: "work.updated" });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("같은 command ID의 동시 변경을 한 번만 전송한다", async () => {
    let release: (() => void) | undefined;
    const command = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const store = new WebConsoleStore({ command } as never);
    const input = { commandId: "command-single-flight" };
    const first = store.mutate(input as never);
    const second = store.mutate(input as never);
    expect(command).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    release?.();
    await first;
  });

  it("같은 query와 의미상 같은 payload의 동시 조회를 한 번만 전송한다", async () => {
    let release: ((value: unknown) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const store = new WebConsoleStore({ query } as never);

    const first = store.refresh("subscription.providers", { filter: { verified: true }, limit: 20 });
    const second = store.refresh("subscription.providers", { limit: 20, filter: { verified: true } });

    expect(query).toHaveBeenCalledTimes(1);
    release?.({
      schemaVersion: "massion.application.v1",
      operation: "subscription.providers",
      data: [],
    });
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(store.getSnapshot().queries['subscription.providers:{"filter":{"verified":true},"limit":20}']).toEqual([]);
  });

  it("같은 query의 서로 다른 payload 결과를 응답 순서와 무관하게 분리한다", async () => {
    const releases = new Map<string, (value: unknown) => void>();
    const query = vi.fn(
      (_operation: string, payload: unknown) =>
        new Promise((resolve) => {
          releases.set((payload as { workId: string }).workId, resolve);
        }),
    );
    const store = new WebConsoleStore({ query } as never);

    const workA = store.refresh("work.get", { workId: "work-a" });
    const workB = store.refresh("work.get", { workId: "work-b" });
    releases.get("work-b")?.({
      schemaVersion: "massion.application.v1",
      operation: "work.get",
      data: { workId: "work-b" },
    });
    await workB;

    expect(store.getSnapshot().queries).toEqual({
      'work.get:{"workId":"work-b"}': { workId: "work-b" },
    });

    releases.get("work-a")?.({
      schemaVersion: "massion.application.v1",
      operation: "work.get",
      data: { workId: "work-a" },
    });
    await workA;

    expect(store.getSnapshot().queries).toEqual({
      'work.get:{"workId":"work-b"}': { workId: "work-b" },
      'work.get:{"workId":"work-a"}': { workId: "work-a" },
    });
  });

  it("같은 query의 서로 다른 payload 오류를 각각 보존한다", async () => {
    const rejections = new Map<string, (error: Error) => void>();
    const query = vi.fn(
      (_operation: string, payload: unknown) =>
        new Promise((_resolve, reject) => {
          rejections.set((payload as { workId: string }).workId, reject);
        }),
    );
    const store = new WebConsoleStore({ query } as never);

    const workA = store.refresh("work.get", { workId: "work-a" });
    const workB = store.refresh("work.get", { workId: "work-b" });
    const rejectedA = expect(workA).rejects.toThrow("work-a 조회 실패");
    const rejectedB = expect(workB).rejects.toThrow("work-b 조회 실패");
    rejections.get("work-b")?.(new Error("work-b 조회 실패"));
    rejections.get("work-a")?.(new Error("work-a 조회 실패"));
    await Promise.all([rejectedA, rejectedB]);

    expect(store.getSnapshot().queryErrors).toEqual({
      'work.get:{"workId":"work-b"}': "work-b 조회 실패",
      'work.get:{"workId":"work-a"}': "work-a 조회 실패",
    });
  });

  it("StrictMode에서 겹친 초기 load도 한 번의 query 묶음으로 합친다", async () => {
    const query = vi.fn((operation: string) =>
      Promise.resolve({
        schemaVersion: "massion.application.v1",
        operation,
        data: operation === "application.audit" ? { events: [], cursor: 0 } : [],
      }),
    );
    const snapshot = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "massion.application.v1",
        operation: "organization.graph.snapshot",
        data: {},
      }),
    );
    const store = new WebConsoleStore({ query, snapshot } as never);

    await Promise.all([store.load(), store.load()]);

    expect(query).toHaveBeenCalledTimes(4);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().queries).toMatchObject({
      "identity.me:{}": [],
      "organization.graph.snapshot:{}": {},
      "work.list:{}": [],
      "governance.approval.list:{}": [],
      'application.audit:{"limit":100}': { events: [], cursor: 0 },
    });
  });

  it("load 중 완료된 다른 payload의 refresh 결과와 오류를 보존한다", async () => {
    const loadMe = deferred<unknown>();
    const query = vi.fn((operation: string, payload: unknown) => {
      if (operation === "identity.me") return loadMe.promise;
      if (operation === "work.get") {
        const workId = (payload as { workId: string }).workId;
        return workId === "work-error"
          ? Promise.reject(new Error("work-error 조회 실패"))
          : Promise.resolve(envelope(operation, { workId }));
      }
      return Promise.resolve(envelope(operation, operation === "application.audit" ? { events: [], cursor: 0 } : []));
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", {}));
    const store = new WebConsoleStore({ query, snapshot } as never);

    const loading = store.load();
    const refreshed = store.refresh("work.get", { workId: "work-success" });
    const failed = store.refresh("work.get", { workId: "work-error" });
    await expect(refreshed).resolves.toEqual({ workId: "work-success" });
    await expect(failed).rejects.toThrow("work-error 조회 실패");

    loadMe.resolve(envelope("identity.me", { role: "owner" }));
    await loading;

    expect(store.getQueryData("work.get", { workId: "work-success" })).toEqual({ workId: "work-success" });
    expect(store.getQueryError("work.get", { workId: "work-error" })).toBe("work-error 조회 실패");
  });

  it("늦은 load query가 나중에 시작한 같은 identity refresh를 덮지 않는다", async () => {
    const loadWorks = deferred<unknown>();
    let workListCalls = 0;
    const query = vi.fn((operation: string) => {
      if (operation === "work.list" && ++workListCalls === 1) return loadWorks.promise;
      return Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 0 }
            : operation === "work.list"
              ? [{ workId: "new-work" }]
              : [],
        ),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", {}));
    const store = new WebConsoleStore({ query, snapshot } as never);

    const loading = store.load();
    await expect(store.refresh("work.list")).resolves.toEqual([{ workId: "new-work" }]);
    loadWorks.resolve(envelope("work.list", [{ workId: "old-work" }]));
    await loading;

    expect(store.getQueryData("work.list")).toEqual([{ workId: "new-work" }]);
  });

  it("늦은 load 성공이 나중에 시작한 같은 identity refresh 오류를 지우지 않는다", async () => {
    const loadWorks = deferred<unknown>();
    let workListCalls = 0;
    const query = vi.fn((operation: string) => {
      if (operation === "work.list" && ++workListCalls === 1) return loadWorks.promise;
      if (operation === "work.list") return Promise.reject(new Error("최신 refresh 실패"));
      return Promise.resolve(envelope(operation, operation === "application.audit" ? { events: [], cursor: 0 } : []));
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", {}));
    const store = new WebConsoleStore({ query, snapshot } as never);

    const loading = store.load();
    await expect(store.refresh("work.list")).rejects.toThrow("최신 refresh 실패");
    loadWorks.resolve(envelope("work.list", [{ workId: "old-load-work" }]));
    await loading;

    expect(store.getQueryData("work.list")).toBeUndefined();
    expect(store.getQueryError("work.list")).toBe("최신 refresh 실패");
  });

  it("늦은 refresh 결과가 나중에 시작한 같은 identity load 결과를 덮지 않는다", async () => {
    const oldRefresh = deferred<unknown>();
    let workListCalls = 0;
    const query = vi.fn((operation: string) => {
      if (operation === "work.list" && ++workListCalls === 1) return oldRefresh.promise;
      return Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 0 }
            : operation === "work.list"
              ? [{ workId: "new-load-work" }]
              : [],
        ),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", {}));
    const store = new WebConsoleStore({ query, snapshot } as never);

    const refreshing = store.refresh("work.list");
    await store.load();
    oldRefresh.resolve(envelope("work.list", [{ workId: "old-refresh-work" }]));
    await refreshing;

    expect(store.getQueryData("work.list")).toEqual([{ workId: "new-load-work" }]);
  });

  it("늦은 refresh 오류가 나중에 시작한 같은 identity load 성공 뒤 오류를 기록하지 않는다", async () => {
    const oldRefresh = deferred<unknown>();
    let workListCalls = 0;
    const query = vi.fn((operation: string) => {
      if (operation === "work.list" && ++workListCalls === 1) return oldRefresh.promise;
      return Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 0 }
            : operation === "work.list"
              ? [{ workId: "new-load-work" }]
              : [],
        ),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", {}));
    const store = new WebConsoleStore({ query, snapshot } as never);

    const refreshing = store.refresh("work.list");
    const rejected = expect(refreshing).rejects.toThrow("오래된 refresh 실패");
    await store.load();
    oldRefresh.reject(new Error("오래된 refresh 실패"));
    await rejected;

    expect(store.getQueryData("work.list")).toEqual([{ workId: "new-load-work" }]);
    expect(store.getQueryError("work.list")).toBeUndefined();
  });

  it("늦은 load snapshot이 나중에 시작한 resync snapshot을 덮지 않는다", async () => {
    const loadSnapshot = deferred<unknown>();
    const resyncSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "application.audit" ? { events: [], cursor: 3, snapshotRequired: false } : [],
        ),
      ),
    );
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => loadSnapshot.promise)
      .mockImplementationOnce(() => resyncSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const loading = store.load();
    const resyncing = store.acceptEvent({ sequence: 3, type: "work.updated" });
    resyncSnapshot.resolve(envelope("organization.graph.snapshot", { source: "new-resync" }));
    await resyncing;
    loadSnapshot.resolve(envelope("organization.graph.snapshot", { source: "old-load" }));
    await loading;

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-resync" });
  });

  it("늦은 resync snapshot이 나중에 시작한 load snapshot을 덮지 않는다", async () => {
    const oldResync = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "application.audit" ? { events: [], cursor: 3, snapshotRequired: false } : [],
        ),
      ),
    );
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => oldResync.promise)
      .mockResolvedValueOnce(envelope("organization.graph.snapshot", { source: "new-load" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const resyncing = store.acceptEvent({ sequence: 3, type: "work.updated" });
    await store.load();
    oldResync.resolve(envelope("organization.graph.snapshot", { source: "old-resync" }));
    await resyncing;

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-load" });
  });

  it("늦은 resync가 나중에 시작한 snapshot refresh를 덮지 않는다", async () => {
    const resyncSnapshot = deferred<unknown>();
    const snapshot = vi.fn(() => resyncSnapshot.promise);
    const query = vi.fn((operation: string) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 3, snapshotRequired: false }
            : { source: "new-refresh" },
        ),
      ),
    );
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const resyncing = store.acceptEvent({ sequence: 3, type: "work.updated" });
    await store.refresh("organization.graph.snapshot");
    resyncSnapshot.resolve(envelope("organization.graph.snapshot", { source: "old-resync" }));
    await resyncing;

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
  });

  it("늦은 snapshot refresh가 나중에 시작한 resync를 덮지 않는다", async () => {
    const refreshSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      operation === "application.audit"
        ? Promise.resolve(envelope(operation, { events: [], cursor: 3, snapshotRequired: false }))
        : refreshSnapshot.promise,
    );
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { source: "new-resync" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const refreshing = store.refresh("organization.graph.snapshot");
    await store.acceptEvent({ sequence: 3, type: "work.updated" });
    refreshSnapshot.resolve(envelope("organization.graph.snapshot", { source: "old-refresh" }));
    await refreshing;

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-resync" });
  });

  it("resync snapshot은 빈 payload identity에 저장하고 다른 identity를 보존한다", async () => {
    const query = vi.fn((operation: string, payload: unknown) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 3, snapshotRequired: false }
            : { workId: (payload as { workId: string }).workId },
        ),
      ),
    );
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { source: "resync" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.refresh("work.get", { workId: "work-a" });
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    await store.acceptEvent({ sequence: 3, type: "work.updated" });

    expect(store.getQueryData("organization.graph.snapshot", {})).toEqual({ source: "resync" });
    expect(store.getQueryData("work.get", { workId: "work-a" })).toEqual({ workId: "work-a" });
  });

  it("무효화된 진행 중 요청을 최신 요청으로 다시 사용하지 않는다", async () => {
    const oldRefresh = deferred<unknown>();
    const resyncSnapshot = deferred<unknown>();
    let snapshotQueryCalls = 0;
    const query = vi.fn((operation: string, payload: unknown) => {
      if (operation === "organization.graph.snapshot") {
        snapshotQueryCalls += 1;
        if (snapshotQueryCalls === 1) return oldRefresh.promise;
        return Promise.resolve(envelope(operation, { source: "new-refresh" }));
      }
      if (operation === "application.audit") {
        return Promise.resolve(envelope(operation, { events: [], cursor: 3, snapshotRequired: false }));
      }
      return Promise.resolve(envelope(operation, payload));
    });
    const snapshot = vi.fn(() => resyncSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const stale = store.refresh("organization.graph.snapshot");
    const recovering = store.acceptEvent({ sequence: 3, type: "work.updated" });
    const latest = store.refresh("organization.graph.snapshot");

    expect(latest).not.toBe(stale);
    resyncSnapshot.resolve(envelope("organization.graph.snapshot", { source: "resync" }));
    await expect(latest).resolves.toEqual({ source: "new-refresh" });
    oldRefresh.resolve(envelope("organization.graph.snapshot", { source: "old-refresh" }));
    await Promise.all([stale, recovering]);
    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
  });

  it("초기 load 일부가 실패해도 성공한 resource와 identity별 오류를 반영한다", async () => {
    const query = vi.fn((operation: string) => {
      if (operation === "identity.me") return Promise.reject(new Error("identity 조회 실패"));
      return Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 7, snapshotRequired: false }
            : operation === "work.list"
              ? [{ workId: "work-success" }]
              : [],
        ),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "snapshot" }));
    const store = new WebConsoleStore({ query, snapshot } as never);

    await expect(store.load()).resolves.toBeUndefined();

    expect(store.getSnapshot().status).toBe("ready");
    expect(store.getQueryData("work.list")).toEqual([{ workId: "work-success" }]);
    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ revision: "snapshot" });
    expect(store.getQueryError("identity.me")).toBe("identity 조회 실패");
    expect(store.getSnapshot().cursor).toBe(7);
  });

  it("query resource cache와 과거 오류를 설정된 LRU 상한 안에 유지한다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => {
      const key = (payload as { key: string }).key;
      return key === "old-error"
        ? Promise.reject(new Error("과거 검색 실패"))
        : Promise.resolve(envelope(operation, { key }));
    });
    const store = new WebConsoleStore({ query } as never, { maxQueryResources: 2 });

    await expect(store.refresh("registry.search", { key: "old-error" })).rejects.toThrow("과거 검색 실패");
    await store.refresh("registry.search", { key: "kept" });
    expect(store.getQueryData("registry.search", { key: "kept" })).toEqual({ key: "kept" });
    await store.refresh("registry.search", { key: "new" });

    expect(store.getQueryError("registry.search", { key: "old-error" })).toBeUndefined();
    expect(store.getQueryData("registry.search", { key: "kept" })).toEqual({ key: "kept" });
    expect(store.getQueryData("registry.search", { key: "new" })).toEqual({ key: "new" });
    expect(Object.keys(store.getSnapshot().queries)).toHaveLength(2);
    expect(Object.keys(store.getSnapshot().queryErrors)).toHaveLength(0);
  });

  it("stale resync 종료 뒤 기존 실시간 연결 상태를 복구한다", async () => {
    const resyncSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "organization.graph.snapshot"
            ? { source: "new-refresh" }
            : { events: [], cursor: 3, snapshotRequired: false },
        ),
      ),
    );
    const snapshot = vi.fn(() => resyncSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const recovering = store.acceptEvent({ sequence: 3, type: "work.updated" });
    await store.refresh("organization.graph.snapshot");
    resyncSnapshot.resolve(envelope("organization.graph.snapshot", { source: "old-resync" }));
    await recovering;

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
    expect(store.getSnapshot().connection).toBe("live");
  });

  it("resync보다 최신인 snapshot 요청이 실패하면 과거 snapshot으로 cursor를 전진시키지 않는다", async () => {
    const resyncSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      operation === "organization.graph.snapshot"
        ? Promise.reject(new Error("최신 snapshot 실패"))
        : Promise.resolve(envelope(operation, { events: [], cursor: 3, snapshotRequired: false })),
    );
    const snapshot = vi.fn(() => resyncSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const recovering = store.acceptEvent({ sequence: 3, type: "work.updated" });
    const rejectedRecovery = expect(recovering).rejects.toThrow("sequence gap");
    await expect(store.refresh("organization.graph.snapshot")).rejects.toThrow("최신 snapshot 실패");
    resyncSnapshot.resolve(envelope("organization.graph.snapshot", { source: "stale-resync" }));
    await rejectedRecovery;

    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded" });
    expect(store.getQueryData("organization.graph.snapshot")).toBeUndefined();
  });

  it("sequence gap을 snapshot과 audit으로 복구해 다음 연속 사건을 수락한다", async () => {
    const recoveredEvents = [
      { sequence: 2, type: "work.updated" },
      { sequence: 3, type: "collaboration.message-posted" },
    ];
    const query = vi.fn((operation: string, payload: unknown) => {
      if (operation === "application.audit") {
        expect(payload).toEqual({ limit: 1000 });
        return Promise.resolve(envelope(operation, { events: recoveredEvents, cursor: 3, snapshotRequired: false }));
      }
      return Promise.resolve(envelope(operation, {}));
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "recovered" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    await store.acceptEvent({ sequence: 3, type: "collaboration.message-posted" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 3, connection: "live", events: recoveredEvents });

    await store.acceptEvent({ sequence: 4, type: "work.completed" });
    expect(store.getSnapshot().cursor).toBe(4);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("query identity와 전송 payload를 실제 JSON wire 의미로 정규화한다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => Promise.resolve(envelope(operation, payload)));
    const store = new WebConsoleStore({ query } as never);
    const firstDate = new Date("2026-07-16T00:00:00.000Z");
    const secondDate = new Date("2026-07-17T00:00:00.000Z");

    expect(createQueryResourceIdentity("calendar.query", { at: firstDate })).not.toBe(
      createQueryResourceIdentity("calendar.query", { at: secondDate }),
    );
    await store.refresh("calendar.query", {
      at: firstDate,
      omitted: undefined,
      values: [undefined, ...Array.from({ length: 1 }), Number.NaN],
      custom: { toJSON: () => ({ z: 1, a: 2 }) },
    });

    expect(query).toHaveBeenCalledWith("calendar.query", {
      at: "2026-07-16T00:00:00.000Z",
      values: [null, null, null],
      custom: { a: 2, z: 1 },
    });
    expect(() => createQueryResourceIdentity("invalid.query", { value: 1n })).toThrow(/JSON/u);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => createQueryResourceIdentity("invalid.query", cycle)).toThrow(/순환|JSON/u);
  });
});
