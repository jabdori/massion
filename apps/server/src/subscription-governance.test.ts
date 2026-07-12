import { describe, expect, it, vi } from "vitest";

import { GovernanceApprovalRequiredError, GovernanceDeniedError, type PolicyDecision } from "@massion/governance";
import type { TenantContext } from "@massion/identity";

import { GovernanceSubscriptionPermissionBridge, SubscriptionAgentPolicyResolver } from "./subscription-governance.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const decision: PolicyDecision = {
  decisionId: "decision-1",
  organizationId: context.organizationId,
  policyVersionId: "policy-1",
  requestHash: "a".repeat(64),
  outcome: "deny",
  reasons: ["policy"],
  errors: [],
  createdAt: new Date(0),
};

describe("구독 Agent 정책과 도구 승인", () => {
  it("제공자별 명시적 automatic·review·deny를 실행 정책으로 해석한다", async () => {
    const getActivePolicy = vi
      .fn()
      .mockResolvedValueOnce({
        version: {},
        bundle: {},
        requirements: [
          {
            requirementId: "review-tools",
            actions: ["tool.call"],
            environments: ["*"],
            riskClasses: ["*"],
          },
        ],
      })
      .mockResolvedValueOnce({ version: {}, bundle: {}, requirements: [] });
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ approvalMode: "review" })
      .mockResolvedValueOnce({ approvalMode: "automatic" })
      .mockResolvedValueOnce({ approvalMode: "deny" });
    const resolver = new SubscriptionAgentPolicyResolver({ getActivePolicy }, "local", { resolve });
    const base = {
      executionId: "execution-1",
      workId: "work-1",
      providerId: "anthropic-claude-code",
      accountId: "account-1",
      connectorId: "connector-1",
      workspaceRoot: "/tmp/work-1",
    } as const;

    await expect(
      resolver.resolve(context, { ...base, agentHandle: "software-engineering.backend-specialist" }),
    ).resolves.toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
    });
    await expect(resolver.resolve(context, { ...base, agentHandle: "representative" })).resolves.toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    });
    await expect(resolver.resolve(context, { ...base, agentHandle: "representative" })).resolves.toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "deny",
      networkAccessEnabled: false,
    });
  });

  it("활성 정책이 없으면 fail closed review를 선택한다", async () => {
    const resolver = new SubscriptionAgentPolicyResolver({ getActivePolicy: async () => undefined }, "team", {
      resolve: async () => ({ approvalMode: "review" }),
    });

    await expect(
      resolver.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "representative",
        providerId: "anthropic-claude-code",
        accountId: "account-1",
        connectorId: "connector-1",
        workspaceRoot: "/tmp/work-1",
      }),
    ).resolves.toMatchObject({ approvalPolicy: "on-request", networkAccessEnabled: false });
  });

  it("실행 시작 시 도구 위험 등급을 아직 모르면 외부 도구 승인 요구도 review로 해석한다", async () => {
    const resolver = new SubscriptionAgentPolicyResolver(
      {
        getActivePolicy: async () => ({
          requirements: [
            {
              actions: ["tool.call"],
              environments: ["local"],
              riskClasses: ["external-tool"],
            },
          ],
        }),
      },
      "local",
    );

    await expect(
      resolver.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "research",
        providerId: "anthropic-claude-code",
        accountId: "account-1",
        connectorId: "connector-1",
        workspaceRoot: "/tmp/work-1",
      }),
    ).resolves.toMatchObject({ approvalPolicy: "on-request" });
  });

  it("Governance 허용·승인 대기·거부를 연결하고 허용 목록 밖 도구 입력 원문을 전달하지 않는다", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "allow", decision: { ...decision, outcome: "allow" } })
      .mockRejectedValueOnce(new GovernanceApprovalRequiredError("decision-2", "approval-2"))
      .mockRejectedValueOnce(new GovernanceDeniedError(decision))
      .mockRejectedValueOnce(new Error("database unavailable"));
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize }, "local");
    const input = {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      toolName: "Bash",
      toolInput: { command: "git status", env: { API_TOKEN: "secret-environment-value" } },
      toolUseId: "tool-use-1",
      permissionRequestId: "permission-request-1",
    } as const;

    await expect(bridge.request(context, input)).resolves.toEqual({ outcome: "allow" });
    await expect(bridge.request(context, { ...input, toolUseId: "tool-use-2" })).resolves.toEqual({
      outcome: "suspend",
      approvalId: "approval-2",
    });
    await expect(bridge.request(context, { ...input, toolUseId: "tool-use-3" })).resolves.toEqual({
      outcome: "deny",
      reason: "Governance 정책이 도구 실행을 거부했습니다",
    });
    await expect(bridge.request(context, { ...input, toolUseId: "tool-use-4" })).resolves.toEqual({
      outcome: "deny",
      reason: "Governance 도구 승인 상태를 확인할 수 없습니다",
    });
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("secret-environment-value");
  });

  it("명령 승인은 실행 파일·민감값이 제거된 인수·작업 경로만 미리보기로 전달한다", async () => {
    const authorize = vi
      .fn()
      .mockRejectedValue(new GovernanceApprovalRequiredError("decision-preview", "approval-preview"));
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize }, "local");

    await bridge.request(context, {
      executionId: "execution-preview",
      workId: "work-preview",
      agentHandle: "software-development",
      toolName: "Bash",
      toolInput: {
        command: [
          "curl",
          "--token",
          "command-token-never-store",
          "--url=https://example.com?api_key=query-secret-never-store",
          "--header",
          "Authorization: Bearer header-secret-never-store",
        ],
        cwd: "/workspace/project\u001b[31m",
        env: { API_TOKEN: "environment-secret-never-store" },
      },
      toolUseId: "tool-preview",
      permissionRequestId: "permission-preview",
      title: "명령\u0007 실행",
      decisionReason: "승인 사유\nAuthorization: Bearer reason-secret-never-store",
    });

    expect(authorize).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        approvalPreview: {
          kind: "command",
          title: "명령 실행",
          executable: "curl",
          arguments: [
            "--token",
            "[민감값 제거]",
            "--url=https://example.com?api_key=[민감값 제거]",
            "--header",
            "Authorization: [민감값 제거]",
          ],
          cwd: "/workspace/project",
          reason: "승인 사유 Authorization: [민감값 제거]",
        },
      }),
    );
    const serialized = JSON.stringify(authorize.mock.calls);
    for (const secret of [
      "command-token-never-store",
      "query-secret-never-store",
      "header-secret-never-store",
      "environment-secret-never-store",
      "reason-secret-never-store",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("파일 변경 승인은 경로와 요약만 전달하고 파일 원문·diff를 버린다", async () => {
    const authorize = vi.fn().mockRejectedValue(new GovernanceApprovalRequiredError("decision-file", "approval-file"));
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize }, "team");

    await bridge.request(context, {
      executionId: "execution-file",
      workId: "work-file",
      agentHandle: "software-development",
      toolName: "Write",
      toolInput: {
        file_path: "/workspace/src/index.ts",
        content: "private-file-content-never-store",
        patch: "private-diff-never-store",
        reason: "설정 파일 갱신",
      },
      toolUseId: "tool-file",
      permissionRequestId: "permission-file",
      title: "파일 변경",
    });

    expect(authorize).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        approvalPreview: {
          kind: "file-change",
          title: "파일 변경",
          path: "/workspace/src/index.ts",
          summary: "설정 파일 갱신",
        },
      }),
    );
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("private-file-content-never-store");
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("private-diff-never-store");
  });

  it("제공자 일반 승인은 제목·이유만 제한해 전달하고 배열과 문자열 크기를 제한한다", async () => {
    const authorize = vi
      .fn()
      .mockRejectedValue(new GovernanceApprovalRequiredError("decision-provider", "approval-provider"));
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize }, "local");

    await bridge.request(context, {
      executionId: "execution-provider",
      workId: "work-provider",
      agentHandle: "research",
      toolName: "ProviderCustomTool",
      toolInput: {
        rawPrompt: "provider-raw-input-never-store",
        values: Array.from({ length: 100 }, (_, index) => index),
      },
      toolUseId: "tool-provider",
      permissionRequestId: "permission-provider",
      title: `제공자 확인 ${"가".repeat(500)}`,
      decisionReason: `password=provider-password-never-store ${"나".repeat(2_000)}`,
    });

    const preview = authorize.mock.calls[0]?.[1]?.approvalPreview as
      { readonly kind: string; readonly title: string; readonly reason?: string } | undefined;
    expect(preview).toMatchObject({ kind: "provider" });
    expect(preview?.title.length).toBeLessThanOrEqual(160);
    expect(preview?.reason?.length).toBeLessThanOrEqual(500);
    const serialized = JSON.stringify(authorize.mock.calls);
    expect(serialized).not.toContain("provider-raw-input-never-store");
    expect(serialized).not.toContain("provider-password-never-store");
  });

  it("승인 결과를 원래 도구 호출에만 결합해 한 번 소비하고 approved boolean을 받지 않는다", async () => {
    const authorize = vi
      .fn()
      .mockRejectedValueOnce(new GovernanceApprovalRequiredError("decision-bound", "approval-bound"))
      .mockResolvedValueOnce({ outcome: "allow", decision: { ...decision, outcome: "allow" } });
    const getApprovalStatus = vi.fn().mockResolvedValue("approved");
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize, getApprovalStatus }, "local");
    const request = {
      executionId: "execution-bound",
      workId: "work-bound",
      agentHandle: "software-development",
      toolName: "Bash",
      toolInput: { command: "private-command" },
      toolUseId: "tool-bound",
      permissionRequestId: "permission-bound",
    } as const;

    await expect(bridge.request(context, request)).resolves.toEqual({
      outcome: "suspend",
      approvalId: "approval-bound",
    });
    await expect(
      bridge.consume(context, { executionId: "execution-bound", approvalId: "approval-forged" }),
    ).rejects.toThrow(/일치/u);
    await expect(
      bridge.consume(
        { ...context, userId: "approver-user", membershipId: "approver-membership", role: "admin" },
        { executionId: "execution-bound", approvalId: "approval-bound" },
      ),
    ).resolves.toBe("approved");
    await expect(
      bridge.consume(context, { executionId: "execution-bound", approvalId: "approval-bound" }),
    ).rejects.toThrow(/없습니다/u);

    expect(authorize).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        approvalId: "approval-bound",
        executionId: "execution-bound",
        workId: "work-bound",
        resource: expect.objectContaining({
          attributes: expect.objectContaining({ toolInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        }),
      }),
    );
    expect(JSON.stringify(authorize.mock.calls)).not.toContain('"command":"private-command"');
  });

  it("거부 vote는 Permit 없이 원래 중단 실행의 rejected 결정으로만 소비한다", async () => {
    const authorize = vi
      .fn()
      .mockRejectedValue(new GovernanceApprovalRequiredError("decision-reject", "approval-reject"));
    const bridge = new GovernanceSubscriptionPermissionBridge(
      { authorize, getApprovalStatus: async () => "rejected" },
      "team",
    );

    await bridge.request(context, {
      executionId: "execution-reject",
      workId: "work-reject",
      agentHandle: "representative",
      toolName: "Write",
      toolInput: { path: "/workspace/file" },
      toolUseId: "tool-reject",
      permissionRequestId: "permission-reject",
    });

    await expect(
      bridge.consume(context, { executionId: "execution-reject", approvalId: "approval-reject" }),
    ).resolves.toBe("rejected");
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("live provider process를 복구할 수 없으면 연결된 미소비 승인을 cancelled로 정리한다", async () => {
    const authorize = vi.fn().mockRejectedValue(new GovernanceApprovalRequiredError("decision-lost", "approval-lost"));
    const cancel = vi.fn().mockResolvedValue({ status: "cancelled" });
    const bridge = new GovernanceSubscriptionPermissionBridge(
      { authorize, getApprovalStatus: async () => "pending" },
      "local",
      { cancel },
    );
    await bridge.request(context, {
      executionId: "execution-lost",
      workId: "work-lost",
      agentHandle: "software-development",
      toolName: "Write",
      toolInput: { path: "/workspace/file" },
      toolUseId: "tool-lost",
      permissionRequestId: "permission-lost",
    });

    await bridge.interrupt(context, { executionId: "execution-lost", approvalId: "approval-lost" });

    expect(cancel).toHaveBeenCalledWith(context, {
      commandId: expect.stringContaining("execution-lost"),
      approvalId: "approval-lost",
      reason: "Provider live process를 재구성할 수 없어 실행이 중단됐습니다",
    });
  });

  it("네트워크 도구는 외부 작업으로 Governance에 전달한다", async () => {
    const authorize = vi.fn().mockResolvedValue({ outcome: "allow", decision: { ...decision, outcome: "allow" } });
    const bridge = new GovernanceSubscriptionPermissionBridge({ authorize }, "team");

    await bridge.request(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "research",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/private" },
      toolUseId: "tool-use-network",
      permissionRequestId: "permission-network",
    });

    expect(authorize).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ environment: "team", riskClass: "external-tool", external: true }),
    );
  });
});
