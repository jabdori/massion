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
    });
    expect(providers.find((provider) => provider.providerId === "opencode-go")).toMatchObject({
      executionKind: "model",
      protocols: ["anthropic", "openai"],
      modelDiscovery: "endpoint",
      officialDocumentation: "https://opencode.ai/docs/go/",
      credentialPolicies: DOMAIN_POLICIES,
      verified: false,
    });
  });

  it("공개 view에 endpoint·route·외부 계정 정보를 포함하지 않는다", async () => {
    const serialized = JSON.stringify(await new BuiltinSubscriptionProviderDirectory().list(context));

    for (const forbidden of ["endpointAllowlist", "baseUrl", "modelDiscoveryEndpoint", "quotaEndpoint", "routes"])
      expect(serialized).not.toContain(forbidden);
  });
});
