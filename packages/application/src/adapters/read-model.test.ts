import { ExtensionStore } from "@massion/extension-host";
import { ApprovalStore, createDefaultPolicy, GovernanceService, PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { ApplicationRunStore } from "../run-store.js";
import { SurrealApplicationReadModel } from "./read-model.js";
import { CollaborationGraphSnapshotProjector } from "../snapshot.js";
import { WorkDirectiveStore } from "../work-directive-store.js";

describe("SurrealApplicationReadModel", () => {
  it("실제 공개 domain record를 협업 graph source로 읽고 tenant를 격리한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "read-model@example.com", displayName: "Reader" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    await ExtensionStore.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: "read-model-work-0001",
      text: "실제 read model 검증\n목록에 노출하지 않을 상세 요청",
      surface: "test",
      organizationVersionId: core.version.version_id,
    });
    const plan = await works.addPlan(context, {
      commandId: "read-model-plan-0001",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      content: { objective: "read model 검증" },
    });
    const task = await works.addTask(context, {
      commandId: "read-model-task-0001",
      workId: created.work.work_id,
      expectedRevision: plan.work.revision,
      title: "실제 Task",
      objective: "read model을 검증합니다",
      acceptanceCriteria: ["snapshot에 나타납니다"],
      dependencyIds: [],
    });
    await database.query(
      "UPDATE work_task SET required_capabilities = ['analysis'], recommended_agent_handles = ['analysis'], parallelizable = true WHERE organization_id = $organization_id AND task_id = $task_id;",
      { organization_id: context.organizationId, task_id: task.task.task_id },
    );
    const assignment = await works.assignTask(context, {
      commandId: "read-model-assignment-0001",
      workId: created.work.work_id,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "representative",
    });
    const room = await works.openRoom(context, {
      commandId: "read-model-room-0001",
      workId: created.work.work_id,
      expectedRevision: assignment.work.revision,
      title: "실제 협업방",
      coordinatorHandle: "representative",
      participants: [
        { kind: "agent", subjectId: "representative", role: "coordinator" },
        { kind: "user", subjectId: context.userId, role: "participant" },
      ],
      limits: { maxParallel: 2, maxTokens: 10_000, maxCostMicros: 1_000_000, maxRounds: 10 },
    });
    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const execution = await runtime.createExecution(context, {
      commandId: "read-model-execution-0001",
      workId: created.work.work_id,
      taskId: task.task.task_id,
      agentHandle: "representative",
      modelRoute: "balanced",
      correlationId: "read-model-correlation-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 500,
      input: { request: "실행" },
    });
    await works.postMessage(context, {
      commandId: "read-model-message-0001",
      workId: created.work.work_id,
      roomId: room.room.room_id,
      messageType: "status",
      authorKind: "agent",
      authorId: "representative",
      content: "진행 중입니다",
      taskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      tokenCount: 25,
      costMicros: 125,
    });
    const artifact = await works.createArtifactVersion(context, {
      commandId: "read-model-artifact-0001",
      workId: created.work.work_id,
      expectedRevision: (await works.getWork(context, created.work.work_id)).revision,
      kind: "report",
      name: "이탈 분석 보고서",
      mediaType: "application/json",
      content: { privateRawData: "읽기 모델에서 노출하면 안 됩니다" },
    });
    await database.query(
      "CREATE work_verification CONTENT { verification_id: 'read-model-verification-0001', organization_id: $organization_id, work_id: $work_id, verifier_id: 'assurance', passed: true, criteria_json: '[\"통계 유의성\"]', evidence_artifact_version_ids: [$artifact_version_id], created_at: time::now() };",
      {
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        artifact_version_id: artifact.artifactVersion.artifact_version_id,
      },
    );
    const applicationRuns = await ApplicationRunStore.create(database, organizations);
    const applicationRun = await applicationRuns.start(context, {
      commandId: "read-model-run-0001",
      correlationId: "read-model-run-correlation-0001",
      request: { text: "실제 read model 검증" },
    });
    const claimedRun = await applicationRuns.claim(context, applicationRun.runId);
    if (claimedRun.outcome !== "claimed") throw new Error("Application run을 claim하지 못했습니다");
    await applicationRuns.advance(context, applicationRun.runId, claimedRun.leaseGeneration, {
      stage: "context-strategy",
      workId: created.work.work_id,
    });
    const directives = await WorkDirectiveStore.create(database, organizations);
    const directive = await directives.submit(context, {
      commandId: "read-model-directive-0001",
      correlationId: "read-model-directive-correlation-0001",
      expectedRevision: (await works.getWork(context, created.work.work_id)).revision,
      workId: created.work.work_id,
      runId: applicationRun.runId,
      content: "표본 구간을 추가해 주세요",
      mode: "next-stage",
    });
    const defaults = createDefaultPolicy("personal");
    const policy = await policies.createDraft(context, {
      commandId: "read-model-policy-0001",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(context, {
      commandId: "read-model-policy-activate-0001",
      policyVersionId: policy.policy_version_id,
    });
    const decision = await governance.evaluate(context, {
      commandId: "read-model-decision-0001",
      request: {
        principal: { type: "Human", id: context.userId, organizationId: context.organizationId },
        action: "tool.call",
        resource: { type: "Tool", id: "tool-read-model", organizationId: context.organizationId },
        context: { environment: "local", riskClass: "agent-tool", external: false },
      },
    });
    await approvals.request(context, {
      commandId: "read-model-approval-0001",
      decisionId: decision.decisionId,
      resourceRevision: artifact.work.revision,
      workId: created.work.work_id,
      executionId: execution.execution.execution_id,
      displayPreview: {
        kind: "file-change",
        title: "파일 변경",
        path: "/workspace/src/index.ts",
        summary: "검증 로직 변경",
      },
    });

    const readModel = new SurrealApplicationReadModel(database, organizations);
    const snapshot = await new CollaborationGraphSnapshotProjector(readModel).project(context);
    expect(snapshot.works[0]).toMatchObject({
      workId: created.work.work_id,
      taskIds: [task.task.task_id],
      roomIds: [room.room.room_id],
    });
    expect(snapshot.nodes.find((node) => node.handle === "representative")).toMatchObject({
      currentTaskId: task.task.task_id,
      executionId: execution.execution.execution_id,
      inputTokens: 25,
      costMicros: 125,
    });
    expect(snapshot.rooms[0]).toMatchObject({
      participantIds: expect.arrayContaining([context.userId, "representative"]),
    });
    expect(snapshot.pendingApprovals[0]?.displayPreview).toEqual({
      kind: "file-change",
      path: "/workspace/src/index.ts",
      summary: "검증 로직 변경",
      title: "파일 변경",
    });
    await expect(readModel.works(context)).resolves.toEqual([
      expect.objectContaining({
        workId: created.work.work_id,
        title: "실제 read model 검증",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    ]);
    await expect(readModel.tasks(context)).resolves.toEqual([
      expect.objectContaining({
        taskId: task.task.task_id,
        objective: "read model을 검증합니다",
        acceptanceCriteria: ["snapshot에 나타납니다"],
        dependencyIds: [],
        requiredCapabilities: ["analysis"],
        recommendedAgentHandles: ["analysis"],
        parallelizable: true,
      }),
    ]);
    await expect(readModel.assignments(context)).resolves.toEqual([
      expect.objectContaining({ assignmentId: assignment.assignment.assignment_id }),
    ]);
    await expect(readModel.artifacts?.(context)).resolves.toEqual([
      expect.objectContaining({
        artifactId: artifact.artifact.artifact_id,
        artifactVersionId: artifact.artifactVersion.artifact_version_id,
        name: "이탈 분석 보고서",
        mediaType: "application/json",
      }),
    ]);
    expect(JSON.stringify(await readModel.artifacts?.(context))).not.toContain("privateRawData");
    await expect(readModel.verifications?.(context)).resolves.toEqual([
      expect.objectContaining({
        verificationId: "read-model-verification-0001",
        workId: created.work.work_id,
        passed: true,
        criteria: ["통계 유의성"],
        evidenceArtifactVersionIds: [artifact.artifactVersion.artifact_version_id],
      }),
    ]);
    await expect(readModel.directives?.(context)).resolves.toEqual([
      expect.objectContaining({
        directiveId: directive.directiveId,
        workId: created.work.work_id,
        runId: applicationRun.runId,
        sequence: 1,
        content: "표본 구간을 추가해 주세요",
        mode: "next-stage",
        submittedStage: "context-strategy",
        status: "queued",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    ]);
    await expect(readModel.approvals(context)).resolves.toEqual([
      expect.objectContaining({
        workId: created.work.work_id,
        executionId: execution.execution.execution_id,
        resourceRevision: artifact.work.revision,
        revision: 1,
      }),
    ]);

    const other = await identities.registerPersonalUser({
      email: "read-model-other@example.com",
      displayName: "Other",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(readModel.works(otherContext)).resolves.toEqual([]);
    await expect(readModel.artifacts?.(otherContext)).resolves.toEqual([]);
    await expect(readModel.verifications?.(otherContext)).resolves.toEqual([]);
    await expect(readModel.directives?.(otherContext)).resolves.toEqual([]);
  }, 15_000);
});
