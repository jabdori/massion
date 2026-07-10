export interface IndependenceExecution {
  readonly executionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly agentHandle: string;
  readonly status: string;
  readonly outputHash?: string;
}

export interface AssuranceIndependenceInput {
  readonly phase: "start" | "verdict" | "completion_audit";
  readonly organizationId: string;
  readonly workId: string;
  readonly verifierHandle: string;
  readonly verifierNodeActive: boolean;
  readonly verifierExecution: IndependenceExecution;
  readonly tasks: readonly { readonly taskId: string; readonly status: string }[];
  readonly assignments: readonly {
    readonly taskId: string;
    readonly agentHandle: string;
    readonly status: string;
  }[];
  readonly referencedExecutions: readonly IndependenceExecution[];
  readonly artifacts: readonly {
    readonly kind: string;
    readonly createdBy?: string;
    readonly contentJson: string;
  }[];
  readonly checkExecutors: readonly (
    | {
        readonly kind: "runtime_agent";
        readonly handle: string;
        readonly execution: IndependenceExecution;
      }
    | { readonly kind: "system_adapter"; readonly adapterId: string }
  )[];
}

export interface AssuranceIndependenceResult {
  readonly contributorHandles: readonly string[];
  readonly checkExecutorHandles: readonly string[];
}

function verifyExecutionOwner(
  input: AssuranceIndependenceInput,
  execution: IndependenceExecution,
  expectedHandle: string,
  label: string,
): void {
  if (execution.organizationId !== input.organizationId) throw new Error(`${label} organization이 일치하지 않습니다`);
  if (execution.workId !== input.workId) throw new Error(`${label} Work가 일치하지 않습니다`);
  if (execution.agentHandle !== expectedHandle) throw new Error(`${label} handle이 일치하지 않습니다`);
}

function deliveryAgent(contentJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(contentJson) as unknown;
  } catch {
    throw new Error("code-change manifest JSON이 올바르지 않습니다");
  }
  if (!value || typeof value !== "object") throw new Error("code-change manifest가 object가 아닙니다");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "massion.code-change-manifest.v1")
    throw new Error("지원하지 않는 code-change manifest version입니다");
  if (typeof record.agentHandle !== "string" || !record.agentHandle.trim())
    throw new Error("code-change manifest delivery Agent가 필요합니다");
  return record.agentHandle;
}

export function verifyAssuranceIndependence(input: AssuranceIndependenceInput): AssuranceIndependenceResult {
  if (input.verifierHandle !== "assurance") throw new Error("최종 verifier는 assurance handle이어야 합니다");
  if (!input.verifierNodeActive) throw new Error("활성 Assurance OrganizationNode가 필요합니다");
  verifyExecutionOwner(input, input.verifierExecution, input.verifierHandle, "Verifier Runtime Execution");
  if (input.phase === "start") {
    if (!["queued", "running"].includes(input.verifierExecution.status))
      throw new Error("시작 verifier Runtime Execution은 queued 또는 running이어야 합니다");
  } else {
    if (input.verifierExecution.status !== "succeeded")
      throw new Error("판정 verifier Runtime Execution은 succeeded여야 합니다");
    if (!input.verifierExecution.outputHash || !/^[a-f0-9]{64}$/u.test(input.verifierExecution.outputHash))
      throw new Error("판정 verifier Runtime Execution output hash가 필요합니다");
  }

  const taskStatus = new Map(input.tasks.map((task) => [task.taskId, task.status]));
  const contributors = new Set<string>();
  for (const assignment of input.assignments) {
    if (taskStatus.get(assignment.taskId) !== "cancelled") contributors.add(assignment.agentHandle);
  }
  for (const execution of input.referencedExecutions) {
    verifyExecutionOwner(input, execution, execution.agentHandle, "참조 Runtime Execution");
    contributors.add(execution.agentHandle);
  }
  for (const artifact of input.artifacts) {
    if (artifact.createdBy !== undefined) {
      if (!artifact.createdBy.trim()) throw new Error("Artifact createdBy가 비어 있을 수 없습니다");
      contributors.add(artifact.createdBy);
    }
    if (artifact.kind === "code-change") contributors.add(deliveryAgent(artifact.contentJson));
  }
  if (contributors.has(input.verifierHandle)) throw new Error("Work contributor는 최종 verifier가 될 수 없습니다");

  const checkExecutors = new Set<string>();
  for (const executor of input.checkExecutors) {
    if (executor.kind === "system_adapter") {
      if (!executor.adapterId.trim()) throw new Error("System adapter ID가 필요합니다");
      continue;
    }
    verifyExecutionOwner(input, executor.execution, executor.handle, "Check executor Runtime Execution");
    if (executor.execution.status !== "succeeded")
      throw new Error("Check executor Runtime Execution은 succeeded여야 합니다");
    if (contributors.has(executor.handle)) throw new Error("Work contributor는 독립 check executor가 될 수 없습니다");
    checkExecutors.add(executor.handle);
  }
  return {
    contributorHandles: [...contributors].sort(),
    checkExecutorHandles: [...checkExecutors].sort(),
  };
}
