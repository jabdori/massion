import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationOutboundDispatcher } from "./outbound.js";
import { IntegrationStore } from "./store.js";

describe("IntegrationOutboundDispatcher", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: IntegrationStore;
  let installationId: string;
  const connector = vi.fn(async () => ({
    method: "chat.postMessage",
    destination: "C012ABCDEF",
    body: { text: "Massion work.create: succeeded", unfurl_links: false, unfurl_media: false },
  }));
  const network = vi.fn<
    (input: unknown) => Promise<{ status: number; headers: Record<string, string | undefined>; body: unknown }>
  >(async () => ({ status: 200, headers: {}, body: { ok: true, ts: "1234.5678" } }));
  let dispatcher: IntegrationOutboundDispatcher;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "outbound@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await IntegrationStore.create(database, organizations);
    installationId = (
      await store.connect(context, {
        commandId: "connect-outbound",
        platform: "slack",
        externalTenantId: "T012ABCDEF",
        credentialRef: "credential:slack:primary",
        scopes: ["chat:write"],
      })
    ).installationId;
    connector.mockClear();
    network.mockClear();
    network.mockResolvedValue({ status: 200, headers: {}, body: { ok: true, ts: "1234.5678" } });
    dispatcher = new IntegrationOutboundDispatcher({
      store,
      connectors: { invoke: connector },
      network: { request: network },
    });
  });

  afterEach(async () => database.close());

  async function enqueue(commandId: string) {
    return await store.enqueue(context, {
      commandId,
      installationId,
      destination: "C012ABCDEF",
      operation: "surface.response",
      idempotencyKey: `${commandId}:effect`,
      payload: {
        result: {
          operation: "work.create",
          outcome: "succeeded",
          resource: { type: "Work", id: "work-12345678" },
          data: { privatePrompt: "외부에 나가면 안 됨" },
        },
      },
    });
  }

  it("공개 결과 요약만 Extension으로 보내고 credential reference로 외부 전송한 뒤 receipt를 기록한다", async () => {
    const outbox = await enqueue("notify-success");
    await expect(dispatcher.runOnce(context, "sender-a", new Date("2100-01-01T00:00:00.000Z"))).resolves.toBe(true);

    expect(connector).toHaveBeenCalledWith(
      "slack",
      "eventConsumers:slack-notification",
      expect.objectContaining({
        destination: "C012ABCDEF",
        text: "Massion work.create: succeeded · Work work-12345678",
      }),
    );
    expect(JSON.stringify(connector.mock.calls)).not.toContain("privatePrompt");
    expect(network).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: "credential:slack:primary",
        origin: "https://slack.com",
        path: "/api/chat.postMessage",
        idempotencyKey: "notify-success:effect",
      }),
    );
    const [receipts] = await database.query<[Array<{ outbox_id: string; external_id: string }>]>(
      "SELECT outbox_id, external_id FROM integration_receipt;",
    );
    expect(receipts).toEqual([{ outbox_id: outbox.outboxId, external_id: "1234.5678" }]);
  });

  it("429 Retry-After를 installation 전송 재개 시각으로 사용한다", async () => {
    await enqueue("notify-rate-limit");
    network.mockResolvedValueOnce({ status: 429, headers: { "retry-after": "30" }, body: {} });
    const now = new Date("2100-01-01T00:00:00.000Z");
    await dispatcher.runOnce(context, "sender-a", now);
    expect(
      await store.claimOutbox(context, {
        workerId: "sender-b",
        now: new Date(now.getTime() + 29_999),
        leaseMs: 1_000,
      }),
    ).toBeUndefined();
    expect(
      await store.claimOutbox(context, {
        workerId: "sender-b",
        now: new Date(now.getTime() + 30_000),
        leaseMs: 1_000,
      }),
    ).toMatchObject({ attempt: 2 });
  });

  it("권한 4xx는 자동 재시도하지 않고 blocked로 둔다", async () => {
    const outbox = await enqueue("notify-forbidden");
    network.mockResolvedValueOnce({ status: 403, headers: {}, body: { message: "forbidden" } });
    await dispatcher.runOnce(context, "sender-a", new Date("2100-01-01T00:00:00.000Z"));
    const [rows] = await database.query<[Array<{ state: string; error_category: string }>]>(
      "SELECT state, error_category FROM integration_outbox WHERE outbox_id=$outbox_id;",
      { outbox_id: outbox.outboxId },
    );
    expect(rows).toEqual([{ state: "blocked", error_category: "http-403" }]);
  });
});
