import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RuntimeExecutionStore } from "./execution-store.js";

describe("Runtime Execution Store", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function createExecution(commandId = crypto.randomUUID()) {
    return await store.createExecution(context, {
      commandId,
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "delivery-coordination",
      modelRoute: "coding-balanced",
      correlationId: "correlation-1",
      input: { objective: "implement" },
    });
  }

  it("queued 생성과 running·suspended·running·succeeded 전이를 단조 event로 원자 기록한다", async () => {
    const created = await createExecution();
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: { worker: "voltagent" },
    });
    const suspended = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 2,
      target: "suspended",
      payload: { reason: "approval" },
    });
    const resumed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 3,
      target: "running",
      payload: { resumed: true },
    });
    const completed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 4,
      target: "succeeded",
      payload: { output: "done" },
    });

    expect([
      created.execution.status,
      running.execution.status,
      suspended.execution.status,
      resumed.execution.status,
    ]).toEqual(["queued", "running", "suspended", "running"]);
    expect(completed.execution.status).toBe("succeeded");
    expect((await store.listEvents(context, created.execution.execution_id)).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("잘못된 상태 전이와 stale version을 거부한다", async () => {
    const created = await createExecution();
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        executionId: created.execution.execution_id,
        expectedVersion: 1,
        target: "succeeded",
        payload: {},
      }),
    ).rejects.toThrow("허용되지 않는 Runtime 전이");
    await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        executionId: created.execution.execution_id,
        expectedVersion: 1,
        target: "cancelled",
        payload: {},
      }),
    ).rejects.toThrow("version");
  });

  it("직접 DB 우회와 같은 version의 동시 전이 중 하나를 거부한다", async () => {
    const direct = await createExecution();
    await expect(
      database.query("UPDATE runtime_execution SET status = 'succeeded' WHERE execution_id = $execution_id;", {
        execution_id: direct.execution.execution_id,
      }),
    ).rejects.toThrow("허용되지 않는 Runtime 전이");
    expect((await store.getRecovery(context, direct.execution.execution_id)).execution.status).toBe("queued");

    const concurrent = await createExecution();
    const results = await Promise.allSettled(
      ["running", "cancelled"].map((target) =>
        store.transition(context, {
          commandId: crypto.randomUUID(),
          executionId: concurrent.execution.execution_id,
          expectedVersion: 1,
          target: target as "running" | "cancelled",
          payload: {},
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("같은 command와 요청은 멱등이고 다른 요청은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await createExecution(commandId);
    const repeated = await createExecution(commandId);
    expect(repeated.execution.execution_id).toBe(first.execution.execution_id);
    await expect(
      store.createExecution(context, {
        commandId,
        workId: "different",
        agentHandle: "representative",
        modelRoute: "planning-quality",
        correlationId: "different",
        input: {},
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("workflow binding과 recovery snapshot을 저장하고 tenant 위조를 거부한다", async () => {
    const created = await createExecution();
    await store.bindWorkflow(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      workflowId: "task-workflow",
      workflowExecutionId: "wf-1",
    });
    const recovered = await store.getRecovery(context, created.execution.execution_id);
    expect(recovered.binding?.workflow_execution_id).toBe("wf-1");
    expect(recovered.events).toHaveLength(2);

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(
      store.getRecovery({ ...otherContext, organizationId: context.organizationId }, created.execution.execution_id),
    ).rejects.toThrow("TenantContext");
  });
});
