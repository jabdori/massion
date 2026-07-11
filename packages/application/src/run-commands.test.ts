import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandDescriptor } from "./command-registry.js";
import { registerApplicationRunCommands } from "./run-commands.js";

const context: TenantContext = {
  userId: "run-user",
  organizationId: "run-org",
  membershipId: "run-member",
  role: "owner",
};

describe("Application run commands", () => {
  it("run.start를 accepted로 기록하고 schedule하며 cancel을 coordinator로 보낸다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    const scheduled: string[] = [];
    const cancelled: string[] = [];
    const view = (status: "ready" | "cancelled" | "completed") => ({
      runId: "run-command-1",
      organizationId: context.organizationId,
      commandId: "run-start-command-0001",
      correlationId: "run-start-correlation-0001",
      request: {},
      stage: status === "ready" ? ("intake" as const) : ("terminal" as const),
      status,
      leaseGeneration: 0,
    });
    registerApplicationRunCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => {
          descriptors.set(descriptor.operation, descriptor);
        },
      } as never,
      {
        store: { start: async () => view("ready") },
        coordinator: {
          cancel: async (_context, runId) => {
            cancelled.push(runId);
            return view("cancelled");
          },
          resume: async () => view("completed"),
          retryBlocked: async () => view("completed"),
        },
        schedule: async (_context, runId) => {
          scheduled.push(runId);
        },
      },
    );
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "run-start-command-0001",
      correlationId: "run-start-correlation-0001",
      operation: "run.start",
      payload: {},
    };
    const start = descriptors.get("run.start");
    if (!start) throw new Error("run.start descriptor가 없습니다");
    const payload = start.validate({ request: { text: "제품화" } });
    await expect(start.handle(context, command, payload)).resolves.toMatchObject({
      outcome: "accepted",
      resource: { id: "run-command-1" },
    });
    expect(scheduled).toEqual(["run-command-1"]);
    const cancel = descriptors.get("run.cancel");
    if (!cancel) throw new Error("run.cancel descriptor가 없습니다");
    await cancel.handle(context, { ...command, operation: "run.cancel" }, cancel.validate({ runId: "run-command-1" }));
    expect(cancelled).toEqual(["run-command-1"]);
  });
});
