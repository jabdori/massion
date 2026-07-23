import { describe, expect, it, vi } from "vitest";

import { createTauriNativeTransport } from "./native-transport";

describe("Tauri native transport", () => {
  it("invoke 입력을 Rust command 계약에 맞게 감싼다", async () => {
    const invoke = vi.fn(async (command: string, input?: unknown) => ({ command, input }));
    const transport = createTauriNativeTransport({ invoke, listen: vi.fn() });

    await transport.bootstrap({ profile: "desktop" });
    await transport.query("work.index", { status: "running" });
    await transport.command({ schemaVersion: "massion.application.v1", operation: "run.cancel" });

    expect(invoke.mock.calls).toEqual([
      ["bootstrap", { input: { profile: "desktop" } }],
      ["query", { input: { operation: "work.index", payload: { status: "running" } } }],
      ["command", { input: { schemaVersion: "massion.application.v1", operation: "run.cancel" } }],
    ]);
  });

  it("bridge event를 stream별로 전달하고 stop 시 unlisten과 native stop을 한 번씩 수행한다", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_name: string, callback: (event: { payload: unknown }) => void) => {
      handler = callback;
      return unlisten;
    });
    const invoke = vi.fn(async () => ({ started: true }));
    const received: unknown[] = [];
    const transport = createTauriNativeTransport({ invoke, listen });

    const stop = await transport.startStream("events", { after: 7 }, (payload) => received.push(payload));
    handler?.({ payload: { stream: "executions", payload: { ignored: true } } });
    handler?.({ payload: { stream: "events", payload: { sequence: 8, type: "work.changed" } } });
    await stop();
    await stop();

    expect(listen).toHaveBeenCalledWith("massion://bridge-event", expect.any(Function));
    expect(invoke.mock.calls).toEqual([
      ["stream_start", { input: { stream: "events", params: { after: 7 } } }],
      ["stream_stop", { input: { stream: "events", params: {} } }],
    ]);
    expect(received).toEqual([{ sequence: 8, type: "work.changed" }]);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
