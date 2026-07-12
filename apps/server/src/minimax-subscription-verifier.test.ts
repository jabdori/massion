import { describe, expect, it, vi } from "vitest";

import { MiniMaxSubscriptionVerifier } from "./minimax-subscription-verifier.js";

describe("MiniMax 구독 Credential 실인증", () => {
  it("공식 model 목록을 Bearer 인증으로 관측하고 필요한 모델의 실제 가용성을 반환한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        object: "list",
        data: [
          { id: "MiniMax-M3", object: "model", created: 1_780_272_000, owned_by: "minimax" },
          { id: "MiniMax-M2.7", object: "model", created: 1_773_799_200, owned_by: "minimax" },
        ],
      }),
    );
    const verifier = new MiniMaxSubscriptionVerifier({
      fetcher,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      verifier.verify({
        endpointUrl: "https://api.minimax.io/v1",
        secret: "private-subscription-key",
        requiredModelId: "MiniMax-M2.7",
      }),
    ).resolves.toEqual({
      modelId: "MiniMax-M2.7",
      availableModelIds: ["MiniMax-M2.7", "MiniMax-M3"],
      observedAt: "2026-07-12T00:00:00.000Z",
      source: "https://api.minimax.io/v1/models",
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.minimax.io/v1/models", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer private-subscription-key" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    {
      name: "인증 거부",
      response: new Response('{"error":"private-subscription-key"}', { status: 401 }),
    },
    {
      name: "필수 모델 부재",
      response: Response.json({ object: "list", data: [{ id: "MiniMax-M3", object: "model" }] }),
    },
    {
      name: "잘못된 schema",
      response: Response.json({ object: "list", data: [{ id: "../unsafe", object: "model" }] }),
    },
    {
      name: "과대 응답",
      response: new Response(JSON.stringify({ object: "list", data: "x".repeat(300_000) })),
    },
  ])("$name 응답은 비밀이나 Provider 본문 없이 실패 폐쇄한다", async ({ response }) => {
    const verifier = new MiniMaxSubscriptionVerifier({ fetcher: vi.fn().mockResolvedValue(response) });

    const failure = await verifier
      .verify({
        endpointUrl: "https://api.minimax.io/v1",
        secret: "private-subscription-key",
        requiredModelId: "MiniMax-M2.7",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("인증 또는 model 관측");
    expect(String(failure)).not.toContain("private-subscription-key");
    expect(String(failure)).not.toContain("../unsafe");
  });

  it("공식 endpoint가 아닌 주소로 Credential을 전달하지 않는다", async () => {
    const fetcher = vi.fn();
    const verifier = new MiniMaxSubscriptionVerifier({ fetcher });

    await expect(
      verifier.verify({
        endpointUrl: "https://attacker.example/v1",
        secret: "private-subscription-key",
        requiredModelId: "MiniMax-M2.7",
      }),
    ).rejects.toThrow("공식 endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
