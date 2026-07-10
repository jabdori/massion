import type { QueryExecutor } from "@massion/storage";
import type {
  ArtifactVersion,
  PlanVersion,
  TaskAssignment,
  Work,
  WorkArtifact,
  WorkRecoveryBundle,
  WorkTask,
} from "@massion/work";

import {
  assuranceBindingVersionChecksum,
  type AssuranceBindingVersion,
  type AssuranceCheckBinding,
} from "./binding-store.js";
import { compileAssuranceCriteria, type CompiledAssuranceCriterion, type CriterionExclusionInput } from "./criteria.js";
import { selectAssuranceProfile } from "./profile.js";
import { createAssuranceSnapshot, type AssuranceSnapshot } from "./snapshot.js";

export interface DatabaseAssuranceSnapshotInput {
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly planVersionId: string;
  readonly bindingVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly criterionExclusions?: Readonly<Record<string, CriterionExclusionInput>>;
}

interface BindingRecord {
  readonly binding_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly plan_version_id: string;
  readonly version: number;
  readonly revision: number;
  readonly status: "draft" | "active" | "superseded";
  readonly profile_id: string;
  readonly profile_version: string;
  readonly bindings_json: string;
  readonly criteria_checksum: string;
  readonly checksum: string;
  readonly author_handle: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

export interface DatabaseAssuranceSnapshotResult {
  readonly snapshot: AssuranceSnapshot;
  readonly criteria: readonly CompiledAssuranceCriterion[];
}

export interface CompletedDatabaseAssuranceSnapshotInput extends DatabaseAssuranceSnapshotInput {
  readonly evidenceArtifactVersionId: string;
}

function binding(
  record: BindingRecord,
): Pick<
  AssuranceBindingVersion,
  | "bindingVersionId"
  | "organizationId"
  | "workId"
  | "planVersionId"
  | "status"
  | "profileId"
  | "profileVersion"
  | "criteriaChecksum"
  | "checksum"
  | "bindings"
> {
  let bindings: AssuranceCheckBinding[];
  try {
    bindings = JSON.parse(record.bindings_json) as AssuranceCheckBinding[];
  } catch {
    throw new Error("Assurance binding JSON이 유효하지 않습니다");
  }
  return {
    bindingVersionId: record.binding_version_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    planVersionId: record.plan_version_id,
    status: record.status,
    profileId: record.profile_id,
    profileVersion: record.profile_version,
    criteriaChecksum: record.criteria_checksum,
    checksum: record.checksum,
    bindings,
  };
}

async function buildSnapshot(
  executor: QueryExecutor,
  organizationId: string,
  input: DatabaseAssuranceSnapshotInput,
  completion?: { readonly evidenceArtifactVersionId: string },
): Promise<DatabaseAssuranceSnapshotResult> {
  const [works] = await executor.query<[Work[]]>(
    "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: organizationId, work_id: input.workId },
  );
  const currentWork = works[0];
  if (!currentWork) {
    throw new Error("Assurance snapshot target Work revision이 유효하지 않습니다");
  }
  const work = completion
    ? {
        ...currentWork,
        status: "verifying" as const,
        revision: input.targetWorkRevision,
        artifact_version_ids: currentWork.artifact_version_ids.filter(
          (artifactVersionId) => artifactVersionId !== completion.evidenceArtifactVersionId,
        ),
      }
    : currentWork;
  if (
    completion
      ? currentWork.status !== "completed" ||
        currentWork.revision !== input.targetWorkRevision + 3 ||
        !currentWork.artifact_version_ids.includes(completion.evidenceArtifactVersionId)
      : currentWork.revision !== input.targetWorkRevision
  ) {
    throw new Error("Assurance snapshot target Work revision이 유효하지 않습니다");
  }
  const [plans] = await executor.query<[PlanVersion[]]>(
    "SELECT * OMIT id FROM plan_version WHERE organization_id = $organization_id AND work_id = $work_id;",
    { organization_id: organizationId, work_id: input.workId },
  );
  const [tasks] = await executor.query<[WorkTask[]]>(
    "SELECT * OMIT id FROM work_task WHERE organization_id = $organization_id AND work_id = $work_id;",
    { organization_id: organizationId, work_id: input.workId },
  );
  const [assignments] = await executor.query<[TaskAssignment[]]>(
    "SELECT * OMIT id FROM task_assignment WHERE organization_id = $organization_id AND work_id = $work_id;",
    { organization_id: organizationId, work_id: input.workId },
  );
  let artifactVersions: ArtifactVersion[] = [];
  if (work.artifact_version_ids.length > 0) {
    [artifactVersions] = await executor.query<[ArtifactVersion[]]>(
      "SELECT * OMIT id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $artifact_version_ids;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        artifact_version_ids: work.artifact_version_ids,
      },
    );
  }
  const artifactIds = [...new Set(artifactVersions.map((version) => version.artifact_id))];
  let artifacts: WorkArtifact[] = [];
  if (artifactIds.length > 0) {
    [artifacts] = await executor.query<[WorkArtifact[]]>(
      "SELECT * OMIT id FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_id IN $artifact_ids;",
      { organization_id: organizationId, work_id: input.workId, artifact_ids: artifactIds },
    );
  }
  const [bindingRecords] = await executor.query<[BindingRecord[]]>(
    "SELECT * OMIT id FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id LIMIT 1;",
    {
      organization_id: organizationId,
      work_id: input.workId,
      binding_version_id: input.bindingVersionId,
    },
  );
  const bindingRecord = bindingRecords[0];
  if (!bindingRecord) throw new Error("Assurance snapshot binding을 찾을 수 없습니다");
  const expectedBindingChecksum = assuranceBindingVersionChecksum({
    workId: bindingRecord.work_id,
    planVersionId: bindingRecord.plan_version_id,
    profileId: bindingRecord.profile_id,
    profileVersion: bindingRecord.profile_version,
    criteriaChecksum: bindingRecord.criteria_checksum,
    bindingsJson: bindingRecord.bindings_json,
  });
  if (bindingRecord.checksum !== expectedBindingChecksum) {
    throw new Error("Assurance binding version checksum이 일치하지 않습니다");
  }
  const selectedBinding = binding(bindingRecord);
  const artifactKinds = artifacts.map((artifact) => artifact.kind);
  const profile = selectAssuranceProfile(artifactKinds);
  if (profile.profileId !== input.profileId || profile.version !== input.profileVersion) {
    throw new Error("Assurance snapshot profile이 Artifact 종류와 일치하지 않습니다");
  }
  const activePlan = plans.find((plan) => plan.plan_version_id === input.planVersionId && plan.valid);
  if (!activePlan) throw new Error("Assurance snapshot 활성 PlanVersion을 찾을 수 없습니다");
  const activeTasks = tasks.filter((task) => task.plan_version_id === input.planVersionId);
  const criteria = compileAssuranceCriteria({
    planContentJson: activePlan.content_json,
    tasks: activeTasks.map((task) => ({
      taskId: task.task_id,
      status: task.status,
      acceptanceCriteriaJson: task.acceptance_criteria_json,
    })),
    profile,
    bindings: selectedBinding.bindings.map((check) => ({
      criterionKey: check.criterionKey,
      method: check.kind,
      requiredEvidenceKinds: check.requiredEvidenceKinds,
    })),
    ...(input.criterionExclusions ? { exclusions: input.criterionExclusions } : {}),
  });
  const bundle = {
    work,
    plans,
    tasks,
    assignments,
    artifacts,
    artifactVersions,
  } as WorkRecoveryBundle;
  const snapshot = createAssuranceSnapshot({
    bundle,
    profile: { profileId: profile.profileId, version: profile.version },
    binding: selectedBinding,
    criteria,
  });
  return { snapshot, criteria };
}

export async function buildDatabaseAssuranceSnapshot(
  executor: QueryExecutor,
  organizationId: string,
  input: DatabaseAssuranceSnapshotInput,
): Promise<DatabaseAssuranceSnapshotResult> {
  return await buildSnapshot(executor, organizationId, input);
}

export async function buildCompletedDatabaseAssuranceSnapshot(
  executor: QueryExecutor,
  organizationId: string,
  input: CompletedDatabaseAssuranceSnapshotInput,
): Promise<DatabaseAssuranceSnapshotResult> {
  return await buildSnapshot(executor, organizationId, input, {
    evidenceArtifactVersionId: input.evidenceArtifactVersionId,
  });
}
