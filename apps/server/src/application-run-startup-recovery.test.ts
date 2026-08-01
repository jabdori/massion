import {
  APPLICATION_RUN_STAGES,
  ApplicationCommandRegistry,
  ApplicationCommandStore,
  ApplicationRunStore,
  CoreWorkCoordinator,
  registerApplicationApprovalCommands,
  type CoreWorkStage,
  type CoreWorkStageExecutor,
} from "../../../packages/application/src/index.js";
import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { ApplicationRunStartupRecoveryService } from "./application-run-startup-recovery.js";

interface Candidate {
  readonly runId: string;
  readonly organizationId: string;
  readonly actorUserId?: string;
  readonly createdAt: string;
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

function pagedSource(...pages: readonly (readonly Candidate[])[]) {
  let index = 0;
  return { listStartupRecoverable: vi.fn(async () => pages[index++] ?? []) };
}

describe("ApplicationRun 시작 복구 서비스", () => {
  it("모든 복구가 끝날 때까지 start를 완료하지 않고 한 번만 시작할 수 있다", async () => {
    let release: (() => void) | undefined;
    const candidate: Candidate = {
      runId: "run-1",
      organizationId: "organization-1",
      actorUserId: "user-1",
      createdAt: "2026-07-11T06:00:00.000Z",
    };
    const source = pagedSource([candidate], []);
    const service = new ApplicationRunStartupRecoveryService(
      source,
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
      {
        runId: "run-1",
        organizationId: "organization-1",
        actorUserId: "user-1",
        createdAt: "2026-07-11T06:00:00.000Z",
      },
      {
        runId: "run-2",
        organizationId: "organization-2",
        actorUserId: "user-2",
        createdAt: "2026-07-11T06:00:01.000Z",
      },
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
    const source = pagedSource(candidates, []);
    const service = new ApplicationRunStartupRecoveryService(source, { resolveTenantContext }, { recover });

    await service.start();

    expect(calls).toEqual(["user-1:organization-1:run-1", "user-2:organization-2:run-2"]);
    expect(maximumActive).toBe(1);
    expect(source.listStartupRecoverable).toHaveBeenCalledTimes(2);
    expect(service.ready()).toBe(true);
    await service.close();
  });

  it("투표 뒤 continuation 실행 전 종료되어도 같은 DB의 다음 시작 복구가 명령 replay와 경쟁해 정확히 한 번 완료한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const approvalId = "approval-startup-recovery-0001";
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "approval-startup-recovery-command-0001",
      correlationId: "approval-startup-recovery-correlation-0001",
      operation: "approval.decide",
      payload: {
        approvalId,
        expectedApprovalRevision: 1,
        vote: "approve" as const,
        reason: "재시작 복구 승인",
      },
    };
    let contextBefore: TenantContext;
    let runId: string;
    {
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: "approval-startup-recovery@example.com",
        displayName: "Approval startup recovery",
      });
      contextBefore = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const runs = await ApplicationRunStore.create(database, organizations);
      const started = await runs.start(contextBefore, {
        commandId: "run-before-approval-startup-recovery-0001",
        correlationId: "run-before-approval-startup-recovery-correlation-0001",
        request: { text: "투표 뒤 프로세스 종료" },
      });
      runId = started.runId;
      const claim = await runs.claim(contextBefore, runId);
      if (claim.outcome !== "claimed") throw new Error("승인 대기 준비 lease를 얻지 못했습니다");
      await runs.suspend(contextBefore, runId, claim.leaseGeneration, approvalId);

      const abandonedContinuations: Array<() => Promise<void>> = [];
      const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
      registerApplicationApprovalCommands(registry, {
        approvals: {
          vote: vi.fn().mockResolvedValue({ approval_id: approvalId, status: "approved", revision: 2 }),
        },
        runs,
        coordinator: { recover: vi.fn() },
        schedule: (_context, continuation) => abandonedContinuations.push(continuation),
      });

      await expect(registry.dispatch(contextBefore, ["approval:write"], command)).resolves.toMatchObject({
        outcome: "succeeded",
      });
      expect(abandonedContinuations).toHaveLength(1);
      await expect(runs.get(contextBefore, runId)).resolves.toMatchObject({
        status: "ready",
        resumeInput: { approvalId },
      });
    }

    // 첫 제품 경계의 continuation은 버리고 저장소·coordinator·명령 registry를 새로 조립합니다.
    {
      const organizations = await OrganizationService.create(database);
      const contextAfter = await organizations.resolveTenantContext(contextBefore.userId, contextBefore.organizationId);
      const runs = await ApplicationRunStore.create(database, organizations);
      const stageCalls: Array<{ readonly stage: CoreWorkStage; readonly resumeInput: unknown }> = [];
      const executors = Object.fromEntries(
        APPLICATION_RUN_STAGES.map((stage) => [
          stage,
          {
            async execute(_context: TenantContext, input: { readonly resumeInput?: unknown }) {
              stageCalls.push({ stage, resumeInput: input.resumeInput });
              return {
                outcome: "advanced" as const,
                ...(stage === "intake" ? { workId: "work-after-approval-startup-recovery" } : {}),
              };
            },
          },
        ]),
      ) as unknown as Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>>;
      const coordinator = new CoreWorkCoordinator(runs, executors);
      const service = new ApplicationRunStartupRecoveryService(
        runs,
        {
          resolveTenantContext: async (userId, organizationId) => {
            expect({ userId, organizationId }).toEqual({
              userId: contextAfter.userId,
              organizationId: contextAfter.organizationId,
            });
            return contextAfter;
          },
        },
        coordinator,
      );
      const replayVote = vi.fn();
      const replaySchedule = vi.fn();
      const replayRegistry = new ApplicationCommandRegistry(
        await ApplicationCommandStore.create(database, organizations),
      );
      registerApplicationApprovalCommands(replayRegistry, {
        approvals: { vote: replayVote },
        runs,
        coordinator,
        schedule: replaySchedule,
      });

      const [, replayed] = await Promise.all([
        service.start(),
        replayRegistry.dispatch(contextAfter, ["approval:write"], command),
      ]);

      expect(replayed).toMatchObject({ outcome: "succeeded" });
      expect(replayVote).not.toHaveBeenCalled();
      expect(replaySchedule).not.toHaveBeenCalled();
      await expect(runs.get(contextAfter, runId)).resolves.toMatchObject({
        status: "completed",
        stage: "terminal",
        workId: "work-after-approval-startup-recovery",
      });
      expect(stageCalls).toHaveLength(APPLICATION_RUN_STAGES.length);
      expect(stageCalls[0]).toEqual({ stage: "intake", resumeInput: { approvalId } });
      expect(stageCalls.slice(1).every((call) => call.resumeInput === undefined)).toBe(true);

      const historicalRecovery = new ApplicationRunStartupRecoveryService(
        runs,
        { resolveTenantContext: async () => contextAfter },
        coordinator,
      );
      await historicalRecovery.start();
      expect(stageCalls).toHaveLength(APPLICATION_RUN_STAGES.length);
      await historicalRecovery.close();
      await service.close();
    }
  }, 20_000);

  it("같은 생성 시각의 201개 후보를 복합 cursor로 페이지해 정확히 한 번씩 복구한다", async () => {
    const createdAt = "2026-07-11T06:00:00.000Z";
    const candidates: Candidate[] = Array.from({ length: 201 }, (_, index) => ({
      runId: `run-${String(index).padStart(3, "0")}`,
      organizationId: `organization-${index % 2}`,
      actorUserId: `user-${index}`,
      createdAt,
    }));
    const recoverable = new Set(candidates.map((candidate) => candidate.runId));
    const listStartupRecoverable = vi.fn(
      async (limit: number, cursor?: { readonly createdAt: string; readonly runId: string }) => {
        return candidates
          .filter(
            (candidate) =>
              recoverable.has(candidate.runId) &&
              (!cursor ||
                candidate.createdAt > cursor.createdAt ||
                (candidate.createdAt === cursor.createdAt && candidate.runId > cursor.runId)),
          )
          .slice(0, limit);
      },
    );
    const recovered: string[] = [];
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable },
      {
        resolveTenantContext: async (userId, organizationId) =>
          context({ runId: "context", organizationId, actorUserId: userId, createdAt }),
      },
      {
        recover: async (_tenant, runId) => {
          recovered.push(runId);
          recoverable.delete(runId);
        },
      },
    );

    await service.start();

    expect(recovered).toEqual(candidates.map((candidate) => candidate.runId));
    expect(new Set(recovered).size).toBe(201);
    expect(listStartupRecoverable.mock.calls).toEqual([
      [100, undefined],
      [100, { createdAt, runId: "run-099" }],
      [100, { createdAt, runId: "run-199" }],
      [100, { createdAt, runId: "run-200" }],
    ]);
    expect(service.ready()).toBe(true);
    await service.close();
  });

  it.each([
    { name: "동일한", firstRunId: "run-1", nextRunId: "run-1" },
    { name: "역행하는", firstRunId: "run-2", nextRunId: "run-1" },
  ])("$name page cursor는 실패 닫힘 처리하고 중복 복구하지 않는다", async ({ firstRunId, nextRunId }) => {
    const createdAt = "2026-07-11T06:00:00.000Z";
    const first: Candidate = {
      runId: firstRunId,
      organizationId: "organization-1",
      actorUserId: "user-1",
      createdAt,
    };
    const next: Candidate = { ...first, runId: nextRunId };
    const listStartupRecoverable = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([next])
      .mockResolvedValueOnce([]);
    const failures: unknown[] = [];
    const recover = vi.fn(async () => undefined);
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable },
      { resolveTenantContext: async () => context(first) },
      { recover },
      { onFailure: (failure) => failures.push(failure) },
    );

    await service.start();

    expect(listStartupRecoverable).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls.map(([, runId]) => runId)).toEqual([firstRunId]);
    expect(failures).toEqual([expect.objectContaining({ reason: "candidate_list_failed", cause: expect.any(Error) })]);
    expect(service.ready()).toBe(false);
    await service.close();
  });

  it("후보별 계보·membership·복구 실패를 격리하고 실패 닫힘 상태로 둔다", async () => {
    const membershipError = new Error("활성 Membership이 없습니다");
    const recoveryError = new Error("복구 체크포인트가 손상됐습니다");
    const candidates: Candidate[] = [
      {
        runId: "legacy",
        organizationId: "organization-1",
        createdAt: "2026-07-11T06:00:00.000Z",
      },
      {
        runId: "membership-gone",
        organizationId: "organization-1",
        actorUserId: "gone-user",
        createdAt: "2026-07-11T06:00:01.000Z",
      },
      {
        runId: "recovery-failed",
        organizationId: "organization-1",
        actorUserId: "active-user",
        createdAt: "2026-07-11T06:00:02.000Z",
      },
      {
        runId: "recovered",
        organizationId: "organization-1",
        actorUserId: "active-user",
        createdAt: "2026-07-11T06:00:03.000Z",
      },
    ];
    const failures: unknown[] = [];
    const resolveTenantContext = vi.fn(async (userId: string, organizationId: string) => {
      if (userId === "gone-user") throw membershipError;
      return context({
        runId: "context",
        actorUserId: userId,
        organizationId,
        createdAt: "2026-07-11T06:00:00.000Z",
      });
    });
    const recover = vi.fn(async (_tenant: TenantContext, runId: string) => {
      if (runId === "recovery-failed") throw recoveryError;
      return { status: "suspended" as const };
    });
    const source = pagedSource(candidates.slice(0, 2), candidates.slice(2), []);
    const service = new ApplicationRunStartupRecoveryService(
      source,
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
    expect(source.listStartupRecoverable).toHaveBeenCalledTimes(3);
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

  it("다음 page 목록 조회가 실패하면 한 번 보고하고 더 진행하지 않는다", async () => {
    const listError = new Error("두 번째 page를 조회할 수 없습니다");
    const candidates: Candidate[] = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${String(index).padStart(3, "0")}`,
      organizationId: "organization-1",
      actorUserId: "user-1",
      createdAt: "2026-07-11T06:00:00.000Z",
    }));
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error("첫 복구 후보가 없습니다");
    const listStartupRecoverable = vi
      .fn()
      .mockResolvedValueOnce(candidates)
      .mockRejectedValueOnce(listError)
      .mockResolvedValueOnce([]);
    const failures: unknown[] = [];
    const recover = vi.fn(async () => undefined);
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable },
      { resolveTenantContext: async () => context(firstCandidate) },
      { recover },
      { onFailure: (failure) => failures.push(failure) },
    );

    await service.start();

    expect(recover).toHaveBeenCalledTimes(100);
    expect(listStartupRecoverable).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([{ reason: "candidate_list_failed", cause: listError }]);
    expect(service.ready()).toBe(false);
    await service.close();
  });

  it("close는 진행 중 복구를 기다리고 다음 후보를 시작하지 않는다", async () => {
    let release: (() => void) | undefined;
    const candidates: Candidate[] = [
      {
        runId: "run-active",
        organizationId: "organization-1",
        actorUserId: "user-1",
        createdAt: "2026-07-11T06:00:00.000Z",
      },
      {
        runId: "run-not-started",
        organizationId: "organization-1",
        actorUserId: "user-1",
        createdAt: "2026-07-11T06:00:01.000Z",
      },
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
    const source = pagedSource(candidates, []);
    const service = new ApplicationRunStartupRecoveryService(source, { resolveTenantContext }, { recover });

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
    expect(source.listStartupRecoverable).toHaveBeenCalledOnce();
    expect(service.ready()).toBe(false);
  });

  it("page 조회 중 close되면 조회를 기다리고 반환된 후보를 시작하지 않는다", async () => {
    let release: (() => void) | undefined;
    const candidate: Candidate = {
      runId: "run-not-started",
      organizationId: "organization-1",
      actorUserId: "user-1",
      createdAt: "2026-07-11T06:00:00.000Z",
    };
    const listStartupRecoverable = vi.fn(
      async () =>
        await new Promise<readonly Candidate[]>((resolve) => {
          release = () => resolve([candidate]);
        }),
    );
    const resolveTenantContext = vi.fn();
    const recover = vi.fn();
    const service = new ApplicationRunStartupRecoveryService(
      { listStartupRecoverable },
      { resolveTenantContext },
      { recover },
    );

    const starting = service.start();
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release?.();
    await Promise.all([starting, closing]);

    expect(listStartupRecoverable).toHaveBeenCalledOnce();
    expect(resolveTenantContext).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(service.ready()).toBe(false);
  });
});
