import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { VoltAgent, createWorkflowChain } from "@voltagent/core";
import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { RuntimeExecutionStore } from "./execution-store.js";
import { ParallelHandoffExecutor, VoltAgentWorkflowRuntime, type WorkflowDefinition } from "./workflow-runtime.js";

describe("병렬 handoff 실행", () => {
  it("DAG 의존 순서를 지키고 독립 작업도 maxParallel을 넘지 않는다", async () => {
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const task = (id: string, dependencies: string[] = []) => ({
      id,
      dependencies,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        completed.push(id);
        return `${id}-result`;
      },
    });
    const executor = new ParallelHandoffExecutor();

    const results = await executor.execute([task("a"), task("b"), task("c", ["a", "b"]), task("d")], 2);

    expect(peak).toBe(2);
    expect(completed.indexOf("c")).toBeGreaterThan(completed.indexOf("a"));
    expect(completed.indexOf("c")).toBeGreaterThan(completed.indexOf("b"));
    expect(results).toEqual([
      { taskId: "a", output: "a-result" },
      { taskId: "b", output: "b-result" },
      { taskId: "c", output: "c-result" },
      { taskId: "d", output: "d-result" },
    ]);
  });

  it("알 수 없는 의존성과 순환 DAG를 실행 전에 거부한다", async () => {
    const executor = new ParallelHandoffExecutor();
    const execute = vi.fn();

    await expect(executor.execute([{ id: "a", dependencies: ["missing"], execute }], 1)).rejects.toThrow(
      "존재하지 않는 의존 Task",
    );
    await expect(
      executor.execute(
        [
          { id: "a", dependencies: ["b"], execute },
          { id: "b", dependencies: ["a"], execute },
        ],
        1,
      ),
    ).rejects.toThrow("순환 의존성");
    expect(execute).not.toHaveBeenCalled();
  });

  it("같은 입력 순서로 결과를 결정론적으로 합성한다", async () => {
    const executor = new ParallelHandoffExecutor();
    const results = await executor.execute(
      [
        { id: "slow", dependencies: [], execute: async () => await delayed("slow", 10) },
        { id: "fast", dependencies: [], execute: async () => await delayed("fast", 1) },
      ],
      2,
    );

    expect(results.map((result) => result.taskId)).toEqual(["slow", "fast"]);
  });
});

describe("실제 VoltAgent Workflow Runtime", () => {
  it("suspend checkpoint를 영속하고 같은 실행을 resume해 완료한다", async () => {
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "workflow@example.com", displayName: "Workflow" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await RuntimeExecutionStore.create(database, organizations);
    const workflow = createWorkflowChain({
      id: `approval-${crypto.randomUUID()}`,
      name: "Approval",
      input: z.object({ value: z.number() }),
      result: z.object({ approved: z.boolean() }),
    })
      .andThen({
        id: "approval",
        resumeSchema: z.object({ approved: z.boolean() }),
        execute: async ({ suspend, resumeData }) => {
          if (!resumeData) await suspend("승인 대기");
          return { approved: resumeData?.approved ?? false };
        },
      })
      .toWorkflow();
    const voltAgent = new VoltAgent({ workflows: { approval: workflow } });
    await voltAgent.ready;
    const runtime = new VoltAgentWorkflowRuntime(store);
    const definition: WorkflowDefinition = {
      id: workflow.id,
      stream: (input) => workflow.stream(input as { value: number }),
    };

    const started = await runtime.start(
      context,
      {
        commandId: crypto.randomUUID(),
        workId: "work-1",
        taskId: "approval",
        agentHandle: "representative",
        modelRoute: "balanced",
        correlationId: crypto.randomUUID(),
        estimatedTokens: 0,
        estimatedCostMicros: 0,
        input: { value: 1 },
      },
      definition,
      { value: 1 },
    );
    const suspended = await started.completion;
    const completed = await runtime.resume(context, started.executionId, { approved: true });

    expect(suspended.status).toBe("suspended");
    expect(completed).toMatchObject({ status: "succeeded", output: { approved: true } });
    const recovery = await store.getRecovery(context, started.executionId);
    expect(recovery.binding?.workflow_execution_id).toBeTruthy();
    expect(recovery.events.filter((event) => event.event_type === "execution_succeeded")).toHaveLength(1);

    await voltAgent.shutdown();
    await database.close();
  });
});

async function delayed(value: string, milliseconds: number): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return value;
}
