import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { invokeDiscord } from "./connector.js";
const protocol = "massion.extension.rpc.v1";
const contributions = ["eventConsumers:discord-notification", "surfaceConnectors:discord"];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const manifestDigest = createHash("sha256")
  .update(canonical(JSON.parse(readFileSync("massion.extension.json", "utf8")) as unknown))
  .digest("hex");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let ready = false;
for await (const line of lines) {
  const frame = JSON.parse(line) as {
    protocol: string;
    requestId: string;
    sequence: number;
    operation: string;
    payload: Record<string, unknown>;
  };
  if (frame.protocol !== protocol || !Number.isSafeInteger(frame.sequence))
    throw new Error("Discord worker RPC frame이 유효하지 않습니다");
  let operation: string;
  let payload: unknown;
  if (frame.operation === "host.handshake") {
    ready = true;
    operation = "worker.handshake";
    payload = { nonce: frame.payload.nonce, manifestDigest, sdkVersion: "1.0.0", contributions };
  } else if (!ready) throw new Error("Discord worker handshake가 필요합니다");
  else if (frame.operation === "health.check") {
    operation = "health.result";
    payload = { status: "healthy" };
  } else if (frame.operation === "contribution.invoke") {
    operation = "contribution.result";
    payload = await invokeDiscord(String(frame.payload.contribution), frame.payload.input);
  } else if (frame.operation === "host.stop") {
    operation = "worker.stopped";
    payload = {};
  } else throw new Error("지원하지 않는 Discord worker operation입니다");
  process.stdout.write(
    `${JSON.stringify({ protocol, requestId: frame.requestId, sequence: frame.sequence, operation, payload })}\n`,
  );
  if (frame.operation === "host.stop") break;
}
