import { randomBytes } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CredentialVault, ModelRouter, ProviderService } from "@massion/router";
import {
  applyMigrations,
  createDatabase,
  defineMigration,
  listAppliedMigrations,
  type MassionDatabase,
} from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationRunStore, type ApplicationRunClock } from "./run-store.js";
import { APPLICATION_RUN_MIGRATION } from "./schema.js";

class MutableRunClock implements ApplicationRunClock {
  public constructor(public now: Date) {}
}

const LEGACY_APPLICATION_RUN_MIGRATION = defineMigration(
  "0069-application-run",
  `
DEFINE TABLE application_run SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD run_id ON application_run TYPE string;
DEFINE FIELD organization_id ON application_run TYPE string;
DEFINE FIELD actor_user_id ON application_run TYPE string;
DEFINE FIELD command_id ON application_run TYPE string;
DEFINE FIELD correlation_id ON application_run TYPE string;
DEFINE FIELD request_json ON application_run TYPE string;
DEFINE FIELD request_hash ON application_run TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD work_id ON application_run TYPE option<string>;
DEFINE FIELD stage ON application_run TYPE string ASSERT $value IN ['intake', 'context-strategy', 'evidence', 'delivery', 'assurance', 'records', 'terminal'];
DEFINE FIELD status ON application_run TYPE string ASSERT $value IN ['ready', 'running', 'awaiting-approval', 'blocked', 'completed', 'failed', 'cancelled'];
DEFINE FIELD approval_id ON application_run TYPE option<string>;
DEFINE FIELD blocked_reason ON application_run TYPE option<string>;
DEFINE FIELD result_json ON application_run TYPE option<string>;
DEFINE FIELD result_hash ON application_run TYPE option<string>;
DEFINE FIELD lease_generation ON application_run TYPE int ASSERT $value >= 0;
DEFINE FIELD lease_expires_at ON application_run TYPE option<datetime>;
DEFINE FIELD created_at ON application_run TYPE datetime;
DEFINE FIELD updated_at ON application_run TYPE datetime;
DEFINE INDEX application_run_id ON application_run FIELDS organization_id, run_id UNIQUE;
DEFINE INDEX application_run_command ON application_run FIELDS organization_id, command_id UNIQUE;

DEFINE TABLE application_run_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD event_id ON application_run_event TYPE string;
DEFINE FIELD organization_id ON application_run_event TYPE string;
DEFINE FIELD run_id ON application_run_event TYPE string;
DEFINE FIELD correlation_id ON application_run_event TYPE string;
DEFINE FIELD lease_generation ON application_run_event TYPE int ASSERT $value >= 0;
DEFINE FIELD stage ON application_run_event TYPE string ASSERT $value IN ['intake', 'context-strategy', 'evidence', 'delivery', 'assurance', 'records', 'terminal'];
DEFINE FIELD event_type ON application_run_event TYPE string ASSERT $value IN ['started', 'claimed', 'reclaimed', 'advanced', 'suspended', 'blocked', 'completed', 'failed', 'cancelled'];
DEFINE FIELD detail_hash ON application_run_event TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD created_at ON application_run_event TYPE datetime;
DEFINE INDEX application_run_event_id ON application_run_event FIELDS organization_id, event_id UNIQUE;
DEFINE EVENT application_run_event_immutable ON TABLE application_run_event
WHEN $event IN ['UPDATE', 'DELETE']
THEN { THROW 'Application run event는 immutable입니다'; };

DEFINE EVENT application_outbox_from_run ON TABLE application_run_event
WHEN $event = 'CREATE'
THEN {
  CREATE application_outbox CONTENT { outbox_id: string::concat('run-event:', $after.event_id), organization_id: $after.organization_id, source_kind: 'run-event', source_id: $after.event_id, aggregate_id: $after.run_id, correlation_id: $after.correlation_id, causation_id: NONE, occurred_at: $after.created_at, state: 'pending', public_event_id: NONE, created_at: time::now(), updated_at: time::now() };
};
`,
);

describe("ApplicationRunStore", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let clock: MutableRunClock;
  let store: ApplicationRunStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "run-store@example.com", displayName: "Run" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    clock = new MutableRunClock(new Date("2026-07-11T06:00:00.000Z"));
    store = await ApplicationRunStore.create(database, organizations, { clock, leaseMs: 30_000 });
  });

  afterEach(async () => database.close());

  it("0069 migration checksum을 고정한다", () => {
    expect(APPLICATION_RUN_MIGRATION.id).toBe("0069-application-run");
    expect(APPLICATION_RUN_MIGRATION.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("기존 0069 checksum 데이터베이스에 재시도 schema migration을 적용한다", async () => {
    await using legacyDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    await applyMigrations(legacyDatabase, [LEGACY_APPLICATION_RUN_MIGRATION]);
    await IdentityService.create(legacyDatabase);
    const organizations = await OrganizationService.create(legacyDatabase);

    await expect(ApplicationRunStore.create(legacyDatabase, organizations)).resolves.toBeInstanceOf(
      ApplicationRunStore,
    );
    expect((await listAppliedMigrations(legacyDatabase)).map((migration) => migration.migration_id)).toEqual(
      expect.arrayContaining(["0069-application-run", "0105-application-run-retry"]),
    );
  });

  it("Router의 0090 migration이 적용된 데이터베이스에도 재시도 schema migration을 적용한다", async () => {
    await using routerDatabase = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    await IdentityService.create(routerDatabase);
    const organizations = await OrganizationService.create(routerDatabase);
    const providers = await ProviderService.create(routerDatabase, organizations, new CredentialVault(randomBytes(32)));
    await ModelRouter.create(routerDatabase, organizations, providers);

    await expect(ApplicationRunStore.create(routerDatabase, organizations)).resolves.toBeInstanceOf(
      ApplicationRunStore,
    );
    expect((await listAppliedMigrations(routerDatabase)).map((migration) => migration.migration_id)).toEqual(
      expect.arrayContaining(["0090-router-subscription-endpoint", "0105-application-run-retry"]),
    );
  });

  it("같은 시작 command는 같은 run을 replay하고 다른 request를 거부한다", async () => {
    const first = await store.start(context, {
      commandId: "application-run-start-0001",
      correlationId: "application-run-correlation-0001",
      request: { text: "제품화" },
    });
    const repeated = await store.start(context, {
      commandId: "application-run-start-0001",
      correlationId: "application-run-correlation-0001",
      request: { text: "제품화" },
    });
    expect(repeated.runId).toBe(first.runId);
    await expect(
      store.start(context, {
        commandId: "application-run-start-0001",
        correlationId: "application-run-correlation-0001",
        request: { text: "다른 요청" },
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("lease 한 개만 claim하고 만료 뒤 generation을 올려 회수한다", async () => {
    const run = await store.start(context, {
      commandId: "application-run-lease-0001",
      correlationId: "application-run-lease-correlation-0001",
      request: {},
    });
    expect(await store.claim(context, run.runId)).toMatchObject({ outcome: "claimed", leaseGeneration: 1 });
    expect(await store.claim(context, run.runId)).toMatchObject({ outcome: "in-progress", leaseGeneration: 1 });
    clock.now = new Date("2026-07-11T06:00:31.000Z");
    expect(await store.claim(context, run.runId)).toMatchObject({
      outcome: "claimed",
      leaseGeneration: 2,
      recovered: true,
    });
  });

  it("차단된 run의 활성 재시도 시도 ID를 다음 stage에서 재실행 ID로 옮긴다", async () => {
    const run = await store.start(context, {
      commandId: "application-run-retry-0001",
      correlationId: "application-run-retry-correlation-0001",
      request: {},
    });
    const firstClaim = await store.claim(context, run.runId);
    if (firstClaim.outcome !== "claimed") throw new Error("첫 lease를 얻지 못했습니다");
    await store.block(context, run.runId, firstClaim.leaseGeneration, "assurance-verifier-interrupted");

    const retry = await store.claim(context, run.runId, {
      resumeBlocked: true,
      retryAttemptId: "run-resume-retry-command-0001",
    });
    expect(retry).toMatchObject({
      outcome: "claimed",
      leaseGeneration: 2,
      retryAttemptId: "run-resume-retry-command-0001",
    });
    expect(await store.get(context, run.runId)).toMatchObject({
      retryAttemptId: "run-resume-retry-command-0001",
    });
    if (retry.outcome !== "claimed") throw new Error("재시도 lease를 얻지 못했습니다");

    clock.now = new Date("2026-07-11T06:00:31.000Z");
    const recovered = await store.claim(context, run.runId);
    expect(recovered).toMatchObject({
      outcome: "claimed",
      recovered: true,
      retryAttemptId: "run-resume-retry-command-0001",
    });
    if (recovered.outcome !== "claimed") throw new Error("재시도 lease를 회수하지 못했습니다");

    await expect(
      store.advance(context, run.runId, recovered.leaseGeneration, { stage: "context-strategy" }),
    ).resolves.toMatchObject({ retryReplayId: "run-resume-retry-command-0001" });
    await expect(store.get(context, run.runId)).resolves.not.toHaveProperty("retryAttemptId");

    const followingClaim = await store.claim(context, run.runId);
    if (followingClaim.outcome !== "claimed") throw new Error("다음 stage lease를 얻지 못했습니다");
    await expect(
      store.advance(context, run.runId, followingClaim.leaseGeneration, { stage: "evidence" }),
    ).resolves.toMatchObject({ retryReplayId: "run-resume-retry-command-0001" });
  });

  it("다음 차단 재시도는 이전 시도 ID를 교체하고 빈 ID를 거부한다", async () => {
    const run = await store.start(context, {
      commandId: "application-run-retry-0002",
      correlationId: "application-run-retry-correlation-0002",
      request: {},
    });
    const firstClaim = await store.claim(context, run.runId);
    if (firstClaim.outcome !== "claimed") throw new Error("첫 lease를 얻지 못했습니다");
    await store.block(context, run.runId, firstClaim.leaseGeneration, "assurance-verifier-interrupted");

    await expect(store.claim(context, run.runId, { resumeBlocked: true, retryAttemptId: " " })).rejects.toThrow(
      "재시도 시도 ID",
    );

    const firstRetry = await store.claim(context, run.runId, {
      resumeBlocked: true,
      retryAttemptId: "run-resume-retry-command-0002",
    });
    if (firstRetry.outcome !== "claimed") throw new Error("첫 재시도 lease를 얻지 못했습니다");
    await store.block(context, run.runId, firstRetry.leaseGeneration, "assurance-verifier-interrupted");

    const secondRetry = await store.claim(context, run.runId, {
      resumeBlocked: true,
      retryAttemptId: "run-resume-retry-command-0003",
    });
    expect(secondRetry).toMatchObject({
      outcome: "claimed",
      retryAttemptId: "run-resume-retry-command-0003",
    });
    await expect(store.get(context, run.runId)).resolves.toMatchObject({
      retryAttemptId: "run-resume-retry-command-0003",
    });
  });

  it("새 재시도 시도 ID는 실제 차단된 run에만 설정할 수 있다", async () => {
    const ready = await store.start(context, {
      commandId: "application-run-retry-status-ready-0001",
      correlationId: "application-run-retry-status-ready-correlation-0001",
      request: {},
    });
    await expect(
      store.claim(context, ready.runId, { resumeBlocked: true, retryAttemptId: "run-resume-ready-0001" }),
    ).rejects.toThrow("차단된 Application run");

    const running = await store.start(context, {
      commandId: "application-run-retry-status-running-0001",
      correlationId: "application-run-retry-status-running-correlation-0001",
      request: {},
    });
    await store.claim(context, running.runId);
    await expect(
      store.claim(context, running.runId, { resumeBlocked: true, retryAttemptId: "run-resume-running-0001" }),
    ).rejects.toThrow("차단된 Application run");

    const blocked = await store.start(context, {
      commandId: "application-run-retry-status-blocked-0001",
      correlationId: "application-run-retry-status-blocked-correlation-0001",
      request: {},
    });
    const initialClaim = await store.claim(context, blocked.runId);
    if (initialClaim.outcome !== "claimed") throw new Error("차단할 lease를 얻지 못했습니다");
    await store.block(context, blocked.runId, initialClaim.leaseGeneration, "assurance-verifier-interrupted");
    const attemptId = "run-resume-running-same-attempt-0001";
    await store.claim(context, blocked.runId, { resumeBlocked: true, retryAttemptId: attemptId });
    await expect(
      store.claim(context, blocked.runId, { resumeBlocked: true, retryAttemptId: attemptId }),
    ).rejects.toThrow("차단된 Application run");
  });

  it("stale lease stage 변경과 다른 tenant 조회를 거부한다", async () => {
    const run = await store.start(context, {
      commandId: "application-run-stale-0001",
      correlationId: "application-run-stale-correlation-0001",
      request: {},
    });
    await store.claim(context, run.runId);
    clock.now = new Date("2026-07-11T06:00:31.000Z");
    const recovered = await store.claim(context, run.runId);
    if (recovered.outcome !== "claimed") throw new Error("run을 회수하지 못했습니다");
    await expect(
      store.advance(context, run.runId, 1, { stage: "context-strategy", workId: "work-run" }),
    ).rejects.toThrow("generation");

    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identities.registerPersonalUser({ email: "run-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(store.get(otherContext, run.runId)).rejects.toThrow("찾을 수 없습니다");
  });
});
