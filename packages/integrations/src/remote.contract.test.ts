import { createHash, randomUUID } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { IntegrationStore } from "./store.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("Integration remote contract", () => {
  remoteTest("실제 SurrealDB 3.2.x에서 delivery·lease·outbox·receipt 계보를 보존한다", async () => {
    const databaseName = `integration_${randomUUID().replaceAll("-", "")}`;
    await using admin = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "main",
      database: "main",
      authentication: { username: "root", password: "root" },
    });
    await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: `${databaseName}@example.com`,
      displayName: "Integration Remote",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await IntegrationStore.create(database, organizations);
    const installation = await store.connect(context, {
      commandId: "remote-connect-0001",
      platform: "github",
      externalTenantId: "98765432",
      credentialRef: "credential:github:remote",
      scopes: ["metadata:read"],
    });
    await store.bindChannel(context, {
      commandId: "remote-bind-repository-0001",
      installationId: installation.installationId,
      externalResourceId: "massion/project",
      resourceKind: "repository",
      events: ["issues", "surface.response"],
    });
    const input = {
      installationId: installation.installationId,
      deliveryId: "b2d3f7c0-90aa-11ee-b9d1-0242ac120002",
      eventType: "issues.opened",
      bodyHash: digest("remote-body"),
      normalizedPayload: { kind: "application-command", operation: "work.create" },
      receivedAt: new Date("2026-07-11T00:00:00.000Z"),
    };
    const [first, repeated] = await Promise.all([
      store.acceptDelivery(context, input),
      store.acceptDelivery(context, input),
    ]);
    expect([first.replayed, repeated.replayed].sort()).toEqual([false, true]);
    const claimed = await store.claimDelivery(context, {
      workerId: "remote-worker",
      now: new Date("2026-07-11T00:00:01.000Z"),
      leaseMs: 1_000,
    });
    if (!claimed) throw new Error("원격 delivery claim이 없습니다");
    await store.completeDelivery(context, {
      deliveryRecordId: claimed.deliveryRecordId,
      workerId: "remote-worker",
      leaseGeneration: claimed.leaseGeneration,
      outcome: "succeeded",
      resultHash: digest("remote-result"),
    });
    const queued = await store.enqueue(context, {
      commandId: "remote-outbox-0001",
      installationId: installation.installationId,
      destination: "massion/project",
      operation: "surface.response",
      idempotencyKey: "remote-effect-0001",
      payload: { kind: "check-run" },
    });
    const effect = await store.claimOutbox(context, {
      workerId: "remote-sender",
      now: new Date("2100-01-01T00:00:00.000Z"),
      leaseMs: 1_000,
    });
    if (!effect) throw new Error("원격 outbox claim이 없습니다");
    await expect(
      store.completeOutbox(context, {
        outboxId: queued.outboxId,
        workerId: "remote-sender",
        leaseGeneration: effect.leaseGeneration,
        externalId: "check-run-12345678",
        externalUrl: "https://github.com/massion/project/runs/1",
        responseHash: digest("remote-response"),
      }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
