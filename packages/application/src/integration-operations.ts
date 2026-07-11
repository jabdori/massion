import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandV1, ApplicationCommandResultV1 } from "./contracts.js";
import type { ApplicationQueryRegistry } from "./query-registry.js";

export interface ApplicationIntegrationOperations {
  connect(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly platform: "slack" | "discord" | "github";
      readonly externalTenantId: string;
      readonly credentialRef: string;
      readonly scopes: readonly string[];
    },
  ): Promise<{ readonly installationId: string; readonly revision: number }>;
  startOAuth(
    context: TenantContext,
    input: {
      readonly platform: "slack" | "github";
      readonly redirectUri: string;
      readonly scopes: readonly string[];
    },
  ): Promise<unknown>;
  bindUser(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly externalUserId: string;
      readonly userId: string;
    },
  ): Promise<{ readonly bindingId: string; readonly revision: number }>;
  bindChannel(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly externalResourceId: string;
      readonly resourceKind: "channel" | "repository";
      readonly events: readonly string[];
    },
  ): Promise<{ readonly channelBindingId: string; readonly revision: number }>;
  list(context: TenantContext): Promise<readonly unknown[]>;
  listDeliveries(context: TenantContext, limit: number): Promise<readonly unknown[]>;
}

function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Integration payload는 object여야 합니다");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Integration payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  if (required.some((key) => record[key] === undefined)) throw new Error("Integration payload 필수 필드가 없습니다");
  return record;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string"))
    throw new Error(`${label}이 유효하지 않습니다`);
  return value as string[];
}

function result(
  command: ApplicationCommandV1,
  input: { resourceType: string; resourceId: string; revision?: number; data?: unknown },
): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: "succeeded",
    resource: {
      type: input.resourceType,
      id: input.resourceId,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    },
    ...(input.data === undefined ? {} : { data: input.data }),
  };
}

export function registerApplicationIntegrationOperations(
  commands: ApplicationCommandRegistry,
  queries: ApplicationQueryRegistry,
  operations: ApplicationIntegrationOperations,
): void {
  commands.register({
    operation: "integration.connect",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate(value) {
      const source = object(
        value,
        ["platform", "externalTenantId", "credentialRef", "scopes"],
        ["platform", "externalTenantId", "credentialRef", "scopes"],
      );
      if (!new Set(["slack", "discord", "github"]).has(String(source.platform)))
        throw new Error("Integration platform이 유효하지 않습니다");
      return {
        platform: source.platform as "slack" | "discord" | "github",
        externalTenantId: text(source.externalTenantId, "externalTenantId"),
        credentialRef: text(source.credentialRef, "credentialRef"),
        scopes: strings(source.scopes, "scopes"),
      };
    },
    async handle(context, command, value) {
      const connected = await operations.connect(context, { commandId: command.commandId, ...value });
      return result(command, {
        resourceType: "IntegrationInstallation",
        resourceId: connected.installationId,
        revision: connected.revision,
      });
    },
  });
  commands.register({
    operation: "integration.oauth.start",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate(value) {
      const source = object(value, ["platform", "redirectUri", "scopes"], ["platform", "redirectUri"]);
      if (source.platform !== "slack" && source.platform !== "github")
        throw new Error("OAuth platform이 유효하지 않습니다");
      return {
        platform: source.platform as "slack" | "github",
        redirectUri: text(source.redirectUri, "redirectUri", 2_048),
        scopes: source.scopes === undefined ? [] : strings(source.scopes, "scopes"),
      };
    },
    async handle(context, command, value) {
      return result(command, {
        resourceType: "IntegrationOAuthAttempt",
        resourceId: command.commandId,
        data: await operations.startOAuth(context, value),
      });
    },
  });
  commands.register({
    operation: "integration.user.bind",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate(value) {
      const source = object(
        value,
        ["installationId", "externalUserId", "userId"],
        ["installationId", "externalUserId", "userId"],
      );
      return {
        installationId: text(source.installationId, "installationId"),
        externalUserId: text(source.externalUserId, "externalUserId"),
        userId: text(source.userId, "userId"),
      };
    },
    async handle(context, command, value) {
      const binding = await operations.bindUser(context, { commandId: command.commandId, ...value });
      return result(command, {
        resourceType: "IntegrationUserBinding",
        resourceId: binding.bindingId,
        revision: binding.revision,
      });
    },
  });
  commands.register({
    operation: "integration.channel.bind",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate(value) {
      const source = object(
        value,
        ["installationId", "externalResourceId", "resourceKind", "events"],
        ["installationId", "externalResourceId", "resourceKind", "events"],
      );
      if (source.resourceKind !== "channel" && source.resourceKind !== "repository")
        throw new Error("Integration resource kind가 유효하지 않습니다");
      return {
        installationId: text(source.installationId, "installationId"),
        externalResourceId: text(source.externalResourceId, "externalResourceId"),
        resourceKind: source.resourceKind as "channel" | "repository",
        events: strings(source.events, "events"),
      };
    },
    async handle(context, command, value) {
      const binding = await operations.bindChannel(context, { commandId: command.commandId, ...value });
      return result(command, {
        resourceType: "IntegrationChannelBinding",
        resourceId: binding.channelBindingId,
        revision: binding.revision,
      });
    },
  });
  queries.register({
    operation: "integration.list",
    requiredScopes: ["extension:read"],
    allowedRoles: ["owner", "admin", "member"],
    validate: (value) => object(value, [], []),
    handle: async (context) => await operations.list(context),
  });
  queries.register({
    operation: "integration.deliveries",
    requiredScopes: ["extension:read"],
    allowedRoles: ["owner", "admin", "member"],
    validate(value) {
      const source = object(value, ["limit"], []);
      const limit = source.limit === undefined ? 100 : Number(source.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Integration delivery limit이 유효하지 않습니다");
      return { limit };
    },
    handle: async (context, value) => await operations.listDeliveries(context, value.limit),
  });
}
