import { describe, expect, it } from "vitest";

import { decodeApplicationSseStream, encodeApplicationSseEvent, parseEventCursor } from "./sse.js";

describe("Application SSE", () => {
  it("id·event·한 줄 data를 WHATWG SSE frame으로 인코딩한다", () => {
    expect(encodeApplicationSseEvent({ sequence: 7, type: "work.created", payload: { text: "a\nb" } })).toBe(
      'id: 7\nevent: work.created\ndata: {"sequence":7,"type":"work.created","payload":{"text":"a\\nb"}}\n\n',
    );
  });

  it("Last-Event-ID를 우선하고 음수·복수·비정수 cursor를 거부한다", () => {
    expect(parseEventCursor("12", "3")).toBe(12);
    expect(parseEventCursor(undefined, "3")).toBe(3);
    expect(() => parseEventCursor("-1", undefined)).toThrow("cursor");
    expect(() => parseEventCursor("1,2", undefined)).toThrow("cursor");
  });

  it("chunk 경계와 heartbeat를 처리하고 id·event·data identity를 검증한다", async () => {
    const encoded = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.encode(": heartbeat\n\nid: 2\nevent: work."));
        controller.enqueue(encoded.encode('changed\ndata: {"sequence":2,"type":"work.changed"}\n\n'));
        controller.close();
      },
    });
    const values: unknown[] = [];
    for await (const value of decodeApplicationSseStream(stream)) values.push(value);
    expect(values).toEqual([{ sequence: 2, type: "work.changed" }]);
  });

  it("소비자가 terminal event 뒤 순회를 멈추면 underlying stream을 취소한다", async () => {
    const encoded = new TextEncoder();
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.encode('id: 1\nevent: run.blocked\ndata: {"sequence":1,"type":"run.blocked"}\n\n'));
      },
      cancel() {
        cancelled += 1;
      },
    });

    for await (const value of decodeApplicationSseStream(stream)) {
      expect(value).toMatchObject({ sequence: 1, type: "run.blocked" });
      break;
    }

    expect(cancelled).toBe(1);
  });
});
