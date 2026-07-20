import type { ReactNode } from "react";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
  run: undefined as unknown,
  runPayload: undefined as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => testState.navigate,
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    mutate: testState.mutate,
    getSnapshot: () => ({ cursor: 7 }),
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: (_store: unknown, operation: string, payload?: unknown) => {
    if (operation === "work.list") return [];
    if (operation === "governance.approval.list") return [];
    if (operation === "organization.graph.snapshot") return { nodes: [], executions: [] };
    if (operation === "run.get") {
      testState.runPayload = payload;
      return testState.run;
    }
    return undefined;
  },
}));

import OverviewPage from "./OverviewPage.js";

beforeEach(() => {
  testState.mutate.mockReset().mockResolvedValue({ data: { runId: "run-web-0001" } });
  testState.navigate.mockReset();
  testState.run = { runId: "run-web-0001", stage: "intake", status: "running" };
  testState.runPayload = undefined;
});

afterEach(() => cleanup());

describe("OverviewPage", () => {
  it("요청 입력 후 계획 미리보기를 보여주고, 확인하면 업무를 시작한다", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<OverviewPage />);
    const request = "경쟁사 동향을 조사해서 보고서로 만들어줘";

    // 1단계: 요청 입력
    await user.type(screen.getByRole("textbox", { name: "새 업무 요청" }), request);
    await user.click(screen.getByRole("button", { name: "업무 시작" }));

    // 계획 미리보기 카드가 표시되고, run.start는 아직 호출되지 않음
    await waitFor(() => expect(screen.getByText("제가 이렇게 진행할게요")).toBeInTheDocument());
    expect(testState.mutate).not.toHaveBeenCalled();

    // 2단계: 시작하기 클릭 → run.start 호출
    await user.click(screen.getByRole("button", { name: "시작하기" }));

    await waitFor(() =>
      expect(testState.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "run.start",
          payload: { request: { text: request, surface: "web" } },
        }),
      ),
    );
    expect(screen.getByRole("textbox", { name: "새 업무 요청" })).toHaveValue("");
    expect(screen.getByText("진행 중이에요")).toBeInTheDocument();
    expect(screen.getByText(/요청 이해/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(request);
    expect(testState.runPayload).toEqual({ runId: "run-web-0001" });

    testState.run = { runId: "run-web-0001", stage: "context", status: "running", workId: "work-web-0001" };
    rerender(<OverviewPage />);

    await waitFor(() =>
      expect(testState.navigate).toHaveBeenCalledWith({
        to: "/works/$workId",
        params: { workId: "work-web-0001" },
      }),
    );
  });

  it("계획 미리보기에서 수정을 누르면 입력으로 돌아간다", async () => {
    const user = userEvent.setup();
    render(<OverviewPage />);

    await user.type(screen.getByRole("textbox", { name: "새 업무 요청" }), "테스트 요청");
    await user.click(screen.getByRole("button", { name: "업무 시작" }));

    expect(screen.getByText("제가 이렇게 진행할게요")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "수정" }));

    expect(screen.queryByText("제가 이렇게 진행할게요")).not.toBeInTheDocument();
    expect(testState.mutate).not.toHaveBeenCalled();
  });

  it("업무 시작 실패에서는 내부 오류 원문을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const internalError = "provider-token-never-render를 포함한 내부 오류";
    testState.mutate.mockRejectedValueOnce(new Error(internalError));
    render(<OverviewPage />);

    await user.type(screen.getByRole("textbox", { name: "새 업무 요청" }), "제품 출시 준비");
    await user.click(screen.getByRole("button", { name: "업무 시작" }));
    await user.click(screen.getByRole("button", { name: "시작하기" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("업무를 시작하지 못했습니다."));
    expect(screen.getByRole("status")).not.toHaveTextContent(internalError);
  });
});
