import { describe, expect, it, vi } from "vitest";

import { discoverModels, validateGatewayModelId } from "./discovery.js";

describe("Provider model discovery 계약", () => {
  it("Ollama /api/tags 응답에서 모델 ID를 추출한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 5_000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverModels({ adapterKind: "ollama", baseUrl: "http://127.0.0.1:11434" }, fetcher);

    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", expect.any(Object));
    expect(result).toEqual({ status: "available", models: [{ id: "qwen3:8b", ownedBy: "local" }] });
  });

  it("OpenAI-compatible /v1/models 응답과 Bearer 인증을 사용한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [{ id: "coding-model", owned_by: "gateway" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1", secret: "token" },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );
    expect(result.models).toEqual([{ id: "coding-model", ownedBy: "gateway" }]);
  });

  it("연결 실패를 꾸며내지 않고 복구 조치가 있는 degraded 진단으로 반환한다", async () => {
    const result = await discoverModels(
      { adapterKind: "openai-compatible", baseUrl: "https://gateway.example/v1" },
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
    );

    expect(result.status).toBe("degraded");
    expect(result.models).toEqual([]);
    expect(result.diagnostic?.recovery).toContain("Endpoint");
  });

  it("LiteLLM·Portkey model alias와 OmniRoute combo ID를 안전한 식별자로 검증한다", () => {
    expect(validateGatewayModelId("litellm", "coding-model")).toBe("coding-model");
    expect(validateGatewayModelId("portkey", "@quality-route")).toBe("@quality-route");
    expect(validateGatewayModelId("omniroute", "auto/coding")).toBe("auto/coding");
    expect(validateGatewayModelId("omniroute", "premium-coding")).toBe("premium-coding");
    expect(() => validateGatewayModelId("omniroute", "bad\nmodel")).toThrow("model ID");
    expect(() => validateGatewayModelId("litellm", " ")).toThrow("model ID");
  });
});
