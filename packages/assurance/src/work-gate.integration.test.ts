import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import {
  createBackup,
  createDatabase,
  listAppliedMigrations,
  restoreBackup,
  type MassionDatabase,
  type QueryExecutor,
} from "@massion/storage";
import { WorkAssurancePort, WorkService, type CreateWorkResult } from "@massion/work";

import {
  AssuranceBindingStore,
  AssuranceBootstrap,
  AssuranceCheckStore,
  AssuranceRunVerdictReader,
  type BindingActivationAuthorizer,
  type TrustedAssuranceCheckExecutor,
} from "./index.js";
import * as publicApi from "./index.js";
import { AssuranceRunStore } from "./run-store.js";
import { AssuranceService, DatabaseAssuranceDecisionSource, createAssuranceServiceTestHarness } from "./service.js";

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
  let contributorExecutionId: string;
  let materialArtifactVersionId: string;
  let checkEvidenceArtifactVersionId: string;

  beforeEach(async () => {
    const remoteUrl = process.env.SURREAL_TEST_URL;
    if (remoteUrl) {
      const sqlUrl = remoteUrl
        .replace(/^ws:/u, "http:")
        .replace(/^wss:/u, "https:")
        .replace(/\/rpc$/u, "/sql");
      const provisioned = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
          accept: "application/json",
          "content-type": "text/plain",
        },
        body: "DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; REMOVE DATABASE IF EXISTS assurance_gate; DEFINE DATABASE assurance_gate;",
      });
      if (!provisioned.ok) {
        throw new Error(`SurrealDB 원격 테스트 프로비저닝 실패: ${String(provisioned.status)}`);
      }
    }
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
    await AssuranceBootstrap.create(database, organizations);
    runs = await AssuranceRunStore.create(database, organizations);
    work = await WorkService.create(database, organizations, graph);
    created = await createVerifyingWork();
  });

  afterEach(async () => database.close());

  async function createRestoreTarget(label: string): Promise<MassionDatabase> {
    const databaseName = `${label}_${crypto.randomUUID().replaceAll("-", "")}`;
    const remoteUrl = process.env.SURREAL_TEST_URL;
    if (remoteUrl) {
      const sqlUrl = remoteUrl
        .replace(/^ws:/u, "http:")
        .replace(/^wss:/u, "https:")
        .replace(/\/rpc$/u, "/sql");
      const provisioned = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
          accept: "application/json",
          "content-type": "text/plain",
        },
        body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`,
      });
      if (!provisioned.ok) throw new Error(`복원 DB 프로비저닝 실패: ${String(provisioned.status)}`);
    }
    return await createDatabase({
      url: remoteUrl ?? "mem://",
      namespace: "massion",
      database: databaseName,
      ...(remoteUrl ? { authentication: { username: "root", password: "root" } } : {}),
    });
  }

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
    const queuedContributor = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      taskId,
      agentHandle: "delivery-coordination",
      modelRoute: "test:delivery",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "delivery" },
    });
    contributorExecutionId = queuedContributor.execution.execution_id;
    const runningContributor = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: contributorExecutionId,
      expectedVersion: queuedContributor.execution.version,
      target: "running",
      payload: { started: true },
    });
    await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: contributorExecutionId,
      expectedVersion: runningContributor.execution.version,
      target: "succeeded",
      payload: { output: "delivery complete" },
    });
    const material = await work.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: running.work.revision,
      kind: "report",
      name: "delivery-result.json",
      mediaType: "application/json",
      content: { result: "검증 대상 산출물" },
      creatorAgentHandle: "delivery-coordination",
      creatorExecutionId: contributorExecutionId,
    });
    materialArtifactVersionId = material.artifactVersion.artifact_version_id;
    const taskRunning = await work.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId: result.work.work_id,
      expectedRevision: material.work.revision,
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

  async function passedRun(
    target: CreateWorkResult = created,
    expectedDecision: "passed" | "failed" | "blocked" = "passed",
    commandOutcome: "passed" | "failed" | "blocked" = "passed",
    omitAcceptanceCheck = false,
    decisionService?: AssuranceService,
  ): Promise<string> {
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
    const checkArtifactId = crypto.randomUUID();
    checkEvidenceArtifactVersionId = crypto.randomUUID();
    const checkEvidenceContent = '{"result":"check-only evidence"}';
    await database.query(
      "CREATE work_artifact CONTENT { artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, kind: 'command-output', name: $name, created_by: $created_by, created_at: time::now() }; CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $checksum, media_type: 'application/json', content_json: $content_json, created_by: $created_by, creator_agent_handle: 'delivery-coordination', creator_execution_id: $creator_execution_id, created_at: time::now() };",
      {
        artifact_id: checkArtifactId,
        artifact_version_id: checkEvidenceArtifactVersionId,
        organization_id: context.organizationId,
        work_id: target.work.work_id,
        name: `check-output-${started.run.assuranceRunId}.json`,
        checksum: createHash("sha256").update(checkEvidenceContent).digest("hex"),
        content_json: checkEvidenceContent,
        created_by: context.userId,
        creator_execution_id: contributorExecutionId,
      },
    );
    const [criteria] = await database.query<[{ criterion_id: string; criterion_key: string }[]]>(
      "SELECT criterion_id, criterion_key FROM assurance_criterion WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: started.run.assuranceRunId },
    );
    let trustedExecutionCount = 0;
    const trustedExecutor: TrustedAssuranceCheckExecutor = {
      adapterId: "massion.command.v1",
      async execute() {
        trustedExecutionCount += 1;
        return {
          status: commandOutcome,
          outputHash: "e".repeat(64),
          summary: "fresh workspace command passed",
          toolName: "pnpm",
          toolVersion: "10.30.3",
          durationMs: 1,
          artifactVersionIds: [checkEvidenceArtifactVersionId],
        };
      },
    };
    const checks = new AssuranceCheckStore(database, organizations, { trustedExecutors: [trustedExecutor] });
    const peerChecks = new AssuranceCheckStore(database, organizations, { trustedExecutors: [trustedExecutor] });
    const orderedCriteria = [...criteria].sort(
      (left, right) =>
        Number(left.criterion_key === "profile:acceptance:coverage") -
        Number(right.criterion_key === "profile:acceptance:coverage"),
    );
    for (const criterion of orderedCriteria) {
      const acceptance = criterion.criterion_key === "profile:acceptance:coverage";
      if (!acceptance) {
        const checkInput = {
          commandId: crypto.randomUUID(),
          workId: target.work.work_id,
          assuranceRunId: started.run.assuranceRunId,
          criterionId: criterion.criterion_id,
          bindingKey: "check:implementation",
          artifactVersionIds: [checkEvidenceArtifactVersionId],
        };
        const [first, deduplicated] = await Promise.all([
          checks.record(context, checkInput),
          peerChecks.record(context, { ...checkInput, commandId: crypto.randomUUID() }),
        ]);
        expect(deduplicated.check.checkId).toBe(first.check.checkId);
        const replayedWithNewCommand = await checks.record(context, {
          ...checkInput,
          commandId: crypto.randomUUID(),
        });
        expect(replayedWithNewCommand.check.checkId).toBe(first.check.checkId);
        expect(trustedExecutionCount).toBe(1);
        continue;
      }
      if (omitAcceptanceCheck) continue;
      await checks.record(context, {
        commandId: crypto.randomUUID(),
        workId: target.work.work_id,
        assuranceRunId: started.run.assuranceRunId,
        criterionId: criterion.criterion_id,
        bindingKey: "check:acceptance-coverage",
      });
    }
    const passed = await (decisionService ?? (await AssuranceService.create(database, organizations))).decide(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
    });
    expect(passed.decision.status, JSON.stringify(passed.decision)).toBe(expectedDecision);
    return passed.run.assuranceRunId;
  }

  it("0039→0040→0041→0042→0043→0045→0046 순서로 부트스트랩한다", async () => {
    const applied = (await listAppliedMigrations(database))
      .map((migration) => migration.migration_id)
      .filter((migrationId) =>
        ["0039", "0040", "0041", "0042", "0043", "0045", "0046"].some((prefix) => migrationId.startsWith(prefix)),
      );
    expect(applied).toEqual([
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
      "0042-work-assurance-link",
      "0043-assurance-evidence-integrity",
      "0045-assurance-decision-evidence",
      "0046-assurance-recovery-metric",
    ]);
  });

  it("공개 API는 caller가 terminal run verdict를 직접 전이하지 못하게 한다", async () => {
    const publicRuns = await AssuranceBootstrap.create(database, organizations);

    expect("AssuranceRunStore" in publicApi).toBe(false);
    expect("AssuranceService" in publicApi).toBe(false);
    expect("createAssuranceServiceTestHarness" in publicApi).toBe(false);
    expect("transition" in publicRuns).toBe(false);
    expect("decide" in publicRuns).toBe(true);
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
    expect(await (await AssuranceBootstrap.create(database, organizations)).auditCompletedWorks(context)).toEqual([]);
  });

  it("completed Work backup을 빈 DB에 복원해 exact Assurance 계보를 감사하고 변조 backup은 거부한다", async () => {
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
    const record = await work.finalizeRecord(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: projected.work.revision,
      summary: "복원 준수 감사",
    });
    await work.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: record.work.revision,
      target: "completed",
    });
    const backup = await createBackup(database);

    const restored = await createRestoreTarget("assurance_restore_valid");
    try {
      await restoreBackup(restored, backup);
      const restoredOrganizations = await OrganizationService.create(restored);
      const restoredGateway = await AssuranceBootstrap.create(restored, restoredOrganizations);
      await expect(restoredGateway.assertRestoredCompliance(context)).resolves.toBeUndefined();
    } finally {
      await restored.close();
    }

    const mutateLine = (
      table: string,
      transform: (line: string) => string,
      match: (line: string) => boolean = () => true,
    ) => {
      const lines = backup.sql.split("\n");
      const index = lines.findIndex((line) => line.includes(`id: ${table}:`) && match(line));
      if (index < 0) throw new Error(`backup에서 ${table} record를 찾을 수 없습니다`);
      const original = lines[index] ?? "";
      const changed = transform(original);
      if (changed === original) throw new Error(`${table} backup 변조가 적용되지 않았습니다`);
      lines[index] = changed;
      const sql = lines.join("\n");
      return {
        ...backup,
        manifest: {
          ...backup.manifest,
          sql_sha256: createHash("sha256").update(sql).digest("hex"),
        },
        sql,
      };
    };
    const replace = (source: string, before: string, after: string): string => {
      if (!source.includes(before)) throw new Error(`backup 변조 대상을 찾을 수 없습니다: ${before}`);
      return source.replace(before, after);
    };
    const mutateArtifactContent = (line: string, marker: string, before: string, after: string): string => {
      const records = line.split(" }, { ");
      const index = records.findIndex((record) => record.includes(marker));
      if (index < 0) throw new Error(`Artifact record를 찾을 수 없습니다: ${marker}`);
      const record = records[index] ?? "";
      const content = /content_json: '([^']*)'/u.exec(record)?.[1];
      if (!content) throw new Error("Artifact content_json을 찾을 수 없습니다");
      const changedContent = replace(content, before, after);
      records[index] = record
        .replace(content, changedContent)
        .replace(
          /checksum: '[a-f0-9]{64}'/u,
          `checksum: '${createHash("sha256").update(changedContent).digest("hex")}'`,
        );
      return records.join(" }, { ");
    };
    const removeRecord = (table: string, marker: string) =>
      mutateLine(table, (line) => {
        const prefix = "INSERT [ {";
        const suffix = " } ];";
        if (!line.startsWith(prefix) || !line.endsWith(suffix)) {
          throw new Error(`${table} backup INSERT 형식이 올바르지 않습니다`);
        }
        const records = line.slice(prefix.length, -suffix.length).split(" }, { ");
        const index = records.findIndex((record) => record.includes(marker));
        if (index < 0) throw new Error(`${table} 삭제 대상을 찾을 수 없습니다: ${marker}`);
        records.splice(index, 1);
        return `${prefix}${records.join(" }, { ")}${suffix}`;
      });
    const inactiveAssuranceNode = mutateLine(
      "organization_node",
      (line) => {
        const records = line.split(" }, { ");
        const index = records.findIndex((record) => record.includes("handle: 'assurance'"));
        if (index < 0) throw new Error("Assurance OrganizationNode를 찾을 수 없습니다");
        records[index] = replace(records[index] ?? "", "status: 'active'", "status: 'inactive'");
        return records.join(" }, { ");
      },
      (line) => line.includes("handle: 'assurance'"),
    );
    const reorganized = await createRestoreTarget("assurance_restore_reorganized");
    try {
      await restoreBackup(reorganized, inactiveAssuranceNode);
      const reorganizedOrganizations = await OrganizationService.create(reorganized);
      const reorganizedGateway = await AssuranceBootstrap.create(reorganized, reorganizedOrganizations);
      await expect(reorganizedGateway.auditCompletedWorks(context)).resolves.toEqual([]);
    } finally {
      await reorganized.close();
    }
    const legacySnapshot = mutateLine("assurance_event", (line) => {
      const records = line.split(" }, { ");
      const index = records.findIndex((record) => record.includes("event_type: 'assurance_run_started'"));
      if (index < 0) throw new Error("Assurance start Event를 찾을 수 없습니다");
      const record = records[index] ?? "";
      const changed = record.replace(/"snapshotCanonicalJson":"(?:\\.|[^"\\])*",?/u, "");
      if (changed === record) throw new Error("Assurance start Event snapshot manifest를 찾을 수 없습니다");
      records[index] = changed;
      return records.join(" }, { ");
    });
    const legacy = await createRestoreTarget("assurance_restore_legacy_snapshot");
    try {
      await restoreBackup(legacy, legacySnapshot);
      const legacyOrganizations = await OrganizationService.create(legacy);
      const legacyGateway = await AssuranceBootstrap.create(legacy, legacyOrganizations);
      await expect(legacyGateway.auditCompletedWorks(context)).resolves.toEqual([]);
    } finally {
      await legacy.close();
    }
    const corruptions = [
      {
        label: "Plan content",
        backup: mutateLine("plan_version", (line) => replace(line, "완료 게이트 검증", "변조된 완료 게이트 검증")),
      },
      {
        label: "Task acceptance criteria",
        backup: mutateLine("work_task", (line) =>
          replace(line, "독립 검증이 통과해야 합니다", "변조된 독립 검증이 통과해야 합니다"),
        ),
      },
      {
        label: "Assignment",
        backup: mutateLine("task_assignment", (line) =>
          replace(line, "agent_handle: 'delivery-coordination'", "agent_handle: 'context-strategy'"),
        ),
      },
      {
        label: "Assurance binding",
        backup: mutateLine("assurance_binding_version", (line) =>
          replace(line, '"executable":"pnpm"', '"executable":"npm"'),
        ),
      },
      {
        label: "material Artifact",
        backup: mutateLine(
          "artifact_version",
          (line) =>
            mutateArtifactContent(
              line,
              `artifact_version_id: '${materialArtifactVersionId}'`,
              "검증 대상 산출물",
              "변조된 산출물",
            ),
          (line) => line.includes(`artifact_version_id: '${materialArtifactVersionId}'`),
        ),
      },
      {
        label: "check ArtifactVersion reference",
        backup: removeRecord("artifact_version", `artifact_version_id: '${checkEvidenceArtifactVersionId}'`),
      },
      {
        label: "evidence verifier metadata",
        backup: mutateLine(
          "artifact_version",
          (line) =>
            mutateArtifactContent(
              line,
              "application/vnd.massion.assurance-evidence+json",
              '"verifierHandle":"assurance"',
              '"verifierHandle":"governance"',
            ),
          (line) => line.includes("application/vnd.massion.assurance-evidence+json"),
        ),
      },
      {
        label: "evidence hash",
        backup: mutateLine(
          "artifact_version",
          (line) =>
            mutateArtifactContent(
              line,
              "application/vnd.massion.assurance-evidence+json",
              /"evidenceHash":"[a-f0-9]{64}"/u.exec(line)?.[0] ?? "missing-evidence-hash",
              `"evidenceHash":"${"f".repeat(64)}"`,
            ),
          (line) => line.includes("application/vnd.massion.assurance-evidence+json"),
        ),
      },
      {
        label: "WorkVerification criteria",
        backup: mutateLine("work_verification", (line) => replace(line, '"status":"passed"', '"status":"failed"')),
      },
      {
        label: "run completedAt",
        backup: mutateLine("assurance_run", (line) => {
          const completedAt = /completed_at: d'[^']+'/u.exec(line)?.[0];
          if (!completedAt) throw new Error("Assurance run completed_at을 찾을 수 없습니다");
          return replace(line, completedAt, "completed_at: d'2026-01-01T00:00:00Z'");
        }),
      },
      {
        label: "decision evidence hash",
        backup: mutateLine("assurance_run", (line) => {
          const hash = /decision_evidence_hash: '[a-f0-9]{64}'/u.exec(line)?.[0];
          if (!hash) throw new Error("Assurance run decision_evidence_hash를 찾을 수 없습니다");
          return replace(line, hash, `decision_evidence_hash: '${"0".repeat(64)}'`);
        }),
      },
      {
        label: "check executor independence",
        backup: mutateLine(
          "assurance_check",
          (line) =>
            replace(
              line,
              "system_adapter_id: 'massion.command.v1'",
              `executor_execution_id: '${contributorExecutionId}', executor_handle: 'delivery-coordination'`,
            ),
          (line) => line.includes("command_key: 'check:implementation'"),
        ),
      },
    ];
    for (const corruption of corruptions) {
      const target = await createRestoreTarget(`assurance_restore_${corruption.label.replaceAll(" ", "_")}`);
      try {
        await restoreBackup(target, corruption.backup);
        const targetOrganizations = await OrganizationService.create(target);
        await expect(
          AssuranceBootstrap.create(target, targetOrganizations),
          `${corruption.label} 변조를 활성화 전에 거부해야 합니다`,
        ).rejects.toThrow("Assurance 준수 위반");
      } finally {
        await target.close();
      }
    }

    const verificationLine = backup.sql
      .split("\n")
      .find(
        (line) =>
          line.startsWith("INSERT [") &&
          /\bid: work_verification:/u.test(line) &&
          !/\bid: work_event:/u.test(line) &&
          line.includes("passed: true"),
      );
    if (!verificationLine) throw new Error("backup의 passed WorkVerification을 찾을 수 없습니다");
    const verificationRecordOffset = verificationLine.lastIndexOf("id: work_verification:");
    const passedOffset = verificationLine.indexOf("passed: true", verificationRecordOffset);
    if (passedOffset < 0) throw new Error("backup WorkVerification passed field를 찾을 수 없습니다");
    const corruptedLine = `${verificationLine.slice(0, passedOffset)}passed: false${verificationLine.slice(passedOffset + "passed: true".length)}`;
    const corruptedSql = backup.sql.replace(verificationLine, corruptedLine);
    const corrupted = {
      ...backup,
      manifest: {
        ...backup.manifest,
        sql_sha256: createHash("sha256").update(corruptedSql).digest("hex"),
      },
      sql: corruptedSql,
    };
    const invalid = await createRestoreTarget("assurance_restore_invalid");
    try {
      await restoreBackup(invalid, corrupted);
      const invalidOrganizations = await OrganizationService.create(invalid);
      const [invalidWorks] = await invalid.query<[{ work_id: string; status: string }[]]>(
        "SELECT work_id, status FROM work WHERE organization_id = $organization_id AND status = 'completed';",
        { organization_id: context.organizationId },
      );
      const [invalidVerifications] = await invalid.query<[{ passed: boolean }[]]>(
        "SELECT passed FROM work_verification WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      );
      expect(invalidWorks).toHaveLength(1);
      expect(invalidVerifications).toEqual([{ passed: false }]);
      await expect(AssuranceBootstrap.create(invalid, invalidOrganizations)).rejects.toThrow("Assurance 준수 위반");
    } finally {
      await invalid.close();
    }
  }, 20_000);

  it.each([
    { verdict: "passed" as const, check: "passed" as const, workStatus: "verifying" },
    { verdict: "failed" as const, check: "failed" as const, workStatus: "failed" },
  ])(
    "실제 $verdict terminal 직후 recovery를 한 번만 원장에 기록하고 Work를 조정한다",
    async ({ verdict, check, workStatus }) => {
      const assuranceRunId = await passedRun(created, verdict, check);
      const gateway = await AssuranceBootstrap.create(database, organizations);
      const commandId = crypto.randomUUID();
      const input = { commandId, assuranceRunId };

      const [first, concurrent] = await Promise.all([gateway.recover(context, input), gateway.recover(context, input)]);
      const replayed = await gateway.recover(context, input);
      await expect(gateway.recover(context, { commandId, assuranceRunId: "different-run" })).rejects.toThrow(
        "다른 Assurance recovery 명령",
      );
      const currentWork = await work.getWork(context, created.work.work_id);
      const [events] = await database.query<[{ event_type: string }[]]>(
        "SELECT event_type FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND event_type = 'assurance_run_recovered';",
        { organization_id: context.organizationId, assurance_run_id: assuranceRunId },
      );
      const [metricEvents] = await database.query<[{ metric_event_id: string }[]]>(
        "SELECT metric_event_id FROM assurance_metric_event WHERE organization_id = $organization_id AND metric_name = 'assurance_recovery_total';",
        { organization_id: context.organizationId },
      );
      const [runMetricNames] = await database.query<[{ metric_name: string }[]]>(
        "SELECT metric_name FROM assurance_metric_event WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      );

      expect(first.result).toBe("projected");
      expect(concurrent).toEqual(first);
      expect(replayed).toEqual(first);
      expect(first.run.projectedWorkRevision).toBe(created.work.revision + 1);
      expect(currentWork.status).toBe(workStatus);
      expect(events).toHaveLength(1);
      expect(metricEvents).toHaveLength(1);
      expect(new Set(runMetricNames.map((metric) => metric.metric_name))).toEqual(
        new Set([
          "assurance_run_duration_ms",
          "assurance_verdict_total",
          "assurance_criterion_total",
          "assurance_check_total",
          "assurance_recovery_total",
        ]),
      );
    },
  );

  it("DB criterion 확정 실패와 필수 check 누락을 각각 failed·blocked로 판정한다", async () => {
    const failedRunId = await passedRun(created, "failed", "failed");
    expect((await runs.get(context, failedRunId)).status).toBe("failed");

    created = await createVerifyingWork();
    const blockedRunId = await passedRun(created, "blocked", "passed", true);
    expect((await runs.get(context, blockedRunId)).status).toBe("blocked");
    const recovered = await (
      await AssuranceBootstrap.create(database, organizations)
    ).recover(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: blockedRunId,
    });
    const [blockedMetrics] = await database.query<[{ dimensions_json: string }[]]>(
      "SELECT dimensions_json FROM assurance_metric_event WHERE organization_id = $organization_id AND metric_name = 'assurance_blocked_total';",
      { organization_id: context.organizationId },
    );
    expect(recovered.result).toBe("terminal_unchanged");
    expect(blockedMetrics).toEqual([{ dimensions_json: '{"reason":"evidence"}' }]);
  });

  it("판정 snapshot 뒤 critical finding이 commit돼도 evidence guard 충돌 재시도로 failed가 된다", async () => {
    let releaseRead = (): void => undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let notifyRead = (): void => undefined;
    const readObserved = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    class PausedDecisionSource extends DatabaseAssuranceDecisionSource {
      public assuranceRunId?: string;
      private paused = false;

      public override async readInTransaction(
        sourceContext: TenantContext,
        assuranceRunId: string,
        transaction: QueryExecutor,
      ) {
        const result = await super.readInTransaction(sourceContext, assuranceRunId, transaction);
        this.assuranceRunId = assuranceRunId;
        if (!this.paused) {
          this.paused = true;
          notifyRead();
          await readReleased;
        }
        return result;
      }
    }
    const source = new PausedDecisionSource(database, organizations, runs);
    const service = createAssuranceServiceTestHarness(source, runs, { database, source, runs });
    const decision = passedRun(created, "failed", "passed", false, service);
    await readObserved;
    if (!source.assuranceRunId) throw new Error("경쟁 테스트 Assurance run ID가 없습니다");
    const [criteria] = await database.query<[{ criterion_id: string }[]]>(
      "SELECT criterion_id FROM assurance_criterion WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: context.organizationId, assurance_run_id: source.assuranceRunId },
    );
    const criterion = criteria[0];
    if (!criterion) throw new Error("경쟁 테스트 criterion이 없습니다");
    await database.query(
      "CREATE assurance_finding CONTENT { finding_id: $finding_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, fingerprint: $fingerprint, category: 'security', severity: 'critical', status: 'open', message: '판정 중 발견된 권한 우회', evidence_reference_ids: [], source_tool: 'race-test', source_rule: 'RACE-001', control_references: [], created_at: time::now() };",
      {
        finding_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        assurance_run_id: source.assuranceRunId,
        criterion_id: criterion.criterion_id,
        fingerprint: "9".repeat(64),
      },
    );
    releaseRead();

    const assuranceRunId = await decision;
    expect((await runs.get(context, assuranceRunId)).status).toBe("failed");
  });

  it("terminal 판정 뒤 evidence guard가 바뀌면 Work 투영을 fail-closed 거부한다", async () => {
    const assuranceRunId = await passedRun();
    const [criteria] = await database.query<[{ criterion_id: string }[]]>(
      "SELECT criterion_id FROM assurance_criterion WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: context.organizationId, assurance_run_id: assuranceRunId },
    );
    const criterion = criteria[0];
    if (!criterion) throw new Error("drift 테스트 criterion이 없습니다");
    await database.query(
      "CREATE assurance_finding CONTENT { finding_id: $finding_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, fingerprint: $fingerprint, category: 'security', severity: 'critical', status: 'open', message: 'terminal 이후 evidence drift', evidence_reference_ids: [], source_tool: 'drift-test', source_rule: 'DRIFT-001', control_references: [], created_at: time::now() };",
      {
        finding_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        assurance_run_id: assuranceRunId,
        criterion_id: criterion.criterion_id,
        fingerprint: "8".repeat(64),
      },
    );

    await expect(
      new WorkAssurancePort(database, organizations, new AssuranceRunVerdictReader()).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId,
      }),
    ).rejects.toThrow("evidence가 변경");
  });

  it("Work 투영 snapshot 도중 Task material이 commit돼도 guard 충돌 재시도로 거부한다", async () => {
    const assuranceRunId = await passedRun();
    let releaseClaim = (): void => undefined;
    const claimReleased = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let notifyClaim = (): void => undefined;
    const claimObserved = new Promise<void>((resolve) => {
      notifyClaim = resolve;
    });
    let paused = false;
    const reader = new AssuranceRunVerdictReader({
      async afterEvidenceGuardClaim() {
        if (paused) return;
        paused = true;
        notifyClaim();
        await claimReleased;
      },
    });
    const projection = new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId,
    });
    await claimObserved;
    await database.query(
      "UPDATE work_task SET acceptance_criteria_json = '[\"투영 중 변경\"]' WHERE organization_id = $organization_id AND work_id = $work_id AND task_id = $task_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id, task_id: taskId },
    );
    releaseClaim();

    await expect(projection).rejects.toThrow(/evidence가 변경|snapshot/u);
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
    ).rejects.toThrow(/snapshot|evidence가 변경/u);
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
    ).rejects.toThrow(/활성 Assurance binding|evidence가 변경/u);
    const [artifacts] = await database.query<[{ kind: string }[]]>(
      "SELECT kind FROM work_artifact WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual(["command-output", "report"]);
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
