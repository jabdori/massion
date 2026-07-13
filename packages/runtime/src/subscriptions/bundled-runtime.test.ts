import { lstat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { inspectBundledSubscriptionRuntime } from "./bundled-runtime.js";

describe("공식 SDK bundled runtime 증명", () => {
  it("Codex SDK·CLI·platform binary의 실제 artifact를 결정론적으로 증명한다", async () => {
    const first = await inspectBundledSubscriptionRuntime("codex");
    const second = await inspectBundledSubscriptionRuntime("codex");

    expect(first).toEqual(second);
    expect(first).toMatchObject({ runtimeId: "codex", version: "0.144.1" });
    expect(first.runtimeArtifactDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.commandArguments.length).toBeGreaterThan(0);
    await expect(lstat(first.command)).resolves.toMatchObject({});
  }, 15_000);

  it("Claude Agent SDK와 현재 platform native binary의 실제 artifact를 증명한다", async () => {
    const artifact = await inspectBundledSubscriptionRuntime("claude");

    expect(artifact).toMatchObject({ runtimeId: "claude", version: "0.3.207", commandArguments: [] });
    expect(artifact.runtimeArtifactDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect((await lstat(artifact.command)).isFile()).toBe(true);
  });

  it("지원하지 않는 runtime ID는 임의 실행 파일로 해석하지 않는다", async () => {
    await expect(inspectBundledSubscriptionRuntime("unknown" as never)).rejects.toThrow("지원하지 않는");
  });
});
