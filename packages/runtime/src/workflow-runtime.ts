export interface HandoffTask<T = unknown> {
  readonly id: string;
  readonly dependencies: readonly string[];
  execute(): Promise<T>;
}

export interface HandoffResult<T = unknown> {
  readonly taskId: string;
  readonly output: T;
}

export class ParallelHandoffExecutor {
  public async execute<T>(tasks: readonly HandoffTask<T>[], maxParallel: number): Promise<HandoffResult<T>[]> {
    if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel은 1 이상의 정수여야 합니다");
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) throw new Error("중복 Task ID");
    for (const task of tasks) {
      for (const dependency of task.dependencies) {
        if (!byId.has(dependency)) throw new Error(`존재하지 않는 의존 Task: ${dependency}`);
      }
    }
    this.assertAcyclic(tasks, byId);

    const pending = new Set(tasks.map((task) => task.id));
    const completed = new Set<string>();
    const outputs = new Map<string, T>();
    while (pending.size > 0) {
      const ready = tasks.filter(
        (task) => pending.has(task.id) && task.dependencies.every((dependency) => completed.has(dependency)),
      );
      if (ready.length === 0) throw new Error("실행 가능한 Task가 없습니다");
      for (let index = 0; index < ready.length; index += maxParallel) {
        const batch = ready.slice(index, index + maxParallel);
        const values = await Promise.all(batch.map(async (task) => await task.execute()));
        batch.forEach((task, offset) => {
          const value = values[offset];
          if (value === undefined) throw new Error(`Task 결과가 없습니다: ${task.id}`);
          outputs.set(task.id, value);
          completed.add(task.id);
          pending.delete(task.id);
        });
      }
    }
    return tasks.map((task) => {
      const output = outputs.get(task.id);
      if (output === undefined) throw new Error(`Task 결과를 찾을 수 없습니다: ${task.id}`);
      return { taskId: task.id, output };
    });
  }

  private assertAcyclic<T>(tasks: readonly HandoffTask<T>[], byId: ReadonlyMap<string, HandoffTask<T>>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`순환 의존성: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const task = byId.get(id);
      if (!task) throw new Error(`Task를 찾을 수 없습니다: ${id}`);
      task.dependencies.forEach((dependency) => {
        visit(dependency);
      });
      visiting.delete(id);
      visited.add(id);
    };
    tasks.forEach((task) => {
      visit(task.id);
    });
  }
}

type WorkflowStatus = "completed" | "suspended" | "cancelled" | "error";

export interface WorkflowStreamExecution extends AsyncIterable<unknown> {
  readonly executionId: string;
  readonly status: Promise<WorkflowStatus>;
  readonly result: Promise<unknown>;
  resume(input: unknown): Promise<WorkflowStreamExecution>;
  suspend(reason?: string): void;
  cancel(reason?: string): void;
  watch(callback: (event: unknown) => void | Promise<void>): () => void;
}

export interface WorkflowDefinition {
  readonly id: string;
  stream(input: unknown): WorkflowStreamExecution;
}

export interface StartedWorkflow {
  readonly executionId: string;
  readonly completion: Promise<AgentExecutionResult>;
}

interface ActiveWorkflow {
  stream: WorkflowStreamExecution;
  completion: Promise<AgentExecutionResult>;
}

export class VoltAgentWorkflowRuntime {
  private readonly active = new Map<string, ActiveWorkflow>();

  public constructor(private readonly store: RuntimeExecutionStore) {}

  public async start(
    context: TenantContext,
    input: AgentExecutionInput,
    workflow: WorkflowDefinition,
    workflowInput: unknown,
  ): Promise<StartedWorkflow> {
    const created = await this.store.createExecution(context, input);
    if (created.execution.status !== "queued") {
      throw new Error(`Workflow 시작 command가 이미 처리됐습니다: ${input.commandId}`);
    }
    const running = await this.store.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: { workflowId: workflow.id },
    });
    const stream = workflow.stream(workflowInput);
    const bound = await this.store.bindWorkflow(context, {
      commandId: `${created.execution.execution_id}:workflow:bind`,
      executionId: created.execution.execution_id,
      workflowId: workflow.id,
      workflowExecutionId: stream.executionId,
    });
    const completion = this.consume(context, bound.execution.execution_id, bound.execution.version, stream);
    this.active.set(bound.execution.execution_id, { stream, completion });
    return { executionId: running.execution.execution_id, completion };
  }

  public async suspend(context: TenantContext, executionId: string, reason?: string): Promise<void> {
    const active = this.activeWorkflow(executionId);
    active.stream.suspend(reason);
    const result = await active.completion;
    if (result.status !== "suspended") throw new Error(`Workflow가 suspended 상태가 아닙니다: ${result.status}`);
    await this.store.getRecovery(context, executionId);
  }

  public async resume(context: TenantContext, executionId: string, input: unknown): Promise<AgentExecutionResult> {
    const current = this.activeWorkflow(executionId);
    const snapshot = await this.store.getRecovery(context, executionId);
    if (snapshot.execution.status !== "suspended") throw new Error("suspended Workflow만 resume할 수 있습니다");
    const running = await this.store.transition(context, {
      commandId: `${executionId}:resume:${String(snapshot.execution.version)}`,
      executionId,
      expectedVersion: snapshot.execution.version,
      target: "running",
      payload: { resumed: true },
    });
    const stream = await current.stream.resume(input);
    const completion = this.consume(context, executionId, running.execution.version, stream);
    this.active.set(executionId, { stream, completion });
    return await completion;
  }

  public async cancel(executionId: string, reason?: string): Promise<AgentExecutionResult> {
    const active = this.activeWorkflow(executionId);
    active.stream.cancel(reason);
    return await active.completion;
  }

  private async consume(
    context: TenantContext,
    executionId: string,
    initialVersion: number,
    stream: WorkflowStreamExecution,
  ): Promise<AgentExecutionResult> {
    let version = initialVersion;
    let sequence = 0;
    let writes = Promise.resolve();
    const unsubscribe = stream.watch((raw) => {
      writes = writes.then(async () => {
        const event = this.eventPayload(raw);
        const appended = await this.store.appendEvent(context, {
          commandId: `${executionId}:workflow:event:${String(sequence)}`,
          executionId,
          expectedVersion: version,
          eventType: `workflow_${event.type}`,
          payload: event,
        });
        version = appended.execution.version;
        sequence += 1;
      });
      return writes;
    });
    const status = await stream.status;
    unsubscribe();
    await writes;
    const output = await stream.result;
    const target =
      status === "completed"
        ? "succeeded"
        : status === "suspended"
          ? "suspended"
          : status === "cancelled"
            ? "cancelled"
            : "failed";
    const terminal = await this.store.transition(context, {
      commandId: `${executionId}:workflow:${status}:${String(version)}`,
      executionId,
      expectedVersion: version,
      target,
      payload: status === "completed" ? { output } : { workflowStatus: status },
    });
    if (status !== "suspended") this.active.delete(executionId);
    return { executionId, status: terminal.execution.status, ...(status === "completed" ? { output } : {}) };
  }

  private eventPayload(raw: unknown): Record<string, unknown> & { type: string } {
    if (!raw || typeof raw !== "object") return { type: "event" };
    const record = raw as Record<string, unknown>;
    const safe: Record<string, unknown> & { type: string } = {
      type: typeof record.type === "string" ? record.type.replaceAll("-", "_") : "event",
    };
    for (const key of ["id", "name", "status"] as const) if (record[key] !== undefined) safe[key] = record[key];
    return safe;
  }

  private activeWorkflow(executionId: string): ActiveWorkflow {
    const active = this.active.get(executionId);
    if (!active) throw new Error(`활성 Workflow를 찾을 수 없습니다: ${executionId}`);
    return active;
  }
}
import type { TenantContext } from "@massion/identity";

import type { AgentExecutionInput, AgentExecutionResult } from "./contracts.js";
import { RuntimeExecutionStore } from "./execution-store.js";
