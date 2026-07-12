import type { GovernanceGate } from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type { QueryExecutor } from "@massion/storage";
import type { SubscriptionAccount, SubscriptionSharingAuthorizer } from "@massion/subscriptions";

export class GovernanceSubscriptionSharingAuthorizer implements SubscriptionSharingAuthorizer {
  public constructor(
    private readonly governance: Pick<GovernanceGate, "authorize">,
    private readonly environment: "local" | "team",
  ) {}

  public async authorize(
    context: TenantContext,
    account: SubscriptionAccount,
    input: { readonly commandId: string; readonly approvalId?: string; readonly executor: QueryExecutor },
  ): Promise<{ readonly policyVersion: string }> {
    const authorization = await this.governance.authorize(
      context,
      {
        commandId: input.commandId,
        action: "subscription.account.share",
        resource: {
          type: "SubscriptionAccount",
          id: account.account_id,
          revision: account.version,
          dataClassification: "provider-account",
          attributes: { providerId: account.provider_id, scope: account.scope },
        },
        environment: this.environment,
        riskClass: "account-sharing",
        external: false,
        executionId: `subscription-share:${account.account_id}`,
        ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      },
      input.executor,
    );
    const policyVersion = authorization.decision.policyVersionId;
    if (!policyVersion) throw new Error("구독 계정 공유 결정에 Governance policy version이 없습니다");
    return { policyVersion };
  }
}
