import { describe, expect, it, vi } from "vitest";

import {
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_PENDING_REQUESTS,
  JsonlFramer,
  createBridge,
  type BridgeAdapter,
} from "./bridge.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapter(overrides: Partial<BridgeAdapter> = {}): BridgeAdapter {
  return {
    connect: async (params) => ({ connected: params }),
    query: async (params) => ({ queried: params }),
    command: async (params) => ({ commanded: params }),
    events: async function* () {},
    executions: async function* () {},
    shutdown: async () => undefined,
    ...overrides,
  };
}

function harness(overrides: Partial<BridgeAdapter> = {}) {
  const lines: string[] = [];
  const bridge = createBridge({
    adapter: adapter(overrides),
    write: async (line) => {
      lines.push(line);
    },
  });
  return {
    bridge,
    lines,
    values: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function request(
  bridge: ReturnType<typeof createBridge>,
  id: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  return await bridge.handle(Buffer.from(JSON.stringify({ id, method, params }), "utf8"));
}

describe("desktop JSONL bridge", () => {
  it("hello와 Application 작업을 고정된 응답 envelope로 전달한다", async () => {
    const { bridge, values } = harness();

    await request(bridge, "request-1", "hello");
    await request(bridge, "request-2", "connect");
    await request(bridge, "request-4", "query", { operation: "work.index", payload: {} });
    await request(bridge, "request-5", "command", { operation: "work.create", payload: {} });

    expect(values()).toEqual([
      {
        id: "request-1",
        ok: true,
        result: {
          protocol: "massion.desktop-bridge.v1",
          methods: [
            "hello",
            "connect",
            "query",
            "command",
            "events.start",
            "events.stop",
            "executions.start",
            "executions.stop",
            "shutdown",
          ],
          limits: {
            inputBytes: MAX_INPUT_BYTES,
            outputBytes: MAX_OUTPUT_BYTES,
            pendingRequests: MAX_PENDING_REQUESTS,
          },
        },
      },
      { id: "request-2", ok: true, result: { connected: {} } },
      {
        id: "request-4",
        ok: true,
        result: { queried: { operation: "work.index", payload: {} } },
      },
      {
        id: "request-5",
        ok: true,
        result: { commanded: { operation: "work.create", payload: {} } },
      },
    ]);
  });

  it("durable과 execution stream을 각각 하나만 열고 stop으로 중단한다", async () => {
    let eventsSignal: AbortSignal | undefined;
    let executionsSignal: AbortSignal | undefined;
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- 값 없는 동기 신호용 게이트
    const eventGate = deferred<void>();
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    const executionGate = deferred<void>();
    const { bridge, values } = harness({
      events: async function* (_params, signal) {
        eventsSignal = signal;
        yield { sequence: 1, type: "work.created" };
        await eventGate.promise;
      },
      executions: async function* (_params, signal) {
        executionsSignal = signal;
        yield { sequence: 2, text: "진행 중" };
        await executionGate.promise;
      },
    });

    await request(bridge, "events-1", "events.start", { after: 0 });
    await request(bridge, "events-2", "events.start", { after: 0 });
    await request(bridge, "executions-1", "executions.start", { executionId: "execution-1" });
    await request(bridge, "executions-2", "executions.start", {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(values()).toContainEqual({
      type: "event",
      stream: "events",
      payload: { sequence: 1, type: "work.created" },
    });
    expect(values()).toContainEqual({
      type: "event",
      stream: "executions",
      payload: { sequence: 2, text: "진행 중" },
    });
    expect(values()).toContainEqual({
      id: "events-2",
      ok: false,
      error: { code: "STREAM_ALREADY_ACTIVE", message: "events 스트림이 이미 실행 중입니다" },
    });
    expect(values()).toContainEqual({
      id: "executions-2",
      ok: false,
      error: { code: "STREAM_ALREADY_ACTIVE", message: "executions 스트림이 이미 실행 중입니다" },
    });

    await request(bridge, "events-stop", "events.stop");
    await request(bridge, "executions-stop", "executions.stop");
    eventGate.resolve();
    executionGate.resolve();

    expect(eventsSignal?.aborted).toBe(true);
    expect(executionsSignal?.aborted).toBe(true);
  });

  it("stop 중인 스트림의 재시작과 늦은 이벤트를 막는다", async () => {
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    const gate = deferred<void>();
    const { bridge, values } = harness({
      events: async function* () {
        await gate.promise;
        yield { secret: "stale-event" };
      },
    });

    await request(bridge, "events-start", "events.start", {});
    await request(bridge, "events-stop", "events.stop", {});
    await request(bridge, "events-restart", "events.start", {});
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(values()).toContainEqual({
      id: "events-restart",
      ok: false,
      error: { code: "STREAM_ALREADY_ACTIVE", message: "events 스트림이 이미 실행 중입니다" },
    });
    expect(linesJoined(values())).not.toContain("stale-event");
  });

  it("잘못된·초과 크기·알 수 없는 요청 뒤에도 다음 요청을 처리한다", async () => {
    const { bridge, values } = harness();

    await bridge.handle(Buffer.from("{broken", "utf8"));
    await bridge.handle(Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61));
    await bridge.handle(
      Buffer.concat([
        Buffer.from('{"id":"utf8-1","method":"hello","params":{"value":"', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}}', "utf8"),
      ]),
    );
    await request(bridge, "unknown-1", "secrets.dump", { authorization: "Bearer do-not-leak" });
    await request(bridge, "request-ok", "hello");

    expect(values().slice(0, 4)).toEqual([
      {
        id: "invalid",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "요청 형식이 올바르지 않습니다" },
      },
      {
        id: "invalid",
        ok: false,
        error: { code: "REQUEST_TOO_LARGE", message: "요청 크기 상한을 초과했습니다" },
      },
      {
        id: "invalid",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "요청 형식이 올바르지 않습니다" },
      },
      {
        id: "unknown-1",
        ok: false,
        error: { code: "METHOD_NOT_FOUND", message: "지원하지 않는 요청입니다" },
      },
    ]);
    expect(values().at(-1)).toMatchObject({ id: "request-ok", ok: true });
    expect(linesJoined(values())).not.toContain("do-not-leak");
  });

  it("adapter 오류와 초과 크기 결과에서 비밀·stack을 노출하지 않는다", async () => {
    const { bridge, values } = harness({
      query: async () => {
        throw new Error("Authorization: Bearer secret-value\nstack: /Users/owner/private.ts");
      },
      command: async () => ({ value: "x".repeat(MAX_OUTPUT_BYTES) }),
    });

    await request(bridge, "failure-1", "query", {});
    await request(bridge, "failure-2", "command", {});

    expect(values()).toEqual([
      {
        id: "failure-1",
        ok: false,
        error: { code: "OPERATION_FAILED", message: "요청을 처리하지 못했습니다" },
      },
      {
        id: "failure-2",
        ok: false,
        error: { code: "RESPONSE_TOO_LARGE", message: "응답 크기 상한을 초과했습니다" },
      },
    ]);
    expect(linesJoined(values())).not.toMatch(/secret-value|private\.ts|Authorization|stack/u);
  });

  it("직렬화 hook을 실행하지 않고 JSON 값만 출력한다", async () => {
    let toJsonCalled = false;
    const { bridge, values } = harness({
      command: async () => ({
        toJSON() {
          toJsonCalled = true;
          return { secret: "x".repeat(MAX_OUTPUT_BYTES) };
        },
      }),
    });

    await request(bridge, "unsafe-result", "command", {});

    expect(toJsonCalled).toBe(false);
    expect(values()).toEqual([
      {
        id: "unsafe-result",
        ok: false,
        error: { code: "RESPONSE_TOO_LARGE", message: "응답 크기 상한을 초과했습니다" },
      },
    ]);
  });

  it("동시에 대기하는 요청은 128개까지만 허용한다", async () => {
    const gate = deferred<unknown>();
    const { bridge, values } = harness({ query: async () => await gate.promise });
    const pending = Array.from({ length: MAX_PENDING_REQUESTS }, (_, index) =>
      request(bridge, `pending-${String(index)}`, "query", {}),
    );
    await request(bridge, "pending-overflow", "query", {});

    expect(values()).toContainEqual({
      id: "pending-overflow",
      ok: false,
      error: { code: "TOO_MANY_REQUESTS", message: "동시 요청 상한을 초과했습니다" },
    });

    gate.resolve({ done: true });
    await Promise.all(pending);
  });

  it("shutdown은 adapter 정리와 성공 응답 flush 뒤 종료 신호를 반환한다", async () => {
    const order: string[] = [];
    const bridge = createBridge({
      adapter: adapter({ shutdown: async () => void order.push("adapter") }),
      write: async () => void order.push("flush"),
    });

    await expect(request(bridge, "shutdown-1", "shutdown")).resolves.toBe("shutdown");
    expect(order).toEqual(["adapter", "flush"]);
  });
});

describe("JsonlFramer", () => {
  it("분할된 UTF-8 JSONL과 oversized line 이후의 정상 line을 복구한다", () => {
    const framer = new JsonlFramer();
    const first = Buffer.from('{"id":"한', "utf8");
    const second = Buffer.from('글"}\n', "utf8");

    expect(framer.push(first)).toEqual([]);
    expect(framer.push(second)).toEqual([{ kind: "line", value: Buffer.concat([first, second]).subarray(0, -1) }]);

    const tooLarge = Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61);
    expect(framer.push(Buffer.concat([tooLarge, Buffer.from('\n{"id":"ok"}\n')]))).toEqual([
      { kind: "oversized" },
      { kind: "line", value: Buffer.from('{"id":"ok"}') },
    ]);
  });

  it("1MiB 한 줄이 조각나도 고정 버퍼로 모은다", () => {
    const framer = new JsonlFramer();
    const concatenate = vi.spyOn(Buffer, "concat");
    try {
      for (let index = 0; index < 128; index += 1) {
        expect(framer.push(Buffer.alloc(8 * 1024, 0x20))).toEqual([]);
      }
      const frames = framer.push(Buffer.from("\n"));
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ kind: "line" });
      expect(frames[0]?.kind === "line" ? frames[0].value.length : 0).toBe(MAX_INPUT_BYTES);
      expect(concatenate).not.toHaveBeenCalled();
    } finally {
      concatenate.mockRestore();
    }
  });
});

function linesJoined(values: readonly Record<string, unknown>[]): string {
  return JSON.stringify(values);
}
