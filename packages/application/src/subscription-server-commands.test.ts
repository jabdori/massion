import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import {
  ServerConnectorAuthenticationRequiredError,
  ServerConnectorPaidSubscriptionRequiredError,
  ServerConnectorQuotaObservationUnavailableError,
} from "@massion/subscriptions";

import { registerApplicationDomainCommands } from "./adapters/domain.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { applicationErrorToHttpStatus, ApplicationError } from "./errors.js";

describe("Application 서버 구독 연결 명령", () => {
  it("Codex 직접 quota 관측 불가는 재로그인 요구 없이 재시도 가능한 unavailable 계약으로 변환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "quota-command@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: {
        prepare: vi.fn(),
        attest: vi.fn().mockRejectedValue(new ServerConnectorQuotaObservationUnavailableError()),
        offline: vi.fn(),
      },
    } as never);

    const failure = await registry
      .dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: randomUUID(),
        correlationId: "correlation-quota-12345678",
        operation: "subscription.server.attest",
        payload: { connectorId: "server-quota-12345678" },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect(failure).toMatchObject({
      category: "unavailable",
      severity: "warning",
      retryable: true,
      operatorCode: "APP_SUBSCRIPTION_QUOTA_UNAVAILABLE",
      correlationId: "correlation-quota-12345678",
    });
    expect(applicationErrorToHttpStatus(failure as ApplicationError)).toBe(503);
  });

  it("Codex profile 재인증 필요 오류만 공개 가능한 authentication 계약으로 변환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "reauth-command@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const privateConnectorId = "server-private-connector-12345678";
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: {
        prepare: vi.fn(),
        attest: vi
          .fn()
          .mockRejectedValue(new ServerConnectorAuthenticationRequiredError("openai-codex", privateConnectorId)),
        offline: vi.fn(),
      },
    } as never);

    const failure = await registry
      .dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: randomUUID(),
        correlationId: "correlation-reauth-12345678",
        operation: "subscription.server.attest",
        payload: { connectorId: privateConnectorId },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect(failure).toMatchObject({
      category: "authentication",
      severity: "warning",
      retryable: false,
      operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
      correlationId: "correlation-reauth-12345678",
    });
    expect(applicationErrorToHttpStatus(failure as ApplicationError)).toBe(401);
    expect(JSON.stringify((failure as ApplicationError).publicView())).not.toContain(privateConnectorId);
  });

  it("Codex 유료 구독 불가 오류는 재인증이 아닌 validation 계약으로 변환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "paid-plan-command@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const privateConnectorId = "server-paid-plan-connector-12345678";
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: {
        prepare: vi.fn(),
        attest: vi
          .fn()
          .mockRejectedValue(new ServerConnectorPaidSubscriptionRequiredError("openai-codex", privateConnectorId)),
        offline: vi.fn(),
      },
    } as never);

    const failure = await registry
      .dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: randomUUID(),
        correlationId: "correlation-paid-plan-12345678",
        operation: "subscription.server.attest",
        payload: { connectorId: privateConnectorId },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect(failure).toMatchObject({
      category: "validation",
      severity: "warning",
      retryable: false,
      operatorCode: "APP_SUBSCRIPTION_PAID_PLAN_REQUIRED",
      correlationId: "correlation-paid-plan-12345678",
    });
    expect(applicationErrorToHttpStatus(failure as ApplicationError)).toBe(400);
    expect(JSON.stringify((failure as ApplicationError).publicView())).not.toContain(privateConnectorId);
  });

  it("실패한 Codex 건강 증명은 같은 command로 재인증 뒤 재개할 수 있다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "reauth-retry-command@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const connectorId = "server-retry-connector-12345678";
    const attest = vi
      .fn()
      .mockRejectedValueOnce(new ServerConnectorAuthenticationRequiredError("openai-codex", connectorId))
      .mockResolvedValueOnce({
        connectorId,
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        version: "0.144.1",
        capabilities: ["openai-codex"],
        status: "ready",
        trustOrigin: "server-managed",
      });
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: { prepare: vi.fn(), attest, offline: vi.fn() },
    } as never);
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      operation: "subscription.server.attest",
      payload: { connectorId },
    };

    await expect(registry.dispatch(context, ["subscription:write"], command)).rejects.toMatchObject({
      operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
    });
    await expect(registry.dispatch(context, ["subscription:write"], command)).resolves.toMatchObject({
      outcome: "succeeded",
      data: { connectorId, status: "ready" },
    });
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it("실패한 새 Codex 계정 준비는 같은 command로 재개할 수 있다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "prepare-retry-command@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const connectorId = "server-prepare-retry-12345678";
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("일시적인 Codex 준비 실패"))
      .mockResolvedValueOnce({
        account: {
          account_id: "account-prepare-retry-12345678",
          provider_id: "openai-codex",
          alias: "새 Codex",
          scope: "personal",
          connector_id: connectorId,
          billing_kind: "consumer-subscription",
          status: "offline",
          consent_version: 0,
          version: 1,
        },
        connector: { status: "offline" },
        profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
      });
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: { prepare, attest: vi.fn(), offline: vi.fn() },
    } as never);
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: randomUUID(),
      correlationId: randomUUID(),
      operation: "subscription.server.prepare",
      payload: {
        providerId: "openai-codex",
        alias: "새 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      },
    };

    await expect(registry.dispatch(context, ["subscription:write"], command)).rejects.toBeInstanceOf(ApplicationError);
    await expect(registry.dispatch(context, ["subscription:write"], command)).resolves.toMatchObject({
      outcome: "succeeded",
      data: { accountId: "account-prepare-retry-12345678", connectorStatus: "offline" },
    });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("prepare→로그인 후 attest→offline을 redacted Application 계약으로 연결한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "server-command@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const account = {
      account_id: "account-12345678",
      organization_id: "organization-secret",
      owner_user_id: "owner-secret",
      provider_id: "openai-codex",
      alias: "개인 Codex",
      scope: "personal" as const,
      connector_id: "server-connector-12345678",
      profile_fingerprint: "profile-secret",
      billing_kind: "consumer-subscription",
      status: "offline" as const,
      consent_version: 0,
      version: 1,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const connector = {
      connectorId: "server-connector-12345678",
      providerId: "openai-codex",
      executionKind: "agent-runtime" as const,
      runtimeId: "codex",
      runtimeArtifactDigest: "artifact-secret",
      version: "0.144.1",
      capabilities: ["openai-codex"],
      status: "offline" as const,
      trustOrigin: "server-managed" as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const prepare = vi.fn().mockResolvedValue({
      account,
      connector,
      binding: {
        providerId: "openai-codex",
        endpointId: "endpoint-secret",
        endpointUrl: "massion://secret",
        protocol: "codex-app-server",
        executionKind: "agent-runtime",
        credentialId: "credential-secret",
      },
      profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
    });
    const attest = vi.fn().mockResolvedValue({
      ...connector,
      status: "ready",
      processGeneration: 1,
      quotaObservation: { source: "direct", attestedAt: "2026-07-15T00:00:00.000Z" },
    });
    const offline = vi.fn().mockResolvedValue(connector);
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: { prepare, attest, offline },
    } as never);
    const dispatch = async (operation: string, payload: unknown) =>
      await registry.dispatch(context, ["subscription:write"], {
        schemaVersion: "massion.application.v1",
        commandId: randomUUID(),
        correlationId: randomUUID(),
        operation,
        payload,
      });

    await expect(
      dispatch("subscription.data-disclosure.acknowledge", {
        providerId: "openai-codex",
        version: "openai-codex-data-controls-2026-07-13",
      }),
    ).rejects.toThrow("지원하지 않는 Application operation");
    const prepared = await dispatch("subscription.server.prepare", {
      providerId: "openai-codex",
      alias: "개인 Codex",
      authKind: "device-code",
      billingKind: "consumer-subscription",
    });
    const ready = await dispatch("subscription.server.attest", { connectorId: connector.connectorId });
    const stopped = await dispatch("subscription.server.offline", { connectorId: connector.connectorId });

    expect(prepared).toMatchObject({
      resource: { type: "SubscriptionAccount", id: account.account_id, revision: 1 },
      data: {
        accountId: account.account_id,
        connectorId: connector.connectorId,
        status: "offline",
        connectorStatus: "offline",
        loginRequired: true,
        profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
      },
    });
    expect(ready).toMatchObject({
      data: {
        connectorId: connector.connectorId,
        status: "ready",
        quotaObservation: { source: "direct", attestedAt: "2026-07-15T00:00:00.000Z" },
      },
    });
    expect(stopped).toMatchObject({ data: { connectorId: connector.connectorId, status: "offline" } });
    expect(prepare).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ providerId: "openai-codex", authKind: "device-code" }),
    );
    const serialized = JSON.stringify([prepared, ready, stopped]);
    for (const secret of [
      "organization-secret",
      "owner-secret",
      "profile-secret",
      "artifact-secret",
      "endpoint-secret",
      "credential-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("model 구독 secret은 서비스에만 전달하고 응답·명령 저장소·감사 기록에서 제거한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "model-command@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const secret = "minimax-subscription-secret-never-persist";
    const connectModel = vi.fn().mockResolvedValue({
      account: {
        account_id: "account-model-12345678",
        provider_id: "minimax-token-plan",
        alias: "개인 MiniMax",
        scope: "personal",
        connector_id: "server-model-12345678",
        billing_kind: "token-plan",
        status: "active",
        consent_version: 0,
        version: 2,
      },
      connector: {
        connectorId: "server-model-12345678",
        providerId: "minimax-token-plan",
        executionKind: "model",
        runtimeId: "openai-model",
        version: "1.0.0+openai.3.0.83",
        capabilities: ["minimax-token-plan"],
        status: "ready",
        trustOrigin: "server-managed",
        processGeneration: 1,
      },
      binding: {
        providerId: "minimax-token-plan",
        endpointId: "endpoint-private",
        endpointUrl: "https://api.minimax.io/v1",
        protocol: "openai",
        executionKind: "model",
        credentialId: "credential-private",
      },
    });
    registerApplicationDomainCommands(registry, {
      subscriptionServerConnections: {
        connectModel,
        prepare: vi.fn(),
        attest: vi.fn(),
        offline: vi.fn(),
      },
    } as never);

    const response = await registry.dispatch(context, ["subscription:write"], {
      schemaVersion: "massion.application.v1",
      commandId: randomUUID(),
      correlationId: randomUUID(),
      operation: "subscription.server.connect-model",
      payload: {
        providerId: "minimax-token-plan",
        alias: "개인 MiniMax",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret,
        endpointUrl: "https://api.minimax.io/v1",
        protocol: "openai",
      },
    });

    expect(connectModel).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        providerId: "minimax-token-plan",
        secret,
        endpointUrl: "https://api.minimax.io/v1",
        protocol: "openai",
      }),
    );
    expect(response).toMatchObject({
      resource: { type: "SubscriptionAccount", id: "account-model-12345678", revision: 2 },
      data: {
        providerId: "minimax-token-plan",
        connectorId: "server-model-12345678",
        status: "active",
        connectorStatus: "ready",
      },
    });
    const persisted = JSON.stringify(
      await database.query("SELECT * FROM application_command; SELECT * FROM application_command_event;"),
    );
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("credential-private");
    expect(persisted).not.toContain("endpoint-private");
  });
});
