import { readFileSync } from "node:fs";

import { validateExtensionManifest } from "@massion/extension-sdk";
import { describe, expect, it } from "vitest";

import { invokeSlack } from "./connector.js";

describe("Slack 공식 Extension", () => {
  it("manifest와 최소 권한을 검증한다", () => {
    const manifest = validateExtensionManifest(
      JSON.parse(readFileSync(new URL("../massion.extension.json", import.meta.url), "utf8")) as unknown,
    );
    expect(manifest.name).toBe("@massion-ext/slack");
    expect(manifest.contributions.surfaceConnectors).toHaveLength(1);
    expect(manifest.permissions.network.map((entry) => entry.origin)).toEqual(["https://slack.com"]);
  });

  it("slash command와 button action을 bounded Application action으로 정규화한다", async () => {
    await expect(
      invokeSlack("surfaceConnectors:slack", {
        kind: "command",
        userId: "U01",
        channelId: "C01",
        text: "work create 결제 오류 조사",
      }),
    ).resolves.toEqual({
      kind: "application-command",
      operation: "work.create",
      actorExternalId: "U01",
      destination: "C01",
      arguments: { request: "결제 오류 조사" },
    });
    await expect(
      invokeSlack("surfaceConnectors:slack", {
        kind: "interaction",
        userId: "U01",
        channelId: "C01",
        actionId: "approval:abc12345:approve",
      }),
    ).resolves.toEqual({
      kind: "application-command",
      operation: "approval.decide",
      actorExternalId: "U01",
      destination: "C01",
      arguments: { handle: "abc12345", decision: "approve" },
    });
  });

  it("알 수 없는 명령·과도한 입력·mention을 거부한다", async () => {
    await expect(
      invokeSlack("surfaceConnectors:slack", { kind: "command", userId: "U01", channelId: "C01", text: "admin raw" }),
    ).rejects.toThrow("지원하지");
    await expect(
      invokeSlack("surfaceConnectors:slack", {
        kind: "command",
        userId: "U01",
        channelId: "C01",
        text: `work create ${"a".repeat(4001)}`,
      }),
    ).rejects.toThrow("상한");
    await expect(
      invokeSlack("eventConsumers:slack-notification", { destination: "C01", text: "<@U01> 완료" }),
    ).rejects.toThrow("mention");
  });
});
