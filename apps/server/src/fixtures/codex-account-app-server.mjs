import { createInterface } from "node:readline";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length !== 4 ||
  arguments_[0] !== "--config" ||
  arguments_[1] !== 'cli_auth_credentials_store = "file"' ||
  arguments_[2] !== "app-server" ||
  arguments_[3] !== "--stdio"
) {
  process.exit(2);
}

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
  if (initialized && request.method === "account/read" && request.params?.refreshToken === true) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } } })}\n`,
    );
    return;
  }
  if (initialized && request.method === "account/rateLimits/read") {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            individualLimit: null,
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        },
      })}\n`,
    );
    return;
  }
  if (initialized && request.method === "model/list") {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          data: [
            {
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              hidden: false,
              isDefault: true,
              inputModalities: ["text"],
            },
          ],
          nextCursor: null,
        },
      })}\n`,
    );
    return;
  }
  if (initialized && request.method === "account/logout") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    return;
  }
  process.exit(3);
});
