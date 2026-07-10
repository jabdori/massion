import { describe, expect, it, vi } from "vitest";

import { RuntimeShutdown } from "./shutdown.js";

describe("Runtime 정상 종료", () => {
  it("intake 차단, 활성 취소, flush, VoltAgent, DB 순서를 지킨다", async () => {
    const order: string[] = [];
    const shutdown = new RuntimeShutdown(
      {
        stopAccepting: () => {
          order.push("intake");
        },
      },
      {
        activeExecutionIds: () => ["execution-1"],
        cancel: async (executionId) => {
          order.push(`cancel:${executionId}`);
        },
      },
      {
        flush: async () => {
          order.push("flush");
        },
      },
      {
        shutdown: async () => {
          order.push("voltagent");
        },
      },
      {
        close: async () => {
          order.push("database");
        },
      },
    );

    await shutdown.shutdown();

    expect(order).toEqual(["intake", "cancel:execution-1", "flush", "voltagent", "database"]);
  });

  it("flush 실패 시 Runtime과 DB를 닫지 않아 미영속 상태를 숨기지 않는다", async () => {
    const runtime = { shutdown: vi.fn() };
    const database = { close: vi.fn() };
    const shutdown = new RuntimeShutdown(
      { stopAccepting: vi.fn() },
      { activeExecutionIds: () => [], cancel: vi.fn() },
      { flush: vi.fn().mockRejectedValue(new Error("flush failed")) },
      runtime,
      database,
    );

    await expect(shutdown.shutdown()).rejects.toThrow("flush failed");
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(database.close).not.toHaveBeenCalled();
  });
});
