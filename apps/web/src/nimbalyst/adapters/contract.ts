// 어댑터 계약(동결) — Massion 도메인(work.timeline 셀 + 실행 델타)을
// transcript 표현으로 변환하는 단일 경계. TUI·Web transcript의 공통 모델.
// nimbalyst AgentTranscript가 소비하는 형태를 Massion 데이터로 채웁니다.

export type TranscriptRole = "user" | "assistant" | "tool";

export type TranscriptKind =
  | "message"
  | "tool-call"
  | "tool-result"
  | "plan"
  | "artifact"
  | "activity";

export interface TranscriptItem {
  readonly id: string;
  readonly role: TranscriptRole;
  readonly kind: TranscriptKind;
  readonly content: string; // 마크다운
  readonly status?: string;
  readonly createdAt: string;
  readonly streaming?: boolean; // 실행 델타 active cell(휘발성)
}

export interface TranscriptAuthor {
  readonly label: string;
  readonly role: TranscriptRole;
}
