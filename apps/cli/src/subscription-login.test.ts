import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
      query: vi.fn(async (operation: string) => {
        void operation;
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
          data: { connectorId: payload?.connectorId ?? "server-1234567890abcdef", status: "ready" },
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
      connectorStatus: "ready",
      status: "active",
      version: 4,
      profileHandle: `${"a".repeat(64)}/${"b".repeat(64)}`,
      ...overrides,
    };
  }

  it("공식 bundled Codex를 격리 profile에서 별도 데이터 고지 없이 로그인하고 준비·건강 증명을 완료한다", async () => {
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
    });

    expect(inspectRuntime).toHaveBeenCalledWith("codex");
    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "login"],
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
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    expect((await readdir(join(root, ".pending-subscriptions"))).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("유효한 기존 Codex profile은 account·doctor·quota 확인 뒤 로그인하지 않고 재사용한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await mkdir(join(root, "profiles", "a".repeat(64), "b".repeat(64)), { recursive: true, mode: 0o700 });
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return {
          data: [
            {
              accountId: "account-existing-123",
              providerId: "openai-codex",
              accountStatus: "active",
              connectorId: "server-existing-123",
              connectorStatus: "ready",
              quotaStatus: "available",
              action: "none",
            },
          ],
        };
      }
      if (operation === "subscription.quota") {
        return { data: [{ accountId: "account-existing-123", windows: [], exhausted: false }] };
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
    ]);
  });

  it("재인증이 필요한 기존 Codex profile만 해당 profile에서 로그인하고 재사용한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await mkdir(join(root, "profiles", "a".repeat(64), "b".repeat(64)), { recursive: true, mode: 0o700 });
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount({ status: "needs-reauth" })] };
      if (operation === "subscription.doctor") {
        return {
          data: [
            {
              accountId: "account-existing-123",
              providerId: "openai-codex",
              accountStatus: "needs-reauth",
              connectorId: "server-existing-123",
              connectorStatus: "ready",
              quotaStatus: "available",
              action: "reauth",
            },
          ],
        };
      }
      if (operation === "subscription.quota") {
        return { data: [{ accountId: "account-existing-123", windows: [], exhausted: false }] };
      }
      return { data: [] };
    });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex" },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ accountId: "account-existing-123", connectorId: "server-existing-123" });

    expect(runInteractive).toHaveBeenCalledWith(
      "/runtime/node",
      ["/runtime/codex.js", "login"],
      expect.objectContaining({
        CODEX_HOME: expect.stringContaining(join("profiles", "a".repeat(64), "b".repeat(64))),
      }),
    );
    expect(commands.map((command) => command.operation)).toEqual(["subscription.server.attest"]);
  });

  it("기존 Codex quota가 다른 계정으로 반환되면 로그인과 attestation을 시작하지 않는다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    await mkdir(join(root, "profiles", "a".repeat(64), "b".repeat(64)), { recursive: true, mode: 0o700 });
    client.query.mockImplementation(async (operation: string) => {
      if (operation === "subscription.accounts") return { data: [existingAccount()] };
      if (operation === "subscription.doctor") {
        return { data: [{ accountId: "account-existing-123", accountStatus: "active", action: "none" }] };
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

  it("new-account 선택은 기존 계정 조회를 재사용하지 않고 새 Codex 로그인으로 시작한다", async () => {
    const { root, commands, client, inspectRuntime, runInteractive } = await fixture();
    client.query.mockResolvedValue({ data: [existingAccount()] });

    await expect(
      connectLocalServerSubscription(
        client,
        { providerId: "openai-codex", newAccount: true },
        { endpoint: "http://127.0.0.1:7331", connectorDirectory: root, inspectRuntime, runInteractive },
      ),
    ).resolves.toMatchObject({ status: "ready", accountId: "account-12345678" });

    expect(runInteractive).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.operation)).toEqual([
      "subscription.server.prepare",
      "subscription.server.attest",
    ]);
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
        data: { connectorId: "server-1234567890abcdef", status: "ready" },
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
