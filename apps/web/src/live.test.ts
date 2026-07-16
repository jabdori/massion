import { expect, it, vi } from "vitest";

import { LiveEventConnection } from "./live.js";

it("SSE cursor 만료 409를 받으면 snapshot·audit 복구 뒤 새 cursor로 즉시 재연결한다", async () => {
  let cursor = 1;
  const store = {
    getSnapshot: vi.fn(() => ({ cursor })),
    setConnection: vi.fn(),
    recoverExpiredCursor: vi.fn(async () => {
      cursor = 52;
    }),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          schemaVersion: "massion.error.v1",
          category: "conflict",
          operatorCode: "APP_EVENT_CURSOR_EXPIRED",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValue(
      new Response(": heartbeat\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  const connection = new LiveEventConnection(store as never, { fetcher, random: () => 0 });

  connection.start();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  connection.stop();

  expect(store.recoverExpiredCursor).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/events/stream?after=1");
  expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/events/stream?after=52");
});
