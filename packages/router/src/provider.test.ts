import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ProviderService } from "./provider.js";
import { CredentialVault } from "./vault.js";

describe("Provider와 암호화 Credential lifecycle", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: ProviderService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
  });

  afterEach(async () => database.close());

  async function providerEndpoint() {
    const provider = await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai",
      displayName: "OpenAI",
      adapterKind: "ai-sdk",
    });
    const endpoint = await service.registerEndpoint(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider.provider_id,
      name: "OpenAI API",
      baseUrl: "https://api.openai.com/v1",
      local: false,
    });
    return { provider: provider.provider, endpoint: endpoint.endpoint };
  }

  it("Provider·Endpoint와 여러 Credential을 등록하되 평문을 DB·audit에 남기지 않는다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const first = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account-a",
      credentialType: "api_key",
      secret: "sk-account-a",
      priority: 1,
      weight: 1,
    });
    const second = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account-b",
      credentialType: "api_key",
      secret: "sk-account-b",
      priority: 1,
      weight: 2,
    });

    expect(await service.revealSecret(context, first.credential.credential_id)).toBe("sk-account-a");
    expect(await service.revealSecret(context, second.credential.credential_id)).toBe("sk-account-b");
    const raw = JSON.stringify(
      await database.query(
        "SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM router_audit_event;",
      ),
    );
    expect(raw).not.toContain("sk-account-a");
    expect(raw).not.toContain("sk-account-b");
    await expect(service.listProviders(context)).resolves.toEqual([
      expect.objectContaining({ provider_id: provider.provider_id, display_name: "OpenAI" }),
    ]);
    await expect(service.listEndpoints(context, provider.provider_id)).resolves.toEqual([
      expect.objectContaining({ endpoint_id: endpoint.endpoint_id, base_url: "https://api.openai.com/v1" }),
    ]);
    expect(await service.listCredentials(context, provider.provider_id)).toHaveLength(2);
  });

  it("secret 회전은 새 immutable version을 만들고 revoke 후 복호화를 거부한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const added = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "account",
      credentialType: "oauth",
      secret: "token-v1",
      priority: 1,
      weight: 1,
    });
    const rotated = await service.rotateCredential(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 1,
      secret: "token-v2",
    });

    expect(rotated.credential.secret_version).toBe(2);
    expect(await service.revealSecret(context, added.credential.credential_id)).toBe("token-v2");
    const revoked = await service.revokeCredential(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 2,
    });
    expect(revoked.credential.status).toBe("revoked");
    await expect(service.revealSecret(context, added.credential.credential_id)).rejects.toThrow("활성");
  });

  it("quota limit·remaining·reset을 version 선행조건으로 갱신한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    const added = await service.addCredential(context, {
      commandId: crypto.randomUUID(),
      providerId: provider.provider_id,
      endpointId: endpoint.endpoint_id,
      label: "quota-account",
      credentialType: "api_key",
      secret: "secret",
      priority: 1,
      weight: 1,
    });
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const updated = await service.updateCredentialQuota(context, {
      commandId: crypto.randomUUID(),
      credentialId: added.credential.credential_id,
      expectedVersion: 1,
      limit: 1_000,
      remaining: 750,
      resetAt,
    });

    expect(updated.credential.version).toBe(2);
    expect(updated.credential.quota_limit).toBe(1_000);
    expect(updated.credential.quota_remaining).toBe(750);
    expect(new Date(String(updated.credential.quota_reset_at)).toISOString()).toBe(resetAt);
    await expect(
      service.updateCredentialQuota(context, {
        commandId: crypto.randomUUID(),
        credentialId: added.credential.credential_id,
        expectedVersion: 1,
        limit: 1_000,
        remaining: 700,
        resetAt,
      }),
    ).rejects.toThrow("version");
  });

  it("비공식 소비자 구독 credential type과 cross-tenant 접근을 거부한다", async () => {
    const { provider, endpoint } = await providerEndpoint();
    await expect(
      service.addCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: provider.provider_id,
        endpointId: endpoint.endpoint_id,
        label: "chatgpt",
        credentialType: "consumer_subscription" as "api_key",
        secret: "cookie",
        priority: 1,
        weight: 1,
      }),
    ).rejects.toThrow("지원하지 않는 Credential type");
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(
      service.listCredentials({ ...otherContext, organizationId: context.organizationId }, provider.provider_id),
    ).rejects.toThrow("TenantContext");
  });

  it("external gateway는 지원 gateway kind를 필수로 하고 일반 Provider에는 이를 허용하지 않는다", async () => {
    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "gateway",
      displayName: "Gateway",
      adapterKind: "external-gateway",
    });
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "gateway",
        name: "Missing kind",
        baseUrl: "https://gateway.example/v1",
        local: false,
      }),
    ).rejects.toThrow("gatewayKind");
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "gateway",
        name: "Unknown",
        baseUrl: "https://gateway.example/v1",
        local: false,
        gatewayKind: "unknown" as "litellm",
      }),
    ).rejects.toThrow("지원하지 않는 Gateway");

    await service.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "direct",
      displayName: "Direct",
      adapterKind: "openai-compatible",
    });
    await expect(
      service.registerEndpoint(context, {
        commandId: crypto.randomUUID(),
        providerId: "direct",
        name: "Wrong gateway metadata",
        baseUrl: "https://direct.example/v1",
        local: false,
        gatewayKind: "portkey",
      }),
    ).rejects.toThrow("external-gateway");
  });
});
