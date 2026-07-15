import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { CodexSubscriptionConnector, type CodexSdkFactory } from "./codex-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("공식 Codex 구독 Connector", () => {
  const profiles: string[] = [];

  afterEach(async () => {
    await Promise.all(profiles.splice(0).map(async (profile) => await rm(profile, { recursive: true, force: true })));
  });

  async function authenticatedManagedProfile(): Promise<string> {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-sdk-profile-"));
    profiles.push(profile);
    await chmod(profile, 0o700);
    await writeFile(join(profile, "auth.json"), "private-login-state", { mode: 0o600 });
    return profile;
  }

  it("허용된 실행 파일과 조직 실행 정책을 SDK 기본값 대신 명시적으로 전달한다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-policy", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "CODEX_HOME"],
      managedProfile: true,
      executable: "/opt/massion/connectors/codex",
      threadPolicy: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        model: "gpt-5.6-codex",
      },
    });
    const profileRoot = await authenticatedManagedProfile();

    await connector.execute(context, {
      executionId: "execution-policy",
      workId: "work-policy",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "정책을 확인하세요",
      workspaceRoot: "/tmp/work-policy",
      profileRoot,
      environment: { PATH: "/opt/massion/connectors", HOME: "/private/home" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      codexPathOverride: "/opt/massion/connectors/codex",
      env: {
        PATH: "/opt/massion/connectors",
        CODEX_HOME: profileRoot,
        HOME: profileRoot,
      },
      config: { cli_auth_credentials_store: "file" },
    });
    expect(startThread).toHaveBeenCalledWith({
      workingDirectory: "/tmp/work-policy",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      model: "gpt-5.6-codex",
    });
  });

  it("위험한 전체 접근 sandbox와 상대 실행 파일을 거부한다", () => {
    const factory = { create: vi.fn() } satisfies CodexSdkFactory;
    expect(
      () =>
        new CodexSubscriptionConnector(factory, {
          allowedEnvironment: ["PATH"],
          executable: "bin/codex",
          threadPolicy: {
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            networkAccessEnabled: false,
          },
        }),
    ).toThrow("절대 경로");
  });

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
      managedProfile: true,
    });
    const profileRoot = await authenticatedManagedProfile();

    const result = await connector.executeStructured(
      context,
      {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "software-engineering.engineering-lead",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-1",
        profileRoot,
        environment: { PATH: "/usr/bin", CODEX_HOME: profileRoot, SECRET_TOKEN: "never-forward" },
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

    expect(create).toHaveBeenCalledWith({
      env: { PATH: "/usr/bin", CODEX_HOME: profileRoot, HOME: profileRoot },
      config: { cli_auth_credentials_store: "file" },
    });
    expect(startThread).toHaveBeenCalledWith({ workingDirectory: "/tmp/work-1" });
    expect(run).toHaveBeenCalledWith(
      "상태를 확인하세요",
      expect.objectContaining({ outputSchema: expect.objectContaining({ type: "object" }) }),
    );
    expect(result).toMatchObject({ outcome: "completed", sessionId: "thread-1", value: { status: "ok" } });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
  });

  it("관리 Codex profile의 auth.json이 없으면 SDK client를 만들지 않고 실행을 거부한다", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-sdk-missing-auth-"));
    profiles.push(profileRoot);
    await chmod(profileRoot, 0o700);
    const create = vi.fn();
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH"],
      managedProfile: true,
    });

    await expect(
      connector.execute(context, {
        executionId: "execution-missing-auth",
        workId: "work-missing-auth",
        agentHandle: "representative",
        prompt: "상태를 확인하세요",
        workspaceRoot: "/tmp/work-missing-auth",
        profileRoot,
        environment: { PATH: "/usr/bin" },
        allowedTools: [],
        disallowedTools: [],
      }),
    ).rejects.toThrow(/auth\.json|재인증/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("외부 Edge profile은 사용자가 선택한 credential storage와 HOME을 바꾸지 않는다", async () => {
    const run = vi.fn().mockResolvedValue({ finalResponse: "완료", items: [] });
    const startThread = vi.fn().mockReturnValue({ id: "thread-external", run });
    const create = vi.fn().mockReturnValue({ startThread, resumeThread: vi.fn() });
    const connector = new CodexSubscriptionConnector({ create } satisfies CodexSdkFactory, {
      allowedEnvironment: ["PATH", "HOME", "CODEX_HOME"],
    });

    await connector.execute(context, {
      executionId: "execution-external",
      workId: "work-external",
      agentHandle: "software-engineering.engineering-lead",
      prompt: "외부 profile을 확인하세요",
      workspaceRoot: "/tmp/work-external",
      profileRoot: "/tmp/profile-external",
      environment: { PATH: "/usr/bin", HOME: "/private/external-home" },
      allowedTools: [],
      disallowedTools: [],
    });

    expect(create).toHaveBeenCalledWith({
      env: {
        PATH: "/usr/bin",
        HOME: "/private/external-home",
        CODEX_HOME: "/tmp/profile-external",
      },
    });
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
