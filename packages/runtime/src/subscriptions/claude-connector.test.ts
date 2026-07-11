import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  ClaudeSubscriptionConnector,
  type ClaudeAgentQuery,
  type SubscriptionPermissionBridge,
} from "./claude-connector.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("공식 Claude Agent SDK 구독 Connector", () => {
  it("도구 권한 요청을 Governance 승인 대기로 바꾸고 실행을 중단한다", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "suspend", approvalId: "approval-1" });
    const permissions: SubscriptionPermissionBridge = { request };
    const query: ClaudeAgentQuery = vi.fn().mockImplementation(async function* ({ options }) {
      const decision = await options.canUseTool?.(
        "Bash",
        { command: "git status" },
        { signal: new AbortController().signal },
      );
      expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
      yield { type: "result", subtype: "error_during_execution", session_id: "session-1" };
    });
    const connector = new ClaudeSubscriptionConnector(query, permissions);

    const result = await connector.execute(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "software-engineering.backend-specialist",
      prompt: "테스트를 실행하세요",
      workspaceRoot: "/tmp/work-1",
      profileRoot: "/tmp/claude-profile-1",
      environment: { PATH: "/usr/bin", HOME: "/private/home" },
      allowedTools: ["Read"],
      disallowedTools: ["WebFetch"],
    });

    expect(request).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ executionId: "execution-1", toolName: "Bash" }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "테스트를 실행하세요",
        options: expect.objectContaining({
          cwd: "/tmp/work-1",
          allowedTools: ["Read"],
          disallowedTools: ["WebFetch"],
          env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/claude-profile-1" }),
        }),
      }),
    );
    expect(result).toEqual({
      outcome: "suspended",
      executionId: "execution-1",
      sessionId: "session-1",
      approvalId: "approval-1",
    });
  });
});
