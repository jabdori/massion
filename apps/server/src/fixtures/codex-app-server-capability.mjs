import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id === 1) {
    if (message.params?.capabilities?.experimentalApi !== true) process.exit(4);
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "capability-fixture" } })}\n`);
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (initialized && message.method === "fixture/capability" && typeof message.id === "number") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { status: "experimental-enabled" } })}\n`);
    return;
  }
  process.exit(3);
});
