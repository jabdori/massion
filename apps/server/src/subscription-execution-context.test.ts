import { lstat, mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import { MassionSubscriptionExecutionContext } from "./subscription-execution-context.js";

const temporary: string[] = [];

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const works = {
  getWork: async (tenant: TenantContext, workId: string) => ({
    work_id: workId,
    organization_id: tenant.organizationId,
  }),
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label));
  temporary.push(path);
  return path;
}

describe("구독 Agent 작업공간 권한", () => {
  it("모델 평가 run도 조직 정본으로 확인한 뒤 격리 workspace를 발급한다", async () => {
    const directory = await root("massion-subscription-optimization-workspace-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works, {
      hasOptimizationRun: async (tenant, runId) =>
        tenant.organizationId === context.organizationId && runId === "run-1",
    });

    const resolved = await service.resolve(context, {
      executionId: "run-1",
      workId: "optimization:run-1",
      agentHandle: "representative",
    });

    expect(resolved.workspaceRoot).toContain("workspaces");
    await expect(
      service.resolve(context, {
        executionId: "run-2",
        workId: "optimization:run-2",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("Work");
  });

  it("조직과 Work별 owner-only 작업공간을 발급하고 같은 요청만 검증한다", async () => {
    const directory = await root("massion-subscription-workspace-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const resolved = await service.resolve(context, {
      executionId: "execution-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-development",
    });
    if (!resolved.workspaceRoot) throw new Error("테스트 작업공간이 없습니다");

    expect((await stat(resolved.workspaceRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(resolved.workspaceRoot)).isSymbolicLink()).toBe(false);
    await expect(
      service.verify(context, {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "software-development",
        providerId: "openai-codex",
        accountId: "account-1",
        connectorId: "connector-1",
        requestedWorkspaceRoot: resolved.workspaceRoot,
      }),
    ).resolves.toEqual({ workspaceRoot: resolved.workspaceRoot, allowedTools: [], disallowedTools: [] });
  });

  it("다른 Work·조직 또는 관리 root 밖 경로를 거부한다", async () => {
    const directory = await root("massion-subscription-boundary-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), works);
    const resolved = await service.resolve(context, {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "representative",
    });
    if (!resolved.workspaceRoot) throw new Error("테스트 작업공간이 없습니다");
    const input = {
      executionId: "execution-1",
      workId: "work-1",
      agentHandle: "representative",
      providerId: "anthropic-claude-code",
      accountId: "account-1",
      connectorId: "connector-1",
      requestedWorkspaceRoot: resolved.workspaceRoot,
    } as const;

    await expect(service.verify(context, { ...input, workId: "work-2" })).rejects.toThrow("발급된 작업공간");
    await expect(service.verify({ ...context, organizationId: "organization-2" }, input)).rejects.toThrow(
      "발급된 작업공간",
    );
    await expect(service.verify(context, { ...input, requestedWorkspaceRoot: directory })).rejects.toThrow(
      "발급된 작업공간",
    );
  });

  it("작업공간 root가 symbolic link이면 fail closed한다", async () => {
    const directory = await root("massion-subscription-symlink-");
    const outside = join(directory, "outside");
    const linked = join(directory, "linked");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linked, "dir");
    const service = new MassionSubscriptionExecutionContext(linked, works);

    await expect(
      service.resolve(context, {
        executionId: "execution-1",
        workId: "work-1",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("안전하지 않습니다");
  });

  it("Work 정본에서 현재 조직 actor의 접근을 확인하지 못하면 workspace를 만들지 않는다", async () => {
    const directory = await root("massion-subscription-work-access-");
    const service = new MassionSubscriptionExecutionContext(join(directory, "workspaces"), {
      getWork: async () => {
        throw new Error("Work를 찾을 수 없습니다");
      },
    });

    await expect(
      service.resolve(context, {
        executionId: "execution-unknown",
        workId: "work-unknown",
        agentHandle: "representative",
      }),
    ).rejects.toThrow("Work");
  });
});
