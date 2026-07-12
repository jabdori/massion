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
