import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

let initialized = false;
let pendingClientRequestId;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "multiplex-fixture" } })}\n`);
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (initialized && message.method === "fixture/multiplex" && typeof message.id === "number") {
    pendingClientRequestId = message.id;
    process.stdout.write(
      `${JSON.stringify({
        id: "approval-request-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: ["git", "status", "--short"],
        },
      })}\n`,
    );
    return;
  }
  if (message.id === "approval-request-1" && message.result?.decision === "accept") {
    process.stdout.write(
      `${JSON.stringify({ id: pendingClientRequestId, result: { status: "approved-and-completed" } })}\n`,
    );
    return;
  }
  process.exit(3);
});
