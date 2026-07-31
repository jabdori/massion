import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import { projectWorkTimeline, workTimelineCellToken } from "./timeline.js";

const context: TenantContext = {
  userId: "timeline-user",
  organizationId: "timeline-organization",
  membershipId: "timeline-membership",
  role: "member",
};

function event(input: {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly createdAt: string;
  readonly payload?: Record<string, unknown>;
  readonly request?: Record<string, unknown>;
}) {
  return {
    event_id: input.eventId,
    organization_id: context.organizationId,
    work_id: "work-1",
    sequence: input.sequence,
    command_id: `command-${String(input.sequence)}`,
    event_type: input.eventType,
    actor_user_id: "timeline-user",
    request_json: JSON.stringify(input.request ?? {}),
    payload_json: JSON.stringify(input.payload ?? {}),
    result_json: "{}",
    created_at: input.createdAt,
  };
}

function message(input: {
  readonly messageId: string;
  readonly sequence: number;
  readonly authorKind: "user" | "agent";
  readonly content: string;
  readonly createdAt: string;
}) {
  return {
    message_id: input.messageId,
    organization_id: context.organizationId,
    work_id: "work-1",
    room_id: "room-1",
    sequence: input.sequence,
    message_type: "question" as const,
    author_kind: input.authorKind,
    author_id: input.authorKind === "user" ? "timeline-user" : "representative",
    content: input.content,
    token_count: 0,
    cost_micros: 0,
    created_at: input.createdAt,
  };
}

describe("work.timeline 투영", () => {
  it("도메인 event와 협업 메시지를 시간순 단일 셀 목록으로 병합한다", async () => {
    const cells = await projectWorkTimeline(
      {
        events: async () => [
          event({
            eventId: "event-1",
            sequence: 1,
            eventType: "work_created",
            createdAt: "2026-07-21T09:00:00.000Z",
          }),
          event({
            eventId: "event-2",
            sequence: 2,
            eventType: "task_created",
            createdAt: "2026-07-21T09:02:00.000Z",
            payload: { title: "환불 API 계약 정의" },
          }),
          event({
            eventId: "event-3",
            sequence: 3,
            eventType: "artifact_version_created",
            createdAt: "2026-07-21T09:05:00.000Z",
            payload: { name: "refund.ts" },
          }),
        ],
        rooms: async () => [{ room_id: "room-1" }],
        messages: async () => [
          message({
            messageId: "message-1",
            sequence: 1,
            authorKind: "user",
            content: "환불 API를 추가해주세요",
            createdAt: "2026-07-21T09:01:00.000Z",
          }),
          message({
            messageId: "message-2",
            sequence: 2,
            authorKind: "agent",
            content: "계획을 수립했습니다",
            createdAt: "2026-07-21T09:03:00.000Z",
          }),
        ],
      },
      context,
      "work-1",
    );

    expect(cells.map((cell) => cell.cellId)).toEqual([
      "event:event-1",
      "message:message-1",
      "event:event-2",
      "message:message-2",
      "event:event-3",
    ]);
    expect(cells.map((cell) => cell.kind)).toEqual(["stage", "user-message", "task", "agent-message", "artifact"]);
    expect(cells[1]).toMatchObject({
      detail: "환불 API를 추가해주세요",
      roomId: "room-1",
      authorKind: "user",
      authorId: "timeline-user",
    });
    expect(cells[3]).toMatchObject({ authorKind: "agent", authorId: "representative" });
    expect(cells[2]?.title).toContain("환불 API 계약 정의");
  });

  it("의미 규칙이 없는 내부 event는 사용자 timeline에서 숨긴다", async () => {
    const cells = await projectWorkTimeline(
      {
        events: async () => [
          event({
            eventId: "event-1",
            sequence: 1,
            eventType: "custom_future_event",
            createdAt: "2026-07-21T09:00:00.000Z",
          }),
          event({
            eventId: "event-transport-room",
            sequence: 2,
            eventType: "collaboration_room_opened",
            createdAt: "2026-07-21T09:00:10.000Z",
          }),
          event({
            eventId: "event-transport-message",
            sequence: 3,
            eventType: "collaboration_message_posted",
            createdAt: "2026-07-21T09:00:20.000Z",
          }),
          event({
            eventId: "event-strategy",
            sequence: 4,
            eventType: "strategy_projection_applied",
            createdAt: "2026-07-21T09:00:30.000Z",
          }),
          event({
            eventId: "event-verification",
            sequence: 5,
            eventType: "verification_recorded",
            createdAt: "2026-07-21T09:00:40.000Z",
          }),
          event({
            eventId: "event-records",
            sequence: 6,
            eventType: "records_finalized",
            createdAt: "2026-07-21T09:00:50.000Z",
          }),
          event({
            eventId: "event-2",
            sequence: 7,
            eventType: "work_state_changed",
            createdAt: "2026-07-21T09:01:00.000Z",
            payload: { target: "running" },
          }),
          event({
            eventId: "event-work-failed",
            sequence: 8,
            eventType: "work_state_changed",
            createdAt: "2026-07-21T09:01:10.000Z",
            request: { target: "failed" },
          }),
          event({
            eventId: "event-task-failed",
            sequence: 9,
            eventType: "task_state_changed",
            createdAt: "2026-07-21T09:01:20.000Z",
            payload: { task: { task_id: "task-1", status: "failed" } },
          }),
          event({
            eventId: "event-task-assigned",
            sequence: 10,
            eventType: "task_assigned",
            createdAt: "2026-07-21T09:01:30.000Z",
            payload: { agentHandle: "staff-opaque-agent" },
          }),
        ],
        rooms: async () => [],
        messages: async () => [],
      },
      context,
      "work-1",
    );

    expect(cells).toMatchObject([
      { cellId: "event:event-strategy", kind: "plan", title: "실행 계획을 확정했습니다" },
      { cellId: "event:event-verification", kind: "verification", title: "독립 검증을 완료했습니다" },
      { cellId: "event:event-records", kind: "record", title: "결과 기록을 확정했습니다" },
      { cellId: "event:event-work-failed", kind: "stage", title: "업무 실행에 실패했습니다" },
      { cellId: "event:event-task-failed", kind: "task", title: "작업 실행에 실패했습니다" },
      { cellId: "event:event-task-assigned", kind: "task" },
    ]);
    expect(cells.at(-1)?.title).not.toContain("staff-opaque-agent");
    expect(cells.map((cell) => cell.title).join(" ")).not.toMatch(
      /활동:|custom_future_event|collaboration_room_opened|collaboration_message_posted|work_state_changed|running/u,
    );
  });

  it("셀 kind별 공통 표시 토큰을 제공한다", () => {
    for (const kind of [
      "user-message",
      "agent-message",
      "stage",
      "task",
      "artifact",
      "verification",
      "record",
      "plan",
      "activity",
    ] as const) {
      const token = workTimelineCellToken(kind);
      expect(token.friendlyLabel.length).toBeGreaterThan(0);
      expect(token.symbol.length).toBeGreaterThan(0);
    }
  });
});
