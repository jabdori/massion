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
  handle: "quant-analysis",
  name: "계량분석 팀",
  scope: "work",
  parentHandle: "delivery-coordination",
  role: "operator",
  capabilities: ["코호트 정규화", "유의성 검정"],
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

  it("인계는 넘긴 쪽과 받는 쪽을 모두 이름으로 말한다", () => {
    render(<RoomHandoff from={quill} time="10:24" to={vega} />);
    const line = screen.getByText(/인계/);
    expect(line).toHaveTextContent("Quill");
    expect(line).toHaveTextContent("Vega");
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
    expect(text).toContain("Revert 가능");
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
});
