import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (initialized && message.method === "fixture/error") {
    process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {} })}\n`);
    return;
  }
  process.exit(3);
});
