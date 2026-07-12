import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionAccountService, type SubscriptionSharingAuthorizer } from "./account-service.js";

class TestSharingAuthorizer implements SubscriptionSharingAuthorizer {
  public allowed = false;
  public readonly calls: Array<{ commandId: string; approvalId?: string }> = [];

  public authorize(
    _context: TenantContext,
    _account: unknown,
    input: { readonly commandId: string; readonly approvalId?: string },
  ): Promise<{ policyVersion: string }> {
    this.calls.push({
      commandId: input.commandId,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    });
    if (!this.allowed && input.approvalId !== "approved-share") {
      return Promise.reject(new Error("관리자 정책에서 구독 계정 공유를 허용하지 않았습니다"));
    }
    return Promise.resolve({ policyVersion: "test-policy-v1" });
  }
}

describe("구독 계정 소유권과 조직 공유", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let service: SubscriptionAccountService;
  let policy: TestSharingAuthorizer;
  let owner: TenantContext;
  let member: TenantContext;
  let outsider: TenantContext;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);

    const registeredOwner = await identities.registerPersonalUser({
      email: "subscription-owner@example.com",
      displayName: "Subscription Owner",
    });
    const registeredMember = await identities.registerPersonalUser({
      email: "subscription-member@example.com",
      displayName: "Subscription Member",
    });
    const registeredOutsider = await identities.registerPersonalUser({
      email: "subscription-outsider@example.com",
      displayName: "Subscription Outsider",
    });
    const team = await organizations.createTeam(registeredOwner.user.user_id, "Subscription Team");
    owner = await organizations.resolveTenantContext(registeredOwner.user.user_id, team.organization.organization_id);
    await organizations.addMember(owner, registeredMember.user.user_id, "member");
    member = await organizations.resolveTenantContext(registeredMember.user.user_id, team.organization.organization_id);
    outsider = await organizations.resolveTenantContext(
      registeredOutsider.user.user_id,
      registeredOutsider.organization.organization_id,
    );

    policy = new TestSharingAuthorizer();
    service = await SubscriptionAccountService.create(database, organizations, randomBytes(32), policy);
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'edge-member',
        organization_id: $organization_id,
        owner_user_id: $owner_user_id,
        location: 'edge',
        execution_kind: 'agent-runtime',
        protocol: 'massion-connector-v1',
        version: '1.0.0',
        public_key: 'test-public-key',
        capabilities: ['codex'],
        status: 'ready',
        created_at: time::now(),
        updated_at: time::now()
      };
      CREATE subscription_connector CONTENT {
        connector_id: 'edge-member-2',
        organization_id: $organization_id,
        owner_user_id: $owner_user_id,
        location: 'edge',
        execution_kind: 'agent-runtime',
        protocol: 'massion-connector-v1',
        version: '1.0.0',
        public_key: 'test-public-key-2',
        capabilities: ['codex'],
        status: 'ready',
        created_at: time::now(),
        updated_at: time::now()
      };`,
      { organization_id: member.organizationId, owner_user_id: member.userId },
    );
  });

  afterEach(async () => database.close());

  async function register(alias = "My Codex") {
    return await service.register(member, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      alias,
      connectorId: "edge-member",
      profileLocator: "subscription-member@example.com",
      billingKind: "consumer-subscription",
    });
  }

  it("계정은 개인 전용으로 등록되며 외부 계정 식별자를 저장하지 않는다", async () => {
    const account = await register();

    expect(account).toMatchObject({
      owner_user_id: member.userId,
      scope: "personal",
      consent_version: 0,
      status: "active",
      version: 1,
    });
    expect(account.profile_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const raw = JSON.stringify(
      await database.query("SELECT * FROM subscription_account; SELECT * FROM subscription_audit_event;"),
    );
    expect(raw).not.toContain("subscription-member@example.com");
  });

  it("계정 소유자의 동의와 조직 공유 정책이 모두 있어야 공유된다", async () => {
    const account = await register();
    await expect(
      service.share(member, { commandId: randomUUID(), accountId: account.account_id, expectedVersion: 1 }),
    ).rejects.toThrow("관리자 정책");

    policy.allowed = true;
    await expect(
      service.share(owner, { commandId: randomUUID(), accountId: account.account_id, expectedVersion: 1 }),
    ).rejects.toThrow("계정 소유자");
    const shared = await service.share(member, {
      commandId: randomUUID(),
      accountId: account.account_id,
      expectedVersion: 1,
    });

    expect(shared).toMatchObject({ scope: "organization", consent_version: 1, version: 2 });
  });

  it("같은 공유 명령을 승인 ID와 재개해도 idempotency 요청 정본은 바뀌지 않는다", async () => {
    const account = await register();
    const commandId = randomUUID();
    await expect(
      service.share(member, { commandId, accountId: account.account_id, expectedVersion: 1 }),
    ).rejects.toThrow("관리자 정책");
    const shared = await service.share(member, {
      commandId,
      accountId: account.account_id,
      expectedVersion: 1,
      approvalId: "approved-share",
    });

    expect(shared).toMatchObject({ scope: "organization", version: 2 });
    expect(policy.calls).toEqual([{ commandId }, { commandId, approvalId: "approved-share" }]);
  });

  it("소유자가 공유를 철회하면 조직 사용 가능성 검사를 즉시 거부한다", async () => {
    policy.allowed = true;
    const account = await register();
    const shared = await service.share(member, {
      commandId: randomUUID(),
      accountId: account.account_id,
      expectedVersion: 1,
    });
    const unshared = await service.unshare(member, {
      commandId: randomUUID(),
      accountId: account.account_id,
      expectedVersion: shared.version,
    });

    expect(unshared).toMatchObject({ scope: "personal", consent_version: 2, version: 3 });
    await expect(service.requireUsable(owner, account.account_id, "organization")).rejects.toThrow("공유가 철회");
    await expect(service.requireUsable(member, account.account_id, "personal")).resolves.toMatchObject({
      account_id: account.account_id,
    });
  });

  it("연결 해제는 계정을 폐기하고 재사용을 차단한다", async () => {
    const account = await register();
    const revoked = await service.disconnect(member, {
      commandId: randomUUID(),
      accountId: account.account_id,
      expectedVersion: 1,
    });

    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
    await expect(service.requireUsable(member, account.account_id, "personal")).rejects.toThrow("폐기된 구독 계정");
  });

  it("할당량 우회가 금지된 StepFun은 조직에 활성 계정을 하나만 등록한다", async () => {
    const first = await service.register(member, {
      commandId: randomUUID(),
      providerId: "stepfun-step-plan",
      alias: "StepFun 1",
      connectorId: "edge-member",
      profileLocator: "stepfun-account-1",
      billingKind: "step-plan",
    });

    await expect(
      service.register(member, {
        commandId: randomUUID(),
        providerId: "stepfun-step-plan",
        alias: "StepFun 2",
        connectorId: "edge-member-2",
        profileLocator: "stepfun-account-2",
        billingKind: "step-plan",
      }),
    ).rejects.toThrow("할당량 우회");

    await service.disconnect(member, {
      commandId: randomUUID(),
      accountId: first.account_id,
      expectedVersion: first.version,
    });
    await expect(
      service.register(member, {
        commandId: randomUUID(),
        providerId: "stepfun-step-plan",
        alias: "StepFun replacement",
        connectorId: "edge-member-2",
        profileLocator: "stepfun-account-2",
        billingKind: "step-plan",
      }),
    ).resolves.toMatchObject({ provider_id: "stepfun-step-plan", status: "active" });
  });

  it("하나의 Edge Connector에는 연결 해제 전까지 외부 계정을 하나만 등록한다", async () => {
    const first = await register("Primary Codex");

    await expect(
      service.register(member, {
        commandId: randomUUID(),
        providerId: "anthropic-claude",
        alias: "Second physical profile",
        connectorId: "edge-member",
        profileLocator: "different-profile@example.com",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow("하나의 Edge Connector에는 외부 계정을 하나만");

    await service.disconnect(member, {
      commandId: randomUUID(),
      accountId: first.account_id,
      expectedVersion: first.version,
    });
    await expect(
      service.register(member, {
        commandId: randomUUID(),
        providerId: "anthropic-claude",
        alias: "Replacement profile",
        connectorId: "edge-member",
        profileLocator: "different-profile@example.com",
        billingKind: "consumer-subscription",
      }),
    ).resolves.toMatchObject({ provider_id: "anthropic-claude", status: "active" });
  });

  it("명령 재시도는 같은 결과를 반환하고 다른 조직 접근과 command 변조를 거부한다", async () => {
    const commandId = randomUUID();
    const input = {
      commandId,
      providerId: "openai-codex",
      alias: "Retry Codex",
      connectorId: "edge-member",
      profileLocator: "retry@example.com",
      billingKind: "consumer-subscription",
    } as const;
    const first = await service.register(member, input);
    await expect(service.register(member, input)).resolves.toEqual(first);
    await expect(service.register(member, { ...input, alias: "Changed" })).rejects.toThrow("다른 요청");
    await expect(service.list({ ...outsider, organizationId: member.organizationId }, "organization")).rejects.toThrow(
      "TenantContext",
    );
  });
});
