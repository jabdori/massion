import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import type { AssuranceRun } from "./contracts.js";
import {
  createAssuranceServiceTestHarness,
  type AssuranceDecisionSource,
  type AssuranceRunDecisionGateway,
} from "./service.js";
import type { AssuranceVerdictDecisionInput } from "./verdict.js";

const context = {
  organizationId: "organization-1",
  userId: "user-1",
  membershipId: "membership-1",
  role: "owner",
} as TenantContext;

function run(status: AssuranceRun["status"] = "running"): AssuranceRun {
  return {
    assuranceRunId: "run-1",
    organizationId: context.organizationId,
    workId: "work-1",
    targetWorkRevision: 7,
    planVersionId: "plan-1",
    bindingVersionId: "binding-1",
    profileId: "massion.assurance.acceptance.v1",
    profileVersion: "1.0.0",
    verifierHandle: "assurance",
    verifierExecutionId: "execution-1",
    snapshotHash: "a".repeat(64),
    status,
    version: status === "running" ? 2 : 3,
    attempt: 1,
    startCommandId: "start-1",
    ...(status === "passed" || status === "failed" || status === "blocked" ? { verdict: status } : {}),
    ...(status === "running" ? {} : { decisionEvidenceHash: "d".repeat(64), decisionGuardRevision: 1 }),
    ...(status === "failed" || status === "blocked"
      ? { failure: { category: "assurance_criterion_failed", causeHash: "b".repeat(64) } }
      : {}),
    createdByUserId: context.userId,
    expiresAt: "2026-07-10T01:00:00.000Z",
    startedAt: "2026-07-10T00:00:00.000Z",
    ...(status === "running" ? {} : { completedAt: "2026-07-10T00:10:00.000Z" }),
    updatedAt: "2026-07-10T00:10:00.000Z",
  };
}

function decisionInput(overrides: Partial<AssuranceVerdictDecisionInput> = {}): AssuranceVerdictDecisionInput {
  return {
    cancellationRequested: false,
    snapshotStatus: "fresh",
    identityValid: true,
    bindingValid: true,
    independenceValid: true,
    verifierSucceeded: true,
    requiredEvidenceComplete: true,
    criteria: [{ criterionId: "criterion-1", status: "passed" }],
    checks: [{ criterionId: "criterion-1", bindingKey: "check-1", status: "passed", outputHash: "c".repeat(64) }],
    findings: [],
    ...overrides,
  };
}

function fixture(sourceInput = decisionInput(), current = run()) {
  const source: AssuranceDecisionSource = {
    read: vi.fn(async () => ({ run: current, decisionInput: sourceInput })),
  };
  const gateway: AssuranceRunDecisionGateway = {
    get: vi.fn(async () => current),
    transition: vi.fn(async (_context, input) => ({
      run: {
        ...current,
        status: input.target,
        version: current.version + 1,
        ...(input.target === "passed" || input.target === "failed" || input.target === "blocked"
          ? { verdict: input.target }
          : {}),
      } as AssuranceRun,
    })),
  };
  return { source, gateway, service: createAssuranceServiceTestHarness(source, gateway) };
}

describe("Assurance decision service", () => {
  it.each([
    { label: "passed", source: decisionInput(), expected: "passed" as const },
    {
      label: "failed",
      source: decisionInput({ criteria: [{ criterionId: "criterion-1", status: "failed" }] }),
      expected: "failed" as const,
    },
    { label: "blocked", source: decisionInput({ requiredEvidenceComplete: false }), expected: "blocked" as const },
  ])("DB source에서 계산한 $label만 run terminal target으로 전이한다", async ({ source, expected }) => {
    const setup = fixture(source);
    const actual = await setup.service.decide(context, {
      commandId: "decision-1",
      assuranceRunId: "run-1",
      expectedVersion: 2,
    });

    expect(actual.decision.status).toBe(expected);
    expect(setup.gateway.transition).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        commandId: "decision-1",
        assuranceRunId: "run-1",
        expectedVersion: 2,
        target: expected,
      }),
    );
  });

  it("explicit cancellation만 cancelled target을 만들고 failure를 저장하지 않는다", async () => {
    const setup = fixture();
    const actual = await setup.service.decide(context, {
      commandId: "cancel-1",
      assuranceRunId: "run-1",
      expectedVersion: 2,
      cancellationRequested: true,
    });
    expect(actual.decision.status).toBe("cancelled");
    expect(setup.source.read).not.toHaveBeenCalled();
    expect(setup.gateway.transition).toHaveBeenCalledWith(
      context,
      expect.not.objectContaining({ failure: expect.anything() }),
    );
  });

  it("terminal command replay는 source를 다시 평가하지 않고 ledger replay 계약을 사용한다", async () => {
    const setup = fixture(decisionInput(), run("passed"));
    const actual = await setup.service.decide(context, {
      commandId: "terminal-replay",
      assuranceRunId: "run-1",
      expectedVersion: 2,
    });
    expect(actual.decision.status).toBe("passed");
    expect(actual.decision.evidenceHash).toBe("d".repeat(64));
    expect(setup.source.read).not.toHaveBeenCalled();
    expect(setup.gateway.transition).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ target: "passed", expectedVersion: 2 }),
    );
  });

  it("0045 이전 terminal run도 deterministic legacy evidence hash로 재생한다", async () => {
    const legacyRun = { ...run("passed"), decisionEvidenceHash: undefined, decisionGuardRevision: undefined } as never;
    const first = fixture(decisionInput(), legacyRun);
    const second = fixture(decisionInput(), legacyRun);
    const replayInput = { commandId: "legacy-replay", assuranceRunId: "run-1", expectedVersion: 2 };

    const [left, right] = await Promise.all([
      first.service.decide(context, replayInput),
      second.service.decide(context, replayInput),
    ]);
    expect(left.decision.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(right.decision.evidenceHash).toBe(left.decision.evidenceHash);
  });

  it("caller verdict·target·failure 주입과 run/version 불일치를 거부한다", async () => {
    const setup = fixture();
    for (const injected of [
      { verdict: "passed" },
      { target: "passed" },
      { failure: { category: "forged", causeHash: "f".repeat(64) } },
    ]) {
      await expect(
        setup.service.decide(context, {
          commandId: "decision-invalid",
          assuranceRunId: "run-1",
          expectedVersion: 2,
          ...injected,
        } as never),
      ).rejects.toThrow("caller verdict");
    }
    await expect(
      setup.service.decide(context, { commandId: "wrong-run", assuranceRunId: "run-2", expectedVersion: 2 }),
    ).rejects.toThrow("run");
    await expect(
      setup.service.decide(context, { commandId: "wrong-version", assuranceRunId: "run-1", expectedVersion: 99 }),
    ).rejects.toThrow("version");
  });
});
