import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RuntimeExecutionStore } from "./execution-store.js";
import { RuntimeRecovery } from "./recovery.js";

describe("Runtime 재시작 복구", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RuntimeExecutionStore.create(database, organizations);
  });

  async function running(workflowExecutionId?: string) {
    const created = await store.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "representative",
      modelRoute: "balanced",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 10,
      estimatedCostMicros: 10,
      input: "recover",
    });
    let state = await store.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: {},
    });
    if (workflowExecutionId) {
      state = await store.bindWorkflow(context, {
        commandId: crypto.randomUUID(),
        executionId: state.execution.execution_id,
        workflowId: "delivery",
        workflowExecutionId,
      });
    }
    return state.execution.execution_id;
  }

  it("checkpoint가 없는 running 실행은 interrupted로 분류한다", async () => {
    const executionId = await running();
    const recovery = new RuntimeRecovery(store, { getWorkflowState: async () => null });

    const result = await recovery.recover(context, executionId);

    expect(result.status).toBe("interrupted");
    expect((await store.getRecovery(context, executionId)).events.at(-1)?.event_type).toBe("execution_interrupted");
  });

  it("VoltAgent suspended checkpoint를 Massion suspended 상태로 투영한다", async () => {
    const executionId = await running("wf-run-1");
    const recovery = new RuntimeRecovery(store, {
      getWorkflowState: async () => ({
        id: "wf-run-1",
        workflowId: "delivery",
        status: "suspended",
        output: undefined,
      }),
    });

    const result = await recovery.recover(context, executionId);

    expect(result.status).toBe("suspended");
  });

  it("완료된 VoltAgent 결과를 terminal 상태로 한 번만 재투영한다", async () => {
    const executionId = await running("wf-run-2");
    const recovery = new RuntimeRecovery(store, {
      getWorkflowState: async () => ({
        id: "wf-run-2",
        workflowId: "delivery",
        status: "completed",
        output: { answer: 42 },
      }),
    });

    const first = await recovery.recover(context, executionId);
    const repeated = await recovery.recover(context, executionId);

    expect(first).toMatchObject({ status: "succeeded", output: { answer: 42 } });
    expect(repeated).toEqual(first);
    expect(
      (await store.getRecovery(context, executionId)).events.filter(
        (event) => event.event_type === "execution_succeeded",
      ),
    ).toHaveLength(1);
  });
});
