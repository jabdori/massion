import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorMaintenanceService } from "./connector-maintenance.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Connector 만료 유지관리", () => {
  it("시작할 때 즉시 만료를 정리하고 설정한 주기로 반복한다", async () => {
    vi.useFakeTimers();
    const expire = vi.fn(async () => 0);
    const service = new ConnectorMaintenanceService({ expire }, { intervalMs: 1_000 });

    await service.start();
    expect(expire).toHaveBeenCalledTimes(1);
    expect(service.ready()).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(expire).toHaveBeenCalledTimes(4);

    await service.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(expire).toHaveBeenCalledTimes(4);
    expect(service.ready()).toBe(false);
  });

  it("앞선 정리가 끝나기 전에는 겹쳐 실행하지 않고 종료가 이를 기다린다", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const expire = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(
        async () =>
          await new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      );
    const service = new ConnectorMaintenanceService({ expire }, { intervalMs: 1_000 });
    await service.start();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(expire).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(closed).toBe(true);
  });

  it("주기 실행 실패를 보고하고 다음 성공 뒤 준비 상태를 복구한다", async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    const expire = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(2);
    const service = new ConnectorMaintenanceService(
      { expire },
      {
        intervalMs: 1_000,
        onError: (error) => {
          failures.push(error);
        },
      },
    );
    await service.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.ready()).toBe(false);
    expect(failures).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.ready()).toBe(true);
    await service.close();
  });

  it("초기 정리에 실패하면 시작을 거부한다", async () => {
    const service = new ConnectorMaintenanceService(
      { expire: async () => await Promise.reject(new Error("initial failure")) },
      { intervalMs: 1_000 },
    );

    await expect(service.start()).rejects.toThrow("initial failure");
    expect(service.ready()).toBe(false);
    await service.close();
  });
});
