// Work 진행 기록 transcript — nimbalyst MarkdownRenderer 로 마크다운을 렌더한다.
// MarkdownRenderer(react-syntax-highlighter Prism 포함)는 무거우므로 lazy-load 로 분리한다.
// 초기 WorkPage 청크는 가볍고, 마크다운 렌더는 별도 청크로 지연 로드된다.
import { Suspense, lazy } from "react";
import type { ComponentType } from "react";

import type { TranscriptItem, TranscriptRole } from "./adapters/contract.js";

// nimbalyst 진짜 마크다운 렌더(Prism 코드 하이라이트·테이블·링크 autolink) — 별도 청크.
interface MarkdownRendererProps {
  readonly content: string;
  readonly isUser: boolean;
}
const MarkdownRenderer = lazy(async (): Promise<{ default: ComponentType<MarkdownRendererProps> }> => ({
  default: (await import("@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer")).MarkdownRenderer,
}));

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
                <Suspense fallback={<span className="nim-transcript-empty">렌더 준비 중…</span>}>
                  <LazyMarkdown content={item.content || " "} isUser={item.role === "user"} />
                </Suspense>
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}

// MarkdownProvider(jotai 빈 store)로 감싼 lazy 렌더.
import { MarkdownProvider } from "./MarkdownProvider.js";
function LazyMarkdown({ content, isUser }: { readonly content: string; readonly isUser: boolean }) {
  return (
    <MarkdownProvider>
      <MarkdownRenderer content={content} isUser={isUser} />
    </MarkdownProvider>
  );
}
