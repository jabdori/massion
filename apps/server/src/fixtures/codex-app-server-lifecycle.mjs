import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

let initialized = false;
let pendingClientRequestId;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "lifecycle-fixture" } })}\n`);
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (initialized && message.method === "fixture/begin" && typeof message.id === "number") {
    pendingClientRequestId = message.id;
    process.stdout.write(
      `${JSON.stringify({
        id: "approval-lifecycle-1",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", reason: "workspace write" },
      })}\n`,
    );
    return;
  }
  if (message.id === "approval-lifecycle-1" && message.result?.decision === "accept") {
    process.stdout.write(`${JSON.stringify({ id: pendingClientRequestId, result: { status: "resumed" } })}\n`);
    return;
  }
  process.exit(3);
});
