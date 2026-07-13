import { lstat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { inspectBuiltinModelRuntime } from "./builtin-model-runtime.js";

describe("서버 내장 직접 모델 runtime artifact 증명", () => {
  it("실제 모델 팩토리·OpenAI 호환 SDK·Node.js artifact와 설치 version을 결정론적으로 증명한다", async () => {
    const first = await inspectBuiltinModelRuntime("openai-model");
    const second = await inspectBuiltinModelRuntime("openai-model");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      runtimeId: "openai-model",
      version: "1.0.0+openai-compatible.2.0.59",
    });
    expect(first.runtimeArtifactDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(lstat(first.nodeExecutable)).resolves.toMatchObject({});
  }, 20_000);

  it("등록하지 않은 runtime ID를 임의의 artifact로 해석하지 않는다", async () => {
    await expect(inspectBuiltinModelRuntime("arbitrary-model" as never)).rejects.toThrow("지원하지 않는");
  });
});
