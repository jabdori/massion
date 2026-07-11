import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandV1, ApplicationCommandResultV1 } from "./contracts.js";
import type { ApplicationQueryRegistry } from "./query-registry.js";

export interface ApplicationRegistryOperations {
  search(
    context: TenantContext,
    input: { readonly query: string; readonly limit: number; readonly cursor?: string },
  ): Promise<unknown>;
  info(context: TenantContext, versionId: string): Promise<unknown>;
  inventory(context: TenantContext): Promise<unknown>;
  install(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly versionId: string;
      readonly environment: string;
      readonly riskClass: string;
      readonly executionId: string;
      readonly installApprovalId?: string;
      readonly permissionApprovalId?: string;
    },
  ): Promise<{ readonly installationId: string; readonly packageName: string; readonly packageVersion: string }>;
  recall(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly versionId: string;
      readonly category: "security" | "malware" | "publisher-compromise" | "policy" | "compatibility";
      readonly severity: "low" | "medium" | "high" | "critical";
      readonly reason: string;
    },
  ): Promise<{ readonly recallId: string; readonly versionId: string }>;
}

function object(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Registry payload는 object여야 합니다");
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Registry payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  if (required.some((key) => result[key] === undefined)) throw new Error("Registry payload 필수 필드가 없습니다");
  return result;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function result(command: ApplicationCommandV1, type: string, id: string, data: unknown): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: "succeeded",
    resource: { type, id },
    data,
  };
}

export function registerApplicationRegistryOperations(
  commands: ApplicationCommandRegistry,
  queries: ApplicationQueryRegistry,
  operations: ApplicationRegistryOperations,
): void {
  queries.register({
    operation: "registry.search",
    requiredScopes: ["extension:read"],
    allowedRoles: ["owner", "admin", "member"],
    validate(value) {
      const source = object(value, ["query", "limit", "cursor"]);
      const limit = source.limit === undefined ? 20 : Number(source.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Registry search limit가 유효하지 않습니다");
      return {
        query: source.query === undefined ? "" : text(source.query, "query", 256),
        limit,
        ...(source.cursor === undefined ? {} : { cursor: text(source.cursor, "cursor", 4096) }),
      };
    },
    handle: async (context, value) => await operations.search(context, value),
  });
  queries.register({
    operation: "registry.info",
    requiredScopes: ["extension:read"],
    allowedRoles: ["owner", "admin", "member"],
    validate(value) {
      const source = object(value, ["versionId"], ["versionId"]);
      return { versionId: text(source.versionId, "versionId") };
    },
    handle: async (context, value) => await operations.info(context, value.versionId),
  });
  queries.register({
    operation: "registry.inventory",
    requiredScopes: ["extension:read"],
    allowedRoles: ["owner", "admin", "member"],
    validate: (value) => object(value, []),
    handle: async (context) => await operations.inventory(context),
  });
  commands.register({
    operation: "registry.install",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate(value) {
      const source = object(
        value,
        ["versionId", "environment", "riskClass", "executionId", "installApprovalId", "permissionApprovalId"],
        ["versionId", "environment", "riskClass", "executionId"],
      );
      return {
        versionId: text(source.versionId, "versionId"),
        environment: text(source.environment, "environment", 64),
        riskClass: text(source.riskClass, "riskClass", 64),
        executionId: text(source.executionId, "executionId"),
        ...(source.installApprovalId === undefined
          ? {}
          : { installApprovalId: text(source.installApprovalId, "installApprovalId") }),
        ...(source.permissionApprovalId === undefined
          ? {}
          : { permissionApprovalId: text(source.permissionApprovalId, "permissionApprovalId") }),
      };
    },
    async handle(context, command, value) {
      const installed = await operations.install(context, { commandId: command.commandId, ...value });
      return result(command, "ExtensionInstallation", installed.installationId, installed);
    },
  });
  commands.register({
    operation: "registry.recall",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner"],
    recovery: "operator-action",
    validate(value) {
      const source = object(
        value,
        ["versionId", "category", "severity", "reason"],
        ["versionId", "category", "severity", "reason"],
      );
      if (!["security", "malware", "publisher-compromise", "policy", "compatibility"].includes(String(source.category)))
        throw new Error("recall category가 유효하지 않습니다");
      if (!["low", "medium", "high", "critical"].includes(String(source.severity)))
        throw new Error("recall severity가 유효하지 않습니다");
      return {
        versionId: text(source.versionId, "versionId"),
        category: source.category as "security" | "malware" | "publisher-compromise" | "policy" | "compatibility",
        severity: source.severity as "low" | "medium" | "high" | "critical",
        reason: text(source.reason, "reason", 2048),
      };
    },
    async handle(context, command, value) {
      const recalled = await operations.recall(context, { commandId: command.commandId, ...value });
      return result(command, "RegistryRecall", recalled.recallId, recalled);
    },
  });
}
