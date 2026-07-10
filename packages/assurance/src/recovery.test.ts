import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import type { AssuranceRun } from "./contracts.js";
import {
  createAssuranceRecoveryTestHarness,
  type AssuranceRecoveryContinuation,
  type AssuranceRecoveryGateway,
  type AssuranceRecoveryLedger,
  type AssuranceRecoveryMetricSink,
  type AssuranceRecoveryProjectionGateway,
  type AssuranceRecoveryReadinessSource,
} from "./recovery.js";

const context = {
  organizationId: "organization-1",
  userId: "user-1",
  membershipId: "membership-1",
  role: "owner",
} as TenantContext;

function assuranceRun(status: AssuranceRun["status"] = "running", projectedWorkRevision?: number): AssuranceRun {
  return {
    assuranceRunId: "run-1",
    organizationId: context.organizationId,
    workId: "work-1",
    targetWorkRevision: 7,
    planVersionId: "plan-1",
    bindingVersionId: "binding-1",
    profileId: "massion.assurance.software-change.v1",
    profileVersion: "1.0.0",
    verifierHandle: "assurance",
    verifierExecutionId: "execution-1",
    snapshotHash: "a".repeat(64),
    status,
    version: status === "running" ? 2 : projectedWorkRevision === undefined ? 3 : 4,
    attempt: 1,
    startCommandId: "start-1",
    ...(status === "passed" || status === "failed" || status === "blocked" ? { verdict: status } : {}),
    ...(projectedWorkRevision === undefined ? {} : { projectedWorkRevision }),
    ...(status === "failed" || status === "blocked"
      ? { failure: { category: "assurance_evidence_blocked", causeHash: "b".repeat(64) } }
      : {}),
    createdByUserId: context.userId,
    expiresAt: "2026-07-10T00:01:00.000Z",
    startedAt: "2026-07-10T00:00:00.000Z",
    ...(status === "running" ? {} : { completedAt: "2026-07-10T00:02:00.000Z" }),
    updatedAt: "2026-07-10T00:02:00.000Z",
  };
}

function fixture(initial = assuranceRun()) {
  let current = initial;
  const replay = new Map<string, { assuranceRunId: string; result: string }>();
  const gateway: AssuranceRecoveryGateway = {
    get: vi.fn(async () => current),
    decide: vi.fn(async (_context, input) => {
      current = { ...assuranceRun("passed"), version: input.expectedVersion + 1 };
      return { run: current };
    }),
  };
  const projection: AssuranceRecoveryProjectionGateway = {
    projectVerdict: vi.fn(async (_context, input) => {
      current = { ...current, projectedWorkRevision: input.expectedRevision + 1, version: current.version + 1 };
    }),
  };
  const readiness: AssuranceRecoveryReadinessSource = {
    inspect: vi.fn(async () => ({ snapshotFresh: true, storedResultsValid: true, evidenceComplete: false })),
  };
  const continuation: AssuranceRecoveryContinuation = { resume: vi.fn(async () => undefined) };
  const ledger: AssuranceRecoveryLedger = {
    replay: vi.fn(async (_context, input) => replay.get(input.commandId)),
    record: vi.fn(async (_context, input) => {
      replay.set(input.commandId, { assuranceRunId: input.assuranceRunId, result: input.result });
    }),
  };
  const metrics: AssuranceRecoveryMetricSink = { recordOnce: vi.fn(async () => undefined) };
  const recovery = createAssuranceRecoveryTestHarness({
    gateway,
    projection,
    readiness,
    continuation,
    ledger,
    metrics,
    now: () => new Date("2026-07-10T00:10:00.000Z"),
  });
  return { gateway, projection, readiness, continuation, ledger, metrics, recovery, current: () => current };
}

describe("Assurance crash recovery", () => {
  it("check 저장 전 crash는 같은 continuation을 재개하고 terminal 판정과 WorkVerification을 조정한다", async () => {
    const setup = fixture();
    const result = await setup.recovery.recover(context, { commandId: "recover-1", assuranceRunId: "run-1" });

    expect(setup.continuation.resume).toHaveBeenCalledOnce();
    expect(setup.gateway.decide).toHaveBeenCalledWith(context, {
      commandId: "run-1:recovery-decision",
      assuranceRunId: "run-1",
      expectedVersion: 2,
    });
    expect(setup.projection.projectVerdict).toHaveBeenCalledWith(context, {
      commandId: "run-1:work-verification",
      workId: "work-1",
      expectedRevision: 7,
      assuranceRunId: "run-1",
    });
    expect(result.result).toBe("projected");
  });

  it("check 저장 후 crash는 저장된 hash가 완전하면 재실행 없이 terminal 판정한다", async () => {
    const setup = fixture();
    vi.mocked(setup.readiness.inspect).mockResolvedValue({
      snapshotFresh: true,
      storedResultsValid: true,
      evidenceComplete: true,
    });
    await setup.recovery.recover(context, { commandId: "recover-after-check", assuranceRunId: "run-1" });

    expect(setup.continuation.resume).not.toHaveBeenCalled();
    expect(setup.gateway.decide).toHaveBeenCalledOnce();
  });

  it("run terminal 직후 crash는 passed와 failed를 각각 고정 command로 Work에 투영한다", async () => {
    const passed = fixture(assuranceRun("passed"));
    await passed.recovery.recover(context, { commandId: "recover-passed", assuranceRunId: "run-1" });
    expect(passed.projection.projectVerdict).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ commandId: "run-1:work-verification" }),
    );

    const failed = fixture(assuranceRun("failed"));
    await failed.recovery.recover(context, { commandId: "recover-failed", assuranceRunId: "run-1" });
    expect(failed.projection.projectVerdict).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ commandId: "run-1:work-failed" }),
    );
  });

  it("WorkVerification 또는 Work failed 전이 직후 crash는 terminal run과 Work를 다시 변경하지 않는다", async () => {
    for (const status of ["passed", "failed"] as const) {
      const setup = fixture(assuranceRun(status, 8));
      const result = await setup.recovery.recover(context, {
        commandId: `recover-projected-${status}`,
        assuranceRunId: "run-1",
      });
      expect(result.result).toBe("projected");
      expect(setup.gateway.decide).not.toHaveBeenCalled();
      expect(setup.projection.projectVerdict).not.toHaveBeenCalled();
    }
  });

  it("만료 run의 snapshot 또는 저장 결과 hash가 유효하지 않으면 재개하지 않고 blocked로 조정한다", async () => {
    const setup = fixture();
    vi.mocked(setup.readiness.inspect).mockResolvedValue({
      snapshotFresh: false,
      storedResultsValid: false,
      evidenceComplete: false,
    });
    vi.mocked(setup.gateway.decide).mockImplementation(async (_context, input) => ({
      run: { ...assuranceRun("blocked"), version: input.expectedVersion + 1 },
    }));
    const result = await setup.recovery.recover(context, {
      commandId: "recover-invalid",
      assuranceRunId: "run-1",
    });

    expect(setup.continuation.resume).not.toHaveBeenCalled();
    expect(result.result).toBe("blocked");
  });

  it("아직 만료되지 않은 불완전 run에 continuation이 없으면 진행 중 run을 blocked로 바꾸지 않는다", async () => {
    const setup = fixture({ ...assuranceRun(), expiresAt: "2026-07-10T01:00:00.000Z" });
    const recovery = createAssuranceRecoveryTestHarness({
      gateway: setup.gateway,
      projection: setup.projection,
      readiness: setup.readiness,
      ledger: setup.ledger,
      metrics: setup.metrics,
      now: () => new Date("2026-07-10T00:10:00.000Z"),
    });
    const result = await recovery.recover(context, {
      commandId: "recover-live-without-continuation",
      assuranceRunId: "run-1",
    });

    expect(result.result).toBe("resume_required");
    expect(setup.gateway.decide).not.toHaveBeenCalled();
    expect(setup.projection.projectVerdict).not.toHaveBeenCalled();
  });

  it("blocked·cancelled terminal run은 변경하지 않고 같은 recovery command와 metric을 한 번만 기록한다", async () => {
    for (const status of ["blocked", "cancelled"] as const) {
      const setup = fixture(assuranceRun(status));
      const input = { commandId: `recover-${status}`, assuranceRunId: "run-1" };
      const first = await setup.recovery.recover(context, input);
      const replayed = await setup.recovery.recover(context, input);

      expect(first.result).toBe("terminal_unchanged");
      expect(replayed).toEqual(first);
      expect(setup.gateway.decide).not.toHaveBeenCalled();
      expect(setup.projection.projectVerdict).not.toHaveBeenCalled();
      expect(setup.ledger.record).toHaveBeenCalledOnce();
      expect(setup.metrics.recordOnce).toHaveBeenCalledOnce();
    }
  });
});
