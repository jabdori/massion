import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { registerApplicationDomainCommands } from "./adapters/domain.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";

describe("Application 서버 구독 연결 명령", () => {
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
    const attest = vi.fn().mockResolvedValue({ ...connector, status: "ready", processGeneration: 1 });
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
    expect(ready).toMatchObject({ data: { connectorId: connector.connectorId, status: "ready" } });
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
