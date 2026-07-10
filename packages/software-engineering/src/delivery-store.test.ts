import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EngineeringDeliveryStore,
  type DeliveryPrerequisiteReader,
  type StartEngineeringDeliveryInput,
} from "./index.js";

describe("Software Engineering delivery 저장소", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let organizations: OrganizationService;
  let prerequisites: DeliveryPrerequisiteReader;
  let store: EngineeringDeliveryStore;

  const workId = "work-1";
  const taskId = "task-1";
  const assignmentId = "assignment-1";
  const repositoryId = "repository-1";
  const repositoryRevisionId = "repository-revision-1";
  const baseRevision = "0123456789abcdef0123456789abcdef01234567";

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "engineer@example.com", displayName: "Engineer" });
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    prerequisites = {
      getWork: async () => ({ organizationId: context.organizationId, workId, status: "ready" }),
      getTask: async () => ({ organizationId: context.organizationId, workId, taskId, status: "ready" }),
      getAssignment: async () => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        assignmentId,
        agentHandle: "software-engineering.backend-specialist",
        status: "active",
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
    store = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
  });

  afterEach(async () => database.close());

  function input(commandId = crypto.randomUUID()): StartEngineeringDeliveryInput {
    return {
      commandId,
      workId,
      taskId,
      assignmentId,
      repositoryId,
      repositoryRevisionId,
      baseRevision,
      agentHandle: "software-engineering.backend-specialist",
      profileVersion: "software-engineering-v1",
    };
  }

  it("delivery를 preparing 상태로 만들고 같은 명령은 멱등 재생하며 payload 변경은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.start(context, input(commandId));
    const repeated = await store.start(context, input(commandId));

    expect(first.delivery).toMatchObject({
      organizationId: context.organizationId,
      workId,
      taskId,
      assignmentId,
      repositoryId,
      repositoryRevisionId,
      baseRevision,
      status: "preparing",
      version: 1,
    });
    expect(repeated.delivery.deliveryId).toBe(first.delivery.deliveryId);
    await expect(store.start(context, { ...input(commandId), profileVersion: "changed" })).rejects.toThrow(
      "다른 delivery 명령",
    );
  });

  it("Task·Assignment·Repository revision의 tenant와 소유 계보가 다르면 생성하지 않는다", async () => {
    prerequisites.getTask = async () => ({
      organizationId: otherContext.organizationId,
      workId,
      taskId,
      status: "ready",
    });
    await expect(store.start(context, input())).rejects.toThrow("Task 소유 계보");

    prerequisites.getTask = async () => ({ organizationId: context.organizationId, workId, taskId, status: "ready" });
    prerequisites.getAssignment = async () => ({
      organizationId: context.organizationId,
      workId,
      taskId: "different-task",
      assignmentId,
      agentHandle: "software-engineering.backend-specialist",
      status: "active",
    });
    await expect(store.start(context, input())).rejects.toThrow("Assignment 소유 계보");

    prerequisites.getAssignment = async () => ({
      organizationId: context.organizationId,
      workId,
      taskId,
      assignmentId,
      agentHandle: "software-engineering.backend-specialist",
      status: "active",
    });
    prerequisites.getRepositoryRevision = async () => ({
      organizationId: context.organizationId,
      repositoryId: "different-repository",
      repositoryRevisionId,
      providerRevision: baseRevision,
      dirty: false,
    });
    await expect(store.start(context, input())).rejects.toThrow("RepositoryRevision 소유 계보");
  });

  it("clean base revision과 선택된 active Agent assignment를 강제한다", async () => {
    prerequisites.getRepositoryRevision = async () => ({
      organizationId: context.organizationId,
      repositoryId,
      repositoryRevisionId,
      providerRevision: baseRevision,
      dirty: true,
    });
    await expect(store.start(context, input())).rejects.toThrow("clean revision");

    prerequisites.getRepositoryRevision = async () => ({
      organizationId: context.organizationId,
      repositoryId,
      repositoryRevisionId,
      providerRevision: baseRevision,
      dirty: false,
    });
    prerequisites.getAssignment = async () => ({
      organizationId: context.organizationId,
      workId,
      taskId,
      assignmentId,
      agentHandle: "software-engineering.frontend-specialist",
      status: "active",
    });
    await expect(store.start(context, input())).rejects.toThrow("Agent assignment");
  });

  it("정방향 상태 전이만 허용하고 terminal delivery는 불변으로 유지한다", async () => {
    const started = await store.start(context, input());
    const transitionCommandId = crypto.randomUUID();
    const testApplied = await store.transition(context, {
      commandId: transitionCommandId,
      deliveryId: started.delivery.deliveryId,
      expectedVersion: 1,
      target: "test_applied",
    });
    expect(testApplied.delivery).toMatchObject({ status: "test_applied", version: 2 });
    const repeated = await store.transition(context, {
      commandId: transitionCommandId,
      deliveryId: started.delivery.deliveryId,
      expectedVersion: 1,
      target: "test_applied",
    });
    expect(repeated.delivery).toEqual(testApplied.delivery);
    await expect(
      store.transition(context, {
        commandId: transitionCommandId,
        deliveryId: started.delivery.deliveryId,
        expectedVersion: 2,
        target: "red_verified",
      }),
    ).rejects.toThrow("다른 delivery 명령");
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        deliveryId: started.delivery.deliveryId,
        expectedVersion: 2,
        target: "implementation_applied",
      }),
    ).rejects.toThrow("허용되지 않는 delivery 상태 전이");

    const failed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      deliveryId: started.delivery.deliveryId,
      expectedVersion: 2,
      target: "failed",
      error: { category: "red_marker_mismatch", causeId: "a".repeat(64) },
    });
    expect(failed.delivery).toMatchObject({
      status: "failed",
      version: 3,
      error: { category: "red_marker_mismatch", causeId: "a".repeat(64) },
    });
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        deliveryId: started.delivery.deliveryId,
        expectedVersion: 3,
        target: "cancelled",
      }),
    ).rejects.toThrow("terminal delivery");
  });

  it("낙관적 version, error 계약과 tenant 격리를 강제한다", async () => {
    const started = await store.start(context, input());
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        deliveryId: started.delivery.deliveryId,
        expectedVersion: 9,
        target: "test_applied",
      }),
    ).rejects.toThrow("delivery version 충돌");
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        deliveryId: started.delivery.deliveryId,
        expectedVersion: 1,
        target: "failed",
      }),
    ).rejects.toThrow("실패 error");
    await expect(store.get(otherContext, started.delivery.deliveryId)).rejects.toThrow("Delivery를 찾을 수 없습니다");
  });
});
