import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { codexFileCredentialStoreArguments } from "@massion/runtime";
import {
  ServerConnectorAuthenticationRequiredError,
  ServerConnectorPaidSubscriptionRequiredError,
} from "@massion/subscriptions";

import { BundledServerConnectorRuntimeAttestor, readCodexAppServerAccount } from "./server-runtime-attestor.js";
import { prepareSubscriptionProfileRoot } from "./subscription-profile.js";

describe("서버 bundled runtime 건강 증명", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
  });

  async function fixture(input: {
    readonly providerId: "openai-codex" | "anthropic-claude-code";
    readonly runtimeId: "codex" | "claude";
    readonly stdout?: string;
    readonly codexAccount?: unknown;
    readonly authenticated?: boolean;
  }) {
    const root = await mkdtemp(join(tmpdir(), "massion-server-attestor-"));
    cleanups.push(root);
    const run = vi.fn().mockResolvedValue({ stdout: input.stdout ?? "" });
    const codexAccount = vi.fn().mockResolvedValue(input.codexAccount);
    const inspect = vi.fn().mockResolvedValue({
      runtimeId: input.runtimeId,
      version: input.runtimeId === "codex" ? "0.144.1" : "0.3.207",
      runtimeArtifactDigest: input.runtimeId === "codex" ? "a".repeat(64) : "b".repeat(64),
      command: `/runtime/${input.runtimeId}`,
      commandArguments: input.runtimeId === "codex" ? ["/runtime/codex.js"] : [],
    });
    let connectorStatus = "offline";
    const database = {
      query: vi.fn().mockImplementation((statement: string) => {
        if (statement.includes("FROM subscription_connector")) return Promise.resolve([[{ status: connectorStatus }]]);
        return Promise.resolve([
          [
            {
              account_id: "account-12345678",
              owner_user_id: "user-12345678",
              provider_id: input.providerId,
              connector_id: "connector-12345678",
              billing_kind: "consumer-subscription",
              status: "offline",
            },
          ],
        ]);
      }),
    };
    if (input.runtimeId === "codex" && input.authenticated !== false) {
      const profile = await prepareSubscriptionProfileRoot(
        join(root, "profiles"),
        "organization-12345678",
        "account-12345678",
      );
      await writeFile(join(profile, "auth.json"), "private-login-state", { mode: 0o600 });
    }
    return {
      root,
      run,
      inspect,
      codexAccount,
      database,
      setConnectorStatus: (status: "ready" | "offline") => {
        connectorStatus = status;
      },
      attestor: new BundledServerConnectorRuntimeAttestor(database as never, {
        profileRoot: join(root, "profiles"),
        inspectRuntime: inspect,
        run,
        codexAccount,
      }),
    };
  }

  it("Codex ChatGPT 로그인 profile과 실제 artifact가 일치할 때만 새 process를 증명한다", async () => {
    const { run, attestor, setConnectorStatus } = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      codexAccount: {
        requiresOpenaiAuth: true,
        account: { type: "chatgpt", planType: "plus", email: "private@example.com" },
      },
    });
    const artifact = await attestor.inspectArtifact({
      organizationId: "organization-12345678",
      actorUserId: "user-12345678",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
    });
    const input = {
      organizationId: "organization-12345678",
      actorUserId: "user-12345678",
      connectorId: "connector-12345678",
      providerId: "openai-codex",
      executionKind: "agent-runtime" as const,
      runtimeId: "codex",
      runtimeArtifactDigest: artifact.runtimeArtifactDigest,
      version: artifact.version,
    };

    await expect(attestor.attestHealth(input)).resolves.toEqual({
      runtimeId: "codex",
      runtimeArtifactDigest: "a".repeat(64),
      processGeneration: 1,
      processState: "new-process",
    });
    setConnectorStatus("ready");
    await expect(attestor.attestHealth({ ...input, previousProcessGeneration: 1 })).resolves.toEqual({
      runtimeId: "codex",
      runtimeArtifactDigest: "a".repeat(64),
      processGeneration: 1,
      processState: "same-process",
    });
    setConnectorStatus("offline");
    await expect(attestor.attestHealth({ ...input, previousProcessGeneration: 1 })).resolves.toEqual({
      runtimeId: "codex",
      runtimeArtifactDigest: "a".repeat(64),
      processGeneration: 2,
      processState: "new-process",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("Codex app-server와 initialize 후 account/read를 refreshToken=true로 교환한다", async () => {
    const fixturePath = new URL("./fixtures/codex-account-app-server.mjs", import.meta.url);
    await expect(
      readCodexAppServerAccount(process.execPath, codexFileCredentialStoreArguments([fileURLToPath(fixturePath)]), {
        CODEX_HOME: "/isolated/profile",
      }),
    ).resolves.toEqual({ requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } });
  });

  it("관리 Codex profile의 auth.json이 없으면 app-server를 실행하지 않고 재인증 상태로 전이한다", async () => {
    const { attestor, codexAccount } = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      authenticated: false,
      codexAccount: { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } },
    });

    await expect(
      attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        runtimeArtifactDigest: "a".repeat(64),
        version: "0.144.1",
      }),
    ).rejects.toBeInstanceOf(ServerConnectorAuthenticationRequiredError);
    expect(codexAccount).not.toHaveBeenCalled();
  });

  it.each(["free", "unknown", "future-unverified-plan", undefined])(
    "Codex 유료 구독으로 증명할 수 없는 planType=%s 계정은 재인증 없이 fail-closed한다",
    async (planType) => {
      const { attestor } = await fixture({
        providerId: "openai-codex",
        runtimeId: "codex",
        codexAccount: {
          requiresOpenaiAuth: true,
          account: { type: "chatgpt", ...(planType === undefined ? {} : { planType }) },
        },
      });

      await expect(
        attestor.attestHealth({
          organizationId: "organization-12345678",
          actorUserId: "user-12345678",
          connectorId: "connector-12345678",
          providerId: "openai-codex",
          executionKind: "agent-runtime",
          runtimeId: "codex",
          runtimeArtifactDigest: "a".repeat(64),
          version: "0.144.1",
        }),
      ).rejects.toMatchObject({
        code: "paid-subscription-required",
        providerId: "openai-codex",
        connectorId: "connector-12345678",
      });
      await expect(
        attestor.attestHealth({
          organizationId: "organization-12345678",
          actorUserId: "user-12345678",
          connectorId: "connector-12345678",
          providerId: "openai-codex",
          executionKind: "agent-runtime",
          runtimeId: "codex",
          runtimeArtifactDigest: "a".repeat(64),
          version: "0.144.1",
        }),
      ).rejects.toBeInstanceOf(ServerConnectorPaidSubscriptionRequiredError);
    },
  );

  it.each([
    ["API key", { requiresOpenaiAuth: true, account: { type: "apiKey" } }],
    ["OpenAI 인증이 필요 없는 provider", { requiresOpenaiAuth: false, account: null }],
    [
      "AWS 관리 Bedrock provider",
      { requiresOpenaiAuth: false, account: { type: "amazonBedrock", credentialSource: "awsManaged" } },
    ],
  ] as const)("%s 상태는 자동 재로그인 신호 없이 유료 구독 불가로 fail-closed한다", async (_label, codexAccount) => {
    const { attestor } = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      codexAccount,
    });

    await expect(
      attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        runtimeArtifactDigest: "a".repeat(64),
        version: "0.144.1",
      }),
    ).rejects.toBeInstanceOf(ServerConnectorPaidSubscriptionRequiredError);
  });

  it("Codex health probe에는 격리된 profile 경로만 전달한다", async () => {
    const { root, codexAccount, attestor } = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      codexAccount: { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } },
    });
    await attestor.attestHealth({
      organizationId: "organization-12345678",
      actorUserId: "user-12345678",
      connectorId: "connector-12345678",
      providerId: "openai-codex",
      executionKind: "agent-runtime",
      runtimeId: "codex",
      runtimeArtifactDigest: "a".repeat(64),
      version: "0.144.1",
    });
    expect(codexAccount).toHaveBeenCalledWith(
      "/runtime/codex",
      ["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"'],
      expect.objectContaining({ CODEX_HOME: expect.stringMatching(/profiles/) }),
    );
    const profileRoot = String(vi.mocked(codexAccount).mock.calls[0]?.[2].CODEX_HOME);
    expect(profileRoot.startsWith(await realpath(join(root, "profiles")))).toBe(true);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o700);
  });

  it("Claude 구독 로그인 JSON에서 민감한 계정 필드는 폐기하고 profile을 격리한다", async () => {
    const { run, attestor } = await fixture({
      providerId: "anthropic-claude-code",
      runtimeId: "claude",
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "private@example.com",
        orgId: "private-org",
        subscriptionType: "pro",
      }),
    });

    const result = await attestor.attestHealth({
      organizationId: "organization-12345678",
      actorUserId: "user-12345678",
      connectorId: "connector-12345678",
      providerId: "anthropic-claude-code",
      executionKind: "agent-runtime",
      runtimeId: "claude",
      runtimeArtifactDigest: "b".repeat(64),
      version: "0.3.207",
    });

    expect(result).toMatchObject({ processState: "new-process", processGeneration: 1 });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(run).toHaveBeenCalledWith(
      "/runtime/claude",
      ["auth", "status", "--json"],
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: expect.any(String),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }),
    );
  });

  it("직접 모델은 실제 내장 artifact와 암호화 Credential 계보가 모두 있을 때만 건강 증명한다", async () => {
    const inspectRuntime = vi.fn();
    const inspectModelRuntime = vi.fn().mockResolvedValue({
      runtimeId: "openai-model",
      version: "1.0.0+openai-compatible.2.0.59",
      runtimeArtifactDigest: "c".repeat(64),
      nodeExecutable: process.execPath,
    });
    const database = {
      query: vi.fn().mockImplementation((statement: string) => {
        if (statement.includes("FROM subscription_connector")) return Promise.resolve([[{ status: "offline" }]]);
        if (statement.includes("FROM provider_credential")) {
          return Promise.resolve([
            [
              {
                credential_id: "credential-12345678",
                subscription_account_id: "account-12345678",
                subscription_connector_id: "connector-12345678",
                provider_id: "minimax-token-plan",
                material_kind: "encrypted_secret",
                status: "active",
                secret_version: 1,
              },
            ],
          ]);
        }
        if (statement.includes("FROM credential_secret_version")) {
          return Promise.resolve([[{ credential_id: "credential-12345678", version: 1, algorithm: "aes-256-gcm" }]]);
        }
        return Promise.resolve([
          [
            {
              account_id: "account-12345678",
              owner_user_id: "user-12345678",
              provider_id: "minimax-token-plan",
              connector_id: "connector-12345678",
              billing_kind: "token-plan",
              status: "offline",
            },
          ],
        ]);
      }),
    };
    const attestor = new BundledServerConnectorRuntimeAttestor(database as never, {
      profileRoot: "/unused-for-model",
      inspectRuntime,
      inspectModelRuntime,
      run: vi.fn(),
      codexAccount: vi.fn(),
    });

    await expect(
      attestor.inspectArtifact({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        providerId: "minimax-token-plan",
        executionKind: "model",
        runtimeId: "openai-model",
      }),
    ).resolves.toEqual({
      runtimeId: "openai-model",
      version: "1.0.0+openai-compatible.2.0.59",
      runtimeArtifactDigest: "c".repeat(64),
    });
    await expect(
      attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "minimax-token-plan",
        executionKind: "model",
        runtimeId: "openai-model",
        runtimeArtifactDigest: "c".repeat(64),
        version: "1.0.0+openai-compatible.2.0.59",
      }),
    ).resolves.toEqual({
      runtimeId: "openai-model",
      runtimeArtifactDigest: "c".repeat(64),
      processGeneration: 1,
      processState: "new-process",
    });
    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(inspectModelRuntime).toHaveBeenCalledTimes(1);
  });

  it("로그아웃·artifact 변경·계정 계보 부재를 fail-closed한다", async () => {
    const loggedOut = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      codexAccount: { requiresOpenaiAuth: true, account: null },
    });
    await expect(
      loggedOut.attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        runtimeArtifactDigest: "a".repeat(64),
        version: "0.144.1",
      }),
    ).rejects.toMatchObject({
      code: "needs-reauth",
      providerId: "openai-codex",
      connectorId: "connector-12345678",
    });

    const changed = await fixture({
      providerId: "openai-codex",
      runtimeId: "codex",
      codexAccount: { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "plus" } },
    });
    await expect(
      changed.attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        runtimeArtifactDigest: "f".repeat(64),
        version: "0.144.1",
      }),
    ).rejects.toThrow("artifact");

    vi.mocked(changed.database.query).mockResolvedValueOnce([[]]);
    await expect(
      changed.attestor.attestHealth({
        organizationId: "organization-12345678",
        actorUserId: "user-12345678",
        connectorId: "connector-12345678",
        providerId: "openai-codex",
        executionKind: "agent-runtime",
        runtimeId: "codex",
        runtimeArtifactDigest: "a".repeat(64),
        version: "0.144.1",
      }),
    ).rejects.toThrow("계정 계보");
  });
});
