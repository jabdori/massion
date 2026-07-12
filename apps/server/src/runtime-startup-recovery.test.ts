import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import type { RuntimeRecoveryCandidate } from "@massion/runtime";

import { RuntimeStartupRecoveryService } from "./runtime-startup-recovery.js";

function context(candidate: RuntimeRecoveryCandidate): TenantContext {
  if (!candidate.actor_user_id) throw new Error("test actor가 없습니다");
  return {
    userId: candidate.actor_user_id,
    organizationId: candidate.organization_id,
    membershipId: `membership-${candidate.actor_user_id}`,
    role: "member",
  };
}

describe("Runtime 시작 복구 서비스", () => {
  it("모든 복구가 끝날 때까지 start를 완료하지 않는다", async () => {
    let release: (() => void) | undefined;
    const candidate: RuntimeRecoveryCandidate = {
      execution_id: "execution-1",
      organization_id: "organization-1",
      actor_user_id: "user-1",
      status: "running",
    };
    const service = new RuntimeStartupRecoveryService(
      { listStartupRecoverable: async () => [candidate] },
      { resolveTenantContext: async () => context(candidate) },
      {
        recover: async () =>
          await new Promise((resolve) => {
            release = () => resolve({ status: "interrupted" });
          }),
      },
    );
    let started = false;

    const starting = service.start().then(() => {
      started = true;
    });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    await Promise.resolve();
    expect(started).toBe(false);

    release?.();
    await starting;
    expect(service.ready()).toBe(true);
    await service.close();
  });

  it("원래 사용자·조직 context로 실행을 순서대로 복구한다", async () => {
    const candidates: RuntimeRecoveryCandidate[] = [
      {
        execution_id: "execution-1",
        organization_id: "organization-1",
        actor_user_id: "user-1",
        status: "running",
      },
      {
        execution_id: "execution-2",
        organization_id: "organization-2",
        actor_user_id: "user-2",
        status: "suspended",
      },
    ];
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const resolveTenantContext = vi.fn(async (userId: string, organizationId: string) => {
      const candidate = candidates.find(
        (value) => value.actor_user_id === userId && value.organization_id === organizationId,
      );
      if (!candidate) throw new Error("unexpected context");
      return context(candidate);
    });
    const recover = vi.fn(async (tenant: TenantContext, executionId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(`${tenant.userId}:${tenant.organizationId}:${executionId}`);
      await Promise.resolve();
      active -= 1;
      return { status: "suspended" as const };
    });
    const service = new RuntimeStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      { resolveTenantContext },
      { recover },
    );

    await service.start();
    await vi.waitFor(() => expect(service.ready()).toBe(true));

    expect(calls).toEqual(["user-1:organization-1:execution-1", "user-2:organization-2:execution-2"]);
    expect(maximumActive).toBe(1);
    expect(service.ready()).toBe(true);
    await expect(service.start()).rejects.toThrow("이미");
    await service.close();
    expect(service.ready()).toBe(false);
  });

  it("레거시 계보·소멸한 membership·개별 복구 실패를 격리하고 readiness에 반영한다", async () => {
    const candidates: RuntimeRecoveryCandidate[] = [
      { execution_id: "legacy", organization_id: "organization-1", status: "running" },
      {
        execution_id: "membership-gone",
        organization_id: "organization-1",
        actor_user_id: "gone-user",
        status: "suspended",
      },
      {
        execution_id: "runtime-failed",
        organization_id: "organization-1",
        actor_user_id: "active-user",
        status: "running",
      },
      {
        execution_id: "runtime-recovered",
        organization_id: "organization-1",
        actor_user_id: "active-user",
        status: "running",
      },
    ];
    const failures: string[] = [];
    const recover = vi.fn(async (_tenant: TenantContext, executionId: string) => {
      if (executionId === "runtime-failed") throw new Error("checkpoint corrupt");
      return { status: "suspended" as const };
    });
    const service = new RuntimeStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      {
        resolveTenantContext: async (userId, organizationId) => {
          if (userId === "gone-user") throw new Error("활성 Membership이 없습니다");
          return context({
            execution_id: "context",
            actor_user_id: userId,
            organization_id: organizationId,
            status: "running",
          });
        },
      },
      { recover },
      {
        onFailure: (failure) => {
          failures.push(`${failure.reason}:${failure.executionId ?? "none"}`);
          if (failure.reason === "legacy_actor_lineage_missing") throw new Error("reporter unavailable");
        },
      },
    );

    await expect(service.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(failures).toHaveLength(3));
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));

    expect(failures).toEqual([
      "legacy_actor_lineage_missing:legacy",
      "membership_unavailable:membership-gone",
      "recovery_failed:runtime-failed",
    ]);
    expect(recover.mock.calls.map((call) => call[1])).toEqual(["runtime-failed", "runtime-recovered"]);
    expect(service.ready()).toBe(false);
    await service.close();
  });

  it("종료는 진행 중인 단일 복구를 기다리고 다음 후보를 시작하지 않는다", async () => {
    let release: (() => void) | undefined;
    const recover = vi.fn(
      async () =>
        await new Promise<{ status: "suspended" }>((resolve) => {
          release = () => resolve({ status: "suspended" });
        }),
    );
    const candidates: RuntimeRecoveryCandidate[] = [
      {
        execution_id: "execution-active",
        organization_id: "organization-1",
        actor_user_id: "user-1",
        status: "running",
      },
      {
        execution_id: "execution-not-started",
        organization_id: "organization-1",
        actor_user_id: "user-1",
        status: "running",
      },
    ];
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error("첫 복구 후보가 없습니다");
    const service = new RuntimeStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      { resolveTenantContext: async () => context(firstCandidate) },
      { recover },
    );

    const starting = service.start();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(service.ready()).toBe(false);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release?.();
    await Promise.all([starting, closing]);

    expect(closed).toBe(true);
    expect(recover).toHaveBeenCalledOnce();
    expect(service.ready()).toBe(false);
  });

  it("복구 후보 조회 실패를 보고하고 readiness를 닫는다", async () => {
    const failures: string[] = [];
    const service = new RuntimeStartupRecoveryService(
      { listStartupRecoverable: async () => await Promise.reject(new Error("database unavailable")) },
      { resolveTenantContext: async () => await Promise.reject(new Error("not called")) },
      { recover: async () => await Promise.reject(new Error("not called")) },
      {
        onFailure: (failure) => {
          failures.push(failure.reason);
        },
      },
    );

    await expect(service.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(failures).toEqual(["candidate_list_failed"]));
    expect(service.ready()).toBe(false);
    await service.close();
  });
});
