import { describe, expect, it } from "vitest";

import { CoreDeliveryStage } from "./core-delivery-stage.js";

const context = {
  userId: "delivery-user",
  organizationId: "delivery-org",
  membershipId: "delivery-member",
  role: "owner" as const,
};
const input = {
  runId: "delivery-run-0001",
  workId: "delivery-work-0001",
  commandId: "delivery-run-0001:delivery",
  correlationId: "delivery-correlation-0001",
  request: {},
};

describe("CoreDeliveryStage", () => {
  it("Task가 없으면 비소프트웨어 Work도 Assurance 경로로 진행한다", async () => {
    const transitions: string[] = [];
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision: 1, status: "running" }),
        transition: async (_context: unknown, value: { target: string }) => {
          transitions.push(value.target);
          return { work: { revision: 2, status: value.target } };
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { artifactVersionIds: [] },
    });
    expect(transitions).toEqual(["verifying"]);
  });

  it("신뢰되지 않은 workspace에 바인딩된 Work는 delivery를 차단한다", async () => {
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision: 1, status: "running", workspace_id: "workspace-1" }),
        transition: async () => {
          throw new Error("차단된 delivery는 상태를 전이하면 안 됩니다");
        },
      },
      runner: {},
      runtimeExecutions: {},
      workspaces: { get: async () => ({ workspaceId: "workspace-1", trust: "pending" }) },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "workspace-untrusted",
    });
  });

  it.each([
    ["verifying", "advanced"],
    ["completed", "completed"],
  ] as const)("복구 시 이미 %s인 Work는 신뢰 게이트나 Delivery를 재실행하지 않고 진행한다", async (status, outcome) => {
    let sideEffects = 0;
    const stage = new CoreDeliveryStage({
      works: {
        getWork: async () => ({ revision: 9, status, workspace_id: "workspace-untrusted" }),
        listTasks: async () => {
          sideEffects += 1;
          return [];
        },
      },
      runner: {},
      runtimeExecutions: {},
      workspaces: {
        get: async () => {
          sideEffects += 1;
          return { trust: "pending" };
        },
      },
      software: {
        executeTask: async () => {
          sideEffects += 1;
          return { outcome: "completed" };
        },
        cancelTask: async () => undefined,
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome, workId: input.workId });
    expect(sideEffects).toBe(0);
  });

  it("저장된 failed Delivery를 신뢰·근거 게이트보다 먼저 찾아 원자 실패 수렴 정보로 반환한다", async () => {
    const task = {
      task_id: "task-stored-terminal-failure",
      title: "저장 실패",
      objective: "저장 실패",
      acceptance_criteria_json: "[]",
      status: "running",
      required_capabilities: ["backend-engineering"],
      recommended_agent_handles: ["software-engineering.backend-specialist"],
      revision: 4,
    };
    let gated = 0;
    const stage = new CoreDeliveryStage({
      works: {
        getWork: async () => ({ revision: 11, status: "running", workspace_id: "workspace-untrusted" }),
        listTasks: async () => [task],
      },
      runner: {},
      runtimeExecutions: {},
      workspaces: {
        get: async () => {
          gated += 1;
          return { trust: "pending" };
        },
      },
      software: {
        inspectTask: async () => ({ outcome: "failed", reason: "software-delivery-failed" }),
        executeTask: async () => {
          gated += 1;
          return { outcome: "completed" };
        },
        cancelTask: async () => undefined,
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "failed",
      workId: input.workId,
      failure: { taskId: task.task_id, expectedWorkRevision: 11, expectedTaskRevision: 4 },
    });
    expect(gated).toBe(0);
  });

  it("trusted workspace에 바인딩된 Work는 정상 진행한다", async () => {
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision: 1, status: "running", workspace_id: "workspace-1" }),
        transition: async (_context: unknown, value: { target: string }) => ({
          work: { revision: 2, status: value.target },
        }),
      },
      runner: {},
      runtimeExecutions: {},
      workspaces: { get: async () => ({ workspaceId: "workspace-1", trust: "trusted" }) },
      evidence: { materializeActive: async () => [] },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome: "advanced" });
  });

  it("계획된 Work를 ready와 running으로 전이한 뒤 Task를 실행한다", async () => {
    const transitions: string[] = [];
    let status = "planned";
    let revision = 1;
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision, status }),
        transition: async (_context: unknown, value: { target: string }) => {
          transitions.push(value.target);
          status = value.target;
          revision += 1;
          return { work: { revision, status } };
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome: "advanced" });
    expect(transitions).toEqual(["ready", "running", "verifying"]);
  });

  it("계획된 Work는 의존 관계로 막힌 Task까지 배정한 뒤 ready로 전이한다", async () => {
    const assignedTaskIds: string[] = [];
    let status = "planned";
    let revision = 1;
    let listCalls = 0;
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => {
          listCalls += 1;
          if (listCalls > 1) return [];
          return [
            {
              task_id: "task-first",
              status: "ready",
              recommended_agent_handles: ["delivery-coordination"],
              revision: 1,
            },
            {
              task_id: "task-dependent",
              status: "blocked",
              recommended_agent_handles: ["records-documentation"],
              revision: 1,
            },
          ];
        },
        getWork: async () => ({ revision, status }),
        assignTask: async (_context: unknown, value: { taskId: string }) => {
          assignedTaskIds.push(value.taskId);
          revision += 1;
          return { work: { revision } };
        },
        transition: async (_context: unknown, value: { target: string }) => {
          if (value.target === "ready" && assignedTaskIds.length !== 2) {
            throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
          }
          status = value.target;
          revision += 1;
          return { work: { revision, status } };
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome: "advanced" });
    expect(assignedTaskIds).toEqual(["task-first", "task-dependent"]);
  });

  it("최종 verifier 추천은 Delivery 담당자로 선택하지 않는다", async () => {
    const assignedHandles: string[] = [];
    let status = "planned";
    let revision = 1;
    let listCalls = 0;
    const task = {
      task_id: "task-assurance-recommended",
      status: "ready",
      recommended_agent_handles: ["assurance"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => (++listCalls === 1 ? [task] : []),
        getWork: async () => ({ revision, status }),
        assignTask: async (_context: unknown, value: { agentHandle: string }) => {
          assignedHandles.push(value.agentHandle);
          revision += 1;
          return { work: { revision } };
        },
        transition: async (_context: unknown, value: { target: string }) => {
          status = value.target;
          revision += 1;
          return { work: { revision, status } };
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome: "advanced" });
    expect(assignedHandles).toEqual(["delivery-coordination"]);
  });

  it("승인 대기 Work는 승인 재개 입력 없이 실행하지 않는다", async () => {
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision: 1, status: "waiting_approval" }),
        transition: async () => {
          throw new Error("전이하면 안 됩니다");
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);
    await expect(stage.execute(context, input)).resolves.toEqual({
      outcome: "blocked",
      reason: "approval-resume-required",
    });
  });

  it("설치된 Software Engineering 전문 담당자 Task는 전용 delivery가 없으면 fail-open하지 않는다", async () => {
    const task = {
      task_id: "task-software",
      status: "ready",
      required_capabilities: ["backend-engineering"],
      recommended_agent_handles: ["software-engineering.backend-specialist"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: { listTasks: async () => [task], getWork: async () => ({ revision: 1, status: "running" }) },
      runner: {},
      runtimeExecutions: {},
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "software-delivery-not-configured",
    });
  });

  it("terminal Software Delivery 실패는 실행 중 Task와 Work를 failed로 수렴시킨다", async () => {
    const transitions: unknown[] = [];
    const task = {
      task_id: "task-software-failed",
      title: "실패 수렴",
      objective: "실패 수렴",
      acceptance_criteria_json: "[]",
      status: "running",
      required_capabilities: ["backend-engineering"],
      recommended_agent_handles: ["software-engineering.backend-specialist"],
      revision: 2,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [task],
        getWork: async () => ({ revision: 7, status: "running" }),
        transitionTask: async (_context: unknown, value: unknown) => {
          transitions.push(value);
          return { work: { revision: 8, status: "failed" }, task: { ...task, status: "failed", revision: 3 } };
        },
      },
      runner: {},
      runtimeExecutions: {},
      software: {
        executeTask: async () => ({ outcome: "failed", reason: "software-delivery-failed" }),
        cancelTask: async () => undefined,
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toEqual({
      outcome: "failed",
      reason: "software-delivery-failed",
      workId: input.workId,
      failure: {
        taskId: task.task_id,
        expectedWorkRevision: 7,
        expectedTaskRevision: 2,
        commandId: `${input.runId}:delivery:task:${task.task_id}:failed`,
      },
    });
    expect(transitions).toEqual([]);
    await stage.convergeFailure(
      context,
      {
        outcome: "failed",
        reason: "software-delivery-failed",
        workId: input.workId,
        failure: {
          taskId: task.task_id,
          expectedWorkRevision: 7,
          expectedTaskRevision: 2,
          commandId: `${input.runId}:delivery:task:${task.task_id}:failed`,
        },
      },
      {} as never,
    );
    expect(transitions).toEqual([
      expect.objectContaining({
        workId: input.workId,
        expectedRevision: 7,
        taskId: task.task_id,
        expectedTaskRevision: 2,
        target: "failed",
      }),
    ]);
  });

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("이미 %s인 Work는 Delivery를 재실행하지 않고 terminal 결과를 보존한다", async (status, outcome) => {
    let softwareCalls = 0;
    const stage = new CoreDeliveryStage({
      works: {
        getWork: async () => ({ revision: 8, status }),
        listTasks: async () => {
          throw new Error("terminal Work의 Task를 다시 읽으면 안 됩니다");
        },
      },
      runner: {},
      runtimeExecutions: {},
      software: {
        executeTask: async () => {
          softwareCalls += 1;
          return { outcome: "completed" };
        },
        cancelTask: async () => undefined,
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome, workId: input.workId });
    expect(softwareCalls).toBe(0);
  });

  it("일반 Task는 assign→running→runtime→artifact→completed 순서를 지킨다", async () => {
    const calls: string[] = [];
    const runtimeInputs: unknown[] = [];
    const artifactInputs: unknown[] = [];
    const materializeInputs: unknown[] = [];
    const knowledgeSources = [
      {
        evidenceBriefId: "delivery-brief-1",
        indexVersionId: "delivery-index-1",
        briefChecksum: "a".repeat(64),
        snippets: [{ citation: "src/delivery.ts:1-1", content: "export const delivery = true;" }],
        estimatedTokens: 8,
      },
    ];
    let taskStatus = "ready";
    let workStatus = "running";
    let revision = 1;
    const task = () => ({
      task_id: "task-general",
      title: "분석",
      objective: "분석",
      acceptance_criteria_json: "[]",
      status: taskStatus,
      required_capabilities: [],
      recommended_agent_handles: ["data-analysis"],
      revision,
    });
    const works = {
      listTasks: async () => (taskStatus === "completed" ? [task()] : [task()]),
      getWork: async () => ({ revision, status: workStatus, workspace_id: "workspace-delivery" }),
      transition: async (_context: unknown, value: { target: string }) => {
        calls.push(`work-${value.target}`);
        workStatus = value.target;
        revision += 1;
        return { work: { revision, status: workStatus } };
      },
      assignTask: async () => {
        calls.push("assign");
        revision += 1;
        return { work: { revision } };
      },
      transitionTask: async (_context: unknown, value: { target: string }) => {
        calls.push(value.target);
        taskStatus = value.target;
        revision += 1;
        return { work: { revision }, task: task() };
      },
      createArtifactVersion: async (_context: unknown, value: unknown) => {
        calls.push("artifact");
        artifactInputs.push(value);
        revision += 1;
        return { work: { revision }, artifactVersion: { artifact_version_id: "artifact-version-1" } };
      },
    };
    const stage = new CoreDeliveryStage({
      works,
      runner: {
        execute: async (_context: unknown, runtimeInput: unknown) => {
          calls.push("runtime");
          runtimeInputs.push(runtimeInput);
          return { executionId: "execution-1", status: "succeeded", output: { answer: 42 } };
        },
        recover: async () => {
          throw new Error("not used");
        },
        cancel: async () => undefined,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
      workspaces: { get: async () => ({ trust: "trusted" }) },
      evidence: {
        materializeActive: async (...args: unknown[]) => {
          materializeInputs.push(args);
          return knowledgeSources;
        },
      },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { artifactVersionIds: ["artifact-version-1"] },
    });
    expect(calls).toEqual(["assign", "running", "runtime", "artifact", "completed", "work-verifying"]);
    expect(materializeInputs).toEqual([[context, input.workId, 24_000]]);
    expect(runtimeInputs).toEqual([
      expect.objectContaining({
        estimatedTokens: expect.any(Number),
        input: expect.objectContaining({ operation: "execute_work_task", knowledgeSources }),
      }),
    ]);
    expect((runtimeInputs[0] as { estimatedTokens: number }).estimatedTokens).toBeLessThanOrEqual(32_000);
    expect(artifactInputs).toEqual([
      expect.objectContaining({
        creatorTaskId: "task-general",
        creatorAgentHandle: "data-analysis",
        creatorExecutionId: "execution-1",
      }),
    ]);
  });

  it("검증된 Workspace 근거를 Software Engineering Task port에도 전달한다", async () => {
    const knowledgeSources = [
      {
        evidenceBriefId: "software-brief-verified",
        indexVersionId: "software-index-verified",
        briefChecksum: "b".repeat(64),
        snippets: [{ citation: "src/software.ts:1-1", content: "export const software = true;" }],
        estimatedTokens: 8,
      },
    ];
    const softwareInputs: unknown[] = [];
    let listCalls = 0;
    const task = {
      task_id: "task-software-evidence",
      status: "ready",
      required_capabilities: ["backend-engineering"],
      recommended_agent_handles: ["software-engineering.backend-specialist"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => (++listCalls === 1 ? [task] : []),
        getWork: async () => ({ revision: 1, status: "running", workspace_id: "workspace-software" }),
        transition: async () => ({ work: { revision: 2, status: "verifying" } }),
      },
      runner: {},
      runtimeExecutions: {},
      workspaces: { get: async () => ({ trust: "trusted" }) },
      evidence: { materializeActive: async () => knowledgeSources },
      software: {
        executeTask: async (_context: unknown, softwareInput: unknown) => {
          softwareInputs.push(softwareInput);
          return { outcome: "completed" };
        },
        cancelTask: async () => undefined,
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({ outcome: "advanced" });
    expect(softwareInputs).toEqual([expect.objectContaining({ knowledgeSources })]);
  });

  it("1,000 token Work에서 stage baseline 뒤 근거 여유가 없으면 실행 전에 차단한다", async () => {
    let materializeCalls = 0;
    let runtimeCalls = 0;
    const stage = new CoreDeliveryStage({
      works: {
        getWork: async () => ({ revision: 1, status: "running", workspace_id: "workspace-low-budget" }),
        listTasks: async () => [
          {
            task_id: "task-low-budget",
            title: "저예산 실행",
            objective: "요청 예산 안에서 실행",
            acceptance_criteria_json: "[]",
            status: "ready",
            required_capabilities: [],
            recommended_agent_handles: ["delivery-coordination"],
            revision: 1,
          },
        ],
      },
      workspaces: { get: async () => ({ trust: "trusted" }) },
      evidence: {
        materializeActive: async () => {
          materializeCalls += 1;
          return [];
        },
      },
      runner: {
        execute: async () => {
          runtimeCalls += 1;
          return {};
        },
      },
      runtimeExecutions: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: { tokenBudget: 1_000 } })).resolves.toEqual({
      outcome: "blocked",
      reason: "evidence-invalid",
    });
    expect(materializeCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
  });

  it("Work 조회 중 취소되면 Delivery 상태 변경을 시작하지 않는다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let releaseWork: (value: { readonly revision: number; readonly status: string }) => void = () => undefined;
    const work = new Promise<{ readonly revision: number; readonly status: string }>((resolve) => {
      releaseWork = resolve;
    });
    const stage = new CoreDeliveryStage({
      works: {
        getWork: async () => await work,
        listTasks: async () => {
          calls.push("list-tasks");
          return [];
        },
        transition: async (_context: unknown, value: { target: string }) => {
          calls.push(`work-${value.target}`);
          return { work: { revision: 2, status: value.target } };
        },
      },
      runner: {},
      runtimeExecutions: {},
    } as never);

    const execution = stage.execute(context, { ...input, signal: controller.signal });
    controller.abort();
    releaseWork({ revision: 1, status: "planned" });

    await expect(execution).rejects.toThrow("Application run cancelled");
    expect(calls).toEqual([]);
  });

  it("runtime 조회 뒤 취소되면 Provider 실행을 시작하지 않는다", async () => {
    const controller = new AbortController();
    let executeCalls = 0;
    const task = {
      task_id: "task-runtime-cancel",
      title: "실행",
      objective: "실행",
      acceptance_criteria_json: "[]",
      status: "ready",
      required_capabilities: [],
      recommended_agent_handles: ["delivery-coordination"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [task],
        getWork: async () => ({ revision: 1, status: "running" }),
        assignTask: async () => ({ work: { revision: 2 } }),
        transitionTask: async () => ({ work: { revision: 3 }, task: { ...task, status: "running" } }),
      },
      runner: {
        execute: async () => {
          executeCalls += 1;
          return { executionId: "runtime-cancel-execution", status: "blocked_model_unavailable" };
        },
      },
      runtimeExecutions: {
        findExecutionIdByCommand: async () => {
          controller.abort();
          return undefined;
        },
      },
    } as never);

    await expect(stage.execute(context, { ...input, signal: controller.signal })).rejects.toThrow(
      "Application run cancelled",
    );
    expect(executeCalls).toBe(0);
  });

  it("runtime 완료 뒤 취소되면 artifact와 Task 완료를 기록하지 않는다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const task = {
      task_id: "task-artifact-cancel",
      title: "실행",
      objective: "실행",
      acceptance_criteria_json: "[]",
      status: "running",
      required_capabilities: [],
      recommended_agent_handles: ["delivery-coordination"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [task],
        getWork: async () => ({ revision: 1, status: "running" }),
        createArtifactVersion: async () => {
          calls.push("artifact");
          return { work: { revision: 2 }, artifactVersion: { artifact_version_id: "artifact-cancel" } };
        },
        transitionTask: async () => {
          calls.push("completed");
          return { work: { revision: 3 }, task: { ...task, status: "completed" } };
        },
      },
      runner: {
        execute: async () => {
          controller.abort();
          return { executionId: "artifact-cancel-execution", status: "succeeded", output: { answer: 42 } };
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
    } as never);

    await expect(stage.execute(context, { ...input, signal: controller.signal })).rejects.toThrow(
      "Application run cancelled",
    );
    expect(calls).toEqual([]);
  });

  it("runtime 실행에는 Delivery stage의 취소 신호를 전달한다", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const task = {
      task_id: "task-runtime-signal",
      title: "실행",
      objective: "실행",
      acceptance_criteria_json: "[]",
      status: "running",
      required_capabilities: [],
      recommended_agent_handles: ["delivery-coordination"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [task],
        getWork: async () => ({ revision: 1, status: "running" }),
      },
      runner: {
        execute: async (_context: unknown, value: { readonly signal?: AbortSignal }) => {
          receivedSignal = value.signal;
          return { executionId: "runtime-signal-execution", status: "blocked_model_unavailable" };
        },
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
    } as never);

    await expect(stage.execute(context, { ...input, signal: controller.signal })).resolves.toEqual({
      outcome: "blocked",
      reason: "model-unavailable",
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("ready 상태 Software Engineering 전문 Task도 취소하면 전용 delivery를 정리한다", async () => {
    const cancelled: string[] = [];
    const task = {
      task_id: "task-software-cancel",
      status: "ready",
      required_capabilities: ["backend-engineering"],
      recommended_agent_handles: ["software-engineering.backend-specialist"],
      revision: 1,
    };
    const stage = new CoreDeliveryStage({
      works: { listTasks: async () => [task] },
      runner: {},
      runtimeExecutions: {},
      software: {
        executeTask: async () => ({ outcome: "completed" }),
        cancelTask: async (_context: unknown, value: { readonly commandId: string }) => {
          cancelled.push(value.commandId);
        },
      },
    } as never);

    await stage.cancel(context, { ...input, commandId: `${input.commandId}:cancel` });

    expect(cancelled).toEqual([`${input.commandId}:task:${task.task_id}`]);
  });
});
