import type { ExtensionGateway } from "@massion/extension-host";
import type { AssuranceBindingStore } from "@massion/assurance";
import { GovernanceApprovalRequiredError, GovernanceDeniedError, type ApprovalStore } from "@massion/governance";
import type { GrowthGateway } from "@massion/growth";
import type { OrganizationGraphService } from "@massion/organization";
import type { ModelRouter, ProviderService } from "@massion/router";
import type { AgentRunner } from "@massion/runtime";
import type { WorkService } from "@massion/work";

import type { ApplicationCommandDescriptor, ApplicationCommandRegistry } from "../command-registry.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "../contracts.js";
import { ApplicationError } from "../errors.js";
import type {
  SubscriptionAccountCommands,
  SubscriptionConnectorCommands,
  SubscriptionPolicyStore,
  SubscriptionPolicyView,
} from "../subscription-operations.js";
import { SUBSCRIPTION_CREDENTIAL_POLICIES } from "../subscription-operations.js";

export interface ApplicationDomainDependencies {
  readonly works?: Pick<
    WorkService,
    | "createWork"
    | "createFollowUpWork"
    | "transition"
    | "forkWork"
    | "planMerge"
    | "applyMerge"
    | "openRoom"
    | "joinRoom"
    | "leaveRoom"
    | "postMessage"
    | "assignTask"
  >;
  readonly runtime?: Pick<AgentRunner, "execute" | "cancel" | "suspend" | "resume">;
  readonly approvals?: Pick<ApprovalStore, "vote" | "cancel">;
  readonly assuranceBindings?: Pick<AssuranceBindingStore, "propose" | "activate">;
  readonly organization?: Pick<OrganizationGraphService, "execute">;
  readonly extension?: Pick<ExtensionGateway, "validate" | "link" | "pack" | "install" | "update" | "rollback">;
  readonly growth?: Pick<GrowthGateway, "configure" | "adopt" | "revert">;
  readonly providers?: Pick<
    ProviderService,
    "registerProvider" | "registerEndpoint" | "addCredential" | "revokeCredential"
  >;
  readonly router?: Pick<ModelRouter, "registerModel" | "createRoute" | "addCandidate">;
  readonly subscriptionAccounts?: SubscriptionAccountCommands;
  readonly subscriptionConnectors?: SubscriptionConnectorCommands;
  readonly subscriptionPolicy?: SubscriptionPolicyStore;
}

type Payload = Readonly<Record<string, unknown>>;

function payload(value: unknown, allowed: readonly string[], required: readonly string[] = []): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application operation payload는 object여야 합니다");
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Application operation payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = required.find((key) => result[key] === undefined);
  if (missing) throw new Error(`Application operation payload 필드가 필요합니다: ${missing}`);
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024)
    throw new Error(`${label} 문자열이 유효하지 않습니다`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} 정수가 유효하지 않습니다`);
  return value as number;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 배열이 유효하지 않습니다`);
  return value.map((item) => string(item, label));
}

function subscriptionCredentialPolicy(value: unknown): SubscriptionPolicyView["credentialPolicy"] {
  const candidate = string(value, "credentialPolicy");
  if (!SUBSCRIPTION_CREDENTIAL_POLICIES.includes(candidate as never)) {
    throw new Error("지원하지 않는 구독 계정 선택 정책입니다");
  }
  return candidate as SubscriptionPolicyView["credentialPolicy"];
}

function expectedRevision(command: ApplicationCommandV1): number {
  if (command.expectedRevision === undefined) throw new Error("expectedRevision이 필요합니다");
  return command.expectedRevision;
}

function result(
  command: ApplicationCommandV1,
  input: {
    readonly outcome?: ApplicationCommandResultV1["outcome"];
    readonly resource?: { readonly type: string; readonly id: string; readonly revision?: number };
    readonly data?: unknown;
  },
): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: input.outcome ?? "succeeded",
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
}

function register<Parsed>(
  registry: ApplicationCommandRegistry,
  descriptor: ApplicationCommandDescriptor<Parsed>,
): void {
  registry.register({
    ...descriptor,
    async handle(context, command, value) {
      try {
        return await descriptor.handle(context, command, value);
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
}

function domainError(error: unknown, correlationId: string): never {
  if (error instanceof GovernanceDeniedError) {
    throw new ApplicationError({
      category: "policy",
      severity: "error",
      retryable: false,
      userMessage: "활성 Governance 정책이 요청을 거부했습니다",
      operatorCode: "APP_POLICY_DENIED",
      correlationId,
      cause: error,
    });
  }
  if (error instanceof ApplicationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/revision|generation|동시성|stale|같은 commandId/iu.test(message)) {
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: false,
      userMessage: "요청의 현재 version 조건이 일치하지 않습니다",
      operatorCode: "APP_DOMAIN_CONFLICT",
      correlationId,
      cause: error,
    });
  }
  if (/찾을 수 없/iu.test(message)) {
    throw new ApplicationError({
      category: "not-found",
      severity: "error",
      retryable: false,
      userMessage: "요청한 resource를 찾을 수 없습니다",
      operatorCode: "APP_DOMAIN_NOT_FOUND",
      correlationId,
      cause: error,
    });
  }
  if (/권한|Membership|owner|admin/iu.test(message)) {
    throw new ApplicationError({
      category: "authorization",
      severity: "error",
      retryable: false,
      userMessage: "현재 사용자 또는 조직 역할에 요청 권한이 없습니다",
      operatorCode: "APP_DOMAIN_AUTHORIZATION",
      correlationId,
      cause: error,
    });
  }
  if (/유효하지|필요합니다|허용되지|비어 있을 수 없|상한/iu.test(message)) {
    throw new ApplicationError({
      category: "validation",
      severity: "error",
      retryable: false,
      userMessage: "도메인 요청 값이 유효하지 않습니다",
      operatorCode: "APP_DOMAIN_VALIDATION",
      correlationId,
      cause: error,
    });
  }
  throw error;
}

function workData(work: { readonly work_id: string; readonly status: string; readonly revision: number }) {
  return { workId: work.work_id, status: work.status, revision: work.revision };
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new Error(`${label} 시각이 유효하지 않습니다`);
}

function subscriptionAccountData(account: {
  readonly account_id: string;
  readonly provider_id: string;
  readonly alias: string;
  readonly scope: string;
  readonly connector_id: string;
  readonly billing_kind: string;
  readonly status: string;
  readonly consent_version: number;
  readonly version: number;
  readonly cooldown_until?: unknown;
}) {
  return {
    accountId: account.account_id,
    providerId: account.provider_id,
    alias: account.alias,
    scope: account.scope,
    connectorId: account.connector_id,
    billingKind: account.billing_kind,
    status: account.status,
    consentVersion: account.consent_version,
    version: account.version,
    ...(account.cooldown_until === undefined
      ? {}
      : { cooldownUntil: timestamp(account.cooldown_until, "구독 계정 cooldown") }),
  };
}

function subscriptionConnectorData(connector: {
  readonly connector_id: string;
  readonly location: string;
  readonly execution_kind: string;
  readonly protocol: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly expires_at?: unknown;
}) {
  return {
    connectorId: connector.connector_id,
    location: connector.location,
    executionKind: connector.execution_kind,
    protocol: connector.protocol,
    version: connector.version,
    capabilities: connector.capabilities,
    status: connector.status,
    ...(connector.expires_at === undefined ? {} : { expiresAt: timestamp(connector.expires_at, "Connector 만료") }),
  };
}

function subscriptionPolicyData(policy: SubscriptionPolicyView) {
  return {
    providerId: policy.providerId,
    credentialPolicy: policy.credentialPolicy,
    version: policy.version,
    source: policy.source,
    ...(policy.updatedAt === undefined ? {} : { updatedAt: policy.updatedAt }),
  };
}

function extensionData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "installationId",
    "versionId",
    "packageName",
    "packageVersion",
    "artifactDigest",
    "permissionDigest",
    "activationGeneration",
    "state",
    "sourceDigest",
    "files",
    "trustLevel",
    "validatedAt",
  ];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function growthData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "configurationVersionId",
    "version",
    "reflectionEnabled",
    "adoptionMode",
    "status",
    "checksum",
    "beforeVersionId",
    "afterVersionId",
    "approvalId",
    "adoptionId",
    "revertOperationId",
    "suggestionId",
  ];
  const selected = Object.fromEntries(
    allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  if (source.adoption && typeof source.adoption === "object") {
    const adoption = source.adoption as Record<string, unknown>;
    selected.adoption = Object.fromEntries(
      ["adoption_id", "suggestion_id", "status", "mode", "revision"]
        .filter((key) => adoption[key] !== undefined)
        .map((key) => [key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()), adoption[key]]),
    );
  }
  return selected;
}

function registerWork(
  registry: ApplicationCommandRegistry,
  works: NonNullable<ApplicationDomainDependencies["works"]>,
): void {
  register(registry, {
    operation: "work.create",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "text",
          "surface",
          "organizationVersionId",
          "projectId",
          "contextVersionId",
          "policyVersionId",
          "promptVersionId",
        ],
        ["text", "surface", "organizationVersionId"],
      ),
    async handle(context, command, value) {
      try {
        const created = await works.createWork(context, {
          commandId: command.commandId,
          text: string(value.text, "text"),
          surface: string(value.surface, "surface"),
          organizationVersionId: string(value.organizationVersionId, "organizationVersionId"),
          ...(value.projectId === undefined ? {} : { projectId: string(value.projectId, "projectId") }),
          ...(value.contextVersionId === undefined
            ? {}
            : { contextVersionId: string(value.contextVersionId, "contextVersionId") }),
          ...(value.policyVersionId === undefined
            ? {}
            : { policyVersionId: string(value.policyVersionId, "policyVersionId") }),
          ...(value.promptVersionId === undefined
            ? {}
            : { promptVersionId: string(value.promptVersionId, "promptVersionId") }),
        });
        return result(command, {
          resource: { type: "Work", id: created.work.work_id, revision: created.work.revision },
          data: workData(created.work),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "work.cancel",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId"], ["workId"]),
    async handle(context, command, value) {
      try {
        const cancelled = await works.transition(context, {
          commandId: command.commandId,
          workId: string(value.workId, "workId"),
          expectedRevision: expectedRevision(command),
          target: "cancelled",
        });
        return result(command, {
          resource: { type: "Work", id: cancelled.work.work_id, revision: cancelled.work.revision },
          data: workData(cancelled.work),
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
  register(registry, {
    operation: "work.follow-up",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["parentWorkId", "text", "surface"], ["parentWorkId", "text", "surface"]),
    async handle(context, command, value) {
      const created = await works.createFollowUpWork(context, {
        commandId: command.commandId,
        parentWorkId: string(value.parentWorkId, "parentWorkId"),
        text: string(value.text, "text"),
        surface: string(value.surface, "surface"),
      });
      return result(command, {
        resource: { type: "Work", id: created.work.work_id, revision: created.work.revision },
        data: workData(created.work),
      });
    },
  });
  register(registry, {
    operation: "work.fork",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "objective"], ["workId", "objective"]),
    async handle(context, command, value) {
      const forked = await works.forkWork(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        objective: string(value.objective, "objective"),
      });
      return result(command, {
        resource: { type: "Work", id: forked.childWork.work_id, revision: forked.childWork.revision },
        data: { parentWorkId: forked.work.work_id, ...workData(forked.childWork) },
      });
    },
  });
  register(registry, {
    operation: "work.merge.plan",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "childWorkId"], ["workId", "childWorkId"]),
    async handle(context, command, value) {
      const planned = await works.planMerge(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        childWorkId: string(value.childWorkId, "childWorkId"),
      });
      return result(command, {
        resource: { type: "MergePlan", id: planned.mergePlan.merge_plan_id },
        data: { mergePlanId: planned.mergePlan.merge_plan_id, status: planned.mergePlan.status },
      });
    },
  });
  register(registry, {
    operation: "work.merge.apply",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "mergePlanId"], ["workId", "mergePlanId"]),
    async handle(context, command, value) {
      const applied = await works.applyMerge(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        mergePlanId: string(value.mergePlanId, "mergePlanId"),
      });
      return result(command, {
        resource: { type: "Work", id: applied.work.work_id, revision: applied.work.revision },
        data: { ...workData(applied.work), mergePlanId: applied.mergePlan.merge_plan_id },
      });
    },
  });
  register(registry, {
    operation: "task.assign",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["workId", "taskId", "agentHandle"], ["workId", "taskId", "agentHandle"]),
    async handle(context, command, value) {
      const assigned = await works.assignTask(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        taskId: string(value.taskId, "taskId"),
        agentHandle: string(value.agentHandle, "agentHandle"),
      });
      return result(command, {
        resource: { type: "Assignment", id: assigned.assignment.assignment_id, revision: assigned.assignment.revision },
        data: {
          assignmentId: assigned.assignment.assignment_id,
          taskId: assigned.assignment.task_id,
          agentHandle: assigned.assignment.agent_handle,
          status: assigned.assignment.status,
        },
      });
    },
  });
  register(registry, {
    operation: "collaboration.room.open",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "title", "coordinatorHandle", "participants", "limits"],
        ["workId", "title", "coordinatorHandle", "participants", "limits"],
      ),
    async handle(context, command, value) {
      const opened = await works.openRoom(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        expectedRevision: expectedRevision(command),
        title: string(value.title, "title"),
        coordinatorHandle: string(value.coordinatorHandle, "coordinatorHandle"),
        participants: value.participants as never,
        limits: value.limits as never,
      });
      return result(command, {
        resource: { type: "CollaborationRoom", id: opened.room.room_id, revision: opened.room.revision },
        data: { roomId: opened.room.room_id, status: opened.room.status },
      });
    },
  });
  register(registry, {
    operation: "collaboration.message.post",
    requiredScopes: ["collaboration:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "workId",
          "roomId",
          "messageType",
          "authorKind",
          "authorId",
          "content",
          "replyToMessageId",
          "causedByMessageId",
          "taskId",
          "contextVersionId",
          "executionId",
          "artifactVersionId",
          "tokenCount",
          "costMicros",
        ],
        ["workId", "roomId", "messageType", "authorKind", "authorId", "content"],
      ),
    async handle(context, command, value) {
      const posted = await works.postMessage(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        roomId: string(value.roomId, "roomId"),
        messageType: string(value.messageType, "messageType") as never,
        authorKind: string(value.authorKind, "authorKind") as never,
        authorId: string(value.authorId, "authorId"),
        content: string(value.content, "content"),
        ...(value.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: string(value.replyToMessageId, "replyToMessageId") }),
        ...(value.causedByMessageId === undefined
          ? {}
          : { causedByMessageId: string(value.causedByMessageId, "causedByMessageId") }),
        ...(value.taskId === undefined ? {} : { taskId: string(value.taskId, "taskId") }),
        ...(value.contextVersionId === undefined
          ? {}
          : { contextVersionId: string(value.contextVersionId, "contextVersionId") }),
        ...(value.executionId === undefined ? {} : { executionId: string(value.executionId, "executionId") }),
        ...(value.artifactVersionId === undefined
          ? {}
          : { artifactVersionId: string(value.artifactVersionId, "artifactVersionId") }),
        tokenCount: value.tokenCount === undefined ? 0 : integer(value.tokenCount, "tokenCount"),
        costMicros: value.costMicros === undefined ? 0 : integer(value.costMicros, "costMicros"),
      });
      return result(command, {
        resource: { type: "CollaborationMessage", id: posted.message.message_id, revision: posted.message.sequence },
        data: {
          messageId: posted.message.message_id,
          roomId: posted.message.room_id,
          sequence: posted.message.sequence,
        },
      });
    },
  });
  for (const operation of ["join", "leave"] as const) {
    register(registry, {
      operation: `collaboration.participant.${operation}`,
      requiredScopes: ["collaboration:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId", "role"],
          operation === "join"
            ? ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId", "role"]
            : ["workId", "roomId", "expectedRoomRevision", "kind", "subjectId"],
        ),
      async handle(context, command, value) {
        const common = {
          commandId: command.commandId,
          workId: string(value.workId, "workId"),
          expectedRevision: expectedRevision(command),
          roomId: string(value.roomId, "roomId"),
          expectedRoomRevision: integer(value.expectedRoomRevision, "expectedRoomRevision"),
          kind: string(value.kind, "kind") as "user" | "agent",
          subjectId: string(value.subjectId, "subjectId"),
        };
        const changed =
          operation === "join"
            ? await works.joinRoom(context, {
                ...common,
                role: string(value.role, "role") as "coordinator" | "participant" | "observer",
              })
            : await works.leaveRoom(context, common);
        return result(command, {
          resource: {
            type: "CollaborationRoom",
            id: changed.room.room_id,
            revision: changed.room.revision,
          },
          data: {
            roomId: changed.room.room_id,
            participantId: changed.participant.participant_id,
            subjectId: changed.participant.subject_id,
            status: changed.participant.status,
          },
        });
      },
    });
  }
}

function registerOrganization(
  registry: ApplicationCommandRegistry,
  organization: NonNullable<ApplicationDomainDependencies["organization"]>,
): void {
  register(registry, {
    operation: "organization.command",
    requiredScopes: ["organization:write"],
    allowedRoles: ["owner"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "kind",
          "handle",
          "name",
          "responsibility",
          "parentHandle",
          "scope",
          "workId",
          "role",
          "outputs",
          "sourceHandle",
          "newHandle",
          "childHandles",
          "referencePlan",
          "survivorHandle",
          "targetVersion",
          "profileId",
          "profileVersion",
          "nodes",
        ],
        ["kind"],
      ),
    async handle(context, command, value) {
      try {
        const changed = await organization.execute(context, {
          ...value,
          commandId: command.commandId,
          expectedVersion: expectedRevision(command),
        } as never);
        return result(command, {
          resource: { type: "Organization", id: context.organizationId, revision: changed.version.version },
          data: { version: changed.version.version, changedHandles: changed.impact.nodeHandles },
        });
      } catch (error) {
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerRuntime(
  registry: ApplicationCommandRegistry,
  runtime: NonNullable<ApplicationDomainDependencies["runtime"]>,
): void {
  register(registry, {
    operation: "runtime.execute",
    requiredScopes: ["runtime:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "taskId", "agentHandle", "modelRoute", "estimatedTokens", "estimatedCostMicros", "input"],
        ["workId", "agentHandle", "modelRoute", "input"],
      ),
    async handle(context, command, value) {
      const executed = await runtime.execute(context, {
        commandId: command.commandId,
        workId: string(value.workId, "workId"),
        ...(value.taskId === undefined ? {} : { taskId: string(value.taskId, "taskId") }),
        agentHandle: string(value.agentHandle, "agentHandle"),
        modelRoute: string(value.modelRoute, "modelRoute"),
        correlationId: command.correlationId,
        estimatedTokens: value.estimatedTokens === undefined ? 0 : integer(value.estimatedTokens, "estimatedTokens"),
        estimatedCostMicros:
          value.estimatedCostMicros === undefined ? 0 : integer(value.estimatedCostMicros, "estimatedCostMicros"),
        input: value.input,
      });
      return result(command, {
        resource: { type: "Execution", id: executed.executionId },
        data: {
          executionId: executed.executionId,
          status: executed.status,
          ...(executed.output === undefined ? {} : { output: executed.output }),
        },
      });
    },
  });
  for (const operation of ["cancel", "suspend", "resume"] as const) {
    register(registry, {
      operation: `runtime.${operation}`,
      requiredScopes: ["runtime:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["executionId", "reason", "input"], ["executionId"]),
      async handle(context, command, value) {
        const executionId = string(value.executionId, "executionId");
        if (operation === "cancel")
          await runtime.cancel(
            context,
            executionId,
            value.reason === undefined ? undefined : string(value.reason, "reason"),
          );
        else if (operation === "suspend")
          await runtime.suspend(
            context,
            executionId,
            value.reason === undefined ? undefined : string(value.reason, "reason"),
          );
        else await runtime.resume(context, executionId, value.input);
        return result(command, { resource: { type: "Execution", id: executionId }, data: { executionId, operation } });
      },
    });
  }
}

function registerApprovals(
  registry: ApplicationCommandRegistry,
  approvals: NonNullable<ApplicationDomainDependencies["approvals"]>,
): void {
  register(registry, {
    operation: "approval.vote",
    requiredScopes: ["approval:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["approvalId", "vote", "reason"], ["approvalId", "vote", "reason"]),
    async handle(context, command, value) {
      const voted = await approvals.vote(context, {
        commandId: command.commandId,
        approvalId: string(value.approvalId, "approvalId"),
        vote: string(value.vote, "vote") as "approve" | "reject",
        reason: string(value.reason, "reason"),
      });
      return result(command, {
        resource: { type: "Approval", id: voted.approval_id, revision: voted.revision },
        data: { approvalId: voted.approval_id, status: voted.status, revision: voted.revision },
      });
    },
  });
  register(registry, {
    operation: "approval.cancel",
    requiredScopes: ["approval:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["approvalId", "reason"], ["approvalId", "reason"]),
    async handle(context, command, value) {
      const cancelled = await approvals.cancel(context, {
        commandId: command.commandId,
        approvalId: string(value.approvalId, "approvalId"),
        reason: string(value.reason, "reason"),
      });
      return result(command, {
        resource: { type: "Approval", id: cancelled.approval_id, revision: cancelled.revision },
        data: { approvalId: cancelled.approval_id, status: cancelled.status, revision: cancelled.revision },
      });
    },
  });
}

function registerExtension(
  registry: ApplicationCommandRegistry,
  extension: NonNullable<ApplicationDomainDependencies["extension"]>,
): void {
  const mutation = (operation: "install" | "update") => {
    register(registry, {
      operation: `extension.${operation}`,
      requiredScopes: ["extension:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["archiveBase64", "environment", "riskClass", "executionId", "installApprovalId", "permissionApprovalId"],
          ["archiveBase64"],
        ),
      idempotencyPayload: (value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !["installApprovalId", "permissionApprovalId"].includes(key)),
        ),
      resumeAwaitingApproval: (value) =>
        value.installApprovalId !== undefined || value.permissionApprovalId !== undefined,
      async handle(context, command, value) {
        try {
          const encoded = string(value.archiveBase64, "archiveBase64");
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
            throw new Error("Extension archive base64가 유효하지 않습니다");
          }
          const archive = Buffer.from(encoded, "base64");
          if (archive.length === 0 || archive.length > 64 * 1024 * 1024)
            throw new Error("Extension archive byte 상한이 유효하지 않습니다");
          const activated = await extension[operation](context, {
            commandId: command.commandId,
            archive,
            ...(value.environment === undefined ? {} : { environment: string(value.environment, "environment") }),
            ...(value.riskClass === undefined ? {} : { riskClass: string(value.riskClass, "riskClass") }),
            ...(value.executionId === undefined ? {} : { executionId: string(value.executionId, "executionId") }),
            ...(value.installApprovalId === undefined
              ? {}
              : { installApprovalId: string(value.installApprovalId, "installApprovalId") }),
            ...(value.permissionApprovalId === undefined
              ? {}
              : { permissionApprovalId: string(value.permissionApprovalId, "permissionApprovalId") }),
          });
          const data = extensionData(activated);
          return result(command, {
            ...(typeof data.installationId === "string"
              ? {
                  resource: {
                    type: "Extension",
                    id: data.installationId,
                    ...(typeof data.activationGeneration === "number" ? { revision: data.activationGeneration } : {}),
                  },
                }
              : {}),
            data,
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError) {
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          }
          return domainError(error, command.correlationId);
        }
      },
    });
  };
  mutation("install");
  mutation("update");
  register(registry, {
    operation: "extension.validate",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["source"], ["source"]),
    async handle(_context, command, value) {
      return result(command, { data: extensionData(await extension.validate(string(value.source, "source"))) });
    },
  });
  register(registry, {
    operation: "extension.link",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["source", "environment"], ["source", "environment"]),
    async handle(_context, command, value) {
      const linked = await extension.link(string(value.source, "source"), {
        environment: string(value.environment, "environment"),
      });
      return result(command, { data: extensionData(linked) });
    },
  });
  register(registry, {
    operation: "extension.pack",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "operator-action",
    validate: (value) => payload(value, ["source", "destination"], ["source", "destination"]),
    async handle(_context, command, value) {
      const packed = await extension.pack(string(value.source, "source"), string(value.destination, "destination"));
      return result(command, { data: extensionData(packed) });
    },
  });
  register(registry, {
    operation: "extension.rollback",
    requiredScopes: ["extension:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "packageName",
          "targetVersionId",
          "environment",
          "riskClass",
          "executionId",
          "installApprovalId",
          "permissionApprovalId",
        ],
        ["packageName", "targetVersionId", "environment", "riskClass", "executionId"],
      ),
    idempotencyPayload: (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !["installApprovalId", "permissionApprovalId"].includes(key)),
      ),
    resumeAwaitingApproval: (value) =>
      value.installApprovalId !== undefined || value.permissionApprovalId !== undefined,
    async handle(context, command, value) {
      try {
        const activated = await extension.rollback(context, {
          commandId: command.commandId,
          packageName: string(value.packageName, "packageName"),
          targetVersionId: string(value.targetVersionId, "targetVersionId"),
          environment: string(value.environment, "environment"),
          riskClass: string(value.riskClass, "riskClass"),
          executionId: string(value.executionId, "executionId"),
          ...(value.installApprovalId === undefined
            ? {}
            : { installApprovalId: string(value.installApprovalId, "installApprovalId") }),
          ...(value.permissionApprovalId === undefined
            ? {}
            : { permissionApprovalId: string(value.permissionApprovalId, "permissionApprovalId") }),
        });
        return result(command, { data: extensionData(activated) });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError)
          return result(command, {
            outcome: "awaiting-approval",
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        return domainError(error, command.correlationId);
      }
    },
  });
}

function registerGrowth(
  registry: ApplicationCommandRegistry,
  growth: NonNullable<ApplicationDomainDependencies["growth"]>,
): void {
  const definitions = [
    ["growth.configure", "configure", ["subject", "reflectionEnabled", "adoptionMode", "expectedVersion"]],
    [
      "growth.adopt",
      "adopt",
      [
        "suggestionId",
        "suggestionRevision",
        "evaluationRunId",
        "expectedEvaluationInputHash",
        "expectedTargetChecksum",
        "approvalId",
      ],
    ],
    ["growth.revert", "revert", ["adoptionId", "suggestionRevision", "reason", "approvalId"]],
  ] as const;
  for (const [operation, method, fields] of definitions) {
    register(registry, {
      operation,
      requiredScopes: ["growth:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, fields),
      idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
      resumeAwaitingApproval: (value) => value.approvalId !== undefined,
      async handle(context, command, value) {
        try {
          const output = await growth[method](context, { commandId: command.commandId, ...value } as never);
          return result(command, { data: growthData(output) });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError)
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          return domainError(error, command.correlationId);
        }
      },
    });
  }
}

function registerRouter(registry: ApplicationCommandRegistry, dependencies: ApplicationDomainDependencies): void {
  if (dependencies.providers) {
    register(registry, {
      operation: "router.provider.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["providerId", "displayName", "adapterKind"], ["providerId", "displayName", "adapterKind"]),
      async handle(context, command, value) {
        const registered = await dependencies.providers?.registerProvider(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelProvider", id: registered.provider.provider_id },
          data: { providerId: registered.provider.provider_id },
        });
      },
    });
    register(registry, {
      operation: "router.endpoint.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["providerId", "name", "baseUrl", "local", "gatewayKind"],
          ["providerId", "name", "baseUrl", "local"],
        ),
      async handle(context, command, value) {
        const registered = await dependencies.providers?.registerEndpoint(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ProviderEndpoint", id: registered.endpoint.endpoint_id },
          data: {
            endpointId: registered.endpoint.endpoint_id,
            providerId: registered.endpoint.provider_id,
          },
        });
      },
    });
    register(registry, {
      operation: "router.credential.add",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "operator-action",
      validate: (value) =>
        payload(
          value,
          ["providerId", "endpointId", "label", "credentialType", "secret", "priority", "weight"],
          ["providerId", "endpointId", "label", "credentialType", "secret", "priority", "weight"],
        ),
      async handle(context, command, value) {
        const added = await dependencies.providers?.addCredential(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!added) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "Credential", id: added.credential.credential_id, revision: added.credential.version },
          data: {
            credentialId: added.credential.credential_id,
            label: added.credential.label,
            status: added.credential.status,
            version: added.credential.version,
          },
        });
      },
    });
    register(registry, {
      operation: "router.credential.disable",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["credentialId", "expectedVersion"], ["credentialId", "expectedVersion"]),
      async handle(context, command, value) {
        const revoked = await dependencies.providers?.revokeCredential(context, {
          commandId: command.commandId,
          credentialId: string(value.credentialId, "credentialId"),
          expectedVersion: integer(value.expectedVersion, "expectedVersion"),
        });
        if (!revoked) throw new Error("Provider service가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "Credential", id: revoked.credential.credential_id, revision: revoked.credential.version },
          data: {
            credentialId: revoked.credential.credential_id,
            status: revoked.credential.status,
            version: revoked.credential.version,
          },
        });
      },
    });
  }
  if (dependencies.router) {
    register(registry, {
      operation: "router.model.register",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "endpointId",
            "modelId",
            "routeKind",
            "contextWindow",
            "supportsTools",
            "supportsStructuredOutput",
            "supportsVision",
            "supportsStreaming",
            "equivalenceGroup",
            "evalScore",
            "inputCostMicrosPerMillion",
            "outputCostMicrosPerMillion",
            "verified",
          ],
          [
            "providerId",
            "endpointId",
            "modelId",
            "routeKind",
            "contextWindow",
            "supportsTools",
            "supportsStructuredOutput",
            "supportsVision",
            "supportsStreaming",
            "equivalenceGroup",
            "evalScore",
            "inputCostMicrosPerMillion",
            "outputCostMicrosPerMillion",
            "verified",
          ],
        ),
      async handle(context, command, value) {
        const registered = await dependencies.router?.registerModel(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!registered) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelProfile", id: registered.profile.model_profile_id },
          data: { modelProfileId: registered.profile.model_profile_id, modelId: registered.profile.model_id },
        });
      },
    });
    register(registry, {
      operation: "router.route.configure",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, [
          "name",
          "routeKind",
          "credentialPolicy",
          "dataPolicy",
          "equivalenceGroup",
          "minEvalScore",
          "requireTools",
          "requireStructuredOutput",
          "requireVision",
          "requireStreaming",
          "maxContextTokens",
          "requestBudgetMicros",
          "totalBudgetMicros",
        ]),
      async handle(context, command, value) {
        const configured = await dependencies.router?.createRoute(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!configured) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "ModelRoute", id: configured.route.route_id },
          data: { routeId: configured.route.route_id, name: configured.route.name, enabled: configured.route.enabled },
        });
      },
    });
    register(registry, {
      operation: "router.candidate.add",
      requiredScopes: ["router:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["routeId", "modelProfileId", "priority"], ["routeId", "modelProfileId", "priority"]),
      async handle(context, command, value) {
        const added = await dependencies.router?.addCandidate(context, {
          commandId: command.commandId,
          ...value,
        } as never);
        if (!added) throw new Error("Model Router가 구성되지 않았습니다");
        return result(command, {
          resource: { type: "RouteCandidate", id: added.candidate.candidate_id },
          data: { candidateId: added.candidate.candidate_id, routeId: added.candidate.route_id },
        });
      },
    });
  }
}

function registerAssuranceBindings(
  registry: ApplicationCommandRegistry,
  bindings: NonNullable<ApplicationDomainDependencies["assuranceBindings"]>,
): void {
  register(registry, {
    operation: "assurance.binding.propose",
    requiredScopes: ["assurance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["workId", "planVersionId", "profileId", "profileVersion", "authorHandle", "requiredCriteria", "bindings"],
        ["workId", "planVersionId", "profileId", "profileVersion", "authorHandle", "requiredCriteria", "bindings"],
      ),
    async handle(context, command, value) {
      const proposed = await bindings.propose(context, { commandId: command.commandId, ...value } as never);
      return result(command, {
        resource: { type: "AssuranceBindingVersion", id: proposed.bindingVersionId, revision: proposed.revision },
        data: {
          bindingVersionId: proposed.bindingVersionId,
          status: proposed.status,
          revision: proposed.revision,
        },
      });
    },
  });
  register(registry, {
    operation: "assurance.binding.activate",
    requiredScopes: ["assurance:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(value, ["bindingVersionId", "expectedRevision", "approvalId"], ["bindingVersionId", "expectedRevision"]),
    idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
    resumeAwaitingApproval: (value) => value.approvalId !== undefined,
    async handle(context, command, value) {
      try {
        const activated = await bindings.activate(context, {
          commandId: command.commandId,
          bindingVersionId: string(value.bindingVersionId, "bindingVersionId"),
          expectedRevision: integer(value.expectedRevision, "expectedRevision", 1),
          ...(value.approvalId === undefined ? {} : { approvalId: string(value.approvalId, "approvalId") }),
        });
        return result(command, {
          resource: {
            type: "AssuranceBindingVersion",
            id: activated.bindingVersionId,
            revision: activated.revision,
          },
          data: {
            bindingVersionId: activated.bindingVersionId,
            status: activated.status,
            revision: activated.revision,
          },
        });
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError)
          return result(command, {
            outcome: "awaiting-approval",
            data: { decisionId: error.decisionId, approvalId: error.approvalId },
          });
        throw error;
      }
    },
  });
}

function registerSubscriptions(
  registry: ApplicationCommandRegistry,
  dependencies: ApplicationDomainDependencies,
): void {
  const connectors = dependencies.subscriptionConnectors;
  if (connectors) {
    register(registry, {
      operation: "subscription.connector.enroll",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "operator-action",
      validate: (value) =>
        payload(
          value,
          [
            "enrollmentId",
            "enrollmentCode",
            "challengeNonce",
            "expiresAt",
            "connectorId",
            "publicKey",
            "protocol",
            "version",
            "capabilities",
            "signature",
          ],
          [
            "enrollmentId",
            "enrollmentCode",
            "challengeNonce",
            "expiresAt",
            "connectorId",
            "publicKey",
            "protocol",
            "version",
            "capabilities",
            "signature",
          ],
        ),
      async handle(_context, command, value) {
        const connector = await connectors.enroll({
          enrollmentId: string(value.enrollmentId, "enrollmentId"),
          enrollmentCode: string(value.enrollmentCode, "enrollmentCode"),
          challengeNonce: string(value.challengeNonce, "challengeNonce"),
          expiresAt: string(value.expiresAt, "expiresAt"),
          connectorId: string(value.connectorId, "connectorId"),
          publicKey: string(value.publicKey, "publicKey"),
          protocol: string(value.protocol, "protocol"),
          version: string(value.version, "version"),
          capabilities: strings(value.capabilities, "capabilities"),
          signature: string(value.signature, "signature"),
        });
        return result(command, {
          resource: { type: "SubscriptionConnector", id: connector.connector_id },
          data: subscriptionConnectorData(connector),
        });
      },
    });
  }

  const accounts = dependencies.subscriptionAccounts;
  if (accounts) {
    register(registry, {
      operation: "subscription.account.register",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["providerId", "alias", "connectorId", "profileLocator", "billingKind"],
          ["providerId", "alias", "connectorId", "profileLocator", "billingKind"],
        ),
      async handle(context, command, value) {
        const account = await accounts.register(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          connectorId: string(value.connectorId, "connectorId"),
          profileLocator: string(value.profileLocator, "profileLocator"),
          billingKind: string(value.billingKind, "billingKind"),
        });
        return result(command, {
          resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
          data: subscriptionAccountData(account),
        });
      },
    });

    const definitions = [
      ["subscription.account.share", "share"],
      ["subscription.account.unshare", "unshare"],
      ["subscription.account.disconnect", "disconnect"],
    ] as const;
    for (const [operation, method] of definitions) {
      register(registry, {
        operation,
        requiredScopes: ["subscription:write"],
        allowedRoles: ["owner", "admin", "member"],
        recovery: "replay-domain",
        validate: (value) => payload(value, ["accountId"], ["accountId"]),
        async handle(context, command, value) {
          const account = await accounts[method](context, {
            commandId: command.commandId,
            accountId: string(value.accountId, "accountId"),
            expectedVersion: expectedRevision(command),
          });
          return result(command, {
            resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
            data: subscriptionAccountData(account),
          });
        },
      });
    }
  }

  const policy = dependencies.subscriptionPolicy;
  if (policy) {
    register(registry, {
      operation: "subscription.policy.configure",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["providerId", "credentialPolicy"], ["providerId", "credentialPolicy"]),
      async handle(context, command, value) {
        const configured = await policy.configure(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          credentialPolicy: subscriptionCredentialPolicy(value.credentialPolicy),
          ...(command.expectedRevision === undefined ? {} : { expectedVersion: command.expectedRevision }),
        });
        return result(command, {
          resource: { type: "SubscriptionPolicy", id: configured.providerId, revision: configured.version },
          data: subscriptionPolicyData(configured),
        });
      },
    });
  }
}

export function registerApplicationDomainCommands(
  registry: ApplicationCommandRegistry,
  dependencies: ApplicationDomainDependencies,
): void {
  if (dependencies.works) registerWork(registry, dependencies.works);
  if (dependencies.runtime) registerRuntime(registry, dependencies.runtime);
  if (dependencies.approvals) registerApprovals(registry, dependencies.approvals);
  if (dependencies.assuranceBindings) registerAssuranceBindings(registry, dependencies.assuranceBindings);
  if (dependencies.organization) registerOrganization(registry, dependencies.organization);
  if (dependencies.extension) registerExtension(registry, dependencies.extension);
  if (dependencies.growth) registerGrowth(registry, dependencies.growth);
  registerRouter(registry, dependencies);
  registerSubscriptions(registry, dependencies);
}
