import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  AntigravityCliConnector,
  NodeCliProcessRunner,
  type CliProcessHandle,
  type CliProcessResult,
  type CliProcessRunner,
} from "./antigravity-connector.js";
import type { SubscriptionAgentInput } from "./agent-runtime.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

function agentInput(overrides: Partial<SubscriptionAgentInput> = {}): SubscriptionAgentInput {
  return {
    executionId: "execution-1",
    workId: "work-1",
    agentHandle: "software-engineering.backend-specialist",
    prompt: "검증하세요",
    workspaceRoot: "/tmp/work-1",
    profileRoot: "/tmp/profile-ignored",
    environment: {
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      GOOGLE_API_KEY: "do-not-forward",
    },
    allowedTools: [],
    disallowedTools: [],
    ...overrides,
  };
}

function completed(result: CliProcessResult): CliProcessHandle {
  return { result: Promise.resolve(result), cancel: vi.fn().mockResolvedValue(undefined) };
}

describe("제한된 CLI process runner", () => {
  it("shell 해석 없이 argv를 전달하고 stdout 상한을 강제한다", async () => {
    const runner = new NodeCliProcessRunner();
    const fixture = fileURLToPath(new URL("./fixtures/cli-process-test.mjs", import.meta.url));
    const literal = "$(touch /tmp/massion-must-not-exist);semi-colon";
    const echo = runner.start({
      executable: process.execPath,
      args: [fixture, "echo", literal],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    await expect(echo.result).resolves.toEqual({ outcome: "exited", exitCode: 0, stdout: literal });

    const oversized = runner.start({
      executable: process.execPath,
      args: [fixture, "oversized"],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      timeoutMs: 5_000,
      maxStdoutBytes: 16,
      maxStderrBytes: 4_096,
    });
    await expect(oversized.result).resolves.toMatchObject({ outcome: "output-limit" });
  });
});

describe("Google Antigravity CLI Connector", () => {
  it("알려진 subprocess 결함이 있는 1.0.16을 doctor에서 차단한다", async () => {
    const start = vi.fn().mockReturnValue(completed({ outcome: "exited", exitCode: 0, stdout: "1.0.16" }));
    const connector = new AntigravityCliConnector({ executable: "/opt/massion/connectors/agy" }, {
      start,
    } satisfies CliProcessRunner);

    await expect(connector.doctor()).resolves.toEqual({
      status: "incompatible",
      version: "1.0.16",
      minimumVersion: "1.1.1",
    });
  });

  it("1.1.1 이상에서 prompt를 argv로 전달하고 단일 OS 계정 환경만 사용한다", async () => {
    const start = vi
      .fn()
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "agy 1.1.1" }))
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "완료\n" }));
    const connector = new AntigravityCliConnector(
      { executable: "/opt/massion/connectors/agy", model: "gemini-3.1-pro", sandbox: true },
      { start } satisfies CliProcessRunner,
    );

    await expect(connector.execute(context, agentInput())).resolves.toMatchObject({
      outcome: "completed",
      executionId: "execution-1",
      sessionId: "antigravity-one-shot:execution-1",
      value: "완료",
    });
    expect(start).toHaveBeenNthCalledWith(2, {
      executable: "/opt/massion/connectors/agy",
      args: ["--sandbox", "--model", "gemini-3.1-pro", "--print", "검증하세요"],
      cwd: "/tmp/work-1",
      env: { PATH: "/usr/bin", HOME: "/Users/tester" },
      shell: false,
      timeoutMs: 300_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    expect(JSON.stringify(start.mock.calls[1])).not.toContain("do-not-forward");
    expect(JSON.stringify(start.mock.calls[1])).not.toContain("profile-ignored");
    expect(JSON.stringify(start.mock.calls[1])).not.toContain("dangerously-skip-permissions");
  });

  it("요청별 도구 정책은 지원한다고 가장하지 않고 process 시작 전에 거부한다", async () => {
    const start = vi.fn();
    const connector = new AntigravityCliConnector({ executable: "/opt/massion/connectors/agy" }, {
      start,
    } satisfies CliProcessRunner);

    await expect(connector.execute(context, agentInput({ allowedTools: ["read_file"] }))).rejects.toThrow(
      "요청별 도구 정책",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("실행 중 취소는 process handle을 종료하고 원격 session 완료를 주장하지 않는다", async () => {
    let finish: ((result: CliProcessResult) => void) | undefined;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const running: CliProcessHandle = {
      result: new Promise((resolve) => {
        finish = resolve;
      }),
      cancel,
    };
    const start = vi
      .fn()
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "1.1.1" }))
      .mockReturnValueOnce(running);
    const connector = new AntigravityCliConnector({ executable: "/opt/massion/connectors/agy" }, {
      start,
    } satisfies CliProcessRunner);
    const execution = connector.execute(context, agentInput({ executionId: "execution-live" }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    await connector.cancel(context, "execution-live");
    finish?.({ outcome: "cancelled", stdout: "" });

    await expect(execution).resolves.toMatchObject({ outcome: "cancelled", executionId: "execution-live" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("기존 provider conversation ID만 명시적으로 재개하고 one-shot ID는 재사용하지 않는다", async () => {
    const start = vi
      .fn()
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "1.1.1" }))
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "재개 완료" }));
    const connector = new AntigravityCliConnector({ executable: "/opt/massion/connectors/agy" }, {
      start,
    } satisfies CliProcessRunner);

    await connector.execute(context, agentInput({ sessionId: "provider-conversation-uuid" }));
    expect(start.mock.calls[1]?.[0].args).toContain("provider-conversation-uuid");
    await expect(
      connector.execute(context, agentInput({ sessionId: "antigravity-one-shot:old-execution" })),
    ).rejects.toThrow("재개할 수 없습니다");
  });

  it("exit 0이라도 빈 stdout이면 출력 전 재시도 가능한 실패로 처리한다", async () => {
    const start = vi
      .fn()
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "1.1.1" }))
      .mockReturnValueOnce(completed({ outcome: "exited", exitCode: 0, stdout: "  \n" }));
    const connector = new AntigravityCliConnector({ executable: "/opt/massion/connectors/agy" }, {
      start,
    } satisfies CliProcessRunner);

    await expect(connector.execute(context, agentInput())).resolves.toMatchObject({
      outcome: "failed",
      category: "antigravity-empty-output",
      retryable: true,
    });
  });
});
