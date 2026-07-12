import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { GovernanceSubscriptionSharingAuthorizer } from "./subscription-sharing.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "member",
};
const account = {
  account_id: "account-1",
  organization_id: context.organizationId,
  owner_user_id: context.userId,
  provider_id: "openai-codex",
  alias: "개인 계정",
  scope: "personal",
  connector_id: "connector-1",
  profile_fingerprint: "fingerprint",
  billing_kind: "consumer-subscription",
  status: "active",
  consent_version: 0,
  version: 1,
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
} as const;

describe("구독 공유 Governance adapter", () => {
  it("조직 정책의 자동 허용과 승인 재개를 같은 공유 action으로 위임한다", async () => {
    const authorize = vi.fn().mockResolvedValue({
      outcome: "allow",
      decision: { policyVersionId: "policy-version-1" },
    });
    const authorizer = new GovernanceSubscriptionSharingAuthorizer({ authorize } as never, "team");
    const executor = { query: vi.fn() } as never;

    await expect(
      authorizer.authorize(context, account, {
        commandId: "share-command-1",
        approvalId: "approval-1",
        executor,
      }),
    ).resolves.toEqual({ policyVersion: "policy-version-1" });
    expect(authorize).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        commandId: "share-command-1",
        action: "subscription.account.share",
        approvalId: "approval-1",
        environment: "team",
        riskClass: "account-sharing",
        external: false,
        resource: expect.objectContaining({
          type: "SubscriptionAccount",
          id: "account-1",
          revision: 1,
          attributes: { providerId: "openai-codex", scope: "personal" },
        }),
      }),
      executor,
    );
  });

  it("policy version이 없는 허용 결과를 동의 근거로 저장하지 않는다", async () => {
    const authorizer = new GovernanceSubscriptionSharingAuthorizer(
      { authorize: vi.fn().mockResolvedValue({ outcome: "allow", decision: {} }) } as never,
      "local",
    );

    await expect(
      authorizer.authorize(context, account, { commandId: "share-command-2", executor: { query: vi.fn() } as never }),
    ).rejects.toThrow("policy version");
  });
});
