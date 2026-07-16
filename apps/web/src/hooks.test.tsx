import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useQueryData } from "./hooks.js";
import { WebConsoleStore } from "./store.js";

describe("useQueryData", () => {
  it("같은 query의 payload가 바뀌면 이전 payload 데이터를 반환하지 않고 새 조회를 시작한다", async () => {
    let releaseWorkB: ((value: unknown) => void) | undefined;
    const query = vi.fn((_operation: string, payload: unknown) => {
      const workId = (payload as { workId: string }).workId;
      if (workId === "work-a") {
        return Promise.resolve({
          schemaVersion: "massion.application.v1",
          operation: "work.get",
          data: { workId },
        });
      }
      return new Promise((resolve) => {
        releaseWorkB = resolve;
      });
    });
    const store = new WebConsoleStore({ query } as never);
    await store.refresh("work.get", { workId: "work-a" });

    const { result, rerender } = renderHook(
      ({ payload }: { payload: { workId: string } }) => useQueryData<{ workId: string }>(store, "work.get", payload),
      { initialProps: { payload: { workId: "work-a" } } },
    );
    expect(result.current).toEqual({ workId: "work-a" });

    rerender({ payload: { workId: "work-b" } });

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(query).toHaveBeenCalledWith("work.get", { workId: "work-b" }));

    releaseWorkB?.({
      schemaVersion: "massion.application.v1",
      operation: "work.get",
      data: { workId: "work-b" },
    });
    await waitFor(() => expect(result.current).toEqual({ workId: "work-b" }));
  });

  it("새 payload의 cache가 있으면 다시 조회하지 않고 즉시 반환한다", async () => {
    const query = vi.fn((_operation: string, payload: unknown) => {
      const workId = (payload as { workId: string }).workId;
      return Promise.resolve({
        schemaVersion: "massion.application.v1",
        operation: "work.get",
        data: { workId },
      });
    });
    const store = new WebConsoleStore({ query } as never);
    await store.refresh("work.get", { workId: "work-a" });
    await store.refresh("work.get", { workId: "work-b" });

    const { result, rerender } = renderHook(
      ({ payload }: { payload: { workId: string } }) => useQueryData<{ workId: string }>(store, "work.get", payload),
      { initialProps: { payload: { workId: "work-a" } } },
    );
    expect(result.current).toEqual({ workId: "work-a" });

    rerender({ payload: { workId: "work-b" } });

    expect(result.current).toEqual({ workId: "work-b" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("의미상 같은 payload 객체로 다시 render해도 실패한 query를 자동 재요청하지 않는다", async () => {
    const query = vi.fn().mockRejectedValue(new Error("조회 실패"));
    const store = new WebConsoleStore({ query } as never);

    const { rerender } = renderHook(
      ({ renderCount }: { renderCount: number }) => {
        void renderCount;
        return useQueryData(store, "work.list", { filter: { status: "active" } });
      },
      { initialProps: { renderCount: 1 } },
    );
    await waitFor(() => expect(store.getQueryError("work.list", { filter: { status: "active" } })).toBe("조회 실패"));

    rerender({ renderCount: 2 });

    expect(query).toHaveBeenCalledTimes(1);
  });
});
