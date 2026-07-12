import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);
if (process.env.CODEX_HOME !== "/tmp/massion-profile" || process.env.HOME !== "/tmp/massion-profile") process.exit(3);

let initialized = false;
let turnStarted = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "agent-fixture" } })}\n`);
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (initialized && message.method === "thread/start") {
    const params = message.params;
    if (
      params?.model !== "gpt-5.6-codex" ||
      params?.cwd !== "/tmp/massion-workspace" ||
      params?.approvalPolicy !== "on-request" ||
      params?.sandbox !== "workspace-write"
    )
      process.exit(4);
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thread-fixture" } } })}\n`);
    return;
  }
  if (initialized && message.method === "turn/start") {
    const params = message.params;
    if (
      params?.threadId !== "thread-fixture" ||
      params?.input?.[0]?.text !== "상태를 확인하고 필요한 파일을 고치세요" ||
      params?.sandboxPolicy?.type !== "workspaceWrite" ||
      params?.sandboxPolicy?.networkAccess !== false
    )
      process.exit(5);
    turnStarted = true;
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn-fixture" } } })}\n`);
    process.stdout.write(
      `${JSON.stringify({
        id: "approval-fixture",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-fixture",
          turnId: "turn-fixture",
          itemId: "command-fixture",
          startedAtMs: 1_000,
          command: "git status --short",
          cwd: "/tmp/massion-workspace",
        },
      })}\n`,
    );
    return;
  }
  if (turnStarted && message.id === "approval-fixture" && message.result?.decision === "accept") {
    process.stdout.write(
      `${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-fixture",
          turnId: "turn-fixture",
          completedAtMs: 2_000,
          item: { type: "agentMessage", id: "message-fixture", text: "실제 transport 완료", phase: "final_answer" },
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed", error: null } },
      })}\n`,
    );
    return;
  }
  process.exit(6);
});
