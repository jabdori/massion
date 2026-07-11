import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signGitHubFixture,
  signSlackFixture,
  verifyDiscordRequest,
  verifyGitHubRequest,
  verifySlackRequest,
} from "./signatures.js";

const now = new Date("2026-07-11T00:00:00.000Z");

describe("외부 Surface 요청 서명", () => {
  it("Slack raw body와 5분 timestamp를 HMAC-SHA256으로 검증한다", () => {
    const body = Buffer.from('{"event_id":"Ev01"}');
    const timestamp = String(now.getTime() / 1000);
    const signature = signSlackFixture("signing-secret", timestamp, body);
    expect(verifySlackRequest({ signingSecret: "signing-secret", timestamp, signature, body, now })).toBe(true);
    expect(
      verifySlackRequest({ signingSecret: "signing-secret", timestamp, signature, body: Buffer.from("{}"), now }),
    ).toBe(false);
    expect(
      verifySlackRequest({
        signingSecret: "signing-secret",
        timestamp: String(now.getTime() / 1000 - 301),
        signature,
        body,
        now,
      }),
    ).toBe(false);
  });

  it("Discord Ed25519 raw body·timestamp 서명을 검증한다", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = Buffer.from('{"type":1}');
    const timestamp = String(now.getTime() / 1000);
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString("hex");
    const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    expect(verifyDiscordRequest({ publicKeyHex, timestamp, signature, body, now })).toBe(true);
    expect(verifyDiscordRequest({ publicKeyHex, timestamp, signature: "00".repeat(64), body, now })).toBe(false);
  });

  it("GitHub X-Hub-Signature-256을 검증하고 SHA-1 형식은 거부한다", () => {
    const body = Buffer.from('{"zen":"Keep it logically awesome."}');
    const signature = signGitHubFixture("webhook-secret", body);
    expect(verifyGitHubRequest({ webhookSecret: "webhook-secret", signature, body })).toBe(true);
    expect(
      verifyGitHubRequest({ webhookSecret: "webhook-secret", signature: signature.replace("sha256", "sha1"), body }),
    ).toBe(false);
  });

  it("비정상 hex·timestamp 입력은 예외 없이 거부한다", () => {
    expect(
      verifySlackRequest({ signingSecret: "secret", timestamp: "1e3", signature: "v0=no", body: Buffer.alloc(0), now }),
    ).toBe(false);
    expect(
      verifyDiscordRequest({ publicKeyHex: "zz", timestamp: "0", signature: "zz", body: Buffer.alloc(0), now }),
    ).toBe(false);
  });
});
