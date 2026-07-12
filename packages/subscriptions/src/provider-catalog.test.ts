import { describe, expect, it } from "vitest";

import {
  listSubscriptionProviderManifests,
  providerManifest,
  subscriptionProviderApprovalModes,
} from "./provider-catalog.js";

describe("공식 구독·OAuth 제공자 catalog", () => {
  it.each([
    ["openai-codex", "cli-profile", "agent-runtime"],
    ["anthropic-claude-code", "cli-profile", "agent-runtime"],
    ["google-gemini-cli-enterprise", "cli-profile", "agent-runtime"],
    ["google-antigravity-cli", "cli-profile", "agent-runtime"],
    ["github-copilot", "cli-profile", "agent-runtime"],
    ["minimax-token-plan", "subscription-key", "model"],
    ["xai-grok-build", "cli-profile", "agent-runtime"],
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
      protocol: "openai",
      quotaDiscovery: "endpoint",
      endpointAllowlist: ["https://api.minimax.io/v1"],
    });
    expect(providerManifest("nous-portal")).toMatchObject({
      authKinds: ["api-key"],
      billingKinds: ["consumer-subscription", "api-credits", "x402"],
      quotaDiscovery: "none",
    });
  });

  it("xAI 구독 실행과 직접 API 사용을 서로 다른 공식 경계로 분리한다", () => {
    expect(providerManifest("xai-grok-build")).toMatchObject({
      authKinds: ["cli-profile"],
      executionKind: "agent-runtime",
      protocol: "acp",
      modelDiscovery: "command",
      endpointAllowlist: [],
      runtimeCapabilities: {
        accountIsolation: "profile-root",
        output: "final-text-only",
        cancellation: "protocol",
        session: "protocol",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        maturity: "experimental",
      },
    });
    expect(providerManifest("xai-api")).toMatchObject({
      authKinds: ["api-key"],
      executionKind: "model",
      protocol: "openai",
      endpointAllowlist: ["https://api.x.ai/v1"],
    });
  });

  it("Codex와 Claude의 현재 output·approval capability를 실제 구현과 일치시킨다", () => {
    expect(providerManifest("openai-codex")).toMatchObject({
      protocol: "codex-app-server",
      modelDiscovery: "protocol",
      quotaDiscovery: "protocol",
      runtimeCapabilities: {
        output: "final-text-only",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        approvalModes: ["automatic", "deny"],
        approvalModesBySurface: {
          server: ["automatic", "review", "deny"],
          edge: ["automatic", "deny"],
        },
      },
    });
    expect(providerManifest("anthropic-claude-code")).toMatchObject({
      protocol: "claude-agent-sdk",
      quotaDiscovery: "none",
      runtimeCapabilities: {
        output: "final-text-only",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        approvalModes: ["automatic", "review", "deny"],
      },
    });
  });

  it("Codex 승인 범위를 연결 표면별로 계산하고 Provider 정책에는 두 표면의 합집합을 허용한다", () => {
    const manifest = providerManifest("openai-codex");

    expect(subscriptionProviderApprovalModes(manifest, "server")).toEqual(["automatic", "review", "deny"]);
    expect(subscriptionProviderApprovalModes(manifest, "edge")).toEqual(["automatic", "deny"]);
    expect(subscriptionProviderApprovalModes(manifest)).toEqual(["automatic", "review", "deny"]);
  });

  it("공식 지원 도구 승인이 필요한 Z.AI를 기본 지원으로 과장하지 않는다", () => {
    expect(providerManifest("zai-coding-plan")).toMatchObject({
      quotaDiscovery: "none",
      availability: "requires-provider-approval",
    });
  });

  it("Anthropic 사전 승인 없는 제3자 제품의 claude.ai 소비자 로그인을 기본 지원하지 않는다", () => {
    expect(providerManifest("anthropic-claude-code")).toMatchObject({
      displayName: "Anthropic Claude Agent",
      availability: "requires-provider-approval",
      officialDocumentation: "https://platform.claude.com/docs/en/agent-sdk/overview",
    });
    expect(listSubscriptionProviderManifests().map((manifest) => manifest.displayName)).not.toContain("Claude Code");
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
      modelDiscovery: "none",
      quotaDiscovery: "none",
      verified: false,
      runtimeCapabilities: {
        accountIsolation: "profile-root",
        output: "final-text-only",
        cancellation: "protocol",
        session: "protocol",
        permissionBridge: "protocol",
        multipleAccounts: "profile-isolated",
        maturity: "experimental",
      },
    });
    expect(() => providerManifest("google-gemini-cli")).toThrow("찾을 수 없습니다");
  });

  it("Copilot의 대화형 session usage를 구독 잔여 quota로 오인하지 않는다", () => {
    expect(providerManifest("github-copilot")).toMatchObject({ quotaDiscovery: "none" });
  });

  it("공개 등록부터 실행까지 닫히지 않은 ACP 제공자를 기본 지원으로 과장하지 않는다", () => {
    expect(providerManifest("google-gemini-cli-enterprise")).toMatchObject({
      availability: "experimental",
      runtimeCapabilities: { maturity: "experimental" },
    });
    expect(providerManifest("github-copilot")).toMatchObject({
      availability: "experimental",
      runtimeCapabilities: {
        accountIsolation: "single-os-keyring-account",
        multipleAccounts: "one-account-per-connector",
        maturity: "experimental",
      },
    });
    expect(providerManifest("xai-grok-build")).toMatchObject({
      availability: "experimental",
      runtimeCapabilities: { maturity: "experimental" },
    });
  });

  it("실제 설치·인증 표면이 있는 위치와 아직 공개 연결할 수 없는 Provider를 구분한다", () => {
    expect(providerManifest("openai-codex")).toMatchObject({ connectionSurface: "server-and-edge" });
    for (const providerId of ["google-gemini-cli-enterprise", "github-copilot", "xai-grok-build"]) {
      expect(providerManifest(providerId)).toMatchObject({ connectionSurface: "edge-only" });
    }
    expect(providerManifest("google-antigravity-cli")).toMatchObject({ connectionSurface: "unavailable" });
    expect(providerManifest("minimax-token-plan")).toMatchObject({ connectionSurface: "server-only" });
    for (const providerId of ["xai-api", "nous-portal", "zai-coding-plan"]) {
      expect(providerManifest(providerId)).toMatchObject({ connectionSurface: "unavailable" });
    }
  });

  it("외부 ACP Edge는 저장된 profile 인증과 automatic·deny만 공개하고 review를 주장하지 않는다", () => {
    for (const providerId of ["google-gemini-cli-enterprise", "github-copilot", "xai-grok-build"]) {
      expect(providerManifest(providerId)).toMatchObject({
        authKinds: ["cli-profile"],
        runtimeCapabilities: {
          output: "final-text-only",
          approvalModes: ["automatic", "deny"],
        },
      });
    }
  });

  it("Provider별로 실제 공개된 model discovery 계약만 선언한다", () => {
    expect(providerManifest("google-gemini-cli-enterprise")).toMatchObject({ modelDiscovery: "none" });
    expect(providerManifest("github-copilot")).toMatchObject({ modelDiscovery: "protocol" });
    expect(providerManifest("xai-grok-build")).toMatchObject({ modelDiscovery: "command" });
  });
});
