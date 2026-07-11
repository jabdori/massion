import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationRunStore, type ApplicationRunClock } from "./run-store.js";
import { APPLICATION_RUN_MIGRATION } from "./schema.js";

class MutableRunClock implements ApplicationRunClock {
  public constructor(public now: Date) {}
}

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
