import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrganizationGraphService, type OrganizationVersion } from "../../organization/src/organization.js";
import { WorkService, type Work, type WorkStatus } from "../../work/src/work.js";
import { SurrealApplicationReadModel } from "./adapters/read-model.js";
import { ApplicationRunStore, type ApplicationRunStatus, type ApplicationRunView } from "./run-store.js";

const TERMINAL_WORK_PATHS: Readonly<Record<"completed" | "failed" | "cancelled", readonly WorkStatus[]>> = {
  completed: ["planned", "ready", "running", "verifying", "completed"],
  failed: ["planned", "ready", "running", "failed"],
  cancelled: ["cancelled"],
};

describe("Work 범위 동적 Agent 수명주기", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let works: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: `dynamic-staff-lifecycle-${crypto.randomUUID()}@example.com`,
      displayName: "Dynamic Staff Lifecycle",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    works = await WorkService.create(database, organizations, graph);
  });

  afterEach(async () => database.close());

  async function createWorkAgent(
    suffix: string,
    tenant = context,
    workService = works,
  ): Promise<{ readonly handle: string; readonly version: OrganizationVersion; readonly work: Work }> {
    const snapshot = await graph.getCurrentSnapshot(tenant);
    const created = await workService.createWork(tenant, {
      commandId: `dynamic-staff-lifecycle-${suffix}:work`,
      text: `${suffix} 수명주기 검증`,
      surface: "test",
      organizationVersionId: snapshot.version.version_id,
    });
    const handle = `staff-${suffix}`;
    const installed = await graph.execute(tenant, {
      commandId: `dynamic-staff-lifecycle-${suffix}:install`,
      expectedVersion: snapshot.version.version,
      kind: "install-profile",
      profileId: `dynamic-staff-lifecycle-${suffix}`,
      profileVersion: "1.0.0",
      nodes: [
        {
          handle,
          name: `Work Operator ${suffix}`,
          responsibility: `${suffix} Work 실행`,
          outputs: ["Task result"],
          capabilities: ["delivery"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: created.work.work_id,
          role: "operator",
        },
      ],
    });
    return { handle, version: installed.version, work: created.work };
  }

  async function runningRun(
    store: ApplicationRunStore,
    suffix: string,
    workId: string,
    tenant = context,
  ): Promise<ApplicationRunView> {
    const started = await store.start(tenant, {
      commandId: `dynamic-staff-lifecycle-${suffix}:run`,
      correlationId: `dynamic-staff-lifecycle-${suffix}:correlation`,
      request: {},
    });
    const initial = await store.claim(tenant, started.runId);
    if (initial.outcome !== "claimed") throw new Error("ApplicationRun 초기 lease를 얻지 못했습니다");
    await store.advance(tenant, started.runId, initial.leaseGeneration, { stage: "records", workId });
    const running = await store.claim(tenant, started.runId);
    if (running.outcome !== "claimed") throw new Error("ApplicationRun terminal lease를 얻지 못했습니다");
    return running.run;
  }

  async function setTerminalWorkStatus(
    workId: string,
    status: "completed" | "failed" | "cancelled",
    organizationId = context.organizationId,
  ): Promise<void> {
    if (status === "completed") {
      // 실제 Records/Assurance fixture 전체 대신 persisted terminal 상태만 정확히 구성합니다.
      await database.query("REMOVE EVENT work_assurance_completion_guard ON TABLE work;");
    }
    for (const target of TERMINAL_WORK_PATHS[status]) {
      await database.query(
        "UPDATE work SET status = $status WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: organizationId, work_id: workId, status: target },
      );
    }
  }

  async function finishRun(
    store: ApplicationRunStore,
    tenant: TenantContext,
    run: ApplicationRunView,
    status: Extract<ApplicationRunStatus, "completed" | "failed" | "cancelled">,
  ): Promise<void> {
    if (status === "completed") await store.complete(tenant, run.runId, run.leaseGeneration);
    else if (status === "failed") await store.fail(tenant, run.runId, run.leaseGeneration, "delivery-failed");
    else await store.cancel(tenant, run.runId);
  }

  async function rawNodeStatus(organizationId: string, handle: string): Promise<string | undefined> {
    const [nodes] = await database.query<[{ readonly handle: string; readonly status: string }[]]>(
      "SELECT handle, status FROM organization_node WHERE organization_id = $organization_id;",
      { organization_id: organizationId },
    );
    return nodes.find((node) => node.handle === handle)?.status;
  }

  async function versions(organizationId = context.organizationId): Promise<readonly OrganizationVersion[]> {
    const [records] = await database.query<[OrganizationVersion[]]>(
      "SELECT * OMIT id FROM organization_version WHERE organization_id = $organization_id ORDER BY version ASC;",
      { organization_id: organizationId },
    );
    return records;
  }

  it.each(["completed", "failed", "cancelled"] as const)(
    "persisted Work와 Run이 모두 %s일 때만 현재 조직에서 해제하고 immutable history는 유지한다",
    async (terminal) => {
      const store = await ApplicationRunStore.create(database, organizations, { graph });
      const fixture = await createWorkAgent(terminal);
      const run = await runningRun(store, terminal, fixture.work.work_id);
      await setTerminalWorkStatus(fixture.work.work_id, terminal);

      expect(await rawNodeStatus(context.organizationId, fixture.handle)).toBe("active");
      await finishRun(store, context, run, terminal);

      expect((await works.getWork(context, fixture.work.work_id)).status).toBe(terminal);
      expect((await store.get(context, run.runId)).status).toBe(terminal);
      expect(await rawNodeStatus(context.organizationId, fixture.handle)).toBe("inactive");
      expect(await rawNodeStatus(context.organizationId, "representative")).toBe("active");
      const current = await graph.getCurrentSnapshot(context);
      expect(current.version).toMatchObject({
        version: fixture.version.version + 1,
        previous_version: fixture.version.version,
        command_kind: "release-work-scope",
      });
      const before = JSON.parse(current.version.before_json) as Array<{ handle: string; status: string }>;
      const after = JSON.parse(current.version.after_json) as Array<{ handle: string; status: string }>;
      expect(before.find((node) => node.handle === fixture.handle)?.status).toBe("active");
      expect(after.find((node) => node.handle === fixture.handle)?.status).toBe("inactive");
      expect(JSON.parse(fixture.version.after_json)).toEqual(
        expect.arrayContaining([expect.objectContaining({ handle: fixture.handle, status: "active" })]),
      );
      expect((await new SurrealApplicationReadModel(database, organizations).organization(context)).nodes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ handle: fixture.handle })]),
      );
    },
  );

  it("승인 대기·차단 Run의 Work Agent는 active로 유지한다", async () => {
    const store = await ApplicationRunStore.create(database, organizations, { graph });
    const awaiting = await createWorkAgent("awaiting");
    const awaitingRun = await runningRun(store, "awaiting", awaiting.work.work_id);
    await store.suspend(context, awaitingRun.runId, awaitingRun.leaseGeneration, "approval-lifecycle-awaiting");

    const blocked = await createWorkAgent("blocked");
    const blockedRun = await runningRun(store, "blocked", blocked.work.work_id);
    await store.block(context, blockedRun.runId, blockedRun.leaseGeneration, "assurance-blocked");

    expect(await rawNodeStatus(context.organizationId, awaiting.handle)).toBe("active");
    expect(await rawNodeStatus(context.organizationId, blocked.handle)).toBe("active");
  });

  it("잘못 삽입된 다른 Work assignment는 terminal Work Agent 정리를 막지 않는다", async () => {
    const store = await ApplicationRunStore.create(database, organizations, { graph });
    const fixture = await createWorkAgent("invalid-cross-work-assignment");
    const run = await runningRun(store, "invalid-cross-work-assignment", fixture.work.work_id);
    await setTerminalWorkStatus(fixture.work.work_id, "cancelled");
    const other = await works.createWork(context, {
      commandId: "dynamic-staff-lifecycle-invalid-cross-work-assignment:other-work",
      text: "잘못된 cross-work 배정",
      surface: "test",
      organizationVersionId: fixture.version.version_id,
    });
    await database.query(
      "CREATE task_assignment CONTENT { assignment_id: $assignment_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, agent_handle: $agent_handle, status: 'assigned', revision: 1, supersedes_assignment_id: NONE, created_by: $created_by, created_at: time::now(), updated_at: time::now() };",
      {
        assignment_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: other.work.work_id,
        task_id: crypto.randomUUID(),
        agent_handle: fixture.handle,
        created_by: context.userId,
      },
    );

    await store.cancel(context, run.runId);

    expect(await rawNodeStatus(context.organizationId, fixture.handle)).toBe("inactive");
  });

  it("Work/Run terminal 호출이 병렬이어도 post-commit 해제는 한 번만 기록한다", async () => {
    const store = await ApplicationRunStore.create(database, organizations, { graph });
    const fixture = await createWorkAgent("parallel-work-run");
    const run = await runningRun(store, "parallel-work-run", fixture.work.work_id);

    await Promise.all([
      works.transition(context, {
        commandId: "dynamic-staff-lifecycle-parallel-work-run:work-cancel",
        workId: fixture.work.work_id,
        expectedRevision: fixture.work.revision,
        target: "cancelled",
      }),
      store.cancel(context, run.runId),
    ]);

    expect(await rawNodeStatus(context.organizationId, fixture.handle)).toBe("inactive");
    const releases = (await versions()).filter((version) => version.command_kind === "release-work-scope");
    expect(releases).toHaveLength(1);
  });

  it("서로 다른 terminal Work를 병렬 해제해도 version chain과 두 current node를 모두 보존한다", async () => {
    const store = await ApplicationRunStore.create(database, organizations, { graph });
    const first = await createWorkAgent("parallel-first");
    const firstRun = await runningRun(store, "parallel-first", first.work.work_id);
    const second = await createWorkAgent("parallel-second");
    const secondRun = await runningRun(store, "parallel-second", second.work.work_id);
    await setTerminalWorkStatus(first.work.work_id, "cancelled");
    await setTerminalWorkStatus(second.work.work_id, "cancelled");
    const baseVersion = (await graph.getCurrentSnapshot(context)).version.version;

    await Promise.all([store.cancel(context, firstRun.runId), store.cancel(context, secondRun.runId)]);

    expect(await rawNodeStatus(context.organizationId, first.handle)).toBe("inactive");
    expect(await rawNodeStatus(context.organizationId, second.handle)).toBe("inactive");
    const releases = (await versions()).filter((version) => version.version > baseVersion);
    expect(releases.map(({ version, previous_version }) => ({ version, previous_version }))).toEqual([
      { version: baseVersion + 1, previous_version: baseVersion },
      { version: baseVersion + 2, previous_version: baseVersion + 1 },
    ]);
  });

  it("startup은 Membership 없는 tenant를 건너뛰고 다른 tenant를 정리한 뒤 재실행할 수 있다", async () => {
    const seed = await ApplicationRunStore.create(database, organizations);
    const orphan = await createWorkAgent("startup-orphan");
    const orphanRun = await runningRun(seed, "startup-orphan", orphan.work.work_id);
    await works.transition(context, {
      commandId: "dynamic-staff-lifecycle-startup-orphan:work-cancel",
      workId: orphan.work.work_id,
      expectedRevision: orphan.work.revision,
      target: "cancelled",
    });
    await seed.cancel(context, orphanRun.runId);

    const identities = await IdentityService.create(database);
    const otherOwner = await identities.registerPersonalUser({
      email: `dynamic-staff-lifecycle-other-${crypto.randomUUID()}@example.com`,
      displayName: "Other Lifecycle",
    });
    const otherContext = await organizations.resolveTenantContext(
      otherOwner.user.user_id,
      otherOwner.organization.organization_id,
    );
    await graph.bootstrap(otherContext);
    const otherWorks = await WorkService.create(database, organizations, graph);
    const other = await createWorkAgent("startup-other", otherContext, otherWorks);
    const otherRun = await runningRun(seed, "startup-other", other.work.work_id, otherContext);
    await otherWorks.transition(otherContext, {
      commandId: "dynamic-staff-lifecycle-startup-other:work-cancel",
      workId: other.work.work_id,
      expectedRevision: other.work.revision,
      target: "cancelled",
    });
    await seed.cancel(otherContext, otherRun.runId);
    await database.query("DELETE membership WHERE organization_id = $organization_id;", {
      organization_id: context.organizationId,
    });

    await expect(ApplicationRunStore.create(database, organizations, { graph })).resolves.toBeInstanceOf(
      ApplicationRunStore,
    );
    expect(await rawNodeStatus(context.organizationId, orphan.handle)).toBe("active");
    expect(await rawNodeStatus(otherContext.organizationId, other.handle)).toBe("inactive");

    await database.query(
      "CREATE membership CONTENT { membership_id: $membership_id, user_id: $user_id, organization_id: $organization_id, role: $role, status: 'active', revision: 0, created_at: time::now() };",
      {
        membership_id: context.membershipId,
        user_id: context.userId,
        organization_id: context.organizationId,
        role: context.role,
      },
    );
    await ApplicationRunStore.create(database, organizations, { graph });
    expect(await rawNodeStatus(context.organizationId, orphan.handle)).toBe("inactive");
  });

  it("startup은 candidate release 실패를 격리하고 다음 Work를 정리한 뒤 재실행한다", async () => {
    const seed = await ApplicationRunStore.create(database, organizations);
    const failed = await createWorkAgent("startup-release-failed");
    const failedRun = await runningRun(seed, "startup-release-failed", failed.work.work_id);
    await works.transition(context, {
      commandId: "dynamic-staff-lifecycle-startup-release-failed:work-cancel",
      workId: failed.work.work_id,
      expectedRevision: failed.work.revision,
      target: "cancelled",
    });
    await seed.cancel(context, failedRun.runId);

    const following = await createWorkAgent("startup-release-following");
    const followingRun = await runningRun(seed, "startup-release-following", following.work.work_id);
    await works.transition(context, {
      commandId: "dynamic-staff-lifecycle-startup-release-following:work-cancel",
      workId: following.work.work_id,
      expectedRevision: following.work.revision,
      target: "cancelled",
    });
    await seed.cancel(context, followingRun.runId);
    await database.query(`
      DEFINE EVENT fail_first_work_scope_release ON TABLE organization_version
      WHEN $event = 'CREATE'
        AND $after.command_kind = 'release-work-scope'
        AND string::contains($after.request_json, '${failed.work.work_id}')
      THEN { THROW 'injected release transaction failure'; };
    `);

    await expect(graph.reconcileTerminalWorkScopedNodes()).resolves.toBe(1);
    expect(await rawNodeStatus(context.organizationId, failed.handle)).toBe("active");
    expect(await rawNodeStatus(context.organizationId, following.handle)).toBe("inactive");

    await database.query("REMOVE EVENT fail_first_work_scope_release ON TABLE organization_version;");
    await expect(graph.reconcileTerminalWorkScopedNodes()).resolves.toBe(1);
    expect(await rawNodeStatus(context.organizationId, failed.handle)).toBe("inactive");
  });
});
