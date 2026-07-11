import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationEventBuffer, ApplicationEventStore, ApplicationEventCursorExpiredError } from "./event-store.js";

describe("ApplicationEventStore", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: ApplicationEventStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "events@example.com", displayName: "Events" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await ApplicationEventStore.create(database, organizations);
  });

  afterEach(async () => {
    await database.close();
  });

  it("after cursor와 limit을 적용하고 retention 아래 cursor를 snapshot-required로 거부한다", async () => {
    await store.appendSystemEvents(context, ["one.created", "two.created", "three.created"]);
    expect((await store.read(context, { after: 1, limit: 1 })).events.map((event) => event.sequence)).toEqual([2]);
    await store.advanceRetention(context, 3);
    await expect(store.read(context, { after: 1, limit: 10 })).rejects.toBeInstanceOf(
      ApplicationEventCursorExpiredError,
    );
    await expect(store.read(context, { after: 0, limit: 10 })).resolves.toMatchObject({ snapshotRequired: false });
  });

  it("다른 tenant는 event를 읽지 못한다", async () => {
    await store.appendSystemEvents(context, ["tenant.created"]);
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identities.registerPersonalUser({ email: "events-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    expect((await store.read(otherContext, { after: 0, limit: 10 })).events).toEqual([]);
  });

  it("client buffer 1,000 event·4 MiB 상한을 넘으면 fail closed한다", () => {
    const buffer = new ApplicationEventBuffer({ maxEvents: 2, maxBytes: 256 });
    buffer.enqueue({ sequence: 1, body: "a" });
    buffer.enqueue({ sequence: 2, body: "b" });
    expect(() => buffer.enqueue({ sequence: 3, body: "c" })).toThrow("event 상한");
    expect(buffer.dequeue()).toEqual({ sequence: 1, body: "a" });
    expect(() =>
      new ApplicationEventBuffer({ maxEvents: 1_000, maxBytes: 4 * 1024 * 1024 }).enqueue({
        sequence: 1,
        body: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).toThrow("byte 상한");
  });
});
