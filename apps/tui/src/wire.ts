import type { CollaborationGraphSnapshot } from "@massion/application";

export interface TuiEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

function text(value: unknown, label: string, maximum = 65_536): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} 문자열이 유효하지 않습니다`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} 정수가 유효하지 않습니다`);
  return value as number;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${label} 배열이 유효하지 않습니다`);
  return value.map((item, index) => text(item, `${label}[${String(index)}]`, 1_024));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${label} 배열이 유효하지 않습니다`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label, 1_024);
}

const ROOT_FIELDS = [
  "schemaVersion",
  "revision",
  "sourceWatermarks",
  "organization",
  "nodes",
  "works",
  "tasks",
  "assignments",
  "executions",
  "rooms",
  "pendingApprovals",
  "extensions",
] as const;

export function decodeSnapshot(input: unknown): CollaborationGraphSnapshot {
  const root = record(input, "협업 snapshot");
  fields(root, ROOT_FIELDS, "협업 snapshot");
  if (root.schemaVersion !== "massion.collaboration.snapshot.v1")
    throw new Error("협업 snapshot version이 유효하지 않습니다");
  const revision = text(root.revision, "revision", 128);
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw new Error("snapshot revision이 유효하지 않습니다");
  const watermarks = record(root.sourceWatermarks, "sourceWatermarks");
  for (const [key, value] of Object.entries(watermarks)) {
    text(key, "watermark key", 128);
    if (!(typeof value === "string" || (Number.isSafeInteger(value) && (value as number) >= 0)))
      throw new Error("source watermark가 유효하지 않습니다");
  }
  const organization = record(root.organization, "organization");
  fields(organization, ["organizationId", "version"], "organization");

  const nodes = array(root.nodes, "nodes").map((item, index) => {
    const node = record(item, `nodes[${String(index)}]`);
    fields(
      node,
      [
        "handle",
        "name",
        "responsibility",
        "capabilities",
        "status",
        "role",
        "scope",
        "currentTaskId",
        "currentWorkId",
        "executionId",
        "executionStatus",
        "modelRoute",
        "inputTokens",
        "outputTokens",
        "costMicros",
      ],
      "node",
    );
    const currentTaskId = optionalText(node.currentTaskId, "currentTaskId");
    const currentWorkId = optionalText(node.currentWorkId, "currentWorkId");
    const executionId = optionalText(node.executionId, "executionId");
    const executionStatus = optionalText(node.executionStatus, "executionStatus");
    const modelRoute = optionalText(node.modelRoute, "modelRoute");
    return {
      handle: text(node.handle, "handle", 256),
      name: text(node.name, "name", 1_024),
      responsibility: text(node.responsibility, "responsibility"),
      capabilities: strings(node.capabilities, "capabilities"),
      status: text(node.status, "status", 128),
      role: text(node.role, "role", 128),
      scope: text(node.scope, "scope", 128),
      ...(currentTaskId === undefined ? {} : { currentTaskId }),
      ...(currentWorkId === undefined ? {} : { currentWorkId }),
      ...(executionId === undefined ? {} : { executionId }),
      ...(executionStatus === undefined ? {} : { executionStatus }),
      ...(modelRoute === undefined ? {} : { modelRoute }),
      ...(node.inputTokens === undefined ? {} : { inputTokens: integer(node.inputTokens, "inputTokens") }),
      ...(node.outputTokens === undefined ? {} : { outputTokens: integer(node.outputTokens, "outputTokens") }),
      ...(node.costMicros === undefined ? {} : { costMicros: integer(node.costMicros, "costMicros") }),
    };
  });

  const works = array(root.works, "works").map((item) => {
    const work = record(item, "work");
    fields(work, ["workId", "status", "revision", "artifactIds", "taskIds", "roomIds"], "work");
    return {
      workId: text(work.workId, "workId", 1_024),
      status: text(work.status, "work status", 128),
      revision: integer(work.revision, "work revision", 1),
      artifactIds: strings(work.artifactIds, "artifactIds"),
      taskIds: strings(work.taskIds, "taskIds"),
      roomIds: strings(work.roomIds, "roomIds"),
    };
  });

  const tasks = array(root.tasks, "tasks").map((item) => {
    const task = record(item, "task");
    fields(task, ["workId", "taskId", "title", "status", "revision"], "task");
    return {
      workId: text(task.workId, "task workId", 1_024),
      taskId: text(task.taskId, "taskId", 1_024),
      title: text(task.title, "task title"),
      status: text(task.status, "task status", 128),
      revision: integer(task.revision, "task revision", 1),
    };
  });

  const assignments = array(root.assignments, "assignments").map((item) => {
    const assignment = record(item, "assignment");
    fields(assignment, ["workId", "taskId", "agentHandle", "status", "revision"], "assignment");
    return {
      workId: text(assignment.workId, "assignment workId", 1_024),
      taskId: text(assignment.taskId, "assignment taskId", 1_024),
      agentHandle: text(assignment.agentHandle, "agentHandle", 256),
      status: text(assignment.status, "assignment status", 128),
      revision: integer(assignment.revision, "assignment revision", 1),
    };
  });

  const executions = array(root.executions, "executions").map((item) => {
    const execution = record(item, "execution");
    fields(
      execution,
      [
        "executionId",
        "workId",
        "taskId",
        "agentHandle",
        "modelRoute",
        "status",
        "inputTokens",
        "outputTokens",
        "costMicros",
      ],
      "execution",
    );
    return {
      executionId: text(execution.executionId, "executionId", 1_024),
      workId: text(execution.workId, "execution workId", 1_024),
      ...(execution.taskId === undefined ? {} : { taskId: text(execution.taskId, "execution taskId", 1_024) }),
      agentHandle: text(execution.agentHandle, "execution agentHandle", 256),
      modelRoute: text(execution.modelRoute, "modelRoute", 256),
      status: text(execution.status, "execution status", 128),
      inputTokens: integer(execution.inputTokens, "execution inputTokens"),
      outputTokens: integer(execution.outputTokens, "execution outputTokens"),
      costMicros: integer(execution.costMicros, "execution costMicros"),
    };
  });

  const rooms = array(root.rooms, "rooms").map((item) => {
    const room = record(item, "room");
    fields(room, ["workId", "roomId", "name", "kind", "status", "participantIds", "lastMessageSequence"], "room");
    return {
      workId: text(room.workId, "room workId", 1_024),
      roomId: text(room.roomId, "roomId", 1_024),
      name: text(room.name, "room name"),
      kind: text(room.kind, "room kind", 128),
      status: text(room.status, "room status", 128),
      participantIds: strings(room.participantIds, "participantIds"),
      lastMessageSequence: integer(room.lastMessageSequence, "lastMessageSequence"),
    };
  });

  const pendingApprovals = array(root.pendingApprovals, "pendingApprovals").map((item) => {
    const approval = record(item, "approval");
    fields(approval, ["approvalId", "action", "status", "requestedBy", "expiresAt"], "approval");
    return {
      approvalId: text(approval.approvalId, "approvalId", 1_024),
      action: text(approval.action, "approval action"),
      status: text(approval.status, "approval status", 128),
      requestedBy: text(approval.requestedBy, "requestedBy", 1_024),
      expiresAt: text(approval.expiresAt, "expiresAt", 128),
    };
  });

  const extensions = array(root.extensions, "extensions").map((item) => {
    const extension = record(item, "extension");
    fields(extension, ["installationId", "packageName", "packageVersion", "state", "contributions"], "extension");
    return {
      installationId: text(extension.installationId, "installationId", 1_024),
      packageName: text(extension.packageName, "packageName", 1_024),
      packageVersion: text(extension.packageVersion, "packageVersion", 256),
      state: text(extension.state, "extension state", 128),
      contributions: strings(extension.contributions, "contributions"),
    };
  });

  return {
    schemaVersion: "massion.collaboration.snapshot.v1",
    revision,
    sourceWatermarks: watermarks as Readonly<Record<string, string | number>>,
    organization: {
      organizationId: text(organization.organizationId, "organizationId", 1_024),
      version: integer(organization.version, "organization version", 1),
    },
    nodes,
    works,
    tasks,
    assignments,
    executions,
    rooms,
    pendingApprovals,
    extensions,
  };
}

export function decodeEvent(input: unknown): TuiEvent {
  const value = record(input, "Application event");
  const sequence = integer(value.sequence, "event sequence", 1);
  const type = text(value.type, "event type", 256);
  if (!/^[a-z][a-z0-9._-]*$/u.test(type)) throw new Error("event type이 유효하지 않습니다");
  return { sequence, type, payload: value.payload };
}

export function decodeQueryResult(input: unknown, expectedOperation: string): unknown {
  const value = record(input, "Application query 응답");
  fields(value, ["schemaVersion", "operation", "data"], "Application query 응답");
  if (value.schemaVersion !== "massion.application.v1" || value.operation !== expectedOperation || !("data" in value))
    throw new Error("Application query 응답 계보가 유효하지 않습니다");
  return value.data;
}
