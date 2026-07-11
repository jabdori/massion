import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { AssuranceBindingStore, type BindingActivationAuthorizer, type StartAssuranceRunInput } from "./index.js";
import { AssuranceRunStore, type TransitionAssuranceRunInput } from "./run-store.js";
import { AssuranceService } from "./service.js";

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

function legacyTransitionHash(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ operation: "transition", input }))
    .digest("hex");
}

describe("Assurance run 저장소", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: AssuranceRunStore;
  let workId: string;
  let verifierExecutionId: string;
  let planVersionId: string;
  let bindingVersionId: string;
  let snapshotHash: string;
  let targetWorkRevision: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "assurance@example.com", displayName: "Assurance" });
    const other = await identity.registerPersonalUser({ email: "other-assurance@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const graphState = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "Assurance run test",
      surface: "test",
      organizationVersionId: graphState.version.version_id,
    });
    workId = created.work.work_id;
    const plan = await works.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: created.work.revision,
      content: { objective: "Assurance run test", acceptanceCriteria: [] },
    });
    planVersionId = plan.plan.plan_version_id;
    const planned = await works.transition(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: plan.work.revision,
      target: "planned",
    });
    const task = await works.addTask(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: planned.work.revision,
      title: "검증 대상",
      objective: "Run store를 검증합니다",
      acceptanceCriteria: ["run을 독립 검증합니다"],
      dependencyIds: [],
    });
    const assigned = await works.assignTask(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: task.work.revision,
      taskId: task.task.task_id,
      agentHandle: "delivery-coordination",
    });
    const ready = await works.transition(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: assigned.work.revision,
      target: "ready",
    });
    const workRunning = await works.transition(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: ready.work.revision,
      target: "running",
    });
    const taskRunning = await works.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: workRunning.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: task.task.revision,
      target: "running",
    });
    const taskCompleted = await works.transitionTask(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: taskRunning.work.revision,
      taskId: task.task.task_id,
      expectedTaskRevision: taskRunning.task.revision,
      target: "completed",
    });
    const verifying = await works.transition(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: taskCompleted.work.revision,
      target: "verifying",
    });
    targetWorkRevision = verifying.work.revision;
    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const queued = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId,
      agentHandle: "assurance",
      modelRoute: "test:assurance",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "assurance" },
    });
    const running = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: queued.execution.execution_id,
      expectedVersion: queued.execution.version,
      target: "running",
      payload: { started: true },
    });
    verifierExecutionId = running.execution.execution_id;
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
    const taskCriterionKey = `task:${task.task.task_id}:0`;
    const draft = await bindings.propose(context, {
      commandId: crypto.randomUUID(),
      workId,
      planVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      authorHandle: "context-strategy",
      requiredCriteria: [
        { criterionKey: taskCriterionKey, method: "test" },
        { criterionKey: "profile:acceptance:coverage", method: "evidence" },
      ],
      bindings: [
        {
          bindingKey: "check:task",
          criterionKey: taskCriterionKey,
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
          bindingKey: "check:coverage",
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
    bindingVersionId = active.bindingVersionId;
    store = await AssuranceRunStore.create(database, organizations);
    snapshotHash = (
      await store.prepareSnapshot(context, {
        workId,
        targetWorkRevision,
        planVersionId,
        bindingVersionId,
        profileId: "massion.assurance.acceptance.v1",
        profileVersion: "1.0.0",
      })
    ).snapshot.hash;
  });

  afterEach(async () => database.close());

  function input(commandId: string = crypto.randomUUID()): StartAssuranceRunInput {
    return {
      commandId,
      workId,
      targetWorkRevision,
      planVersionId,
      bindingVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      verifierHandle: "assurance",
      verifierExecutionId,
      snapshotHash,
      leaseTtlMs: 60_000,
    };
  }

  it("planned run을 만들고 같은 명령은 멱등 재생하며 payload 변경은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.start(context, input(commandId));
    const repeated = await store.start(context, input(commandId));

    expect(first.run).toMatchObject({
      organizationId: context.organizationId,
      workId,
      targetWorkRevision,
      planVersionId,
      bindingVersionId,
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      verifierHandle: "assurance",
      verifierExecutionId,
      snapshotHash,
      status: "planned",
      version: 1,
      attempt: 1,
    });
    expect(first.run.expiresAt).toBeDefined();
    expect(first.run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(first.run.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(repeated.run.assuranceRunId).toBe(first.run.assuranceRunId);
    await expect(store.listCriteria(context, first.run.assuranceRunId)).resolves.toEqual([
      expect.objectContaining({ criterionKey: "profile:acceptance:coverage", status: "pending" }),
      expect.objectContaining({ criterionKey: expect.stringMatching(/^task:/u), status: "pending" }),
    ]);
    await expect(store.start(context, { ...input(commandId), snapshotHash: "b".repeat(64) })).rejects.toThrow(
      "다른 assurance 명령",
    );
  });

  it("caller snapshot hash가 현재 DB material snapshot과 다르면 run을 만들지 않는다", async () => {
    await expect(store.start(context, { ...input(), snapshotHash: "f".repeat(64) })).rejects.toThrow(
      "material snapshot",
    );
    const [runs] = await database.query<[unknown[]]>("SELECT * FROM assurance_run;");
    expect(runs).toHaveLength(0);
  });

  it("planned → running → passed만 허용하고 optimistic version과 terminal 불변성을 강제한다", async () => {
    const started = await store.start(context, input());
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });

    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        assuranceRunId: running.run.assuranceRunId,
        expectedVersion: 1,
        target: "passed",
      }),
    ).rejects.toThrow("version 충돌");

    const commandId = crypto.randomUUID();
    const passedInput: TransitionAssuranceRunInput = {
      commandId,
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
      target: "passed",
    };
    const passed = await store.transition(context, passedInput);
    const replayed = await store.transition(context, passedInput);

    expect(passed.run).toMatchObject({ status: "passed", verdict: "passed", version: 3 });
    expect(passed.run.completedAt).toBeDefined();
    expect(replayed.run).toEqual(passed.run);
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        assuranceRunId: passed.run.assuranceRunId,
        expectedVersion: passed.run.version,
        target: "cancelled",
      }),
    ).rejects.toThrow("terminal assurance run");
  });

  it("check·finding·attestation Event 뒤에도 실제 다음 sequence로 상태 전이 Event를 기록한다", async () => {
    const started = await store.start(context, input());
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });
    await database.query(
      "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: 3, event_type: 'assurance_attestation_recorded', request_hash: $request_hash, payload_json: '{}', actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: started.run.assuranceRunId,
        command_id: crypto.randomUUID(),
        request_hash: "d".repeat(64),
        actor_user_id: context.userId,
      },
    );

    await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
      target: "passed",
    });
    expect((await store.listEvents(context, running.run.assuranceRunId)).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("허용되지 않은 전이와 failure metadata가 없는 failed·blocked를 거부한다", async () => {
    const started = await store.start(context, input());
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        assuranceRunId: started.run.assuranceRunId,
        expectedVersion: started.run.version,
        target: "passed",
      }),
    ).rejects.toThrow("허용되지 않은 assurance 상태 전이");

    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });
    await expect(
      store.transition(context, {
        commandId: crypto.randomUUID(),
        assuranceRunId: running.run.assuranceRunId,
        expectedVersion: running.run.version,
        target: "failed",
      }),
    ).rejects.toThrow("failure metadata");
    const failed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
      target: "failed",
      failure: { category: "criterion_failed", causeHash: "c".repeat(64) },
    });
    expect(failed.run).toMatchObject({ status: "failed", verdict: "failed" });
  });

  it("같은 Work revision·profile의 active run 경쟁은 한 건만 성공하고 terminal 뒤 attempt를 올린다", async () => {
    const results = await Promise.allSettled([
      store.start(context, input("concurrent-run-1")),
      store.start(context, input("concurrent-run-2")),
    ]);
    const fulfilled = results.find((result) => result.status === "fulfilled");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (!fulfilled || fulfilled.status !== "fulfilled") throw new Error("active assurance run이 없습니다");

    const cancelled = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: fulfilled.value.run.assuranceRunId,
      expectedVersion: fulfilled.value.run.version,
      target: "cancelled",
    });
    const next = await store.start(context, input("next-attempt"));

    expect(cancelled.run.status).toBe("cancelled");
    expect(next.run.attempt).toBe(2);
  });

  it("0045 이전 terminal Event request hash를 synthetic evidence hash로 실제 ledger 재생한다", async () => {
    const assuranceRunId = crypto.randomUUID();
    const startCommandId = crypto.randomUUID();
    const decisionCommandId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_run CONTENT { assurance_run_id: $assurance_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: $target_work_revision, plan_version_id: $plan_version_id, binding_version_id: $binding_version_id, profile_id: 'massion.assurance.acceptance.v1', profile_version: '1.0.0', verifier_handle: 'assurance', verifier_execution_id: $verifier_execution_id, snapshot_hash: $snapshot_hash, status: 'planned', version: 1, attempt: 99, start_command_id: $start_command_id, active_guard_key: $active_guard_key, created_by_user_id: $user_id, expires_at: time::now() + 1h, started_at: time::now(), updated_at: time::now() }; CREATE assurance_event CONTENT { event_id: $start_event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $start_command_id, sequence: 1, event_type: 'assurance_run_started', request_hash: $start_request_hash, payload_json: '{}', actor_user_id: $user_id, created_at: time::now() };",
      {
        assurance_run_id: assuranceRunId,
        organization_id: context.organizationId,
        work_id: workId,
        target_work_revision: targetWorkRevision,
        plan_version_id: planVersionId,
        binding_version_id: bindingVersionId,
        verifier_execution_id: verifierExecutionId,
        snapshot_hash: snapshotHash,
        start_command_id: startCommandId,
        active_guard_key: crypto.randomUUID(),
        user_id: context.userId,
        start_event_id: crypto.randomUUID(),
        start_request_hash: "1".repeat(64),
      },
    );
    await database.query(
      "UPDATE assurance_run SET status = 'running', version = 2, updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id; CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: 2, event_type: 'assurance_run_running', request_hash: $request_hash, payload_json: '{}', actor_user_id: $user_id, created_at: time::now() };",
      {
        event_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: assuranceRunId,
        command_id: crypto.randomUUID(),
        request_hash: "2".repeat(64),
        user_id: context.userId,
      },
    );
    await database.query("REMOVE EVENT assurance_run_decision_evidence_integrity ON assurance_run;");
    await database.query(
      "UPDATE assurance_run SET status = 'passed', version = 3, active_guard_key = NONE, verdict = 'passed', completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id; CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: 3, event_type: 'assurance_run_passed', request_hash: $request_hash, payload_json: '{}', actor_user_id: $user_id, created_at: time::now() };",
      {
        event_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: assuranceRunId,
        command_id: decisionCommandId,
        request_hash: legacyTransitionHash({
          commandId: decisionCommandId,
          assuranceRunId,
          expectedVersion: 2,
          target: "passed",
        }),
        user_id: context.userId,
      },
    );

    const replayed = await (
      await AssuranceService.create(database, organizations)
    ).decide(context, {
      commandId: decisionCommandId,
      assuranceRunId,
      expectedVersion: 2,
    });
    expect(replayed.run.status).toBe("passed");
    expect(replayed.decision.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("다른 tenant run 접근을 거부하고 command Event 계보를 보존한다", async () => {
    const started = await store.start(context, input("tenant-start"));
    const running = await store.transition(context, {
      commandId: "tenant-running",
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });

    await expect(store.get(otherContext, running.run.assuranceRunId)).rejects.toThrow(
      "Assurance run을 찾을 수 없습니다",
    );
    expect((await store.listEvents(context, running.run.assuranceRunId)).map((event) => event.eventType)).toEqual([
      "assurance_run_started",
      "assurance_run_running",
    ]);
  });

  it.each([
    [{ workId: "" }, "Work ID"],
    [{ targetWorkRevision: 0 }, "revision"],
    [{ snapshotHash: "not-a-hash" }, "snapshot hash"],
    [{ profileId: "x".repeat(201) }, "Profile ID"],
    [{ verifierHandle: "delivery-coordination" }, "assurance"],
    [{ leaseTtlMs: 0 }, "TTL"],
  ] as const)("bounded start input을 강제한다: %s", async (change, error) => {
    await expect(store.start(context, { ...input(), ...change })).rejects.toThrow(error);
  });

  it("0039 migration이 모든 Assurance 정본 table을 만든다", async () => {
    for (const table of [
      "assurance_binding_version",
      "assurance_run",
      "assurance_criterion",
      "assurance_check",
      "assurance_finding",
      "assurance_human_attestation",
      "assurance_metric_observation",
      "assurance_event",
    ]) {
      await expect(database.query(`INFO FOR TABLE ${table};`)).resolves.toBeDefined();
    }
  });

  it("0039 schema가 criterion·check·finding·metric의 invalid 정본을 거부한다", async () => {
    await expect(
      database.query(
        "CREATE assurance_criterion CONTENT { criterion_id: 'invalid-criterion', organization_id: $organization_id, work_id: 'work-1', assurance_run_id: 'run-1', criterion_key: 'criterion:test', source: 'plan', statement: 'test', method: 'test', required_evidence_kinds: [], control_references: [], status: 'excluded', created_at: time::now(), updated_at: time::now() };",
        { organization_id: context.organizationId },
      ),
    ).rejects.toThrow("exclusion metadata");
    await expect(
      database.query(
        "CREATE assurance_check CONTENT { check_id: 'invalid-check', organization_id: $organization_id, work_id: 'work-1', assurance_run_id: 'run-1', criterion_id: 'criterion-1', kind: 'command', system_adapter_id: 'adapter-1', command_key: 'check:test', input_hash: $input_hash, status: 'pending', artifact_version_ids: [], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], duration_ms: -1, created_at: time::now() };",
        { organization_id: context.organizationId, input_hash: "a".repeat(64) },
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        "CREATE assurance_finding CONTENT { finding_id: 'invalid-finding', organization_id: $organization_id, work_id: 'work-1', assurance_run_id: 'run-1', fingerprint: $fingerprint, category: 'security', severity: 'minor', status: 'accepted', message: 'finding', evidence_reference_ids: [], control_references: [], created_at: time::now() };",
        { organization_id: context.organizationId, fingerprint: "b".repeat(64) },
      ),
    ).rejects.toThrow("open 상태");
    await expect(
      database.query(
        "CREATE assurance_metric_observation CONTENT { observation_id: 'invalid-observation', organization_id: $organization_id, work_id: 'work-1', producer_kind: 'system_adapter', producer_id: 'adapter-1', source_kind: 'runtime_execution', source_id: 'execution-1', numeric_value: math::infinity, unit: 'percent', checksum: $checksum, command_id: 'metric-1', request_hash: $request_hash, measured_at: time::now(), created_at: time::now() };",
        { organization_id: context.organizationId, checksum: "c".repeat(64), request_hash: "d".repeat(64) },
      ),
    ).rejects.toThrow();
  });

  it("DB Event가 status·verdict·failure·completedAt과 version 조합 위조를 rollback한다", async () => {
    const started = await store.start(context, input());

    await expect(
      database.query(
        "UPDATE assurance_run SET status = 'passed', version = 2 WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        { organization_id: context.organizationId, assurance_run_id: started.run.assuranceRunId },
      ),
    ).rejects.toThrow("metadata");
    await expect(
      database.query(
        "UPDATE assurance_run SET status = 'running', version = 3 WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        { organization_id: context.organizationId, assurance_run_id: started.run.assuranceRunId },
      ),
    ).rejects.toThrow("version");
    await expect(
      database.query(
        "UPDATE assurance_run SET snapshot_hash = $snapshot_hash, version = 2 WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        {
          snapshot_hash: "b".repeat(64),
          organization_id: context.organizationId,
          assurance_run_id: started.run.assuranceRunId,
        },
      ),
    ).rejects.toThrow("identity field");
    await expect(
      database.query(
        "UPDATE assurance_run SET active_guard_key = $guard_key, version = 2 WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        {
          guard_key: "f".repeat(64),
          organization_id: context.organizationId,
          assurance_run_id: started.run.assuranceRunId,
        },
      ),
    ).rejects.toThrow("guard key");
    await expect(
      database.query(
        "UPDATE assurance_run SET projected_work_revision = 99, version = 2 WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        { organization_id: context.organizationId, assurance_run_id: started.run.assuranceRunId },
      ),
    ).rejects.toThrow("metadata 불변식");
    expect(await store.get(context, started.run.assuranceRunId)).toMatchObject({ status: "planned", version: 1 });
  });

  it("DB Event가 terminal run의 metadata 덮어쓰기를 거부한다", async () => {
    const started = await store.start(context, input());
    const running = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: started.run.assuranceRunId,
      expectedVersion: started.run.version,
      target: "running",
    });
    const passed = await store.transition(context, {
      commandId: crypto.randomUUID(),
      assuranceRunId: running.run.assuranceRunId,
      expectedVersion: running.run.version,
      target: "passed",
    });

    await expect(
      database.query(
        "UPDATE assurance_run SET snapshot_hash = $snapshot_hash, version = $version WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
        {
          snapshot_hash: "b".repeat(64),
          version: passed.run.version + 1,
          organization_id: context.organizationId,
          assurance_run_id: passed.run.assuranceRunId,
        },
      ),
    ).rejects.toThrow("Terminal Assurance run");
  });
});
import { createHash } from "node:crypto";
