import { describe, expect, it, vi } from "vitest";

import { WebConsoleStore } from "./store.js";

describe("WebConsoleStore", () => {
  it("초기 query를 병렬로 읽고 event sequence gap에서 snapshot을 다시 읽는다", async () => {
    let resolveMe: ((value: unknown) => void) | undefined;
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    const query = vi.fn(
      (operation: string) =>
        new Promise((resolve) => {
          if (operation === "identity.me") resolveMe = resolve;
          else
            resolve({
              schemaVersion: "massion.application.v1",
              operation,
              data: operation === "application.audit" ? { events: [], cursor: 2 } : [],
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
  });
});
