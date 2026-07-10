import { createHash } from "node:crypto";

import type { QueryExecutor } from "@massion/storage";

import type { AssuranceRun, StartAssuranceRunInput } from "./contracts.js";
import {
  verifyAssuranceIndependence,
  type AssuranceIndependenceInput,
  type IndependenceExecution,
} from "./independence.js";

interface WorkRecord {
  readonly revision: number;
  readonly status: string;
  readonly artifact_version_ids: readonly string[];
}

interface NodeRecord {
  readonly status: string;
}

interface TaskRecord {
  readonly task_id: string;
  readonly status: string;
}

interface AssignmentRecord {
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: string;
}

interface RuntimeRecord {
  readonly execution_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
  readonly status: string;
  readonly output_json?: string;
}

interface ArtifactVersionRecord {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly created_by: string;
  readonly content_json: string;
  readonly creator_agent_handle?: string;
  readonly creator_execution_id?: string;
}

interface ArtifactRecord {
  readonly artifact_id: string;
  readonly kind: string;
}

interface CheckRecord {
  readonly executor_handle?: string;
  readonly executor_execution_id?: string;
  readonly system_adapter_id?: string;
}

interface VerificationRecord {
  readonly assurance_run_id: string;
  readonly projected_work_revision: number;
}

function outputHash(record: RuntimeRecord): string | undefined {
  if (!record.output_json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(record.output_json) as unknown;
  } catch {
    throw new Error(`Runtime Execution output JSON이 유효하지 않습니다: ${record.execution_id}`);
  }
  if (!value || typeof value !== "object") return undefined;
  return createHash("sha256").update(record.output_json).digest("hex");
}

function execution(record: RuntimeRecord): IndependenceExecution {
  const hash = outputHash(record);
  return {
    executionId: record.execution_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    agentHandle: record.agent_handle,
    status: record.status,
    ...(hash ? { outputHash: hash } : {}),
  };
}

async function findExecution(
  executor: QueryExecutor,
  organizationId: string,
  executionId: string,
  label: string,
): Promise<RuntimeRecord> {
  const [records] = await executor.query<[RuntimeRecord[]]>(
    "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
    { organization_id: organizationId, execution_id: executionId },
  );
  const record = records[0];
  if (!record) throw new Error(`${label} Runtime Execution을 찾을 수 없습니다: ${executionId}`);
  return record;
}

async function verify(
  executor: QueryExecutor,
  input: {
    readonly phase: "start" | "verdict";
    readonly organizationId: string;
    readonly workId: string;
    readonly targetWorkRevision: number;
    readonly assuranceRunId?: string;
    readonly verifierHandle: string;
    readonly verifierExecutionId: string;
  },
): Promise<void> {
  const [works] = await executor.query<[WorkRecord[]]>(
    "SELECT revision, status, artifact_version_ids FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: input.organizationId, work_id: input.workId },
  );
  const work = works[0];
  if (!work) throw new Error(`Assurance 대상 Work를 찾을 수 없습니다: ${input.workId}`);
  if (work.status !== "verifying" || work.revision !== input.targetWorkRevision) {
    throw new Error("Assurance 대상 Work는 target revision의 verifying 상태여야 합니다");
  }
  const [nodes] = await executor.query<[NodeRecord[]]>(
    "SELECT status FROM organization_node WHERE organization_id = $organization_id AND handle = $handle LIMIT 1;",
    { organization_id: input.organizationId, handle: input.verifierHandle },
  );
  const verifier = await findExecution(executor, input.organizationId, input.verifierExecutionId, "Verifier");
  const [tasks] = await executor.query<[TaskRecord[]]>(
    "SELECT task_id, status FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id;",
    { organization_id: input.organizationId, work_id: input.workId },
  );
  const [assignments] = await executor.query<[AssignmentRecord[]]>(
    "SELECT task_id, agent_handle, status FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id;",
    { organization_id: input.organizationId, work_id: input.workId },
  );
  if (tasks.length === 0 || tasks.some((task) => !["completed", "cancelled"].includes(task.status))) {
    throw new Error("Assurance 대상 Work의 모든 Task는 completed 또는 cancelled여야 합니다");
  }
  if (
    tasks
      .filter((task) => task.status !== "cancelled")
      .some((task) => !assignments.some((assignment) => assignment.task_id === task.task_id))
  ) {
    throw new Error("Assurance 대상 non-cancelled Task의 Assignment 계보가 필요합니다");
  }
  const taskIds = tasks.map((task) => task.task_id);
  let referencedRuntimeRecords: RuntimeRecord[] = [];
  if (taskIds.length > 0) {
    [referencedRuntimeRecords] = await executor.query<[RuntimeRecord[]]>(
      "SELECT * OMIT id FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND task_id IN $task_ids AND execution_id != $verifier_execution_id;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        task_ids: taskIds,
        verifier_execution_id: input.verifierExecutionId,
      },
    );
  }
  let artifactVersions: ArtifactVersionRecord[] = [];
  if (work.artifact_version_ids.length > 0) {
    [artifactVersions] = await executor.query<[ArtifactVersionRecord[]]>(
      "SELECT artifact_version_id, artifact_id, created_by, content_json, creator_agent_handle, creator_execution_id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $artifact_version_ids;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        artifact_version_ids: work.artifact_version_ids,
      },
    );
  }
  if (artifactVersions.length !== work.artifact_version_ids.length) {
    throw new Error("Work의 Assurance 대상 ArtifactVersion 참조가 완전하지 않습니다");
  }
  const artifactIds = [...new Set(artifactVersions.map((version) => version.artifact_id))];
  let artifacts: ArtifactRecord[] = [];
  if (artifactIds.length > 0) {
    [artifacts] = await executor.query<[ArtifactRecord[]]>(
      "SELECT artifact_id, kind FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_id IN $artifact_ids;",
      { organization_id: input.organizationId, work_id: input.workId, artifact_ids: artifactIds },
    );
  }
  const artifactById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  for (const version of artifactVersions) {
    const artifact = artifactById.get(version.artifact_id);
    if (!artifact) throw new Error(`Artifact를 찾을 수 없습니다: ${version.artifact_id}`);
    if (artifact.kind === "code-change") continue;
    if (artifact.kind === "verification-evidence") {
      const [verifications] = await executor.query<[VerificationRecord[]]>(
        "SELECT assurance_run_id, projected_work_revision FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id AND evidence_artifact_version_id = $artifact_version_id LIMIT 1;",
        {
          organization_id: input.organizationId,
          work_id: input.workId,
          artifact_version_id: version.artifact_version_id,
        },
      );
      const verification = verifications[0];
      if (!verification || verification.projected_work_revision > work.revision) {
        throw new Error(
          `Verification evidence WorkVerification 연결이 유효하지 않습니다: ${version.artifact_version_id}`,
        );
      }
      const [runs] = await executor.query<[{ assurance_run_id: string }[]]>(
        "SELECT assurance_run_id FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND projected_work_revision = $projected_work_revision AND status IN ['passed', 'failed'] LIMIT 1;",
        {
          organization_id: input.organizationId,
          work_id: input.workId,
          assurance_run_id: verification.assurance_run_id,
          projected_work_revision: verification.projected_work_revision,
        },
      );
      if (!runs[0]) {
        throw new Error(`Verification evidence AssuranceRun 연결이 유효하지 않습니다: ${version.artifact_version_id}`);
      }
      continue;
    }
    if (!version.creator_agent_handle || !version.creator_execution_id) {
      throw new Error(`Material Artifact의 Runtime provenance가 필요합니다: ${version.artifact_version_id}`);
    }
    const creator = await findExecution(
      executor,
      input.organizationId,
      version.creator_execution_id,
      "Artifact creator",
    );
    if (
      creator.work_id !== input.workId ||
      creator.agent_handle !== version.creator_agent_handle ||
      creator.status !== "succeeded"
    ) {
      throw new Error(
        `Material Artifact creator Runtime Execution이 유효하지 않습니다: ${version.artifact_version_id}`,
      );
    }
    referencedRuntimeRecords.push(creator);
  }
  const checkExecutors: AssuranceIndependenceInput["checkExecutors"][number][] = [];
  if (input.phase === "verdict" && input.assuranceRunId) {
    const [checks] = await executor.query<[CheckRecord[]]>(
      "SELECT executor_handle, executor_execution_id, system_adapter_id FROM assurance_check WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    for (const check of checks) {
      if (check.system_adapter_id) {
        checkExecutors.push({ kind: "system_adapter", adapterId: check.system_adapter_id });
        continue;
      }
      if (!check.executor_handle || !check.executor_execution_id) {
        throw new Error("Assurance check executor provenance가 완전하지 않습니다");
      }
      checkExecutors.push({
        kind: "runtime_agent",
        handle: check.executor_handle,
        execution: execution(
          await findExecution(executor, input.organizationId, check.executor_execution_id, "Check executor"),
        ),
      });
    }
  }
  verifyAssuranceIndependence({
    phase: input.phase,
    organizationId: input.organizationId,
    workId: input.workId,
    verifierHandle: input.verifierHandle,
    verifierNodeActive: nodes[0]?.status === "active",
    verifierExecution: execution(verifier),
    tasks: tasks.map((task) => ({ taskId: task.task_id, status: task.status })),
    assignments: assignments.map((assignment) => ({
      taskId: assignment.task_id,
      agentHandle: assignment.agent_handle,
      status: assignment.status,
    })),
    referencedExecutions: referencedRuntimeRecords.map(execution),
    artifacts: artifactVersions.map((version) => {
      const artifact = artifactById.get(version.artifact_id);
      if (!artifact) throw new Error(`Artifact를 찾을 수 없습니다: ${version.artifact_id}`);
      return {
        kind: artifact.kind,
        ...(version.creator_agent_handle && artifact.kind !== "verification-evidence"
          ? { createdBy: version.creator_agent_handle }
          : {}),
        contentJson: version.content_json,
      };
    }),
    checkExecutors,
  });
}

export async function verifyAssuranceStartIndependence(
  executor: QueryExecutor,
  organizationId: string,
  input: StartAssuranceRunInput,
): Promise<void> {
  await verify(executor, {
    phase: "start",
    organizationId,
    workId: input.workId,
    targetWorkRevision: input.targetWorkRevision,
    verifierHandle: input.verifierHandle,
    verifierExecutionId: input.verifierExecutionId,
  });
}

export async function verifyAssuranceVerdictIndependence(
  executor: QueryExecutor,
  run: Pick<
    AssuranceRun,
    "organizationId" | "workId" | "targetWorkRevision" | "assuranceRunId" | "verifierHandle" | "verifierExecutionId"
  >,
): Promise<void> {
  await verify(executor, {
    phase: "verdict",
    organizationId: run.organizationId,
    workId: run.workId,
    targetWorkRevision: run.targetWorkRevision,
    assuranceRunId: run.assuranceRunId,
    verifierHandle: run.verifierHandle,
    verifierExecutionId: run.verifierExecutionId,
  });
}
