import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import type { Work, WorkCommandResult } from "@massion/work";
import { describe, expect, it } from "vitest";

import { CoreDeliveryStage } from "./core-delivery-stage.js";
import type { DynamicStaffingCoordinator } from "./core-staffing.js";

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

function workView(status: Work["status"], revision: number): Work {
  return {
    work_id: input.workId,
    organization_id: context.organizationId,
    request_id: "delivery-request-0001",
    status,
    revision,
    organization_version_id: "delivery-organization-version-0001",
    artifact_version_ids: [],
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
  };
}

function transitionResult(status: Work["status"], revision: number): WorkCommandResult {
  return {
    work: workView(status, revision),
    event: {
      event_id: `delivery-event-${String(revision)}`,
      organization_id: context.organizationId,
      work_id: input.workId,
      sequence: revision,
      command_id: `delivery-command-${String(revision)}`,
      event_type: "work_transitioned",
      actor_user_id: context.userId,
      request_json: "{}",
      payload_json: "{}",
      result_json: "{}",
      created_at: "2026-07-31T00:00:00.000Z",
    },
  };
}

async function unexpectedCall(): Promise<never> {
  throw new Error("호출되면 안 되는 테스트 경로입니다");
}

const unexpectedRunner = {
  execute: unexpectedCall,
  recover: unexpectedCall,
  cancel: unexpectedCall,
} satisfies Pick<AgentRunner, "execute" | "recover" | "cancel">;

const unexpectedRuntimeExecutions = {
  findExecutionIdByCommand: unexpectedCall,
} satisfies Pick<RuntimeExecutionStore, "findExecutionIdByCommand">;

const readyStaffing = {
  prepare: async () => ({ outcome: "ready" as const }),
} satisfies Pick<DynamicStaffingCoordinator, "prepare">;

type DeliveryDependencies = ConstructorParameters<typeof CoreDeliveryStage>[0];

function deliveryStage(
  dependencies: Omit<DeliveryDependencies, "staffing" | "works"> & {
    readonly staffing?: DeliveryDependencies["staffing"];
    readonly works: Omit<DeliveryDependencies["works"], "recoverWork"> &
      Partial<Pick<DeliveryDependencies["works"], "recoverWork">>;
  },
): CoreDeliveryStage {
  const { recoverWork, ...works } = dependencies.works;
  return new CoreDeliveryStage({
    ...dependencies,
    works: {
      ...works,
      recoverWork:
        recoverWork ??
        (async () =>
          ({ request: {}, work: { artifact_version_ids: [] }, messages: [], artifactVersions: [] }) as never),
    },
    staffing: dependencies.staffing ?? readyStaffing,
  });
}

describe("CoreDeliveryStage", () => {
  it("Task가 없으면 비소프트웨어 Work도 Assurance 경로로 진행한다", async () => {
    const transitions: string[] = [];
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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

  it("동적 Staffing 승인 대기는 planned Work와 기존 preassignment를 건드리지 않고 그대로 반환한다", async () => {
    const calls: string[] = [];
    const stage = deliveryStage({
      works: {
        getWork: async () => workView("planned", 7),
        listTasks: async () => {
          calls.push("list-tasks");
          return [];
        },
        listAssignments: unexpectedCall,
        assignTask: async (): Promise<never> => {
          calls.push("assign");
          return await unexpectedCall();
        },
        transition: async (): Promise<never> => {
          calls.push("transition");
          return await unexpectedCall();
        },
        transitionTask: unexpectedCall,
        createArtifactVersion: unexpectedCall,
      },
      staffing: {
        prepare: async (_context: unknown, value: { readonly commandId: string; readonly workId: string }) => {
          calls.push(`staffing:${value.commandId}:${value.workId}`);
          return {
            outcome: "awaiting-approval" as const,
            approvalId: "dynamic-staffing-approval-0001",
            proposalId: "dynamic-staffing-proposal-0001",
          };
        },
      },
      runner: unexpectedRunner,
      runtimeExecutions: unexpectedRuntimeExecutions,
    });

    await expect(stage.execute(context, input)).resolves.toEqual({
      outcome: "awaiting-approval",
      approvalId: "dynamic-staffing-approval-0001",
      proposalId: "dynamic-staffing-proposal-0001",
    });
    expect(calls).toEqual([`staffing:${input.commandId}:staffing:${input.workId}`]);
  });

  it("동적 Staffing ready 뒤 최신 Work를 다시 읽어 기존 preassignment와 실행 흐름을 계속한다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    let revision = 3;
    let status: Work["status"] = "planned";
    let reads = 0;
    const stage = deliveryStage({
      works: {
        getWork: async () => {
          reads += 1;
          calls.push(`read:${String(revision)}`);
          return workView(status, revision);
        },
        listTasks: async () => [],
        listAssignments: unexpectedCall,
        assignTask: unexpectedCall,
        transitionTask: unexpectedCall,
        createArtifactVersion: unexpectedCall,
        transition: async (
          _context: unknown,
          value: { readonly expectedRevision: number; readonly target: Work["status"] },
        ) => {
          calls.push(`${value.target}:${String(value.expectedRevision)}`);
          if (value.expectedRevision !== revision) throw new Error("최신 Work revision을 사용하지 않았습니다");
          revision += 1;
          status = value.target;
          return transitionResult(status, revision);
        },
      },
      staffing: {
        prepare: async (_context: unknown, value: { readonly approvalId?: string; readonly signal?: AbortSignal }) => {
          calls.push(`staffing:${value.approvalId ?? "none"}`);
          receivedSignal = value.signal;
          revision = 9;
          return { outcome: "ready" as const, proposalId: "dynamic-staffing-proposal-0002" };
        },
      },
      runner: unexpectedRunner,
      runtimeExecutions: unexpectedRuntimeExecutions,
    });

    await expect(
      stage.execute(context, {
        ...input,
        resumeInput: { approvalId: "dynamic-staffing-approval-0002" },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ outcome: "advanced" });
    expect(receivedSignal).toBe(controller.signal);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(calls.slice(0, 5)).toEqual([
      "read:3",
      "staffing:dynamic-staffing-approval-0002",
      "read:9",
      "ready:9",
      "running:10",
    ]);
  });

  it("계획된 Work는 의존 관계로 막힌 Task까지 배정한 뒤 ready로 전이한다", async () => {
    const assignedTaskIds: string[] = [];
    let status = "planned";
    let revision = 1;
    let listCalls = 0;
    const stage = deliveryStage({
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
        listAssignments: async () =>
          assignedTaskIds.map((taskId) => ({
            task_id: taskId,
            agent_handle: taskId === "task-first" ? "delivery-coordination" : "records-documentation",
            status: "assigned",
          })),
        getWork: async () => ({ revision, status }),
        assignTask: async (_context: unknown, value: { taskId: string }) => {
          assignedTaskIds.push(value.taskId);
          revision += 1;
          return {
            work: { revision },
            assignment: {
              task_id: value.taskId,
              agent_handle: value.taskId === "task-first" ? "delivery-coordination" : "records-documentation",
              status: "assigned",
            },
          };
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
    const stage = deliveryStage({
      works: {
        listTasks: async () => (++listCalls === 1 ? [task] : []),
        listAssignments: async () => [],
        getWork: async () => ({ revision, status }),
        assignTask: async (_context: unknown, value: { agentHandle: string }) => {
          assignedHandles.push(value.agentHandle);
          revision += 1;
          return {
            work: { revision },
            assignment: {
              task_id: task.task_id,
              agent_handle: value.agentHandle,
              status: "assigned",
            },
          };
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    const stage = deliveryStage({
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
    let assigned = false;
    const task = () => ({
      task_id: "task-general",
      title: "분석",
      objective: "분석",
      acceptance_criteria_json: "[]",
      dependency_ids: ["task-prior"],
      status: taskStatus,
      required_capabilities: [],
      recommended_agent_handles: ["data-analysis"],
      revision,
    });
    const works = {
      listTasks: async () => (taskStatus === "completed" ? [task()] : [task()]),
      listAssignments: async () =>
        assigned ? [{ task_id: "task-general", agent_handle: "data-analysis", status: "assigned" }] : [],
      getWork: async () => ({ revision, status: workStatus, workspace_id: "workspace-delivery" }),
      transition: async (_context: unknown, value: { target: string }) => {
        calls.push(`work-${value.target}`);
        workStatus = value.target;
        revision += 1;
        return { work: { revision, status: workStatus } };
      },
      assignTask: async () => {
        calls.push("assign");
        assigned = true;
        revision += 1;
        return {
          work: { revision },
          assignment: { task_id: "task-general", agent_handle: "data-analysis", status: "assigned" },
        };
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
      recoverWork: async () => ({
        request: {
          text: "A안 1,000명 중 100명과 B안 1,000명 중 130명의 차이를 분석해 주세요.",
          surface: "test",
        },
        work: { artifact_version_ids: ["artifact-prior"] },
        messages: [
          {
            sequence: 1,
            task_id: "task-prior",
            artifact_version_id: "artifact-prior",
          },
        ],
        artifactVersions: [
          {
            artifact_version_id: "artifact-prior",
            content_json: '{"absoluteLift":0.03,"pValue":0.036}',
          },
        ],
      }),
    };
    const stage = deliveryStage({
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
    await expect(stage.execute(context, { ...input, request: {} })).resolves.toMatchObject({
      outcome: "advanced",
      data: { artifactVersionIds: ["artifact-version-1"] },
    });
    expect(calls).toEqual(["assign", "running", "runtime", "artifact", "completed", "work-verifying"]);
    expect(materializeInputs).toEqual([[context, input.workId, 24_000]]);
    expect(runtimeInputs).toEqual([
      expect.objectContaining({
        estimatedTokens: expect.any(Number),
        input: expect.objectContaining({
          operation: "execute_work_task",
          sourceRequest: expect.objectContaining({
            text: "A안 1,000명 중 100명과 B안 1,000명 중 130명의 차이를 분석해 주세요.",
          }),
          dependencyOutputs: [
            {
              taskId: "task-prior",
              artifactVersionId: "artifact-prior",
              content: { absoluteLift: 0.03, pValue: 0.036 },
            },
          ],
          knowledgeSources,
          outputContract: expect.stringContaining("Task output ArtifactVersion으로 자동 저장"),
        }),
      }),
    ]);
    const outputContract = (runtimeInputs[0] as { readonly input: { readonly outputContract: string } }).input
      .outputContract;
    expect(outputContract).toContain("Artifact 생성·제출 도구를 찾거나 호출하지 말고");
    expect(outputContract).toContain("최종 결과 본문만 반환");
    expect((runtimeInputs[0] as { estimatedTokens: number }).estimatedTokens).toBeLessThanOrEqual(32_000);
    expect(artifactInputs).toEqual([
      expect.objectContaining({
        creatorTaskId: "task-general",
        creatorAgentHandle: "data-analysis",
        creatorExecutionId: "execution-1",
      }),
    ]);
  });

  it("동적 Staffing이 만든 활성 Assignment를 덮어쓰지 않고 같은 Agent로 실행·산출한다", async () => {
    let taskStatus = "ready";
    let workStatus = "running";
    let revision = 4;
    const runtimeInputs: Array<{ readonly agentHandle: string }> = [];
    const artifactInputs: Array<{ readonly creatorAgentHandle: string }> = [];
    const task = () => ({
      task_id: "task-dynamic-staffing",
      title: "계량 분석",
      objective: "동적으로 배치된 전문 Agent가 분석한다",
      acceptance_criteria_json: "[]",
      status: taskStatus,
      required_capabilities: ["quant-analysis"],
      recommended_agent_handles: [],
      revision,
    });
    const stage = deliveryStage({
      works: {
        listTasks: async () => [task()],
        listAssignments: async () => [
          {
            assignment_id: "assignment-dynamic-staffing",
            task_id: "task-dynamic-staffing",
            agent_handle: "work-quant-specialist",
            status: "assigned",
          },
        ],
        getWork: async () => ({ revision, status: workStatus }),
        assignTask: async () => {
          throw new Error("동적 Staffing의 활성 Assignment를 덮어쓰면 안 됩니다");
        },
        transitionTask: async (_context: unknown, value: { target: string }) => {
          taskStatus = value.target;
          revision += 1;
          return { work: { revision }, task: task() };
        },
        createArtifactVersion: async (_context: unknown, value: { creatorAgentHandle: string }) => {
          artifactInputs.push(value);
          revision += 1;
          return { work: { revision }, artifactVersion: { artifact_version_id: "artifact-dynamic-staffing" } };
        },
        transition: async (_context: unknown, value: { target: string }) => {
          workStatus = value.target;
          revision += 1;
          return { work: { revision, status: workStatus } };
        },
      },
      runner: {
        execute: async (_context: unknown, value: { agentHandle: string }) => {
          runtimeInputs.push(value);
          return { executionId: "execution-dynamic-staffing", status: "succeeded", output: { result: "done" } };
        },
        recover: async () => {
          throw new Error("not used");
        },
        cancel: async () => undefined,
      },
      runtimeExecutions: { findExecutionIdByCommand: async () => undefined },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { artifactVersionIds: ["artifact-dynamic-staffing"] },
    });
    expect(runtimeInputs).toEqual([expect.objectContaining({ agentHandle: "work-quant-specialist" })]);
    expect(artifactInputs).toEqual([expect.objectContaining({ creatorAgentHandle: "work-quant-specialist" })]);
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
    const stage = deliveryStage({
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

  it("의존 Artifact를 포함한 runtime 입력이 Work 예산을 넘으면 실행 전에 차단한다", async () => {
    let runtimeCalls = 0;
    const stage = deliveryStage({
      works: {
        getWork: async () => ({ revision: 1, status: "running" }),
        listTasks: async () => [
          {
            task_id: "task-low-budget",
            title: "저예산 실행",
            objective: "요청 예산 안에서 실행",
            acceptance_criteria_json: "[]",
            dependency_ids: ["task-prior"],
            status: "ready",
            required_capabilities: [],
            recommended_agent_handles: ["delivery-coordination"],
            revision: 1,
          },
        ],
        recoverWork: async () => ({
          request: { text: "대형 선행 결과를 요약해 주세요." },
          work: { artifact_version_ids: ["artifact-prior"] },
          messages: [{ sequence: 1, task_id: "task-prior", artifact_version_id: "artifact-prior" }],
          artifactVersions: [
            { artifact_version_id: "artifact-prior", content_json: JSON.stringify({ result: "x".repeat(120_000) }) },
          ],
        }),
      },
      runner: {
        execute: async () => {
          runtimeCalls += 1;
          return {};
        },
      },
      runtimeExecutions: {},
    } as never);

    await expect(stage.execute(context, { ...input, request: { tokenBudget: 32_000 } })).resolves.toEqual({
      outcome: "blocked",
      reason: "evidence-invalid",
    });
    expect(runtimeCalls).toBe(0);
  });

  it("Work 조회 중 취소되면 Delivery 상태 변경을 시작하지 않는다", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let releaseWork: (value: { readonly revision: number; readonly status: string }) => void = () => undefined;
    const work = new Promise<{ readonly revision: number; readonly status: string }>((resolve) => {
      releaseWork = resolve;
    });
    const stage = deliveryStage({
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
    const stage = deliveryStage({
      works: {
        listTasks: async () => [task],
        listAssignments: async () => [
          { task_id: task.task_id, agent_handle: "delivery-coordination", status: "assigned" },
        ],
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
    const stage = deliveryStage({
      works: {
        listTasks: async () => [task],
        listAssignments: async () => [
          { task_id: task.task_id, agent_handle: "delivery-coordination", status: "assigned" },
        ],
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
    const stage = deliveryStage({
      works: {
        listTasks: async () => [task],
        listAssignments: async () => [
          { task_id: task.task_id, agent_handle: "delivery-coordination", status: "assigned" },
        ],
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
    const stage = deliveryStage({
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
