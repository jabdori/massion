import { describe, expect, it } from "vitest";

import {
  createEdgeWorkspaceExecutionCapability,
  createEdgeWorkspaceRootCapability,
  matchesEdgeWorkspaceExecutionCapability,
  selectEdgeWorkspaceRootCapability,
} from "./workspace-capability.js";

const lineage = {
  organizationId: "organization-1",
  connectorId: "connector-1",
  providerId: "openai-codex",
  accountId: "account-1",
  routeAttemptId: "attempt-1",
  sessionLeaseId: "lease-1",
  executionId: "execution-1",
  workId: "work-1",
  agentHandle: "software-engineering.backend-specialist",
} as const;

describe("Edge 작업공간 capability", () => {
  it("장치 비밀과 로컬 canonical root로 경로 원문 없는 불투명 root capability를 만든다", () => {
    const secret = Buffer.alloc(32, 7);
    const root = "/Users/alice/private/customer-repository";
    const capability = createEdgeWorkspaceRootCapability(secret, root);

    expect(capability).toMatch(/^massion\.workspace-root\.v1\.[A-Za-z0-9_-]{43}$/u);
    expect(capability).not.toContain("Users");
    expect(capability).not.toContain("alice");
    expect(capability).not.toContain("customer-repository");
    expect(createEdgeWorkspaceRootCapability(secret, root)).toBe(capability);
    expect(createEdgeWorkspaceRootCapability(Buffer.alloc(32, 8), root)).not.toBe(capability);
    expect(createEdgeWorkspaceRootCapability(secret, "/Users/alice/other")).not.toBe(capability);
  });

  it("root handle과 전체 조직·실행 계보를 하나의 불투명 실행 capability에 묶는다", () => {
    const rootCapability = createEdgeWorkspaceRootCapability(Buffer.alloc(32, 3), "/safe/workspace");
    const capability = createEdgeWorkspaceExecutionCapability(rootCapability, lineage);

    expect(capability).toMatch(/^massion\.workspace-execution\.v1\.[A-Za-z0-9_-]{43}$/u);
    expect(capability).not.toContain(lineage.organizationId);
    expect(capability).not.toContain(lineage.workId);
    expect(matchesEdgeWorkspaceExecutionCapability(capability, rootCapability, lineage)).toBe(true);

    for (const changed of [
      { ...lineage, organizationId: "organization-2" },
      { ...lineage, connectorId: "connector-2" },
      { ...lineage, accountId: "account-2" },
      { ...lineage, routeAttemptId: "attempt-2" },
      { ...lineage, sessionLeaseId: "lease-2" },
      { ...lineage, executionId: "execution-2" },
      { ...lineage, workId: "work-2" },
      { ...lineage, agentHandle: "software-engineering.frontend-specialist" },
    ]) {
      expect(matchesEdgeWorkspaceExecutionCapability(capability, rootCapability, changed)).toBe(false);
    }
    expect(
      matchesEdgeWorkspaceExecutionCapability(
        capability,
        createEdgeWorkspaceRootCapability(Buffer.alloc(32, 4), "/safe/workspace"),
        lineage,
      ),
    ).toBe(false);
    expect(matchesEdgeWorkspaceExecutionCapability("../../outside", rootCapability, lineage)).toBe(false);
  });

  it("등록된 전용 root capability가 정확히 하나일 때만 선택하고 경로·임의·복수 capability는 거부한다", () => {
    const first = createEdgeWorkspaceRootCapability(Buffer.alloc(32, 1), "/safe/first");
    const second = createEdgeWorkspaceRootCapability(Buffer.alloc(32, 2), "/safe/second");
    expect(selectEdgeWorkspaceRootCapability(["agent-turn", "openai-codex", first], lineage)).toBe(first);
    expect(() => selectEdgeWorkspaceRootCapability(["agent-turn", "openai-codex", second, first], lineage)).toThrow(
      /정확히 1개|전용/u,
    );
    expect(() => selectEdgeWorkspaceRootCapability(["agent-turn", "/safe/first"], lineage)).toThrow(
      "작업공간 root capability",
    );
    expect(() =>
      selectEdgeWorkspaceRootCapability(["agent-turn", "massion.workspace-root.v1.not-a-valid-digest"], lineage),
    ).toThrow("작업공간 root capability");
  });
});
