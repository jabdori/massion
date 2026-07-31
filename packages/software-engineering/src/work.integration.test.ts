import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService, WORK_ASSURANCE_LINK_MIGRATION } from "@massion/work";

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
  let organizations: OrganizationService;
  let work: WorkService;
  let deliveries: EngineeringDeliveryStore;
  let port: WorkServiceDeliveryPort;
  let deliveryId: string;
  let workId: string;
  let taskId: string;
  let expectedWorkRevision: number;
  let expectedTaskRevision: number;
  let proposalExecutionId: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
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
    const room = await work.openRoom(context, {
      commandId: "open-core-office-room",
      workId: created.work.work_id,
      expectedRevision: runningTask.work.revision,
      title: "Core Office",
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        {
          kind: "agent",
          subjectId: "software-engineering.backend-specialist",
          role: "participant",
        },
      ],
      limits: { maxParallel: 1, maxTokens: 1_000, maxCostMicros: 0, maxRounds: 2 },
    });
    const seededRoom = await work.postMessage(context, {
      commandId: "seed-core-office-room",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "proposal",
      authorKind: "user",
      authorId: context.userId,
      content: "Software Engineering Task를 전달합니다.",
      taskId: task.task.task_id,
      tokenCount: 1,
      costMicros: 0,
    });
    workId = created.work.work_id;
    taskId = task.task.task_id;
    expectedWorkRevision = seededRoom.work.revision;
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
        rootRealPathHash: "a".repeat(64),
      }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        repositoryRevisionId: "repository-revision-1",
        providerRevision: "a".repeat(40),
        dirty: false,
        rootRealPathHash: "a".repeat(64),
      }),
    };
    const executions = await RuntimeExecutionStore.create(database, organizations);
    await applyMigrations(database, [WORK_ASSURANCE_LINK_MIGRATION]);
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
    const proposal = await executions.createExecution(context, {
      commandId: "delivery-proposal",
      workId,
      taskId,
      agentHandle: assigned.assignment.agent_handle,
      modelRoute: "software-engineering-quality",
      correlationId: delivery.deliveryId,
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: {},
    });
    proposalExecutionId = proposal.execution.execution_id;
    const runningProposal = await executions.transition(context, {
      commandId: "delivery-proposal:running",
      executionId: proposal.execution.execution_id,
      expectedVersion: proposal.execution.version,
      target: "running",
      payload: {},
    });
    await executions.transition(context, {
      commandId: "delivery-proposal:succeeded",
      executionId: proposal.execution.execution_id,
      expectedVersion: runningProposal.execution.version,
      target: "succeeded",
      payload: {
        output: {
          testPatch: "test",
          implementationPatch: "implementation",
          focusedCommand: {
            executable: "node",
            args: ["test.js"],
            cwd: ".",
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
            environment: {},
          },
          redFailureMarker: "EXPECTED_RED",
          validationCommands: [],
          commitMessage: "fix: delivery",
        },
      },
    });
    delivery = (
      await deliveries.bindProposalExecution(context, {
        commandId: "delivery-proposal:bind",
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        executionId: proposal.execution.execution_id,
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
          validationEvidenceIds: [],
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
    const [messages] = await database.query<
      [{ task_id?: string; execution_id?: string; artifact_version_id?: string }[]]
    >(
      "SELECT task_id, execution_id, artifact_version_id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id;",
      {
        organization_id: context.organizationId,
        work_id: workId,
        artifact_version_id: first.artifactVersion.artifactVersionId,
      },
    );
    expect(messages).toEqual([
      expect.objectContaining({
        task_id: taskId,
        execution_id: proposalExecutionId,
        artifact_version_id: first.artifactVersion.artifactVersionId,
      }),
    ]);
    expect(gate.authorize).toHaveBeenCalled();
  });

  it.each(["artifact", "task"] as const)("%s 저장 직후 crash를 같은 command로 복구한다", async (fault) => {
    let injected = false;
    const faulting: WorkDeliveryPort = {
      getWork: port.getWork.bind(port),
      findArtifactVersion: port.findArtifactVersion.bind(port),
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

  it.each(["artifact", "task"] as const)(
    "%s 저장 직후 crash를 다른 retry command로 수렴시키고 산출물 계보를 하나만 남긴다",
    async (fault) => {
      let injected = false;
      const faulting: WorkDeliveryPort = {
        getWork: port.getWork.bind(port),
        findArtifactVersion: port.findArtifactVersion.bind(port),
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
      await expect(
        new SoftwareDeliveryFinalizer(deliveries, faulting, gate).finalize(context, {
          ...input(),
          commandId: `finalize-delivery-attempt-1-${fault}`,
        }),
      ).rejects.toThrow("injected");
      const currentWork = await work.getWork(context, workId);
      const currentTask = (await work.listTasks(context, workId)).find((candidate) => candidate.task_id === taskId);
      if (!currentTask) throw new Error("retry 대상 Task를 찾을 수 없습니다");
      const recovered = await new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, {
        ...input(),
        commandId: `finalize-delivery-attempt-2-${fault}`,
        expectedWorkRevision: currentWork.revision,
        expectedTaskRevision: currentTask.revision,
      });

      expect(recovered.work.status).toBe("verifying");
      const [artifacts, messages] = await database.query<
        [unknown[], { artifact_version_id?: string; task_id?: string; execution_id?: string }[]]
      >(
        "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id; SELECT artifact_version_id, task_id, execution_id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id != NONE;",
        { organization_id: context.organizationId, work_id: workId },
      );
      expect(artifacts).toHaveLength(1);
      expect(messages).toEqual([
        expect.objectContaining({
          artifact_version_id: recovered.artifactVersion.artifactVersionId,
          task_id: taskId,
          execution_id: expect.any(String),
        }),
      ]);
    },
  );

  it("실제 승인 Permit 소비 뒤 artifact crash도 다른 retry command에서 하나의 산출물로 수렴한다", async () => {
    await deliveries.recordFileChanges(context, deliveryId, [
      {
        relativePath: "pnpm-lock.yaml",
        kind: "modified",
        beforeHash: "1".repeat(40),
        afterHash: "2".repeat(40),
        testFile: false,
      },
    ]);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const gate = new GovernanceGate(governance, approvals, permits, emergency);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: "finalizer-policy-draft",
      bundle: defaults.bundle,
      requirements: [
        ...defaults.requirements,
        {
          requirementId: "software-delivery-review",
          actions: ["software-delivery.finalize"],
          environments: ["*"],
          riskClasses: ["*"],
          approverRoles: ["owner", "admin"],
          quorum: 1,
          separationOfDuty: false,
          expiresInSeconds: 3_600,
        },
      ],
    });
    await policies.activate(context, {
      commandId: "finalizer-policy-activate",
      policyVersionId: draft.policy_version_id,
    });
    let required: GovernanceApprovalRequiredError | undefined;
    try {
      await new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, {
        ...input(),
        commandId: "finalize-permit-request",
      });
    } catch (error) {
      if (error instanceof GovernanceApprovalRequiredError) required = error;
      else throw error;
    }
    if (!required) throw new Error("Software delivery 승인 요청이 없습니다");
    await approvals.vote(context, {
      commandId: "finalize-permit-approve",
      approvalId: required.approvalId,
      vote: "approve",
      reason: "검증된 코드 전달을 승인합니다",
    });
    let injected = false;
    const faulting: WorkDeliveryPort = {
      getWork: port.getWork.bind(port),
      findArtifactVersion: port.findArtifactVersion.bind(port),
      listTasks: port.listTasks.bind(port),
      transitionTask: port.transitionTask.bind(port),
      transitionWork: port.transitionWork.bind(port),
      createArtifactVersion: async (...args) => {
        const result = await port.createArtifactVersion(...args);
        if (!injected) {
          injected = true;
          throw new Error("post-authorize artifact crash");
        }
        return result;
      },
    };
    await expect(
      new SoftwareDeliveryFinalizer(deliveries, faulting, gate).finalize(context, {
        ...input(),
        commandId: "finalize-permit-attempt-1",
        governanceApprovalId: required.approvalId,
      }),
    ).rejects.toThrow("post-authorize artifact crash");
    const currentWork = await work.getWork(context, workId);
    const currentTask = (await work.listTasks(context, workId)).find((candidate) => candidate.task_id === taskId);
    if (!currentTask) throw new Error("Permit retry 대상 Task를 찾을 수 없습니다");
    const recovered = await new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, {
      ...input(),
      commandId: "finalize-permit-attempt-2",
      expectedWorkRevision: currentWork.revision,
      expectedTaskRevision: currentTask.revision,
      governanceApprovalId: required.approvalId,
    });

    expect(recovered.work.status).toBe("verifying");
    const [artifacts, messages, storedPermits] = await database.query<[unknown[], unknown[], unknown[]]>(
      "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id; SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id != NONE; SELECT * OMIT id FROM governance_execution_permit WHERE organization_id = $organization_id AND approval_id = $approval_id;",
      { organization_id: context.organizationId, work_id: workId, approval_id: required.approvalId },
    );
    expect(artifacts).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(storedPermits).toHaveLength(1);
  });
});
