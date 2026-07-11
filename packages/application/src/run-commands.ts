import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandV1, ApplicationCommandResultV1 } from "./contracts.js";
import type { CoreWorkCoordinator } from "./core-work-coordinator.js";
import type { ApplicationRunStore } from "./run-store.js";

interface RunCommandDependencies {
  readonly store: Pick<ApplicationRunStore, "start">;
  readonly coordinator: Pick<CoreWorkCoordinator, "cancel" | "resume" | "retryBlocked">;
  readonly schedule: (context: TenantContext, runId: string) => void | Promise<void>;
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application run payload는 object여야 합니다");
  const result = value as Record<string, unknown>;
  const extra = Object.keys(result).find((key) => !fields.includes(key));
  if (extra) throw new Error(`Application run payload에 알 수 없는 필드가 있습니다: ${extra}`);
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function result(
  command: ApplicationCommandV1,
  input: Omit<ApplicationCommandResultV1, "schemaVersion" | "commandId" | "correlationId" | "operation">,
): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    ...input,
  };
}

export function registerApplicationRunCommands(
  registry: ApplicationCommandRegistry,
  dependencies: RunCommandDependencies,
): void {
  registry.register({
    operation: "run.start",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate(value) {
      const payload = object(value, ["request"]);
      if (payload.request === undefined) throw new Error("run request가 필요합니다");
      return payload as { request: unknown };
    },
    async handle(context, command, payload) {
      const run = await dependencies.store.start(context, {
        commandId: command.commandId,
        correlationId: command.correlationId,
        request: payload.request,
      });
      await dependencies.schedule(context, run.runId);
      return result(command, {
        outcome: "accepted",
        resource: { type: "ApplicationRun", id: run.runId, revision: run.leaseGeneration },
        data: { runId: run.runId, status: run.status, stage: run.stage },
      });
    },
  });
  registry.register({
    operation: "run.cancel",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate(value) {
      const payload = object(value, ["runId"]);
      return { runId: text(payload.runId, "runId") };
    },
    async handle(context, command, payload) {
      const run = await dependencies.coordinator.cancel(context, payload.runId);
      return result(command, {
        outcome: "succeeded",
        resource: { type: "ApplicationRun", id: run.runId, revision: run.leaseGeneration },
        data: { runId: run.runId, status: run.status },
      });
    },
  });
  registry.register({
    operation: "run.resume",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate(value) {
      const payload = object(value, ["runId", "resumeInput", "retryBlocked"]);
      return {
        runId: text(payload.runId, "runId"),
        resumeInput: payload.resumeInput,
        retryBlocked: payload.retryBlocked === true,
      };
    },
    async handle(context, command, payload) {
      const run = payload.retryBlocked
        ? await dependencies.coordinator.retryBlocked(context, payload.runId)
        : await dependencies.coordinator.resume(context, payload.runId, payload.resumeInput);
      return result(command, {
        outcome: run.status === "completed" ? "succeeded" : "accepted",
        resource: { type: "ApplicationRun", id: run.runId, revision: run.leaseGeneration },
        data: { runId: run.runId, status: run.status, stage: run.stage },
      });
    },
  });
}
