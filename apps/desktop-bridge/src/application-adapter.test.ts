import { describe, expect, it, vi } from "vitest";

import {
  APPLICATION_EVENT_SCHEMA_VERSION,
  APPLICATION_SCHEMA_VERSION,
  ApplicationRemoteError,
} from "@massion/application";

import {
  createApplicationAdapter,
  type ApplicationAdapterDependencies,
  type ApplicationHttpPort,
} from "./application-adapter.js";

function client(overrides: Partial<ApplicationHttpPort> = {}): ApplicationHttpPort {
  return {
    status: async () => ({ status: "ready" }),
    me: async () => ({ userId: "owner", secret: "server-only" }),
    query: async (operation, payload) => ({ operation, payload }),
    command: async (input) => input,
    streamEvents: async function* () {},
    streamExecutionDeltas: async function* () {},
    ...overrides,
  };
}

function event(sequence: number) {
  return {
    schemaVersion: APPLICATION_EVENT_SCHEMA_VERSION,
    eventId: `event-${String(sequence).padStart(8, "0")}`,
    organizationId: "organization-local",
    sequence,
    type: "work.changed",
    author: { kind: "system" as const, id: "desktop-bridge" },
    occurredAt: new Date(sequence * 1_000).toISOString(),
    payload: {},
  };
}

function dependencies(overrides: Partial<ApplicationAdapterDependencies> = {}) {
  const http = client();
  const value: ApplicationAdapterDependencies = {
    startDaemon: vi.fn(async () => undefined),
    stopDaemon: vi.fn(async () => undefined),
    openLocalSession: vi.fn(async () => "mat_session-only-in-memory"),
    createClient: vi.fn(() => http),
    defaultEndpoint: "http://127.0.0.1:7331",
    reconnectAttempts: 3,
    wait: vi.fn(async () => undefined),
    ...overrides,
  };
  return { dependencies: value, http };
}

async function connected(overrides: Partial<ApplicationAdapterDependencies> = {}) {
  const fixture = dependencies(overrides);
  const adapter = createApplicationAdapter(fixture.dependencies);
  await adapter.connect({});
  return { ...fixture, adapter };
}

describe("ApplicationBridgeAdapter 연결", () => {
  it("daemon 뒤에 메모리 local session만 열고 secret 없는 연결 결과를 반환한다", async () => {
    const calls: string[] = [];
    const finalClient = client({
      status: async () => void calls.push("status"),
      me: async () => void calls.push("me"),
    });
    const { dependencies: deps } = dependencies({
      startDaemon: async () => void calls.push("daemon"),
      openLocalSession: async () => (calls.push("session"), "mat_session-only-in-memory"),
      createClient: () => finalClient,
    });
    const adapter = createApplicationAdapter(deps);

    const result = await adapter.connect({});

    expect(result).toEqual({ status: "connected" });
    expect(calls).toEqual(["daemon", "session", "status", "me"]);
    expect(JSON.stringify(result)).not.toMatch(/7331|token|secret|authorization/iu);
    await expect(adapter.connect({ profile: "other" })).rejects.toThrow("알 수 없는");
  });

  it("같은 bridge process에서는 다시 profile이나 token을 만들지 않는다", async () => {
    const fixture = dependencies();
    const adapter = createApplicationAdapter(fixture.dependencies);

    await adapter.connect({});
    await adapter.connect({});

    expect(fixture.dependencies.openLocalSession).toHaveBeenCalledOnce();
  });
});

describe("ApplicationBridgeAdapter operation", () => {
  it("query를 strict 검증하고 검증된 command envelope를 그대로 전달한다", async () => {
    const queries: unknown[] = [];
    const commands: unknown[] = [];
    const http = client({
      query: async (operation, payload) => (queries.push({ operation, payload }), { data: "ok" }),
      command: async (input) => (commands.push(input), { outcome: "accepted" }),
    });
    const { adapter } = await connected({ createClient: () => http });
    const command = {
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      commandId: "command-0001",
      correlationId: "correlation-0001",
      operation: "run.cancel",
      payload: { runId: "run-0001" },
    } as const;

    await expect(adapter.query({ operation: "work.index", payload: { limit: 25 } })).resolves.toEqual({ data: "ok" });
    await expect(adapter.command(command)).resolves.toEqual({ outcome: "accepted" });
    expect(queries).toEqual([{ operation: "work.index", payload: { limit: 25 } }]);
    expect(commands).toEqual([command]);
    await expect(adapter.query({ operation: "work.index", payload: {}, extra: true })).rejects.toThrow("알 수 없는");
    await expect(adapter.command({ ...command, authorization: "Bearer secret" })).rejects.toThrow("알 수 없는");
  });

  it("연결 전 operation을 거부하고 shutdown에서 시작하지 않은 daemon도 한 번 종료한다", async () => {
    const fixture = dependencies();
    const adapter = createApplicationAdapter(fixture.dependencies);

    await expect(adapter.query({ operation: "work.index", payload: {} })).rejects.toThrow("연결");
    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(fixture.dependencies.startDaemon).not.toHaveBeenCalled();
    expect(fixture.dependencies.stopDaemon).toHaveBeenCalledOnce();
  });

});

describe("ApplicationBridgeAdapter streams", () => {
  it("새 sequence가 진행되면 reconnect failure를 reset한다", async () => {
    const cursors: number[] = [];
    const controller = new AbortController();
    const http = client({
      streamEvents: async function* (after = 0) {
        cursors.push(after);
        yield event(after + 1);
      },
    });
    const { adapter } = await connected({ createClient: () => http, reconnectAttempts: 2 });
    const events: unknown[] = [];

    for await (const value of adapter.events({}, controller.signal)) {
      events.push(value);
      if (events.length === 5) controller.abort();
    }

    expect(events).toHaveLength(5);
    expect(cursors).toEqual([0, 1, 2, 3, 4]);
  });

  it("durable event stream은 cursor를 이어 정상·일시 오류 종료를 bounded 재연결한다", async () => {
    const cursors: number[] = [];
    let connections = 0;
    const controller = new AbortController();
    const http = client({
      streamEvents: async function* (after = 0) {
        cursors.push(after);
        connections += 1;
        yield event(after + 1);
        if (connections === 2) throw new TypeError("Authorization: Bearer transient-secret");
      },
    });
    const { adapter } = await connected({ createClient: () => http, reconnectAttempts: 3 });
    const events: unknown[] = [];

    for await (const event of adapter.events({ after: 4 }, controller.signal)) {
      events.push(event);
      if (events.length === 3) controller.abort();
    }

    expect(cursors).toEqual([4, 5, 6]);
    expect(events).toHaveLength(3);
  });

  it("durable reconnect 상한과 비일시 HTTP 오류를 일반 오류로 끝낸다", async () => {
    const empty = client({ streamEvents: async function* () {} });
    const bounded = await connected({ createClient: () => empty, reconnectAttempts: 2 });
    await expect(async () => {
      for await (const _event of bounded.adapter.events({}, new AbortController().signal)) void _event;
    }).rejects.toThrow("재연결 상한");

    const denied = client({
      streamEvents: async function* () {
        throw new ApplicationRemoteError(401, { authorization: "Bearer server-secret" });
      },
    });
    const permanent = await connected({ createClient: () => denied });
    await expect(async () => {
      for await (const _event of permanent.adapter.events({}, new AbortController().signal)) void _event;
    }).rejects.toThrow("다시 연결할 수 없습니다");
  });

  it("execution stream은 replay·reconnect 없이 한 연결만 사용한다", async () => {
    const executions: Array<string | undefined> = [];
    const http = client({
      streamExecutionDeltas: async function* (executionId) {
        executions.push(executionId);
        yield { sequence: 1, text: "진행" };
      },
    });
    const { adapter } = await connected({ createClient: () => http });
    const values: unknown[] = [];

    for await (const value of adapter.executions({ executionId: "execution-0001" }, new AbortController().signal)) {
      values.push(value);
    }

    expect(values).toEqual([{ sequence: 1, text: "진행" }]);
    expect(executions).toEqual(["execution-0001"]);
    await expect(async () => {
      for await (const _value of adapter.executions({ executionId: "bad value" }, new AbortController().signal)) {
        void _value;
      }
    }).rejects.toThrow("executionId");
  });
});
