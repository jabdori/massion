import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    mutate: testState.mutate,
    refresh: testState.refresh,
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: () => testState.data,
}));

import ApprovalsPage from "./ApprovalsPage.js";

beforeEach(() => {
  testState.mutate.mockReset().mockResolvedValue({ outcome: "succeeded" });
  testState.refresh.mockReset().mockResolvedValue([]);
  testState.data = [
    {
      approvalId: "approval-command",
      action: "tool.call",
      status: "pending",
      requestedBy: "software-development",
      expiresAt: "2026-07-13T03:00:00.000Z",
      displayPreview: {
        kind: "command",
        title: "명령 실행",
        executable: "curl",
        arguments: ["--token", "[민감값 제거]", "https://example.com/status"],
        cwd: "/workspace/project",
        reason: "상태 확인",
      },
      rawInput: { token: "web-secret-never-render" },
    },
    {
      approvalId: "approval-file",
      action: "tool.call",
      status: "pending",
      requestedBy: "software-development",
      expiresAt: "2026-07-13T03:00:00.000Z",
      displayPreview: {
        kind: "file-change",
        title: "파일 변경",
        path: "/workspace/src/index.ts",
        summary: "검증 로직 변경",
      },
      content: "file-content-never-render",
      diff: "raw-diff-never-render",
    },
    {
      approvalId: "approval-provider",
      action: "tool.call",
      status: "pending",
      requestedBy: "research",
      expiresAt: "2026-07-13T03:00:00.000Z",
      displayPreview: {
        kind: "provider",
        title: "제공자 권한 확인",
        reason: "외부 검색 사용",
      },
    },
  ];
});

afterEach(() => cleanup());

describe("ApprovalsPage", () => {
  it("승인 전에 명령·파일 변경·제공자 이유의 비밀 제거 미리보기를 표시한다", () => {
    const { container } = render(<ApprovalsPage />);

    expect(screen.getByRole("heading", { name: "명령 실행" })).toBeInTheDocument();
    expect(screen.getByText("curl")).toBeInTheDocument();
    expect(screen.getByText("--token [민감값 제거] https://example.com/status")).toBeInTheDocument();
    expect(screen.getByText("/workspace/project")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "파일 변경" })).toBeInTheDocument();
    expect(screen.getByText("/workspace/src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("검증 로직 변경")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "제공자 권한 확인" })).toBeInTheDocument();
    expect(screen.getByText("외부 검색 사용")).toBeInTheDocument();
    for (const forbidden of ["web-secret-never-render", "file-content-never-render", "raw-diff-never-render"]) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });
});
