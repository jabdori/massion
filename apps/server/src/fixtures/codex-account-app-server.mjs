import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize" && request.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "fixture" } })}\n`);
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (initialized && request.method === "account/read" && request.id === 2 && request.params?.refreshToken === true) {
    process.stdout.write(
      `${JSON.stringify({ id: 2, result: { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } } })}\n`,
    );
    return;
  }
  process.exit(3);
});
