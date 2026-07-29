import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { createFixtureDesktopService } from "./desktop-service";
import type { WorkView } from "./model";

function renderApp() {
  return render(<App service={createFixtureDesktopService()} />);
}

describe("AgentOS 데스크톱", () => {
  it("네 개의 독립 영역과 선택한 Work 활동을 표시한다", () => {
    renderApp();

    expect(screen.getByRole("complementary", { name: "전역 탐색" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Work 목록" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAccessibleName("3분기 고객 이탈 원인 분석");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toBeInTheDocument();
    expect(screen.getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
  });

  it("문서가 아니라 각 열만 스크롤하고 composer를 viewport 안에 고정한다", () => {
    renderApp();

    expect(screen.getByTestId("desktop-shell")).toHaveClass("grid-rows-[minmax(0,1fr)]", "overflow-hidden");
    expect(screen.getByRole("complementary", { name: "전역 탐색" })).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("region", { name: "Work 목록" })).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("main")).toHaveClass("min-h-0", "h-full");
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveClass("min-h-0", "overflow-y-auto");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveClass("min-h-0", "h-full");
    expect(screen.getByTestId("directive-composer")).toBeInTheDocument();
  });

  it("검색과 상태 필터로 Work 목록을 좁힌다", async () => {
    const user = userEvent.setup();
    renderApp();
    const list = screen.getByRole("region", { name: "Work 목록" });

    await user.type(within(list).getByRole("searchbox"), "계약서");
    expect(within(list).getByRole("button", { name: /파트너 계약서 검토/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /3분기 고객 이탈 원인 분석/ })).not.toBeInTheDocument();

    await user.clear(within(list).getByRole("searchbox"));
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    expect(await within(list).findByText("완료된 Work가 없습니다.")).toBeInTheDocument();
  });

  it("진행 중 Work가 없어도 완료 탭에서 종료된 Work를 다시 연다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const completed: WorkView = { ...seed, status: "complete" };
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [] },
          loadIndex: async ({ filter }) => (filter === "complete" ? [completed] : []),
          loadWork: async () => completed,
        }}
      />,
    );

    const list = screen.getByRole("region", { name: "Work 목록" });
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    expect(await within(list).findByRole("button", { name: new RegExp(completed.title) })).toBeInTheDocument();
  });

  it("다른 Work를 선택하면 중앙 제목과 inspector가 함께 바뀐다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    expect(screen.getByRole("main")).toHaveAccessibleName("파트너 계약서 검토");
    expect(screen.getByRole("heading", { name: "파트너 계약서 검토" })).toBeInTheDocument();
    expect(screen.getByText("계약 조항 검증")).toBeInTheDocument();
  });

  it("막힌 Work의 실행 단계와 오류를 중앙 대화에 표시하고 재개를 제공한다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const seed = fixture.initialSnapshot?.works[0];
    if (!seed) throw new Error("fixture Work가 필요합니다.");
    const blocked: WorkView = {
      ...seed,
      id: "work-context-strategy-failed",
      title: "전략 계획이 멈춘 업무",
      run: {
        runId: "run-context-strategy-failed",
        status: "blocked",
        stage: "context-strategy",
        leaseGeneration: 2,
        blockedReason: "strategy-failed",
      },
    };
    const resumeRun = vi.fn(async () => undefined);
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
          resumeRun,
        }}
      />,
    );

    // 멈춤은 스트림 안에 놓이고 재시도가 원인 바로 옆에 붙습니다.
    const status = screen.getByRole("status", { name: "실행 상태" });
    expect(status).toHaveTextContent("Provider가 전략 계획의 구조화 응답을 완성하지 못했습니다.");
    expect(status).toHaveTextContent("맥락·전략 구성에서 멈춤");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });

  it("승인 결정을 반영하고 중복 결정을 막는다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "CRM 고객 데이터 읽기 승인" }));
    expect(screen.getByRole("status")).toHaveTextContent("승인되었습니다");
    expect(screen.queryByRole("button", { name: "CRM 고객 데이터 읽기 승인" })).not.toBeInTheDocument();
  });

  it("전역 메뉴가 여섯 제품 화면으로 전환되고 수신함 패널은 현재 화면 위에 열린다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "홈" }));
    expect(await screen.findByRole("main", { name: "홈" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "업무" }));
    expect(screen.getByRole("main", { name: "3분기 고객 이탈 원인 분석" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "조직" }));
    expect(await screen.findByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /수신함/ }));
    expect(await screen.findByRole("dialog", { name: "수신함" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "수신함 닫기" }));
    expect(screen.getByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "개선" }));
    expect(await screen.findByRole("main", { name: "개선" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "확장" }));
    expect(await screen.findByRole("main", { name: "확장" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
  });

  // 반영 시점은 보내기 «전»이 아니라 «후»에 고릅니다. 보낸 지시는 인풋 위에 카드로 섭니다.
  it("보낸 지시는 대기 카드로 서고 거기서 현재 작업에 반영한다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByRole("textbox", { name: "추가 지시" }), "산업군별 이탈률도 분리해줘");
    await user.click(screen.getByRole("button", { name: "보내기" }));

    expect(screen.getByRole("status")).toHaveTextContent("다음 단계에 반영하도록 예약했습니다");
    expect(screen.getByRole("textbox", { name: "추가 지시" })).toHaveValue("");
    expect(screen.getByText("산업군별 이탈률도 분리해줘")).toBeInTheDocument();

    const cards = screen.getAllByRole("button", { name: /현재 작업 조정/ });
    await user.click(cards[cards.length - 1] as HTMLElement);
    expect(screen.getByRole("status")).toHaveTextContent("안전한 실행 경계에서 지금 반영합니다");
  });
});
