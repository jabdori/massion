import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(),
  workspaces: [] as unknown[],
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    mutate: testState.mutate,
    refresh: testState.refresh,
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: (_store: unknown, operation: string) =>
    operation === "workspace.list" ? testState.workspaces : undefined,
}));

import WorkspacesPage from "./WorkspacesPage.js";

beforeEach(() => {
  testState.mutate.mockReset().mockResolvedValue({});
  testState.refresh.mockReset().mockResolvedValue(undefined);
  testState.workspaces = [
    {
      workspaceId: "workspace-1",
      name: "shop-api",
      path: "/home/owner/projects/shop-api",
      kind: "local-directory",
      trust: "pending",
      status: "active",
      revision: 0,
    },
  ];
});

afterEach(() => cleanup());

describe("WorkspacesPage", () => {
  it("워크스페이스 목록과 신뢰 상태를 표시하고 신뢰 결정을 command로 보낸다", async () => {
    const user = userEvent.setup();
    render(<WorkspacesPage />);

    expect(screen.getByText("shop-api")).toBeInTheDocument();
    expect(screen.getByText("/home/owner/projects/shop-api")).toBeInTheDocument();
    expect(screen.getByText("확인 필요")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "신뢰" }));

    expect(testState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "workspace.trust",
        expectedRevision: 0,
        payload: { workspaceId: "workspace-1", decision: "trusted" },
      }),
    );
    expect(testState.refresh).toHaveBeenCalledWith("workspace.list", {});
  });

  it("desktop shell 어댑터가 있으면 폴더 선택으로 경로를 채운다", async () => {
    (globalThis as { massionShell?: unknown }).massionShell = {
      pickDirectory: () => Promise.resolve("/home/owner/projects/from-dialog"),
    };
    try {
      const user = userEvent.setup();
      render(<WorkspacesPage />);
      await user.click(screen.getByRole("button", { name: "폴더 선택" }));
      expect(await screen.findByRole("textbox", { name: "워크스페이스 경로" })).toHaveValue(
        "/home/owner/projects/from-dialog",
      );
    } finally {
      delete (globalThis as { massionShell?: unknown }).massionShell;
    }
  });

  it("경로를 입력해 workspace.register command를 보낸다", async () => {
    const user = userEvent.setup();
    render(<WorkspacesPage />);

    await user.type(screen.getByRole("textbox", { name: "워크스페이스 경로" }), "/home/owner/projects/mobile-app");
    await user.click(screen.getByRole("button", { name: "등록" }));

    expect(testState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "workspace.register",
        payload: { path: "/home/owner/projects/mobile-app" },
      }),
    );
  });
});
