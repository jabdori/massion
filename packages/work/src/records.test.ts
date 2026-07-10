import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService, type CreateWorkResult } from "./work.js";

describe("Work fork·merge와 완료 기록", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;
  let created: CreateWorkResult;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const organization = await graph.bootstrap(context);
    service = await WorkService.create(database, organizations, graph);
    created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "부모 업무",
      surface: "test",
      organizationVersionId: organization.version.version_id,
      contextVersionId: "context-v1",
      policyVersionId: "policy-v1",
      promptVersionId: "prompt-v1",
    });
  });

  afterEach(async () => database.close());

  it("자식 Work가 version binding과 ArtifactVersion 참조를 고정 상속한다", async () => {
    const artifact = await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "document",
      name: "design.md",
      mediaType: "application/json",
      content: { version: 1 },
    });
    const forked = await service.forkWork(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: artifact.work.revision,
      objective: "독립 조사",
    });
    await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: forked.work.revision,
      artifactId: artifact.artifact.artifact_id,
      kind: "document",
      name: "design.md",
      mediaType: "application/json",
      content: { version: 2 },
    });

    const child = await service.getWork(context, forked.childWork.work_id);
    expect(child).toMatchObject({
      parent_work_id: created.work.work_id,
      organization_version_id: created.work.organization_version_id,
      context_version_id: "context-v1",
      policy_version_id: "policy-v1",
      prompt_version_id: "prompt-v1",
    });
    expect(child.artifact_version_ids).toEqual([artifact.artifactVersion.artifact_version_id]);
  });

  it("충돌 없는 자식 Artifact를 계획 후 부모에 병합하고 자식 기록을 보존한다", async () => {
    const forked = await service.forkWork(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      objective: "구현 분기",
    });
    const childArtifact = await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: forked.childWork.work_id,
      expectedRevision: forked.childWork.revision,
      kind: "code",
      name: "feature.ts",
      mediaType: "application/json",
      content: { code: "ok" },
    });
    const planned = await service.planMerge(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: forked.work.revision,
      childWorkId: forked.childWork.work_id,
    });
    const applied = await service.applyMerge(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      mergePlanId: planned.mergePlan.merge_plan_id,
    });

    expect(planned.mergePlan.status).toBe("ready");
    expect(applied.mergedArtifactVersions[0]?.source_artifact_version_id).toBe(
      childArtifact.artifactVersion.artifact_version_id,
    );
    expect(applied.work.artifact_version_ids).toContain(applied.mergedArtifactVersions[0]?.artifact_version_id);
    expect((await service.getWork(context, forked.childWork.work_id)).work_id).toBe(forked.childWork.work_id);
  });

  it("같은 이름의 다른 Artifact checksum 충돌을 보고하고 merge를 거부한다", async () => {
    const parentArtifact = await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "code",
      name: "shared.ts",
      mediaType: "application/json",
      content: { side: "parent" },
    });
    const forked = await service.forkWork(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: parentArtifact.work.revision,
      objective: "충돌 분기",
    });
    await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: forked.childWork.work_id,
      expectedRevision: forked.childWork.revision,
      kind: "code",
      name: "shared.ts",
      mediaType: "application/json",
      content: { side: "child" },
    });
    const planned = await service.planMerge(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: forked.work.revision,
      childWorkId: forked.childWork.work_id,
    });

    expect(planned.mergePlan.status).toBe("conflicted");
    expect(JSON.parse(planned.mergePlan.conflict_json)).toEqual([expect.objectContaining({ name: "shared.ts" })]);
    await expect(
      service.applyMerge(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: planned.work.revision,
        mergePlanId: planned.mergePlan.merge_plan_id,
      }),
    ).rejects.toThrow("ready 상태");
  });

  it("통과 Verification과 확정 WorkRecord 없이는 completed가 될 수 없다", async () => {
    const plan = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "완료" },
    });
    const planned = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    const task = await service.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      title: "구현",
      objective: "구현",
      acceptanceCriteria: ["통과"],
      dependencyIds: [],
    });
    const assignment = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const ready = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: assignment.work.revision,
      target: "ready",
    });
    const running = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    const taskRunning = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: running.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: 1,
      target: "running",
    });
    const taskCompleted = await service.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: taskRunning.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: taskRunning.task.revision,
      target: "completed",
    });
    const verifying = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: taskCompleted.work.revision,
      target: "verifying",
    });

    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: verifying.work.revision,
        target: "completed",
      }),
    ).rejects.toThrow("Verification");
    await expect(
      service.recordVerification(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: verifying.work.revision,
        verifierId: "assurance",
        passed: true,
        criteria: [{ criterion: "테스트", passed: false }],
        evidenceArtifactVersionIds: [],
      }),
    ).rejects.toThrow("일치하지 않습니다");
    const verification = await service.recordVerification(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: verifying.work.revision,
      verifierId: "assurance",
      passed: true,
      criteria: [{ criterion: "테스트", passed: true }],
      evidenceArtifactVersionIds: [],
    });
    const record = await service.finalizeRecord(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: verification.work.revision,
      summary: "검증 완료",
    });
    const laterVerification = await service.recordVerification(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: record.work.revision,
      verifierId: "assurance",
      passed: true,
      criteria: [{ criterion: "재검증", passed: true }],
      evidenceArtifactVersionIds: [],
    });
    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: laterVerification.work.revision,
        target: "completed",
      }),
    ).rejects.toThrow("WorkRecord");
    const refreshedRecord = await service.finalizeRecord(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: laterVerification.work.revision,
      summary: "재검증 반영 완료",
    });
    const completed = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: refreshedRecord.work.revision,
      target: "completed",
    });

    expect(record.record.finalized).toBe(true);
    expect(refreshedRecord.record.version).toBe(2);
    expect(completed.work.status).toBe("completed");
    await expect(
      service.finalizeRecord(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: completed.work.revision,
        summary: "변경",
      }),
    ).rejects.toThrow("terminal Work");
  });
});
