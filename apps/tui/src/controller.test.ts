import { describe, expect, it, vi } from "vitest";

import { TuiController } from "./controller.js";
import { createTuiState, reduceTuiState, type TuiState } from "./state.js";
import { testSnapshot } from "./state.test.js";

function response(operation: string, data: unknown): unknown {
  return { schemaVersion: "massion.application.v1", operation, data };
}

describe("TUI controller", () => {
  it("status→Identity→snapshot 순서로 초기화하고 조직 불일치를 거부한다", async () => {
    const calls: string[] = [];
    let state = createTuiState();
    const controller = new TuiController(
      {
        status: () => (calls.push("status"), Promise.resolve(response("system.status", { ok: true }))),
        me: () => (
          calls.push("me"),
          Promise.resolve(
            response("identity.me", {
              userId: "user-1",
              organizationId: "organization-1",
              membershipId: "member-1",
              role: "owner",
            }),
          )
        ),
        snapshot: () => (
          calls.push("snapshot"),
          Promise.resolve(response("organization.graph.snapshot", testSnapshot))
        ),
        streamEvents: async function* () {},
        query: () => Promise.resolve({}),
        command: () => Promise.resolve({}),
      },
      (action) => {
        state = reduceTuiState(state, action);
      },
      () => state,
    );
    await controller.refresh();
    expect(calls).toEqual(["status", "me", "snapshot"]);
    expect(controller.identity.userId).toBe("user-1");
    expect(state.snapshot?.organization.organizationId).toBe("organization-1");
  });

  it("event gap을 발견하면 snapshot을 다시 읽는다", async () => {
    let state: TuiState = { ...createTuiState(), cursor: 4 };
    let snapshots = 0;
    const abort = new AbortController();
    const controller = new TuiController(
      {
        status: () => Promise.resolve(response("system.status", {})),
        me: () =>
          Promise.resolve(
            response("identity.me", {
              userId: "user-1",
              organizationId: "organization-1",
              membershipId: "member-1",
              role: "owner",
            }),
          ),
        snapshot: () => {
          snapshots += 1;
          return Promise.resolve(response("organization.graph.snapshot", testSnapshot));
        },
        streamEvents: async function* () {
          yield { sequence: 6, type: "work.changed", payload: {} };
          abort.abort();
        },
        query: () => Promise.resolve({}),
        command: () => Promise.resolve({}),
      },
      (action) => {
        state = reduceTuiState(state, action);
      },
      () => state,
      { delay: () => Promise.resolve(), random: () => 0 },
    );
    await controller.run(abort.signal);
    expect(snapshots).toBeGreaterThanOrEqual(2);
    expect(state.needsResync).toBe(false);
  });

  it("연결 실패 후 상한 backoff로 재연결하고 token을 오류 상태에 복사하지 않는다", async () => {
    let state = createTuiState();
    let streams = 0;
    const delays: number[] = [];
    const abort = new AbortController();
    const controller = new TuiController(
      {
        status: () => Promise.resolve(response("system.status", {})),
        me: () =>
          Promise.resolve(
            response("identity.me", {
              userId: "user-1",
              organizationId: "organization-1",
              membershipId: "member-1",
              role: "owner",
            }),
          ),
        snapshot: () => Promise.resolve(response("organization.graph.snapshot", testSnapshot)),
        streamEvents: async function* () {
          streams += 1;
          if (streams === 1) throw new Error("Bearer secret-token");
          abort.abort();
          yield* [];
        },
        query: () => Promise.resolve({}),
        command: () => Promise.resolve({}),
      },
      (action) => {
        state = reduceTuiState(state, action);
      },
      () => state,
      { delay: (milliseconds) => (delays.push(milliseconds), Promise.resolve()), random: () => 0 },
    );
    await controller.run(abort.signal);
    expect(streams).toBe(2);
    expect(delays[0]).toBe(250);
    expect(state.error ?? "").not.toContain("secret-token");
  });

  it("query는 allowlist operation만 전달한다", async () => {
    const query = vi.fn().mockImplementation((operation: string) => Promise.resolve(response(operation, [])));
    const state = createTuiState();
    const controller = new TuiController(
      {
        status: () => Promise.resolve(response("system.status", {})),
        me: () =>
          Promise.resolve(
            response("identity.me", { userId: "u", organizationId: "o", membershipId: "m", role: "owner" }),
          ),
        snapshot: () => Promise.resolve(response("organization.graph.snapshot", testSnapshot)),
        streamEvents: async function* () {},
        query,
        command: () => Promise.resolve({}),
      },
      () => undefined,
      () => state,
    );
    await controller.query("work.messages", { workId: "work-1", roomId: "room-1" });
    await expect(controller.query("surreal.raw", {})).rejects.toThrow(/허용/u);
    expect(query).toHaveBeenCalledOnce();
  });

  it("구독 관리 조회만 명시적 allowlist로 전달한다", async () => {
    const query = vi.fn().mockImplementation((operation: string) => Promise.resolve(response(operation, [])));
    const state = createTuiState();
    const controller = new TuiController(
      {
        status: () => Promise.resolve(response("system.status", {})),
        me: () =>
          Promise.resolve(
            response("identity.me", { userId: "u", organizationId: "o", membershipId: "m", role: "owner" }),
          ),
        snapshot: () => Promise.resolve(response("organization.graph.snapshot", testSnapshot)),
        streamEvents: async function* () {},
        query,
        command: () => Promise.resolve({}),
      },
      () => undefined,
      () => state,
    );

    for (const operation of [
      "subscription.providers",
      "subscription.accounts",
      "subscription.quota",
      "subscription.policy",
      "subscription.doctor",
    ]) {
      await controller.query(operation, {});
    }

    expect(query.mock.calls.map(([operation]) => operation)).toEqual([
      "subscription.providers",
      "subscription.accounts",
      "subscription.quota",
      "subscription.policy",
      "subscription.doctor",
    ]);
  });
});
