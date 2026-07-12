import { describe, expect, it, vi } from "vitest";

import { executeCliInvocation, type CliApplicationClient } from "./commands.js";
import { parseCliArguments } from "./parser.js";

describe("CLI Application adapter", () => {
  it("subscription enroll은 재시도하지 않는 전용 API로 일회 등록 코드를 발급한다", async () => {
    const issueConnectorEnrollment = vi.fn().mockResolvedValue({ enrollmentCode: "one-time-code" });
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      issueConnectorEnrollment,
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await executeCliInvocation(client, parseCliArguments(["subscription", "enroll", "edge", "agent-runtime", "60000"]));
    expect(issueConnectorEnrollment).toHaveBeenCalledWith({
      commandId: expect.any(String),
      location: "edge",
      executionKind: "agent-runtime",
      ttlMs: 60_000,
    });
    await expect(
      executeCliInvocation(client, parseCliArguments(["subscription", "enroll", "remote", "agent-runtime"])),
    ).rejects.toThrow("edge");
    await expect(
      executeCliInvocation(client, parseCliArguments(["subscription", "enroll", "server", "agent-runtime"])),
    ).rejects.toThrow("server-managed provisioning");
  });

  it("조회와 mutation을 ApplicationClient 경계만으로 호출한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({ ok: true }),
      snapshot: async () => ({ graph: true }),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return { operation };
      },
      command: async (input) => {
        calls.push(input);
        return { outcome: "succeeded" };
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["work", "list"]));
    await executeCliInvocation(client, parseCliArguments(["approval", "approve", "approval-1", "동의"]));
    await executeCliInvocation(client, parseCliArguments(["resume", "run-12345678", "--retry-blocked"]));
    expect(calls[0]).toEqual(["work.list", {}]);
    expect(calls[1]).toMatchObject({
      operation: "approval.vote",
      payload: { approvalId: "approval-1", vote: "approve", reason: "동의" },
    });
    expect(calls[2]).toMatchObject({ operation: "run.resume", payload: { runId: "run-12345678", retryBlocked: true } });
  });

  it("credential·route·조직 변경은 argv가 아닌 stdin JSON을 사용한다", async () => {
    let command: unknown;
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async (input) => {
        command = input;
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["provider", "credential-add"]), {
      readJson: async () => ({ providerId: "openai", secret: "reference-only" }),
    });
    expect(command).toMatchObject({ operation: "router.credential.add", payload: { providerId: "openai" } });
    await executeCliInvocation(client, parseCliArguments(["provider", "model-add"]), {
      readJson: async () => ({ providerId: "openai", modelId: "gpt" }),
    });
    expect(command).toMatchObject({ operation: "router.model.register", payload: { modelId: "gpt" } });
    await executeCliInvocation(client, parseCliArguments(["assurance", "binding-propose"]), {
      readJson: async () => ({ workId: "work-1", planVersionId: "plan-1" }),
    });
    expect(command).toMatchObject({ operation: "assurance.binding.propose", payload: { workId: "work-1" } });
  });

  it("provider list가 credential과 fallback route를 함께 조회한다", async () => {
    const operations: string[] = [];
    const client = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation: string) => {
        operations.push(operation);
        return { operation };
      },
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await expect(executeCliInvocation(client, parseCliArguments(["provider", "list"]))).resolves.toMatchObject({
      catalog: { operation: "router.catalog" },
      credentials: { operation: "router.credentials" },
      routes: { operation: "router.routes" },
    });
    expect(operations).toEqual(["router.catalog", "router.credentials", "router.routes"]);
  });

  it("구독 실행 계보를 공개 질의 경계로만 조회한다", async () => {
    const query = vi.fn().mockResolvedValue({ executionId: "execution-1", attempts: [] });
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query,
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await executeCliInvocation(client, parseCliArguments(["runtime", "lineage", "execution-1"]));
    expect(query).toHaveBeenCalledWith("runtime.execution.subscription-lineage", { executionId: "execution-1" });
    await executeCliInvocation(client, parseCliArguments(["runtime", "lineage", "correlation", "correlation-1"]));
    expect(query).toHaveBeenCalledWith("runtime.execution.subscription-lineage", {
      correlationId: "correlation-1",
    });
  });

  it("공식 Integration 상태와 연결 변경을 같은 Application 경계로 호출한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return {};
      },
      command: async (input) => {
        calls.push(input);
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["integration", "list"]));
    await executeCliInvocation(client, parseCliArguments(["integration", "deliveries", "25"]));
    await executeCliInvocation(client, parseCliArguments(["integration", "channel-bind"]), {
      readJson: async () => ({
        installationId: "installation-12345678",
        externalResourceId: "massion/project",
        resourceKind: "repository",
        events: ["issues"],
      }),
    });
    expect(calls[0]).toEqual(["integration.list", {}]);
    expect(calls[1]).toEqual(["integration.deliveries", { limit: 25 }]);
    expect(calls[2]).toMatchObject({ operation: "integration.channel.bind" });
  });

  it("Marketplace 검색·설치·inventory를 Registry Application operation으로 전달한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return {};
      },
      command: async (input) => {
        calls.push(input);
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["ext", "search", "slack"]));
    await executeCliInvocation(client, parseCliArguments(["ext", "install", "version-12345678"]));
    await executeCliInvocation(client, parseCliArguments(["ext", "inventory"]));
    expect(calls[0]).toEqual(["registry.search", { query: "slack", limit: 20 }]);
    expect(calls[1]).toMatchObject({ operation: "registry.install", payload: { versionId: "version-12345678" } });
    expect(calls[2]).toEqual(["registry.inventory", {}]);
  });

  it("Registry publish는 artifact와 stdin trust metadata를 분리해 전달한다", async () => {
    const publishArtifact = vi.fn(async () => ({}));
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
      publishArtifact,
    };
    await executeCliInvocation(client, parseCliArguments(["ext", "publish", "extension.tgz"]), {
      readArtifact: async () => Buffer.from("artifact"),
      readJson: async () => ({ uploadGrant: "grant-reference", provenanceBundle: {} }),
    });
    expect(publishArtifact).toHaveBeenCalledWith(expect.any(String), Buffer.from("artifact"), {
      uploadGrant: "grant-reference",
      provenanceBundle: {},
    });
  });

  it("구독 조회와 계정 변경을 공개 Application operation으로 전달한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        if (operation === "subscription.providers") {
          return {
            data: [
              {
                providerId: "verified-provider",
                connectionSurface: "server-and-edge",
                runtimeCapabilities: { approvalModes: ["automatic", "review", "deny"] },
              },
            ],
          };
        }
        return operation === "subscription.accounts"
          ? { data: [{ accountId: "account-1", version: 3 }] }
          : { operation };
      },
      command: async (command) => {
        calls.push(command);
        return { outcome: "succeeded" };
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await executeCliInvocation(client, parseCliArguments(["subscription", "providers"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "accounts"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "quota", "account-1"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "policy", "verified-provider"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "doctor", "account-1"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "share", "account-1"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "unshare", "account-1"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "disconnect", "account-1"]));
    await executeCliInvocation(client, parseCliArguments(["subscription", "connect-advanced", "verified-provider"]), {
      readJson: async () => ({
        alias: "업무 계정",
        connectorId: "connector-1",
        profileLocator: "외부 계정 참조",
        authKind: "cli-profile",
        billingKind: "subscription",
      }),
    });
    await executeCliInvocation(
      client,
      parseCliArguments(["subscription", "policy", "verified-provider", "quota-headroom", "automatic", "4"]),
    );

    expect(calls).toContainEqual(["subscription.providers", {}]);
    expect(calls).toContainEqual(["subscription.accounts", {}]);
    expect(calls).toContainEqual(["subscription.quota", { accountId: "account-1" }]);
    expect(calls).toContainEqual(["subscription.policy", { providerId: "verified-provider" }]);
    expect(calls).toContainEqual(["subscription.doctor", { accountId: "account-1" }]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        operation: "subscription.account.share",
        expectedRevision: 3,
        payload: { accountId: "account-1" },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        operation: "subscription.account.unshare",
        expectedRevision: 3,
        payload: { accountId: "account-1" },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        operation: "subscription.account.disconnect",
        expectedRevision: 3,
        payload: { accountId: "account-1" },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        operation: "subscription.account.register",
        payload: expect.objectContaining({ providerId: "verified-provider", connectorId: "connector-1" }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        operation: "subscription.policy.configure",
        expectedRevision: 4,
        payload: {
          providerId: "verified-provider",
          credentialPolicy: "quota-headroom",
          approvalMode: "automatic",
        },
      }),
    );
  });

  it("구독 정책 command는 Provider가 공개한 승인 방식만 허용하고 unavailable을 거부한다", async () => {
    const command = vi.fn().mockResolvedValue({ outcome: "succeeded" });
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation) => {
        if (operation !== "subscription.providers") return {};
        return {
          data: [
            {
              providerId: "github-copilot",
              connectionSurface: "edge-only",
              runtimeCapabilities: { approvalModes: ["automatic", "deny"] },
            },
            {
              providerId: "google-antigravity-cli",
              connectionSurface: "unavailable",
              runtimeCapabilities: {},
            },
          ],
        };
      },
      command,
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "policy", "github-copilot", "adaptive", "review", "1"]),
      ),
    ).rejects.toThrow(/review|승인 방식/u);
    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "policy", "google-antigravity-cli", "adaptive", "deny", "1"]),
      ),
    ).rejects.toThrow(/연결|unavailable/u);
    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "policy", "github-copilot", "adaptive", "automatic", "1"]),
      ),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("Codex 정책 command는 연결된 계정의 실행 표면에 맞춰 review 지원 여부를 판단한다", async () => {
    let connectorLocation: "server" | "edge" = "server";
    const command = vi.fn().mockResolvedValue({ outcome: "succeeded" });
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation) => {
        if (operation === "subscription.providers") {
          return {
            data: [
              {
                providerId: "openai-codex",
                connectionSurface: "server-and-edge",
                runtimeCapabilities: {
                  approvalModes: ["automatic", "deny"],
                  approvalModesBySurface: {
                    server: ["automatic", "review", "deny"],
                    edge: ["automatic", "deny"],
                  },
                },
              },
            ],
          };
        }
        if (operation === "subscription.accounts") {
          return { data: [{ providerId: "openai-codex", connectorLocation }] };
        }
        return {};
      },
      command,
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "policy", "openai-codex", "adaptive", "review", "1"]),
      ),
    ).resolves.toEqual({ outcome: "succeeded" });

    connectorLocation = "edge";
    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "policy", "openai-codex", "adaptive", "review", "1"]),
      ),
    ).rejects.toThrow(/review|승인 방식/u);
  });

  it("subscription connect-advanced는 인증 정보 원문 없이 Connector 연결 metadata를 stdin으로 받는다", async () => {
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    const invocation = parseCliArguments(["subscription", "connect-advanced", "verified-provider"]);

    await expect(executeCliInvocation(client, invocation)).rejects.toThrow("구독 Connector 연결");
    await expect(
      executeCliInvocation(client, invocation, {
        readJson: async () => ({
          alias: "업무 계정",
          connectorId: "connector-1",
          profileLocator: "외부 계정 참조",
          authKind: "cli-profile",
          billingKind: "subscription",
          token: "원문-token-금지",
        }),
      }),
    ).rejects.toThrow("알 수 없는 필드가 있습니다: token");
  });

  it("subscription connect-model은 secret을 argv가 아닌 stdin에서만 읽어 서버 연결 adapter에 전달한다", async () => {
    const secret = "minimax-cli-secret-never-returned";
    const connectServerModelSubscription = vi.fn().mockResolvedValue({
      accountId: "account-model-12345678",
      connectorId: "server-model-12345678",
      status: "active",
      connectorStatus: "ready",
    });
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    const result = await executeCliInvocation(
      client,
      parseCliArguments(["subscription", "connect-model", "minimax-token-plan"]),
      {
        readJson: async () => ({ secret, alias: "개인 MiniMax" }),
        connectServerModelSubscription,
      },
    );

    expect(connectServerModelSubscription).toHaveBeenCalledWith({
      providerId: "minimax-token-plan",
      alias: "개인 MiniMax",
      authKind: "subscription-key",
      billingKind: "token-plan",
      secret,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(
      executeCliInvocation(client, parseCliArguments(["subscription", "connect-model", "minimax-token-plan", secret]), {
        readJson: async () => ({ secret }),
        connectServerModelSubscription,
      }),
    ).rejects.toThrow(/stdin|명령행|argv/u);
  });

  it("subscription connect는 로컬 로그인 adapter에 provider와 사람이 읽는 별칭만 전달한다", async () => {
    const connectServerSubscription = vi.fn(async () => ({ status: "ready" }));
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await expect(
      executeCliInvocation(
        client,
        parseCliArguments(["subscription", "connect", "openai-codex", "개인 Codex", "--model", "gpt-5.6-sol"]),
        {
          connectServerSubscription,
        },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(connectServerSubscription).toHaveBeenCalledWith({
      providerId: "openai-codex",
      alias: "개인 Codex",
      modelId: "gpt-5.6-sol",
    });
  });

  it("subscription share 승인 재개는 approval ID와 원래 command ID를 함께 보존한다", async () => {
    const commands: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({ data: [{ accountId: "account-1", version: 3 }] }),
      command: async (input) => {
        commands.push(input);
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };

    await expect(
      executeCliInvocation(client, parseCliArguments(["subscription", "share", "account-1", "approval-1"])),
    ).rejects.toThrow("함께 필요");
    await executeCliInvocation(
      client,
      parseCliArguments(["subscription", "share", "account-1", "approval-1", "original-command-1"]),
    );
    expect(commands).toEqual([
      expect.objectContaining({
        commandId: "original-command-1",
        expectedRevision: 3,
        operation: "subscription.account.share",
        payload: { accountId: "account-1", approvalId: "approval-1" },
      }),
    ]);
  });
});
