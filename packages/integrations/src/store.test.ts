import { createHash } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IntegrationStore } from "./store.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("IntegrationStore", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let other: TenantContext;
  let store: IntegrationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    const outsider = await identities.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    other = await organizations.resolveTenantContext(outsider.user.user_id, outsider.organization.organization_id);
    store = await IntegrationStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("외부 tenant 설치와 확인된 사용자 binding을 tenant 안에 저장한다", async () => {
    const installation = await store.connect(context, {
      commandId: "connect-slack",
      platform: "slack",
      externalTenantId: "T012ABCDEF",
      credentialRef: "credential:slack:primary",
      scopes: ["chat:write", "commands"],
    });
    const binding = await store.bindUser(context, {
      commandId: "bind-owner",
      installationId: installation.installationId,
      externalUserId: "U012ABCDEF",
      userId: context.userId,
    });

    expect(installation).toMatchObject({ platform: "slack", revision: 1, state: "active" });
    expect(binding).toMatchObject({ externalUserId: "U012ABCDEF", userId: context.userId, state: "active" });
    await expect(store.getInstallation(other, installation.installationId)).rejects.toThrow("찾을 수 없습니다");
  });

  it("credential 원문처럼 보이는 reference와 다른 command replay를 거부한다", async () => {
    await expect(
      store.connect(context, {
        commandId: "connect-secret",
        platform: "github",
        externalTenantId: "12345678",
        credentialRef: "ghs_this_is_a_raw_token_123456789",
        scopes: ["metadata:read"],
      }),
    ).rejects.toThrow("credential reference");
    const input = {
      commandId: "connect-github",
      platform: "github" as const,
      externalTenantId: "12345678",
      credentialRef: "credential:github:app",
      scopes: ["metadata:read"],
    };
    const first = await store.connect(context, input);
    expect(await store.connect(context, input)).toEqual(first);
    await expect(store.connect(context, { ...input, externalTenantId: "87654321" })).rejects.toThrow("command");
  });

  it("동일 delivery를 한 번만 수락하고 같은 ID의 다른 body는 차단한다", async () => {
    const installation = await store.connect(context, {
      commandId: "connect-discord",
      platform: "discord",
      externalTenantId: "123456789012345678",
      credentialRef: "credential:discord:primary",
      scopes: ["applications.commands"],
    });
    const input = {
      installationId: installation.installationId,
      deliveryId: "123456789012345678",
      eventType: "APPLICATION_COMMAND",
      bodyHash: hash("same"),
      receivedAt: new Date("2026-07-11T00:00:00.000Z"),
    };

    const [first, second] = await Promise.all([
      store.acceptDelivery(context, input),
      store.acceptDelivery(context, input),
    ]);
    expect(first.deliveryId).toBe(second.deliveryId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(store.acceptDelivery(context, { ...input, bodyHash: hash("different") })).rejects.toThrow("body hash");
  });

  it("delivery lease를 회수하고 완료 결과를 멱등하게 기록한다", async () => {
    const installation = await store.connect(context, {
      commandId: "connect-gh-delivery",
      platform: "github",
      externalTenantId: "98765432",
      credentialRef: "credential:github:webhook",
      scopes: ["metadata:read"],
    });
    const delivery = await store.acceptDelivery(context, {
      installationId: installation.installationId,
      deliveryId: "b2d3f7c0-90aa-11ee-b9d1-0242ac120002",
      eventType: "issues.opened",
      bodyHash: hash("issue"),
      receivedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    const first = await store.claimDelivery(context, {
      workerId: "worker-a",
      now: new Date("2026-07-11T00:00:01.000Z"),
      leaseMs: 1_000,
    });
    expect(first).toMatchObject({ deliveryRecordId: delivery.deliveryRecordId, leaseGeneration: 1 });
    expect(
      await store.claimDelivery(context, {
        workerId: "worker-b",
        now: new Date("2026-07-11T00:00:01.500Z"),
        leaseMs: 1_000,
      }),
    ).toBeUndefined();
    const recovered = await store.claimDelivery(context, {
      workerId: "worker-b",
      now: new Date("2026-07-11T00:00:02.001Z"),
      leaseMs: 1_000,
    });
    expect(recovered).toMatchObject({ leaseGeneration: 2 });
    await store.completeDelivery(context, {
      deliveryRecordId: delivery.deliveryRecordId,
      workerId: "worker-b",
      leaseGeneration: 2,
      outcome: "succeeded",
      resultHash: hash("work-created"),
    });
    expect(
      await store.claimDelivery(context, { workerId: "worker-c", now: new Date(), leaseMs: 1_000 }),
    ).toBeUndefined();
  });

  it("외부 side effect outbox를 멱등 생성하고 Retry-After 뒤로 예약한다", async () => {
    const installation = await store.connect(context, {
      commandId: "connect-slack-outbox",
      platform: "slack",
      externalTenantId: "T999999999",
      credentialRef: "credential:slack:outbox",
      scopes: ["chat:write"],
    });
    const input = {
      commandId: "notify-work-1",
      installationId: installation.installationId,
      destination: "C012ABCDEF",
      operation: "chat.postMessage",
      idempotencyKey: "work:1:revision:2",
      payload: { text: "완료" },
    };
    const first = await store.enqueue(context, input);
    expect(await store.enqueue(context, input)).toEqual(first);
    const claimed = await store.claimOutbox(context, {
      workerId: "sender-a",
      now: new Date("2100-01-01T00:00:00.000Z"),
      leaseMs: 1_000,
    });
    expect(claimed?.payload).toEqual({ text: "완료" });
    await store.retryOutbox(context, {
      outboxId: first.outboxId,
      workerId: "sender-a",
      leaseGeneration: 1,
      nextAttemptAt: new Date("2100-01-01T00:00:30.000Z"),
      errorCategory: "rate-limit",
    });
    expect(
      await store.claimOutbox(context, {
        workerId: "sender-b",
        now: new Date("2100-01-01T00:00:29.999Z"),
        leaseMs: 1_000,
      }),
    ).toBeUndefined();
  });

  it("성공한 outbox를 immutable 외부 receipt와 원자적으로 완료한다", async () => {
    const installation = await store.connect(context, {
      commandId: "connect-receipt",
      platform: "slack",
      externalTenantId: "TRECEIPT01",
      credentialRef: "credential:slack:receipt",
      scopes: ["chat:write"],
    });
    const queued = await store.enqueue(context, {
      commandId: "receipt-command",
      installationId: installation.installationId,
      destination: "CRECEIPT01",
      operation: "chat.postMessage",
      idempotencyKey: "receipt-effect-1",
      payload: { text: "완료" },
    });
    const claimed = await store.claimOutbox(context, {
      workerId: "sender-receipt",
      now: new Date("2100-01-01T00:00:00.000Z"),
      leaseMs: 1_000,
    });
    if (!claimed) throw new Error("outbox claim 결과가 없습니다");
    await expect(
      store.completeOutbox(context, {
        outboxId: queued.outboxId,
        workerId: "sender-receipt",
        leaseGeneration: claimed.leaseGeneration,
        externalId: "1234.5678",
        responseHash: hash("response"),
      }),
    ).resolves.toMatchObject({ externalId: "1234.5678", replayed: false });
  });
});
