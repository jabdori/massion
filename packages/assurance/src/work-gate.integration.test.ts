import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";
import { WorkAssurancePort, WorkService, type CreateWorkResult } from "@massion/work";

import {
  AssuranceBindingStore,
  AssuranceBootstrap,
  AssuranceRunVerdictReader,
  type AssuranceRunStore,
  type BindingActivationAuthorizer,
} from "./index.js";

describe("Assurance run과 Work 완료 게이트", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let work: WorkService;
  let runs: AssuranceRunStore;
  let runtime: RuntimeExecutionStore;
  let created: CreateWorkResult;
  let planVersionId: string;
  let taskId: string;

  beforeEach(async () => {
    const remoteUrl = process.env.SURREAL_TEST_URL;
    database = await createDatabase({
      url: remoteUrl ?? "mem://",
      namespace: "massion",
      database: remoteUrl ? "assurance_gate" : `assurance_gate_${crypto.randomUUID().replaceAll("-", "")}`,
      ...(remoteUrl ? { authentication: { username: "root", password: "root" } } : {}),
    });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: `owner-${crypto.randomUUID()}@example.com`,
      displayName: "Owner",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    runtime = await RuntimeExecutionStore.create(database, organizations);
    runs = await AssuranceBootstrap.create(database, organizations);
    work = await WorkService.create(database, organizations, graph);
    created = await createVerifyingWork();
  });

  afterEach(async () => database.close());

  async function createVerifyingWork(): Promise<CreateWorkResult> {
    const result = await work.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "완료 게이트 테스트",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    const plan = await work.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: result.work.revision,
      content: { objective: "완료 게이트 검증", acceptanceCriteria: [] },
    });
    planVersionId = plan.plan.plan_version_id;
    const planned = await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    const task = await work.addTask(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: planned.work.revision,
      title: "독립 검증 대상",
      objective: "완료 게이트를 검증합니다",
      acceptanceCriteria: ["독립 검증이 통과해야 합니다"],
      dependencyIds: [],
    });
    taskId = task.task.task_id;
    const assigned = await work.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: task.work.revision,
      taskId,
      agentHandle: "delivery-coordination",
    });
    const ready = await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: assigned.work.revision,
      target: "ready",
    });
    const running = await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    const taskRunning = await work.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: running.work.revision,
      taskId,
      expectedTaskRevision: task.task.revision,
      target: "running",
    });
    const taskCompleted = await work.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: taskRunning.work.revision,
      taskId,
      expectedTaskRevision: taskRunning.task.revision,
      target: "completed",
    });
    const verifying = await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: taskCompleted.work.revision,
      target: "verifying",
    });
    return { ...result, work: verifying.work };
  }

  async function passedRun(target: CreateWorkResult = created): Promise<string> {
    const authorizer: BindingActivationAuthorizer = {
      async authorize(_context, input) {
        const decisionId = `decision:${input.bindingVersionId}`;
        await database.query(
          "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, request_hash: $request_hash, principal_type: 'Human', principal_id: $principal_id, action: 'work.execute', resource_type: 'AssuranceBindingVersion', resource_id: $resource_id, resource_revision: $resource_revision, environment: 'local', risk_class: 'assurance-binding-activation', external: false, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', request_json: '{}', created_at: time::now() };",
          {
            decision_id: decisionId,
            organization_id: _context.organizationId,
            command_id: `${input.commandId}:policy`,
            request_hash: "c".repeat(64),
            principal_id: _context.userId,
            resource_id: input.bindingVersionId,
            resource_revision: input.revision,
          },
        );
        return { decisionId };
      },
    };
    const bindings = await AssuranceBindingStore.create(database, organizations, authorizer, {
      allowedAuthorHandles: ["context-strategy"],
    });
    const draft = await bindings.propose(context, {
      commandId: crypto.randomUUID(),
      workId: target.work.work_id,
      planVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      authorHandle: "context-strategy",
      requiredCriteria: [
        { criterionKey: `task:${taskId}:0`, method: "test" },
        { criterionKey: "profile:acceptance:coverage", method: "evidence" },
      ],
      bindings: [
        {
          bindingKey: "check:implementation",
          criterionKey: `task:${taskId}:0`,
          kind: "test",
          executor: { kind: "system_adapter", adapterId: "massion.command.v1" },
          executable: "pnpm",
          args: ["test"],
          cwd: ".",
          expectedExitCode: 0,
          timeoutMs: 60_000,
          maxOutputBytes: 1_000_000,
          requiredEvidenceKinds: ["command-output"],
        },
        {
          bindingKey: "check:acceptance-coverage",
          criterionKey: "profile:acceptance:coverage",
          kind: "evidence",
          executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
          evidenceKinds: ["check-result"],
          maximumAgeMs: 60_000,
          requiredEvidenceKinds: ["check-result"],
        },
      ],
    });
    const active = await bindings.activate(context, {
      commandId: crypto.randomUUID(),
      bindingVersionId: draft.bindingVersionId,
      expectedRevision: draft.revision,
    });
    const queuedVerifier = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: target.work.work_id,
      agentHandle: "assurance",
      modelRoute: "test:assurance",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "assurance" },
    });
    const runningVerifier = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: queuedVerifier.execution.execution_id,
      expectedVersion: queuedVerifier.execution.version,
      target: "running",
      payload: { started: true },
    });
    const prepared = await runs.prepareSnapshot(context, {
      workId: target.work.work_id,
      targetWorkRevision: target.work.revision,
      planVersionId,
      bindingVersionId: active.bindingVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
    });
    const started = await runs.start(context, {
      commandId: crypto.randomUUID(),
      workId: target.work.work_id,
      targetWorkRevision: target.work.revision,
      planVersionId,
      bindingVersionId: active.bindingVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      verifierHandle: "assurance",
      verifierExecutionId: runningVerifier.execution.execution_id,
      snapshotHash: prepared.snapshot.hash,
      leaseTtlMs: 60_000,
    });
    const running = await runs.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });
    await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: runningVerifier.execution.execution_id,
      expectedVersion: runningVerifier.execution.version,
      target: "succeeded",
      payload: { outputHash: "e".repeat(64) },
    });
    await database.query(
      "UPDATE assurance_criterion SET status = 'passed', updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: started.run.assuranceRunId },
    );
    const passed = await runs.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
      target: "passed",
    });
    return passed.run.assuranceRunId;
  }

  it("0039→0040→0041→0042 순서로 부트스트랩한다", async () => {
    const applied = (await listAppliedMigrations(database))
      .map((migration) => migration.migration_id)
      .filter((migrationId) => ["0039", "0040", "0041", "0042"].some((prefix) => migrationId.startsWith(prefix)));
    expect(applied).toEqual([
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
      "0042-work-assurance-link",
    ]);
  });

  it("실제 terminal passed run만 투영하고 WorkRecord 이후 completed를 허용한다", async () => {
    const assuranceRunId = await passedRun();
    const port = new WorkAssurancePort(database, organizations, new AssuranceRunVerdictReader());
    const projected = await port.projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId,
    });

    await expect(
      work.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: projected.work.revision,
        target: "completed",
      }),
    ).rejects.toThrow("WorkRecord");

    const record = await work.finalizeRecord(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: projected.work.revision,
      summary: "독립 보증 완료",
    });
    const completed = await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: record.work.revision,
      target: "completed",
    });
    const run = await runs.get(context, assuranceRunId);

    expect(projected.verification?.assurance_run_id).toBe(assuranceRunId);
    expect(record.record.verification_ids).toEqual([projected.verification?.verification_id]);
    expect(completed.work.status).toBe("completed");
    expect(run.projectedWorkRevision).toBe(projected.work.revision);
  });

  it("보증 연결이 없는 direct DB completed 우회를 rollback한다", async () => {
    await expect(
      database.query(
        "UPDATE work SET status = 'completed', revision += 1 WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: created.work.work_id },
      ),
    ).rejects.toThrow("Assurance Verification");
    expect((await work.getWork(context, created.work.work_id)).status).toBe("verifying");
  });

  it("존재하지 않는 verifier Runtime Execution으로 run 시작을 거부한다", async () => {
    await expect(
      runs.start(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        targetWorkRevision: created.work.revision,
        planVersionId: "plan-version-1",
        bindingVersionId: "binding-version-1",
        profileId: "software-change",
        profileVersion: "1.0.0",
        verifierHandle: "assurance",
        verifierExecutionId: "nonexistent-self-review-execution",
        snapshotHash: "a".repeat(64),
        leaseTtlMs: 60_000,
      }),
    ).rejects.toThrow("Runtime Execution을 찾을 수 없습니다");
  });

  it("DB Assignment 계보에 assurance contributor가 있으면 self-review run을 거부한다", async () => {
    await database.query(
      "CREATE task_assignment CONTENT { assignment_id: $assignment_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: 'assurance', status: 'released', revision: 1, created_by: $created_by, created_at: time::now(), updated_at: time::now() };",
      {
        assignment_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        task_id: taskId,
        created_by: context.userId,
      },
    );
    await expect(passedRun()).rejects.toThrow("contributor");
  });

  it("일반 material Artifact는 succeeded Runtime Execution provenance가 있어야 run에 포함된다", async () => {
    const queued = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      agentHandle: "evidence-research",
      modelRoute: "test:evidence",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "artifact" },
    });
    const running = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: queued.execution.execution_id,
      expectedVersion: queued.execution.version,
      target: "running",
      payload: { started: true },
    });
    const succeeded = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: running.execution.execution_id,
      expectedVersion: running.execution.version,
      target: "succeeded",
      payload: { output: "artifact" },
    });
    const artifact = await work.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "document",
      name: "runtime-evidence.json",
      mediaType: "application/json",
      content: { evidence: true },
      creatorAgentHandle: "evidence-research",
      creatorExecutionId: succeeded.execution.execution_id,
    });
    await expect(
      database.query(
        "UPDATE artifact_version SET content_json = '{\"tampered\":true}' WHERE organization_id = $organization_id AND artifact_version_id = $artifact_version_id;",
        {
          organization_id: context.organizationId,
          artifact_version_id: artifact.artifactVersion.artifact_version_id,
        },
      ),
    ).rejects.toThrow("immutable");
    created = { ...created, work: artifact.work };

    await expect(passedRun()).resolves.toEqual(expect.any(String));
  });

  it("Runtime provenance가 없는 일반 material Artifact는 run 시작을 거부한다", async () => {
    const artifact = await work.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "document",
      name: "unbound-evidence.json",
      mediaType: "application/json",
      content: { evidence: false },
    });
    created = { ...created, work: artifact.work };

    await expect(passedRun()).rejects.toThrow("Runtime provenance");
  });

  it("run 시작 뒤 Work revision 없이 Task material이 변조돼도 투영을 거부한다", async () => {
    const assuranceRunId = await passedRun();
    await database.query(
      "UPDATE work_task SET acceptance_criteria_json = '[\"변조된 기준\"]' WHERE organization_id = $organization_id AND task_id = $task_id;",
      { organization_id: context.organizationId, task_id: taskId },
    );

    await expect(
      new WorkAssurancePort(database, organizations, new AssuranceRunVerdictReader()).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId,
      }),
    ).rejects.toThrow("snapshot");
  });

  it("이전 verification-evidence를 검증하되 contributor에서 제외해 새 attempt를 허용한다", async () => {
    const firstRunId = await passedRun();
    const firstProjection = await new WorkAssurancePort(
      database,
      organizations,
      new AssuranceRunVerdictReader(),
    ).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: firstRunId,
    });
    created = { ...created, work: firstProjection.work };

    const secondRunId = await passedRun();
    expect(secondRunId).not.toBe(firstRunId);
  });

  it("terminal run의 binding이 더 이상 active가 아니면 투영을 거부한다", async () => {
    const assuranceRunId = await passedRun();
    const run = await runs.get(context, assuranceRunId);
    await database.query(
      "UPDATE assurance_binding_version SET status = 'superseded', revision += 1, active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
      { organization_id: context.organizationId, binding_version_id: run.bindingVersionId },
    );

    await expect(
      new WorkAssurancePort(database, organizations, new AssuranceRunVerdictReader()).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId,
      }),
    ).rejects.toThrow("활성 Assurance binding");
    const [artifacts] = await database.query<[unknown[]]>(
      "SELECT * FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(artifacts).toHaveLength(0);
  });

  it("WorkVerification linkage 변경을 즉시 rollback한다", async () => {
    const assuranceRunId = await passedRun();
    const projected = await new WorkAssurancePort(
      database,
      organizations,
      new AssuranceRunVerdictReader(),
    ).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId,
    });
    await expect(
      database.query(
        "UPDATE work_verification SET snapshot_hash = $snapshot_hash WHERE organization_id = $organization_id AND verification_id = $verification_id;",
        {
          snapshot_hash: "d".repeat(64),
          organization_id: context.organizationId,
          verification_id: projected.verification?.verification_id,
        },
      ),
    ).rejects.toThrow("immutable");
    const [verifications] = await database.query<[{ snapshot_hash: string }[]]>(
      "SELECT snapshot_hash FROM work_verification WHERE organization_id = $organization_id AND verification_id = $verification_id;",
      {
        organization_id: context.organizationId,
        verification_id: projected.verification?.verification_id,
      },
    );
    expect(verifications[0]?.snapshot_hash).toBe(projected.verification?.snapshot_hash);
  });

  it("판정 투영 뒤 material 변경이 끼면 새 WorkRecord로도 completed가 될 수 없다", async () => {
    const assuranceRunId = await passedRun();
    const projected = await new WorkAssurancePort(
      database,
      organizations,
      new AssuranceRunVerdictReader(),
    ).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId,
    });
    const changed = await work.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: projected.work.revision,
      kind: "document",
      name: "late-material-change.json",
      mediaType: "application/json",
      content: { changed: true },
    });
    const record = await work.finalizeRecord(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: changed.work.revision,
      summary: "오래된 판정 뒤 기록",
    });

    await expect(
      work.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: record.work.revision,
        target: "completed",
      }),
    ).rejects.toThrow("Verification");
    expect((await work.getWork(context, created.work.work_id)).status).toBe("verifying");
  });
});
