import { describe, expect, it } from "vitest";

import { listSubscriptionProviderManifests, providerManifest } from "./provider-catalog.js";

describe("공식 구독·OAuth 제공자 catalog", () => {
  it.each([
    ["google-gemini-cli-enterprise", "acp", "agent-runtime"],
    ["google-antigravity-cli", "cli-profile", "agent-runtime"],
    ["github-copilot", "acp", "agent-runtime"],
    ["minimax-token-plan", "subscription-key", "model"],
    ["xai-grok-build", "acp", "agent-runtime"],
    ["xai-api", "api-key", "model"],
    ["nous-portal", "api-key", "model"],
    ["zai-coding-plan", "api-key", "model"],
  ] as const)("%s manifest가 공식 auth와 실행 종류를 선언한다", (id, auth, executionKind) => {
    expect(providerManifest(id)).toMatchObject({
      id,
      authKinds: expect.arrayContaining([auth]),
      executionKind,
      verified: false,
    });
  });

  it("공식 HTTPS documentation과 endpoint만 catalog에 포함한다", () => {
    for (const manifest of listSubscriptionProviderManifests()) {
      expect(manifest.officialDocumentation).toMatch(/^https:\/\//u);
      expect(manifest.endpointAllowlist.every((endpoint) => endpoint.startsWith("https://"))).toBe(true);
      expect(manifest.authKinds).not.toContain("no-auth");
    }
  });

  it("중단되거나 공개 계약이 확인되지 않은 범용 OAuth 경로를 노출하지 않는다", () => {
    for (const id of ["qwen-oauth", "minimax-oauth", "xai-oauth"]) {
      expect(() => providerManifest(id)).toThrow("찾을 수 없습니다");
    }

    expect(providerManifest("minimax-token-plan")).toMatchObject({
      protocol: "anthropic",
      quotaDiscovery: "endpoint",
      endpointAllowlist: ["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"],
    });
    expect(providerManifest("nous-portal")).toMatchObject({
      authKinds: ["api-key"],
      billingKinds: ["consumer-subscription", "api-credits", "x402"],
      quotaDiscovery: "none",
    });
  });

  it("xAI 구독 실행과 직접 API 사용을 서로 다른 공식 경계로 분리한다", () => {
    expect(providerManifest("xai-grok-build")).toMatchObject({
      authKinds: expect.arrayContaining(["acp", "oauth", "device-code", "cli-profile", "api-key"]),
      executionKind: "agent-runtime",
      protocol: "acp",
      endpointAllowlist: [],
      runtimeCapabilities: {
        accountIsolation: "profile-root",
        output: "structured-stream",
        cancellation: "protocol",
        session: "protocol",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        maturity: "contract-tested",
      },
    });
    expect(providerManifest("xai-api")).toMatchObject({
      authKinds: ["api-key"],
      executionKind: "model",
      protocol: "openai",
      endpointAllowlist: ["https://api.x.ai/v1"],
    });
  });

  it("공식 지원 도구 승인이 필요한 Z.AI를 기본 지원으로 과장하지 않는다", () => {
    expect(providerManifest("zai-coding-plan")).toMatchObject({
      quotaDiscovery: "none",
      availability: "requires-provider-approval",
    });
  });

  it("Google 개인 구독과 기업 CLI를 분리하고 기계 판독할 수 없는 잔여 quota를 주장하지 않는다", () => {
    expect(providerManifest("google-antigravity-cli")).toMatchObject({
      billingKinds: ["consumer-subscription"],
      protocol: "cli-process",
      modelDiscovery: "none",
      quotaDiscovery: "none",
      verified: false,
      runtimeCapabilities: {
        minimumVersion: "1.1.1",
        accountIsolation: "single-os-keyring-account",
        output: "final-text-only",
        cancellation: "best-effort-process-tree",
        session: "explicit-existing-id-only",
        permissionBridge: "unsupported",
        multipleAccounts: "one-account-per-connector",
        maturity: "experimental",
      },
    });
    expect(providerManifest("google-gemini-cli-enterprise")).toMatchObject({
      billingKinds: expect.arrayContaining(["enterprise-subscription"]),
      protocol: "acp",
      quotaDiscovery: "none",
      verified: false,
      runtimeCapabilities: {
        accountIsolation: "profile-root",
        output: "structured-stream",
        cancellation: "protocol",
        session: "protocol",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        maturity: "contract-tested",
      },
    });
    expect(() => providerManifest("google-gemini-cli")).toThrow("찾을 수 없습니다");
  });

  it("Copilot의 대화형 session usage를 구독 잔여 quota로 오인하지 않는다", () => {
    expect(providerManifest("github-copilot")).toMatchObject({ quotaDiscovery: "none" });
  });
});
