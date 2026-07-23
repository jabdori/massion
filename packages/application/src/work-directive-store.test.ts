import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { WorkService } from "@massion/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationRunStore } from "./run-store.js";
import { WorkDirectiveStore, type WorkDirectiveClock } from "./work-directive-store.js";
import { APPLICATION_WORK_DIRECTIVE_MIGRATION } from "./schema.js";

class MutableDirectiveClock implements WorkDirectiveClock {
  public constructor(public now: Date) {}
}

function createRunReadBarrier(database: MassionDatabase): {
  readonly database: MassionDatabase;
  readonly entered: Promise<void>;
  enable(): void;
  release(): void;
} {
  let enabled = false;
  let paused = false;
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrierDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return async <T>(operation: (transaction: QueryExecutor) => Promise<T>): Promise<T> =>
          await target.transaction(
            async (transaction) =>
              await operation({
                async query<R = unknown[]>(surql: string, bindings?: Record<string, unknown>): Promise<R> {
                  const result = await transaction.query<R>(surql, bindings);
                  if (
                    enabled &&
                    !paused &&
                    surql.startsWith("SELECT run_id") &&
                    surql.includes("FROM application_run")
                  ) {
                    paused = true;
                    markEntered();
                    await released;
                  }
                  return result;
                },
              }),
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: barrierDatabase,
    entered,
    enable() {
      enabled = true;
    },
    release,
  };
}

describe("WorkDirectiveStore", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let runStore: ApplicationRunStore;
  let directives: WorkDirectiveStore;
  let workId: string;
  let runId: string;
  let clock: MutableDirectiveClock;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "directive@example.com", displayName: "Directive" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const created = await works.createWork(context, {
      commandId: "directive-work-command-0001",
      text: "대표 지시를 반영해주세요",
      surface: "desktop",
      organizationVersionId: "directive-org-version-0001",
    });
    workId = created.work.work_id;
    runStore = await ApplicationRunStore.create(database, organizations);
    const run = await runStore.start(context, {
      commandId: "directive-run-command-0001",
      correlationId: "directive-run-correlation-0001",
      request: { text: "기존 요청" },
    });
    const claim = await runStore.claim(context, run.runId);
    if (claim.outcome !== "claimed") throw new Error("run lease를 얻지 못했습니다");
    await runStore.advance(context, run.runId, claim.leaseGeneration, {
      stage: "context-strategy",
      workId,
    });
    runId = run.runId;
    clock = new MutableDirectiveClock(new Date("2026-07-22T00:00:00.000Z"));
    directives = await WorkDirectiveStore.create(database, organizations, { clock, leaseMs: 1_000 });
  });

  afterEach(async () => database.close());

  it("commandId를 멱등 재생하고 Work revision과 terminal 경계를 검증한다", async () => {
    const input = {
      commandId: "directive-submit-command-0001",
      correlationId: "directive-submit-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "개인정보를 빼고 통계를 다시 검증해주세요.",
      mode: "now" as const,
    };
    const submitted = await directives.submit(context, input);
    await expect(directives.submit(context, input)).resolves.toEqual(submitted);
    await expect(directives.submit(context, { ...input, content: "다른 지시" })).rejects.toThrow("commandId");
    await expect(
      directives.submit(context, { ...input, commandId: "directive-submit-command-0002", expectedRevision: 0 }),
    ).rejects.toThrow("revision");

    const claim = await runStore.claim(context, runId);
    if (claim.outcome !== "claimed") throw new Error("run lease를 얻지 못했습니다");
    await runStore.complete(context, runId, claim.leaseGeneration);
    await expect(
      directives.submit(context, {
        ...input,
        commandId: "directive-submit-command-0003",
        expectedRevision: claim.leaseGeneration,
      }),
    ).rejects.toThrow("후속 Work");
  });

  it("FIFO로 안전 경계의 지시만 claim하고 applying 지시는 lease 만료 뒤에도 자동 회수하지 않는다", async () => {
    const first = await directives.submit(context, {
      commandId: "directive-fifo-command-0001",
      correlationId: "directive-fifo-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "다음 단계부터 사용할 첫 지시",
      mode: "next-stage",
    });
    const second = await directives.submit(context, {
      commandId: "directive-fifo-command-0002",
      correlationId: "directive-fifo-correlation-0002",
      expectedRevision: 1,
      workId,
      runId,
      content: "즉시 사용할 둘째 지시",
      mode: "now",
    });

    const stageClaim = await runStore.claim(context, runId);
    if (stageClaim.outcome !== "claimed") throw new Error("stage 전환 lease를 얻지 못했습니다");
    await expect(
      directives.claimEligible(context, runId, "context-strategy", stageClaim.leaseGeneration),
    ).resolves.toEqual([]);
    await expect(directives.claimEligible(context, runId, "evidence", stageClaim.leaseGeneration)).rejects.toThrow(
      "stage",
    );
    await runStore.advance(context, runId, stageClaim.leaseGeneration, { stage: "evidence" });
    const evidenceClaim = await runStore.claim(context, runId);
    if (evidenceClaim.outcome !== "claimed") throw new Error("evidence lease를 얻지 못했습니다");
    const claimed = await directives.claimEligible(context, runId, "evidence", evidenceClaim.leaseGeneration);
    expect(claimed.map((directive) => directive.directiveId)).toEqual([first.directiveId, second.directiveId]);
    expect(claimed.map((directive) => directive.status)).toEqual(["applying", "applying"]);
    await expect(directives.claimEligible(context, runId, "evidence", evidenceClaim.leaseGeneration)).rejects.toThrow(
      "applying",
    );

    clock.now = new Date("2026-07-22T00:00:01.001Z");
    await expect(directives.claimEligible(context, runId, "evidence", evidenceClaim.leaseGeneration)).rejects.toThrow(
      "applying",
    );
    await Promise.all(
      claimed.map((directive) => directives.markApplied(context, directive.directiveId, directive.leaseGeneration)),
    );
    await expect(directives.listByRun(context, runId)).resolves.toEqual([
      expect.objectContaining({ directiveId: first.directiveId, status: "applied" }),
      expect.objectContaining({ directiveId: second.directiveId, status: "applied" }),
    ]);
  });

  it("첫 100개 claim 범위 뒤에 applying 지시가 있어도 run 전체를 busy로 거부한다", async () => {
    const submitted = [];
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      submitted.push(
        await directives.submit(context, {
          commandId: `directive-busy-boundary-command-${String(sequence).padStart(4, "0")}`,
          correlationId: `directive-busy-boundary-correlation-${String(sequence).padStart(4, "0")}`,
          expectedRevision: 1,
          workId,
          runId,
          content: `${String(sequence)}번째 busy 경계 지시`,
          mode: "now",
        }),
      );
    }
    const applying = submitted.at(-1)!;
    await database.query(
      "UPDATE application_work_directive SET status = 'applying', lease_generation = 1, lease_expires_at = <datetime>$lease_expires_at WHERE organization_id = $organization_id AND directive_id = $directive_id;",
      {
        organization_id: context.organizationId,
        directive_id: applying.directiveId,
        lease_expires_at: new Date("2026-07-22T00:00:01.000Z").toISOString(),
      },
    );
    const runClaim = await runStore.claim(context, runId);
    if (runClaim.outcome !== "claimed") throw new Error("busy 경계 확인용 run lease를 얻지 못했습니다");

    await expect(
      directives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration),
    ).rejects.toThrow("applying");
    const listed = await directives.listByRun(context, runId);
    expect(listed.slice(0, 100).every((directive) => directive.status === "queued")).toBe(true);
    expect(listed[100]).toMatchObject({ directiveId: applying.directiveId, status: "applying", leaseGeneration: 1 });
  });

  it("현재 worker의 run lease generation이 아니면 queued 지시를 claim하지 않는다", async () => {
    const directive = await directives.submit(context, {
      commandId: "directive-run-generation-command-0001",
      correlationId: "directive-run-generation-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "현재 run lease를 가진 worker만 반영해주세요",
      mode: "now",
    });
    const runClaim = await runStore.claim(context, runId);
    if (runClaim.outcome !== "claimed") throw new Error("지시 claim용 run lease를 얻지 못했습니다");

    await expect(
      directives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration - 1),
    ).rejects.toThrow("run lease generation");
    const claimed = await directives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration);
    expect(claimed.map((candidate) => candidate.directiveId)).toEqual([directive.directiveId]);
  });

  it("run generation을 읽은 뒤 다른 worker가 회수해도 stale worker는 queued 지시를 claim하지 않는다", async () => {
    const directive = await directives.submit(context, {
      commandId: "directive-concurrent-fence-command-0001",
      correlationId: "directive-concurrent-fence-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "동시 회수 뒤 stale worker는 실행하지 마세요",
      mode: "now",
    });
    const runClaim = await runStore.claim(context, runId);
    if (runClaim.outcome !== "claimed") throw new Error("stale worker용 run lease를 얻지 못했습니다");
    const barrier = createRunReadBarrier(database);
    const fencedDirectives = await WorkDirectiveStore.create(barrier.database, organizations, {
      clock,
      leaseMs: 1_000,
    });
    barrier.enable();
    const staleClaim = fencedDirectives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration);
    await barrier.entered;
    await database.query(
      "UPDATE application_run SET lease_generation = $next_generation, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND lease_generation = $previous_generation;",
      {
        organization_id: context.organizationId,
        run_id: runId,
        previous_generation: runClaim.leaseGeneration,
        next_generation: runClaim.leaseGeneration + 1,
        updated_at: new Date("2026-07-22T00:00:00.500Z").toISOString(),
      },
    );
    barrier.release();

    await expect(staleClaim).rejects.toThrow("run lease generation");
    await expect(directives.listByRun(context, runId)).resolves.toEqual([
      expect.objectContaining({ directiveId: directive.directiveId, status: "queued", leaseGeneration: 0 }),
    ]);
  });

  it("종료 전에 반영하지 못한 지시를 unapplied로 남긴다", async () => {
    const directive = await directives.submit(context, {
      commandId: "directive-unapplied-command-0001",
      correlationId: "directive-unapplied-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "다음 단계에서만 반영해주세요",
      mode: "next-stage",
    });

    await expect(directives.markUnapplied(context, runId)).rejects.toThrow("terminal");
    await runStore.cancel(context, runId);
    await directives.markUnapplied(context, runId);
    await expect(directives.listByRun(context, runId)).resolves.toEqual([
      expect.objectContaining({ directiveId: directive.directiveId, status: "unapplied" }),
    ]);
  });

  it("명시적 blocked 재시도의 retry attempt가 일치할 때만 failed 지시를 FIFO로 재큐잉한다", async () => {
    const submitted = [];
    for (const sequence of [1, 2]) {
      submitted.push(
        await directives.submit(context, {
          commandId: `directive-requeue-command-000${String(sequence)}`,
          correlationId: `directive-requeue-correlation-000${String(sequence)}`,
          expectedRevision: 1,
          workId,
          runId,
          content: `${String(sequence)}번째 재큐잉 지시`,
          mode: "now",
        }),
      );
    }
    const runClaim = await runStore.claim(context, runId);
    if (runClaim.outcome !== "claimed") throw new Error("지시 실패 처리용 run lease를 얻지 못했습니다");
    const claimed = await directives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration);
    await Promise.all(
      claimed.map((directive) =>
        directives.markFailed(context, directive.directiveId, directive.leaseGeneration, "directive-test-failed"),
      ),
    );
    await runStore.block(context, runId, runClaim.leaseGeneration, "directive-test-failed", workId);
    const retryAttemptId = "directive-requeue-attempt-0001";
    const retryClaim = await runStore.claim(context, runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("명시적 재시도용 run lease를 얻지 못했습니다");

    await expect(
      directives.requeueFailed(context, runId, "different-retry-attempt", retryClaim.leaseGeneration),
    ).rejects.toThrow("retry attempt");
    await expect(
      directives.requeueFailed(context, runId, retryAttemptId, retryClaim.leaseGeneration - 1),
    ).rejects.toThrow("run lease generation");
    await directives.requeueFailed(context, runId, retryAttemptId, retryClaim.leaseGeneration);
    await expect(directives.listByRun(context, runId)).resolves.toEqual(
      submitted.map((directive, index) =>
        expect.objectContaining({
          directiveId: directive.directiveId,
          sequence: index + 1,
          status: "queued",
        }),
      ),
    );
  });

  it("retry generation을 읽은 뒤 다른 worker가 회수하면 stale worker는 failed 지시를 재큐잉하지 않는다", async () => {
    const directive = await directives.submit(context, {
      commandId: "directive-concurrent-requeue-command-0001",
      correlationId: "directive-concurrent-requeue-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "동시 회수 뒤에는 재큐잉하지 마세요",
      mode: "now",
    });
    const runClaim = await runStore.claim(context, runId);
    if (runClaim.outcome !== "claimed") throw new Error("지시 실패 처리용 run lease를 얻지 못했습니다");
    const [claimed] = await directives.claimEligible(context, runId, "context-strategy", runClaim.leaseGeneration);
    if (!claimed) throw new Error("실패 처리할 지시를 claim하지 못했습니다");
    await directives.markFailed(context, claimed.directiveId, claimed.leaseGeneration, "directive-concurrent-failed");
    await runStore.block(context, runId, runClaim.leaseGeneration, "directive-concurrent-failed", workId);
    const retryAttemptId = "directive-concurrent-requeue-attempt-0001";
    const retryClaim = await runStore.claim(context, runId, { resumeBlocked: true, retryAttemptId });
    if (retryClaim.outcome !== "claimed") throw new Error("stale retry worker용 run lease를 얻지 못했습니다");
    const barrier = createRunReadBarrier(database);
    const fencedDirectives = await WorkDirectiveStore.create(barrier.database, organizations, {
      clock,
      leaseMs: 1_000,
    });
    barrier.enable();
    const staleRequeue = fencedDirectives.requeueFailed(context, runId, retryAttemptId, retryClaim.leaseGeneration);
    await barrier.entered;
    await database.query(
      "UPDATE application_run SET lease_generation = $next_generation, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND run_id = $run_id AND lease_generation = $previous_generation;",
      {
        organization_id: context.organizationId,
        run_id: runId,
        previous_generation: retryClaim.leaseGeneration,
        next_generation: retryClaim.leaseGeneration + 1,
        updated_at: new Date("2026-07-22T00:00:00.500Z").toISOString(),
      },
    );
    barrier.release();

    await expect(staleRequeue).rejects.toThrow("run lease generation");
    await expect(directives.listByRun(context, runId)).resolves.toEqual([
      expect.objectContaining({ directiveId: directive.directiveId, status: "failed" }),
    ]);
  });

  it("병렬 submit에서 command 재생과 run 내 FIFO sequence를 보존하고 tenant를 격리한다", async () => {
    expect(APPLICATION_WORK_DIRECTIVE_MIGRATION.id).toBe("0108-application-work-directive");
    const shared = {
      commandId: "directive-concurrent-command-0001",
      correlationId: "directive-concurrent-correlation-0001",
      expectedRevision: 1,
      workId,
      runId,
      content: "동일 command는 한 번만 저장해주세요",
      mode: "now" as const,
    };
    const [first, replayed] = await Promise.all([
      directives.submit(context, shared),
      directives.submit(context, shared),
    ]);
    expect(replayed.directiveId).toBe(first.directiveId);
    await Promise.all([
      directives.submit(context, {
        ...shared,
        commandId: "directive-concurrent-command-0002",
        correlationId: "directive-concurrent-correlation-0002",
      }),
      directives.submit(context, {
        ...shared,
        commandId: "directive-concurrent-command-0003",
        correlationId: "directive-concurrent-correlation-0003",
      }),
    ]);
    expect((await directives.listByRun(context, runId)).map((directive) => directive.sequence)).toEqual([1, 2, 3]);

    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identities.registerPersonalUser({
      email: "directive-other@example.com",
      displayName: "Other directive",
    });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(directives.listByRun(otherContext, runId)).resolves.toEqual([]);
    await expect(directives.claimEligible(otherContext, runId, "context-strategy", 0)).rejects.toThrow(
      "찾을 수 없습니다",
    );
  });
});
