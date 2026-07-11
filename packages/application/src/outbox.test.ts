import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationOutbox } from "./outbox.js";
import { APPLICATION_OUTBOX_MIGRATION } from "./schema.js";

describe("ApplicationOutbox", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let works: WorkService;
  let outbox: ApplicationOutbox;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "outbox@example.com", displayName: "Outbox" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    works = await WorkService.create(database, organizations, graph);
    outbox = await ApplicationOutbox.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  it("0067 migration checksum과 source trigger를 고정한다", () => {
    expect(APPLICATION_OUTBOX_MIGRATION.id).toBe("0067-application-outbox");
    expect(APPLICATION_OUTBOX_MIGRATION.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("Organization·Work domain event와 같은 transaction에서 source reference를 만든다", async () => {
    const bootstrapped = await graph.bootstrap(context);
    const created = await works.createWork(context, {
      commandId: "outbox-create-work-0001",
      text: "outbox를 검증합니다",
      surface: "test",
      organizationVersionId: bootstrapped.version.version_id,
    });

    const pending = await outbox.listPending(context, 10);
    expect(pending.map((item) => item.sourceKind)).toEqual(["organization-version", "work-event"]);
    expect(pending.at(-1)).toMatchObject({
      sourceId: created.event.event_id,
      aggregateId: created.work.work_id,
      correlationId: "outbox-create-work-0001",
    });
  });

  it("domain transaction rollback이면 outbox reference도 남지 않는다", async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          "CREATE work_event CONTENT { event_id: 'rolled-back-event', organization_id: $organization_id, work_id: 'rolled-back-work', sequence: 1, command_id: 'rolled-back-command', event_type: 'work_state_changed', actor_user_id: $actor_user_id, caused_by_event_id: NONE, request_json: '{}', payload_json: '{}', result_json: '{}', created_at: time::now() };",
          { organization_id: context.organizationId, actor_user_id: context.userId },
        );
        throw new Error("rollback injection");
      }),
    ).rejects.toThrow("rollback injection");
    expect((await outbox.listPending(context, 10)).some((item) => item.sourceId === "rolled-back-event")).toBe(false);
  });
});
