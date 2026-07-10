import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { AssuranceRunStore, type StartAssuranceRunInput, type TransitionAssuranceRunInput } from "./index.js";

describe("Assurance run 저장소", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: AssuranceRunStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "assurance@example.com", displayName: "Assurance" });
    const other = await identity.registerPersonalUser({ email: "other-assurance@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await AssuranceRunStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  function input(commandId: string = crypto.randomUUID()): StartAssuranceRunInput {
    return {
      commandId,
      workId: "work-1",
      targetWorkRevision: 12,
      planVersionId: "plan-1",
      bindingVersionId: "binding-1",
      profileId: "massion.assurance.acceptance",
      profileVersion: "1.0.0",
      verifierHandle: "assurance",
      verifierExecutionId: "execution-assurance-1",
      snapshotHash: "a".repeat(64),
      leaseTtlMs: 60_000,
    };
  }

  it("planned run을 만들고 같은 명령은 멱등 재생하며 payload 변경은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.start(context, input(commandId));
    const repeated = await store.start(context, input(commandId));

    expect(first.run).toMatchObject({
      organizationId: context.organizationId,
      workId: "work-1",
      targetWorkRevision: 12,
      planVersionId: "plan-1",
      bindingVersionId: "binding-1",
      profileId: "massion.assurance.acceptance",
      profileVersion: "1.0.0",
      verifierHandle: "assurance",
      verifierExecutionId: "execution-assurance-1",
      snapshotHash: "a".repeat(64),
      status: "planned",
      version: 1,
      attempt: 1,
    });
    expect(first.run.expiresAt).toBeDefined();
    expect(first.run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(first.run.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(repeated.run.assuranceRunId).toBe(first.run.assuranceRunId);
    await expect(store.start(context, { ...input(commandId), snapshotHash: "b".repeat(64) })).rejects.toThrow(
      "다른 assurance 명령",
    );
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
    ).rejects.toThrow("resolution metadata");
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
    ).rejects.toThrow("metadata 불변식");
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
