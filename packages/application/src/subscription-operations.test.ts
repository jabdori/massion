import type { TenantContext } from "@massion/identity";
import { SUBSCRIPTION_CREDENTIAL_POLICIES as DOMAIN_POLICIES } from "@massion/subscriptions";
import { describe, expect, it } from "vitest";

import { BuiltinSubscriptionProviderDirectory } from "./subscription-operations.js";

const context: TenantContext = {
  userId: "provider-directory-user",
  organizationId: "provider-directory-organization",
  membershipId: "provider-directory-membership",
  role: "member",
};

describe("BuiltinSubscriptionProviderDirectory", () => {
  it("내장 manifest와 Coding Plan preset을 ID별로 병합해 공개 선택 계약을 만든다", async () => {
    const providers = await new BuiltinSubscriptionProviderDirectory().list(context);
    const ids = providers.map((provider) => provider.providerId);

    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("opencode-go");
    expect(ids.filter((id) => id === "minimax-token-plan")).toHaveLength(1);
    expect(ids.filter((id) => id === "zai-coding-plan")).toHaveLength(1);
    expect(providers.find((provider) => provider.providerId === "openai-codex")).toMatchObject({
      protocols: ["codex-app-server"],
      protocol: "codex-app-server",
      officialDocumentation: "https://developers.openai.com/codex/auth",
      credentialPolicies: DOMAIN_POLICIES,
      runtimeCapabilities: {
        approvalModes: ["automatic", "deny"],
        approvalModesBySurface: {
          server: ["automatic", "review", "deny"],
          edge: ["automatic", "deny"],
        },
      },
    });
    expect(providers.find((provider) => provider.providerId === "anthropic-claude-code")).toMatchObject({
      displayName: "Anthropic Claude Code",
      availability: "supported",
    });
    expect(providers.find((provider) => provider.providerId === "github-copilot")).toMatchObject({
      availability: "experimental",
      connectionSurface: "edge-only",
      runtimeCapabilities: {
        accountIsolation: "single-os-keyring-account",
        multipleAccounts: "one-account-per-connector",
        maturity: "experimental",
      },
    });
    expect(providers.find((provider) => provider.providerId === "google-antigravity-cli")).toMatchObject({
      connectionSurface: "unavailable",
    });
    expect(providers.map((provider) => provider.displayName)).toContain("Anthropic Claude Code");
    expect(providers.find((provider) => provider.providerId === "opencode-go")).toMatchObject({
      executionKind: "model",
      connectionSurface: "unavailable",
      protocols: ["anthropic", "openai"],
      modelDiscovery: "endpoint",
      officialDocumentation: "https://opencode.ai/docs/go/",
      credentialPolicies: DOMAIN_POLICIES,
      verified: false,
    });
    for (const providerId of [
      "kimi-coding-plan",
      "stepfun-step-plan",
      "alibaba-coding-plan",
      "opencode-go",
      "kilo-gateway",
      "xai-api",
      "nous-portal",
    ]) {
      expect(providers.find((provider) => provider.providerId === providerId)).toMatchObject({
        connectionSurface: "unavailable",
      });
    }
    expect(providers.find((provider) => provider.providerId === "minimax-token-plan")).toMatchObject({
      connectionSurface: "server-only",
    });
    expect(providers.find((provider) => provider.providerId === "zai-coding-plan")).toMatchObject({
      connectionSurface: "server-only",
    });
  });

  it("공개 view에 endpoint·route·외부 계정 정보를 포함하지 않는다", async () => {
    const serialized = JSON.stringify(await new BuiltinSubscriptionProviderDirectory().list(context));

    for (const forbidden of ["endpointAllowlist", "baseUrl", "modelDiscoveryEndpoint", "quotaEndpoint", "routes"])
      expect(serialized).not.toContain(forbidden);
  });
});
