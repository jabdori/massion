import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type Work } from "./work.js";

describe("Task DAG, Assignment와 Session", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const graphVersion = await graph.bootstrap(context);
    service = await WorkService.create(database, organizations, graph);
    expect(graphVersion.version.version).toBe(1);
  });

  afterEach(async () => database.close());

  async function plannedWork(label = "work"): Promise<Work> {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: label,
      surface: "test",
      organizationVersionId: "org-v1",
    });
    const plan = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: label },
    });
    return (
      await service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: plan.work.revision,
        target: "planned",
      })
    ).work;
  }

  it("cycle 없는 DAG와 모든 Assignment가 있어야 Work를 ready로 전이한다", async () => {
    let work = await plannedWork();
    const first = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "설계",
      objective: "설계",
      acceptanceCriteria: ["승인됨"],
      dependencyIds: [],
    });
    const second = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: first.work.revision,
      title: "구현",
      objective: "구현",
      acceptanceCriteria: ["테스트 통과"],
      dependencyIds: [first.task.task_id],
    });
    work = second.work;

    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: work.work_id,
        expectedRevision: work.revision,
        target: "ready",
      }),
    ).rejects.toThrow("모든 실행 Task의 Assignment");
    const assignedFirst = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      taskId: first.task.task_id,
      agentHandle: "context-strategy",
    });
    const assignedSecond = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: assignedFirst.work.revision,
      taskId: second.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const ready = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: assignedSecond.work.revision,
      target: "ready",
    });

    expect(ready.work.status).toBe("ready");
    expect((await service.listTasks(context, work.work_id)).map((task) => task.status)).toEqual(["ready", "blocked"]);
    const runningTask = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: ready.work.revision,
      taskId: first.task.task_id,
      expectedTaskRevision: 1,
      target: "running",
    });
    const completedTask = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: runningTask.work.revision,
      taskId: first.task.task_id,
      expectedTaskRevision: runningTask.task.revision,
      target: "completed",
    });

    expect(completedTask.unblockedTasks.map((task) => task.task_id)).toEqual([second.task.task_id]);
    expect((await service.listTasks(context, work.work_id)).map((task) => task.status)).toEqual(["completed", "ready"]);
  });

  it("cycle과 다른 Work의 dependency를 거부한다", async () => {
    let firstWork = await plannedWork("first");
    const first = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: firstWork.work_id,
      expectedRevision: firstWork.revision,
      title: "A",
      objective: "A",
      acceptanceCriteria: ["A"],
      dependencyIds: [],
    });
    const second = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: firstWork.work_id,
      expectedRevision: first.work.revision,
      title: "B",
      objective: "B",
      acceptanceCriteria: ["B"],
      dependencyIds: [first.task.task_id],
    });
    firstWork = second.work;

    await expect(
      service.setTaskDependencies(context, {
        commandId: crypto.randomUUID(),
        workId: firstWork.work_id,
        expectedRevision: firstWork.revision,
        taskId: first.task.task_id,
        dependencyIds: [second.task.task_id],
      }),
    ).rejects.toThrow("cycle");
    const other = await plannedWork("other");
    await expect(
      service.addTask(context, {
        commandId: crypto.randomUUID(),
        workId: other.work_id,
        expectedRevision: other.revision,
        title: "Cross",
        objective: "Cross",
        acceptanceCriteria: ["Cross"],
        dependencyIds: [first.task.task_id],
      }),
    ).rejects.toThrow("같은 Work");
  });

  it("재배정 계보를 보존하고 Agent Session과 checkpoint를 Work별로 격리한다", async () => {
    const work = await plannedWork();
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: work.revision,
      title: "실행",
      objective: "실행",
      acceptanceCriteria: ["완료"],
      dependencyIds: [],
    });
    const first = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const reassigned = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: first.work.revision,
      taskId: task.task.task_id,
      agentHandle: "assurance",
    });

    expect(reassigned.assignment.supersedes_assignment_id).toBe(first.assignment.assignment_id);
    expect((await service.listAssignments(context, work.work_id)).map((assignment) => assignment.status)).toEqual([
      "released",
      "assigned",
    ]);
    const session = await service.openSession(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: reassigned.work.revision,
      agentHandle: "assurance",
    });
    const checkpoint = await service.saveCheckpoint(context, {
      commandId: crypto.randomUUID(),
      workId: work.work_id,
      expectedRevision: session.work.revision,
      sessionId: session.session.session_id,
      expectedSessionRevision: 1,
      data: { cursor: 10 },
    });

    expect(checkpoint.checkpoint.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.session.revision).toBe(2);
  });
});
