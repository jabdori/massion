import { describe, expect, it } from "vitest";

import { createTuiState, reduceTuiState } from "./state.js";
import { decodeQueryResult, decodeSnapshot } from "./wire.js";

const snapshot = {
  schemaVersion: "massion.collaboration.snapshot.v1",
  revision: "a".repeat(64),
  sourceWatermarks: { work: 1 },
  organization: { organizationId: "organization-1", version: 2 },
  nodes: [
    {
      handle: "representative",
      name: "대표",
      responsibility: "요청 조정",
      capabilities: ["intake"],
      status: "active",
      role: "representative",
      scope: "core",
      currentTaskId: "task-1",
      currentWorkId: "work-1",
      executionId: "execution-1",
      executionStatus: "running",
      modelRoute: "planning-quality",
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 25,
    },
  ],
  works: [
    {
      workId: "work-1",
      status: "running",
      revision: 3,
      artifactIds: [],
      taskIds: ["task-1"],
      roomIds: ["room-1"],
    },
  ],
  tasks: [{ workId: "work-1", taskId: "task-1", title: "분석", status: "running", revision: 1 }],
  assignments: [
    {
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "representative",
      status: "assigned",
      revision: 1,
    },
  ],
  executions: [
    {
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "representative",
      modelRoute: "planning-quality",
      status: "running",
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 25,
    },
  ],
  rooms: [
    {
      workId: "work-1",
      roomId: "room-1",
      name: "개발 협업",
      kind: "work",
      status: "open",
      participantIds: ["representative", "user-1"],
      lastMessageSequence: 4,
    },
  ],
  pendingApprovals: [
    {
      approvalId: "approval-1",
      action: "deploy",
      status: "pending",
      requestedBy: "representative",
      expiresAt: "2026-07-12T00:00:00.000Z",
    },
  ],
  extensions: [],
} as const;

describe("TUI wire와 상태", () => {
  it("공개 협업 snapshot을 검증하고 내부 secret 필드를 거부한다", () => {
    expect(decodeSnapshot(snapshot).organization.organizationId).toBe("organization-1");
    expect(() => decodeSnapshot({ ...snapshot, token: "secret" })).toThrow(/알 수 없는/u);
    expect(() => decodeSnapshot({ ...snapshot, nodes: [{ ...snapshot.nodes[0], costMicros: -1 }] })).toThrow(
      /costMicros/u,
    );
  });

  it("HTTP query 응답의 schema와 operation 계보를 검증한다", () => {
    expect(
      decodeQueryResult(
        { schemaVersion: "massion.application.v1", operation: "identity.me", data: { userId: "user-1" } },
        "identity.me",
      ),
    ).toEqual({ userId: "user-1" });
    expect(() =>
      decodeQueryResult(
        { schemaVersion: "massion.application.v1", operation: "system.status", data: {} },
        "identity.me",
      ),
    ).toThrow(/계보/u);
  });

  it("snapshot을 적용하면 유효한 선택을 보존하고 사라진 선택만 교정한다", () => {
    const loaded = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(snapshot) });
    expect(loaded.selection).toMatchObject({ workId: "work-1", agentHandle: "representative", roomId: "room-1" });
    const manuallySelected = { ...loaded, selection: { ...loaded.selection, workId: "missing" } };
    const refreshed = reduceTuiState(manuallySelected, { type: "snapshot.loaded", snapshot: decodeSnapshot(snapshot) });
    expect(refreshed.selection.workId).toBe("work-1");
  });

  it("event cursor를 단조 증가시키고 순서 gap은 snapshot 재동기화를 요구한다", () => {
    const first = reduceTuiState(createTuiState(), {
      type: "event.received",
      event: { sequence: 1, type: "work.changed", payload: {} },
    });
    expect(first.cursor).toBe(1);
    expect(first.needsResync).toBe(false);
    const gap = reduceTuiState(first, {
      type: "event.received",
      event: { sequence: 3, type: "work.changed", payload: {} },
    });
    expect(gap.cursor).toBe(1);
    expect(gap.needsResync).toBe(true);
  });

  it("최근 event를 정해진 상한 안에만 보관한다", () => {
    let state = createTuiState({ eventLimit: 3 });
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      state = reduceTuiState(state, {
        type: "event.received",
        event: { sequence, type: "work.changed", payload: { sequence } },
      });
    }
    expect(state.events.map((event) => event.sequence)).toEqual([3, 4, 5]);
  });
});

export { snapshot as testSnapshot };
