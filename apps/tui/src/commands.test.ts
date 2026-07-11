import { describe, expect, it } from "vitest";

import { TuiCommands } from "./commands.js";

describe("TUI command", () => {
  it("메시지를 인증된 Application command로만 전송한다", async () => {
    const sent: unknown[] = [];
    const commands = new TuiCommands(
      { command: (value) => (sent.push(value), Promise.resolve(value)) },
      () => "user-1",
    );
    await commands.postMessage({ workId: "work-1", roomId: "room-1", content: "검토해 주세요" });
    expect(sent[0]).toMatchObject({
      schemaVersion: "massion.application.v1",
      operation: "collaboration.message.post",
      payload: {
        workId: "work-1",
        roomId: "room-1",
        messageType: "question",
        authorKind: "user",
        authorId: "user-1",
        content: "검토해 주세요",
      },
    });
  });

  it("Work 취소와 Task 배정은 현재 revision을 반드시 전달한다", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const commands = new TuiCommands(
      { command: (value) => (sent.push(value as never), Promise.resolve(value)) },
      () => "user-1",
    );
    await commands.cancelWork({ workId: "work-1", revision: 7 });
    await commands.assignTask({ workId: "work-1", taskId: "task-1", agentHandle: "developer", revision: 8 });
    expect(sent.map(({ operation, expectedRevision }) => ({ operation, expectedRevision }))).toEqual([
      { operation: "work.cancel", expectedRevision: 7 },
      { operation: "task.assign", expectedRevision: 8 },
    ]);
  });

  it("승인 정책을 TUI가 재판단하지 않고 사용자의 명시적 투표만 보낸다", async () => {
    const sent: unknown[] = [];
    const commands = new TuiCommands(
      { command: (value) => (sent.push(value), Promise.resolve(value)) },
      () => "user-1",
    );
    await commands.vote({ approvalId: "approval-1", vote: "approve", reason: "검증 결과 확인" });
    expect(sent[0]).toMatchObject({
      operation: "approval.vote",
      payload: { approvalId: "approval-1", vote: "approve", reason: "검증 결과 확인" },
    });
  });

  it("같은 command key가 진행 중이면 중복 mutation을 보내지 않는다", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const commands = new TuiCommands(
      {
        command: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {};
        },
      },
      () => "user-1",
    );
    const first = commands.cancelExecution("execution-1", "사용자 중단");
    await expect(commands.cancelExecution("execution-1", "사용자 중단")).rejects.toThrow(/진행 중/u);
    release?.();
    await first;
    expect(calls).toBe(1);
  });
});
