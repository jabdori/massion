import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { SurrealApplicationReadModel } from "./read-model.js";
import { CollaborationGraphSnapshotProjector } from "../snapshot.js";

describe("SurrealApplicationReadModel", () => {
  it("실제 공개 domain record를 협업 graph source로 읽고 tenant를 격리한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "read-model@example.com", displayName: "Reader" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    await ApprovalStore.create(database, organizations, governance);
    await ExtensionStore.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "read-model-work-0001",
      text: "실제 read model 검증",
      surface: "test",
      organizationVersionId: core.version.version_id,
    });
    const plan = await works.addPlan(context, {
      commandId: "read-model-plan-0001",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "read model 검증" },
    });
    const task = await works.addTask(context, {
      commandId: "read-model-task-0001",
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      title: "실제 Task",
      objective: "read model을 검증합니다",
      acceptanceCriteria: ["snapshot에 나타납니다"],
      dependencyIds: [],
    });
    const assignment = await works.assignTask(context, {
      commandId: "read-model-assignment-0001",
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "representative",
    });
    const room = await works.openRoom(context, {
      commandId: "read-model-room-0001",
      workId: created.work.work_id,
      expectedRevision: assignment.work.revision,
      title: "실제 협업방",
      coordinatorHandle: "representative",
      participants: [
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        { kind: "user", subjectId: context.userId, role: "participant" },
      ],
      limits: { maxParallel: 2, maxTokens: 10_000, maxCostMicros: 1_000_000, maxRounds: 10 },
    });
    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const execution = await runtime.createExecution(context, {
      commandId: "read-model-execution-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "representative",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "실행" },
    });
    await works.postMessage(context, {
      commandId: "read-model-message-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "status",
      authorKind: "agent",
      authorId: "representative",
      content: "진행 중입니다",
      taskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      tokenCount: 25,
      costMicros: 125,
    });

    const readModel = new SurrealApplicationReadModel(database, organizations);
    const snapshot = await new CollaborationGraphSnapshotProjector(readModel).project(context);
    expect(snapshot.works[0]).toMatchObject({
      workId: created.work.work_id,
      taskIds: [task.task.task_id],
      roomIds: [room.room.room_id],
    });
    expect(snapshot.nodes.find((node) => node.handle === "representative")).toMatchObject({
      currentTaskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      inputTokens: 25,
      costMicros: 125,
    });
    expect(snapshot.rooms[0]).toMatchObject({
      participantIds: expect.arrayContaining([context.userId, "representative"]),
    });

    const other = await identities.registerPersonalUser({
      email: "read-model-other@example.com",
      displayName: "Other",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(readModel.works(otherContext)).resolves.toEqual([]);
  });
});
import { ExtensionStore } from "@massion/extension-host";
import { ApprovalStore, GovernanceService, PolicyStore } from "@massion/governance";
