import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { WorkRecoveryBundle } from "@massion/work";

import type { AssuranceCheckBinding } from "./binding-store.js";
import { checksumCriterionCoverage, compileAssuranceCriteria } from "./criteria.js";
import { selectAssuranceProfile } from "./profile.js";
import {
  classifyAssuranceFollowUpEvents,
  createAssuranceSnapshot,
  type CreateAssuranceSnapshotInput,
} from "./snapshot.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bundle(): WorkRecoveryBundle {
  return {
    request: {} as WorkRecoveryBundle["request"],
    work: {
      work_id: "work-1",
      organization_id: "organization-1",
      request_id: "request-1",
      status: "verifying",
      revision: 12,
      organization_version_id: "organization-version-1",
      context_version_id: "context-version-1",
      active_plan_version_id: "plan-version-1",
      policy_version_id: "policy-version-1",
      prompt_version_id: "prompt-version-1",
      artifact_version_ids: ["artifact-version-2", "artifact-version-1"],
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
    },
    childWorks: [],
    events: [],
    plans: [
      {
        plan_version_id: "plan-version-1",
        organization_id: "organization-1",
        work_id: "work-1",
        version: 1,
        content_json: '{"acceptanceCriteria":[]}',
        valid: true,
        created_by: "context-strategy",
        created_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    tasks: [
      {
        task_id: "task-2",
        organization_id: "organization-1",
        work_id: "work-1",
        plan_version_id: "plan-version-1",
        title: "B",
        objective: "B",
        acceptance_criteria_json: '["B"]',
        dependency_ids: [],
        status: "cancelled",
        revision: 2,
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T00:00:00.000Z",
      },
      {
        task_id: "task-1",
        organization_id: "organization-1",
        work_id: "work-1",
        plan_version_id: "plan-version-1",
        title: "A",
        objective: "A",
        acceptance_criteria_json: '["A"]',
        dependency_ids: [],
        status: "completed",
        revision: 3,
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    assignments: [
      {
        assignment_id: "assignment-2",
        organization_id: "organization-1",
        work_id: "work-1",
        task_id: "task-1",
        agent_handle: "software-implementation",
        status: "released",
        revision: 2,
        created_by: "user-1",
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T00:00:00.000Z",
      },
      {
        assignment_id: "assignment-1",
        organization_id: "organization-1",
        work_id: "work-1",
        task_id: "task-1",
        agent_handle: "software-implementation",
        status: "completed",
        revision: 1,
        created_by: "user-1",
        created_at: "2026-07-10T00:00:00.000Z",
        updated_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    sessions: [],
    checkpoints: [],
    rooms: [],
    messages: [],
    sharedContextReferences: [],
    leases: [],
    artifacts: [
      {
        artifact_id: "artifact-1",
        organization_id: "organization-1",
        work_id: "work-1",
        kind: "code-change",
        name: "change",
        created_by: "software-implementation",
        created_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    artifactVersions: [
      {
        artifact_version_id: "artifact-version-1",
        artifact_id: "artifact-1",
        organization_id: "organization-1",
        work_id: "work-1",
        version: 1,
        checksum: sha256('{"version":1}'),
        media_type: "application/json",
        content_json: '{"version":1}',
        created_by: "software-implementation",
        created_at: "2026-07-10T00:00:00.000Z",
      },
      {
        artifact_version_id: "artifact-version-2",
        artifact_id: "artifact-1",
        organization_id: "organization-1",
        work_id: "work-1",
        version: 2,
        checksum: sha256('{"version":2}'),
        media_type: "application/json",
        content_json: '{"version":2}',
        created_by: "software-implementation",
        created_at: "2026-07-10T00:00:00.000Z",
      },
    ],
    verifications: [],
    records: [],
  };
}

const profile = selectAssuranceProfile(["code-change"]);
const requiredCriteria = [
  ...profile.criteria.map((criterion) => ({
    criterionKey: criterion.key,
    method: criterion.method,
    requiredEvidenceKinds: criterion.requiredEvidenceKinds,
  })),
  { criterionKey: "task:task-1:0", method: "evidence" as const, requiredEvidenceKinds: ["artifact-version"] },
  { criterionKey: "task:task-2:0", method: "evidence" as const, requiredEvidenceKinds: ["artifact-version"] },
];

function checkBinding(criterion: (typeof requiredCriteria)[number], index: number): AssuranceCheckBinding {
  const common = {
    bindingKey: `check:${String(index)}`,
    criterionKey: criterion.criterionKey,
    executor: { kind: "system_adapter" as const, adapterId: "massion.snapshot-test.v1" },
    requiredEvidenceKinds: criterion.requiredEvidenceKinds,
  };
  if (criterion.method === "test") {
    return {
      ...common,
      kind: "test",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      expectedExitCode: 0,
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
    };
  }
  if (criterion.method === "inspection") {
    return {
      ...common,
      kind: "inspection",
      inspectorProfile: "massion.inspection.security.v1",
      evidenceAllowlist: ["artifact-version"],
      maximumAgeMs: 60_000,
      maximumFindings: 100,
    };
  }
  return {
    ...common,
    kind: "evidence",
    evidenceKinds: criterion.requiredEvidenceKinds,
    maximumAgeMs: 60_000,
  };
}

const bindings = requiredCriteria.map(checkBinding);
const criteria = compileAssuranceCriteria({
  planContentJson: '{"acceptanceCriteria":[]}',
  tasks: [
    { taskId: "task-1", status: "completed", acceptanceCriteriaJson: '["A"]' },
    { taskId: "task-2", status: "cancelled", acceptanceCriteriaJson: '["B"]' },
  ],
  profile,
  bindings: bindings.map((binding) => ({
    criterionKey: binding.criterionKey,
    method: binding.kind,
    requiredEvidenceKinds: binding.requiredEvidenceKinds,
  })),
});

function activeBinding(overrides: Partial<CreateAssuranceSnapshotInput["binding"]> = {}) {
  return {
    bindingVersionId: "binding-1",
    organizationId: "organization-1",
    workId: "work-1",
    planVersionId: "plan-version-1",
    status: "active" as const,
    profileId: "massion.assurance.software-change.v1",
    profileVersion: "1.0.0",
    criteriaChecksum: checksumCriterionCoverage(criteria),
    checksum: "c".repeat(64),
    bindings,
    ...overrides,
  };
}

describe("Assurance snapshot", () => {
  it("Work·Plan·Task·Assignment·Artifact·version reference를 정렬해 canonical hash로 고정한다", () => {
    const input = {
      bundle: bundle(),
      profile: { profileId: "massion.assurance.software-change.v1", version: "1.0.0" },
      binding: activeBinding(),
      criteria,
    };
    const first = createAssuranceSnapshot(input);
    const reordered = bundle();
    reordered.tasks.reverse();
    reordered.assignments.reverse();
    reordered.artifactVersions.reverse();
    const second = createAssuranceSnapshot({ ...input, bundle: reordered });

    expect(second.hash).toBe(first.hash);
    expect(first.material).toMatchObject({
      workId: "work-1",
      workRevision: 12,
      planVersionId: "plan-version-1",
      organizationVersionId: "organization-version-1",
      contextVersionId: "context-version-1",
      policyVersionId: "policy-version-1",
      promptVersionId: "prompt-version-1",
    });
    expect(first.material.artifactVersions[0]).toMatchObject({ kind: "code-change", mediaType: "application/json" });
  });

  it("material input 변경과 잘못된 verifying precondition을 거부하거나 stale hash로 구분한다", () => {
    const source = bundle();
    const common = {
      profile: { profileId: "massion.assurance.software-change.v1", version: "1.0.0" },
      binding: activeBinding(),
      criteria,
    };
    const first = createAssuranceSnapshot({ bundle: source, ...common });
    const changedTask = source.tasks[0];
    if (!changedTask) throw new Error("변경할 Task가 없습니다");
    source.tasks[0] = { ...changedTask, revision: 3 };
    expect(createAssuranceSnapshot({ bundle: source, ...common }).hash).not.toBe(first.hash);

    const runningSource = bundle();
    const running = { ...runningSource, work: { ...runningSource.work, status: "running" as const } };
    expect(() => createAssuranceSnapshot({ bundle: running, ...common })).toThrow("verifying");
    const incomplete = bundle();
    const incompleteTask = incomplete.tasks[0];
    if (!incompleteTask) throw new Error("미완료로 바꿀 Task가 없습니다");
    incomplete.tasks[0] = { ...incompleteTask, status: "running" };
    expect(() => createAssuranceSnapshot({ bundle: incomplete, ...common })).toThrow("completed 또는 cancelled");
    expect(() =>
      createAssuranceSnapshot({
        bundle: bundle(),
        ...common,
        binding: activeBinding({
          bindingVersionId: "binding-other-work",
          organizationId: "organization-other",
          workId: "work-other",
          checksum: "d".repeat(64),
        }),
      }),
    ).toThrow("binding");
    const truncated = criteria.slice(1);
    expect(() =>
      createAssuranceSnapshot({
        bundle: bundle(),
        ...common,
        criteria: truncated,
        binding: activeBinding({ criteriaChecksum: checksumCriterionCoverage(truncated) }),
      }),
    ).toThrow("compile한 criterion");
  });

  it("검증 투영·Records finalize 후속 사건만 material 변경과 구분한다", () => {
    expect(classifyAssuranceFollowUpEvents(12, [{ sequence: 13, event_type: "verification_recorded" }])).toEqual({
      status: "allowed",
      stage: "verification_projection",
    });
    expect(
      classifyAssuranceFollowUpEvents(12, [
        { sequence: 13, event_type: "verification_recorded" },
        { sequence: 14, event_type: "work_record_finalized" },
      ]),
    ).toEqual({ status: "allowed", stage: "records_finalize" });
    expect(
      classifyAssuranceFollowUpEvents(12, [{ sequence: 13, event_type: "artifact_version_created" }]),
    ).toMatchObject({ status: "stale" });
    expect(classifyAssuranceFollowUpEvents(12, [{ sequence: 14, event_type: "verification_recorded" }])).toMatchObject({
      status: "stale",
      reason: expect.stringContaining("연속"),
    });
  });
});
