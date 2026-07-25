import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkTranscript } from "./WorkTranscript.js";
import type { TranscriptItem } from "./adapters/contract.js";

// MarkdownRenderer(react-markdown + react-syntax-highlighter Prism)는 무거운 청크라
// lazy dynamic import 로 불러온다. jsdom 테스트에서는 이 의존성 transform 이
// 비결정적으로 느려(전체 실행 시 waitFor 기본 1000ms 초과) 본문이 resolve 되지 않는다.
// 테스트 의도는 "본문 텍스트가 보이는가"이지 Prism 하이라이트 검증이 아니므로,
// content 를 그대로 렌더하는 가벼운 stub 으로 치환해 결정적·빠르게 만든다.
// ponytail: 프로덕션 lazy 청크 분리는 그대로 두고 테스트만 mock.
vi.mock("@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { readonly content: string }) => <>{content}</>,
}));

describe("WorkTranscript", () => {
  it("빈 상태에서 안내 문구를 렌더한다", () => {
    render(<WorkTranscript items={[]} />);
    expect(screen.getByText("아직 진행 기록이 없습니다.")).toBeTruthy();
  });

  it("role·kind별 셀을 nimbalyst 시각 클래스로 렌더한다", async () => {
    // MarkdownRenderer 는 lazy-load(별도 청크)이므로 Suspense resolve 를 기다린다.
    const items: TranscriptItem[] = [
      { id: "u1", role: "user", kind: "message", content: "도움 필요", createdAt: "2026-07-21" },
      { id: "a1", role: "assistant", kind: "message", content: "응답입니다", createdAt: "2026-07-21" },
      { id: "t1", role: "tool", kind: "tool-call", content: "도구 실행됨", createdAt: "2026-07-21" },
      { id: "p1", role: "assistant", kind: "plan", content: "계획 항목", createdAt: "2026-07-21" },
      {
        id: "s1",
        role: "assistant",
        kind: "message",
        content: "스트리밍 중",
        createdAt: "2026-07-21",
        streaming: true,
      },
    ];
    const { container } = render(<WorkTranscript items={items} />);

    // role별 셀 클래스(동기 렌더, lazy 본문과 무관).
    expect(container.querySelector(".nim-transcript-cell--user")).toBeTruthy();
    expect(container.querySelector(".nim-transcript-cell--assistant")).toBeTruthy();
    expect(container.querySelector(".nim-transcript-cell--tool")).toBeTruthy();
    expect(container.querySelector(".is-streaming")).toBeTruthy();

    // plan 셀은 kind 라벨을 표시한다.
    expect(screen.getByText("계획")).toBeTruthy();

    // lazy MarkdownRenderer 가 resolve 된 뒤 마크다운 본문이 나타난다.
    await waitFor(() => {
      expect(screen.getByText("도움 필요")).toBeTruthy();
      expect(screen.getByText("응답입니다")).toBeTruthy();
    });
  });
});
