import type { OrganizationService } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "./contracts.js";
import { ApplicationError } from "./errors.js";
import type { WebSessionService } from "./web-session.js";

interface AccessCommandDependencies {
  readonly organizations: Pick<OrganizationService, "updateMembershipRole" | "suspendMembership">;
  readonly webSessions: Pick<WebSessionService, "revokeById">;
}

function payload(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Access command payload가 유효하지 않습니다");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Access command payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = required.find((key) => record[key] === undefined);
  if (missing) throw new Error(`Access command payload 필드가 필요합니다: ${missing}`);
  return record;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value.trim();
}

function revision(command: ApplicationCommandV1): number {
  if (command.expectedRevision === undefined) throw new Error("expectedRevision이 필요합니다");
  return command.expectedRevision;
}

function result(
  command: ApplicationCommandV1,
  resource: { readonly type: string; readonly id: string; readonly revision: number },
  data: unknown,
): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: "succeeded",
    resource,
    data,
  };
}

function accessError(error: unknown, correlationId: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/revision/iu.test(message)) {
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: false,
      userMessage: "다른 변경이 먼저 반영되어 화면을 새로 읽어야 합니다",
      operatorCode: "APP_ACCESS_REVISION_CONFLICT",
      correlationId,
      cause: error,
    });
  }
  if (/권한|owner|admin|Membership/iu.test(message)) {
    throw new ApplicationError({
      category: "authorization",
      severity: "error",
      retryable: false,
      userMessage: "현재 조직 역할에 이 변경 권한이 없습니다",
      operatorCode: "APP_ACCESS_ROLE_REQUIRED",
      correlationId,
      cause: error,
    });
  }
  if (/찾을 수 없/iu.test(message)) {
    throw new ApplicationError({
      category: "not-found",
      severity: "error",
      retryable: false,
      userMessage: "변경할 대상을 찾을 수 없습니다",
      operatorCode: "APP_ACCESS_NOT_FOUND",
      correlationId,
      cause: error,
    });
  }
  throw error;
}

export function registerApplicationAccessCommands(
  registry: ApplicationCommandRegistry,
  dependencies: AccessCommandDependencies,
): void {
  registry.register({
    operation: "identity.membership.role",
    requiredScopes: ["identity:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate(value) {
      const parsed = payload(value, ["membershipId", "role"], ["membershipId", "role"]);
      const role = text(parsed.role, "role");
      if (role !== "admin" && role !== "member") throw new Error("role이 유효하지 않습니다");
      return { membershipId: text(parsed.membershipId, "membershipId", 128), role } as const;
    },
    async handle(context, command, value) {
      try {
        const updated = await dependencies.organizations.updateMembershipRole(
          context,
          value.membershipId,
          value.role,
          revision(command),
        );
        return result(
          command,
          { type: "Membership", id: updated.membership_id, revision: updated.revision },
          {
            membershipId: updated.membership_id,
            role: updated.role,
            status: updated.status,
            revision: updated.revision,
          },
        );
      } catch (error) {
        return accessError(error, command.correlationId);
      }
    },
  });
  registry.register({
    operation: "identity.membership.suspend",
    requiredScopes: ["identity:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => {
      const parsed = payload(value, ["membershipId"], ["membershipId"]);
      return { membershipId: text(parsed.membershipId, "membershipId", 128) };
    },
    async handle(context, command, value) {
      try {
        const updated = await dependencies.organizations.suspendMembership(
          context,
          value.membershipId,
          revision(command),
        );
        return result(
          command,
          { type: "Membership", id: updated.membership_id, revision: updated.revision },
          {
            membershipId: updated.membership_id,
            role: updated.role,
            status: updated.status,
            revision: updated.revision,
          },
        );
      } catch (error) {
        return accessError(error, command.correlationId);
      }
    },
  });
  registry.register({
    operation: "application.session.revoke",
    requiredScopes: ["identity:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => {
      const parsed = payload(value, ["sessionId", "reason"], ["sessionId", "reason"]);
      return {
        sessionId: text(parsed.sessionId, "sessionId", 128),
        reason: text(parsed.reason, "reason"),
      };
    },
    async handle(context, command, value) {
      try {
        const revoked = await dependencies.webSessions.revokeById(
          context,
          value.sessionId,
          revision(command),
          value.reason,
        );
        return result(
          command,
          { type: "WebSession", id: revoked.sessionId, revision: revoked.revision },
          {
            sessionId: revoked.sessionId,
            status: revoked.status,
            revision: revoked.revision,
            revokedAt: revoked.revokedAt,
          },
        );
      } catch (error) {
        return accessError(error, command.correlationId);
      }
    },
  });
}
