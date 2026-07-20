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

  it("차단된 run 재시도는 외부 command ID를 재시도 시도 ID로 전달한다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    const retryCalls: Array<{ runId: string; retryAttemptId: string }> = [];
    const completed = {
      runId: "run-command-retry-1",
      organizationId: context.organizationId,
      commandId: "run-start-command-0002",
      correlationId: "run-start-correlation-0002",
      request: {},
      stage: "terminal" as const,
      status: "completed" as const,
      leaseGeneration: 2,
    };
    registerApplicationRunCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => {
          descriptors.set(descriptor.operation, descriptor);
        },
      } as never,
      {
        store: { start: async () => completed },
        coordinator: {
          cancel: async () => completed,
          resume: async () => completed,
          retryBlocked: async (_context, runId, retryAttemptId) => {
            retryCalls.push({ runId, retryAttemptId });
            return completed;
          },
        },
        schedule: async () => undefined,
      },
    );
    const resume = descriptors.get("run.resume");
    if (!resume) throw new Error("run.resume descriptor가 없습니다");
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "run-resume-retry-command-0001",
      correlationId: "run-resume-retry-correlation-0001",
      operation: "run.resume",
      payload: {},
    };
    const payload = resume.validate({ runId: "run-command-retry-1", retryBlocked: true });

    await expect(resume.handle(context, command, payload)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(retryCalls).toEqual([{ runId: "run-command-retry-1", retryAttemptId: "run-resume-retry-command-0001" }]);
  });
});
