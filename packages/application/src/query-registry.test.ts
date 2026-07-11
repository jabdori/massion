import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import type { ApplicationReadModel } from "./read-model.js";
import { ApplicationQueryRegistry, registerApplicationQueries } from "./query-registry.js";

const context: TenantContext = {
  userId: "query-user",
  organizationId: "query-organization",
  membershipId: "query-membership",
  role: "member",
};

const readModel: ApplicationReadModel = {
  watermarks: async () => ({ work: 1 }),
  organization: async () => ({ organizationId: context.organizationId, version: 1, nodes: [] }),
  works: async () => [
    { organizationId: context.organizationId, workId: "query-work", status: "running", revision: 2, artifactIds: [] },
  ],
  tasks: async () => [
    {
      organizationId: context.organizationId,
      workId: "query-work",
      taskId: "query-task",
      title: "조회",
      status: "ready",
      revision: 1,
    },
  ],
  assignments: async () => [],
  executions: async () => [],
  rooms: async () => [],
  approvals: async () => [
    {
      organizationId: context.organizationId,
      approvalId: "query-approval",
      action: "tool.call",
      status: "pending",
      requestedBy: "agent",
      expiresAt: "2026-07-11T05:00:00.000Z",
    },
  ],
  extensions: async () => [],
};

describe("ApplicationQueryRegistry", () => {
  it("공개 read model 조회를 allowlist·scope로 제공한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["work:read"], "work.list", {})).resolves.toMatchObject({
      operation: "work.list",
      data: [{ workId: "query-work", status: "running", revision: 2, artifactIds: [] }],
    });
    await expect(registry.query(context, ["work:read"], "work.tasks", { workId: "query-work" })).resolves.toMatchObject(
      {
        data: [{ taskId: "query-task" }],
      },
    );
    await expect(registry.query(context, ["work:read"], "governance.approval.list", {})).rejects.toMatchObject({
      category: "authorization",
    });
  });

  it("unknown operation·payload field와 role을 거부한다", async () => {
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, { readModel });
    await expect(registry.query(context, ["application:*"], "unknown.read", {})).rejects.toMatchObject({
      category: "validation",
    });
    await expect(registry.query(context, ["work:read"], "work.list", { injected: true })).rejects.toThrow("알 수 없는");
  });
});
