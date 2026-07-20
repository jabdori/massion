import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));

import { CommandPalette, WEB_PALETTE_ACTIONS, WEB_PALETTE_ITEMS } from "./CommandPalette.js";

afterEach(() => {
  cleanup();
  testState.navigate.mockReset();
});

describe("CommandPalette", () => {
  it("palette parity: web surface 계약 항목마다 실행 action이 존재한다", () => {
    for (const item of WEB_PALETTE_ITEMS) {
      expect(WEB_PALETTE_ACTIONS[item.id], `팔레트 항목 ${item.id}에 web action이 없습니다`).toBeDefined();
    }
  });

  it("Ctrl+K로 열고 질의로 거른 항목을 Enter로 실행한다", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "명령 팔레트" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "명령 검색" }), "구독");
    expect(screen.getByText("구독 화면 열기")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/subscriptions" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("위험 항목은 ⚠ 표시를 포함한다", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("textbox", { name: "명령 검색" }), "취소");
    expect(screen.getByText(/⚠/u)).toBeInTheDocument();
  });
});
