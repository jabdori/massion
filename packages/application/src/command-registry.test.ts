import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";

class MutableRegistryClock {
  public constructor(public now: Date) {}
}

describe("ApplicationCommandRegistry", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let registry: ApplicationCommandRegistry;
  let store: ApplicationCommandStore;
  let clock: MutableRegistryClock;
  let calls: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "registry@example.com", displayName: "Registry" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    clock = new MutableRegistryClock(new Date("2026-07-11T02:00:00.000Z"));
    store = await ApplicationCommandStore.create(database, organizations, { clock, leaseMs: 30_000 });
    registry = new ApplicationCommandRegistry(store);
    calls = 0;
    registry.register({
      operation: "work.create",
      requiredScopes: ["work:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate(payload) {
        if (!payload || typeof payload !== "object" || (payload as { text?: unknown }).text !== "valid") {
          throw new Error("work.create payload가 유효하지 않습니다");
        }
        return payload as { readonly text: string };
      },
      async handle(_context, command, payload) {
        calls += 1;
        return {
          schemaVersion: "massion.application.v1",
          commandId: command.commandId,
          correlationId: command.correlationId,
          operation: command.operation,
          outcome: "succeeded",
          data: { accepted: payload.text },
        };
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it("operation 중복과 descriptor 불완전을 거부한다", () => {
    expect(() =>
      registry.register({
        operation: "work.create",
        requiredScopes: ["work:write"],
        allowedRoles: ["owner"],
        recovery: "replay-domain",
        validate: (payload) => payload,
        handle: async () => {
          throw new Error("호출되지 않아야 합니다");
        },
      }),
    ).toThrow("중복");
    expect(() =>
      registry.register({
        operation: "invalid",
        requiredScopes: [],
        allowedRoles: [],
        recovery: "replay-domain",
        validate: (payload) => payload,
        handle: async () => {
          throw new Error("호출되지 않아야 합니다");
        },
      }),
    ).toThrow();
  });

  it("scope·role·payload를 확인하고 같은 command 결과를 handler 재호출 없이 replay한다", async () => {
    const input = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "registry-dispatch-command-0001",
      correlationId: "registry-dispatch-correlation-0001",
      operation: "work.create",
      payload: { text: "valid" },
    };
    await expect(registry.dispatch(context, ["work:read"], input)).rejects.toThrow("scope");
    await expect(registry.dispatch(context, ["work:write"], { ...input, payload: { text: "bad" } })).rejects.toThrow(
      "payload",
    );
    await expect(registry.dispatch(context, ["work:write"], input)).resolves.toMatchObject({
      outcome: "succeeded",
      data: { accepted: "valid" },
    });
    await expect(registry.dispatch(context, ["work:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(calls).toBe(1);
  });

  it("등록되지 않은 operation과 in-progress 명령을 구조화 conflict로 거부한다", async () => {
    await expect(
      registry.dispatch(context, ["application:*"], {
        schemaVersion: "massion.application.v1",
        commandId: "registry-unknown-command-0001",
        correlationId: "registry-unknown-correlation-0001",
        operation: "unknown.execute",
        payload: {},
      }),
    ).rejects.toMatchObject({ category: "validation" });

    let release: (() => void) | undefined;
    registry.register({
      operation: "work.slow",
      requiredScopes: ["work:write"],
      allowedRoles: ["owner"],
      recovery: "replay-domain",
      validate: (payload) => payload,
      async handle(_context, command) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          schemaVersion: "massion.application.v1",
          commandId: command.commandId,
          correlationId: command.correlationId,
          operation: command.operation,
          outcome: "succeeded",
        };
      },
    });
    const slow = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "registry-concurrent-command-0001",
      correlationId: "registry-concurrent-correlation-0001",
      operation: "work.slow",
      payload: {},
    };
    const running = registry.dispatch(context, ["work:write"], slow);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(registry.dispatch(context, ["work:write"], slow)).rejects.toMatchObject({ category: "conflict" });
    release?.();
    await running;
  });

  it("외부 side effect command가 lease 만료 후 회수되면 자동 재실행하지 않고 blocked로 둔다", async () => {
    let called = false;
    registry.register({
      operation: "external.publish",
      requiredScopes: ["work:write"],
      allowedRoles: ["owner"],
      recovery: "operator-action",
      validate: (payload) => payload,
      async handle(_context, command) {
        called = true;
        return {
          schemaVersion: "massion.application.v1",
          commandId: command.commandId,
          correlationId: command.correlationId,
          operation: command.operation,
          outcome: "succeeded",
        };
      },
    });
    const input = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "registry-external-command-0001",
      correlationId: "registry-external-correlation-0001",
      operation: "external.publish",
      payload: { target: "outside" },
    };
    await store.begin(context, input);
    clock.now = new Date("2026-07-11T02:00:31.000Z");

    await expect(registry.dispatch(context, ["work:write"], input)).resolves.toMatchObject({
      outcome: "blocked",
      data: { operatorActionRequired: true },
    });
    expect(called).toBe(false);
  });

  it("승인 ID를 멱등 payload에서 제외하고 awaiting-approval 명령만 같은 command로 재개한다", async () => {
    registry.register({
      operation: "extension.reviewed-install",
      requiredScopes: ["work:write"],
      allowedRoles: ["owner"],
      recovery: "replay-domain",
      validate(payload) {
        return payload as { readonly artifactDigest: string; readonly approvalId?: string };
      },
      idempotencyPayload: (payload) => ({ artifactDigest: payload.artifactDigest }),
      resumeAwaitingApproval: (payload) => payload.approvalId !== undefined,
      async handle(_context, command, payload) {
        return {
          schemaVersion: "massion.application.v1",
          commandId: command.commandId,
          correlationId: command.correlationId,
          operation: command.operation,
          outcome: payload.approvalId ? "succeeded" : "awaiting-approval",
          data: payload.approvalId ? { installed: true } : { approvalId: "approval-required-0001" },
        };
      },
    });
    const initial = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "registry-approval-command-0001",
      correlationId: "registry-approval-correlation-0001",
      operation: "extension.reviewed-install",
      payload: { artifactDigest: "a".repeat(64) },
    };
    await expect(registry.dispatch(context, ["work:write"], initial)).resolves.toMatchObject({
      outcome: "awaiting-approval",
    });
    await expect(
      registry.dispatch(context, ["work:write"], {
        ...initial,
        payload: { ...initial.payload, approvalId: "approval-required-0001" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { installed: true } });
  });
});
