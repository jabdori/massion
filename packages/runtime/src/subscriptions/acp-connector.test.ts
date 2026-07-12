import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  CopilotAcpConnector,
  GeminiCliAcpConnector,
  GrokBuildAcpConnector,
  NodeAcpClientFactory,
  type AcpClientFactory,
  type AcpSession,
} from "./acp-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("Node ACP process factory", () => {
  it("공식 SDK NDJSON process와 initialize·session·prompt를 실제로 왕복한다", async () => {
    const factory = new NodeAcpClientFactory();
    const fixture = fileURLToPath(new URL("./fixtures/acp-test-agent.mjs", import.meta.url));
    const client = await factory.create({
      executable: process.execPath,
      args: [fixture],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    });

    try {
      const session = await client.openSession({ workspaceRoot: "/tmp" });
      await expect(session.prompt("안녕하세요")).resolves.toEqual({
        text: "fixture:안녕하세요",
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 3 },
      });
    } finally {
      await client.close();
    }
  });
});

describe("GitHub Copilot ACP Connector", () => {
  it("shell 없이 공식 ACP command를 계정 profile과 workspace에 연결한다", async () => {
    const prompt = vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" });
    const openSession = vi.fn().mockResolvedValue({ sessionId: "session-1", prompt, cancel: vi.fn() });
    const create = vi.fn().mockResolvedValue({ openSession, close: vi.fn() });
    const connector = new CopilotAcpConnector(
      {
        executable: "/opt/massion/connectors/copilot",
      },
      { create } satisfies AcpClientFactory,
    );

    const result = await connector.execute(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/copilot-profile-1",
      environment: { PATH: "/usr/bin", GH_TOKEN: "do-not-forward" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      executable: "/opt/massion/connectors/copilot",
      args: ["--acp", "--stdio"],
      cwd: "/tmp/work-1",
      env: { PATH: "/usr/bin", COPILOT_HOME: "/tmp/copilot-profile-1" },
      shell: false,
      requestPermission: expect.any(Function),
    });
    expect(openSession).toHaveBeenCalledWith({ workspaceRoot: "/tmp/work-1" });
    expect(result).toMatchObject({ outcome: "completed", sessionId: "session-1", value: "완료" });
  });

  it("session ID를 prompt 전에 등록해 실행 중 ACP cancel을 한 번만 보낸다", async () => {
    let finishPrompt: ((result: { text: string; stopReason: string }) => void) | undefined;
    const prompt = vi.fn().mockImplementation(
      () =>
        new Promise<{ text: string; stopReason: string }>((resolve) => {
          finishPrompt = resolve;
        }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const session: AcpSession = { sessionId: "session-live", prompt, cancel };
    const close = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ openSession: vi.fn().mockResolvedValue(session), close });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    const execution = connector.execute(context, {
      executionId: "execution-live",
      workId: "work-live",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "오래 걸리는 작업",
      workspaceRoot: "/tmp/work-live",
      profileRoot: "/tmp/copilot-profile-live",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    await connector.cancel(context, "execution-live");
    finishPrompt?.({ text: "", stopReason: "cancelled" });

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      executionId: "execution-live",
      sessionId: "session-live",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("실행 파일 절대 경로를 명시하지 않으면 process를 만들지 않는다", async () => {
    const create = vi.fn();
    const connector = new CopilotAcpConnector({ executable: "copilot" }, { create } satisfies AcpClientFactory);

    await expect(
      connector.execute(context, {
        executionId: "execution-relative",
        workId: "work-relative",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot: "/tmp/work-relative",
        profileRoot: "/tmp/copilot-profile-relative",
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toThrow("절대 경로");
    expect(create).not.toHaveBeenCalled();
  });

  it("공식 Copilot ACP tool filter flag로 요청별 허용·제외 범위를 전달한다", async () => {
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "session-tools",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new CopilotAcpConnector({ executable: "/opt/massion/connectors/copilot" }, {
      create,
    } satisfies AcpClientFactory);

    await connector.execute(context, {
      executionId: "execution-tools",
      workId: "work-tools",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/work-tools",
      profileRoot: "/tmp/copilot-profile-tools",
      environment: { PATH: "/usr/bin" },
      allowedTools: ["read_file", "write_file"],
      disallowedTools: ["shell(rm *)"],
    });

    expect(create.mock.calls[0]?.[0].args).toEqual([
      "--acp",
      "--stdio",
      "--available-tools",
      "read_file,write_file",
      "--excluded-tools",
      "shell(rm *)",
    ]);
  });
});

describe("Google Gemini CLI ACP Connector", () => {
  it("기업·Cloud profile을 공식 Gemini ACP command와 GEMINI_CLI_HOME으로 격리한다", async () => {
    const prompt = vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" });
    const openSession = vi.fn().mockResolvedValue({ sessionId: "gemini-session", prompt, cancel: vi.fn() });
    const create = vi.fn().mockResolvedValue({ openSession, close: vi.fn() });
    const connector = new GeminiCliAcpConnector({ executable: "/opt/massion/connectors/gemini" }, {
      create,
    } satisfies AcpClientFactory);

    await connector.execute(context, {
      executionId: "gemini-execution",
      workId: "gemini-work",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/gemini-work",
      profileRoot: "/tmp/gemini-profile",
      environment: { PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "do-not-forward" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      executable: "/opt/massion/connectors/gemini",
      args: ["--acp"],
      cwd: "/tmp/gemini-work",
      env: { PATH: "/usr/bin", GEMINI_CLI_HOME: "/tmp/gemini-profile" },
      shell: false,
      requestPermission: expect.any(Function),
    });
  });

  it("Gemini ACP가 표현하지 못하는 요청별 tool filter를 조용히 무시하지 않는다", async () => {
    const create = vi.fn();
    const connector = new GeminiCliAcpConnector({ executable: "/opt/massion/connectors/gemini" }, {
      create,
    } satisfies AcpClientFactory);

    await expect(
      connector.execute(context, {
        executionId: "gemini-tools",
        workId: "gemini-work-tools",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "검증하세요",
        workspaceRoot: "/tmp/gemini-work-tools",
        profileRoot: "/tmp/gemini-profile-tools",
        environment: { PATH: "/usr/bin" },
        allowedTools: ["read_file"],
        disallowedTools: [],
      }),
    ).rejects.toThrow("요청별 도구 filter");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("xAI Grok Build ACP Connector", () => {
  it("공식 ACP command·cached login·profile home·tool filter를 process에 전달한다", async () => {
    const create = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue({
        sessionId: "grok-session",
        prompt: vi.fn().mockResolvedValue({ text: "완료", stopReason: "end_turn" }),
        cancel: vi.fn(),
      }),
      close: vi.fn(),
    });
    const connector = new GrokBuildAcpConnector({ executable: "/opt/massion/connectors/grok" }, {
      create,
    } satisfies AcpClientFactory);

    await connector.execute(context, {
      executionId: "grok-execution",
      workId: "grok-work",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "검증하세요",
      workspaceRoot: "/tmp/grok-work",
      profileRoot: "/tmp/grok-profile",
      environment: { PATH: "/usr/bin", XAI_API_KEY: "do-not-forward" },
      allowedTools: ["read_file"],
      disallowedTools: ["shell(rm *)"],
    });

    expect(create).toHaveBeenCalledWith({
      executable: "/opt/massion/connectors/grok",
      args: ["--no-auto-update", "agent", "stdio", "--tools", "read_file", "--disallowed-tools", "shell(rm *)"],
      cwd: "/tmp/grok-work",
      env: { PATH: "/usr/bin", HOME: "/tmp/grok-profile" },
      shell: false,
      requestPermission: expect.any(Function),
      authenticationMethod: "cached_token",
    });
    expect(JSON.stringify(create.mock.calls[0])).not.toContain("do-not-forward");
  });
});
