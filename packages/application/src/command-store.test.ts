import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationCommandStore, type ApplicationCommandClock } from "./command-store.js";
import { APPLICATION_COMMAND_MIGRATION } from "./schema.js";

class MutableCommandClock implements ApplicationCommandClock {
  public constructor(public now: Date) {}
}

const command = {
  schemaVersion: "massion.application.v1" as const,
  commandId: "command-store-request-0001",
  correlationId: "correlation-store-request-0001",
  operation: "work.create",
  payload: { text: "멱등 Work" },
};

describe("ApplicationCommandStore", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let clock: MutableCommandClock;
  let store: ApplicationCommandStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "command@example.com", displayName: "Command" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    clock = new MutableCommandClock(new Date("2026-07-11T01:00:00.000Z"));
    store = await ApplicationCommandStore.create(database, organizations, { clock, leaseMs: 30_000 });
  });

  afterEach(async () => {
    await database.close();
  });

  it("0066 migration checksum을 고정한다", () => {
    expect(APPLICATION_COMMAND_MIGRATION.id).toBe("0066-application-command");
    expect(APPLICATION_COMMAND_MIGRATION.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("같은 command payload는 한 번 claim하고 완료 결과를 replay한다", async () => {
    const claimed = await store.begin(context, command);
    expect(claimed).toMatchObject({ outcome: "claimed", leaseGeneration: 1 });
    if (claimed.outcome !== "claimed") throw new Error("command를 claim하지 못했습니다");
    const result = {
      schemaVersion: "massion.application.v1" as const,
      commandId: command.commandId,
      correlationId: command.correlationId,
      operation: command.operation,
      outcome: "succeeded" as const,
      resource: { type: "Work", id: "work-created-0001", revision: 0 },
      data: { workId: "work-created-0001" },
    };
    await store.complete(context, claimed.commandRecordId, claimed.leaseGeneration, result);

    await expect(store.begin(context, command)).resolves.toEqual({ outcome: "replayed", result });
    await expect(store.begin(context, { ...command, payload: { text: "다른 Work" } })).rejects.toThrow(
      "같은 commandId",
    );
  });

  it("살아 있는 lease는 중복 실행을 막고 만료 뒤 generation을 올려 회수한다", async () => {
    const first = await store.begin(context, { ...command, commandId: "command-lease-request-0001" });
    if (first.outcome !== "claimed") throw new Error("command를 claim하지 못했습니다");
    await expect(store.begin(context, { ...command, commandId: "command-lease-request-0001" })).resolves.toMatchObject({
      outcome: "in-progress",
      leaseGeneration: 1,
    });
    clock.now = new Date("2026-07-11T01:00:31.000Z");
    await expect(store.begin(context, { ...command, commandId: "command-lease-request-0001" })).resolves.toMatchObject({
      outcome: "claimed",
      recovered: true,
      leaseGeneration: 2,
      commandRecordId: first.commandRecordId,
    });
  });

  it("stale generation 완료와 다른 tenant command 조회를 거부한다", async () => {
    const first = await store.begin(context, { ...command, commandId: "command-stale-request-0001" });
    if (first.outcome !== "claimed") throw new Error("command를 claim하지 못했습니다");
    clock.now = new Date("2026-07-11T01:00:31.000Z");
    const recovered = await store.begin(context, { ...command, commandId: "command-stale-request-0001" });
    if (recovered.outcome !== "claimed") throw new Error("command를 회수하지 못했습니다");
    await expect(
      store.complete(context, first.commandRecordId, 1, {
        schemaVersion: "massion.application.v1",
        commandId: "command-stale-request-0001",
        correlationId: command.correlationId,
        operation: command.operation,
        outcome: "succeeded",
      }),
    ).rejects.toThrow("generation");

    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identities.registerPersonalUser({ email: "command-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await expect(store.get(otherContext, recovered.commandRecordId)).rejects.toThrow("찾을 수 없습니다");
  });
});
