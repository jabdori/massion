import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import type { ApplicationCommandDescriptor } from "./command-registry.js";
import { registerWorkDirectiveCommands } from "./work-directive-commands.js";

const context: TenantContext = {
  userId: "directive-user",
  organizationId: "directive-org",
  membershipId: "directive-member",
  role: "owner",
};

const directive = {
  directiveId: "directive-command-result-0001",
  organizationId: context.organizationId,
  commandId: "directive-command-submit-0001",
  correlationId: "directive-command-correlation-0001",
  workId: "directive-work-0001",
  runId: "directive-run-0001",
  sequence: 1,
  content: "검증 기준을 하나 추가해주세요",
  mode: "now" as const,
  submittedStage: "delivery" as const,
  status: "queued" as const,
  leaseGeneration: 0,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

describe("Work directive commands", () => {
  it("work.directive.submit을 등록하고 ready run만 schedule한다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    const submitted: unknown[] = [];
    const scheduled: string[] = [];
    registerWorkDirectiveCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => descriptors.set(descriptor.operation, descriptor),
      } as never,
      {
        directives: {
          submit: async (_context, input) => {
            submitted.push(input);
            return directive;
          },
        },
        runs: {
          get: async () => ({ ...directive, stage: "delivery", status: "ready", request: {} }) as never,
        },
        schedule: async (_context, runId) => {
          scheduled.push(runId);
        },
      },
    );
    const descriptor = descriptors.get("work.directive.submit");
    if (!descriptor) throw new Error("work.directive.submit descriptor가 없습니다");
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "directive-command-submit-0001",
      correlationId: "directive-command-correlation-0001",
      operation: "work.directive.submit",
      expectedRevision: 3,
      payload: {},
    };
    const payload = descriptor.validate({
      workId: directive.workId,
      runId: directive.runId,
      content: directive.content,
      mode: "now",
    });

    await expect(descriptor.handle(context, command, payload)).resolves.toMatchObject({
      outcome: "accepted",
      resource: { type: "WorkDirective", id: directive.directiveId, revision: 0 },
      data: { status: "queued", runId: directive.runId, workId: directive.workId },
    });
    expect(submitted).toEqual([
      {
        commandId: command.commandId,
        correlationId: command.correlationId,
        expectedRevision: 3,
        workId: directive.workId,
        runId: directive.runId,
        content: directive.content,
        mode: "now",
      },
    ]);
    expect(scheduled).toEqual([directive.runId]);
  });

  it("승인 대기·차단 run을 자동 재개하지 않고 엄격한 payload와 expectedRevision을 강제한다", async () => {
    const descriptors = new Map<string, ApplicationCommandDescriptor>();
    let status: "awaiting-approval" | "blocked" = "awaiting-approval";
    const scheduled: string[] = [];
    registerWorkDirectiveCommands(
      {
        register: (descriptor: ApplicationCommandDescriptor) => descriptors.set(descriptor.operation, descriptor),
      } as never,
      {
        directives: { submit: async () => directive },
        runs: { get: async () => ({ ...directive, stage: "delivery", status, request: {} }) as never },
        schedule: async (_context, runId) => {
          scheduled.push(runId);
        },
      },
    );
    const descriptor = descriptors.get("work.directive.submit");
    if (!descriptor) throw new Error("work.directive.submit descriptor가 없습니다");
    expect(() => descriptor.validate({ ...directive, unknown: true })).toThrow("알 수 없는 필드");
    expect(() =>
      descriptor.validate({ workId: directive.workId, runId: directive.runId, content: " ", mode: "now" }),
    ).toThrow("content");
    expect(() =>
      descriptor.validate({
        workId: directive.workId,
        runId: directive.runId,
        content: directive.content,
        mode: "later",
      }),
    ).toThrow("mode");
    const payload = descriptor.validate({
      workId: directive.workId,
      runId: directive.runId,
      content: directive.content,
      mode: "now",
    });
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "directive-command-submit-0002",
      correlationId: "directive-command-correlation-0002",
      operation: "work.directive.submit",
      payload: {},
    };
    await expect(descriptor.handle(context, command, payload)).rejects.toThrow("expectedRevision");
    await descriptor.handle(context, { ...command, expectedRevision: 3 }, payload);
    status = "blocked";
    await descriptor.handle(
      context,
      { ...command, commandId: "directive-command-submit-0003", expectedRevision: 3 },
      payload,
    );
    expect(scheduled).toEqual([]);
  });
});
