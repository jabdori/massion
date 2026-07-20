import { describe, expect, it } from "vitest";

import { CoreAssuranceStage } from "./core-assurance-stage.js";

const context = {
  userId: "assurance-user",
  organizationId: "assurance-org",
  membershipId: "assurance-member",
  role: "owner" as const,
};
const input = {
  runId: "assurance-run-root",
  workId: "assurance-work",
  commandId: "assurance-run-root:assurance",
  correlationId: "assurance-correlation",
  request: { assurance: { bindingVersionId: "binding-1", profileId: "profile-1", profileVersion: "1.0.0" } },
};

const automaticEvidencePlan = {
  objective: "산출물을 검증한다",
  summary: "완료 산출물을 evidence로 확인한다",
  scopeIn: [],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "artifact-created",
      statement: "산출물이 생성된다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "deliver",
      title: "전달",
      objective: "산출물을 생성한다",
      criterionKeys: ["artifact-created"],
      dependencyKeys: [],
      requiredCapabilities: [],
      recommendedAgentHandles: ["delivery-coordination"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

const noStoredVerifier = {
  findExecutionIdByCommand: async () => undefined,
  getRecovery: async () => {
    throw new Error("저장된 verifier가 없습니다");
  },
};

function verifierRunner(calls: string[] = []) {
  return {
    stream: async function* () {
      calls.push("verifier-queued");
      yield { executionId: "verifier-execution", sequence: 1, type: "execution_queued", payload: {}, createdAt: "now" };
      calls.push("verifier-running");
      yield {
        executionId: "verifier-execution",
        sequence: 2,
        type: "execution_running",
        payload: {},
        createdAt: "now",
      };
      calls.push("verifier-succeeded");
      yield {
        executionId: "verifier-execution",
        sequence: 3,
        type: "execution_succeeded",
        payload: {},
        createdAt: "now",
      };
    },
    recover: async () => {
      calls.push("verifier-finished");
      return { executionId: "verifier-execution", status: "succeeded" };
    },
  };
}

describe("CoreAssuranceStage", () => {
  it("계획 조직의 일반 완료 기준을 실제 산출물 검사로 자동 연결하고 Work 검증까지 반영한다", async () => {
    const calls: string[] = [];
    let proposed: unknown;
    let activated: unknown;
    const plan = {
      objective: "일반 전달 검증",
      summary: "전달 산출물을 독립적으로 확인한다",
      scopeIn: ["Core 경로"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "deliverable-created",
          statement: "전달 산출물이 생성된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver",
          title: "전달",
          objective: "산출물을 만든다",
          criterionKeys: ["deliverable-created"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1", content_json: JSON.stringify(plan) }),
        recoverWork: async () => ({
          artifacts: [{ kind: "task-output" }],
          tasks: [
            {
              task_id: "task-1",
              status: "completed",
              acceptance_criteria_json: JSON.stringify([plan.acceptanceCriteria[0]]),
            },
          ],
        }),
      },
      bindings: {
        getActive: async () => undefined,
        propose: async (_context: unknown, value: unknown) => {
          calls.push("binding-propose");
          proposed = value;
          return {
            bindingVersionId: "binding-1",
            revision: 1,
            profileId: "massion.assurance.acceptance.v1",
            profileVersion: "1.0.0",
          };
        },
        activate: async (_context: unknown, value: unknown) => {
          calls.push("binding-activate");
          activated = value;
          return {
            bindingVersionId: "binding-1",
            revision: 2,
            profileId: "massion.assurance.acceptance.v1",
            profileVersion: "1.0.0",
          };
        },
      },
      runner: verifierRunner(calls),
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async () => {
          calls.push("snapshot");
          return { snapshot: { hash: "a".repeat(64) } };
        },
        findByStartCommand: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        start: async () => {
          calls.push("start");
          return { run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } };
        },
        transition: async () => {
          calls.push("running");
          return { run: { assuranceRunId: "assurance-1", status: "running", version: 2 } };
        },
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => {
          calls.push("decide");
          return { run: { assuranceRunId: "assurance-1", status: "passed", version: 3 } };
        },
        projectVerdict: async () => {
          calls.push("project");
          return { work: { revision: 8 } };
        },
      },
      checks: {
        execute: async (_context: unknown, value: { readonly run: { readonly status: string } }) => {
          calls.push("checks");
          expect(value.run.status).toBe("running");
          return { outcome: "ready" };
        },
      },
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toMatchObject({
      outcome: "advanced",
      data: { assuranceRunId: "assurance-1", verdict: "passed", projectedWorkRevision: 8 },
    });
    expect(proposed).toMatchObject({
      authorHandle: "assurance",
      requiredCriteria: [
        { criterionKey: "deliverable-created", method: "evidence" },
        { criterionKey: "profile:acceptance:coverage", method: "evidence" },
      ],
      bindings: [
        expect.objectContaining({
          criterionKey: "deliverable-created",
          kind: "evidence",
          evidenceKinds: ["artifact-version"],
        }),
        expect.objectContaining({
          criterionKey: "profile:acceptance:coverage",
          kind: "evidence",
          evidenceKinds: ["check-result"],
        }),
      ],
    });
    expect(activated).toMatchObject({ bindingVersionId: "binding-1", expectedRevision: 1 });
    expect(calls).toEqual([
      "binding-propose",
      "binding-activate",
      "snapshot",
      "verifier-queued",
      "verifier-running",
      "start",
      "running",
      "verifier-succeeded",
      "verifier-finished",
      "checks",
      "decide",
      "project",
    ]);
  });

  it("소프트웨어 변경은 신뢰할 수 있는 검사 recipe가 연결되기 전까지 자동 통과시키지 않는다", async () => {
    let proposed = false;
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1", content_json: "{}" }),
        recoverWork: async () => ({ artifacts: [{ kind: "code-change" }], tasks: [] }),
      },
      bindings: {
        getActive: async () => undefined,
        propose: async () => {
          proposed = true;
          return {};
        },
      },
      runner: verifierRunner(),
      runtimeExecutions: noStoredVerifier,
      assurance: {},
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
      outcome: "blocked",
      reason: "assurance-recipe-unavailable",
    });
    expect(proposed).toBe(false);
  });

  it("요청에 ID가 없어도 현재 Plan과 Artifact에 맞는 활성 binding을 자동 선택한다", async () => {
    let snapshotInput: unknown;
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-auto",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: verifierRunner(),
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async (_context: unknown, value: unknown) => {
          snapshotInput = value;
          return { snapshot: { hash: "a".repeat(64) } };
        },
        start: async () => ({ run: { assuranceRunId: "assurance-auto", status: "planned", version: 1 } }),
        transition: async () => ({ run: { assuranceRunId: "assurance-auto", status: "running", version: 2 } }),
        get: async () => ({ assuranceRunId: "assurance-auto", status: "running", version: 2 }),
        decide: async () => ({ run: { assuranceRunId: "assurance-auto", status: "passed", version: 3 } }),
        projectVerdict: async () => ({ work: { revision: 8 } }),
      },
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);
    await expect(stage.execute(context, { ...input, request: {} })).resolves.toMatchObject({ outcome: "advanced" });
    expect(snapshotInput).toMatchObject({
      bindingVersionId: "binding-auto",
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
    });
  });

  it("snapshot→independent verifier→run→checks→decide 순서와 service verdict를 사용한다", async () => {
    const calls: string[] = [];
    const assurance = {
      prepareSnapshot: async () => {
        calls.push("snapshot");
        return { snapshot: { hash: "a".repeat(64) } };
      },
      start: async () => {
        calls.push("start");
        return { run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } };
      },
      transition: async () => {
        calls.push("running");
        return { run: { assuranceRunId: "assurance-1", status: "running", version: 2 } };
      },
      get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
      decide: async () => {
        calls.push("decide");
        return {
          run: { assuranceRunId: "assurance-1", status: "passed", version: 3 },
          decision: { status: "passed" },
        };
      },
      projectVerdict: async () => {
        calls.push("project");
        return { work: { revision: 8 } };
      },
    };
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: verifierRunner(calls),
      runtimeExecutions: noStoredVerifier,
      assurance,
      checks: {
        execute: async () => {
          calls.push("checks");
          return { outcome: "ready" };
        },
      },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { assuranceRunId: "assurance-1", verdict: "passed" },
    });
    expect(calls).toEqual([
      "snapshot",
      "verifier-queued",
      "verifier-running",
      "start",
      "running",
      "verifier-succeeded",
      "verifier-finished",
      "checks",
      "decide",
      "project",
    ]);
  });

  it("human check는 approval 대기로, failed verdict는 명시 차단으로 반환한다", async () => {
    const base = {
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: verifierRunner(),
      assurance: {
        prepareSnapshot: async () => ({ snapshot: { hash: "a".repeat(64) } }),
        start: async () => ({ run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } }),
        transition: async () => ({ run: { assuranceRunId: "assurance-1", status: "running", version: 2 } }),
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => ({
          run: { assuranceRunId: "assurance-1", status: "failed", version: 2 },
          decision: { status: "failed" },
        }),
        projectVerdict: async () => ({ work: { revision: 8 } }),
      },
    };
    const waiting = new CoreAssuranceStage({
      ...base,
      runtimeExecutions: noStoredVerifier,
      checks: { execute: async () => ({ outcome: "awaiting-approval", approvalId: "approval-1" }) },
    } as never);
    await expect(waiting.execute(context, input)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      approvalId: "approval-1",
    });
    const failed = new CoreAssuranceStage({
      ...base,
      runtimeExecutions: noStoredVerifier,
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);
    await expect(failed.execute(context, input)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "assurance-failed",
    });
  });

  it("승인 재개는 이미 끝난 verifier와 running Assurance run을 재사용한다", async () => {
    const calls: string[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        stream: () => {
          throw new Error("재개에서 새 verifier를 시작하면 안 됩니다");
        },
        recover: async () => {
          calls.push("verifier-reused");
          return { executionId: "verifier-existing", status: "succeeded" };
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-existing",
        getRecovery: async () => ({ execution: { status: "succeeded" } }),
      },
      assurance: {
        prepareSnapshot: async () => {
          calls.push("snapshot");
          return { snapshot: { hash: "a".repeat(64) } };
        },
        findByStartCommand: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        start: async () => {
          calls.push("start-replay");
          return { run: { assuranceRunId: "assurance-1", status: "running", version: 2 } };
        },
        transition: async () => {
          throw new Error("running Assurance run을 다시 전이하면 안 됩니다");
        },
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => {
          calls.push("decide");
          return { run: { assuranceRunId: "assurance-1", status: "passed", version: 3 } };
        },
        projectVerdict: async () => {
          calls.push("project");
          return { work: { revision: 8 } };
        },
      },
      checks: {
        execute: async (_context: unknown, value: { readonly resumeInput?: unknown }) => {
          calls.push("checks");
          expect(value.resumeInput).toEqual({ approvalId: "approval-1" });
          return { outcome: "ready" };
        },
      },
    } as never);

    await expect(
      stage.execute(context, { ...input, request: {}, resumeInput: { approvalId: "approval-1" } }),
    ).resolves.toMatchObject({ outcome: "advanced", data: { projectedWorkRevision: 8 } });
    expect(calls).toEqual(["snapshot", "start-replay", "verifier-reused", "checks", "decide", "project"]);
  });

  it("중단 직후 대기열에 남은 verifier는 같은 실행을 시작해 완료한다", async () => {
    const calls: string[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: verifierRunner(calls),
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-queued",
        getRecovery: async () => ({ execution: { status: "queued" } }),
      },
      assurance: {
        prepareSnapshot: async () => {
          calls.push("snapshot");
          return { snapshot: { hash: "a".repeat(64) } };
        },
        start: async () => {
          calls.push("start");
          return { run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } };
        },
        transition: async () => {
          calls.push("running");
          return { run: { assuranceRunId: "assurance-1", status: "running", version: 2 } };
        },
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => {
          calls.push("decide");
          return { run: { assuranceRunId: "assurance-1", status: "passed", version: 3 } };
        },
        projectVerdict: async () => {
          calls.push("project");
          return { work: { revision: 8 } };
        },
      },
      checks: {
        execute: async () => {
          calls.push("checks");
          return { outcome: "ready" };
        },
      },
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toMatchObject({
      outcome: "advanced",
      data: { projectedWorkRevision: 8 },
    });
    expect(calls).toEqual([
      "snapshot",
      "verifier-queued",
      "verifier-running",
      "start",
      "running",
      "verifier-succeeded",
      "verifier-finished",
      "checks",
      "decide",
      "project",
    ]);
  });

  it("이미 실행 중인 verifier는 다른 stage 재개가 중단시키지 않고 진행 중으로 남긴다", async () => {
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        stream: () => {
          throw new Error("실행 중 verifier를 다시 stream하면 안 됩니다");
        },
        recover: async () => {
          throw new Error("실행 중 verifier를 recover하면 안 됩니다");
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-running",
        getRecovery: async () => ({ execution: { status: "running" } }),
      },
      assurance: {
        prepareSnapshot: async () => {
          throw new Error("진행 중 verifier에는 새 snapshot이 필요하지 않습니다");
        },
      },
      checks: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({ outcome: "in-progress" });
  });

  it.each([
    {
      verifierStatus: "failed",
      activeRunStatus: "planned",
      terminalRunStatus: "blocked",
      expectedReason: "assurance-blocked",
      cancellationRequested: false,
    },
    {
      verifierStatus: "blocked_model_unavailable",
      activeRunStatus: "running",
      terminalRunStatus: "blocked",
      expectedReason: "model-unavailable",
      cancellationRequested: false,
    },
    {
      verifierStatus: "cancelled",
      activeRunStatus: "planned",
      terminalRunStatus: "cancelled",
      expectedReason: "assurance-cancelled",
      cancellationRequested: true,
    },
  ] as const)(
    "저장된 $verifierStatus verifier는 활성 Assurance run을 종료한 뒤 반환한다",
    async ({ verifierStatus, activeRunStatus, terminalRunStatus, expectedReason, cancellationRequested }) => {
      const decisions: unknown[] = [];
      const stage = new CoreAssuranceStage({
        works: {
          getWork: async () => ({ revision: 7 }),
          getActivePlan: async () => ({ plan_version_id: "plan-1" }),
          recoverWork: async () => ({ artifacts: [] }),
        },
        bindings: {
          getActive: async () => ({
            bindingVersionId: "binding-1",
            profileId: "massion.assurance.acceptance.v1",
            profileVersion: "1.0.0",
          }),
        },
        runner: {},
        runtimeExecutions: {
          findExecutionIdByCommand: async () => "verifier-existing",
          getRecovery: async () => ({ execution: { status: verifierStatus } }),
        },
        assurance: {
          findByStartCommand: async () => ({
            assuranceRunId: "assurance-1",
            status: activeRunStatus,
            version: 2,
          }),
          decide: async (_context: unknown, value: unknown) => {
            decisions.push(value);
            return {
              run: {
                assuranceRunId: "assurance-1",
                status: terminalRunStatus,
                version: 3,
              },
            };
          },
          prepareSnapshot: async () => {
            throw new Error("끝난 verifier에는 새 snapshot을 만들면 안 됩니다");
          },
        },
        checks: {},
      } as never);

      await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
        outcome: "blocked",
        reason: expectedReason,
      });
      expect(decisions).toEqual([
        {
          commandId: "assurance-run-root:assurance:decide",
          assuranceRunId: "assurance-1",
          expectedVersion: 2,
          ...(cancellationRequested ? { cancellationRequested: true } : {}),
        },
      ]);
    },
  );

  it("이미 종료된 Assurance run은 저장된 verifier 실패에서도 다시 결정하지 않는다", async () => {
    const decisions: unknown[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {},
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-existing",
        getRecovery: async () => ({ execution: { status: "failed" } }),
      },
      assurance: {
        findByStartCommand: async () => ({ assuranceRunId: "assurance-1", status: "blocked", version: 3 }),
        decide: async (_context: unknown, value: unknown) => {
          decisions.push(value);
          throw new Error("종료된 run을 다시 결정하면 안 됩니다");
        },
        prepareSnapshot: async () => {
          throw new Error("끝난 verifier에는 새 snapshot을 만들면 안 됩니다");
        },
      },
      checks: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
      outcome: "blocked",
      reason: "assurance-blocked",
    });
    expect(decisions).toEqual([]);
  });

  it("차단된 checks는 active guard를 종료하고 다음 재시도 stage를 진행시킨다", async () => {
    let activeGuard = false;
    let startCount = 0;
    let checkCount = 0;
    const decisions: unknown[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        ...verifierRunner(),
        cancel: async () => undefined,
      },
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async () => ({ snapshot: { hash: "a".repeat(64) } }),
        start: async () => {
          if (activeGuard) throw new Error("active Assurance guard 충돌");
          activeGuard = true;
          startCount += 1;
          return {
            run: {
              assuranceRunId: `assurance-${String(startCount)}`,
              status: "planned",
              version: 1,
            },
          };
        },
        transition: async (_context: unknown, value: { readonly assuranceRunId: string }) => ({
          run: { assuranceRunId: value.assuranceRunId, status: "running", version: 2 },
        }),
        get: async (_context: unknown, assuranceRunId: string) => ({
          assuranceRunId,
          status: "running",
          version: 2,
        }),
        decide: async (_context: unknown, value: unknown) => {
          decisions.push(value);
          activeGuard = false;
          const terminalRunStatus = decisions.length === 1 ? "blocked" : "passed";
          return {
            run: {
              assuranceRunId: (value as { readonly assuranceRunId: string }).assuranceRunId,
              status: terminalRunStatus,
              version: 3,
            },
          };
        },
        projectVerdict: async () => ({ work: { revision: 8 } }),
      },
      checks: {
        execute: async () => {
          checkCount += 1;
          return checkCount === 1
            ? { outcome: "blocked" as const, reason: "assurance-binding-incomplete" }
            : { outcome: "ready" as const };
        },
      },
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
      outcome: "blocked",
      reason: "assurance-binding-incomplete",
    });
    await expect(
      stage.execute(context, {
        ...input,
        commandId: "assurance-run-root:assurance:retry:attempt-1",
        request: {},
      }),
    ).resolves.toMatchObject({
      outcome: "advanced",
      data: { assuranceRunId: "assurance-2", verdict: "passed", projectedWorkRevision: 8 },
    });
    expect(decisions).toEqual([
      {
        commandId: "assurance-run-root:assurance:decide",
        assuranceRunId: "assurance-1",
        expectedVersion: 2,
      },
      {
        commandId: "assurance-run-root:assurance:retry:attempt-1:decide",
        assuranceRunId: "assurance-2",
        expectedVersion: 2,
      },
    ]);
    expect(startCount).toBe(2);
  });

  it("snapshot 준비 대기 중 abort하면 verifier와 Assurance run을 시작하지 않는다", async () => {
    let releaseSnapshot!: (value: { readonly snapshot: { readonly hash: string } }) => void;
    let enteredSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve;
    });
    const snapshot = new Promise<{ readonly snapshot: { readonly hash: string } }>((resolve) => {
      releaseSnapshot = resolve;
    });
    const calls: string[] = [];
    const controller = new AbortController();
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        stream: async function* () {
          calls.push("verifier-stream");
          yield {
            executionId: "verifier-should-not-start",
            sequence: 1,
            type: "execution_queued",
            payload: {},
            createdAt: "now",
          };
          yield {
            executionId: "verifier-should-not-start",
            sequence: 2,
            type: "execution_running",
            payload: {},
            createdAt: "now",
          };
        },
        recover: async () => ({ executionId: "verifier-should-not-start", status: "succeeded" }),
        cancel: async () => undefined,
      },
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async () => {
          enteredSnapshot();
          return await snapshot;
        },
        start: async () => {
          calls.push("assurance-start");
          return { run: { assuranceRunId: "assurance-should-not-start", status: "blocked", version: 1 } };
        },
      },
      checks: {},
    } as never);

    const executing = stage.execute(context, { ...input, request: {}, signal: controller.signal });
    await snapshotEntered;
    controller.abort();
    releaseSnapshot({ snapshot: { hash: "a".repeat(64) } });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(calls).toEqual([]);
  });

  it("verifier와 Assurance run이 생성된 뒤 abort하면 둘을 취소하고 cancelled로 끝낸다", async () => {
    let releaseStart!: (value: {
      readonly run: { readonly assuranceRunId: string; readonly status: string; readonly version: number };
    }) => void;
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const start = new Promise<{
      readonly run: { readonly assuranceRunId: string; readonly status: string; readonly version: number };
    }>((resolve) => {
      releaseStart = resolve;
    });
    const calls: Array<{ readonly kind: string; readonly value?: unknown }> = [];
    const controller = new AbortController();
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        stream: async function* () {
          calls.push({ kind: "verifier-stream" });
          yield {
            executionId: "verifier-1",
            sequence: 1,
            type: "execution_queued",
            payload: {},
            createdAt: "now",
          };
          yield {
            executionId: "verifier-1",
            sequence: 2,
            type: "execution_running",
            payload: {},
            createdAt: "now",
          };
          yield {
            executionId: "verifier-1",
            sequence: 3,
            type: "execution_succeeded",
            payload: {},
            createdAt: "now",
          };
        },
        recover: async () => ({ executionId: "verifier-1", status: "succeeded" }),
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          calls.push({ kind: "verifier-cancel", value: { executionId, reason } });
        },
      },
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async () => ({ snapshot: { hash: "a".repeat(64) } }),
        start: async () => {
          calls.push({ kind: "assurance-start" });
          enteredStart();
          return await start;
        },
        transition: async () => ({ run: { assuranceRunId: "assurance-1", status: "running", version: 2 } }),
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        findByStartCommand: async () => {
          calls.push({ kind: "assurance-find" });
          return { assuranceRunId: "assurance-1", status: "planned", version: 1 };
        },
        decide: async (_context: unknown, value: unknown) => {
          calls.push({ kind: "assurance-decide", value });
          return { run: { assuranceRunId: "assurance-1", status: "cancelled", version: 2 } };
        },
        projectVerdict: async () => ({ work: { revision: 8 } }),
      },
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);

    const executing = stage.execute(context, { ...input, request: {}, signal: controller.signal });
    await startEntered;
    controller.abort();
    releaseStart({ run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(calls).toEqual([
      { kind: "verifier-stream" },
      { kind: "assurance-start" },
      {
        kind: "verifier-cancel",
        value: { executionId: "verifier-1", reason: "Application run cancelled" },
      },
      { kind: "assurance-find" },
      {
        kind: "assurance-decide",
        value: {
          commandId: "assurance-run-root:assurance:cancel:decide",
          assuranceRunId: "assurance-1",
          expectedVersion: 1,
          cancellationRequested: true,
        },
      },
    ]);
  });

  it("중단된 subscription verifier는 원장을 함께 취소한 뒤 명시 차단한다", async () => {
    const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          calls.push({ kind: "verifier-cancel", value: { executionId, reason } });
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-suspended",
        getRecovery: async () => ({ execution: { status: "suspended" } }),
      },
      assurance: {
        findByStartCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "run-find", value: commandId });
          return { assuranceRunId: "assurance-1", status: "running", version: 2 };
        },
        decide: async (_context: unknown, value: unknown) => {
          calls.push({ kind: "run-cancel", value });
          return { run: { assuranceRunId: "assurance-1", status: "cancelled", version: 3 } };
        },
        prepareSnapshot: async () => {
          throw new Error("중단 verifier에는 새 snapshot을 만들면 안 됩니다");
        },
      },
      checks: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
      outcome: "blocked",
      reason: "assurance-verifier-suspended",
    });
    expect(calls).toEqual([
      {
        kind: "verifier-cancel",
        value: { executionId: "verifier-suspended", reason: "Assurance verifier suspended requires explicit retry" },
      },
      { kind: "run-find", value: "assurance-run-root:assurance:start" },
      {
        kind: "run-cancel",
        value: {
          commandId: "assurance-run-root:assurance:suspended:decide",
          assuranceRunId: "assurance-1",
          expectedVersion: 2,
          cancellationRequested: true,
        },
      },
    ]);
  });

  it("재시작으로 중단된 verifier는 이전 원장을 취소하고 새 시도를 허용한다", async () => {
    const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: {
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          calls.push({ kind: "verifier-cancel", value: { executionId, reason } });
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async () => "verifier-interrupted",
        getRecovery: async () => ({ execution: { status: "interrupted" } }),
      },
      assurance: {
        findByStartCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "run-find", value: commandId });
          return { assuranceRunId: "assurance-1", status: "running", version: 2 };
        },
        decide: async (_context: unknown, value: unknown) => {
          calls.push({ kind: "run-cancel", value });
          return { run: { assuranceRunId: "assurance-1", status: "cancelled", version: 3 } };
        },
        prepareSnapshot: async () => {
          throw new Error("중단 verifier에는 새 snapshot을 만들면 안 됩니다");
        },
      },
      checks: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: {} })).resolves.toEqual({
      outcome: "blocked",
      reason: "assurance-verifier-interrupted",
    });
    expect(calls).toEqual([
      {
        kind: "verifier-cancel",
        value: {
          executionId: "verifier-interrupted",
          reason: "Assurance verifier interrupted requires explicit retry",
        },
      },
      { kind: "run-find", value: "assurance-run-root:assurance:start" },
      {
        kind: "run-cancel",
        value: {
          commandId: "assurance-run-root:assurance:interrupted:decide",
          assuranceRunId: "assurance-1",
          expectedVersion: 2,
          cancellationRequested: true,
        },
      },
    ]);
  });

  it("작업 취소는 verifier와 진행 중인 Assurance run을 함께 취소한다", async () => {
    const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
    const stage = new CoreAssuranceStage({
      works: {},
      bindings: {},
      runner: {
        cancel: async (_context: unknown, executionId: string, reason: string) => {
          calls.push({ kind: "verifier-cancel", value: { executionId, reason } });
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "verifier-find", value: commandId });
          return "verifier-1";
        },
      },
      assurance: {
        findByStartCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "run-find", value: commandId });
          return { assuranceRunId: "assurance-1", status: "running", version: 2 };
        },
        decide: async (_context: unknown, value: unknown) => {
          calls.push({ kind: "run-cancel", value });
          return { run: { assuranceRunId: "assurance-1", status: "cancelled", version: 3 } };
        },
      },
      checks: {},
    } as never);

    await expect(
      stage.cancel(context, {
        ...input,
        commandId: "assurance-run-root:assurance:cancel",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      { kind: "verifier-find", value: "assurance-run-root:assurance:verifier" },
      {
        kind: "verifier-cancel",
        value: { executionId: "verifier-1", reason: "Application run cancelled" },
      },
      { kind: "run-find", value: "assurance-run-root:assurance:start" },
      {
        kind: "run-cancel",
        value: {
          commandId: "assurance-run-root:assurance:cancel:decide",
          assuranceRunId: "assurance-1",
          expectedVersion: 2,
          cancellationRequested: true,
        },
      },
    ]);
  });

  it("verifier 취소가 실패하면 Assurance run을 cancelled로 결정하지 않는다", async () => {
    const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
    const stage = new CoreAssuranceStage({
      works: {},
      bindings: {},
      runner: {
        cancel: async (_context: unknown, executionId: string) => {
          calls.push({ kind: "verifier-cancel", value: executionId });
          throw new Error("verifier cancellation failed");
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "verifier-find", value: commandId });
          return "verifier-1";
        },
      },
      assurance: {
        findByStartCommand: async (_context: unknown, commandId: string) => {
          calls.push({ kind: "run-find", value: commandId });
          return { assuranceRunId: "assurance-1", status: "running", version: 2 };
        },
        decide: async (_context: unknown, value: unknown) => {
          calls.push({ kind: "run-cancel", value });
          return { run: { assuranceRunId: "assurance-1", status: "cancelled", version: 3 } };
        },
      },
      checks: {},
    } as never);

    await expect(stage.cancel(context, { ...input, commandId: "assurance-run-root:assurance:cancel" })).rejects.toThrow(
      "verifier cancellation failed",
    );
    expect(calls).toEqual([
      { kind: "verifier-find", value: "assurance-run-root:assurance:verifier" },
      { kind: "verifier-cancel", value: "verifier-1" },
    ]);
  });

  it("binding proposal 중 취소되면 binding 활성화를 시작하지 않는다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1", content_json: JSON.stringify(automaticEvidencePlan) }),
        recoverWork: async () => ({
          artifacts: [],
          tasks: [
            {
              task_id: "task-1",
              status: "completed",
              acceptance_criteria_json: JSON.stringify(automaticEvidencePlan.acceptanceCriteria),
            },
          ],
        }),
      },
      bindings: {
        getActive: async () => undefined,
        propose: async () => {
          calls.push("propose");
          controller.abort();
          return {
            bindingVersionId: "binding-1",
            revision: 1,
            profileId: "massion.assurance.acceptance.v1",
            profileVersion: "1.0.0",
          };
        },
        activate: async () => {
          calls.push("activate");
          return {
            bindingVersionId: "binding-1",
            revision: 2,
            profileId: "massion.assurance.acceptance.v1",
            profileVersion: "1.0.0",
          };
        },
      },
      runner: {},
      runtimeExecutions: {},
      assurance: {},
      checks: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: {}, signal: controller.signal })).rejects.toThrow(
      "Application run cancelled",
    );
    expect(calls).toEqual(["propose"]);
  });

  it("verdict 결정 중 취소되면 Work projection을 시작하지 않는다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const stage = new CoreAssuranceStage({
      works: {
        getWork: async () => ({ revision: 7 }),
        getActivePlan: async () => ({ plan_version_id: "plan-1" }),
        recoverWork: async () => ({ artifacts: [] }),
      },
      bindings: {
        getActive: async () => ({
          bindingVersionId: "binding-1",
          profileId: "massion.assurance.acceptance.v1",
          profileVersion: "1.0.0",
        }),
      },
      runner: verifierRunner(calls),
      runtimeExecutions: noStoredVerifier,
      assurance: {
        prepareSnapshot: async () => ({ snapshot: { hash: "a".repeat(64) } }),
        start: async () => ({ run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } }),
        transition: async () => ({ run: { assuranceRunId: "assurance-1", status: "running", version: 2 } }),
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => {
          controller.abort();
          return {
            run: { assuranceRunId: "assurance-1", status: "passed", version: 3, targetWorkRevision: 7 },
          };
        },
        projectVerdict: async () => {
          calls.push("project");
          return { work: { revision: 8 } };
        },
      },
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);

    await expect(stage.execute(context, { ...input, request: {}, signal: controller.signal })).rejects.toThrow(
      "Application run cancelled",
    );
    expect(calls).not.toContain("project");
  });
});
