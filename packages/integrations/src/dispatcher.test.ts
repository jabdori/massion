import { createHash } from "node:crypto";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationDeliveryDispatcher } from "./dispatcher.js";
import { IntegrationStore } from "./store.js";
import type { IntegrationTokenService } from "./tokens.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("IntegrationDeliveryDispatcher", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: IntegrationStore;
  let installationId: string;
  const dispatch = vi.fn(async (_context: TenantContext, _scopes: readonly string[], input: unknown) => ({
    outcome: "succeeded",
    command: input,
  }));
  const query = vi.fn(async (_context: TenantContext, _scopes: readonly string[], operation: string) =>
    operation === "work.rooms" ? { data: [{ roomId: "room-12345678" }] } : { data: { status: "running" } },
  );
  const consumeInteraction = vi.fn(async () => ({ resourceId: "approval-12345678" }));
  let dispatcher: IntegrationDeliveryDispatcher;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "dispatcher@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await IntegrationStore.create(database, organizations);
    installationId = (
      await store.connect(context, {
        commandId: "connect-dispatcher",
        platform: "slack",
        externalTenantId: "T012ABCDEF",
        credentialRef: "credential:slack:dispatcher",
        scopes: ["surface:write"],
      })
    ).installationId;
    dispatch.mockClear();
    query.mockClear();
    consumeInteraction.mockClear();
    dispatcher = new IntegrationDeliveryDispatcher({
      store,
      tokens: { consumeInteraction } as unknown as IntegrationTokenService,
      application: {
        dispatch,
        query,
        async currentOrganizationVersionId() {
          return "organization-version-12345678";
        },
      },
    });
  });

  afterEach(async () => database.close());

  async function accept(deliveryId: string, normalizedPayload: unknown) {
    await store.acceptDelivery(context, {
      installationId,
      deliveryId,
      eventType: "slash-command",
      bodyHash: digest(deliveryId),
      normalizedPayload,
      receivedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
  }

  it("Work 요청을 현재 조직 version과 외부 Surface를 가진 Application command로 실행한다", async () => {
    await accept("delivery-work-12345678", {
      kind: "application-command",
      operation: "work.create",
      actorExternalId: "U012ABCDEF",
      destination: "C012ABCDEF",
      arguments: { request: "결제 오류 조사" },
    });

    await expect(dispatcher.runOnce(context, "worker-a", new Date("2026-07-11T00:00:01.000Z"))).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      context,
      ["work:write"],
      expect.objectContaining({
        operation: "work.create",
        payload: {
          text: "결제 오류 조사",
          surface: "integration:slack",
          organizationVersionId: "organization-version-12345678",
        },
      }),
    );
    const response = await store.claimOutbox(context, {
      workerId: "sender",
      now: new Date("2100-01-01T00:00:00.000Z"),
      leaseMs: 1_000,
    });
    expect(response).toMatchObject({ destination: "C012ABCDEF", operation: "surface.response" });
  });

  it("Work 상태는 read scope query만 사용하고 협업 메시지는 현재 사용자를 작성자로 기록한다", async () => {
    await accept("delivery-status-12345678", {
      kind: "application-command",
      operation: "work.status",
      actorExternalId: "U012ABCDEF",
      destination: "C012ABCDEF",
      arguments: { workId: "work-12345678" },
    });
    await dispatcher.runOnce(context, "worker-a", new Date("2026-07-11T00:00:01.000Z"));
    expect(query).toHaveBeenCalledWith(context, ["work:read"], "work.get", { workId: "work-12345678" });

    await accept("delivery-room-12345678", {
      kind: "application-command",
      operation: "collaboration.post",
      actorExternalId: "U012ABCDEF",
      arguments: { workId: "work-12345678", message: "진행 상황을 알려주세요" },
    });
    await dispatcher.runOnce(context, "worker-b", new Date("2026-07-11T00:00:02.000Z"));
    expect(dispatch).toHaveBeenLastCalledWith(
      context,
      ["collaboration:write"],
      expect.objectContaining({
        operation: "collaboration.message.post",
        payload: expect.objectContaining({ roomId: "room-12345678", authorId: context.userId }),
      }),
    );
  });

  it("승인 결정은 외부 사용자·설치·decision에 결속된 일회 handle을 먼저 소비한다", async () => {
    await accept("delivery-approval-12345678", {
      kind: "application-command",
      operation: "approval.decide",
      actorExternalId: "U012ABCDEF",
      arguments: { handle: "a".repeat(32), decision: "approve" },
    });
    await dispatcher.runOnce(context, "worker-a", new Date("2026-07-11T00:00:01.000Z"));
    expect(consumeInteraction).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        installationId,
        externalUserId: "U012ABCDEF",
        action: "approval.decide",
        payloadHash: digest("approval:approve"),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      context,
      ["approval:write"],
      expect.objectContaining({
        operation: "approval.vote",
        payload: expect.objectContaining({ approvalId: "approval-12345678", vote: "approve" }),
      }),
    );
  });
});
