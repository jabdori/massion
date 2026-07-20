import { describe, expect, it } from "vitest";

import {
  codingPlanPreset,
  codingPlanRouteForModel,
  listCodingPlanPresets,
  verifyCodingPlanPreset,
} from "./coding-plan.js";

describe("공식 Coding Plan preset", () => {
  it.each([
    ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4", "coding-plan"],
    ["kimi-coding-plan", "https://api.kimi.com/coding/v1", "membership-subscription"],
    ["stepfun-step-plan", "https://api.stepfun.ai/step_plan/v1", "step-plan"],
    ["alibaba-coding-plan", "https://coding-intl.dashscope.aliyuncs.com/v1", "coding-plan"],
    ["minimax-token-plan", "https://api.minimax.io/anthropic", "token-plan"],
    ["kilo-gateway", "https://api.kilo.ai/api/gateway", "api-credits"],
  ] as const)("%s는 공식 endpoint와 과금 경계를 선언하고 비검증 상태로 시작한다", (id, baseUrl, billing) => {
    expect(codingPlanPreset(id)).toMatchObject({
      id,
      routes: expect.arrayContaining([expect.objectContaining({ baseUrl })]),
      billingKinds: expect.arrayContaining([billing]),
      verified: false,
    });
  });

  it("OpenCode Go의 최신 공식 OpenAI·Anthropic API 경로와 model discovery를 선언한다", () => {
    expect(codingPlanPreset("opencode-go")).toMatchObject({
      id: "opencode-go",
      routes: [
        expect.objectContaining({ protocol: "openai", baseUrl: "https://opencode.ai/zen/go/v1" }),
        expect.objectContaining({ protocol: "anthropic", baseUrl: "https://opencode.ai/zen/go/v1" }),
      ],
      modelDiscoveryEndpoint: "https://opencode.ai/zen/go/v1/models",
      verified: false,
    });
  });

  it("MiniMax Token Plan은 공식 Anthropic·OpenAI 호환 경로를 모두 선언한다", () => {
    expect(codingPlanPreset("minimax-token-plan")).toMatchObject({
      modelDiscoveryEndpoint: "https://api.minimax.io/v1/models",
      routes: [
        { protocol: "anthropic", baseUrl: "https://api.minimax.io/anthropic" },
        { protocol: "openai", baseUrl: "https://api.minimax.io/v1" },
      ],
    });
    expect(codingPlanRouteForModel("minimax-token-plan", "MiniMax-M2.7")).toMatchObject({
      protocol: "openai",
      baseUrl: "https://api.minimax.io/v1",
    });
    expect(codingPlanRouteForModel("minimax-token-plan", "MiniMax-M3")).toMatchObject({
      protocol: "openai",
      baseUrl: "https://api.minimax.io/v1",
    });
    expect(() => codingPlanRouteForModel("minimax-token-plan", "MiniMax-미검증")).toThrow("검증된 route");
  });

  it("Z.AI Coding Plan은 현재 공식 모델 허용 목록으로 OpenAI 호환 경로를 선언한다", () => {
    expect(codingPlanPreset("zai-coding-plan")).toMatchObject({
      connectionSurface: "server-only",
      usageScope: "agent-api",
      availability: "supported",
      authKinds: ["api-key"],
      billingKinds: ["coding-plan"],
    });
    expect(codingPlanPreset("zai-coding-plan").routes[0]?.modelIds).toEqual([
      "glm-5.2",
      "glm-5-turbo",
      "glm-4.7",
    ]);
    expect(codingPlanRouteForModel("zai-coding-plan", "glm-5.2")).toMatchObject({
      protocol: "openai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    });
    expect(() => codingPlanRouteForModel("zai-coding-plan", "glm-5.1")).toThrow("검증된 route");
  });

  it("모든 preset은 인증을 요구하고 무료·익명 모델을 활성 후보에서 제외한다", () => {
    for (const preset of listCodingPlanPresets()) {
      expect(preset.authKinds.length).toBeGreaterThan(0);
      expect(preset.requiresAuthentication).toBe(true);
      expect(preset.routes.flatMap((route) => route.modelIds ?? []).every((id) => !id.endsWith(":free"))).toBe(true);
    }
    expect(JSON.stringify(listCodingPlanPresets())).not.toMatch(/anonymous|no-auth/iu);
    expect(codingPlanPreset("kilo-gateway")).toMatchObject({
      blockedModelIdSuffixes: [":free"],
      billingKinds: expect.arrayContaining(["api-credits", "pay-as-you-go", "byok", "credit-subscription"]),
    });
  });

  it("여러 계정을 quota 우회에 사용하면 안 되는 제공자 정책을 기계 판독 가능하게 보존한다", () => {
    expect(codingPlanPreset("stepfun-step-plan")).toMatchObject({ accountPolicy: "no-quota-circumvention" });
  });

  it("OpenCode Go 모델을 공식 문서의 실제 protocol 경로로 보낸다", () => {
    expect(codingPlanRouteForModel("opencode-go", "glm-5.2")).toMatchObject({ protocol: "openai" });
    expect(codingPlanRouteForModel("opencode-go", "minimax-m3")).toMatchObject({ protocol: "anthropic" });
    expect(() => codingPlanRouteForModel("opencode-go", "새로운-미검증-모델")).toThrow("검증된 route");
  });

  it("문서 허용 목록 제공자는 공식 모델 ID만 통과시킨다", () => {
    expect(codingPlanRouteForModel("kimi-coding-plan", "kimi-for-coding")).toMatchObject({ protocol: "openai" });
    expect(codingPlanRouteForModel("kimi-coding-plan", "kimi-for-coding-highspeed")).toMatchObject({
      protocol: "openai",
    });
    expect(codingPlanPreset("stepfun-step-plan").routes[0]?.modelIds).toEqual([
      "step-3.7-flash",
      "step-3.5-flash-2603",
      "step-3.5-flash",
    ]);
    for (const modelId of ["step-3.7-flash", "step-3.5-flash-2603", "step-3.5-flash"]) {
      expect(codingPlanRouteForModel("stepfun-step-plan", modelId)).toMatchObject({ protocol: "openai" });
    }
    expect(codingPlanRouteForModel("alibaba-coding-plan", "qwen3.7-plus")).toMatchObject({ protocol: "openai" });
    expect(codingPlanRouteForModel("zai-coding-plan", "glm-5.2")).toMatchObject({ protocol: "openai" });
    for (const providerId of ["kimi-coding-plan", "stepfun-step-plan", "alibaba-coding-plan", "zai-coding-plan"]) {
      expect(() => codingPlanRouteForModel(providerId, "문서에-없는-모델")).toThrow("검증된 route");
    }
  });

  it("documented-allowlist preset은 비어 있지 않은 모델별 route를 가진다", () => {
    for (const preset of listCodingPlanPresets().filter(
      (candidate) => candidate.modelDiscovery === "documented-allowlist",
    )) {
      expect(preset.routes.length).toBeGreaterThan(0);
      expect(preset.routes.every((route) => (route.modelIds?.length ?? 0) > 0)).toBe(true);
    }
  });

  it("공식 model discovery endpoint의 capability probe 성공 뒤에만 검증된 view를 만든다", async () => {
    const probe = async (endpoint: string) => ({
      endpoint,
      modelIds: ["glm-5.2", "minimax-m3", "provider-returned-model", "provider-returned-model:free"],
      capabilities: ["chat", "tools"] as const,
    });

    await expect(verifyCodingPlanPreset("opencode-go", probe)).resolves.toMatchObject({
      id: "opencode-go",
      verified: true,
      modelIds: ["glm-5.2", "minimax-m3"],
      capabilities: ["chat", "tools"],
    });
    await expect(verifyCodingPlanPreset("kilo-gateway", probe)).resolves.toMatchObject({
      id: "kilo-gateway",
      modelIds: ["glm-5.2", "minimax-m3", "provider-returned-model"],
    });
    await expect(verifyCodingPlanPreset("zai-coding-plan", probe)).rejects.toThrow("model discovery");
  });
});
