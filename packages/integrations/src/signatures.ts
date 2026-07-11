import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function unixTimestamp(value: string, now: Date): number | undefined {
  if (!/^(?:0|[1-9][0-9]{0,12})$/u.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now.getTime() / 1000) - seconds) > 300) return undefined;
  return seconds;
}

function hex(value: string, bytes: number): Buffer | undefined {
  if (!new RegExp(`^[a-fA-F0-9]{${String(bytes * 2)}}$`, "u").test(value)) return undefined;
  return Buffer.from(value, "hex");
}

function constantEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function signSlackFixture(signingSecret: string, timestamp: string, body: Buffer): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
}

export function verifySlackRequest(input: {
  readonly signingSecret: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly body: Buffer;
  readonly now?: Date;
}): boolean {
  if (
    unixTimestamp(input.timestamp, input.now ?? new Date()) === undefined ||
    !/^v0=[a-fA-F0-9]{64}$/u.test(input.signature)
  )
    return false;
  return constantEqual(
    signSlackFixture(input.signingSecret, input.timestamp, input.body),
    input.signature.toLowerCase(),
  );
}

export function verifyDiscordRequest(input: {
  readonly publicKeyHex: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly body: Buffer;
  readonly now?: Date;
}): boolean {
  if (unixTimestamp(input.timestamp, input.now ?? new Date()) === undefined) return false;
  const rawKey = hex(input.publicKeyHex, 32);
  const signature = hex(input.signature, 64);
  if (!rawKey || !signature) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      type: "spki",
      format: "der",
    });
    return verify(null, Buffer.concat([Buffer.from(input.timestamp), input.body]), publicKey, signature);
  } catch {
    return false;
  }
}

export function signGitHubFixture(webhookSecret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

export function verifyGitHubRequest(input: {
  readonly webhookSecret: string;
  readonly signature: string;
  readonly body: Buffer;
}): boolean {
  if (!/^sha256=[a-fA-F0-9]{64}$/u.test(input.signature)) return false;
  return constantEqual(signGitHubFixture(input.webhookSecret, input.body), input.signature.toLowerCase());
}
