import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrganizationChangeView, SpeakerView } from "@/model";
import { ProposalActivity, RoomHandoff, RoomMessage, SpeakerRow, speakerFill } from "@/room";

const iris: SpeakerView = { handle: "assurance", name: "Iris", initial: "I", accentSlot: 5, role: "검증" };
const quill: SpeakerView = { handle: "evidence-research", name: "Quill", initial: "Q", accentSlot: 2, role: "조사" };
const vega: SpeakerView = { handle: "delivery-coordination", name: "Vega", initial: "V", accentSlot: 4, role: "실행" };
const atlas: SpeakerView = { handle: "representative", name: "Atlas", initial: "A", accentSlot: 0, role: "조정" };

const change: OrganizationChangeView = {
  nodes: [
    {
      handle: "quant-analysis",
      name: "계량분석 팀",
      scope: "work",
      parentHandle: "delivery-coordination",
      role: "operator",
      capabilities: ["코호트 정규화", "유의성 검정"],
    },
  ],
  impactNodes: 2,
  impactReferences: 3,
  impactHandles: ["delivery-coordination", "assurance"],
  fromVersion: 12,
  toVersion: 13,
  revertable: true,
  compliance: ["orphan", "cycle"],
  lifetime: "이 업무가 끝나면 자동으로 사라집니다.",
};

describe("협업방 문법", () => {
  it("이름이 정체성이고 역할은 배지로 붙는다", () => {
    render(<RoomMessage content="분류를 마쳤습니다." speaker={quill} time="10:23" type="evidence" />);
    expect(screen.getByText("Quill")).toBeInTheDocument();
    expect(screen.getByText("조사")).toBeInTheDocument();
  });

  it("사람 화자도 빈 아바타 대신 자신의 이니셜을 유지한다", () => {
    const me: SpeakerView = { handle: "owner-1", name: "나", initial: "나", accentSlot: -1, role: "사람", human: true };
    render(<RoomMessage content="진행해주세요." speaker={me} time="10:22" type="question" />);
    expect(screen.getAllByText("나")).toHaveLength(2);
  });

  it("일반 발언과 인계에는 내부 Provider가 아니라 실제 모델만 표시한다", () => {
    const actual: SpeakerView = {
      ...quill,
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    };
    const { rerender } = render(
      <RoomMessage content="근거를 찾았습니다." speaker={actual} time="10:23" type="evidence" />,
    );
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.queryByText(/openai-codex/u)).not.toBeInTheDocument();

    rerender(<RoomHandoff content="검증을 넘깁니다." from={actual} time="10:24" />);
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.queryByText(/openai-codex/u)).not.toBeInTheDocument();
  });

  it("긴 단일-token 모델명은 compact 인계 너비 안에서 줄바꿈한다", () => {
    const modelId = "m".repeat(120);
    render(<RoomHandoff from={{ ...quill, modelId }} time="10:24" to={vega} />);

    const model = screen.getByText(modelId);
    expect(model).toHaveClass("min-w-0", "max-w-full", "[overflow-wrap:anywhere]");
    expect(model.parentElement).toHaveClass("min-w-0");
  });

  it("같은 역할이 병렬로 있어도 이름과 색이 갈린다", () => {
    // scope:"work"로 만들어진 조사 노드 둘. 역할은 같고 handle만 다릅니다.
    const first: SpeakerView = { handle: "research-cohort", name: "Nova", initial: "N", accentSlot: 1, role: "조사" };
    const second: SpeakerView = { handle: "research-pricing", name: "Wren", initial: "W", accentSlot: 6, role: "조사" };

    render(
      <>
        <RoomMessage content="코호트를 뽑았습니다." speaker={first} time="10:23" type="evidence" />
        <RoomMessage content="가격대를 뽑았습니다." speaker={second} time="10:23" type="evidence" />
      </>,
    );

    expect(screen.getAllByText("조사")).toHaveLength(2);
    expect(screen.getByText("Nova")).toBeInTheDocument();
    expect(screen.getByText("Wren")).toBeInTheDocument();
    // 색이 역할이 아니라 정체성에 붙어야 병렬에서 구분됩니다.
    expect(speakerFill(first)).not.toBe(speakerFill(second));
  });

  it("아직 조직에 없는 노드는 채우지 않고 점선으로 표기한다", () => {
    const provisional: SpeakerView = { ...quill, handle: "quant-analysis", provisional: true };
    expect(speakerFill(provisional)).toContain("border-dashed");
    expect(speakerFill(provisional)).not.toContain("bg-agent-");
  });

  it("아바타 줄은 상한을 두되 잘린 사실을 감추지 않는다", () => {
    const many: SpeakerView[] = Array.from({ length: 9 }, (_, index) => ({
      handle: `agent-${String(index)}`,
      name: `Agent${String(index)}`,
      initial: String(index),
      accentSlot: index % 8,
      role: "역할",
    }));

    const { container, rerender } = render(<SpeakerRow limit={3} speakers={many} />);
    // 참가자가 늘어도 폭이 무한히 자라면 안 되고, 남은 인원이 있다는 사실은 보여야 합니다.
    expect(container.textContent).toContain("+6");

    rerender(<SpeakerRow limit={3} speakers={many.slice(0, 3)} />);
    expect(container.textContent).not.toContain("+");
  });

  it("반론은 원본을 인용해서 붙인다", () => {
    render(
      <RoomMessage
        content="분기 간 비교가 성립하지 않습니다."
        quoted={{ author: "Quill", time: "10:23", content: "가격 · 기능 부족 5축" }}
        speaker={iris}
        time="10:24"
        type="challenge"
      />,
    );

    // 반론은 무엇에 대한 반론인지 없이 존재할 수 없습니다.
    const quote = screen.getByText(/가격 · 기능 부족 5축/);
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote).toHaveTextContent("Quill");
    expect(screen.getByText("반론")).toBeInTheDocument();
  });

  it("질문은 수신자를, 답변은 들여쓰기를 가진다", () => {
    const { container, rerender } = render(
      <RoomMessage content="기준이 뭔가요?" recipient="Quill" speaker={vega} time="10:23" type="question" />,
    );
    expect(screen.getByText(/→ Quill/)).toBeInTheDocument();
    expect(container.querySelector("article")?.className).not.toContain("pl-[27px]");

    rerender(<RoomMessage content="5축입니다." indented speaker={quill} time="10:23" type="answer" />);
    expect(container.querySelector("article")?.className).toContain("pl-[27px]");
  });

  it("인계는 넘긴 쪽·내용을 항상 말하고 구조화된 받는 쪽만 표시한다", () => {
    const { container, rerender } = render(
      <RoomHandoff content="검증할 표본과 남은 질문을 넘깁니다." from={quill} time="10:24" to={vega} />,
    );
    const line = screen.getByText(/인계/);
    expect(line).toHaveTextContent("인계 · Quill → Vega · 10:24");
    expect(container.querySelectorAll(".h-px.flex-1")).toHaveLength(0);
    expect(screen.getByText("검증할 표본과 남은 질문을 넘깁니다.")).toBeInTheDocument();

    const longContent = `받는 쪽은 아직 정해지지 않았습니다.\n${"긴문자열".repeat(40)}`;
    rerender(<RoomHandoff content={longContent} from={quill} time="10:25" />);
    expect(screen.getByText(/인계/)).toHaveTextContent("Quill");
    expect(screen.queryByText("Vega")).not.toBeInTheDocument();
    expect(screen.getByText(/받는 쪽은 아직 정해지지 않았습니다/u)).toHaveClass(
      "whitespace-pre-wrap",
      "break-words",
      "[overflow-wrap:anywhere]",
    );
  });

  it("최종 응답은 heading과 GFM 표를 의미 구조로 렌더링한다", () => {
    const { container } = render(
      <RoomMessage
        content={"## 결과\n\n| 항목 | 상태 |\n| --- | --- |\n| 검증 | 통과 |"}
        final
        speaker={atlas}
        time="10:26"
        type="answer"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "결과" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "항목" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "통과" })).toBeInTheDocument();
    const tableRegion = screen.getByRole("region", { name: "최종 응답 표" });
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(tableRegion).toHaveClass("overflow-x-auto");
    expect(tableRegion).toContainElement(container.querySelector("table"));
  });

  it("최종 응답의 raw HTML은 실행하지 않는다", () => {
    const { container } = render(
      <RoomMessage
        content={'<em data-testid="raw-html">실행 금지</em>'}
        final
        speaker={atlas}
        time="10:26"
        type="answer"
      />,
    );

    expect(container.querySelector("[data-testid='raw-html']")).toBeNull();
  });

  it("최종 응답의 위험한 link와 image URL은 안전한 기본 변환으로 제거한다", () => {
    render(
      <RoomMessage
        content={
          "[직접](javascript:alert(1)) [혼합](JaVaScRiPt:alert(1)) [인코딩](jav&#x61;script:alert(1)) ![이미지](data:text/html;base64,PHNjcmlwdD4=)"
        }
        final
        speaker={atlas}
        time="10:26"
        type="answer"
      />,
    );

    for (const name of ["직접", "혼합", "인코딩"]) {
      expect(screen.getByText(name)).not.toHaveAttribute("href");
    }
    expect(screen.getByRole("img", { name: "이미지" })).not.toHaveAttribute("src");
  });

  it("일반 메시지는 Markdown 문법을 기존 plain text로 보존한다", () => {
    render(
      <RoomMessage content={"## 일반 메시지\n\n| 그대로 | 표시 |"} speaker={quill} time="10:26" type="evidence" />,
    );

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/## 일반 메시지/u)).toHaveTextContent("| 그대로 | 표시 |");
  });

  it("조직 변경 제안은 영향과 되돌리기를 버튼보다 먼저 보인다", async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(
      <ProposalActivity
        change={change}
        content="임시 팀을 제안합니다."
        decided={false}
        disabled={false}
        onApprove={onApprove}
        onReject={vi.fn()}
        speaker={atlas}
        time="10:25"
      />,
    );

    const block = screen.getByRole("region", { name: "조직 변경 제안 계량분석 팀" });
    const text = block.textContent ?? "";
    expect(text).toContain("노드 2개 · 참조 3건");
    expect(text).toContain("조직 버전 12 → 13");
    expect(screen.getByText("Revert 가능")).toBeInTheDocument();
    // scope:"work"는 이 업무가 끝나면 사라진다는 사실이 승인 전에 보여야 합니다.
    expect(text).toContain("이 업무에서만");
    expect(text).toContain("자동으로 사라집니다");
    // 도메인 열거값과 규칙 코드는 사람의 말로 나옵니다.
    expect(text).toContain("실행 역할");
    expect(text).toContain("순환 없음");
    expect(text).not.toContain("operator");
    expect(text).not.toContain("cycle");
    // 영향받는 노드도 handle이 아니라 이름으로 말합니다.
    expect(text).not.toContain("delivery-coordination");
    expect(text.indexOf("되돌리기")).toBeLessThan(text.lastIndexOf("승인"));
    // 버튼 문구는 두 단어로 고정입니다. 결과 설명은 카드 본문이 이미 했습니다.
    expect(screen.getByRole("button", { name: "계량분석 팀 신설 승인" })).toHaveTextContent(/^승인$/);

    await user.click(screen.getByRole("button", { name: "계량분석 팀 신설 승인" }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("처리된 제안은 gate 색을 벗는다", () => {
    const { container } = render(
      <ProposalActivity
        change={change}
        content="임시 팀을 제안합니다."
        decided
        disabled={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        speaker={atlas}
        time="10:25"
      />,
    );

    // 노랑은 "지금 사람이 필요함" 전용어이므로 결정이 끝나면 남아 있으면 안 됩니다.
    expect(container.querySelector("section")?.className).not.toContain("bg-gate-wash");
    expect(screen.queryByRole("button", { name: /승인/ })).toBeNull();
  });

  it("적용된 Staffing 카드는 두 노드를 모두 보여주고 추정 정보와 결정 버튼을 숨긴다", () => {
    const appliedChange = {
      nodes: [
        {
          handle: "staff-analysis",
          name: "Wren",
          scope: "work",
          workId: "work-0001",
          parentHandle: "delivery-coordination",
          role: "operator",
          capabilities: ["analysis", "statistics"],
        },
        {
          handle: "staff-review",
          name: "Haven",
          scope: "work",
          workId: "work-0001",
          parentHandle: "assurance",
          role: "coordinator",
          capabilities: ["review"],
        },
      ],
      impactNodes: 3,
      impactReferences: 3,
      impactHandles: ["delivery-coordination", "assurance", "staff-analysis"],
      fromVersion: 12,
      toVersion: 13,
    } as unknown as OrganizationChangeView;
    render(
      <ProposalActivity
        change={appliedChange}
        content="두 개의 Work 전용 Agent를 적용했습니다."
        decided
        disabled={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        speaker={atlas}
        time="10:25"
      />,
    );

    const card = screen.getByRole("region", { name: "조직 변경 제안 Wren 외 1개" });
    expect(card).toHaveTextContent("Wren");
    expect(card).toHaveTextContent("Haven");
    expect(card).toHaveTextContent("analysis · statistics");
    expect(card).toHaveTextContent("review");
    expect(card).toHaveTextContent("노드 3개 · 참조 3건");
    expect(card).toHaveTextContent("조직 버전 12 → 13");
    expect(card).toHaveTextContent("처리됨");
    expect(card).not.toHaveTextContent("조직 검사 통과");
    expect(card).not.toHaveTextContent("Revert");
    expect(card).not.toHaveTextContent("자동으로 사라집니다");
    expect(card.outerHTML).not.toContain("staff-");
    expect(screen.queryByRole("button", { name: /승인|거절/u })).toBeNull();
  });
});
