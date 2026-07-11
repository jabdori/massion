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
        transition: async (_context: unknown, value: any) => {
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

  it("계획된 Work를 ready와 running으로 전이한 뒤 Task를 실행한다", async () => {
    const transitions: string[] = [];
    let status = "planned";
    let revision = 1;
    const stage = new CoreDeliveryStage({
      works: {
        listTasks: async () => [],
        getWork: async () => ({ revision, status }),
        transition: async (_context: unknown, value: any) => {
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

  it("software capability는 전용 delivery가 없으면 fail-open하지 않는다", async () => {
    const task = {
      task_id: "task-software",
      status: "ready",
      required_capabilities: ["software-development"],
      recommended_agent_handles: ["software-development"],
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

  it("일반 Task는 assign→running→runtime→artifact→completed 순서를 지킨다", async () => {
    const calls: string[] = [];
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
      getWork: async () => ({ revision, status: workStatus }),
      transition: async (_context: unknown, value: any) => {
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
      transitionTask: async (_context: unknown, value: any) => {
        calls.push(value.target);
        taskStatus = value.target;
        revision += 1;
        return { work: { revision }, task: task() };
      },
      createArtifactVersion: async () => {
        calls.push("artifact");
        revision += 1;
        return { work: { revision }, artifactVersion: { artifact_version_id: "artifact-version-1" } };
      },
    };
    const stage = new CoreDeliveryStage({
      works,
      runner: {
        execute: async () => {
          calls.push("runtime");
          return { executionId: "execution-1", status: "succeeded", output: { answer: 42 } };
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
      data: { artifactVersionIds: ["artifact-version-1"] },
    });
    expect(calls).toEqual(["assign", "running", "runtime", "artifact", "completed", "work-verifying"]);
  });
});
