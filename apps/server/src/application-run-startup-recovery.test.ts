import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { ApplicationRunStartupRecoveryService } from "./application-run-startup-recovery.js";

interface Candidate {
  readonly runId: string;
  readonly organizationId: string;
  readonly actorUserId?: string;
}

function context(candidate: Candidate): TenantContext {
  if (!candidate.actorUserId) throw new Error("test actor가 없습니다");
  return {
    userId: candidate.actorUserId,
    organizationId: candidate.organizationId,
    membershipId: `membership-${candidate.actorUserId}`,
    role: "member",
  };
}

describe("ApplicationRun 시작 복구 서비스", () => {
  it("모든 복구가 끝날 때까지 start를 완료하지 않고 한 번만 시작할 수 있다", async () => {
    let release: (() => void) | undefined;
    const candidate: Candidate = {
      runId: "run-1",
      organizationId: "organization-1",
      actorUserId: "user-1",
    };
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable: async () => [candidate] },
      { resolveTenantContext: async () => context(candidate) },
      {
        recover: async () =>
          await new Promise((resolve) => {
            release = () => resolve({ status: "suspended" });
          }),
      },
    );
    let started = false;

    expect(service.ready()).toBe(false);
    const starting = service.start().then(() => {
      started = true;
    });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    await Promise.resolve();
    expect(started).toBe(false);
    expect(service.ready()).toBe(false);

    release?.();
    await starting;
    expect(service.ready()).toBe(true);
    await expect(service.start()).rejects.toThrow("이미");

    await service.close();
    expect(service.ready()).toBe(false);
    await expect(service.start()).rejects.toThrow("종료");
  });

  it("입력 순서대로 원래 사용자·조직 문맥을 해석해 순차 복구한다", async () => {
    const candidates: Candidate[] = [
      { runId: "run-1", organizationId: "organization-1", actorUserId: "user-1" },
      { runId: "run-2", organizationId: "organization-2", actorUserId: "user-2" },
    ];
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const resolveTenantContext = vi.fn(async (userId: string, organizationId: string) => {
      const candidate = candidates.find(
        (value) => value.actorUserId === userId && value.organizationId === organizationId,
      );
      if (!candidate) throw new Error("예상하지 못한 문맥입니다");
      return context(candidate);
    });
    const recover = vi.fn(async (tenant: TenantContext, runId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(`${tenant.userId}:${tenant.organizationId}:${runId}`);
      await Promise.resolve();
      active -= 1;
      return { status: "suspended" as const };
    });
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      { resolveTenantContext },
      { recover },
    );

    await service.start();

    expect(calls).toEqual(["user-1:organization-1:run-1", "user-2:organization-2:run-2"]);
    expect(maximumActive).toBe(1);
    expect(service.ready()).toBe(true);
    await service.close();
  });

  it("후보별 계보·membership·복구 실패를 격리하고 실패 닫힘 상태로 둔다", async () => {
    const membershipError = new Error("활성 Membership이 없습니다");
    const recoveryError = new Error("복구 체크포인트가 손상됐습니다");
    const candidates: Candidate[] = [
      { runId: "legacy", organizationId: "organization-1" },
      { runId: "membership-gone", organizationId: "organization-1", actorUserId: "gone-user" },
      { runId: "recovery-failed", organizationId: "organization-1", actorUserId: "active-user" },
      { runId: "recovered", organizationId: "organization-1", actorUserId: "active-user" },
    ];
    const failures: unknown[] = [];
    const resolveTenantContext = vi.fn(async (userId: string, organizationId: string) => {
      if (userId === "gone-user") throw membershipError;
      return context({ runId: "context", actorUserId: userId, organizationId });
    });
    const recover = vi.fn(async (_tenant: TenantContext, runId: string) => {
      if (runId === "recovery-failed") throw recoveryError;
      return { status: "suspended" as const };
    });
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      { resolveTenantContext },
      { recover },
      {
        onFailure: (failure) => {
          failures.push(failure);
          if (failure.reason === "legacy_actor_lineage_missing") throw new Error("보고 채널을 사용할 수 없습니다");
        },
      },
    );

    await expect(service.start()).resolves.toBeUndefined();

    expect(failures).toEqual([
      {
        reason: "legacy_actor_lineage_missing",
        runId: "legacy",
        organizationId: "organization-1",
      },
      {
        reason: "membership_unavailable",
        runId: "membership-gone",
        organizationId: "organization-1",
        cause: membershipError,
      },
      {
        reason: "recovery_failed",
        runId: "recovery-failed",
        organizationId: "organization-1",
        cause: recoveryError,
      },
    ]);
    expect(resolveTenantContext.mock.calls.map(([userId]) => userId)).toEqual([
      "gone-user",
      "active-user",
      "active-user",
    ]);
    expect(recover.mock.calls.map((call) => call[1])).toEqual(["recovery-failed", "recovered"]);
    expect(service.ready()).toBe(false);
    await service.close();
  });

  it("후보 목록 조회 실패를 보고하고 실패 닫힘 상태로 둔다", async () => {
    const listError = new Error("데이터베이스를 사용할 수 없습니다");
    const failures: unknown[] = [];
    const resolveTenantContext = vi.fn();
    const recover = vi.fn();
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable: async () => await Promise.reject(listError) },
      { resolveTenantContext },
      { recover },
      {
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
    );

    await expect(service.start()).resolves.toBeUndefined();

    expect(failures).toEqual([{ reason: "candidate_list_failed", cause: listError }]);
    expect(resolveTenantContext).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(service.ready()).toBe(false);
    await service.close();
  });

  it("close는 진행 중 복구를 기다리고 다음 후보를 시작하지 않는다", async () => {
    let release: (() => void) | undefined;
    const candidates: Candidate[] = [
      { runId: "run-active", organizationId: "organization-1", actorUserId: "user-1" },
      { runId: "run-not-started", organizationId: "organization-1", actorUserId: "user-1" },
    ];
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error("첫 복구 후보가 없습니다");
    const resolveTenantContext = vi.fn(async () => context(firstCandidate));
    const recover = vi.fn(
      async () =>
        await new Promise<{ status: "suspended" }>((resolve) => {
          release = () => resolve({ status: "suspended" });
        }),
    );
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable: async () => candidates },
      { resolveTenantContext },
      { recover },
    );

    const starting = service.start();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(service.ready()).toBe(false);

    release?.();
    await Promise.all([starting, closing]);

    expect(closed).toBe(true);
    expect(resolveTenantContext).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(service.ready()).toBe(false);
  });
});
