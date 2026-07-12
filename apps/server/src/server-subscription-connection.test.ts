import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApplicationCommandRegistry,
  ApplicationCommandStore,
  registerApplicationDomainCommands,
  SubscriptionConnectionService,
} from "@massion/application";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import { MassionModelFactory, OpenAICompatibleModelBuilder } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import {
  ServerConnectorProvisioningService,
  SubscriptionAccountService,
  SubscriptionQuotaService,
} from "@massion/subscriptions";

import { BuiltinModelRouteAssembler } from "./server-model-route-assembler.js";
import { BundledServerConnectorRuntimeAttestor } from "./server-runtime-attestor.js";
import { ServerSubscriptionConnectionService } from "./server-subscription-connection.js";
import { prepareSubscriptionProfileRoot } from "./subscription-profile.js";

const context: TenantContext = {
  userId: "user-12345678",
  organizationId: "organization-12345678",
  membershipId: "membership-12345678",
  role: "owner",
};

const observedMiniMax = {
  modelId: "MiniMax-M2.7",
  availableModelIds: ["MiniMax-M2.7", "MiniMax-M3"],
  observedAt: "2026-07-12T00:00:00.000Z",
  source: "https://api.minimax.io/v1/models" as const,
};

function miniMaxVerifier() {
  return { verify: vi.fn().mockResolvedValue(observedMiniMax) };
}

describe("로컬 서버 구독 계정 준비", () => {
  it("서버 관리 계정 연결 해제는 Provider logout·Connector 폐기·profile 삭제를 재시도 가능하게 완료한다", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "massion-server-disconnect-"));
    const root = await realpath(temporaryRoot);
    const profileRoot = join(root, "profiles");
    const accountProfile = await prepareSubscriptionProfileRoot(
      profileRoot,
      context.organizationId,
      "account-disconnect-12345678",
    );
    await writeFile(join(accountProfile, "auth.json"), "private-login-state", { mode: 0o600 });
    const disconnect = vi.fn().mockResolvedValue({
      account: {
        account_id: "account-disconnect-12345678",
        organization_id: context.organizationId,
        provider_id: "openai-codex",
        connector_id: "server-disconnect-12345678",
        status: "revoked",
        version: 2,
      },
      revokedCredentialCount: 1,
    });
    const revoke = vi.fn().mockResolvedValue({ connectorId: "server-disconnect-12345678", status: "revoked" });
    const logout = vi.fn().mockResolvedValue(undefined);
    const service = new ServerSubscriptionConnectionService(
      { provision: vi.fn(), attestHealth: vi.fn(), revoke, markOffline: vi.fn() } as never,
      { connect: vi.fn(), connectModel: vi.fn(), disconnect } as never,
      undefined,
      undefined,
      undefined,
      {
        profileRoot,
        connectors: {
          get: vi.fn().mockResolvedValue({
            connector_id: "server-disconnect-12345678",
            organization_id: context.organizationId,
            trust_origin: "server-managed",
            location: "server",
          }),
        },
        logout,
      },
    );
    const input = {
      commandId: "disconnect-server-account-12345678",
      accountId: "account-disconnect-12345678",
      expectedVersion: 1,
    };

    await expect(service.disconnect(context, input)).resolves.toMatchObject({ revokedCredentialCount: 1 });
    await expect(lstat(accountProfile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.disconnect(context, input)).resolves.toMatchObject({ revokedCredentialCount: 1 });

    expect(logout).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledWith("openai-codex", {
      organizationId: context.organizationId,
      accountId: "account-disconnect-12345678",
      profileRoot: accountProfile,
    });
    expect(revoke).toHaveBeenCalledWith(context, {
      commandId: "disconnect-server-account-12345678:connector-revoke",
      connectorId: "server-disconnect-12345678",
    });
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("Provider runtime을 offline으로 준비한 뒤 계정·라우팅 연결을 만들고 불투명 profile handle만 반환한다", async () => {
    const provision = vi
      .fn()
      .mockImplementation((_context, input) => Promise.resolve({ connectorId: input.connectorId, status: "offline" }));
    const connect = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        account: { account_id: "account-12345678", connector_id: input.connectorId, status: "offline", version: 1 },
        binding: { providerId: input.providerId, executionKind: "agent-runtime" },
      }),
    );
    const service = new ServerSubscriptionConnectionService(
      { provision, attestHealth: vi.fn(), revoke: vi.fn(), markOffline: vi.fn() } as never,
      { connect } as never,
    );

    const result = await service.prepare(context, {
      commandId: "command-12345678",
      providerId: "openai-codex",
      alias: "개인 Codex",
      authKind: "device-code",
      billingKind: "consumer-subscription",
    });

    const connectorId = vi.mocked(provision).mock.calls[0]?.[1].connectorId;
    expect(connectorId).toMatch(/^server-[a-f0-9]{40}$/u);
    expect(provision).toHaveBeenCalledWith(context, {
      commandId: "command-12345678:connector",
      connectorId,
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
    });
    expect(connect).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        commandId: "command-12345678:account",
        providerId: "openai-codex",
        connectorId,
        profileLocator: `massion-server:${connectorId}`,
      }),
    );
    expect(result).toMatchObject({
      account: { account_id: "account-12345678", status: "offline" },
      connector: { status: "offline" },
      profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("/var/");
  });

  it("지원하지 않는 서버 runtime과 소비자 구독이 아닌 결제를 연결 전에 거부한다", async () => {
    const provision = vi.fn();
    const service = new ServerSubscriptionConnectionService(
      { provision, attestHealth: vi.fn(), revoke: vi.fn(), markOffline: vi.fn() } as never,
      { connect: vi.fn() } as never,
    );

    await expect(
      service.prepare(context, {
        commandId: "command-12345678",
        providerId: "google-gemini-cli-enterprise",
        alias: "Gemini",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow("Codex와 Claude");
    await expect(
      service.prepare(context, {
        commandId: "command-12345678",
        providerId: "openai-codex",
        alias: "API",
        authKind: "api-key",
        billingKind: "api-usage",
      }),
    ).rejects.toThrow("소비자 구독");
    await expect(
      service.prepare(context, {
        commandId: "command-claude-policy",
        providerId: "anthropic-claude-code",
        alias: "Claude",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow(/승인|Anthropic/u);
    expect(provision).not.toHaveBeenCalled();
  });

  it("계정 연결이 실패하면 생성한 Connector를 감사 가능한 offline 상태로 되돌려 재시도 가능하게 둔다", async () => {
    const markOffline = vi.fn().mockResolvedValue({ status: "offline" });
    const service = new ServerSubscriptionConnectionService(
      {
        provision: vi
          .fn()
          .mockImplementation((_context, input) =>
            Promise.resolve({ connectorId: input.connectorId, status: "offline" }),
          ),
        attestHealth: vi.fn(),
        revoke: vi.fn(),
        markOffline,
      } as never,
      { connect: vi.fn().mockRejectedValue(new Error("계정 연결 실패")) } as never,
    );

    await expect(
      service.prepare(context, {
        commandId: "command-rollback-1",
        providerId: "openai-codex",
        alias: "Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow("계정 연결 실패");
    expect(markOffline).toHaveBeenCalledWith(context, {
      commandId: "command-rollback-1:compensate-offline",
      connectorId: expect.stringMatching(/^server-/u),
    });
  });

  it("로그인 완료 후 건강 증명과 명시적 offline 전이를 서버 정본에 위임한다", async () => {
    const attestHealth = vi.fn().mockResolvedValue({ connectorId: "server-1", status: "ready" });
    const markOffline = vi.fn().mockResolvedValue({ connectorId: "server-1", status: "offline" });
    const service = new ServerSubscriptionConnectionService(
      { provision: vi.fn(), attestHealth, revoke: vi.fn(), markOffline } as never,
      { connect: vi.fn() } as never,
    );

    await expect(service.attest(context, { commandId: "attest-1", connectorId: "server-1" })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(service.offline(context, { commandId: "offline-1", connectorId: "server-1" })).resolves.toMatchObject({
      status: "offline",
    });
    expect(attestHealth).toHaveBeenCalledWith(context, { commandId: "attest-1", connectorId: "server-1" });
    expect(markOffline).toHaveBeenCalledWith(context, { commandId: "offline-1", connectorId: "server-1" });
  });

  it("Codex attest는 계정별 model/list 선택과 evidence Core route 조립까지 완료해야 ready를 반환한다", async () => {
    const attestHealth = vi.fn().mockResolvedValue({
      connectorId: "server-codex-1",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
      status: "ready",
    });
    const observed = {
      modelId: "gpt-5.6-sol",
      catalogId: "gpt-5.6-sol",
      hidden: false,
      isDefault: true,
      inputModalities: ["text", "image"],
      observedAt: "2026-07-12T00:00:00.000Z",
      runtimeVersion: "0.144.1",
      runtimeArtifactDigest: "a".repeat(64),
    } as const;
    const readModel = vi.fn().mockResolvedValue(observed);
    const assembleCodex = vi.fn().mockResolvedValue({
      modelId: "gpt-5.6-sol",
      modelProfileId: "profile-gpt-56-sol",
      routeNames: ["orchestration-balanced", "planning-quality"],
    });
    const service = new ServerSubscriptionConnectionService(
      { provision: vi.fn(), attestHealth, revoke: vi.fn(), markOffline: vi.fn() } as never,
      { connect: vi.fn() } as never,
      {
        requireBindable: vi.fn().mockResolvedValue({
          account_id: "account-codex-1",
          provider_id: "openai-codex",
          connector_id: "server-codex-1",
          status: "offline",
          version: 1,
        }),
        requireUsable: vi.fn().mockResolvedValue({
          account_id: "account-codex-1",
          provider_id: "openai-codex",
          connector_id: "server-codex-1",
          status: "active",
          version: 2,
        }),
      } as never,
      { assemble: vi.fn(), assembleCodex } as never,
      { readModel } as never,
    );

    await expect(
      service.attest(context, {
        commandId: "attest-codex-1",
        connectorId: "server-codex-1",
        accountId: "account-codex-1",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      modelRuntime: { modelId: "gpt-5.6-sol", modelProfileId: "profile-gpt-56-sol" },
    });
    expect(readModel).toHaveBeenCalledWith({
      organizationId: context.organizationId,
      accountId: "account-codex-1",
    });
    expect(assembleCodex).toHaveBeenCalledWith(context, {
      commandId: "attest-codex-1:routes",
      accountId: "account-codex-1",
      observed,
    });
  });

  it("MiniMax secret을 공식 OpenAI 호환 runtime에 암호화 연결하고 건강 증명 후 active로 반환한다", async () => {
    const secret = "minimax-server-secret-never-returned";
    const provision = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        connectorId: input.connectorId,
        providerId: input.providerId,
        executionKind: "model",
        runtimeId: input.runtimeId,
        status: "offline",
      }),
    );
    const connectModel = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        account: {
          account_id: "account-model-12345678",
          provider_id: input.providerId,
          connector_id: input.connectorId,
          status: "offline",
          version: 1,
        },
        binding: {
          providerId: input.providerId,
          endpointId: "endpoint-minimax-openai",
          endpointUrl: input.endpointUrl,
          protocol: input.protocol,
          executionKind: "model",
        },
      }),
    );
    const attestHealth = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        connectorId: input.connectorId,
        providerId: "minimax-token-plan",
        executionKind: "model",
        runtimeId: "openai-model",
        status: "ready",
      }),
    );
    const requireUsable = vi.fn().mockImplementation(() =>
      Promise.resolve({
        account_id: "account-model-12345678",
        provider_id: "minimax-token-plan",
        connector_id: vi.mocked(provision).mock.calls[0]?.[1].connectorId,
        status: "active",
        version: 2,
      }),
    );
    const assemble = vi.fn().mockResolvedValue({
      modelId: "MiniMax-M2.7",
      modelProfileId: "profile-minimax-m27",
      routeNames: ["orchestration-balanced", "planning-quality"],
    });
    const observed = {
      modelId: "MiniMax-M2.7",
      availableModelIds: ["MiniMax-M2.7", "MiniMax-M3"],
      observedAt: "2026-07-12T00:00:00.000Z",
      source: "https://api.minimax.io/v1/models" as const,
    };
    const verify = vi.fn().mockResolvedValue(observed);
    const service = new ServerSubscriptionConnectionService(
      {
        provision,
        attestHealth,
        revoke: vi.fn().mockResolvedValue({ status: "revoked" }),
        markOffline: vi.fn(),
      } as never,
      { connect: vi.fn(), connectModel } as never,
      {
        requireBindable: vi.fn().mockImplementation(() =>
          Promise.resolve({
            account_id: "account-model-12345678",
            provider_id: "minimax-token-plan",
            connector_id: vi.mocked(provision).mock.calls[0]?.[1].connectorId,
            status: "offline",
            version: 1,
          }),
        ),
        requireUsable,
      } as never,
      { assemble } as never,
      undefined,
      undefined,
      { verify },
    );

    const result = await service.connectModel(context, {
      commandId: "model-command-12345678",
      providerId: "minimax-token-plan",
      alias: "개인 MiniMax",
      authKind: "subscription-key",
      billingKind: "token-plan",
      secret,
    });

    const selectedConnectorId = vi.mocked(provision).mock.calls[0]?.[1].connectorId;
    expect(provision).toHaveBeenCalledWith(context, {
      commandId: "model-command-12345678:connector",
      connectorId: selectedConnectorId,
      providerId: "minimax-token-plan",
      executionKind: "model",
      runtimeId: "openai-model",
    });
    expect(connectModel).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        commandId: "model-command-12345678:account",
        connectorId: selectedConnectorId,
        secret,
        endpointUrl: "https://api.minimax.io/v1",
        protocol: "openai",
      }),
    );
    expect(verify).toHaveBeenCalledWith({
      endpointUrl: "https://api.minimax.io/v1",
      secret,
      requiredModelId: "MiniMax-M2.7",
    });
    expect(attestHealth).toHaveBeenCalledWith(context, {
      commandId: "model-command-12345678:attest:v1",
      connectorId: selectedConnectorId,
    });
    expect(requireUsable).toHaveBeenCalledWith(context, "account-model-12345678", "personal");
    expect(assemble).toHaveBeenCalledWith(context, {
      commandId: "model-command-12345678:routes",
      providerId: "minimax-token-plan",
      endpointId: expect.any(String),
      accountId: "account-model-12345678",
      observed,
    });
    expect(result).toMatchObject({
      account: { status: "active", version: 2 },
      connector: { status: "ready", runtimeId: "openai-model" },
      binding: { protocol: "openai", endpointUrl: "https://api.minimax.io/v1" },
      modelRuntime: { modelId: "MiniMax-M2.7", modelProfileId: "profile-minimax-m27" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("MiniMax Credential 실인증이 실패하면 영속 Connector·계정 생성 전에 중단한다", async () => {
    const provision = vi.fn();
    const service = new ServerSubscriptionConnectionService(
      { provision, attestHealth: vi.fn(), revoke: vi.fn(), markOffline: vi.fn() } as never,
      { connect: vi.fn(), connectModel: vi.fn() } as never,
      { requireBindable: vi.fn(), requireUsable: vi.fn() } as never,
      { assemble: vi.fn() } as never,
      undefined,
      undefined,
      { verify: vi.fn().mockRejectedValue(new Error("인증 또는 model 관측 실패")) },
    );

    await expect(
      service.connectModel(context, {
        commandId: "model-invalid-key-12345678",
        providerId: "minimax-token-plan",
        alias: "MiniMax",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret: "invalid-secret",
      }),
    ).rejects.toThrow("인증 또는 model 관측 실패");
    expect(provision).not.toHaveBeenCalled();
  });

  it("MiniMax Anthropic runtime과 아직 미지원인 model plan을 Connector 생성 전에 거부한다", async () => {
    const provision = vi.fn();
    const service = new ServerSubscriptionConnectionService(
      { provision, attestHealth: vi.fn(), revoke: vi.fn(), markOffline: vi.fn() } as never,
      { connect: vi.fn(), connectModel: vi.fn() } as never,
      {
        requireBindable: vi.fn().mockResolvedValue({
          account_id: "account-model-rollback",
          provider_id: "minimax-token-plan",
          connector_id: expect.any(String),
          status: "offline",
          version: 1,
        }),
        requireUsable: vi.fn(),
      } as never,
    );
    const common = {
      commandId: "model-blocked-12345678",
      alias: "Model",
      authKind: "subscription-key" as const,
      billingKind: "token-plan",
      secret: "never-forwarded-secret",
    };

    await expect(
      service.connectModel(context, {
        ...common,
        providerId: "minimax-token-plan",
        endpointUrl: "https://api.minimax.io/anthropic",
        protocol: "anthropic",
      }),
    ).rejects.toThrow(/OpenAI|openai-model/u);
    await expect(
      service.connectModel(context, {
        ...common,
        providerId: "kimi-coding-plan",
        authKind: "api-key",
        billingKind: "membership-subscription",
      }),
    ).rejects.toThrow(/미지원|지원/u);
    expect(provision).not.toHaveBeenCalled();
  });

  it("모델 건강 증명이 실패하면 Connector를 offline으로 되돌리고 secret 없는 오류만 반환한다", async () => {
    const markOffline = vi.fn().mockResolvedValue({ status: "offline" });
    const provision = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        connectorId: input.connectorId,
        providerId: input.providerId,
        executionKind: "model",
        runtimeId: input.runtimeId,
        status: "offline",
      }),
    );
    const service = new ServerSubscriptionConnectionService(
      {
        provision,
        attestHealth: vi.fn().mockRejectedValue(new Error("secret-value-in-cause")),
        revoke: vi.fn(),
        markOffline,
      } as never,
      {
        connect: vi.fn(),
        connectModel: vi.fn().mockImplementation((_context, input) =>
          Promise.resolve({
            account: {
              account_id: "account-model-rollback",
              provider_id: input.providerId,
              connector_id: input.connectorId,
              status: "offline",
            },
            binding: {
              executionKind: "model",
              protocol: input.protocol,
              endpointUrl: input.endpointUrl,
            },
          }),
        ),
      } as never,
      {
        requireBindable: vi.fn().mockImplementation(() =>
          Promise.resolve({
            account_id: "account-model-rollback",
            provider_id: "minimax-token-plan",
            connector_id: vi.mocked(provision).mock.calls[0]?.[1].connectorId,
            status: "offline",
            version: 1,
          }),
        ),
        requireUsable: vi.fn(),
      } as never,
      { assemble: vi.fn() } as never,
      undefined,
      undefined,
      miniMaxVerifier(),
    );

    const failure = await service
      .connectModel(context, {
        commandId: "model-rollback-12345678",
        providerId: "minimax-token-plan",
        alias: "MiniMax",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret: "secret-value-in-cause",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("secret-value-in-cause");
    expect(markOffline).toHaveBeenCalledWith(context, {
      commandId: "model-rollback-12345678:compensate-offline:v1",
      connectorId: expect.stringMatching(/^server-/u),
    });
  });

  it("Core route 조립이 일시 실패하면 Connector와 계정을 offline으로 되돌리고 같은 command로 재개한다", async () => {
    const markOffline = vi.fn().mockResolvedValue({ status: "offline" });
    const provision = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        connectorId: input.connectorId,
        providerId: input.providerId,
        executionKind: "model",
        runtimeId: input.runtimeId,
        status: "offline",
      }),
    );
    const service = new ServerSubscriptionConnectionService(
      {
        provision,
        attestHealth: vi.fn().mockImplementation((_context, input) =>
          Promise.resolve({
            connectorId: input.connectorId,
            providerId: "minimax-token-plan",
            executionKind: "model",
            runtimeId: "openai-model",
            status: "ready",
          }),
        ),
        revoke: vi.fn(),
        markOffline,
      } as never,
      {
        connect: vi.fn(),
        connectModel: vi.fn().mockImplementation((_context, input) =>
          Promise.resolve({
            account: {
              account_id: "account-route-failure",
              provider_id: input.providerId,
              connector_id: input.connectorId,
              status: "offline",
            },
            binding: {
              endpointId: "endpoint-minimax-openai",
              endpointUrl: input.endpointUrl,
              protocol: input.protocol,
              executionKind: "model",
            },
          }),
        ),
      } as never,
      {
        requireBindable: vi.fn().mockImplementation(() =>
          Promise.resolve({
            account_id: "account-route-failure",
            provider_id: "minimax-token-plan",
            connector_id: vi.mocked(provision).mock.calls[0]?.[1].connectorId,
            status: "offline",
            version: 1,
          }),
        ),
        requireUsable: vi.fn().mockImplementation(() =>
          Promise.resolve({
            account_id: "account-route-failure",
            provider_id: "minimax-token-plan",
            connector_id: vi.mocked(provision).mock.calls[0]?.[1].connectorId,
            status: "active",
            version: 2,
          }),
        ),
      } as never,
      {
        assemble: vi
          .fn()
          .mockRejectedValueOnce(new Error("Core route transient failure"))
          .mockResolvedValueOnce({ modelId: "MiniMax-M2.7", modelProfileId: "profile-1", routeNames: [] }),
      } as never,
      undefined,
      undefined,
      miniMaxVerifier(),
    );

    await expect(
      service.connectModel(context, {
        commandId: "model-route-failure",
        providerId: "minimax-token-plan",
        alias: "MiniMax",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret: "safe-secret",
      }),
    ).rejects.toThrow("완료하지 못했습니다");
    expect(markOffline).toHaveBeenCalledWith(context, {
      commandId: "model-route-failure:compensate-offline:v2",
      connectorId: expect.stringMatching(/^server-/u),
    });
    await expect(
      service.connectModel(context, {
        commandId: "model-route-failure",
        providerId: "minimax-token-plan",
        alias: "MiniMax",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret: "safe-secret",
      }),
    ).resolves.toMatchObject({ modelRuntime: { modelId: "MiniMax-M2.7" } });
  });
});

describe("실제 서버 구독 계정 준비 조립", () => {
  let database: MassionDatabase | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await database?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("실제 공개 command는 route 조립 실패를 offline으로 격리하고 같은 command 재시도에서 중복 없이 완료한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    root = await mkdtemp(join(tmpdir(), "massion-server-model-saga-"));
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "model-saga@example.com", displayName: "Saga" });
    const actualContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    const quota = await SubscriptionQuotaService.create(database, organizations);
    const router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    const connections = new SubscriptionConnectionService(database, accounts, providers);
    const connectors = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor: new BundledServerConnectorRuntimeAttestor(database, { profileRoot: join(root, "profiles") }),
    });
    const assembler = new BuiltinModelRouteAssembler(router);
    const assemble = vi
      .fn()
      .mockRejectedValueOnce(new Error("route storage temporarily unavailable"))
      .mockImplementation(async (tenant, input) => await assembler.assemble(tenant, input));
    const service = new ServerSubscriptionConnectionService(
      connectors,
      connections,
      accounts,
      { assemble } as never,
      undefined,
      undefined,
      miniMaxVerifier(),
    );
    const commandStore = await ApplicationCommandStore.create(database, organizations);
    const commands = new ApplicationCommandRegistry(commandStore);
    registerApplicationDomainCommands(commands, { subscriptionServerConnections: service } as never);
    const input = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "actual-minimax-saga-command",
      correlationId: "actual-minimax-saga-correlation",
      operation: "subscription.server.connect-model",
      payload: {
        providerId: "minimax-token-plan",
        alias: "MiniMax Saga",
        authKind: "subscription-key",
        billingKind: "token-plan",
        secret: "actual-saga-secret",
      },
    };

    await expect(commands.dispatch(actualContext, ["subscription:write"], input)).rejects.toMatchObject({
      category: "internal",
    });
    const [failedAccounts, failedConnectors, credentials] = await database.query<
      [Array<{ status: string }>, Array<{ status: string }>, Array<{ status: string }>]
    >(
      `SELECT status FROM subscription_account WHERE organization_id = $organization_id;
       SELECT status FROM subscription_connector WHERE organization_id = $organization_id;
       SELECT status FROM provider_credential WHERE organization_id = $organization_id;`,
      { organization_id: actualContext.organizationId },
    );
    expect(failedAccounts).toEqual([{ status: "offline" }]);
    expect(failedConnectors).toEqual([{ status: "offline" }]);
    expect(credentials).toEqual([{ status: "active" }]);

    await expect(commands.dispatch(actualContext, ["subscription:write"], input)).resolves.toMatchObject({
      outcome: "succeeded",
      data: { status: "active", connectorStatus: "ready" },
    });
    const [finalAccounts, finalConnectors, finalCredentials, applicationCommands] = await database.query<
      [
        Array<{ status: string }>,
        Array<{ status: string }>,
        Array<{ status: string }>,
        Array<{ state: string; lease_generation: number }>,
      ]
    >(
      `SELECT status FROM subscription_account WHERE organization_id = $organization_id;
       SELECT status FROM subscription_connector WHERE organization_id = $organization_id;
       SELECT status FROM provider_credential WHERE organization_id = $organization_id;
       SELECT state, lease_generation FROM application_command WHERE organization_id = $organization_id
         AND command_id = 'actual-minimax-saga-command';`,
      { organization_id: actualContext.organizationId },
    );
    expect(finalAccounts).toEqual([{ status: "active" }]);
    expect(finalConnectors).toEqual([{ status: "ready" }]);
    expect(finalCredentials).toEqual([{ status: "active" }]);
    expect(applicationCommands).toEqual([{ state: "succeeded", lease_generation: 2 }]);
  });

  it("고정된 bundled Codex artifact와 실제 저장소 서비스를 함께 사용해 offline 계정을 준비한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    root = await mkdtemp(join(tmpdir(), "massion-server-connection-"));
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "actual@example.com", displayName: "Owner" });
    const actualContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    const connections = new SubscriptionConnectionService(database, accounts, providers);
    const connectors = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor: new BundledServerConnectorRuntimeAttestor(database, { profileRoot: join(root, "profiles") }),
    });
    const service = new ServerSubscriptionConnectionService(connectors, connections, accounts);

    await expect(
      service.prepare(actualContext, {
        commandId: "actual-server-subscription",
        providerId: "openai-codex",
        alias: "Codex Personal",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        priority: 1,
        weight: 1,
      }),
    ).resolves.toMatchObject({
      account: { provider_id: "openai-codex", status: "offline" },
      connector: { status: "offline", trustOrigin: "server-managed" },
      profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
    });
  });

  it("Codex 유료 계정의 실제 model/list 선택이 Core route와 MassionModelFactory agent-runtime lease까지 이어진다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    root = await mkdtemp(join(tmpdir(), "massion-server-codex-model-"));
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "codex-model@example.com", displayName: "Owner" });
    const actualContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32));
    const quota = await SubscriptionQuotaService.create(database, organizations);
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    const router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    const connections = new SubscriptionConnectionService(database, accounts, providers);
    const runtimeArtifact = {
      runtimeId: "codex" as const,
      version: "0.144.1",
      runtimeArtifactDigest: "d".repeat(64),
      command: process.execPath,
      commandArguments: ["/bundled/codex.js"],
    };
    const attestor = new BundledServerConnectorRuntimeAttestor(database, {
      profileRoot: join(root, "profiles"),
      inspectRuntime: vi.fn().mockResolvedValue(runtimeArtifact),
      codexAccount: vi.fn().mockResolvedValue({
        account: { type: "chatgpt", planType: "plus" },
        requiresOpenaiAuth: true,
      }),
    });
    const connectors = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor: attestor,
    });
    const observed = {
      modelId: "gpt-5.6-sol" as const,
      catalogId: "gpt-5.6-sol",
      hidden: false as const,
      isDefault: true,
      inputModalities: ["text", "image"],
      observedAt: "2026-07-12T00:00:00.000Z",
      runtimeVersion: runtimeArtifact.version,
      runtimeArtifactDigest: runtimeArtifact.runtimeArtifactDigest,
    };
    const readModel = vi.fn().mockResolvedValue(observed);
    const service = new ServerSubscriptionConnectionService(
      connectors,
      connections,
      accounts,
      new BuiltinModelRouteAssembler(router),
      { readModel } as never,
    );

    const prepared = await service.prepare(actualContext, {
      commandId: "actual-codex-model-prepare",
      providerId: "openai-codex",
      alias: "Codex Plus",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      priority: 1,
      weight: 1,
    });
    const ready = await service.attest(actualContext, {
      commandId: "actual-codex-model-attest",
      connectorId: prepared.connector.connectorId,
      accountId: prepared.account.account_id,
    });

    const acquireSession = vi.fn().mockImplementation((_context, input) =>
      Promise.resolve({
        leaseId: `lease-${input.routeAttemptId}`,
        executionId: input.executionId,
        accountId: input.accountId,
        connectorId: input.connectorId,
        workId: input.workId,
        agentHandle: input.agentHandle,
        routeAttemptId: input.routeAttemptId,
        ...(input.quotaSnapshotId === undefined ? {} : { quotaSnapshotId: input.quotaSnapshotId }),
        status: "active",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        complete: vi.fn(),
        fail: vi.fn(),
        renew: vi.fn(),
      }),
    );
    const resolveRuntime = vi.fn().mockResolvedValue({
      kind: "agent-runtime",
      adapterId: "codex-app-server",
      executor: { execute: vi.fn() },
    });
    const factory = new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder(), {
      broker: {
        acquire: acquireSession,
        bindRuntime: vi.fn(async (_context, input) => ({ adapterId: input.adapterId })),
        recoverActive: vi.fn().mockResolvedValue([]),
        getLease: vi.fn(),
        findExecutionLeases: vi.fn().mockResolvedValue([]),
      },
      resolver: { resolve: resolveRuntime },
    });
    const lease = await factory.acquire(actualContext, {
      commandId: "actual-codex-model-acquire",
      executionId: "execution-codex-1",
      workId: "work-codex-1",
      agentHandle: "software-engineering.backend-specialist",
      workspaceRoot: join(root, "workspace"),
      routeName: "software-engineering-quality",
      estimatedTokens: 1_000,
      estimatedCostMicros: 0,
    });

    expect(ready).toMatchObject({
      status: "ready",
      modelRuntime: {
        modelId: "gpt-5.6-sol",
        routeNames: expect.arrayContaining(["software-engineering-quality"]),
      },
    });
    expect(lease).toMatchObject({
      kind: "agent-runtime",
      subscription: {
        accountId: prepared.account.account_id,
        connectorId: prepared.connector.connectorId,
        adapterId: "codex-app-server",
      },
    });
    expect(acquireSession).toHaveBeenCalledWith(
      actualContext,
      expect.objectContaining({
        accountId: prepared.account.account_id,
        connectorId: prepared.connector.connectorId,
      }),
    );
    expect(resolveRuntime).toHaveBeenCalledWith(
      actualContext,
      expect.objectContaining({ providerId: "openai-codex", modelId: "gpt-5.6-sol" }),
    );
  });

  it("실제 저장소에서 MiniMax secret을 암호화하고 내장 OpenAI 모델 artifact 증명 뒤 ready·active로 전이한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    root = await mkdtemp(join(tmpdir(), "massion-server-model-connection-"));
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "model-actual@example.com", displayName: "Owner" });
    const member = await identities.registerPersonalUser({ email: "model-member@example.com", displayName: "Member" });
    const actualContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    await organizations.addMember(actualContext, member.user.user_id, "member");
    const memberContext = await organizations.resolveTenantContext(
      member.user.user_id,
      owner.organization.organization_id,
    );
    const accounts = await SubscriptionAccountService.create(database, organizations, randomBytes(32), {
      authorize: async () => ({ policyVersion: "model-sharing-test-v1" }),
    });
    const providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)), {
      accounts,
    });
    const quota = await SubscriptionQuotaService.create(database, organizations);
    const router = await ModelRouter.create(database, organizations, providers, { accounts, quota });
    const connections = new SubscriptionConnectionService(database, accounts, providers);
    const connectors = await ServerConnectorProvisioningService.create(database, organizations, {
      runtimeAttestor: new BundledServerConnectorRuntimeAttestor(database, { profileRoot: join(root, "profiles") }),
    });
    const assembler = new BuiltinModelRouteAssembler(router);
    const service = new ServerSubscriptionConnectionService(
      connectors,
      connections,
      accounts,
      assembler,
      undefined,
      undefined,
      miniMaxVerifier(),
    );
    const secret = "actual-minimax-secret-never-persisted";

    const connected = await service.connectModel(actualContext, {
      commandId: "actual-minimax-server-subscription",
      providerId: "minimax-token-plan",
      alias: "MiniMax Token Plan",
      authKind: "subscription-key",
      billingKind: "token-plan",
      secret,
      priority: 1,
      weight: 1,
    });

    expect(connected).toMatchObject({
      account: { provider_id: "minimax-token-plan", status: "active", version: 2 },
      connector: {
        providerId: "minimax-token-plan",
        executionKind: "model",
        runtimeId: "openai-model",
        status: "ready",
        processGeneration: 1,
      },
      binding: {
        endpointUrl: "https://api.minimax.io/v1",
        protocol: "openai",
        executionKind: "model",
      },
      modelRuntime: {
        modelId: "MiniMax-M2.7",
        routeNames: [
          "orchestration-balanced",
          "planning-quality",
          "delivery-quality",
          "assurance-independent",
          "software-engineering-quality",
        ],
      },
    });
    const routes = await router.listRoutes(actualContext);
    const models = await router.listModels(actualContext);
    const candidates = await router.listCandidates(actualContext);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: "MiniMax-M2.7", verified: true });
    expect(routes).toHaveLength(5);
    expect(candidates).toHaveLength(5);
    for (const route of routes) {
      await expect(
        router.simulate(actualContext, {
          routeName: route.name,
          estimatedTokens: 1,
          estimatedCostMicros: 0,
        }),
      ).resolves.toMatchObject({ status: "selected", profile: { model_id: "MiniMax-M2.7" } });
    }
    const lease = await new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder()).acquire(
      actualContext,
      {
        commandId: randomUUID(),
        routeName: "orchestration-balanced",
        estimatedTokens: 1,
        estimatedCostMicros: 0,
      },
    );
    expect(lease).toMatchObject({ kind: "model", model: { modelId: "MiniMax-M2.7" } });
    await lease.complete({ commandId: randomUUID(), inputTokens: 1, outputTokens: 1 });
    const shared = await accounts.share(actualContext, {
      commandId: randomUUID(),
      accountId: connected.account.account_id,
      expectedVersion: connected.account.version,
    });
    expect(shared).toMatchObject({ scope: "organization", status: "active", version: 3 });
    const memberLease = await new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder()).acquire(
      memberContext,
      {
        commandId: randomUUID(),
        routeName: "orchestration-balanced",
        estimatedTokens: 1,
        estimatedCostMicros: 0,
      },
    );
    expect(memberLease).toMatchObject({ kind: "model", model: { modelId: "MiniMax-M2.7" } });
    await memberLease.complete({ commandId: randomUUID(), inputTokens: 1, outputTokens: 1 });
    const unshared = await accounts.unshare(actualContext, {
      commandId: randomUUID(),
      accountId: connected.account.account_id,
      expectedVersion: shared.version,
    });
    expect(unshared).toMatchObject({ scope: "personal", status: "active", version: 4 });
    await expect(
      new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder()).acquire(memberContext, {
        commandId: randomUUID(),
        routeName: "orchestration-balanced",
        estimatedTokens: 1,
        estimatedCostMicros: 0,
      }),
    ).rejects.toThrow(/사용 가능한|Credential|구독 계정/u);
    await expect(
      new MassionModelFactory(router, providers, new OpenAICompatibleModelBuilder()).acquire(actualContext, {
        commandId: randomUUID(),
        routeName: "orchestration-balanced",
        estimatedTokens: 1,
        estimatedCostMicros: 0,
      }),
    ).resolves.toMatchObject({ kind: "model", model: { modelId: "MiniMax-M2.7" } });
    const persisted = JSON.stringify(
      await database.query(
        "SELECT * FROM subscription_account; SELECT * FROM subscription_connector; SELECT * FROM model_provider; SELECT * FROM provider_endpoint; SELECT * FROM provider_credential; SELECT * FROM credential_secret_version; SELECT * FROM subscription_audit_event; SELECT * FROM router_audit_event;",
      ),
    );
    expect(persisted).not.toContain(secret);
    expect(JSON.stringify(connected)).not.toContain(secret);
  });
});
