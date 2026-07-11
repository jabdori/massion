import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { IntegrationStore } from "./store.js";
import type { IntegrationTokenService } from "./tokens.js";

interface ApplicationPort {
  dispatch(context: TenantContext, scopes: readonly string[], input: unknown): Promise<unknown>;
  query(context: TenantContext, scopes: readonly string[], operation: string, payload: unknown): Promise<unknown>;
  currentOrganizationVersionId(context: TenantContext): Promise<string>;
  observeExternalEvent?(context: TenantContext, input: unknown): Promise<unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 65_536): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export class IntegrationDeliveryDispatcher {
  public constructor(
    private readonly dependencies: {
      readonly store: IntegrationStore;
      readonly tokens: IntegrationTokenService;
      readonly application: ApplicationPort;
    },
  ) {}

  public async runOnce(context: TenantContext, workerId: string, now = new Date()): Promise<boolean> {
    const delivery = await this.dependencies.store.claimDelivery(context, { workerId, now, leaseMs: 30_000 });
    if (!delivery) return false;
    try {
      const result = await this.execute(context, delivery);
      await this.dependencies.store.completeDelivery(context, {
        deliveryRecordId: delivery.deliveryRecordId,
        workerId,
        leaseGeneration: delivery.leaseGeneration,
        outcome: "succeeded",
        resultHash: sha256(canonical(result)),
      });
    } catch (error) {
      await this.dependencies.store.completeDelivery(context, {
        deliveryRecordId: delivery.deliveryRecordId,
        workerId,
        leaseGeneration: delivery.leaseGeneration,
        outcome: "failed",
        resultHash: sha256(error instanceof Error ? error.message : String(error)),
      });
    }
    return true;
  }

  private async execute(
    context: TenantContext,
    delivery: Awaited<ReturnType<IntegrationStore["claimDelivery"]>> & object,
  ): Promise<unknown> {
    const action = object(delivery.payload, "Integration normalized action");
    if (action.kind === "ignored") return action;
    if (action.kind === "application-event") {
      if (!this.dependencies.application.observeExternalEvent)
        return { observed: false, reason: "observer-unavailable" };
      return await this.dependencies.application.observeExternalEvent(context, action);
    }
    if (action.kind !== "application-command") throw new Error("Integration action kind를 지원하지 않습니다");
    const operation = text(action.operation, "Integration operation", 128);
    const arguments_ = object(action.arguments, "Integration arguments");
    const installation = await this.dependencies.store.getInstallation(context, delivery.installationId);
    const commandId = `integration:${delivery.deliveryRecordId}`;
    const correlationId = `delivery:${delivery.deliveryRecordId}`;
    let result: unknown;
    if (operation === "work.create") {
      result = await this.command(context, ["work:write"], commandId, correlationId, "work.create", {
        text: text(arguments_.request, "Work request"),
        surface: `integration:${installation.platform}`,
        organizationVersionId: await this.dependencies.application.currentOrganizationVersionId(context),
      });
    } else if (operation === "work.status") {
      result = await this.dependencies.application.query(context, ["work:read"], "work.get", {
        workId: text(arguments_.workId, "Work ID", 128),
      });
    } else if (operation === "collaboration.post") {
      const workId = text(arguments_.workId, "Work ID", 128);
      const roomsResult = object(
        await this.dependencies.application.query(context, ["collaboration:read"], "work.rooms", { workId }),
        "Work rooms result",
      );
      const rooms = Array.isArray(roomsResult.data) ? roomsResult.data : [];
      const room = object(rooms[0], "Work primary room");
      result = await this.command(
        context,
        ["collaboration:write"],
        commandId,
        correlationId,
        "collaboration.message.post",
        {
          workId,
          roomId: text(room.roomId, "Room ID", 128),
          messageType: "question",
          authorKind: "user",
          authorId: context.userId,
          content: text(arguments_.message, "Collaboration message"),
        },
      );
    } else if (operation === "runtime.stop") {
      result = await this.command(context, ["work:write"], commandId, correlationId, "run.cancel", {
        runId: text(arguments_.runId, "Run ID", 128),
      });
    } else if (operation === "approval.decide") {
      const decision = text(arguments_.decision, "Approval decision", 16);
      if (decision !== "approve" && decision !== "reject") throw new Error("Approval decision이 유효하지 않습니다");
      const payloadHash = sha256(`approval:${decision}`);
      const consumed = await this.dependencies.tokens.consumeInteraction(context, {
        installationId: delivery.installationId,
        externalUserId: text(action.actorExternalId, "External actor ID", 128),
        handle: text(arguments_.handle, "Interaction handle", 128),
        action: "approval.decide",
        payloadHash,
      });
      result = await this.command(context, ["approval:write"], commandId, correlationId, "approval.vote", {
        approvalId: consumed.resourceId,
        vote: decision,
        reason: `${installation.platform}에서 확인된 사용자가 결정했습니다`,
      });
    } else throw new Error("지원하지 않는 Integration Application operation입니다");

    if (typeof action.destination === "string") {
      await this.dependencies.store.enqueue(context, {
        commandId: `${commandId}:response`,
        installationId: delivery.installationId,
        destination: action.destination,
        operation: "surface.response",
        idempotencyKey: `${delivery.deliveryRecordId}:response`,
        payload: { result },
      });
    }
    return result;
  }

  private async command(
    context: TenantContext,
    scopes: readonly string[],
    commandId: string,
    correlationId: string,
    operation: string,
    payload: unknown,
  ): Promise<unknown> {
    return await this.dependencies.application.dispatch(context, scopes, {
      schemaVersion: "massion.application.v1",
      commandId,
      correlationId,
      operation,
      payload,
    });
  }
}
