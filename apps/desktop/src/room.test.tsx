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
    expect(screen.getByText(/받는 쪽은 아직 정해지지 않았습니다/u).parentElement).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]",
    );
  });

  it("인계 본문은 compact 배치를 유지하면서 Agent Markdown 의미를 렌더링한다", () => {
    render(<RoomHandoff content={"### 다음 단계\n\n- 표본 검증\n- 결과 보고"} from={quill} time="10:24" to={vega} />);

    expect(screen.getByRole("heading", { level: 3, name: "다음 단계" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["표본 검증", "결과 보고"]);
  });

  it("일반 Agent 발언도 heading, list, GFM 표를 의미 구조로 렌더링한다", () => {
    render(
      <RoomMessage
        content={"## 조사 결과\n\n- 근거 확인\n- 반론 검토\n\n| 항목 | 상태 |\n| --- | --- |\n| 조사 | 완료 |"}
        speaker={quill}
        time="10:25"
        type="evidence"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "조사 결과" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["근거 확인", "반론 검토"]);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "협업 메시지 표" })).toHaveAttribute("tabindex", "0");
  });

  it("3열 GFM 표는 첫 열을 가로로 유지하고 표 영역에서 스크롤한다", () => {
    render(
      <RoomMessage
        content={
          "| 확인 항목 | 유효 조건 | 미충족 시 영향과 판단 |\n| --- | --- | --- |\n| 독립 관측 | 사용자 단위로 한 번만 집계 | 동일 사용자의 반복 집계가 있으면 표준오차가 과소평가됩니다. |"
        }
        speaker={quill}
        time="10:25"
        type="evidence"
      />,
    );

    expect(screen.getByRole("region", { name: "협업 메시지 표" })).toHaveClass("overflow-x-auto");
    expect(screen.getByRole("table")).toHaveClass(
      "min-w-[36rem]",
      "[&_tr>*:first-child]:min-w-16",
      "[&_tr>*:first-child]:whitespace-nowrap",
    );
  });

  it("닫는 punctuation 바로 뒤에 조사가 와도 Agent 강조를 strong 의미 구조로 렌더링한다", () => {
    const { container } = render(
      <RoomMessage
        content="사업팀은 **최소 사업 허용 효과(MBE)**를 정한다"
        speaker={quill}
        time="10:25"
        type="evidence"
      />,
    );

    expect(screen.getByText("최소 사업 허용 효과(MBE)", { selector: "strong" })).toBeInTheDocument();
    expect(container).toHaveTextContent("사업팀은 최소 사업 허용 효과(MBE)를 정한다");
    expect(container).not.toHaveTextContent("**");
  });

  it("공백 뒤 조사가 오는 표준 strong 강조는 기존 의미를 유지한다", () => {
    render(<RoomMessage content="**한국어** 조사" speaker={quill} time="10:25" type="evidence" />);

    expect(screen.getByText("한국어", { selector: "strong" })).toBeInTheDocument();
  });

  it("escape된 marker와 inline·fenced code 안의 marker는 literal로 유지한다", () => {
    const marked = "**최소 사업 허용 효과(MBE)**를";
    const content = [`\\${marked}`, "", `inline \`${marked}\``, "", "```text", marked, "```"].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector("strong")).toBeNull();
    expect(container).toHaveTextContent(marked);
    expect([...container.querySelectorAll("code")].map((code) => code.textContent)).toEqual([marked, `${marked}\n`]);
  });

  it("MathJax inline delimiter를 KaTeX 수식으로 렌더링한다", () => {
    const { container } = render(
      <RoomMessage content={String.raw`유의수준은 \(p < 0.05\)입니다.`} speaker={quill} time="10:25" type="evidence" />,
    );

    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("MathJax multiline delimiter와 fraction을 KaTeX display 수식으로 렌더링한다", () => {
    const content = ["\\[", String.raw`\frac{13-10}{10}=30\%`, "\\]"].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex-display")).toBeInTheDocument();
    expect(
      [...container.querySelectorAll("*")]
        .filter((element) => element.closest(".katex") === null)
        .flatMap((element) => [...element.childNodes])
        .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("\\frac")),
    ).toBe(false);
  });

  it("inline code와 fenced code 안의 수식 delimiter는 literal로 유지한다", () => {
    const content = [
      "inline `\\(p < 0.05\\)`",
      "",
      "```text",
      "\\[",
      String.raw`\frac{13-10}{10}=30\%`,
      "\\]",
      "```",
    ].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex")).toBeNull();
    expect([...container.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      String.raw`\(p < 0.05\)`,
      ["\\[", String.raw`\frac{13-10}{10}=30\%`, "\\]", ""].join("\n"),
    ]);
  });

  it("달러 통화 범위는 inline math로 오인하지 않는다", () => {
    const { container } = render(<RoomMessage content="$7M to $40M" speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("$7M to $40M")).toBeInTheDocument();
  });

  it("신뢰할 수 없는 KaTeX href 명령은 link를 만들지 않는다", () => {
    const { container } = render(
      <RoomMessage
        content={String.raw`\(\href{javascript:alert(1)}{x}\)`}
        speaker={quill}
        time="10:25"
        type="evidence"
      />,
    );

    expect(container.querySelector("a, [href]")).toBeNull();
  });

  it("잘못된 수식은 앱을 중단하지 않고 원문 fallback을 표시한다", () => {
    const { container } = render(
      <RoomMessage content={String.raw`\(\frac{1}{\)`} speaker={quill} time="10:25" type="evidence" />,
    );

    expect(container.querySelector(".katex-error")).toHaveTextContent(String.raw`\frac{1}{`);
  });

  it("짝이 없는 MathJax 여는·닫는 delimiter는 각각 literal로 유지한다", () => {
    const { container, rerender } = render(
      <RoomMessage content={String.raw`open \(p < 0.05`} speaker={quill} time="10:25" type="evidence" />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container).toHaveTextContent("open (p < 0.05");

    rerender(<RoomMessage content={String.raw`close p < 0.05\)`} speaker={quill} time="10:25" type="evidence" />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container).toHaveTextContent("close p < 0.05)");
  });

  it("여러 줄 inline code 안의 delimiter는 exact literal로 유지한다", () => {
    const content = ["``first", String.raw`\(p < 0.05\)`, "last``"].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code")).toHaveTextContent(String.raw`first \(p < 0.05\) last`);
  });

  it("더 긴 backtick run은 짧은 opener를 닫지 않고 전체 inline code를 literal로 유지한다", () => {
    const { container } = render(
      <RoomMessage content={"``a ``` \\(x\\) b``"} speaker={quill} time="10:25" type="evidence" />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code")).toHaveTextContent("a ``` \\(x\\) b");
  });

  it("backtick이 든 잘못된 fence info 뒤의 수식은 정상 렌더링한다", () => {
    const content = ["```bad`info", "", String.raw`\(x\)`].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("delimiter 앞 연속 backslash 2·3·4개의 escape parity를 지킨다", () => {
    const content = String.raw`two \\(two\\), three \\\(three\\\), four \\\\(four\\\\)`;
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    const katex = container.querySelector(".katex");
    const paragraph = katex?.closest("p");
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(paragraph?.childNodes[0]?.textContent).toBe("two \\(two\\), three \\");
    expect(paragraph?.childNodes[paragraph.childNodes.length - 1]?.textContent).toBe(", four \\\\(four\\\\)");
  });

  it("EOF까지 닫히지 않은 valid fence 안의 delimiter는 exact literal로 유지한다", () => {
    const content = ["```text", String.raw`\(p < 0.05\)`].join("\n");
    const { container } = render(<RoomMessage content={content} speaker={quill} time="10:25" type="evidence" />);

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code")).toHaveTextContent(String.raw`\(p < 0.05\)`);
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
    const tableRegion = screen.getByRole("region", { name: "협업 메시지 표" });
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

  it("일반 Agent 발언도 위험한 link·image URL과 raw HTML을 차단한다", () => {
    const { container } = render(
      <RoomMessage
        content={
          '<em data-testid="raw-html">실행 금지</em> [직접](javascript:alert(1)) [혼합](JaVaScRiPt:alert(1)) [인코딩](jav&#x61;script:alert(1)) ![이미지](data:text/html;base64,PHNjcmlwdD4=)'
        }
        speaker={atlas}
        time="10:26"
        type="answer"
      />,
    );

    for (const name of ["직접", "혼합", "인코딩"]) {
      expect(screen.getByText(name)).not.toHaveAttribute("href");
    }
    expect(screen.getByRole("img", { name: "이미지" })).not.toHaveAttribute("src");
    expect(container.querySelector("[data-testid='raw-html']")).toBeNull();
  });

  it("사용자 메시지는 Markdown을 해석하지 않고 줄바꿈을 보존한다", () => {
    const content = "## 사용자 입력\n\n- 그대로 표시";
    const me: SpeakerView = {
      handle: "owner-1",
      name: "나",
      initial: "나",
      accentSlot: -1,
      role: "사람",
      human: true,
    };
    render(<RoomMessage content={content} speaker={me} time="10:26" type="question" />);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText(/## 사용자 입력/u)).toHaveClass("whitespace-pre-wrap");
    expect(screen.getByText(/## 사용자 입력/u).textContent).toBe(content);
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
