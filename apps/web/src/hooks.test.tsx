import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useQueryData, useQueryError, useQueryErrors } from "./hooks.js";
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

  it("저장된 raw snapshot이 같으면 새 객체 decoder 결과를 다시 만들지 않는다", async () => {
    const query = vi.fn().mockResolvedValue({
      schemaVersion: "massion.application.v1",
      operation: "work.get",
      data: { workId: "work-a" },
    });
    const store = new WebConsoleStore({ query } as never);
    await store.refresh("work.get", { workId: "work-a" });
    const decoder = vi.fn((value: unknown) => ({ workId: (value as { workId: string }).workId }));

    const { result, rerender } = renderHook(
      ({ renderCount }: { renderCount: number }) => {
        void renderCount;
        return useQueryData(store, "work.get", { workId: "work-a" }, decoder);
      },
      { initialProps: { renderCount: 1 } },
    );
    const firstResult = result.current;
    act(() => store.setConnection("live"));
    rerender({ renderCount: 2 });

    expect(result.current).toBe(firstResult);
    expect(decoder).toHaveBeenCalledTimes(1);
  });

  it("실제 store의 빈 payload query 오류를 선택해서 읽는다", async () => {
    const query = vi.fn().mockRejectedValue(new Error("할당량 조회 실패"));
    const store = new WebConsoleStore({ query } as never);
    const { result } = renderHook(() => useQueryError(store, "subscription.quota"));

    await act(async () => {
      await store.refresh("subscription.quota", {}).catch(() => undefined);
    });

    expect(result.current).toBe("할당량 조회 실패");
  });

  it("mount된 query descriptor만 유지하고 payload 변경과 unmount에서 해제한다", async () => {
    const query = vi.fn((_operation: string, payload: unknown) =>
      Promise.resolve({ schemaVersion: "massion.application.v1", operation: "work.get", data: payload }),
    );
    const store = new WebConsoleStore({ query } as never);
    const { rerender, unmount } = renderHook(
      ({ workId }: { workId: string }) => useQueryData(store, "work.get", { workId }),
      { initialProps: { workId: "work-a" } },
    );

    await waitFor(() =>
      expect(store.activeQueryResources()).toEqual([expect.objectContaining({ payload: { workId: "work-a" } })]),
    );
    rerender({ workId: "work-b" });
    await waitFor(() =>
      expect(store.activeQueryResources()).toEqual([expect.objectContaining({ payload: { workId: "work-b" } })]),
    );
    unmount();
    expect(store.activeQueryResources()).toEqual([]);
  });

  it("현재 화면이 구독한 query 오류만 전역 오류 snapshot에 노출한다", async () => {
    const query = vi.fn().mockRejectedValue(new Error("현재 조회 실패"));
    const store = new WebConsoleStore({ query } as never);
    await store.refresh("registry.search", { query: "과거 검색" }).catch(() => undefined);
    const errors = renderHook(() => useQueryErrors(store));

    expect(errors.result.current).toEqual({});
    const active = renderHook(() => useQueryData(store, "work.list"));
    await waitFor(() => expect(Object.values(errors.result.current)).toEqual(["현재 조회 실패"]));

    active.unmount();
    await waitFor(() => expect(errors.result.current).toEqual({}));
    errors.unmount();
  });

  it("비활성 query는 유지하거나 읽지 않다가 활성화되면 조회한다", async () => {
    const query = vi.fn((_operation: string, payload: unknown) =>
      Promise.resolve({ schemaVersion: "massion.application.v1", operation: "run.get", data: payload }),
    );
    const store = new WebConsoleStore({ query } as never);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useQueryData<{ runId: string }>(store, "run.get", { runId: "run-pending" }, undefined, { enabled }),
      { initialProps: { enabled: false } },
    );

    expect(result.current).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(store.activeQueryResources()).toEqual([]);

    rerender({ enabled: true });

    await waitFor(() => expect(query).toHaveBeenCalledWith("run.get", { runId: "run-pending" }));
    await waitFor(() => expect(result.current).toEqual({ runId: "run-pending" }));
  });
});
