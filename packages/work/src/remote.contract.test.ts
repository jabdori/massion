import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";

import { WorkService } from "./work.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote Work contract", () => {
  remoteTest("원격 SurrealDB에서 Work·Task·협업·fork·merge를 원자 적용한다", async () => {
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: `work_${crypto.randomUUID().replaceAll("-", "")}`,
      authentication: { username: "root", password: "root" },
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const graphState = await graph.bootstrap(context);
    const service = await WorkService.create(database, organizations, graph);
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "remote",
      surface: "contract",
      organizationVersionId: graphState.version.version_id,
    });
    const plan = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "remote" },
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
      title: "Remote",
      objective: "Remote",
      acceptanceCriteria: ["pass"],
      dependencyIds: [],
    });
    const assigned = await service.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const room = await service.openRoom(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: assigned.work.revision,
      title: "Remote Room",
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        { kind: "agent", subjectId: "representative", role: "coordinator" },
      ],
      limits: { maxParallel: 2, maxTokens: 100, maxCostMicros: 100, maxRounds: 5 },
    });
    await Promise.all(
      ["one", "two"].map((content) =>
        service.postMessage(context, {
          commandId: crypto.randomUUID(),
          workId: created.work.work_id,
          roomId: room.room.room_id,
          messageType: "proposal",
          authorKind: "user",
          authorId: context.userId,
          content,
          tokenCount: 1,
          costMicros: 1,
        }),
      ),
    );
    const current = await service.getWork(context, created.work.work_id);
    const forked = await service.forkWork(context, {
      commandId: crypto.randomUUID(),
      workId: current.work_id,
      expectedRevision: current.revision,
      objective: "child",
    });
    const childArtifact = await service.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: forked.childWork.work_id,
      expectedRevision: forked.childWork.revision,
      kind: "code",
      name: "remote.ts",
      mediaType: "application/json",
      content: { remote: true },
    });
    const merge = await service.planMerge(context, {
      commandId: crypto.randomUUID(),
      workId: current.work_id,
      expectedRevision: forked.work.revision,
      childWorkId: forked.childWork.work_id,
    });
    const applied = await service.applyMerge(context, {
      commandId: crypto.randomUUID(),
      workId: current.work_id,
      expectedRevision: merge.work.revision,
      mergePlanId: merge.mergePlan.merge_plan_id,
    });

    expect(
      (await service.listMessages(context, created.work.work_id, room.room.room_id)).map((message) => message.sequence),
    ).toEqual([1, 2]);
    expect(applied.mergedArtifactVersions[0]?.source_artifact_version_id).toBe(
      childArtifact.artifactVersion.artifact_version_id,
    );
    expect(await service.auditWork(context, created.work.work_id)).toEqual([]);
  });
});
