// Work 진행 기록 transcript — nimbalyst 시각 언어(crystal-dark 토큰 + 셀 구조)로 렌더.
// v1은 react-markdown으로 내용을 읽습니다(lexical 리치 편집은 다음 슬라이스).
// nimbalyst AgentTranscript(lexical 기반)는 vendor에 보존되어 있으며 lazy-load로 전환 예정.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { TranscriptItem, TranscriptRole } from "./adapters/contract.js";

const ROLE_LABEL: Readonly<Record<TranscriptRole, string>> = {
  user: "나",
  assistant: "에이전트",
  tool: "도구",
};

const KIND_LABEL: Readonly<Record<TranscriptItem["kind"], string>> = {
  message: "",
  "tool-call": "도구 호출",
  "tool-result": "도구 결과",
  plan: "계획",
  artifact: "산출물",
  activity: "활동",
};

export interface WorkTranscriptProps {
  readonly items: readonly TranscriptItem[];
}

export function WorkTranscript({ items }: WorkTranscriptProps) {
  return (
    <div className="nim-transcript" role="log" aria-live="polite" aria-label="업무 진행 기록">
      {items.length === 0 ? (
        <p className="nim-transcript-empty">아직 진행 기록이 없습니다.</p>
      ) : (
        items.map((item) => {
          const kindLabel = KIND_LABEL[item.kind];
          return (
            <article
              key={item.id}
              className={`nim-transcript-cell nim-transcript-cell--${item.role} nim-transcript-cell--${item.kind}`}
            >
              <header className="nim-transcript-cell-header">
                <strong className="nim-transcript-cell-sender">{ROLE_LABEL[item.role]}</strong>
                {kindLabel ? <span className="nim-transcript-cell-kind">{kindLabel}</span> : null}
                <time className="nim-transcript-cell-time">{item.createdAt}</time>
              </header>
              <div className={`nim-transcript-cell-body${item.streaming ? " is-streaming" : ""}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content || " "}</ReactMarkdown>
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}
