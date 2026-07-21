// Massion 도메인(work.timeline 셀 + 실행 델타)을 transcript 표현으로 변환하는 단일 어댑터.
// nimbalyst AgentTranscript가 소비하는 형태(TranscriptItem)를 Massion 데이터로 채웁니다.
import { label, rows } from "../../data.js";
import type { TranscriptItem, TranscriptKind, TranscriptRole } from "./contract.js";

// work.timeline 셀 종류(WorkTimelineCellKind) → transcript role/kind 매핑
function mapCellKind(kind: string): { role: TranscriptRole; kind: TranscriptKind } {
  switch (kind) {
    case "user-message":
      return { role: "user", kind: "message" };
    case "agent-message":
      return { role: "assistant", kind: "message" };
    case "plan":
      return { role: "assistant", kind: "plan" };
    case "task":
      return { role: "tool", kind: "tool-call" };
    case "artifact":
      return { role: "tool", kind: "artifact" };
    default:
      // stage · verification · record · activity
      return { role: "tool", kind: "activity" };
  }
}

// work.timeline 응답(unknown)을 TranscriptItem 목록으로 변환합니다.
export function toTranscriptItems(timelineData: unknown): TranscriptItem[] {
  return rows(timelineData).map((cell) => {
    const { role, kind } = mapCellKind(label(cell.kind, "activity"));
    return {
      id: label(cell.cellId),
      role,
      kind,
      content: label(cell.detail, label(cell.title)),
      createdAt: label(cell.createdAt),
    };
  });
}

export interface ExecutionStreamLike {
  readonly executionId: string;
  readonly agentHandle: string;
  readonly text: string;
}

// 실행 델타 active cell(휘발성)을 streaming assistant 항목으로 꼬리에 덧붙입니다.
// lifecycle finish 시 스트림이 비워지면 자동으로 사라집니다.
export function withStreamingTail(
  items: readonly TranscriptItem[],
  stream: ExecutionStreamLike | undefined,
): TranscriptItem[] {
  if (!stream || !stream.text) return [...items];
  return [
    ...items,
    {
      id: `stream:${stream.executionId}`,
      role: "assistant",
      kind: "message",
      content: stream.text,
      createdAt: new Date().toISOString(),
      streaming: true,
    },
  ];
}
