import { readFileSync } from "node:fs";
import { validateExtensionManifest } from "@massion/extension-sdk";
import { describe, expect, it } from "vitest";
import { invokeDiscord } from "./connector.js";

describe("Discord 공식 Extension", () => {
  it("manifest와 최소 권한을 검증한다", () => {
    const manifest = validateExtensionManifest(
      JSON.parse(readFileSync(new URL("../massion.extension.json", import.meta.url), "utf8")) as unknown,
    );
    expect(manifest.name).toBe("@massion-ext/discord");
    expect(manifest.permissions.network[0]?.origin).toBe("https://discord.com");
  });
  it("slash command와 component를 Application action으로 정규화한다", async () => {
    await expect(
      invokeDiscord("surfaceConnectors:discord", {
        kind: "command",
        name: "massion",
        subcommand: "work-create",
        userId: "123456789012345678",
        channelId: "223456789012345678",
        options: { request: "배포 오류 조사" },
      }),
    ).resolves.toMatchObject({ operation: "work.create", arguments: { request: "배포 오류 조사" } });
    await expect(
      invokeDiscord("surfaceConnectors:discord", {
        kind: "component",
        userId: "123456789012345678",
        channelId: "223456789012345678",
        customId: "approval:handle123:reject",
      }),
    ).resolves.toMatchObject({ operation: "approval.decide", arguments: { handle: "handle123", decision: "reject" } });
  });
  it("mention과 비정상 snowflake를 거부한다", async () => {
    await expect(
      invokeDiscord("eventConsumers:discord-notification", { channelId: "223456789012345678", text: "@everyone 완료" }),
    ).rejects.toThrow("mention");
    await expect(
      invokeDiscord("surfaceConnectors:discord", {
        kind: "command",
        name: "massion",
        subcommand: "stop",
        userId: "not-id",
        channelId: "223456789012345678",
        options: { runId: "run-12345678" },
      }),
    ).rejects.toThrow("user ID");
  });
});
