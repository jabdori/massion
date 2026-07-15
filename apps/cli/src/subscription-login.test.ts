import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationRemoteError } from "@massion/application";

import { connectLocalServerSubscription } from "./subscription-login.js";

describe("로컬 서버 소비자 구독 로그인", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "massion-cli-subscription-"));
    cleanups.push(root);
    const commands: Array<Record<string, unknown>> = [];
    const client = {
      status: vi.fn(async () => ({ data: { mode: "local" } })),
      query: vi.fn(async (operation: string, payload: unknown) => {
        if (operation === "subscription.quota") {
          const accountId = (payload as { accountId?: unknown })?.accountId;
          if (typeof accountId !== "string") throw new Error("quota 계정 ID가 누락되었습니다");
          return { data: [reportedCodexQuota(accountId)] };
        }
        return { data: [] as Array<Record<string, unknown>> };
      }),
      command: vi.fn(async (command: unknown) => {
        const value = command as Record<string, unknown>;
        commands.push(value);
        if (value.operation === "subscription.server.prepare") {
          return {
            outcome: "succeeded",
            resource: { type: "SubscriptionAccount", id: "account-12345678" },
            data: {
              accountId: "account-12345678",
              connectorId: "server-1234567890abcdef",
              profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
              loginRequired: true,
            },
          };
        }
        const payload = value.payload as { connectorId?: string } | undefined;
        return {
          outcome: "succeeded",
          data: {
            connectorId: payload?.connectorId ?? "server-1234567890abcdef",
            status: "ready",
            quotaObservation: directQuotaObservation(),
          },
        };
      }),
    };
    const inspectRuntime = vi.fn(async () => ({
      runtimeId: "codex" as const,
      version: "0.144.1",
      runtimeArtifactDigest: "c".repeat(64),
      command: "/runtime/node",
      commandArguments: ["/runtime/codex.js"],
    }));
    const runInteractive = vi.fn(
      async (_command: string, _arguments: readonly string[], environment: NodeJS.ProcessEnv) => {
        if (!environment.CODEX_HOME) throw new Error("CODEX_HOME 누락");
        await writeFile(join(environment.CODEX_HOME, "auth.json"), "fixture", { mode: 0o600 });
        return 0;
      },
    );
    return { root, commands, client, inspectRuntime, runInteractive };
  }

  function existingAccount(overrides: Record<string, unknown> = {}) {
    return {
      accountId: "account-existing-123",
      providerId: "openai-codex",
      alias: "기존 Codex",
      connectorId: "server-existing-123",
      connectorLocation: "server",
      connectorExecutionKind: "agent-runtime",
      connectorStatus: "ready",
      billingKind: "consumer-subscription",
      scope: "personal",
      canManage: true,
      status: "active",
      version: 4,
      profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
      ...overrides,
    };
  }

  function existingDoctor(overrides: Record<string, unknown> = {}) {
    return {
      accountId: "account-existing-123",
      providerId: "openai-codex",
      alias: "기존 Codex",
      accountStatus: "active",
      connectorId: "server-existing-123",
      connectorLocation: "server",
      connectorStatus: "ready",
      quotaStatus: "available",
      action: "none",
      ...overrides,
    };
  }

  function reportedCodexQuota(accountId: string) {
    const observedAt = new Date(Date.now() + 60_000).toISOString();
    return {
      accountId,
      windows: [
        {
          kind: "codex:codex:primary",
          remainingRatio: 0.75,
          observedAt,
          confidence: "reported",
        },
      ],
      exhausted: false,
      observedAt,
    };
  }

  function directQuotaObservation() {
    return { source: "direct" as const, attestedAt: new Date().toISOString() };
  }

  async function seedExistingCodexProfile(root: string): Promise<string> {
    const profile = join(root, "profiles", "a".repeat(64), "b".repeat(64));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, "auth.json"), "existing-private-login-state", { mode: 0o600 });
    return profile;
  }

  it("계정이 없으면 공식 bundled Codex를 격리 profile에서 별도 데이터 고지 없이 첫 연결한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", alias: "개인 Codex", modelId: "gpt-5.6-sol" },
        {
          endpoint: "http://127.0.0.1:7331",
          connectorDirectory: root,
          environment: { PATH: "/usr/bin", TMPDIR: "/tmp", OPENAI_API_KEY: "노출되면-안됨" },
          inspectRuntime,
          runInteractive,
        },
      ),
    ).resolves.toEqual({
      status: "ready",
      providerId: "openai-codex",
      alias: "개인 Codex",
      accountId: "account-12345678",
      connectorId: "server-1234567890abcdef",
      connectionDisposition: "new",
    });

    expect(inspectRuntime).toHaveBeenCalledWith("codex");
    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"', "login"],
      expect.objectContaining({ CODEX_HOME: expect.any(String), HOME: expect.any(String) }),
    );
    expect(runInteractive.mock.calls[0]?.[2]).not.toHaveProperty("OPENAI_API_KEY");
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.attest",
    ]);
    expect(commands[0]).toMatchObject({
      payload: {
        providerId: "openai-codex",
        alias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
      },
    });
    expect(commands[1]).toMatchObject({
      payload: {
        connectorId: "server-1234567890abcdef",
        accountId: "account-12345678",
        modelId: "gpt-5.6-sol",
      },
    });
    const profile = join(root, "profiles", "a".repeat(64), "b".repeat(64));
    expect(await readFile(join(profile, "auth.json"), "utf8")).toBe("fixture");
    expect(await readFile(join(profile, "config.toml"), "utf8")).toBe('cli_auth_credentials_store = "file"\n');
    expect((await stat(join(profile, "config.toml"))).mode & 0o777).toBe(0o600);
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    expect((await readdir(join(root, ".pending-subscriptions"))).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("유효한 기존 Codex profile은 account·doctor·quota 확인 뒤 로그인하지 않고 재사용한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") {
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      status: "ready",
      providerId: "openai-codex",
      accountId: "account-existing-123",
      connectorId: "server-existing-123",
      connectionDisposition: "reused",
    });

    expect(runInteractive).not.toHaveBeenCalled();
    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
    expect(commands[0]).toMatchObject({
      payload: { connectorId: "server-existing-123", accountId: "account-existing-123" },
    });
    expect(client.query.mock.calls.map(([operation]) => operation)).toEqual([
      "subscription.accounts",
      "subscription.doctor",
      "subscription.quota",
      "subscription.quota",
    ]);
    await expect(readFile(join(root, "profiles", "a".repeat(64), "b".repeat(64), "config.toml"), "utf8")).resolves.toBe(
      'cli_auth_credentials_store = "file"\n',
    );
  });

  it("ready 응답에 직접 quota 관측 증거가 없으면 기존 Codex profile을 재사용하지 않는다", async () => {
    const { root, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") return { data: [existingDoctor()] };
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });
    client.command.mockResolvedValue({
      outcome: "succeeded",
      data: { connectorId: "server-existing-123", status: "ready" },
    } as never);

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("직접 quota 관측 증거");

    expect(runInteractive).not.toHaveBeenCalled();
    expect(client.command).toHaveBeenCalledOnce();
  });

  it("조직에 공유된 다른 사용자의 Codex 계정은 profile을 열거나 로그인하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") {
        return {
          data: [
            existingAccount({
              canManage: false,
              scope: "organization",
              status: "needs-reauth",
            }),
          ],
        };
      }
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor({ accountStatus: "needs-reauth", action: "reauth" })] };
      }
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", alias: "기존 Codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("계정 소유자만");

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("공유받은 profile이 함께 있어도 현재 사용자가 관리하는 유일한 Codex profile을 재사용한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string, payload: unknown) => {
      if (operation === "subscription.accounts") {
        return {
          data: [
            existingAccount(),
            existingAccount({
              accountId: "account-shared-456",
              connectorId: "server-shared-456",
              alias: "공유 Codex",
              scope: "organization",
              canManage: false,
              profileHandle: `${"c".repeat(64)}/${"d".repeat(64)}`,
            }),
          ],
        };
      }
      if (operation === "subscription.doctor") {
        expect(payload).toEqual({ accountId: "account-existing-123" });
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") {
        expect(payload).toEqual({ accountId: "account-existing-123" });
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      accountId: "account-existing-123",
      connectorId: "server-existing-123",
      connectionDisposition: "reused",
    });

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("기존 관리 profile에 auth.json이 없으면 같은 profile에서 로그인한 뒤에만 건강 증명한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await mkdir(join(root, "profiles", "a".repeat(64), "b".repeat(64)), { recursive: true, mode: 0o700 });
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") {
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      status: "ready",
      accountId: "account-existing-123",
      connectionDisposition: "reauthenticated",
    });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
    await expect(readFile(join(root, "profiles", "a".repeat(64), "b".repeat(64), "auth.json"), "utf8")).resolves.toBe(
      "fixture",
    );
  });

  it("이전 keyring profile은 전역 자격 증명을 읽지 않고 같은 profile에서 한 번 격리 file 인증으로 전환한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    const profile = join(root, "profiles", "a".repeat(64), "b".repeat(64));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, "config.toml"), 'cli_auth_credentials_store = "keyring"\n', { mode: 0o600 });
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") return { data: [existingDoctor()] };
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ accountId: "account-existing-123", connectionDisposition: "reauthenticated" });
    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ accountId: "account-existing-123", connectionDisposition: "reused" });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"', "login"],
      expect.objectContaining({
        CODEX_HOME: expect.stringContaining(join("profiles", "a".repeat(64), "b".repeat(64))),
      }),
    );
    await expect(readFile(join(profile, "config.toml"), "utf8")).resolves.toBe(
      'cli_auth_credentials_store = "keyring"\n',
    );
    await expect(readFile(join(profile, "auth.json"), "utf8")).resolves.toBe("fixture");
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.attest",
      "subscription.server.attest",
    ]);
  });

  it("기존 profile의 preflight quota가 비어 있으면 재로그인하지 않고 attest 뒤 직접 관측된 quota를 다시 확인한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    let quotaQueries = 0;
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor({ quotaStatus: "unknown" })] };
      }
      if (operation === "subscription.quota") {
        quotaQueries += 1;
        return { data: quotaQueries === 1 ? [] : [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ accountId: "account-existing-123", connectionDisposition: "reused" });

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
    expect(quotaQueries).toBe(2);
  });

  it("preflight quota가 비어 있으면 health 뒤 직접 관측한 quota의 exhausted 형식도 검증한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    let quotaQueries = 0;
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") return { data: [existingDoctor({ quotaStatus: "unknown" })] };
      if (operation === "subscription.quota") {
        quotaQueries += 1;
        if (quotaQueries === 1) return { data: [] };
        const quota = reportedCodexQuota("account-existing-123");
        return { data: [{ ...quota, exhausted: undefined }] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("Codex quota 직접 관측 결과");

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("preflight quota가 비어 있으면 health 뒤 직접 관측한 quota의 잔여 비율 범위도 검증한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    let quotaQueries = 0;
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") return { data: [existingDoctor({ quotaStatus: "unknown" })] };
      if (operation === "subscription.quota") {
        quotaQueries += 1;
        if (quotaQueries === 1) return { data: [] };
        const quota = reportedCodexQuota("account-existing-123");
        return {
          data: [
            {
              ...quota,
              windows: quota.windows.map((window) => ({ ...window, remainingRatio: 1.1 })),
            },
          ],
        };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("잔여 비율");

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("기존 Codex profile의 live attest만 재인증을 요구하면 같은 profile에서 한 번 로그인하고 새 command로 재검증한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") {
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });
    let attestAttempts = 0;
    client.command.mockImplementation(async (command: unknown) => {
      const value = command as Record<string, unknown>;
      commands.push(value);
      if (value.operation !== "subscription.server.attest") throw new Error("예상하지 않은 command입니다");
      attestAttempts += 1;
      if (attestAttempts === 1) {
        throw new ApplicationRemoteError(401, {
          category: "authentication",
          operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
          userMessage: "Codex 구독 profile에 재인증이 필요합니다",
        });
      }
      const payload = value.payload as { connectorId?: string };
      if (typeof payload.connectorId !== "string") throw new Error("Connector ID가 누락되었습니다");
      return {
        outcome: "succeeded",
        data: { connectorId: payload.connectorId, status: "ready", quotaObservation: directQuotaObservation() },
      };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      accountId: "account-existing-123",
      connectorId: "server-existing-123",
      connectionDisposition: "reauthenticated",
    });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"', "login"],
      expect.objectContaining({
        CODEX_HOME: expect.stringContaining(join("profiles", "a".repeat(64), "b".repeat(64))),
      }),
    );
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.attest",
      "subscription.server.attest",
    ]);
    expect(commands[0]?.commandId).not.toBe(commands[1]?.commandId);
  });

  it("재로그인 뒤에도 같은 재인증 신호가 오면 한 번만 로그인하고 오류를 보존한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });
    client.command.mockImplementation(async (command: unknown) => {
      commands.push(command as Record<string, unknown>);
      throw new ApplicationRemoteError(401, {
        category: "authentication",
        operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
        userMessage: "Codex 구독 profile에 재인증이 필요합니다",
      });
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toMatchObject({
      status: 401,
      body: { operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED" },
    });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.attest",
      "subscription.server.attest",
    ]);
    expect(commands[0]?.commandId).not.toBe(commands[1]?.commandId);
  });

  it.each([
    ["다른 운영 코드", new ApplicationRemoteError(401, { category: "authentication", operatorCode: "APP_OTHER" })],
    [
      "유료 Codex 구독 불가",
      new ApplicationRemoteError(400, { category: "validation", operatorCode: "APP_SUBSCRIPTION_PAID_PLAN_REQUIRED" }),
    ],
    ["일반 네트워크 오류", new Error("network timeout")],
    ["형식 오류", new ApplicationRemoteError(500, { category: "internal", operatorCode: "APP_INTERNAL" })],
  ])("정확한 재인증 계약이 아닌 %s에는 기존 Codex 로그인을 시작하지 않는다", async (_label, failure) => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });
    client.command.mockImplementation(async (command: unknown) => {
      commands.push(command as Record<string, unknown>);
      throw failure;
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toBe(failure);

    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("재인증이 필요한 기존 Codex profile만 해당 profile에서 로그인하고 재사용한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount({ status: "needs-reauth" })] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor({ accountStatus: "needs-reauth", action: "reauth" })] };
      }
      if (operation === "subscription.quota") {
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      accountId: "account-existing-123",
      connectorId: "server-existing-123",
      connectionDisposition: "reauthenticated",
    });

    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"', "login"],
      expect.objectContaining({
        CODEX_HOME: expect.stringContaining(join("profiles", "a".repeat(64), "b".repeat(64))),
      }),
    );
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("기존 Codex quota가 다른 계정으로 반환되면 로그인과 attestation을 시작하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [existingDoctor()] };
      }
      if (operation === "subscription.quota") return { data: [{ accountId: "other-account" }] };
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("quota 계보");

    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });

  it("기존 Codex quota의 형식이 깨지면 로그인과 attestation을 시작하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    let quotaQueries = 0;
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") return { data: [existingDoctor()] };
      if (operation === "subscription.quota") {
        quotaQueries += 1;
        if (quotaQueries === 1) {
          return {
            data: [
              {
                accountId: "account-existing-123",
                windows: "not-an-array",
                exhausted: false,
                observedAt: new Date().toISOString(),
              },
            ],
          };
        }
        return { data: [reportedCodexQuota("account-existing-123")] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("quota 응답");

    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
    expect(quotaQueries).toBe(1);
  });

  it("기존 profile doctor가 다른 Connector 계보이면 로그인과 attestation을 시작하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await seedExistingCodexProfile(root);
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return {
          data: [
            {
              accountId: "account-existing-123",
              providerId: "openai-codex",
              alias: "기존 Codex",
              accountStatus: "active",
              connectorId: "server-other-123",
              connectorLocation: "server",
              connectorStatus: "ready",
              quotaStatus: "available",
              action: "none",
            },
          ],
        };
      }
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow("doctor 계보");

    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });

  it("new-account 선택은 기존 계정 조회를 재사용하지 않고 새 Codex 로그인으로 시작한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    client.query.mockImplementation(async (operation: string, payload: unknown) => {
      if (operation === "subscription.quota") {
        const accountId = (payload as { accountId?: unknown })?.accountId;
        if (typeof accountId !== "string") throw new Error("quota 계정 ID가 누락되었습니다");
        return { data: [reportedCodexQuota(accountId)] };
      }
      return { data: [existingAccount()] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", newAccount: true },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ status: "ready", accountId: "account-12345678", connectionDisposition: "new" });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.attest",
    ]);
  });

  it("새 Codex 계정의 건강 증명이 재인증을 요구하면 배치된 같은 profile에서 한 번 다시 로그인하고 재개한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    let attestAttempts = 0;
    client.command.mockImplementation(async (command: unknown) => {
      const value = command as Record<string, unknown>;
      commands.push(value);
      if (value.operation === "subscription.server.prepare") {
        return {
          outcome: "succeeded",
          resource: { type: "SubscriptionAccount", id: "account-12345678" },
          data: {
            accountId: "account-12345678",
            connectorId: "server-1234567890abcdef",
            profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
            loginRequired: true,
          },
        };
      }
      if (value.operation !== "subscription.server.attest") throw new Error("예상하지 않은 command입니다");
      attestAttempts += 1;
      if (attestAttempts === 1) {
        throw new ApplicationRemoteError(401, {
          category: "authentication",
          operatorCode: "APP_SUBSCRIPTION_REAUTH_REQUIRED",
          userMessage: "Codex 구독 profile에 재인증이 필요합니다",
        });
      }
      const payload = value.payload as { connectorId?: unknown };
      if (typeof payload.connectorId !== "string") throw new Error("Connector ID가 누락되었습니다");
      return {
        outcome: "succeeded",
        data: { connectorId: payload.connectorId, status: "ready", quotaObservation: directQuotaObservation() },
      };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", newAccount: true },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({
      status: "ready",
      accountId: "account-12345678",
      connectionDisposition: "new",
    });

    expect(runInteractive).toHaveBeenCalledTimes(2);
    expect(runInteractive.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({
        CODEX_HOME: expect.stringContaining(join("profiles", "a".repeat(64), "b".repeat(64))),
      }),
    );
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.attest",
      "subscription.server.attest",
    ]);
    expect(commands[1]?.commandId).toBe(commands[2]?.commandId);
  });

  it("중단된 새 Codex 계정 추가는 다음 실행에서도 --new-account를 다시 명시해야만 재개한다", async () => {
    const { root, client, inspectRuntime, runInteractive } = await fixture();
    const interruptedLogin = vi.fn().mockResolvedValue(1);
    client.query.mockResolvedValue({ data: [existingAccount()] });
    const options = { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive };

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", newAccount: true },
        { ...options, runInteractive: interruptedLogin },
      ),
    ).rejects.toThrow("로그인이 완료되지 않았습니다");
    await expect(connectLocalServerSubscription(client, { providerId: "openai-codex" }, options)).rejects.toThrow(
      "--new-account",
    );

    expect(interruptedLogin).toHaveBeenCalledOnce();
    expect(runInteractive).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("이전 형식의 중단된 기존 연결은 intent 없이도 새 계정을 만들지 않고 재개한다", async () => {
    const { root, client, inspectRuntime, runInteractive } = await fixture();
    const interruptedLogin = vi.fn().mockResolvedValue(1);
    const options = { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive };

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { ...options, runInteractive: interruptedLogin },
      ),
    ).rejects.toThrow("로그인이 완료되지 않았습니다");

    const pendingPath = join(root, ".pending-subscriptions", "openai-codex.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
    const legacyPending = Object.fromEntries(Object.entries(pending).filter(([key]) => key !== "intent"));
    await writeFile(pendingPath, `${JSON.stringify(legacyPending)}\n`, "utf8");

    await expect(
      connectLocalServerSubscription(client, { providerId: "openai-codex" }, options),
    ).resolves.toMatchObject({
      status: "ready",
      connectionDisposition: "new",
    });

    expect(interruptedLogin).toHaveBeenCalledOnce();
    expect(runInteractive).toHaveBeenCalledOnce();
  });

  it("기존 profile의 상위 경로가 심볼릭 링크이면 재인증 프로세스를 시작하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "massion-cli-subscription-outside-"));
    cleanups.push(outside);
    const organizationSegment = "a".repeat(64);
    const accountSegment = "b".repeat(64);
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await mkdir(join(outside, accountSegment), { recursive: true, mode: 0o700 });
    await symlink(outside, join(root, "profiles", organizationSegment), "dir");
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount({ status: "needs-reauth" })] };
      if (operation === "subscription.doctor")
        return { data: [existingDoctor({ action: "reauth", accountStatus: "needs-reauth" })] };
      if (operation === "subscription.quota") return { data: [reportedCodexQuota("account-existing-123")] };
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).rejects.toThrow(/symlink|안전/u);

    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(runInteractive).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
    await expect(readFile(join(outside, accountSegment, "config.toml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("건강 증명 응답이 끊기면 같은 command와 profile로 재개하며 로그인을 반복하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    // 순서가 있는 응답을 유지하면서 호출 원문도 별도로 수집합니다.
    const responses = [
      {
        outcome: "succeeded",
        resource: { type: "SubscriptionAccount", id: "account-12345678" },
        data: {
          accountId: "account-12345678",
          connectorId: "server-1234567890abcdef",
          profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
          loginRequired: true,
        },
      },
      new Error("attest response lost"),
      {
        outcome: "succeeded",
        data: {
          connectorId: "server-1234567890abcdef",
          status: "ready",
          quotaObservation: directQuotaObservation(),
        },
      },
    ];
    client.command.mockImplementation(async (command: unknown) => {
      commands.push(command as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("예상하지 않은 추가 command입니다");
      if (response instanceof Error) throw response;
      return response;
    });
    const options = {
      endpoint: "http://localhost:7331",
      connectorDirectory: root,
      environment: { PATH: "/usr/bin" },
      inspectRuntime,
      runInteractive,
    };

    await expect(connectLocalServerSubscription(client, { providerId: "openai-codex" }, options)).rejects.toThrow(
      "attest response lost",
    );
    await expect(
      connectLocalServerSubscription(client, { providerId: "openai-codex" }, options),
    ).resolves.toMatchObject({ status: "ready" });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.attest",
      "subscription.server.attest",
    ]);
    expect(commands[1]?.commandId).toBe(commands[2]?.commandId);
  });

  it("새 계정 준비 응답이 실패하면 --new-account와 같은 command로 재개하며 로그인을 반복하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    const responses = [
      new Error("prepare response lost"),
      {
        outcome: "succeeded",
        resource: { type: "SubscriptionAccount", id: "account-12345678" },
        data: {
          accountId: "account-12345678",
          connectorId: "server-1234567890abcdef",
          profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
          loginRequired: true,
        },
      },
      {
        outcome: "succeeded",
        data: {
          connectorId: "server-1234567890abcdef",
          status: "ready",
          quotaObservation: directQuotaObservation(),
        },
      },
    ];
    client.command.mockImplementation(async (command: unknown) => {
      commands.push(command as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("예상하지 않은 추가 command입니다");
      if (response instanceof Error) throw response;
      return response;
    });
    const options = {
      endpoint: "http://localhost:7331",
      connectorDirectory: root,
      environment: { PATH: "/usr/bin" },
      inspectRuntime,
      runInteractive,
    };

    await expect(
      connectLocalServerSubscription(client, { providerId: "openai-codex", newAccount: true }, options),
    ).rejects.toThrow("prepare response lost");
    await expect(
      connectLocalServerSubscription(client, { providerId: "openai-codex", newAccount: true }, options),
    ).resolves.toMatchObject({ status: "ready", connectionDisposition: "new" });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.prepare",
      "subscription.server.attest",
    ]);
    expect(commands[0]?.commandId).toBe(commands[1]?.commandId);
  });

  it("team 서버·미지원 provider·미승인 Claude 소비자 로그인은 profile과 process 생성 전에 거부한다", async () => {
    const { root, client, inspectRuntime, runInteractive } = await fixture();
    client.status.mockResolvedValue({ data: { mode: "team" } });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        {
          endpoint: "https://massion.example.com",
          connectorDirectory: root,
          inspectRuntime,
          runInteractive,
        },
      ),
    ).rejects.toThrow("local mode");
    await expect(
      connectLocalServerSubscription(
        { ...client, status: async () => ({ data: { mode: "local" } }) },
        { providerId: "google-gemini-cli-enterprise" },
        {
          endpoint: "http://127.0.0.1:7331",
          connectorDirectory: root,
          inspectRuntime,
          runInteractive,
        },
      ),
    ).rejects.toThrow("Codex");
    await expect(
      connectLocalServerSubscription(
        { ...client, status: async () => ({ data: { mode: "local" } }) },
        { providerId: "anthropic-claude-code" },
        {
          endpoint: "http://127.0.0.1:7331",
          connectorDirectory: root,
          inspectRuntime,
          runInteractive,
        },
      ),
    ).rejects.toThrow(/승인|Anthropic/u);
    expect(inspectRuntime).not.toHaveBeenCalled();
    expect(runInteractive).not.toHaveBeenCalled();
  });
});
