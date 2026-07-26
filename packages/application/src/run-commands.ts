import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import type { TenantContext } from "@massion/identity";
import type { WorkspaceService } from "@massion/workspace";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandV1, ApplicationCommandResultV1 } from "./contracts.js";
import type { CoreWorkCoordinator } from "./core-work-coordinator.js";
import { ApplicationError } from "./errors.js";
import type { ApplicationRunStore } from "./run-store.js";

interface RunCommandDependencies {
  readonly store: Pick<ApplicationRunStore, "start">;
  readonly coordinator: Pick<CoreWorkCoordinator, "cancel" | "retryBlocked">;
  readonly schedule: (context: TenantContext, runId: string) => void | Promise<void>;
  readonly workspaces?: Pick<WorkspaceService, "get">;
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

function workspacePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error("workspace file 경로가 유효하지 않습니다");
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../"))
    throw new Error("workspace file 경로가 유효하지 않습니다");
  return normalized;
}

function runRequest(value: unknown): Record<string, unknown> {
  const input = object(value, [
    "text",
    "surface",
    "projectId",
    "workspaceId",
    "workspacePaths",
    "tokenBudget",
    "softwareDelivery",
    "scopeIn",
    "scopeOut",
    "constraints",
    "assumptions",
    "unknowns",
    "decisions",
  ]);
  if (typeof input.text !== "string" || input.text.trim().length === 0)
    throw new Error("run request text가 유효하지 않습니다");
  if (input.workspacePaths === undefined) return input;
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0)
    throw new Error("workspace file 경로에는 workspaceId가 필요합니다");
  if (!Array.isArray(input.workspacePaths)) throw new Error("workspace file 경로가 유효하지 않습니다");
  const workspacePaths = [...new Set(input.workspacePaths.map(workspacePath))];
  if (workspacePaths.length > 20) throw new Error("workspace file 경로는 최대 20개까지 허용됩니다");
  return {
    ...input,
    workspaceId: input.workspaceId.trim(),
    workspacePaths,
  };
}

async function verifyWorkspacePaths(
  context: TenantContext,
  request: Record<string, unknown>,
  workspaces: RunCommandDependencies["workspaces"],
  correlationId: string,
): Promise<void> {
  const paths = request.workspacePaths;
  if (typeof request.workspaceId !== "string") return;
  if (!workspaces) throw new Error("workspace file 경로를 확인할 WorkspaceService가 구성되지 않았습니다");
  const workspace = await workspaces.get(context, request.workspaceId);
  if (workspace.status !== "active") throw new Error("workspace는 active 상태여야 합니다");
  if ((await lstat(workspace.path)).isSymbolicLink())
    throw new Error("workspace 경로는 canonical directory여야 합니다");
  const root = await realpath(workspace.path);
  if (root !== workspace.path) throw new Error("workspace 경로는 canonical directory여야 합니다");
  if (!(await stat(root)).isDirectory()) throw new Error("workspace 경로는 directory여야 합니다");
  if (!Array.isArray(paths) || paths.length === 0) return;
  for (const path of paths) {
    const selected = await realpath(resolve(root, path as string));
    const fromRoot = relative(root, selected);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
      throw new Error("workspace 밖 파일은 첨부할 수 없습니다");
    if (!(await stat(selected)).isFile())
      throw new ApplicationError({
        category: "validation",
        severity: "error",
        retryable: false,
        userMessage: "첨부 경로는 workspace 안의 기존 파일이어야 합니다",
        operatorCode: "APP_WORKSPACE_PATH_VALIDATION",
        correlationId,
      });
  }
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
      return { request: runRequest(payload.request) };
    },
    async handle(context, command, payload) {
      await verifyWorkspacePaths(context, payload.request, dependencies.workspaces, command.correlationId);
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
      const payload = object(value, ["runId", "retryBlocked"]);
      if (payload.retryBlocked !== true) {
        throw new Error("run.resume은 차단된 실행 재시도 전용이며 retryBlocked는 true여야 합니다");
      }
      return {
        runId: text(payload.runId, "runId"),
        retryBlocked: true as const,
      };
    },
    async handle(context, command, payload) {
      const run = await dependencies.coordinator.retryBlocked(context, payload.runId, command.commandId);
      return result(command, {
        outcome: run.status === "completed" ? "succeeded" : "accepted",
        resource: { type: "ApplicationRun", id: run.runId, revision: run.leaseGeneration },
        data: { runId: run.runId, status: run.status, stage: run.stage },
      });
    },
  });
}
