import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { CodexSubscriptionConnector, type CodexSdkFactory } from "./codex-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("공식 Codex 구독 Connector", () => {
  it("구조화 turn을 격리 workspace와 제한된 환경 변수로 실행한다", async () => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: JSON.stringify({ status: "ok" }),
      items: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const startThread = vi.fn().mockReturnValue({ id: "thread-1", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "CODEX_HOME"],
    });

    const result = await connector.executeStructured(
      context,
      {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "software-engineering.engineering-lead",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-1",
        profileRoot: "/tmp/profile-1",
        environment: { PATH: "/usr/bin", CODEX_HOME: "/tmp/profile-1", SECRET_TOKEN: "never-forward" },
        allowedTools: [],
        disallowedTools: [],
      },
      {
        name: "status",
        description: "실행 상태",
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string", enum: ["ok"] } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    );

    expect(create).toHaveBeenCalledWith({ env: { PATH: "/usr/bin", CODEX_HOME: "/tmp/profile-1" } });
    expect(startThread).toHaveBeenCalledWith({ workingDirectory: "/tmp/work-1" });
    expect(run).toHaveBeenCalledWith(
      "상태를 확인하세요",
      expect.objectContaining({ outputSchema: expect.objectContaining({ type: "object" }) }),
    );
    expect(result).toMatchObject({ outcome: "completed", sessionId: "thread-1", value: { status: "ok" } });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
  });

  it("저장된 공식 thread ID로 같은 session을 재개한다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const resumeThread = vi.fn().mockReturnValue({ id: "thread-existing", run });
    const connector = new CodexSubscriptionConnector(
      { create: () => ({ startThread: vi.fn(), resumeThread }) },
      { allowedEnvironment: ["PATH"] },
    );

    await connector.execute(context, {
      executionId: "execution-2",
      workId: "work-1",
      agentHandle: "representative",
      prompt: "계속하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/profile-1",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
      sessionId: "thread-existing",
    });

    expect(resumeThread).toHaveBeenCalledWith("thread-existing", { workingDirectory: "/tmp/work-1" });
  });

  it("실행 중인 turn을 취소하면 SDK AbortSignal을 중단한다", async () => {
    let turnSignal: AbortSignal | undefined;
    const run = vi.fn().mockImplementation(
      (_input, options?: { readonly signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          turnSignal = options?.signal;
          turnSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const connector = new CodexSubscriptionConnector({
      create: () => ({
        startThread: () => ({ id: "thread-cancel", run }),
        resumeThread: vi.fn(),
      }),
    });
    const execution = connector.execute(context, {
      executionId: "execution-cancel",
      workId: "work-1",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "취소 대기",
      workspaceRoot: "/tmp/work-cancel",
      profileRoot: "/tmp/profile-cancel",
      environment: { PATH: "/usr/bin" },
      allowedTools: [],
      disallowedTools: [],
    });

    await connector.cancel(context, "execution-cancel");

    expect(turnSignal?.aborted).toBe(true);
    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      executionId: "execution-cancel",
      sessionId: "thread-cancel",
    });
  });
});
