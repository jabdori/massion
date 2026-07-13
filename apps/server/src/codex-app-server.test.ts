import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { openCodexAppServer, withCodexAppServer, type CodexAppServerInboundRequest } from "./codex-app-server.js";

describe("Codex app-server JSON-RPC transport", () => {
  it("runtime workspace root capability를 initialize에서 선언한다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-capability.mjs", import.meta.url));

    await expect(
      withCodexAppServer(
        process.execPath,
        [fixturePath],
        { CODEX_HOME: "/isolated/profile" },
        async (session) => await session.request("fixture/capability"),
      ),
    ).resolves.toEqual({ status: "experimental-enabled" });
  });

  it("client request와 server 승인 request를 request ID 계보로 multiplex한다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-multiplex.mjs", import.meta.url));
    const approval = vi.fn(async (request: CodexAppServerInboundRequest) => {
      expect(request).toEqual({
        id: "approval-request-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: ["git", "status", "--short"],
        },
      });
      return { decision: "accept" };
    });

    await expect(
      withCodexAppServer(
        process.execPath,
        [fixturePath],
        { CODEX_HOME: "/isolated/profile" },
        async (session) => await session.request("fixture/multiplex", { executionId: "execution-1" }),
        {
          requestHandlers: {
            "item/commandExecution/requestApproval": approval,
          },
        },
      ),
    ).resolves.toEqual({ status: "approved-and-completed" });
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it("승인 대기 중 연결을 유지하고 명시적 재개 뒤 종료한다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-lifecycle.mjs", import.meta.url));
    let releaseApproval: (() => void) | undefined;
    const approvalObserved = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let resumeApproval: (() => void) | undefined;
    const approvalGate = new Promise<void>((resolve) => {
      resumeApproval = resolve;
    });
    const connection = await openCodexAppServer(
      process.execPath,
      [fixturePath],
      { CODEX_HOME: "/isolated/profile" },
      {
        requestHandlers: {
          "item/fileChange/requestApproval": async () => {
            releaseApproval?.();
            await approvalGate;
            return { decision: "accept" };
          },
        },
      },
    );

    const operation = connection.request("fixture/begin", { executionId: "execution-1" });
    await approvalObserved;
    expect(connection.closed).toBe(false);
    resumeApproval?.();
    await expect(operation).resolves.toEqual({ status: "resumed" });
    await connection.close();
    expect(connection.closed).toBe(true);
  });

  it("notification handler의 동기 오류를 process 예외 대신 RPC 실패로 닫는다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-notification-error.mjs", import.meta.url));

    await expect(
      withCodexAppServer(
        process.execPath,
        [fixturePath],
        { CODEX_HOME: "/isolated/profile" },
        async (session) => await session.request("fixture/error"),
        {
          onNotification: () => {
            throw new Error("private notification detail");
          },
        },
      ),
    ).rejects.toThrow("notification 처리에 실패했습니다");
  });
});
