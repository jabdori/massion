import type { TenantContext } from "@massion/identity";

// Work 계보(도메인 event + 협업 메시지)를 Surface가 공유하는 단일 시간순 셀 목록으로 투영합니다.
// 셀 union과 표시 토큰이 TUI·Web transcript의 공통 정본입니다.

export type WorkTimelineCellKind =
  "user-message" | "agent-message" | "stage" | "task" | "artifact" | "verification" | "record" | "plan" | "activity";

export interface WorkTimelineCell {
  readonly cellId: string;
  readonly kind: WorkTimelineCellKind;
  readonly title: string;
  readonly detail?: string;
  readonly authorId?: string;
  readonly roomId?: string;
  readonly eventType?: string;
  readonly createdAt: string;
  readonly sequence: number;
}

export interface WorkTimelineCellToken {
  readonly kind: WorkTimelineCellKind;
  readonly friendlyLabel: string;
  readonly symbol: string;
}

const CELL_TOKENS: Readonly<Record<WorkTimelineCellKind, WorkTimelineCellToken>> = {
  "user-message": { kind: "user-message", friendlyLabel: "내 메시지", symbol: "›" },
  "agent-message": { kind: "agent-message", friendlyLabel: "에이전트 응답", symbol: "●" },
  stage: { kind: "stage", friendlyLabel: "진행 단계", symbol: "▶" },
  task: { kind: "task", friendlyLabel: "작업", symbol: "▸" },
  artifact: { kind: "artifact", friendlyLabel: "산출물", symbol: "✎" },
  verification: { kind: "verification", friendlyLabel: "검증", symbol: "✓" },
  record: { kind: "record", friendlyLabel: "기록", symbol: "▣" },
  plan: { kind: "plan", friendlyLabel: "계획", symbol: "☰" },
  activity: { kind: "activity", friendlyLabel: "활동", symbol: "·" },
};

export function workTimelineCellToken(kind: WorkTimelineCellKind): WorkTimelineCellToken {
  return CELL_TOKENS[kind];
}

interface TimelineEventSource {
  readonly event_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly payload_json: string;
  readonly created_at: unknown;
}

interface TimelineRoomSource {
  readonly room_id: string;
}

interface TimelineMessageSource {
  readonly message_id: string;
  readonly room_id: string;
  readonly sequence: number;
  readonly author_kind: "user" | "agent";
  readonly author_id: string;
  readonly content: string;
  readonly created_at: unknown;
}

export interface WorkTimelineSources {
  events(context: TenantContext, workId: string): Promise<readonly TimelineEventSource[]>;
  rooms(context: TenantContext, workId: string): Promise<readonly TimelineRoomSource[]>;
  messages(context: TenantContext, workId: string, roomId: string): Promise<readonly TimelineMessageSource[]>;
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  // SurrealDB DateTime (not instanceof Date; has .toISOString())
  if (value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)["toISOString"] === "function") {
    return (value as { toISOString(): string }).toISOString();
  }
  throw new Error("timeline 항목의 시각이 유효하지 않습니다");
}

function payloadOf(event: TimelineEventSource): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function payloadText(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

interface EventRule {
  readonly kind: WorkTimelineCellKind;
  readonly title: (payload: Record<string, unknown>) => string;
}

const EVENT_RULES: Readonly<Record<string, EventRule>> = {
  work_created: { kind: "stage", title: () => "업무가 접수되었습니다" },
  work_created_from_fork: { kind: "stage", title: () => "분기된 업무가 시작되었습니다" },
  work_state_changed: {
    kind: "stage",
    title: (payload) => `업무 상태가 바뀌었습니다: ${payloadText(payload, ["target", "status"]) ?? "변경"}`,
  },
  task_created: {
    kind: "task",
    title: (payload) =>
      `작업이 생성되었습니다${payloadText(payload, ["title"]) ? `: ${payloadText(payload, ["title"]) ?? ""}` : ""}`,
  },
  task_assigned: {
    kind: "task",
    title: (payload) =>
      `작업이 배정되었습니다${payloadText(payload, ["agentHandle", "agent_handle"]) ? `: @${payloadText(payload, ["agentHandle", "agent_handle"]) ?? ""}` : ""}`,
  },
  task_state_changed: {
    kind: "task",
    title: (payload) => `작업 상태가 바뀌었습니다: ${payloadText(payload, ["target", "status"]) ?? "변경"}`,
  },
  artifact_version_created: {
    kind: "artifact",
    title: (payload) =>
      `산출물이 생성되었습니다${payloadText(payload, ["name"]) ? `: ${payloadText(payload, ["name"]) ?? ""}` : ""}`,
  },
  plan_version_created: { kind: "plan", title: () => "계획이 수립되었습니다" },
  work_verification: {
    kind: "verification",
    title: (payload) =>
      `검증 결과가 기록되었습니다${payloadText(payload, ["status", "outcome"]) ? `: ${payloadText(payload, ["status", "outcome"]) ?? ""}` : ""}`,
  },
  work_record_finalized: { kind: "record", title: () => "기록이 확정되었습니다" },
  work_forked: { kind: "activity", title: () => "업무가 분기되었습니다" },
  work_merge_planned: { kind: "activity", title: () => "병합이 계획되었습니다" },
  work_merge_applied: { kind: "activity", title: () => "병합이 적용되었습니다" },
};

function cellFromEvent(event: TimelineEventSource): WorkTimelineCell {
  const payload = payloadOf(event);
  const rule = EVENT_RULES[event.event_type];
  return {
    cellId: `event:${event.event_id}`,
    kind: rule?.kind ?? "activity",
    title: rule?.title(payload) ?? `활동: ${event.event_type}`,
    authorId: event.actor_user_id,
    eventType: event.event_type,
    createdAt: isoTimestamp(event.created_at),
    sequence: event.sequence,
  };
}

function cellFromMessage(message: TimelineMessageSource): WorkTimelineCell {
  return {
    cellId: `message:${message.message_id}`,
    kind: message.author_kind === "user" ? "user-message" : "agent-message",
    title: message.author_kind === "user" ? "내 메시지" : "에이전트 응답",
    detail: message.content,
    authorId: message.author_id,
    roomId: message.room_id,
    createdAt: isoTimestamp(message.created_at),
    sequence: message.sequence,
  };
}

export async function projectWorkTimeline(
  sources: WorkTimelineSources,
  context: TenantContext,
  workId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly WorkTimelineCell[]> {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new Error("timeline limit이 유효하지 않습니다");
  const [events, rooms] = await Promise.all([sources.events(context, workId), sources.rooms(context, workId)]);
  const messagesByRoom = await Promise.all(rooms.map(async (room) => sources.messages(context, workId, room.room_id)));
  const cells = [...events.map(cellFromEvent), ...messagesByRoom.flat().map(cellFromMessage)];
  cells.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0;
  });
  return cells.slice(-limit);
}
