import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkTranscript } from "./WorkTranscript.js";
import type { TranscriptItem } from "./adapters/contract.js";

describe("WorkTranscript", () => {
  it("빈 상태에서 안내 문구를 렌더한다", () => {
    render(<WorkTranscript items={[]} />);
    expect(screen.getByText("아직 진행 기록이 없습니다.")).toBeTruthy();
  });

  it("role·kind별 셀을 nimbalyst 시각 클래스로 렌더하고 마크다운을 푼다", () => {
    const items: TranscriptItem[] = [
      { id: "u1", role: "user", kind: "message", content: "**도움** 필요", createdAt: "2026-07-21" },
      { id: "a1", role: "assistant", kind: "message", content: "응답 *입니다*", createdAt: "2026-07-21" },
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

    // role별 셀 클래스
    expect(container.querySelector(".nim-transcript-cell--user")).toBeTruthy();
    expect(container.querySelector(".nim-transcript-cell--assistant")).toBeTruthy();
    expect(container.querySelector(".nim-transcript-cell--tool")).toBeTruthy();
    // plan 셀은 kind 라벨을 표시
    expect(screen.getByText("계획")).toBeTruthy();
    // 마크다운 강조가 풀려 텍스트로 노출
    expect(screen.getByText("도움")).toBeTruthy();
    expect(screen.getByText("입니다")).toBeTruthy();
    // streaming active cell
    expect(container.querySelector(".is-streaming")).toBeTruthy();
  });
});
