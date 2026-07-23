import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./app";
import { createFixtureDesktopService } from "./desktop-service";

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

  it("다른 Work를 선택하면 중앙 제목과 inspector가 함께 바뀐다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    expect(screen.getByRole("main")).toHaveAccessibleName("파트너 계약서 검토");
    expect(screen.getByRole("heading", { name: "파트너 계약서 검토" })).toBeInTheDocument();
    expect(screen.getByText("계약 조항 검증")).toBeInTheDocument();
  });

  it("승인 결정을 반영하고 중복 결정을 막는다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "CRM 고객 데이터 읽기 승인" }));
    expect(screen.getByRole("status")).toHaveTextContent("승인되었습니다");
    expect(screen.queryByRole("button", { name: "CRM 고객 데이터 읽기 승인" })).not.toBeInTheDocument();
  });

  it("전역 메뉴가 여섯 제품 화면으로 전환되고 알림 패널은 현재 화면 위에 열린다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "홈" }));
    expect(await screen.findByRole("main", { name: "홈" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "업무" }));
    expect(screen.getByRole("main", { name: "3분기 고객 이탈 원인 분석" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "조직" }));
    expect(await screen.findByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /알림/ }));
    expect(await screen.findByRole("dialog", { name: "알림" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "알림 닫기" }));
    expect(screen.getByRole("main", { name: "조직" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "개선" }));
    expect(await screen.findByRole("main", { name: "개선" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "확장" }));
    expect(await screen.findByRole("main", { name: "확장" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
  });

  it("지시문은 실행 시점을 선택한 뒤 제출한다", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByRole("textbox", { name: "추가 지시" }), "산업군별 이탈률도 분리해줘");
    await user.click(screen.getByRole("button", { name: "다음 단계에 반영" }));

    expect(screen.getByRole("status")).toHaveTextContent("다음 단계에 반영하도록 예약했습니다");
    expect(screen.getByRole("textbox", { name: "추가 지시" })).toHaveValue("");
  });
});
