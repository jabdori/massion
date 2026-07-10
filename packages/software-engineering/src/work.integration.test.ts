import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  EngineeringDeliveryStore,
  SoftwareDeliveryFinalizer,
  WorkServiceDeliveryPort,
  installSoftwareEngineeringTeam,
  type DeliveryPrerequisiteReader,
  type WorkDeliveryPort,
} from "./index.js";

describe("Committed delivery의 Work Artifact 통합", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let work: WorkService;
  let deliveries: EngineeringDeliveryStore;
  let port: WorkServiceDeliveryPort;
  let deliveryId: string;
  let workId: string;
  let taskId: string;
  let expectedWorkRevision: number;
  let expectedTaskRevision: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "finalize@example.com", displayName: "Finalize" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const installed = await installSoftwareEngineeringTeam(graph, context, {
      commandId: "install-team",
      expectedVersion: 1,
    });
    work = await WorkService.create(database, organizations, graph);
    const created = await work.createWork(context, {
      commandId: "create-work",
      text: "코드 변경",
      surface: "test",
      organizationVersionId: installed.version.version_id,
    });
    const planned = await work.addPlan(context, {
      commandId: "add-plan",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "코드 변경" },
    });
    const plannedState = await work.transition(context, {
      commandId: "work-planned",
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      target: "planned",
    });
    const task = await work.addTask(context, {
      commandId: "add-task",
      workId: created.work.work_id,
      expectedRevision: plannedState.work.revision,
      title: "구현",
      objective: "테스트 우선 구현",
      acceptanceCriteria: ["GREEN"],
      dependencyIds: [],
    });
    const assigned = await work.assignTask(context, {
      commandId: "assign-task",
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "software-engineering.backend-specialist",
    });
    const ready = await work.transition(context, {
      commandId: "work-ready",
      workId: created.work.work_id,
      expectedRevision: assigned.work.revision,
      target: "ready",
    });
    const running = await work.transition(context, {
      commandId: "work-running",
      workId: created.work.work_id,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    const runningTask = await work.transitionTask(context, {
      commandId: "task-running",
      workId: created.work.work_id,
      expectedRevision: running.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: task.task.revision,
      target: "running",
    });
    workId = created.work.work_id;
    taskId = task.task.task_id;
    expectedWorkRevision = runningTask.work.revision;
    expectedTaskRevision = runningTask.task.revision;

    const prerequisites: DeliveryPrerequisiteReader = {
      getWork: async () => ({ organizationId: context.organizationId, workId, status: "running" }),
      getTask: async () => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        status: "running",
      }),
      getAssignment: async () => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        assignmentId: assigned.assignment.assignment_id,
        agentHandle: assigned.assignment.agent_handle,
        status: "assigned",
      }),
      getRepository: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        status: "active",
      }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        repositoryRevisionId: "repository-revision-1",
        providerRevision: "a".repeat(40),
        dirty: false,
      }),
    };
    deliveries = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
    let delivery = (
      await deliveries.start(context, {
        commandId: "delivery-start",
        workId,
        taskId,
        assignmentId: assigned.assignment.assignment_id,
        repositoryId: "repository-1",
        repositoryRevisionId: "repository-revision-1",
        baseRevision: "a".repeat(40),
        agentHandle: assigned.assignment.agent_handle,
        profileVersion: "1.0.0",
      })
    ).delivery;
    for (const [target, extra] of [
      ["test_applied", { testPatchHash: "1".repeat(64) }],
      ["red_verified", { redEvidenceId: "red-evidence" }],
      ["implementation_applied", { implementationPatchHash: "2".repeat(64) }],
      ["green_verified", { greenEvidenceId: "green-evidence" }],
      [
        "committed",
        {
          branchRef: "refs/heads/massion/delivery",
          commitSha: "b".repeat(40),
          changeSetHash: "3".repeat(64),
          validationEvidenceIds: ["validation-evidence"],
        },
      ],
    ] as const) {
      delivery = (
        await deliveries.transition(context, {
          commandId: `delivery-${target}`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target,
          ...extra,
        })
      ).delivery;
    }
    deliveryId = delivery.deliveryId;
    await deliveries.recordFileChanges(context, deliveryId, [
      {
        relativePath: "src/value.ts",
        kind: "modified",
        beforeHash: "c".repeat(40),
        afterHash: "d".repeat(40),
        testFile: false,
      },
      {
        relativePath: "src/value.test.ts",
        kind: "modified",
        beforeHash: "e".repeat(40),
        afterHash: "f".repeat(40),
        testFile: true,
      },
    ]);
    port = new WorkServiceDeliveryPort(work);
  });

  afterEach(async () => database.close());

  function input() {
    return {
      commandId: "finalize-delivery",
      deliveryId,
      expectedWorkRevision,
      expectedTaskRevision,
      environment: "local",
    } as const;
  }

  it("patch 본문 없는 code-change manifest를 연결하고 Task 완료 뒤 Work를 verifying에 둔다", async () => {
    const gate = { authorize: vi.fn().mockResolvedValue({ outcome: "allow" }) };
    const finalizer = new SoftwareDeliveryFinalizer(deliveries, port, gate);
    const first = await finalizer.finalize(context, input());
    const repeated = await finalizer.finalize(context, input());

    expect(repeated.artifactVersion.artifactVersionId).toBe(first.artifactVersion.artifactVersionId);
    expect(first.work).toMatchObject({ status: "verifying" });
    expect(first.task).toMatchObject({ status: "completed" });
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "committed",
      artifactVersionId: first.artifactVersion.artifactVersionId,
    });
    const manifest = JSON.parse(first.artifactVersion.contentJson) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: "massion.code-change-manifest.v1",
      deliveryId,
      branchRef: "refs/heads/massion/delivery",
      commitSha: "b".repeat(40),
      changeSetHash: "3".repeat(64),
    });
    expect(JSON.stringify(manifest)).not.toMatch(/testPatch|implementationPatch|patchBody|outputExcerpt/u);
    const [artifacts] = await database.query<[unknown[]]>(
      "SELECT * FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: workId },
    );
    expect(artifacts).toHaveLength(1);
    expect(gate.authorize).toHaveBeenCalled();
  });

  it.each(["artifact", "task"] as const)("%s 저장 직후 crash를 같은 command로 복구한다", async (fault) => {
    let injected = false;
    const faulting: WorkDeliveryPort = {
      getWork: port.getWork.bind(port),
      listTasks: port.listTasks.bind(port),
      transitionWork: port.transitionWork.bind(port),
      createArtifactVersion: async (...args) => {
        const result = await port.createArtifactVersion(...args);
        if (fault === "artifact" && !injected) {
          injected = true;
          throw new Error("injected artifact crash");
        }
        return result;
      },
      transitionTask: async (...args) => {
        const result = await port.transitionTask(...args);
        if (fault === "task" && !injected) {
          injected = true;
          throw new Error("injected task crash");
        }
        return result;
      },
    };
    const gate = { authorize: vi.fn().mockResolvedValue({ outcome: "allow" }) };
    await expect(new SoftwareDeliveryFinalizer(deliveries, faulting, gate).finalize(context, input())).rejects.toThrow(
      "injected",
    );
    const recovered = await new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, input());
    expect(recovered.work.status).toBe("verifying");
    const [artifacts] = await database.query<[unknown[]]>(
      "SELECT * FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: workId },
    );
    expect(artifacts).toHaveLength(1);
    expect((await work.listTasks(context, workId)).filter((task) => task.status === "completed")).toHaveLength(1);
  });
});
