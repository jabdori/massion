import { describe, expect, it, vi } from "vitest";

import { WebApiError } from "./api.js";
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

  it("늦은 resync snapshot은 나중에 시작한 load snapshot을 덮지 않는다", async () => {
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
    await expect(resyncing).resolves.toBeUndefined();

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-load" });
  });

  it("늦은 resync는 나중 snapshot refresh를 덮지 않지만 gap 복구 실패를 반환한다", async () => {
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
    await expect(resyncing).rejects.toThrow("sequence gap");

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded" });
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
    await stale;
    await expect(recovering).rejects.toThrow("sequence gap");
    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded" });
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

  it("오래된 load snapshot 실패는 더 최신 snapshot 성공을 무효화하지 않는다", async () => {
    const loadSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      Promise.resolve(
        envelope(
          operation,
          operation === "application.audit"
            ? { events: [], cursor: 7, snapshotRequired: false }
            : operation === "organization.graph.snapshot"
              ? { source: "newer-refresh" }
              : [],
        ),
      ),
    );
    const snapshot = vi.fn(() => loadSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);

    const loading = store.load();
    await store.refresh("organization.graph.snapshot");
    loadSnapshot.reject(new Error("오래된 load snapshot 실패"));

    await expect(loading).resolves.toBeUndefined();
    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "newer-refresh" });
    expect(store.getSnapshot()).toMatchObject({ status: "ready", cursor: 7 });
  });

  it("load snapshot이 stale이면 진행 중인 최신 snapshot 결과까지 기다린다", async () => {
    const loadSnapshot = deferred<unknown>();
    const refreshSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) => {
      if (operation === "organization.graph.snapshot") return refreshSnapshot.promise;
      return Promise.resolve(
        envelope(
          operation,
          operation === "application.audit" ? { events: [], cursor: 7, snapshotRequired: false } : [],
        ),
      );
    });
    const snapshot = vi.fn(() => loadSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    const loadOutcome = vi.fn();

    const loading = store.load();
    const refreshing = store.refresh("organization.graph.snapshot");
    void loading.then(
      () => loadOutcome("resolved"),
      () => loadOutcome("rejected"),
    );
    loadSnapshot.resolve(envelope("organization.graph.snapshot", { source: "stale-load" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadOutcome).not.toHaveBeenCalled();

    refreshSnapshot.resolve(envelope("organization.graph.snapshot", { source: "newer-refresh" }));
    await expect(Promise.all([loading, refreshing])).resolves.toEqual([undefined, { source: "newer-refresh" }]);
    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "newer-refresh" });
    expect(store.getSnapshot()).toMatchObject({ status: "ready", cursor: 7 });
  });

  it("초기 snapshot 또는 audit cursor가 없으면 ready가 되거나 첫 고순번 사건을 수락하지 않는다", async () => {
    const query = vi.fn((operation: string) => Promise.reject(new Error(`${operation} 초기 실패`)));
    const snapshot = vi.fn().mockRejectedValue(new Error("snapshot 초기 실패"));
    const store = new WebConsoleStore({ query, snapshot } as never);

    await expect(store.load()).rejects.toThrow(/초기 운영 상태/u);
    expect(store.getSnapshot()).toMatchObject({ status: "error", connection: "degraded", cursor: 0 });
    expect(Object.keys(store.getSnapshot().queryErrors)).toHaveLength(5);

    await expect(store.acceptEvent({ sequence: 500, type: "work.updated" })).rejects.toThrow();
    expect(store.getSnapshot().cursor).toBe(0);
  });

  it("query resource cache와 과거 오류를 요청·retain 기준 soft limit 안에 유지한다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => {
      const key = (payload as { key: string }).key;
      return key === "old-error"
        ? Promise.reject(new Error("과거 검색 실패"))
        : Promise.resolve(envelope(operation, { key }));
    });
    const store = new WebConsoleStore({ query } as never, { queryResourceSoftLimit: 2 });

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

  it("stale resync는 최신 snapshot을 보존하되 미복구 gap을 성공으로 처리하지 않는다", async () => {
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
    await expect(recovering).rejects.toThrow("sequence gap");

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "new-refresh" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded" });
  });

  it("stale resync와 audit이 실패해도 최신 snapshot은 보존하고 gap 실패를 반환한다", async () => {
    const resyncSnapshot = deferred<unknown>();
    const query = vi.fn((operation: string) =>
      operation === "organization.graph.snapshot"
        ? Promise.resolve(envelope(operation, { source: "newest" }))
        : Promise.reject(new Error("audit 복구 실패")),
    );
    const snapshot = vi.fn(() => resyncSnapshot.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const recovering = store.acceptEvent({ sequence: 3, type: "work.updated" });
    await store.refresh("organization.graph.snapshot");
    resyncSnapshot.reject(new Error("stale resync 실패"));
    await expect(recovering).rejects.toThrow("sequence gap");

    expect(store.getQueryData("organization.graph.snapshot")).toEqual({ source: "newest" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded" });
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
        expect(payload).toEqual({ after: 1, limit: 1000 });
        return Promise.resolve(envelope(operation, { events: recoveredEvents, cursor: 3, snapshotRequired: false }));
      }
      return Promise.resolve(envelope(operation, {}));
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "recovered" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    await store.acceptEvent({ sequence: 3, type: "collaboration.message-posted" });
    expect(store.getSnapshot()).toMatchObject({
      cursor: 3,
      connection: "live",
      events: [{ sequence: 1, type: "work.created" }, ...recoveredEvents],
    });

    await store.acceptEvent({ sequence: 4, type: "work.completed" });
    expect(store.getSnapshot().cursor).toBe(4);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("실패한 gap을 다음 연결에서 복구하면 과거 오류를 제거한다", async () => {
    let auditFails = true;
    const query = vi.fn((operation: string) => {
      if (operation === "application.audit" && auditFails) return Promise.reject(new Error("일시적 audit 실패"));
      return Promise.resolve(envelope(operation, { events: [], cursor: 3, snapshotRequired: false }));
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "recovered" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    await expect(store.acceptEvent({ sequence: 3, type: "work.updated" })).rejects.toThrow("일시적 audit 실패");
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, connection: "degraded", error: "일시적 audit 실패" });

    auditFails = false;
    store.setConnection("live");
    await store.acceptEvent({ sequence: 3, type: "work.updated" });

    expect(store.getSnapshot()).toMatchObject({ cursor: 3, connection: "live" });
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it("snapshot을 기다리는 동안 더 높은 gap이 들어오면 높아진 cursor까지 audit을 추가 복구한다", async () => {
    const snapshotResult = deferred<unknown>();
    const firstAuditStarted = deferred<undefined>();
    const query = vi.fn((_operation: string, payload: unknown) => {
      const after = (payload as { after: number }).after;
      if (after === 1) {
        firstAuditStarted.resolve(undefined);
        return Promise.resolve(
          envelope("application.audit", {
            events: [
              { sequence: 2, type: "work.updated" },
              { sequence: 3, type: "work.completed" },
            ],
            cursor: 3,
            snapshotRequired: false,
          }),
        );
      }
      expect(payload).toEqual({ after: 3, limit: 1000 });
      return Promise.resolve(
        envelope("application.audit", {
          events: [
            { sequence: 4, type: "work.updated" },
            { sequence: 5, type: "work.completed" },
          ],
          cursor: 5,
          snapshotRequired: false,
        }),
      );
    });
    const snapshot = vi.fn(() => snapshotResult.promise);
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    const lowerGap = store.acceptEvent({ sequence: 3, type: "work.completed" });
    await firstAuditStarted.promise;
    const higherGap = store.acceptEvent({ sequence: 5, type: "work.completed" });
    snapshotResult.resolve(envelope("organization.graph.snapshot", { revision: "concurrent-gap" }));

    await expect(Promise.all([lowerGap, higherGap])).resolves.toEqual([undefined, undefined]);
    expect(query).toHaveBeenNthCalledWith(1, "application.audit", { after: 1, limit: 1000 });
    expect(query).toHaveBeenNthCalledWith(2, "application.audit", { after: 3, limit: 1000 });
    expect(store.getSnapshot()).toMatchObject({ cursor: 5, connection: "live" });
  });

  it("성숙 조직의 gap 복구는 cursor 0이 아니라 현재 cursor 뒤부터 audit을 읽는다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => {
      if (operation !== "application.audit") return Promise.resolve(envelope(operation, []));
      if ((payload as { limit?: number }).limit === 100) {
        return Promise.resolve(envelope(operation, { events: [], cursor: 1498, snapshotRequired: false }));
      }
      expect(payload).toEqual({ after: 1498, limit: 1000 });
      return Promise.resolve(
        envelope(operation, {
          events: [
            { sequence: 1499, type: "work.updated" },
            { sequence: 1500, type: "work.completed" },
          ],
          cursor: 1500,
          snapshotRequired: false,
        }),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "mature" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    await store.load();

    await store.acceptEvent({ sequence: 1500, type: "work.completed" });

    expect(store.getSnapshot()).toMatchObject({ cursor: 1500, connection: "connecting" });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("현재 cursor가 감사 보존 범위 밖이면 snapshot 뒤 보존 중인 첫 사건부터 복구한다", async () => {
    const query = vi.fn((_operation: string, payload: unknown) => {
      const after = (payload as { after: number }).after;
      if (after === 1) {
        return Promise.reject(
          new WebApiError(409, {
            schemaVersion: "massion.error.v1",
            operatorCode: "APP_EVENT_CURSOR_EXPIRED",
          }),
        );
      }
      expect(payload).toEqual({ after: 0, limit: 1000 });
      return Promise.resolve(
        envelope("application.audit", {
          events: [
            { sequence: 50, type: "work.updated" },
            { sequence: 51, type: "work.updated" },
            { sequence: 52, type: "work.completed" },
          ],
          cursor: 52,
          snapshotRequired: false,
        }),
      );
    });
    const snapshot = vi.fn().mockResolvedValue(envelope("organization.graph.snapshot", { revision: "retained" }));
    const store = new WebConsoleStore({ query, snapshot } as never);
    store.setConnection("live");
    await store.acceptEvent({ sequence: 1, type: "work.created" });

    await store.recoverExpiredCursor();

    expect(query).toHaveBeenNthCalledWith(1, "application.audit", { after: 1, limit: 1000 });
    expect(query).toHaveBeenNthCalledWith(2, "application.audit", { after: 0, limit: 1000 });
    expect(store.getSnapshot()).toMatchObject({ cursor: 52, connection: "live" });
  });

  it("실행 사건은 유지 중인 실행 조회와 개요 조회만 다시 읽는다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => Promise.resolve(envelope(operation, payload)));
    const snapshot = vi.fn(() => Promise.resolve(envelope("organization.graph.snapshot", { revision: 2 })));
    const store = new WebConsoleStore({ query, snapshot } as never);
    const releaseRunA = store.retainQueryResource("run.get", { runId: "run-active-a" });
    const releaseRunB = store.retainQueryResource("run.get", { runId: "run-active-b" });
    const releaseWorks = store.retainQueryResource("work.list");
    const releaseSnapshot = store.retainQueryResource("organization.graph.snapshot");
    const releaseUnrelated = store.retainQueryResource("work.get", { workId: "work-unrelated" });

    await store.acceptEvent({
      sequence: 1,
      type: "run.stage-advanced",
      resource: { type: "ApplicationRun", id: "run-event" },
    });

    expect(query).toHaveBeenCalledWith("run.get", { runId: "run-active-a" });
    expect(query).toHaveBeenCalledWith("run.get", { runId: "run-active-b" });
    expect(query).toHaveBeenCalledWith("work.list", {});
    expect(query).not.toHaveBeenCalledWith("work.get", { workId: "work-unrelated" });
    expect(snapshot).toHaveBeenCalledTimes(1);

    releaseUnrelated();
    releaseSnapshot();
    releaseWorks();
    releaseRunB();
    releaseRunA();
  });

  it("업무와 협업 사건은 같은 업무와 협업방의 유지 중인 조회만 다시 읽는다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => Promise.resolve(envelope(operation, payload)));
    const snapshot = vi.fn(() => Promise.resolve(envelope("organization.graph.snapshot", { revision: 2 })));
    const store = new WebConsoleStore({ query, snapshot } as never);
    const releases = [
      store.retainQueryResource("work.list"),
      store.retainQueryResource("organization.graph.snapshot"),
      store.retainQueryResource("work.get", { workId: "work-active" }),
      store.retainQueryResource("work.tasks", { workId: "work-active" }),
      store.retainQueryResource("work.assignments", { workId: "work-active" }),
      store.retainQueryResource("work.rooms", { workId: "work-active" }),
      store.retainQueryResource("work.records", { workId: "work-active" }),
      store.retainQueryResource("work.messages", { workId: "work-active", roomId: "room-active" }),
      store.retainQueryResource("work.messages", { workId: "work-active", roomId: "room-other" }),
      store.retainQueryResource("work.get", { workId: "work-other" }),
    ];

    await store.acceptEvent({
      sequence: 1,
      type: "work.updated",
      resource: { type: "Work", id: "work-active" },
    });

    for (const operation of ["work.get", "work.tasks", "work.assignments", "work.rooms", "work.records"]) {
      expect(query).toHaveBeenCalledWith(operation, { workId: "work-active" });
    }
    expect(query).toHaveBeenCalledWith("work.list", {});
    expect(query).not.toHaveBeenCalledWith("work.get", { workId: "work-other" });
    expect(query).not.toHaveBeenCalledWith("work.messages", { workId: "work-active", roomId: "room-active" });
    expect(snapshot).toHaveBeenCalledTimes(1);

    query.mockClear();
    snapshot.mockClear();
    await store.acceptEvent({
      sequence: 2,
      type: "collaboration.message-posted",
      resource: { type: "Work", id: "work-active" },
      payload: { roomId: "room-active" },
    });

    expect(query).toHaveBeenCalledWith("work.messages", { workId: "work-active", roomId: "room-active" });
    expect(query).not.toHaveBeenCalledWith("work.messages", { workId: "work-active", roomId: "room-other" });
    expect(query).toHaveBeenCalledWith("work.get", { workId: "work-active" });
    expect(query).toHaveBeenCalledWith("work.rooms", { workId: "work-active" });
    expect(query).not.toHaveBeenCalledWith("work.tasks", { workId: "work-active" });
    expect(query).not.toHaveBeenCalledWith("work.assignments", { workId: "work-active" });
    expect(query).not.toHaveBeenCalledWith("work.records", { workId: "work-active" });
    expect(query).not.toHaveBeenCalledWith("work.list", {});
    expect(snapshot).toHaveBeenCalledTimes(1);

    for (const release of releases.reverse()) release();
  });

  it("유지 중인 조회가 있어도 무관한 runtime 사건은 다시 읽지 않는다", async () => {
    const query = vi.fn((operation: string, payload: unknown) => Promise.resolve(envelope(operation, payload)));
    const snapshot = vi.fn(() => Promise.resolve(envelope("organization.graph.snapshot", { revision: 2 })));
    const store = new WebConsoleStore({ query, snapshot } as never);
    const release = store.retainQueryResource("work.get", { workId: "work-active" });

    await store.acceptEvent({
      sequence: 1,
      type: "runtime.token-emitted",
      resource: { type: "Execution", id: "execution-active" },
    });

    expect(query).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    release();
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
