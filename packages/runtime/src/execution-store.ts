import { randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { AgentExecutionInput, RuntimeExecutionStatus } from "./contracts.js";
import { RUNTIME_EXECUTION_MIGRATION } from "./schema.js";

export interface RuntimeExecution {
  readonly execution_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id?: string;
  readonly agent_handle: string;
  readonly model_route: string;
  readonly correlation_id: string;
  readonly input_json: string;
  readonly status: RuntimeExecutionStatus;
  readonly version: number;
  readonly event_sequence: number;
  readonly output_json?: string;
  readonly error_json?: string;
  readonly started_at?: unknown;
  readonly ended_at?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface RuntimeEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly execution_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

export interface RuntimeWorkflowBinding {
  readonly binding_id: string;
  readonly organization_id: string;
  readonly execution_id: string;
  readonly workflow_id: string;
  readonly workflow_execution_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface TransitionExecutionInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
  readonly target: RuntimeExecutionStatus;
  readonly payload: unknown;
}

export interface BindWorkflowInput {
  readonly commandId: string;
  readonly executionId: string;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
}

const TRANSITIONS: Readonly<Record<RuntimeExecutionStatus, readonly RuntimeExecutionStatus[]>> = {
  queued: ["running", "blocked_model_unavailable", "cancelled"],
  running: ["suspended", "succeeded", "failed", "cancelled", "interrupted"],
  suspended: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  blocked_model_unavailable: [],
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class RuntimeExecutionStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<RuntimeExecutionStore> {
    await applyMigrations(database, [RUNTIME_EXECUTION_MIGRATION]);
    return new RuntimeExecutionStore(database, organizations);
  }

  public async createExecution(
    context: TenantContext,
    input: AgentExecutionInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.resultFromEvent(tx, context.organizationId, repeated);
      const executionId = randomUUID();
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "CREATE runtime_execution CONTENT { execution_id: $execution_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, model_route: $model_route, correlation_id: $correlation_id, input_json: $input_json, status: 'queued', version: 1, event_sequence: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          execution_id: executionId,
          organization_id: context.organizationId,
          work_id: input.workId,
          task_id: input.taskId,
          agent_handle: input.agentHandle,
          model_route: input.modelRoute,
          correlation_id: input.correlationId,
          input_json: canonicalJson(input.input),
        },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Execution 생성 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        "execution_queued",
        requestJson,
        input.input,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event };
    });
  }

  public async transition(
    context: TenantContext,
    input: TransitionExecutionInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.resultFromEvent(tx, context.organizationId, repeated);
      const current = await this.execution(tx, context.organizationId, input.executionId);
      if (current.version !== input.expectedVersion)
        throw new Error(`현재 Runtime Execution version은 ${String(current.version)}입니다`);
      if (!TRANSITIONS[current.status].includes(input.target))
        throw new Error(`허용되지 않는 Runtime 전이: ${current.status} -> ${input.target}`);
      const nextSequence = current.event_sequence + 1;
      const terminal = ["succeeded", "failed", "cancelled", "interrupted", "blocked_model_unavailable"].includes(
        input.target,
      );
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET status = $status, version += 1, event_sequence = $sequence, started_at = IF $status = 'running' AND started_at = NONE { time::now() } ELSE { started_at }, ended_at = IF $terminal { time::now() } ELSE { ended_at }, output_json = IF $status = 'succeeded' { $payload_json } ELSE { output_json }, error_json = IF $status IN ['failed', 'interrupted', 'blocked_model_unavailable'] { $payload_json } ELSE { error_json }, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        {
          organization_id: context.organizationId,
          execution_id: current.execution_id,
          status: input.target,
          sequence: nextSequence,
          terminal,
          payload_json: canonicalJson(input.payload),
        },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Execution 전이 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        `execution_${input.target}`,
        requestJson,
        input.payload,
      );
      await this.saveResult(tx, event, { execution, event });
      return { execution, event };
    });
  }

  public async bindWorkflow(
    context: TenantContext,
    input: BindWorkflowInput,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent; binding: RuntimeWorkflowBinding }> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const current = await this.execution(tx, context.organizationId, input.executionId);
      const [bindings] = await tx.query<[RuntimeWorkflowBinding[]]>(
        "CREATE runtime_workflow_binding CONTENT { binding_id: $binding_id, organization_id: $organization_id, execution_id: $execution_id, workflow_id: $workflow_id, workflow_execution_id: $workflow_execution_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          binding_id: randomUUID(),
          organization_id: context.organizationId,
          execution_id: current.execution_id,
          workflow_id: input.workflowId,
          workflow_execution_id: input.workflowExecutionId,
        },
      );
      const binding = bindings[0];
      if (!binding) throw new Error("Runtime Workflow binding 생성 결과가 없습니다");
      const [executions] = await tx.query<[RuntimeExecution[]]>(
        "UPDATE runtime_execution SET version += 1, event_sequence += 1, updated_at = time::now() WHERE organization_id = $organization_id AND execution_id = $execution_id RETURN AFTER;",
        { organization_id: context.organizationId, execution_id: current.execution_id },
      );
      const execution = executions[0];
      if (!execution) throw new Error("Runtime Workflow binding 전이 결과가 없습니다");
      const event = await this.insertEvent(
        tx,
        context.organizationId,
        execution,
        input.commandId,
        "workflow_bound",
        requestJson,
        input,
      );
      await this.saveResult(tx, event, { execution, event, binding });
      return { execution, event, binding };
    });
  }

  public async listEvents(context: TenantContext, executionId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    await this.organizations.verifyTenantContext(context);
    const [events] = await this.database.query<[RuntimeEvent[]]>(
      "SELECT * OMIT id FROM runtime_event WHERE organization_id = $organization_id AND execution_id = $execution_id AND sequence > $after_sequence ORDER BY sequence ASC;",
      { organization_id: context.organizationId, execution_id: executionId, after_sequence: afterSequence },
    );
    return events;
  }

  public async getRecovery(
    context: TenantContext,
    executionId: string,
  ): Promise<{
    execution: RuntimeExecution;
    events: RuntimeEvent[];
    binding?: RuntimeWorkflowBinding;
  }> {
    await this.organizations.verifyTenantContext(context);
    const execution = await this.execution(this.database, context.organizationId, executionId);
    const events = await this.listEvents(context, executionId);
    const [bindings] = await this.database.query<[RuntimeWorkflowBinding[]]>(
      "SELECT * OMIT id FROM runtime_workflow_binding WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: context.organizationId, execution_id: executionId },
    );
    return { execution, events, ...(bindings[0] ? { binding: bindings[0] } : {}) };
  }

  private async execution(
    executor: QueryExecutor,
    organizationId: string,
    executionId: string,
  ): Promise<RuntimeExecution> {
    const [executions] = await executor.query<[RuntimeExecution[]]>(
      "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: organizationId, execution_id: executionId },
    );
    if (!executions[0]) throw new Error(`Runtime Execution을 찾을 수 없습니다: ${executionId}`);
    return executions[0];
  }

  private async repeated(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<RuntimeEvent | undefined> {
    const [events] = await executor.query<[RuntimeEvent[]]>(
      "SELECT * OMIT id FROM runtime_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Runtime 요청을 사용할 수 없습니다");
    return events[0];
  }

  private async resultFromEvent(
    executor: QueryExecutor,
    organizationId: string,
    event: RuntimeEvent,
  ): Promise<{ execution: RuntimeExecution; event: RuntimeEvent }> {
    return { execution: await this.execution(executor, organizationId, event.execution_id), event };
  }

  private async insertEvent(
    executor: QueryExecutor,
    organizationId: string,
    execution: RuntimeExecution,
    commandId: string,
    eventType: string,
    requestJson: string,
    payload: unknown,
  ): Promise<RuntimeEvent> {
    const [events] = await executor.query<[RuntimeEvent[]]>(
      "CREATE runtime_event CONTENT { event_id: $event_id, organization_id: $organization_id, execution_id: $execution_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_json: $request_json, payload_json: $payload_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        execution_id: execution.execution_id,
        command_id: commandId,
        sequence: execution.event_sequence,
        event_type: eventType,
        request_json: requestJson,
        payload_json: canonicalJson(payload),
      },
    );
    if (!events[0]) throw new Error("Runtime Event 생성 결과가 없습니다");
    return events[0];
  }

  private async saveResult(executor: QueryExecutor, event: RuntimeEvent, result: unknown): Promise<void> {
    await executor.query("UPDATE runtime_event SET result_json = $result_json WHERE event_id = $event_id;", {
      event_id: event.event_id,
      result_json: JSON.stringify(result),
    });
  }
}
