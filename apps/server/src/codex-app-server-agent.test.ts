import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import type { TenantContext } from "@massion/identity";
import type { SubscriptionPermissionBridge } from "@massion/runtime";

import type { CodexAppServerConnection, CodexAppServerOptions } from "./codex-app-server.js";
import { CodexAppServerSubscriptionConnector, type CodexAppServerOpen } from "./codex-app-server-agent.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const inputTemplate = {
  executionId: "execution-review",
  workId: "work-review",
  agentHandle: "software-engineering.backend-specialist",
  prompt: "상태를 확인하고 필요한 파일을 고치세요",
  workspaceRoot: "/tmp/massion-workspace",
  profileRoot: "",
  environment: { PATH: "/usr/bin", LANG: "ko_KR.UTF-8", SECRET_TOKEN: "never-forward" },
  allowedTools: [],
  disallowedTools: [],
} as const;

let input: typeof inputTemplate;
const profiles: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object가 필요합니다");
  return value as Record<string, unknown>;
}

describe("Codex app-server 구독 실행 adapter", () => {
  beforeEach(async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-app-server-profile-"));
    profiles.push(profileRoot);
    await chmod(profileRoot, 0o700);
    await writeFile(join(profileRoot, "auth.json"), "private-login-state", { mode: 0o600 });
    input = { ...inputTemplate, profileRoot };
  });

  afterEach(async () => {
    await Promise.all(profiles.splice(0).map(async (profile) => await rm(profile, { recursive: true, force: true })));
  });

  it("관리 Codex profile의 auth.json이 없으면 app-server process를 열지 않고 실행을 거부한다", async () => {
    await rm(join(input.profileRoot, "auth.json"));
    const open = vi.fn() satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request: vi.fn() } satisfies SubscriptionPermissionBridge,
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );

    await expect(connector.execute(context, input)).rejects.toThrow(/auth\.json|재인증/u);
    expect(open).not.toHaveBeenCalled();
  });

  it("command 승인을 Governance에 중단하고 같은 server request를 승인한 뒤 turn을 완료한다", async () => {
    const request = vi
      .fn<SubscriptionPermissionBridge["request"]>()
      .mockResolvedValueOnce({
        outcome: "suspend",
        approvalId: "governance-approval-1",
      })
      .mockResolvedValueOnce({ outcome: "allow" });
    let options: CodexAppServerOptions | undefined;
    let approvalResponse: unknown;
    let fileApprovalResponse: unknown;
    let closed = false;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const connection: CodexAppServerConnection = {
      get closed() {
        return closed;
      },
      close: vi.fn(async () => {
        closed = true;
      }),
      notify: vi.fn(async () => undefined),
      request: vi.fn(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-review" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            const handler = options?.requestHandlers?.["item/commandExecution/requestApproval"];
            if (!handler) throw new Error("command approval handler가 필요합니다");
            void handler(
              {
                id: "server-request-1",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  itemId: "command-item-1",
                  startedAtMs: 1_000,
                  command: "git status --short",
                  cwd: "/tmp/massion-workspace",
                  reason: "workspace 확인",
                },
              },
              connection,
            ).then(async (response) => {
              approvalResponse = response;
              const fileHandler = options?.requestHandlers?.["item/fileChange/requestApproval"];
              if (!fileHandler) throw new Error("file approval handler가 필요합니다");
              fileApprovalResponse = await fileHandler(
                {
                  id: "server-request-2",
                  method: "item/fileChange/requestApproval",
                  params: {
                    threadId: "thread-review",
                    turnId: "turn-review",
                    itemId: "file-item-1",
                    startedAtMs: 1_500,
                    reason: "파일 수정",
                    grantRoot: "/tmp/massion-workspace",
                  },
                },
                connection,
              );
              await options?.onNotification?.({
                method: "item/completed",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  completedAtMs: 2_000,
                  item: { type: "agentMessage", id: "message-1", text: "검증 완료", phase: "final_answer" },
                },
              });
              await options?.onNotification?.({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-review",
                  turnId: "turn-review",
                  tokenUsage: {
                    last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 },
                  },
                },
              });
              await options?.onNotification?.({
                method: "turn/completed",
                params: {
                  threadId: "thread-review",
                  turn: { id: "turn-review", status: "completed", error: null },
                },
              });
            });
          });
          return { turn: { id: "turn-review" } };
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      }),
    };
    const open = vi.fn(async (_command, arguments_, environment, configuredOptions) => {
      expect(arguments_).toEqual(["/runtime/codex.js", "--config", 'cli_auth_credentials_store = "file"']);
      expect(environment).toEqual({
        CODEX_HOME: input.profileRoot,
        HOME: input.profileRoot,
        LANG: "ko_KR.UTF-8",
        NO_COLOR: "1",
        PATH: "/usr/bin",
      });
      expect(JSON.stringify(environment)).not.toContain("never-forward");
      options = configuredOptions;
      return connection;
    }) satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );

    await expect(connector.execute(context, input)).resolves.toEqual({
      outcome: "suspended",
      executionId: "execution-review",
      sessionId: "thread-review",
      approvalId: "governance-approval-1",
    });
    expect(connection.closed).toBe(false);
    expect(request).toHaveBeenCalledWith(context, {
      executionId: "execution-review",
      workId: "work-review",
      agentHandle: "software-engineering.backend-specialist",
      toolName: "CodexCommandExecution",
      toolInput: {
        command: "git status --short",
        cwd: "/tmp/massion-workspace",
        reason: "workspace 확인",
      },
      toolUseId: "command-item-1",
      permissionRequestId: "server-request-1",
    });

    await expect(
      connector.resume(context, input, {
        sessionId: "thread-review",
        approvalId: "governance-approval-1",
        approved: true,
      }),
    ).resolves.toEqual({
      outcome: "completed",
      executionId: "execution-review",
      sessionId: "thread-review",
      value: "검증 완료",
      usage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(approvalResponse).toEqual({ decision: "accept" });
    expect(fileApprovalResponse).toEqual({ decision: "accept" });
    expect(request).toHaveBeenNthCalledWith(2, context, {
      executionId: "execution-review",
      workId: "work-review",
      agentHandle: "software-engineering.backend-specialist",
      toolName: "CodexFileChange",
      toolInput: { reason: "파일 수정", grantRoot: "/tmp/massion-workspace" },
      toolUseId: "file-item-1",
      permissionRequestId: "server-request-2",
    });
    expect(connection.closed).toBe(true);

    const threadStart = record(calls.find((call) => call.method === "thread/start")?.params);
    expect(threadStart).toMatchObject({
      model: "gpt-5.6-codex",
      cwd: "/tmp/massion-workspace",
      runtimeWorkspaceRoots: ["/tmp/massion-workspace"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    const turnStart = record(calls.find((call) => call.method === "turn/start")?.params);
    expect(turnStart).toMatchObject({
      threadId: "thread-review",
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      model: "gpt-5.6-codex",
      cwd: "/tmp/massion-workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/tmp/massion-workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
  });

  it("기존 thread를 재개하고 turn/interrupt로 실행을 취소한다", async () => {
    let options: CodexAppServerOptions | undefined;
    let closed = false;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const connection: CodexAppServerConnection = {
      get closed() {
        return closed;
      },
      close: async () => {
        closed = true;
      },
      notify: async () => undefined,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/resume") return { thread: { id: "thread-existing" } };
        if (method === "turn/start") return { turn: { id: "turn-cancel" } };
        if (method === "turn/interrupt") {
          queueMicrotask(() => {
            void options?.onNotification?.({
              method: "turn/completed",
              params: { threadId: "thread-existing", turn: { id: "turn-cancel", status: "interrupted", error: null } },
            });
          });
          return {};
        }
        throw new Error(`예상하지 않은 method: ${method}`);
      },
    };
    const open = vi.fn(async (_command, _arguments, _environment, configuredOptions) => {
      options = configuredOptions;
      return connection;
    }) satisfies CodexAppServerOpen;
    const connector = new CodexAppServerSubscriptionConnector(
      { request: async () => ({ outcome: "deny", reason: "테스트" }) },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: "/usr/bin/node", commandArguments: ["/runtime/codex.js"] }),
      },
      open,
    );
    const resumedInput = { ...input, executionId: "execution-cancel", sessionId: "thread-existing" };
    const execution = connector.execute(context, resumedInput);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "turn/start")).toBe(true));

    await connector.cancel(context, "execution-cancel");

    await expect(execution).resolves.toEqual({
      outcome: "cancelled",
      executionId: "execution-cancel",
      sessionId: "thread-existing",
    });
    expect(calls).toContainEqual({
      method: "thread/resume",
      params: expect.objectContaining({
        threadId: "thread-existing",
        model: "gpt-5.6-codex",
        approvalPolicy: "on-request",
        sandbox: "read-only",
      }),
    });
    expect(calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-existing", turnId: "turn-cancel" },
    });
    expect(closed).toBe(true);
  });

  it("실제 NDJSON transport에서 thread→turn→승인→완료 순서를 수행한다", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-agent.mjs", import.meta.url));
    const connector = new CodexAppServerSubscriptionConnector(
      { request: async () => ({ outcome: "allow" }) },
      {
        model: "gpt-5.6-codex",
        policy: { sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccessEnabled: false },
        runtime: async () => ({ command: process.execPath, commandArguments: [fixturePath] }),
        timeoutMs: 5_000,
      },
    );

    await expect(connector.execute(context, input)).resolves.toEqual({
      outcome: "completed",
      executionId: "execution-review",
      sessionId: "thread-fixture",
      value: "실제 transport 완료",
    });
  });
});
