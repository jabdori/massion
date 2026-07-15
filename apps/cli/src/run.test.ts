import { describe, expect, it } from "vitest";

import { runHeadless, type HeadlessApplicationClient } from "./run.js";

function event(sequence: number, type: string, correlationId = "run-correlation-0001") {
  return { sequence, type, correlationId, resource: { type: "ApplicationRun", id: "run-headless-1" }, payload: {} };
}

describe("massion run", () => {
  it("detach는 accepted run만 반환하고 wait는 terminal event까지 재연결한다", async () => {
    let streams = 0;
    const client: HeadlessApplicationClient = {
      command: async () => ({ outcome: "accepted", data: { runId: "run-headless-1" } }),
      async *streamEvents(after = 0) {
        streams += 1;
        if (streams === 1) {
          yield event(after + 1, "run.claimed");
          throw new TypeError("disconnect");
        }
        yield event(after + 1, "run.completed");
      },
    };
    await expect(
      runHeadless(
        client,
        { text: "제품화" },
        { detach: true, commandId: "run-command-0001", correlationId: "run-correlation-0001", reconnectAttempts: 2 },
      ),
    ).resolves.toMatchObject({ type: "accepted", runId: "run-headless-1" });
    await expect(
      runHeadless(
        client,
        { text: "제품화" },
        { detach: false, commandId: "run-command-0002", correlationId: "run-correlation-0001", reconnectAttempts: 2 },
      ),
    ).resolves.toMatchObject({ type: "result", status: "completed", runId: "run-headless-1" });
  });

  it("approval·model blocked를 성공으로 꾸미지 않고 abort는 run.cancel을 전송한다", async () => {
    const commands: Array<{ readonly operation?: unknown }> = [];
    const controller = new AbortController();
    const client: HeadlessApplicationClient = {
      command: async (input) => {
        commands.push(input as { readonly operation?: unknown });
        if (commands.length === 1) queueMicrotask(() => controller.abort());
        return { outcome: "accepted", data: { runId: "run-headless-1" } };
      },
      async *streamEvents() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield event(1, "run.suspended");
      },
    };
    await runHeadless(
      client,
      {},
      {
        detach: false,
        commandId: "run-command-0003",
        correlationId: "run-correlation-0001",
        signal: controller.signal,
      },
    );
    expect(commands.map((command) => command.operation)).toEqual(["run.start", "run.cancel"]);
  });

  it.each([
    ["run.suspended", "awaiting-approval"],
    ["run.blocked", "blocked"],
  ])("%s terminal surface 상태를 %s로 반환한다", async (type, status) => {
    const client: HeadlessApplicationClient = {
      command: async () => ({ outcome: "accepted", data: { runId: "run-headless-1" } }),
      async *streamEvents() {
        yield event(1, type);
      },
    };
    await expect(
      runHeadless(client, {}, { detach: false, commandId: "run-command-0004", correlationId: "run-correlation-0001" }),
    ).resolves.toMatchObject({ type: "result", status });
  });
});
