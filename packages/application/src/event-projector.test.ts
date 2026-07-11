import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationEventProjector } from "./event-projector.js";
import { ApplicationEventStore } from "./event-store.js";
import { ApplicationRunStore } from "./run-store.js";

describe("ApplicationEventProjector", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let works: WorkService;
  let projector: ApplicationEventProjector;
  let events: ApplicationEventStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "projector@example.com", displayName: "Projector" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    works = await WorkService.create(database, organizations, graph);
    projector = await ApplicationEventProjector.create(database, organizations);
    events = await ApplicationEventStore.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  it("public allowlist mapper로 조직별 연속 sequence를 만들고 replay는 중복하지 않는다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    await works.createWork(context, {
      commandId: "projector-create-work-0001",
      text: "공개 event projection",
      surface: "test",
      organizationVersionId: bootstrapped.version.version_id,
    });

    expect(await projector.projectPending(context, 10)).toBe(2);
    expect(await projector.projectPending(context, 10)).toBe(0);
    const projected = await events.read(context, { after: 0, limit: 10 });
    expect(projected.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "organization.version-created"],
      [2, "work.created"],
    ]);
    expect(JSON.stringify(projected)).not.toContain("request_json");
    expect(JSON.stringify(projected)).not.toContain("공개 event projection");
  });

  it("event create 뒤 오류는 outbox와 sequence까지 rollback하고 다음 실행이 같은 source를 복구한다", async () => {
    await graph.bootstrap(context);
    const crashing = await ApplicationEventProjector.create(database, organizations, {
      afterEventCreated: () => {
        throw new Error("projection crash injection");
      },
    });
    await expect(crashing.projectPending(context, 1)).rejects.toThrow("projection crash injection");
    expect((await events.read(context, { after: 0, limit: 10 })).events).toEqual([]);

    expect(await projector.projectPending(context, 10)).toBe(1);
    expect((await events.read(context, { after: 0, limit: 10 })).events[0]).toMatchObject({
      sequence: 1,
      type: "organization.version-created",
    });
  });

  it("두 projector가 동시에 실행돼도 source 중복과 sequence gap을 만들지 않는다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    await Promise.all(
      [1, 2, 3].map(
        async (index) =>
          await works.createWork(context, {
            commandId: `projector-concurrent-work-000${String(index)}`,
            text: `동시 Work ${String(index)}`,
            surface: "test",
            organizationVersionId: bootstrapped.version.version_id,
          }),
      ),
    );
    const other = await ApplicationEventProjector.create(database, organizations);
    await Promise.all([projector.projectPending(context, 10), other.projectPending(context, 10)]);
    const projected = (await events.read(context, { after: 0, limit: 10 })).events;
    expect(projected.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(projected.map((event) => event.eventId))).toHaveProperty("size", 4);
  });

  it("Core run 상태를 correlation이 보존된 공개 event로 투영한다", async () => {
    const runs = await ApplicationRunStore.create(database, organizations);
    const run = await runs.start(context, {
      commandId: "projector-run-command-0001",
      correlationId: "projector-run-correlation-0001",
      request: {},
    });
    await projector.projectPending(context, 10);
    const projected = (await events.read(context, { after: 0, limit: 10 })).events;
    expect(projected.at(-1)).toMatchObject({
      type: "run.started",
      correlationId: "projector-run-correlation-0001",
      resource: { type: "ApplicationRun", id: run.runId, revision: 0 },
      payload: { stage: "intake" },
    });
  });
});
