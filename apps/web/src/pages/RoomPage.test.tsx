import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  messages: [] as unknown[],
  messagesPayload: undefined as unknown,
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ roomId: "room-active" }),
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    mutate: testState.mutate,
    refresh: testState.refresh,
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: (_store: unknown, operation: string, payload?: unknown) => {
    if (operation === "organization.graph.snapshot") {
      return {
        rooms: [
          {
            roomId: "room-active",
            workId: "work-active",
            name: "제품 협업방",
            status: "active",
            participantIds: ["user-active", "representative"],
          },
        ],
      };
    }
    if (operation === "identity.me") return { userId: "user-active" };
    if (operation === "work.messages") {
      testState.messagesPayload = payload;
      return testState.messages;
    }
    return undefined;
  },
}));

import RoomPage from "./RoomPage.js";

beforeEach(() => {
  testState.messages = [
    {
      messageId: "message-user",
      sequence: 1,
      authorKind: "user",
      authorId: "user-active",
      content: "첫 번째 요청",
      createdAt: "2026-07-20T00:00:00.000Z",
    },
  ];
  testState.messagesPayload = undefined;
  testState.mutate.mockReset().mockResolvedValue({ outcome: "succeeded" });
  testState.refresh.mockReset().mockResolvedValue(testState.messages);
});

afterEach(() => cleanup());

describe("RoomPage", () => {
  it("공통 메시지 조회를 표시하고 전송 뒤 별도 수동 조회 없이 최신 메시지를 반영한다", async () => {
    const user = userEvent.setup();
    const rendered = render(<RoomPage />);

    expect(screen.getByText("첫 번째 요청")).toBeInTheDocument();
    expect(testState.messagesPayload).toEqual({ workId: "work-active", roomId: "room-active" });
    expect(testState.refresh).not.toHaveBeenCalled();

    testState.messages = [
      ...testState.messages,
      {
        messageId: "message-agent",
        sequence: 2,
        authorKind: "agent",
        authorId: "representative",
        content: "에이전트가 협업방에 남긴 최신 메시지",
        createdAt: "2026-07-20T00:01:00.000Z",
      },
    ];
    rendered.rerender(<RoomPage />);

    expect(screen.getByText("에이전트가 협업방에 남긴 최신 메시지")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "협업방에 말하기" }), "사용자 후속 질문");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    await waitFor(() =>
      expect(testState.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "collaboration.message.post",
          payload: expect.objectContaining({
            workId: "work-active",
            roomId: "room-active",
            messageType: "question",
            authorId: "user-active",
            content: "사용자 후속 질문",
          }),
        }),
      ),
    );
    expect(testState.refresh).not.toHaveBeenCalled();
  });
});
