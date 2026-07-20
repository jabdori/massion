import { describe, expect, it, vi } from "vitest";

import { ZaiCodingPlanSubscriptionVerifier } from "./zai-coding-plan-subscription-verifier.js";

describe("Z.AI Coding Plan Credential 실인증", () => {
  it("공식 OpenAI 호환 chat completion으로 키와 선택 모델의 실제 실행 가능성을 확인한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "glm-5.2",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const verifier = new ZaiCodingPlanSubscriptionVerifier({
      fetcher,
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    await expect(
      verifier.verify({
        endpointUrl: "https://api.z.ai/api/coding/paas/v4",
        secret: "private-zai-coding-plan-key",
        requiredModelId: "glm-5.2",
      }),
    ).resolves.toEqual({
      modelId: "glm-5.2",
      observedAt: "2026-07-20T00:00:00.000Z",
      source: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.z.ai/api/coding/paas/v4/chat/completions", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer private-zai-coding-plan-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "glm-5.2",
        messages: [{ role: "user", content: "Respond with: ok" }],
        max_tokens: 8,
        stream: false,
      }),
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("실패 응답에서는 비밀값이나 Provider 본문을 내보내지 않는다", async () => {
    const verifier = new ZaiCodingPlanSubscriptionVerifier({
      fetcher: vi.fn().mockResolvedValue(new Response('{"error":"private-zai-coding-plan-key"}', { status: 401 })),
    });

    const failure = await verifier
      .verify({
        endpointUrl: "https://api.z.ai/api/coding/paas/v4",
        secret: "private-zai-coding-plan-key",
        requiredModelId: "glm-5.2",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("인증 또는 model 실행 확인");
    expect(String(failure)).not.toContain("private-zai-coding-plan-key");
  });
});
