import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EngineeringDeliveryCoordinator,
  EngineeringDeliveryStore,
  EngineeringPathLeaseStore,
  installSoftwareEngineeringTeam,
  type DeliveryPrerequisiteReader,
  type EngineeringCoordinationPort,
} from "./index.js";

describe("Software Engineering delivery coordination", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let deliveryStore: EngineeringDeliveryStore;
  let leaseStore: EngineeringPathLeaseStore;
  let port: EngineeringCoordinationPort;
  let coordinator: EngineeringDeliveryCoordinator;
  let taskStatus: string;
  let assignmentStatus: string;
  let currentRepositoryRevisionId: string;
  let taskTransitionCount: number;

  const workId = "work-1";
  const taskId = "task-1";
  const assignmentId = "assignment-1";
  const repositoryId = "repository-1";
  const repositoryRevisionId = "repository-revision-1";
  const baseRevision = "0123456789abcdef0123456789abcdef01234567";
  const agentHandle = "software-engineering.backend-specialist";

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "coord@example.com", displayName: "Coordinator" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const installed = await installSoftwareEngineeringTeam(graph, context, {
      commandId: "install-software-team",
      expectedVersion: 1,
    });
    taskStatus = "ready";
    assignmentStatus = "assigned";
    currentRepositoryRevisionId = repositoryRevisionId;
    taskTransitionCount = 0;
    const prerequisiteReader: DeliveryPrerequisiteReader = {
      getWork: async () => ({ organizationId: context.organizationId, workId, status: "ready" }),
      getTask: async () => ({ organizationId: context.organizationId, workId, taskId, status: taskStatus }),
      getAssignment: async () => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        assignmentId,
        agentHandle,
        status: assignmentStatus,
      }),
      getRepository: async () => ({ organizationId: context.organizationId, repositoryId, status: "active" }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId,
        repositoryRevisionId,
        providerRevision: baseRevision,
        dirty: false,
      }),
    };
    deliveryStore = await EngineeringDeliveryStore.create(database, organizations, prerequisiteReader);
    leaseStore = await EngineeringPathLeaseStore.create(database, organizations);
    const transitionedCommands = new Set<string>();
    port = {
      getWork: async () => ({
        organizationId: context.organizationId,
        workId,
        status: "ready",
        revision: 5,
      }),
      getTask: async () => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        status: taskStatus,
        revision: 3,
        requiredCapabilities: ["backend-engineering"],
        recommendedAgentHandles: [agentHandle],
      }),
      getAssignment: prerequisiteReader.getAssignment,
      getCurrentIndex: async () => ({
        repositoryId,
        repositoryRevisionId: currentRepositoryRevisionId,
        status: "complete",
        current: true,
      }),
      listOrganizationNodes: async () => installed.nodes,
      transitionTask: async (_context, input) => {
        if (!transitionedCommands.has(input.commandId)) {
          transitionedCommands.add(input.commandId);
          taskTransitionCount += 1;
          taskStatus = "running";
        }
        return { taskId: input.taskId, status: "running" as const, revision: input.expectedTaskRevision + 1 };
      },
    };
    coordinator = new EngineeringDeliveryCoordinator(deliveryStore, leaseStore, port);
  });

  afterEach(async () => database.close());

  function input(commandId = "coordinate-1") {
    return {
      commandId,
      workId,
      expectedWorkRevision: 5,
      taskId,
      expectedTaskRevision: 3,
      assignmentId,
      repositoryId,
      repositoryRevisionId,
      baseRevision,
      agentHandle,
      profileVersion: "1.0.0",
      allowedPaths: ["packages/api"],
      leaseTtlMs: 60_000,
    } as const;
  }

  it("ready Task·assigned Agent·current Evidence를 delivery, lease와 running 전이에 연결한다", async () => {
    const first = await coordinator.start(context, input());
    const repeated = await coordinator.start(context, input());

    expect(first.delivery).toMatchObject({ taskId, assignmentId, status: "preparing" });
    expect(first.lease).toMatchObject({ deliveryId: first.delivery.deliveryId, pathPrefixes: ["packages/api"] });
    expect(first.task).toMatchObject({ taskId, status: "running", revision: 4 });
    expect(repeated.delivery.deliveryId).toBe(first.delivery.deliveryId);
    expect(repeated.lease.leaseId).toBe(first.lease.leaseId);
    expect(taskTransitionCount).toBe(1);
  });

  it("ready Task, 활성 Assignment와 정확한 capability 선행조건을 강제한다", async () => {
    taskStatus = "blocked";
    await expect(coordinator.start(context, input("blocked"))).rejects.toThrow("ready Task");
    taskStatus = "ready";
    assignmentStatus = "released";
    await expect(coordinator.start(context, input("released"))).rejects.toThrow("활성(assigned) Assignment");
    assignmentStatus = "assigned";
    port.getTask = async () => ({
      organizationId: context.organizationId,
      workId,
      taskId,
      status: "ready",
      revision: 3,
      requiredCapabilities: ["missing-capability"],
      recommendedAgentHandles: [],
    });
    await expect(coordinator.start(context, input("capability"))).rejects.toThrow("staffing gap");
  });

  it("입력 RepositoryRevision이 current complete Evidence index와 다르면 시작하지 않는다", async () => {
    currentRepositoryRevisionId = "stale-revision";
    await expect(coordinator.start(context, input("stale"))).rejects.toThrow("current Evidence revision");
    expect(taskTransitionCount).toBe(0);
    expect(await leaseStore.list(context, repositoryId)).toEqual([]);
  });

  it("Task running 전이가 실패하면 lease를 해제하고 delivery를 failed로 보존한다", async () => {
    port.transitionTask = async () => {
      throw new Error("work revision conflict");
    };
    await expect(coordinator.start(context, input("transition-failure"))).rejects.toThrow("work revision conflict");

    const delivery = await deliveryStore.findByStartCommand(context, "transition-failure");
    expect(delivery).toMatchObject({ status: "failed", error: { category: "coordination_failed" } });
    expect(await leaseStore.list(context, repositoryId)).toEqual([
      expect.objectContaining({ deliveryId: delivery?.deliveryId, status: "released" }),
    ]);
    expect(taskTransitionCount).toBe(0);
  });
});
