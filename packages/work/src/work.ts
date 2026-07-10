import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { type OrganizationGraphService } from "@massion/organization";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { WORK_CORE_MIGRATION, WORK_DELIVERY_MIGRATION } from "./schema.js";

export type WorkStatus =
  | "draft"
  | "planned"
  | "ready"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "completed"
  | "failed"
  | "retrying"
  | "replanning"
  | "cancelled";

export interface WorkRequest {
  readonly request_id: string;
  readonly organization_id: string;
  readonly requester_user_id: string;
  readonly text: string;
  readonly surface: string;
  readonly created_at: unknown;
}

export interface Work {
  readonly work_id: string;
  readonly organization_id: string;
  readonly request_id: string;
  readonly parent_work_id?: string;
  readonly project_id?: string;
  readonly status: WorkStatus;
  readonly revision: number;
  readonly organization_version_id: string;
  readonly context_version_id?: string;
  readonly policy_version_id?: string;
  readonly prompt_version_id?: string;
  readonly artifact_version_ids: readonly string[];
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface WorkEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly caused_by_event_id?: string;
  readonly request_json: string;
  readonly payload_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

export interface PlanVersion {
  readonly plan_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly version: number;
  readonly content_json: string;
  readonly valid: boolean;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface CreateWorkInput {
  readonly commandId: string;
  readonly text: string;
  readonly surface: string;
  readonly organizationVersionId: string;
  readonly projectId?: string;
  readonly contextVersionId?: string;
  readonly policyVersionId?: string;
  readonly promptVersionId?: string;
}

export interface CreateWorkResult {
  readonly request: WorkRequest;
  readonly work: Work;
  readonly event: WorkEvent;
}

export interface WorkCommandInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedRevision: number;
  readonly causedByEventId?: string;
}

export interface TransitionInput extends WorkCommandInput {
  readonly target: WorkStatus;
}

export interface AddPlanInput extends WorkCommandInput {
  readonly content: Record<string, unknown>;
}

export interface WorkCommandResult {
  readonly work: Work;
  readonly event: WorkEvent;
}

export interface AddPlanResult extends WorkCommandResult {
  readonly plan: PlanVersion;
}

export type TaskStatus = "blocked" | "ready" | "running" | "completed" | "failed" | "cancelled";

export interface WorkTask {
  readonly task_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptance_criteria_json: string;
  readonly dependency_ids: readonly string[];
  readonly status: TaskStatus;
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface TaskAssignment {
  readonly assignment_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: "assigned" | "released" | "completed";
  readonly revision: number;
  readonly supersedes_assignment_id?: string;
  readonly created_by: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface WorkSession {
  readonly session_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
  readonly status: "active" | "idle" | "closed" | "archived";
  readonly revision: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface SessionCheckpoint {
  readonly checkpoint_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly session_id: string;
  readonly version: number;
  readonly data_json: string;
  readonly checksum: string;
  readonly created_at: unknown;
}

export interface AddTaskInput extends WorkCommandInput {
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly string[];
}

export interface SetTaskDependenciesInput extends WorkCommandInput {
  readonly taskId: string;
  readonly dependencyIds: readonly string[];
}

export interface TransitionTaskInput extends WorkCommandInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly target: Exclude<TaskStatus, "blocked">;
}

export interface AssignTaskInput extends WorkCommandInput {
  readonly taskId: string;
  readonly agentHandle: string;
}

export interface OpenSessionInput extends WorkCommandInput {
  readonly agentHandle: string;
}

export interface SaveCheckpointInput extends WorkCommandInput {
  readonly sessionId: string;
  readonly expectedSessionRevision: number;
  readonly data: unknown;
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  draft: ["planned", "cancelled"],
  planned: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["waiting_approval", "verifying", "failed", "cancelled"],
  waiting_approval: ["running", "cancelled"],
  verifying: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["retrying", "replanning", "cancelled"],
  retrying: ["running", "cancelled"],
  replanning: ["planned", "cancelled"],
  cancelled: [],
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

async function findWork(executor: QueryExecutor, organizationId: string, workId: string): Promise<Work | undefined> {
  const [works] = await executor.query<[Work[]]>(
    "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: organizationId, work_id: workId },
  );
  return works[0];
}

async function listEventsWith(executor: QueryExecutor, organizationId: string, workId: string): Promise<WorkEvent[]> {
  const [events] = await executor.query<[WorkEvent[]]>(
    "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return events;
}

async function findCommand(
  executor: QueryExecutor,
  organizationId: string,
  commandId: string,
): Promise<WorkEvent | undefined> {
  const [events] = await executor.query<[WorkEvent[]]>(
    "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
    { organization_id: organizationId, command_id: commandId },
  );
  return events[0];
}

async function listTasksWith(executor: QueryExecutor, organizationId: string, workId: string): Promise<WorkTask[]> {
  const [tasks] = await executor.query<[WorkTask[]]>(
    "SELECT * OMIT id FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return tasks;
}

async function listAssignmentsWith(
  executor: QueryExecutor,
  organizationId: string,
  workId: string,
): Promise<TaskAssignment[]> {
  const [assignments] = await executor.query<[TaskAssignment[]]>(
    "SELECT * OMIT id FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
    { organization_id: organizationId, work_id: workId },
  );
  return assignments;
}

function assertAcyclic(tasks: readonly WorkTask[]): void {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const visit = (taskId: string, path: Set<string>, complete: Set<string>): void => {
    if (path.has(taskId)) throw new Error("Task DAG에 cycle이 생깁니다");
    if (complete.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${taskId}`);
    const nextPath = new Set(path).add(taskId);
    for (const dependencyId of task.dependency_ids) visit(dependencyId, nextPath, complete);
    complete.add(taskId);
  };
  const complete = new Set<string>();
  for (const task of tasks) visit(task.task_id, new Set(), complete);
}

export class WorkService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly graph?: OrganizationGraphService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    graph?: OrganizationGraphService,
  ): Promise<WorkService> {
    await applyMigrations(database, [WORK_CORE_MIGRATION, WORK_DELIVERY_MIGRATION]);
    return new WorkService(database, organizations, graph);
  }

  private async verify(context: TenantContext): Promise<void> {
    await this.organizations.verifyTenantContext(context);
  }

  public async createWork(context: TenantContext, input: CreateWorkInput): Promise<CreateWorkResult> {
    await this.verify(context);
    const text = input.text.trim();
    if (!text) throw new Error("Request 원문은 비어 있을 수 없습니다");
    if (!input.organizationVersionId.trim()) throw new Error("OrganizationVersion 참조가 필요합니다");
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) return this.replay(repeated, requestJson) as CreateWorkResult;
      const requestId = randomUUID();
      const workId = randomUUID();
      const [requests] = await transaction.query<[WorkRequest[]]>(
        "CREATE work_request CONTENT { request_id: $request_id, organization_id: $organization_id, requester_user_id: $requester_user_id, text: $text, surface: $surface, created_at: time::now() } RETURN AFTER;",
        {
          request_id: requestId,
          organization_id: context.organizationId,
          requester_user_id: context.userId,
          text,
          surface: input.surface,
        },
      );
      const [works] = await transaction.query<[Work[]]>(
        "CREATE work CONTENT { work_id: $work_id, organization_id: $organization_id, request_id: $request_id, project_id: $project_id, status: 'draft', revision: 1, organization_version_id: $organization_version_id, context_version_id: $context_version_id, policy_version_id: $policy_version_id, prompt_version_id: $prompt_version_id, artifact_version_ids: [], created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          work_id: workId,
          organization_id: context.organizationId,
          request_id: requestId,
          project_id: input.projectId,
          organization_version_id: input.organizationVersionId,
          context_version_id: input.contextVersionId,
          policy_version_id: input.policyVersionId,
          prompt_version_id: input.promptVersionId,
        },
      );
      const request = requests[0];
      const work = works[0];
      if (!request || !work) throw new Error("Request와 Work 생성 결과가 불완전합니다");
      const provisional = { request, work };
      const event = await this.appendEvent(
        transaction,
        context,
        work,
        input.commandId,
        "work_created",
        requestJson,
        { requestId },
        provisional,
      );
      const result = { request, work, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    });
  }

  public async getWork(context: TenantContext, workId: string): Promise<Work> {
    await this.verify(context);
    const work = await findWork(this.database, context.organizationId, workId);
    if (!work) throw new Error(`Work를 찾을 수 없습니다: ${workId}`);
    return work;
  }

  public async listEvents(context: TenantContext, workId: string): Promise<WorkEvent[]> {
    await this.getWork(context, workId);
    return await listEventsWith(this.database, context.organizationId, workId);
  }

  public async addPlan(context: TenantContext, input: AddPlanInput): Promise<AddPlanResult> {
    if (Object.keys(input.content).length === 0) throw new Error("Plan content는 비어 있을 수 없습니다");
    return await this.mutate(context, input, "plan_version_created", async (transaction, work) => {
      const [plans] = await transaction.query<[PlanVersion[]]>(
        "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      const version = plans.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
      const [created] = await transaction.query<[PlanVersion[]]>(
        "CREATE plan_version CONTENT { plan_version_id: $plan_version_id, organization_id: $organization_id, work_id: $work_id, version: $version, content_json: $content_json, valid: true, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
        {
          plan_version_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          version,
          content_json: canonicalJson(input.content),
          created_by: context.userId,
        },
      );
      const plan = created[0];
      if (!plan) throw new Error("PlanVersion 생성 결과가 없습니다");
      return { plan };
    });
  }

  public async addTask(context: TenantContext, input: AddTaskInput): Promise<WorkCommandResult & { task: WorkTask }> {
    if (!input.title.trim() || !input.objective.trim())
      throw new Error("Task title과 objective는 비어 있을 수 없습니다");
    if (input.acceptanceCriteria.length === 0) throw new Error("Task acceptance criteria가 필요합니다");
    return await this.mutate(context, input, "task_created", async (transaction, work) => {
      const existing = await listTasksWith(transaction, context.organizationId, work.work_id);
      for (const dependencyId of input.dependencyIds) {
        if (!existing.some((task) => task.task_id === dependencyId)) {
          throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${dependencyId}`);
        }
      }
      const [records] = await transaction.query<[WorkTask[]]>(
        "CREATE work_task CONTENT { task_id: $task_id, organization_id: $organization_id, work_id: $work_id, title: $title, objective: $objective, acceptance_criteria_json: $acceptance_criteria_json, dependency_ids: $dependency_ids, status: $status, revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          task_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          title: input.title.trim(),
          objective: input.objective.trim(),
          acceptance_criteria_json: canonicalJson(input.acceptanceCriteria),
          dependency_ids: input.dependencyIds,
          status: input.dependencyIds.length === 0 ? "ready" : "blocked",
        },
      );
      const task = records[0];
      if (!task) throw new Error("Task 생성 결과가 없습니다");
      assertAcyclic([...existing, task]);
      return { task };
    });
  }

  public async setTaskDependencies(
    context: TenantContext,
    input: SetTaskDependenciesInput,
  ): Promise<WorkCommandResult & { task: WorkTask }> {
    return await this.mutate(context, input, "task_dependencies_changed", async (transaction, work) => {
      const tasks = await listTasksWith(transaction, context.organizationId, work.work_id);
      const target = tasks.find((task) => task.task_id === input.taskId);
      if (!target) throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
      for (const dependencyId of input.dependencyIds) {
        if (!tasks.some((task) => task.task_id === dependencyId)) {
          throw new Error(`같은 Work의 dependency Task를 찾을 수 없습니다: ${dependencyId}`);
        }
      }
      const planned = tasks.map((task) =>
        task.task_id === input.taskId
          ? {
              ...task,
              dependency_ids: input.dependencyIds,
              status: input.dependencyIds.length === 0 ? ("ready" as const) : ("blocked" as const),
            }
          : task,
      );
      assertAcyclic(planned);
      await transaction.query(
        "UPDATE work_task SET dependency_ids = $dependency_ids, status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
        {
          dependency_ids: input.dependencyIds,
          status: input.dependencyIds.length === 0 ? "ready" : "blocked",
          revision: target.revision + 1,
          organization_id: context.organizationId,
          work_id: work.work_id,
          task_id: input.taskId,
        },
      );
      const updated = (await listTasksWith(transaction, context.organizationId, work.work_id)).find(
        (task) => task.task_id === input.taskId,
      );
      if (!updated) throw new Error("변경된 Task를 찾을 수 없습니다");
      return { task: updated };
    });
  }

  public async assignTask(
    context: TenantContext,
    input: AssignTaskInput,
  ): Promise<WorkCommandResult & { assignment: TaskAssignment }> {
    if (!this.graph) throw new Error("Organization Graph reader가 필요합니다");
    const nodes = await this.graph.listNodes(context);
    if (!nodes.some((node) => node.handle === input.agentHandle && node.status === "active")) {
      throw new Error(`활성 OrganizationNode를 찾을 수 없습니다: ${input.agentHandle}`);
    }
    return await this.mutate(context, input, "task_assigned", async (transaction, work) => {
      const tasks = await listTasksWith(transaction, context.organizationId, work.work_id);
      if (!tasks.some((task) => task.task_id === input.taskId))
        throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
      const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
      const active = assignments.find(
        (assignment) => assignment.task_id === input.taskId && assignment.status === "assigned",
      );
      if (active) {
        await transaction.query(
          "UPDATE task_assignment SET status = 'released', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND assignment_id = $assignment_id;",
          {
            revision: active.revision + 1,
            organization_id: context.organizationId,
            assignment_id: active.assignment_id,
          },
        );
      }
      const [records] = await transaction.query<[TaskAssignment[]]>(
        "CREATE task_assignment CONTENT { assignment_id: $assignment_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, status: 'assigned', revision: 1, supersedes_assignment_id: $supersedes_assignment_id, created_by: $created_by, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          assignment_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          task_id: input.taskId,
          agent_handle: input.agentHandle,
          supersedes_assignment_id: active?.assignment_id,
          created_by: context.userId,
        },
      );
      const assignment = records[0];
      if (!assignment) throw new Error("Assignment 생성 결과가 없습니다");
      return { assignment };
    });
  }

  public async transitionTask(
    context: TenantContext,
    input: TransitionTaskInput,
  ): Promise<WorkCommandResult & { task: WorkTask; unblockedTasks: WorkTask[] }> {
    const allowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
      blocked: ["ready", "cancelled"],
      ready: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled"],
      completed: [],
      failed: ["ready", "cancelled"],
      cancelled: [],
    };
    return await this.mutate(context, input, "task_state_changed", async (transaction, work) => {
      const tasks = await listTasksWith(transaction, context.organizationId, work.work_id);
      const target = tasks.find((task) => task.task_id === input.taskId);
      if (!target) throw new Error(`Task를 찾을 수 없습니다: ${input.taskId}`);
      if (target.revision !== input.expectedTaskRevision) {
        throw new Error(`현재 Task revision은 ${String(target.revision)}입니다`);
      }
      if (!allowed[target.status].includes(input.target)) {
        throw new Error(`허용되지 않은 Task 상태 전이입니다: ${target.status} -> ${input.target}`);
      }
      if (
        input.target === "ready" &&
        target.dependency_ids.some(
          (dependencyId) => tasks.find((task) => task.task_id === dependencyId)?.status !== "completed",
        )
      ) {
        throw new Error("완료되지 않은 dependency Task가 있습니다");
      }
      await transaction.query(
        "UPDATE work_task SET status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
        {
          status: input.target,
          revision: target.revision + 1,
          organization_id: context.organizationId,
          work_id: work.work_id,
          task_id: target.task_id,
        },
      );
      const unblockedTasks: WorkTask[] = [];
      if (input.target === "completed") {
        const completedIds = new Set(
          tasks
            .filter((task) => task.status === "completed" || task.task_id === target.task_id)
            .map((task) => task.task_id),
        );
        for (const candidate of tasks) {
          if (
            candidate.status === "blocked" &&
            candidate.dependency_ids.every((dependencyId) => completedIds.has(dependencyId))
          ) {
            await transaction.query(
              "UPDATE work_task SET status = 'ready', revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
              {
                revision: candidate.revision + 1,
                organization_id: context.organizationId,
                work_id: work.work_id,
                task_id: candidate.task_id,
              },
            );
            unblockedTasks.push({ ...candidate, status: "ready", revision: candidate.revision + 1 });
          }
        }
      }
      return { task: { ...target, status: input.target, revision: target.revision + 1 }, unblockedTasks };
    });
  }

  public async listTasks(context: TenantContext, workId: string): Promise<WorkTask[]> {
    await this.getWork(context, workId);
    return await listTasksWith(this.database, context.organizationId, workId);
  }

  public async listAssignments(context: TenantContext, workId: string): Promise<TaskAssignment[]> {
    await this.getWork(context, workId);
    return await listAssignmentsWith(this.database, context.organizationId, workId);
  }

  public async openSession(
    context: TenantContext,
    input: OpenSessionInput,
  ): Promise<WorkCommandResult & { session: WorkSession }> {
    return await this.mutate(context, input, "session_opened", async (transaction, work) => {
      const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
      if (
        !assignments.some(
          (assignment) => assignment.agent_handle === input.agentHandle && assignment.status === "assigned",
        )
      ) {
        throw new Error("Agent의 활성 Assignment가 필요합니다");
      }
      const [existing] = await transaction.query<[WorkSession[]]>(
        "SELECT * OMIT id FROM work_session WHERE organization_id = $organization_id AND work_id = $work_id AND agent_handle = $agent_handle LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, agent_handle: input.agentHandle },
      );
      if (existing[0]) return { session: existing[0] };
      const [records] = await transaction.query<[WorkSession[]]>(
        "CREATE work_session CONTENT { session_id: $session_id, organization_id: $organization_id, work_id: $work_id, agent_handle: $agent_handle, status: 'active', revision: 1, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          session_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          agent_handle: input.agentHandle,
        },
      );
      const session = records[0];
      if (!session) throw new Error("Session 생성 결과가 없습니다");
      return { session };
    });
  }

  public async saveCheckpoint(
    context: TenantContext,
    input: SaveCheckpointInput,
  ): Promise<WorkCommandResult & { session: WorkSession; checkpoint: SessionCheckpoint }> {
    return await this.mutate(context, input, "checkpoint_saved", async (transaction, work) => {
      const [sessions] = await transaction.query<[WorkSession[]]>(
        "SELECT * OMIT id FROM work_session WHERE organization_id = $organization_id AND work_id = $work_id AND session_id = $session_id LIMIT 1;",
        { organization_id: context.organizationId, work_id: work.work_id, session_id: input.sessionId },
      );
      const session = sessions[0];
      if (!session) throw new Error(`Session을 찾을 수 없습니다: ${input.sessionId}`);
      if (session.revision !== input.expectedSessionRevision) {
        throw new Error(`현재 Session revision은 ${String(session.revision)}입니다`);
      }
      const dataJson = canonicalJson(input.data);
      const version = session.revision;
      const [records] = await transaction.query<[SessionCheckpoint[]]>(
        "CREATE session_checkpoint CONTENT { checkpoint_id: $checkpoint_id, organization_id: $organization_id, work_id: $work_id, session_id: $session_id, version: $version, data_json: $data_json, checksum: $checksum, created_at: time::now() } RETURN AFTER;",
        {
          checkpoint_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: work.work_id,
          session_id: session.session_id,
          version,
          data_json: dataJson,
          checksum: createHash("sha256").update(dataJson).digest("hex"),
        },
      );
      await transaction.query(
        "UPDATE work_session SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND session_id = $session_id;",
        { revision: session.revision + 1, organization_id: context.organizationId, session_id: session.session_id },
      );
      const checkpoint = records[0];
      if (!checkpoint) throw new Error("Checkpoint 생성 결과가 없습니다");
      return { session: { ...session, revision: session.revision + 1 }, checkpoint };
    });
  }

  public async transition(context: TenantContext, input: TransitionInput): Promise<WorkCommandResult> {
    return await this.mutate(context, input, "work_state_changed", async (transaction, work) => {
      if (!ALLOWED_TRANSITIONS[work.status].includes(input.target)) {
        throw new Error(`허용되지 않은 Work 상태 전이입니다: ${work.status} -> ${input.target}`);
      }
      if (input.target === "planned") {
        const [plans] = await transaction.query<[PlanVersion[]]>(
          "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id AND valid = true LIMIT 1;",
          { organization_id: context.organizationId, work_id: work.work_id },
        );
        if (!plans[0]) throw new Error("planned 전이에는 유효한 PlanVersion이 필요합니다");
      }
      if (input.target === "ready") {
        const tasks = await listTasksWith(transaction, context.organizationId, work.work_id);
        assertAcyclic(tasks);
        if (tasks.length === 0) throw new Error("ready 전이에는 Task DAG가 필요합니다");
        const assignments = await listAssignmentsWith(transaction, context.organizationId, work.work_id);
        if (
          tasks
            .filter((task) => task.status !== "cancelled")
            .some(
              (task) =>
                !assignments.some(
                  (assignment) => assignment.task_id === task.task_id && assignment.status === "assigned",
                ),
            )
        ) {
          throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
        }
      }
      if (input.target === "completed") throw new Error("completed 전이에는 Verification과 WorkRecord가 필요합니다");
      await transaction.query(
        "UPDATE work SET status = $status, revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          status: input.target,
          revision: work.revision + 1,
          organization_id: context.organizationId,
          work_id: work.work_id,
        },
      );
      return {};
    });
  }

  private async mutate<Extra extends object>(
    context: TenantContext,
    input: WorkCommandInput,
    eventType: string,
    operation: (transaction: QueryExecutor, work: Work) => Promise<Extra>,
  ): Promise<WorkCommandResult & Extra> {
    await this.verify(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) return this.replay(repeated, requestJson) as WorkCommandResult & Extra;
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (work.revision !== input.expectedRevision)
        throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
      const extra = await operation(transaction, work);
      if (eventType !== "work_state_changed") {
        await transaction.query(
          "UPDATE work SET revision = $revision, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
          { revision: work.revision + 1, organization_id: context.organizationId, work_id: work.work_id },
        );
      }
      const updated = await findWork(transaction, context.organizationId, work.work_id);
      if (!updated) throw new Error("변경된 Work를 찾을 수 없습니다");
      const provisional = { work: updated, ...extra };
      const event = await this.appendEvent(
        transaction,
        context,
        updated,
        input.commandId,
        eventType,
        requestJson,
        extra,
        provisional,
        input.causedByEventId,
      );
      const result = { ...provisional, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: event.event_id,
      });
      return result;
    });
  }

  private replay(event: WorkEvent, requestJson: string): unknown {
    if (event.request_json !== requestJson) throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
    return JSON.parse(event.result_json) as unknown;
  }

  private async appendEvent(
    executor: QueryExecutor,
    context: TenantContext,
    work: Work,
    commandId: string,
    eventType: string,
    requestJson: string,
    payload: unknown,
    result: unknown,
    causedByEventId?: string,
  ): Promise<WorkEvent> {
    const existing = await listEventsWith(executor, context.organizationId, work.work_id);
    const sequence = existing.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    if (causedByEventId && !existing.some((event) => event.event_id === causedByEventId)) {
      throw new Error(`원인 WorkEvent를 찾을 수 없습니다: ${causedByEventId}`);
    }
    const [events] = await executor.query<[WorkEvent[]]>(
      "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, caused_by_event_id: $caused_by_event_id, request_json: $request_json, payload_json: $payload_json, result_json: $result_json, created_at: time::now() } RETURN AFTER;",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        work_id: work.work_id,
        sequence,
        command_id: commandId,
        event_type: eventType,
        actor_user_id: context.userId,
        caused_by_event_id: causedByEventId,
        request_json: requestJson,
        payload_json: JSON.stringify(payload),
        result_json: JSON.stringify(result),
      },
    );
    const event = events[0];
    if (!event) throw new Error("WorkEvent 생성 결과가 없습니다");
    return event;
  }
}
