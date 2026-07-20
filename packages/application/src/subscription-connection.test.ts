import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CredentialVault, ProviderService, type ProviderCredential } from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { SubscriptionAccountService } from "@massion/subscriptions";

import { SubscriptionConnectionService } from "./subscription-connection.js";

describe("구독 연결 오케스트레이션", () => {
  let database: MassionDatabase;
  let identities: IdentityService;
  let organizations: OrganizationService;
  let ownerContext: TenantContext;
  let memberContext: TenantContext;
  let connections: SubscriptionConnectionService;
  let providers: ProviderService;
  let accounts: SubscriptionAccountService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const member = await identities.registerPersonalUser({ email: "member@example.com", displayName: "Member" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    memberContext = await organizations.resolveTenantContext(member.user.user_id, owner.organization.organization_id);
    accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    connections = new SubscriptionConnectionService(database, accounts, providers);
  });

  afterEach(async () => database.close());

  async function connector(input: {
    readonly id: string;
    readonly owner: TenantContext;
    readonly executionKind: "model" | "agent-runtime";
    readonly capabilities: readonly string[];
    readonly location?: "server" | "edge";
  }): Promise<void> {
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: $connector_id, organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: $location, execution_kind: $execution_kind, protocol: 'massion.connector.v1', version: '1.0.0',
        public_key: 'fixture', capabilities: $capabilities, status: 'ready',
        created_at: time::now(), updated_at: time::now()
      };`,
      {
        connector_id: input.id,
        organization_id: input.owner.organizationId,
        owner_user_id: input.owner.userId,
        location: input.location ?? "edge",
        execution_kind: input.executionKind,
        capabilities: input.capabilities,
      },
    );
  }

  it("일반 구성원이 검증된 Codex 연결기에서 계정·Provider·Credential을 한 번에 만든다", async () => {
    await connector({
      id: "member-codex",
      owner: memberContext,
      executionKind: "agent-runtime",
      capabilities: ["openai-codex"],
    });
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      providerId: "openai-codex",
      alias: "개인 Codex",
      connectorId: "member-codex",
      profileLocator: "member-local-profile",
      authKind: "cli-profile" as const,
      billingKind: "consumer-subscription",
    };

    const connected = await connections.connect(memberContext, input);
    await expect(connections.connect(memberContext, input)).resolves.toEqual(connected);
    expect(connected).toMatchObject({
      account: {
        owner_user_id: memberContext.userId,
        provider_id: "openai-codex",
        connector_id: "member-codex",
        scope: "personal",
        status: "active",
      },
      binding: {
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        protocol: "codex-app-server",
      },
    });

    const [providers, endpoints, credentials] = await database.query<
      [
        Array<{ adapter_kind: string }>,
        Array<{ base_url: string; subscription_protocol?: string }>,
        Array<{ material_kind?: string; subscription_account_id?: string }>,
      ]
    >(
      `SELECT adapter_kind FROM model_provider WHERE organization_id = $organization_id;
       SELECT base_url, subscription_protocol FROM provider_endpoint WHERE organization_id = $organization_id;
       SELECT material_kind, subscription_account_id FROM provider_credential WHERE organization_id = $organization_id;`,
      { organization_id: memberContext.organizationId },
    );
    expect(providers).toEqual([{ adapter_kind: "subscription-connector" }]);
    expect(endpoints).toEqual([
      {
        base_url: "massion-connector:///openai-codex/codex-app-server",
        subscription_protocol: "codex-app-server",
      },
    ]);
    expect(credentials).toEqual([
      expect.objectContaining({
        material_kind: "connector_session",
        subscription_account_id: connected.account.account_id,
      }),
    ]);
    expect(
      JSON.stringify(await database.query("SELECT * FROM subscription_account; SELECT * FROM router_audit_event;")),
    ).not.toContain("member-local-profile");
  });

  it("연결 해제 시 계정과 연결된 Router Credential을 한 transaction에서 함께 폐기한다", async () => {
    await connector({
      id: "member-codex-disconnect",
      owner: memberContext,
      executionKind: "agent-runtime",
      capabilities: ["openai-codex"],
    });
    const connected = await connections.connect(memberContext, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      alias: "해제할 Codex",
      connectorId: "member-codex-disconnect",
      profileLocator: "member-disconnect-profile",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
    });
    const commandId = crypto.randomUUID();

    const disconnected = await connections.disconnect(memberContext, {
      commandId,
      accountId: connected.account.account_id,
      expectedVersion: connected.account.version,
    });
    await expect(
      connections.disconnect(memberContext, {
        commandId,
        accountId: connected.account.account_id,
        expectedVersion: connected.account.version,
      }),
    ).resolves.toEqual(disconnected);
    expect(disconnected).toMatchObject({
      account: { account_id: connected.account.account_id, status: "revoked", version: 2 },
      revokedCredentialCount: 1,
    });
    const [credentials] = await database.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE subscription_account_id = $account_id;",
      { account_id: connected.account.account_id },
    );
    expect(credentials).toEqual([
      expect.objectContaining({
        credential_id: connected.binding.credentialId,
        status: "revoked",
        version: 2,
      }),
    ]);
    const credential = credentials[0];
    if (!credential) throw new Error("폐기된 Credential fixture가 없습니다");
    await expect(providers.resolveExecutionMaterial(memberContext, credential, database)).rejects.toThrow(
      "활성 Credential",
    );
  });

  it("Credential 폐기가 실패하면 계정 연결 해제도 원자적으로 되돌린다", async () => {
    await connector({
      id: "member-codex-rollback",
      owner: memberContext,
      executionKind: "agent-runtime",
      capabilities: ["openai-codex"],
    });
    const connected = await connections.connect(memberContext, {
      commandId: crypto.randomUUID(),
      providerId: "openai-codex",
      alias: "원자성 Codex",
      connectorId: "member-codex-rollback",
      profileLocator: "member-rollback-profile",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
    });
    const failing = new SubscriptionConnectionService(database, accounts, {
      revokeSubscriptionAccountCredentials: async () => {
        throw new Error("강제 Credential 폐기 실패");
      },
    } as never);

    await expect(
      failing.disconnect(memberContext, {
        commandId: crypto.randomUUID(),
        accountId: connected.account.account_id,
        expectedVersion: connected.account.version,
      }),
    ).rejects.toThrow("강제 Credential 폐기 실패");
    const [accountRows, credentialRows] = await database.query<
      [Array<{ status: string; version: number }>, Array<{ status: string; version: number }>]
    >(
      `SELECT status, version FROM subscription_account WHERE account_id = $account_id;
       SELECT status, version FROM provider_credential WHERE subscription_account_id = $account_id;`,
      { account_id: connected.account.account_id },
    );
    expect(accountRows).toEqual([{ status: "active", version: 1 }]);
    expect(credentialRows).toEqual([{ status: "active", version: 1 }]);
  });

  it("연결기 실행 종류나 제공자 capability가 다르면 모든 생성을 원자적으로 되돌린다", async () => {
    await connector({
      id: "wrong-runtime",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["anthropic-claude-code"],
    });

    await expect(
      connections.connect(memberContext, {
        commandId: crypto.randomUUID(),
        providerId: "openai-codex",
        alias: "잘못된 연결",
        connectorId: "wrong-runtime",
        profileLocator: "wrong-profile",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow(/실행 종류|capability/u);

    const [accounts, providers, endpoints, credentials] = await database.query<
      [unknown[], unknown[], unknown[], unknown[]]
    >(
      `SELECT * FROM subscription_account;
       SELECT * FROM model_provider;
       SELECT * FROM provider_endpoint;
       SELECT * FROM provider_credential;`,
    );
    expect({ accounts, providers, endpoints, credentials }).toEqual({
      accounts: [],
      providers: [],
      endpoints: [],
      credentials: [],
    });
  });

  it("기존 연결 명령은 model 실행 종류를 원자적으로 거부한다", async () => {
    await connector({
      id: "minimax-model",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["minimax-token-plan"],
      location: "server",
    });
    const base = {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "MiniMax",
      connectorId: "minimax-model",
      profileLocator: "minimax-profile",
      authKind: "subscription-key" as const,
      billingKind: "token-plan",
    };

    await expect(
      connections.connect(memberContext, {
        ...base,
        endpointUrl: "https://api.minimax.io/anthropic",
        protocol: "anthropic",
      }),
    ).rejects.toThrow("agent-runtime");

    const [accounts, providerRows, endpoints, credentials] = await database.query<
      [unknown[], unknown[], unknown[], unknown[]]
    >(
      `SELECT * FROM subscription_account;
       SELECT * FROM model_provider;
       SELECT * FROM provider_endpoint;
       SELECT * FROM provider_credential;`,
    );
    expect({ accounts, providerRows, endpoints, credentials }).toEqual({
      accounts: [],
      providerRows: [],
      endpoints: [],
      credentials: [],
    });
  });

  it("model 구독 키를 공식 endpoint 계보에 연결하고 암호화한 뒤 동일 명령을 재실행한다", async () => {
    await connector({
      id: "minimax-model",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["minimax-token-plan"],
      location: "server",
    });
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      providerId: "minimax-token-plan",
      alias: "MiniMax",
      connectorId: "minimax-model",
      profileLocator: "minimax-account",
      authKind: "subscription-key" as const,
      billingKind: "token-plan",
      secret: "sk-cp-super-secret",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai" as const,
    };

    const connected = await connections.connectModel(memberContext, input);
    await expect(connections.connectModel(memberContext, input)).resolves.toEqual(connected);
    await expect(connections.connectModel(memberContext, { ...input, secret: "different-secret" })).rejects.toThrow(
      "같은 commandId",
    );
    expect(connected.binding).toMatchObject({
      executionKind: "model",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    const [credentials] = await database.query<[ProviderCredential[]]>(
      `SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id;`,
      { organization_id: memberContext.organizationId },
    );
    expect(credentials).toEqual([
      expect.objectContaining({
        credential_id: connected.binding.credentialId,
        credential_type: "subscription_key",
        material_kind: "encrypted_secret",
        secret_version: 1,
        subscription_account_id: connected.account.account_id,
        subscription_connector_id: "minimax-model",
        subscription_scope: "personal",
      }),
    ]);
    const credential = credentials[0];
    if (!credential) throw new Error("model 구독 Credential fixture가 없습니다");
    await expect(providers.resolveExecutionMaterial(memberContext, credential, database)).resolves.toEqual({
      kind: "encrypted_secret",
      secret: "sk-cp-super-secret",
      secretVersion: 1,
    });
    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM router_audit_event; SELECT * FROM subscription_audit_event;",
      ),
    );
    expect(raw).not.toContain("sk-cp-super-secret");
    expect(raw).not.toContain("minimax-account");
  });

  it("여러 공식 endpoint가 있는 model 제공자는 allowlist 안의 endpoint와 protocol을 명시해야 한다", async () => {
    await connector({
      id: "minimax-model",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["minimax-token-plan"],
      location: "server",
    });
    const base = {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "MiniMax",
      connectorId: "minimax-model",
      profileLocator: "minimax-profile",
      authKind: "subscription-key" as const,
      billingKind: "token-plan",
      secret: "sk-cp-endpoint-test",
    };

    await expect(connections.connectModel(memberContext, base)).rejects.toThrow("endpoint 선택");
    const connected = await connections.connectModel(memberContext, {
      ...base,
      commandId: crypto.randomUUID(),
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
    expect(connected.binding).toMatchObject({
      executionKind: "model",
      endpointUrl: "https://api.minimax.io/v1",
      protocol: "openai",
    });
  });

  it("대화형 코딩 전용 구독은 일반 direct model backend 연결을 fail-closed한다", async () => {
    await connector({
      id: "kimi-interactive",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["kimi-coding-plan"],
    });

    await expect(
      connections.connectModel(memberContext, {
        commandId: crypto.randomUUID(),
        providerId: "kimi-coding-plan",
        alias: "Kimi Code",
        connectorId: "kimi-interactive",
        profileLocator: "kimi-interactive-account",
        authKind: "api-key",
        billingKind: "membership-subscription",
        secret: "kimi-interactive-secret",
      }),
    ).rejects.toThrow(/실제 연결|검증되지/u);

    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM subscription_account; SELECT * FROM model_provider; SELECT * FROM provider_endpoint; SELECT * FROM provider_credential; SELECT * FROM credential_secret_version;",
      ),
    );
    expect(raw).toBe("[[],[],[],[],[]]");
    expect(raw).not.toContain("kimi-interactive-secret");
  });

  it("다른 조직 Connector와 Provider capability가 다른 Connector로 model 구독을 만들지 않는다", async () => {
    const outsider = await identities.registerPersonalUser({
      email: `outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Outsider",
    });
    const outsiderContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    await connector({
      id: "outsider-minimax",
      owner: outsiderContext,
      executionKind: "model",
      capabilities: ["minimax-token-plan"],
    });
    const base = {
      providerId: "minimax-token-plan",
      alias: "격리된 MiniMax",
      profileLocator: "isolated-minimax",
      authKind: "subscription-key" as const,
      billingKind: "token-plan",
      secret: "isolated-secret",
      endpointUrl: "https://api.minimax.io/anthropic",
      protocol: "anthropic" as const,
    };

    await expect(
      connections.connectModel(memberContext, {
        ...base,
        commandId: crypto.randomUUID(),
        connectorId: "outsider-minimax",
      }),
    ).rejects.toThrow("Connector");

    await connector({
      id: "wrong-provider-model",
      owner: memberContext,
      executionKind: "model",
      capabilities: ["opencode-go"],
    });
    await expect(
      connections.connectModel(memberContext, {
        ...base,
        commandId: crypto.randomUUID(),
        connectorId: "wrong-provider-model",
      }),
    ).rejects.toThrow("capability");

    const [accounts, providersRows, endpoints, credentials, secrets] = await database.query<
      [unknown[], unknown[], unknown[], unknown[], unknown[]]
    >(
      `SELECT * FROM subscription_account WHERE organization_id = $organization_id;
       SELECT * FROM model_provider WHERE organization_id = $organization_id;
       SELECT * FROM provider_endpoint WHERE organization_id = $organization_id;
       SELECT * FROM provider_credential WHERE organization_id = $organization_id;
       SELECT * FROM credential_secret_version WHERE organization_id = $organization_id;`,
      { organization_id: memberContext.organizationId },
    );
    expect({ accounts, providersRows, endpoints, credentials, secrets }).toEqual({
      accounts: [],
      providersRows: [],
      endpoints: [],
      credentials: [],
      secrets: [],
    });
  });

  it("Z.AI Coding Plan과 허용되지 않은 인증·결제 유형을 구분한다", async () => {
    await connector({
      id: "zai-model",
      owner: ownerContext,
      executionKind: "model",
      capabilities: ["zai-coding-plan"],
      location: "server",
    });
    await expect(
      connections.connectModel(ownerContext, {
        commandId: crypto.randomUUID(),
        providerId: "zai-coding-plan",
        alias: "개인 Z.AI",
        connectorId: "zai-model",
        profileLocator: "zai-profile",
        authKind: "api-key",
        billingKind: "coding-plan",
        secret: "zai-secret",
        endpointUrl: "https://api.z.ai/api/coding/paas/v4",
        protocol: "openai",
      }),
    ).resolves.toMatchObject({
      account: { provider_id: "zai-coding-plan", status: "active" },
      binding: {
        endpointUrl: "https://api.z.ai/api/coding/paas/v4",
        protocol: "openai",
        executionKind: "model",
      },
    });

    await connector({
      id: "minimax-invalid-policy",
      owner: ownerContext,
      executionKind: "model",
      capabilities: ["minimax-token-plan"],
    });
    const minimax = {
      commandId: crypto.randomUUID(),
      providerId: "minimax-token-plan",
      alias: "MiniMax 정책 검증",
      connectorId: "minimax-invalid-policy",
      profileLocator: "minimax-policy-profile",
      authKind: "api-key" as const,
      billingKind: "token-plan",
      secret: "minimax-policy-secret",
      endpointUrl: "https://api.minimax.io/anthropic",
      protocol: "anthropic" as const,
    };
    await expect(connections.connectModel(ownerContext, minimax)).rejects.toThrow("인증 방식");
    await expect(
      connections.connectModel(ownerContext, {
        ...minimax,
        commandId: crypto.randomUUID(),
        authKind: "subscription-key",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow("결제 유형");

    await connector({
      id: "codex-invalid-auth",
      owner: ownerContext,
      executionKind: "agent-runtime",
      capabilities: ["openai-codex"],
    });
    await expect(
      connections.connect(ownerContext, {
        commandId: crypto.randomUUID(),
        providerId: "openai-codex",
        alias: "잘못된 인증",
        connectorId: "codex-invalid-auth",
        profileLocator: "codex-profile",
        authKind: "acp",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow("인증 방식");
  });
});
