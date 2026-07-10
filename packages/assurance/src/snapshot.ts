import { createHash } from "node:crypto";

import type { WorkRecoveryBundle } from "@massion/work";

import type { AssuranceBindingVersion } from "./binding-store.js";
import {
  checksumCriterionCoverage,
  compileAssuranceCriteria,
  type CompiledAssuranceCriterion,
  type CriterionExclusionInput,
} from "./criteria.js";
import { selectAssuranceProfile } from "./profile.js";

export interface CreateAssuranceSnapshotInput {
  readonly bundle: WorkRecoveryBundle;
  readonly profile: { readonly profileId: string; readonly version: string };
  readonly binding: Pick<
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
  >;
  readonly criteria: readonly CompiledAssuranceCriterion[];
}

export interface AssuranceSnapshotMaterial {
  readonly organizationId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly planVersionId: string;
  readonly planChecksum: string;
  readonly organizationVersionId: string;
  readonly contextVersionId?: string;
  readonly policyVersionId?: string;
  readonly promptVersionId?: string;
  readonly tasks: readonly Readonly<Record<string, unknown>>[];
  readonly assignments: readonly Readonly<Record<string, unknown>>[];
  readonly artifactVersions: readonly Readonly<Record<string, unknown>>[];
  readonly profile: { readonly profileId: string; readonly version: string };
  readonly binding: {
    readonly bindingVersionId: string;
    readonly checksum: string;
    readonly criteriaChecksum: string;
  };
  readonly criteria: readonly CompiledAssuranceCriterion[];
}

export interface AssuranceSnapshot {
  readonly material: AssuranceSnapshotMaterial;
  readonly canonicalJson: string;
  readonly hash: string;
}

export type AssuranceFollowUpClassification =
  | { readonly status: "fresh" }
  | {
      readonly status: "allowed";
      readonly stage: "verification_projection" | "records_finalize" | "completed";
    }
  | { readonly status: "stale"; readonly reason: string };

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function sameOwner(
  record: { readonly organization_id: string; readonly work_id: string },
  input: CreateAssuranceSnapshotInput,
): void {
  if (record.organization_id !== input.bundle.work.organization_id || record.work_id !== input.bundle.work.work_id) {
    throw new Error("Snapshot record의 organization·Work 소유권이 일치하지 않습니다");
  }
}

export function createAssuranceSnapshot(input: CreateAssuranceSnapshotInput): AssuranceSnapshot {
  const { bundle, profile, binding } = input;
  const { work } = bundle;
  if (work.status !== "verifying")
    throw new Error(`Assurance snapshot에는 verifying Work가 필요합니다: ${work.status}`);
  if (!work.active_plan_version_id) throw new Error("Assurance snapshot에는 활성 PlanVersion이 필요합니다");
  const validPlans = bundle.plans.filter((candidate) => candidate.valid);
  if (validPlans.length !== 1 || validPlans[0]?.plan_version_id !== work.active_plan_version_id) {
    throw new Error(`활성 PlanVersion 정본이 하나가 아닙니다: ${work.active_plan_version_id}`);
  }
  const plan = validPlans[0];
  sameOwner(plan, input);
  const tasks = bundle.tasks.filter((task) => task.plan_version_id === plan.plan_version_id);
  if (tasks.length === 0 || tasks.some((task) => !["completed", "cancelled"].includes(task.status))) {
    throw new Error("Assurance snapshot의 모든 Task는 completed 또는 cancelled여야 합니다");
  }
  for (const task of tasks) sameOwner(task, input);
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const assignments = bundle.assignments.filter((assignment) => taskIds.has(assignment.task_id));
  for (const assignment of assignments) sameOwner(assignment, input);
  for (const task of tasks.filter((candidate) => candidate.status !== "cancelled")) {
    if (!assignments.some((assignment) => assignment.task_id === task.task_id)) {
      throw new Error(`완료 Task의 Assignment 계보가 없습니다: ${task.task_id}`);
    }
  }

  const versionsById = new Map(bundle.artifactVersions.map((version) => [version.artifact_version_id, version]));
  const artifactsById = new Map(bundle.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  if (new Set(work.artifact_version_ids).size !== work.artifact_version_ids.length) {
    throw new Error("Work ArtifactVersion 참조가 중복됐습니다");
  }
  const artifactVersions = work.artifact_version_ids.map((versionId) => {
    const version = versionsById.get(versionId);
    if (!version) throw new Error(`Work ArtifactVersion 참조를 찾을 수 없습니다: ${versionId}`);
    sameOwner(version, input);
    assertHash(version.checksum, "ArtifactVersion checksum");
    if (sha256(version.content_json) !== version.checksum) {
      throw new Error(`ArtifactVersion content checksum이 일치하지 않습니다: ${versionId}`);
    }
    const artifact = artifactsById.get(version.artifact_id);
    if (!artifact) throw new Error(`ArtifactVersion의 Artifact를 찾을 수 없습니다: ${version.artifact_id}`);
    sameOwner(artifact, input);
    return {
      artifactVersionId: version.artifact_version_id,
      artifactId: version.artifact_id,
      version: version.version,
      checksum: version.checksum,
      kind: artifact.kind,
      mediaType: version.media_type,
      sourceArtifactVersionId: version.source_artifact_version_id ?? null,
    };
  });
  assertHash(binding.checksum, "Assurance binding checksum");
  if (!profile.profileId.trim() || !profile.version.trim() || !binding.bindingVersionId.trim()) {
    throw new Error("Assurance profile·binding 식별자가 필요합니다");
  }

  const criteria = [...input.criteria].sort((left, right) => left.criterionKey.localeCompare(right.criterionKey));
  if (criteria.length === 0 || criteria.length > 100) throw new Error("Snapshot criterion은 1~100개여야 합니다");
  if (new Set(criteria.map((criterion) => criterion.criterionKey)).size !== criteria.length)
    throw new Error("Snapshot criterion key가 중복됐습니다");
  if (criteria.some((criterion) => !["pending", "excluded"].includes(criterion.status)))
    throw new Error("Snapshot 시작 criterion 상태는 pending 또는 excluded여야 합니다");
  const expectedProfile = selectAssuranceProfile(artifactVersions.map((version) => version.kind));
  if (profile.profileId !== expectedProfile.profileId || profile.version !== expectedProfile.version) {
    throw new Error("Artifact 종류에 맞는 Assurance profile이 아닙니다");
  }
  if (
    binding.organizationId !== work.organization_id ||
    binding.workId !== work.work_id ||
    binding.planVersionId !== plan.plan_version_id ||
    binding.status !== "active" ||
    binding.profileId !== profile.profileId ||
    binding.profileVersion !== profile.version
  ) {
    throw new Error("활성 Assurance binding의 organization·Work·Plan·profile 결속이 일치하지 않습니다");
  }
  const exclusions: Record<string, CriterionExclusionInput> = {};
  for (const criterion of criteria.filter((candidate) => candidate.status === "excluded")) {
    if (!criterion.exclusionRule || !criterion.exclusionReason || !criterion.exclusionActorId) {
      throw new Error(`Excluded criterion metadata가 불완전합니다: ${criterion.criterionKey}`);
    }
    exclusions[criterion.criterionKey] = {
      rule: criterion.exclusionRule,
      reason: criterion.exclusionReason,
      actorId: criterion.exclusionActorId,
    };
  }
  const compiled = compileAssuranceCriteria({
    planContentJson: plan.content_json,
    tasks: tasks.map((task) => ({
      taskId: task.task_id,
      status: task.status,
      acceptanceCriteriaJson: task.acceptance_criteria_json,
    })),
    profile: expectedProfile,
    bindings: binding.bindings.map((check) => ({
      criterionKey: check.criterionKey,
      method: check.kind,
      requiredEvidenceKinds: check.requiredEvidenceKinds,
    })),
    exclusions,
  });
  if (canonicalJson(criteria) !== canonicalJson(compiled)) {
    throw new Error("Plan·Task·profile에서 compile한 criterion과 snapshot criterion이 일치하지 않습니다");
  }
  if (binding.criteriaChecksum !== checksumCriterionCoverage(compiled)) {
    throw new Error("Assurance binding criterion coverage checksum이 일치하지 않습니다");
  }
  const material: AssuranceSnapshotMaterial = {
    organizationId: work.organization_id,
    workId: work.work_id,
    workRevision: work.revision,
    planVersionId: plan.plan_version_id,
    planChecksum: sha256(plan.content_json),
    organizationVersionId: work.organization_version_id,
    ...(work.context_version_id ? { contextVersionId: work.context_version_id } : {}),
    ...(work.policy_version_id ? { policyVersionId: work.policy_version_id } : {}),
    ...(work.prompt_version_id ? { promptVersionId: work.prompt_version_id } : {}),
    tasks: tasks
      .map((task) => ({
        taskId: task.task_id,
        revision: task.revision,
        status: task.status,
        acceptanceCriteriaJson: task.acceptance_criteria_json,
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    assignments: assignments
      .map((assignment) => ({
        assignmentId: assignment.assignment_id,
        taskId: assignment.task_id,
        revision: assignment.revision,
        status: assignment.status,
        agentHandle: assignment.agent_handle,
        supersedesAssignmentId: assignment.supersedes_assignment_id ?? null,
      }))
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)),
    artifactVersions: artifactVersions.sort((left, right) =>
      left.artifactVersionId.localeCompare(right.artifactVersionId),
    ),
    profile,
    binding: {
      bindingVersionId: binding.bindingVersionId,
      checksum: binding.checksum,
      criteriaChecksum: binding.criteriaChecksum,
    },
    criteria: compiled,
  };
  const serialized = canonicalJson(material);
  return { material, canonicalJson: serialized, hash: sha256(serialized) };
}

export function classifyAssuranceFollowUpEvents(
  targetWorkRevision: number,
  events: readonly { readonly sequence: number; readonly event_type: string }[],
): AssuranceFollowUpClassification {
  const subsequent = events
    .filter((event) => event.sequence > targetWorkRevision)
    .sort((left, right) => left.sequence - right.sequence);
  if (subsequent.length === 0) return { status: "fresh" };
  if (subsequent.some((event, index) => event.sequence !== targetWorkRevision + index + 1)) {
    return { status: "stale", reason: "Work Event sequence가 연속적이지 않습니다" };
  }
  const types = subsequent.map((event) => event.event_type);
  if (types.length === 1 && types[0] === "verification_recorded") {
    return { status: "allowed", stage: "verification_projection" };
  }
  if (types.length === 2 && types[0] === "verification_recorded" && types[1] === "work_record_finalized") {
    return { status: "allowed", stage: "records_finalize" };
  }
  if (
    types.length === 3 &&
    types[0] === "verification_recorded" &&
    types[1] === "work_record_finalized" &&
    types[2] === "work_state_changed"
  ) {
    return { status: "allowed", stage: "completed" };
  }
  return { status: "stale", reason: `허용되지 않은 Work 후속 사건입니다: ${types.join(",")}` };
}
