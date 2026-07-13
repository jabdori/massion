import type { ExtensionGateway } from "@massion/extension-host";
import type { AssuranceBindingStore } from "@massion/assurance";
import { GovernanceApprovalRequiredError, GovernanceDeniedError, type ApprovalStore } from "@massion/governance";
import type { GrowthGateway } from "@massion/growth";
import type { OrganizationGraphService } from "@massion/organization";
import type { ModelRouter, ProviderService } from "@massion/router";
import type { AgentRunner } from "@massion/runtime";
import {
  isOptimizationRoleKey,
  type EvaluationPolicy,
  type EvaluationReceipt,
  type ModelOptimizationStore,
  type OptimizationBatchService,
  type OptimizationModelProfile,
  type OptimizationRoleKey,
} from "@massion/model-optimization";
import { listSubscriptionProviderManifests, subscriptionProviderApprovalModes } from "@massion/subscriptions";
import type { SubscriptionAuthKind, SubscriptionProviderProtocol } from "@massion/subscriptions";
import type { WorkService } from "@massion/work";

import type { ApplicationCommandDescriptor, ApplicationCommandRegistry } from "../command-registry.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "../contracts.js";
import { ApplicationError } from "../errors.js";
import type {
  SubscriptionAccountCommands,
  SubscriptionConnectionCommands,
  SubscriptionConnectorCommands,
  SubscriptionDataDisclosureCommands,
  SubscriptionServerConnectionCommands,
  SubscriptionPolicyStore,
  SubscriptionPolicyView,
} from "../subscription-operations.js";
import { SUBSCRIPTION_APPROVAL_MODES, SUBSCRIPTION_CREDENTIAL_POLICIES } from "../subscription-operations.js";

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
  readonly optimization?: {
    readonly evaluations: Pick<
      ModelOptimizationStore,
      "createBundle" | "startEvaluation" | "completeEvaluation" | "configurePolicy" | "recommend"
    >;
    readonly batches: Pick<
      OptimizationBatchService,
      "approveRecommendation" | "createBatch" | "activateBatch" | "recordObservation" | "recover"
    >;
  };
  readonly subscriptionAccounts?: SubscriptionAccountCommands;
  readonly subscriptionConnections?: SubscriptionConnectionCommands;
  readonly subscriptionServerConnections?: SubscriptionServerConnectionCommands;
  readonly subscriptionConnectors?: SubscriptionConnectorCommands;
  readonly subscriptionDataDisclosures?: SubscriptionDataDisclosureCommands;
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

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} boolean이 유효하지 않습니다`);
  return value;
}

function subscriptionAuthKind(value: unknown): SubscriptionAuthKind {
  const candidate = string(value, "authKind");
  if (!new Set(["oauth", "device-code", "api-key", "subscription-key", "cli-profile", "acp"]).has(candidate)) {
    throw new Error("지원하지 않는 구독 인증 방식입니다");
  }
  return candidate as SubscriptionAuthKind;
}

function subscriptionModelAuthKind(value: unknown): Extract<SubscriptionAuthKind, "api-key" | "subscription-key"> {
  const candidate = subscriptionAuthKind(value);
  if (candidate !== "api-key" && candidate !== "subscription-key") {
    throw new Error("model 구독 인증 방식이 유효하지 않습니다");
  }
  return candidate;
}

function subscriptionSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 16 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("구독 Credential secret이 유효하지 않습니다");
  }
  return value;
}

function subscriptionProtocol(value: unknown): SubscriptionProviderProtocol {
  const candidate = string(value, "protocol");
  if (
    !new Set(["openai", "anthropic", "gemini", "acp", "cli-process", "codex-app-server", "claude-agent-sdk"]).has(
      candidate,
    )
  ) {
    throw new Error("지원하지 않는 구독 Provider protocol입니다");
  }
  return candidate as SubscriptionProviderProtocol;
}

function subscriptionCredentialPolicy(value: unknown): SubscriptionPolicyView["credentialPolicy"] {
  const candidate = string(value, "credentialPolicy");
  if (!SUBSCRIPTION_CREDENTIAL_POLICIES.includes(candidate as never)) {
    throw new Error("지원하지 않는 구독 계정 선택 정책입니다");
  }
  return candidate as SubscriptionPolicyView["credentialPolicy"];
}

function subscriptionApprovalMode(value: unknown): SubscriptionPolicyView["approvalMode"] {
  const candidate = string(value, "approvalMode");
  if (!SUBSCRIPTION_APPROVAL_MODES.includes(candidate as never)) {
    throw new Error("지원하지 않는 구독 승인 방식입니다");
  }
  return candidate as SubscriptionPolicyView["approvalMode"];
}

function providerApprovalMode(providerId: string, value: unknown): SubscriptionPolicyView["approvalMode"] {
  const manifest = listSubscriptionProviderManifests().find((candidate) => candidate.id === providerId);
  if (manifest?.connectionSurface === "unavailable") {
    throw new Error("공개 연결 표면이 없는 Provider에는 구독 실행 정책이 허용되지 않습니다");
  }
  const declared = manifest ? subscriptionProviderApprovalModes(manifest) : undefined;
  const selected =
    value === undefined
      ? declared?.includes("review")
        ? "review"
        : declared?.includes("deny")
          ? "deny"
          : (declared?.[0] ?? "review")
      : subscriptionApprovalMode(value);
  if (declared && !declared.includes(selected)) {
    throw new Error(`이 Provider에서 허용되지 않는 구독 승인 방식입니다: ${selected}`);
  }
  return selected;
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

function subscriptionServerConnectorData(connector: {
  readonly connectorId: string;
  readonly providerId: string;
  readonly executionKind: string;
  readonly runtimeId: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly trustOrigin: string;
  readonly processGeneration?: number;
  readonly lastHealthAt?: string;
}) {
  return {
    connectorId: connector.connectorId,
    providerId: connector.providerId,
    executionKind: connector.executionKind,
    runtimeId: connector.runtimeId,
    version: connector.version,
    capabilities: connector.capabilities,
    status: connector.status,
    trustOrigin: connector.trustOrigin,
    ...(connector.processGeneration === undefined ? {} : { processGeneration: connector.processGeneration }),
    ...(connector.lastHealthAt === undefined ? {} : { lastHealthAt: connector.lastHealthAt }),
  };
}

function subscriptionProfileHandle(value: string): string {
  if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/u.test(value)) throw new Error("구독 profile handle이 유효하지 않습니다");
  return value;
}

function subscriptionPolicyData(policy: SubscriptionPolicyView) {
  return {
    providerId: policy.providerId,
    credentialPolicy: policy.credentialPolicy,
    approvalMode: policy.approvalMode,
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
  runtime?: ApplicationDomainDependencies["runtime"],
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
      if (
        runtime &&
        voted.execution_id &&
        voted.resume_target === "runtime-subscription" &&
        (voted.status === "approved" || voted.status === "rejected")
      ) {
        await runtime.resume(context, voted.execution_id, { approvalId: voted.approval_id });
      }
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
  const dataDisclosures = dependencies.subscriptionDataDisclosures;
  if (dataDisclosures) {
    register(registry, {
      operation: "subscription.data-disclosure.acknowledge",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["providerId", "version"], ["providerId", "version"]),
      async handle(context, command, value) {
        const acknowledgement = await dataDisclosures.acknowledge(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          version: string(value.version, "version"),
        });
        return result(command, {
          resource: {
            type: "SubscriptionDataDisclosureAcknowledgement",
            id: `${acknowledgement.providerId}:${acknowledgement.version}`,
          },
          data: acknowledgement,
        });
      },
    });
  }

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

    register(registry, {
      operation: "subscription.connector.revoke",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["connectorId"], ["connectorId"]),
      async handle(context, command, value) {
        const connector = await connectors.revoke(context, string(value.connectorId, "connectorId"));
        return result(command, {
          resource: { type: "SubscriptionConnector", id: connector.connector_id },
          data: subscriptionConnectorData(connector),
        });
      },
    });
  }

  const serverConnections = dependencies.subscriptionServerConnections;
  if (serverConnections) {
    register(registry, {
      operation: "subscription.server.connect-model",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      retryFailedCommand: true,
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "alias",
            "authKind",
            "billingKind",
            "secret",
            "endpointUrl",
            "protocol",
            "acceptExperimental",
            "priority",
            "weight",
          ],
          ["providerId", "alias", "authKind", "billingKind", "secret"],
        ),
      async handle(context, command, value) {
        const connected = await serverConnections.connectModel(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          authKind: subscriptionModelAuthKind(value.authKind),
          billingKind: string(value.billingKind, "billingKind"),
          secret: subscriptionSecret(value.secret),
          ...(value.endpointUrl === undefined ? {} : { endpointUrl: string(value.endpointUrl, "endpointUrl") }),
          ...(value.protocol === undefined ? {} : { protocol: subscriptionProtocol(value.protocol) }),
          ...(value.acceptExperimental === undefined
            ? {}
            : { acceptExperimental: boolean(value.acceptExperimental, "acceptExperimental") }),
          ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
          ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
        });
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: connected.account.account_id,
            revision: connected.account.version,
          },
          data: {
            ...subscriptionAccountData(connected.account),
            connectorStatus: connected.connector.status,
          },
        });
      },
    });

    register(registry, {
      operation: "subscription.server.prepare",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          ["providerId", "alias", "authKind", "billingKind", "priority", "weight"],
          ["providerId", "alias", "authKind", "billingKind"],
        ),
      async handle(context, command, value) {
        if (!dataDisclosures) {
          throw new Error("서버 구독 로그인에 필요한 데이터 처리 고지 서비스가 구성되지 않았습니다");
        }
        await dataDisclosures.requireAcknowledgement(context, string(value.providerId, "providerId"));
        const prepared = await serverConnections.prepare(context, {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          authKind: subscriptionAuthKind(value.authKind),
          billingKind: string(value.billingKind, "billingKind"),
          ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
          ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
        });
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: prepared.account.account_id,
            revision: prepared.account.version,
          },
          data: {
            ...subscriptionAccountData(prepared.account),
            connectorStatus: prepared.connector.status,
            loginRequired: prepared.connector.status !== "ready",
            profileHandle: subscriptionProfileHandle(prepared.profileHandle),
          },
        });
      },
    });

    for (const [operation, method] of [
      ["subscription.server.attest", "attest"],
      ["subscription.server.offline", "offline"],
    ] as const) {
      register(registry, {
        operation,
        requiredScopes: ["subscription:write"],
        allowedRoles: ["owner", "admin", "member"],
        recovery: "replay-domain",
        validate: (value) =>
          payload(value, method === "attest" ? ["connectorId", "accountId", "modelId"] : ["connectorId"], [
            "connectorId",
          ]),
        async handle(context, command, value) {
          const connector = await serverConnections[method](context, {
            commandId: command.commandId,
            connectorId: string(value.connectorId, "connectorId"),
            ...(method !== "attest" || value.accountId === undefined
              ? {}
              : { accountId: string(value.accountId, "accountId") }),
            ...(method !== "attest" || value.modelId === undefined
              ? {}
              : { modelId: string(value.modelId, "modelId") }),
          });
          const modelRuntime =
            method === "attest"
              ? (
                  connector as {
                    readonly modelRuntime?: {
                      readonly modelId: string;
                      readonly modelProfileId: string;
                      readonly routeNames: readonly string[];
                    };
                  }
                ).modelRuntime
              : undefined;
          return result(command, {
            resource: { type: "SubscriptionConnector", id: connector.connectorId },
            data: {
              ...subscriptionServerConnectorData(connector),
              ...(modelRuntime
                ? {
                    modelId: modelRuntime.modelId,
                    modelProfileId: modelRuntime.modelProfileId,
                    routeNames: modelRuntime.routeNames,
                  }
                : {}),
            },
          });
        },
      });
    }
  }

  const accounts = dependencies.subscriptionAccounts;
  const connections = dependencies.subscriptionConnections;
  if (accounts || connections) {
    register(registry, {
      operation: "subscription.account.register",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(
          value,
          [
            "providerId",
            "alias",
            "connectorId",
            "profileLocator",
            "authKind",
            "billingKind",
            "endpointUrl",
            "protocol",
            "acceptExperimental",
            "priority",
            "weight",
          ],
          ["providerId", "alias", "connectorId", "profileLocator", "billingKind"],
        ),
      async handle(context, command, value) {
        const common = {
          commandId: command.commandId,
          providerId: string(value.providerId, "providerId"),
          alias: string(value.alias, "alias"),
          connectorId: string(value.connectorId, "connectorId"),
          profileLocator: string(value.profileLocator, "profileLocator"),
          billingKind: string(value.billingKind, "billingKind"),
        };
        let account;
        if (connections) {
          account = (
            await connections.connect(context, {
              ...common,
              authKind: subscriptionAuthKind(value.authKind),
              ...(value.endpointUrl === undefined ? {} : { endpointUrl: string(value.endpointUrl, "endpointUrl") }),
              ...(value.protocol === undefined ? {} : { protocol: subscriptionProtocol(value.protocol) }),
              ...(value.acceptExperimental === undefined
                ? {}
                : { acceptExperimental: boolean(value.acceptExperimental, "acceptExperimental") }),
              ...(value.priority === undefined ? {} : { priority: integer(value.priority, "priority") }),
              ...(value.weight === undefined ? {} : { weight: integer(value.weight, "weight", 1) }),
            })
          ).account;
        } else {
          if (!accounts) throw new Error("구독 계정 서비스가 구성되지 않았습니다");
          account = await accounts.register(context, common);
        }
        return result(command, {
          resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
          data: subscriptionAccountData(account),
        });
      },
    });
  }

  if (accounts) {
    register(registry, {
      operation: "subscription.account.share",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["accountId", "approvalId"], ["accountId"]),
      idempotencyPayload: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "approvalId")),
      resumeAwaitingApproval: (value) => value.approvalId !== undefined,
      async handle(context, command, value) {
        try {
          const account = await accounts.share(context, {
            commandId: command.commandId,
            accountId: string(value.accountId, "accountId"),
            expectedVersion: expectedRevision(command),
            ...(value.approvalId === undefined ? {} : { approvalId: string(value.approvalId, "approvalId") }),
          });
          return result(command, {
            resource: { type: "SubscriptionAccount", id: account.account_id, revision: account.version },
            data: subscriptionAccountData(account),
          });
        } catch (error) {
          if (error instanceof GovernanceApprovalRequiredError) {
            return result(command, {
              outcome: "awaiting-approval",
              data: { decisionId: error.decisionId, approvalId: error.approvalId },
            });
          }
          throw error;
        }
      },
    });

    const definitions = [["subscription.account.unshare", "unshare"]] as const;
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

    register(registry, {
      operation: "subscription.account.disconnect",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin", "member"],
      recovery: "replay-domain",
      validate: (value) => payload(value, ["accountId"], ["accountId"]),
      async handle(context, command, value) {
        const disconnectInput = {
          commandId: command.commandId,
          accountId: string(value.accountId, "accountId"),
          expectedVersion: expectedRevision(command),
        };
        const disconnected = connections
          ? await connections.disconnect(context, disconnectInput)
          : { account: await accounts.disconnect(context, disconnectInput), revokedCredentialCount: undefined };
        return result(command, {
          resource: {
            type: "SubscriptionAccount",
            id: disconnected.account.account_id,
            revision: disconnected.account.version,
          },
          data: {
            ...subscriptionAccountData(disconnected.account),
            ...(disconnected.revokedCredentialCount === undefined
              ? {}
              : { revokedCredentialCount: disconnected.revokedCredentialCount }),
          },
        });
      },
    });
  }

  const policy = dependencies.subscriptionPolicy;
  if (policy) {
    register(registry, {
      operation: "subscription.policy.configure",
      requiredScopes: ["subscription:write"],
      allowedRoles: ["owner", "admin"],
      recovery: "replay-domain",
      validate: (value) =>
        payload(value, ["providerId", "credentialPolicy", "approvalMode"], ["providerId", "credentialPolicy"]),
      async handle(context, command, value) {
        const providerId = string(value.providerId, "providerId");
        const configured = await policy.configure(context, {
          commandId: command.commandId,
          providerId,
          credentialPolicy: subscriptionCredentialPolicy(value.credentialPolicy),
          approvalMode: providerApprovalMode(providerId, value.approvalMode),
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

function optimizationRole(value: unknown): OptimizationRoleKey {
  const candidate = string(value, "roleKey");
  if (!isOptimizationRoleKey(candidate)) throw new Error("지원하지 않는 최적화 roleKey입니다");
  return candidate;
}

function optimizationPolicy(value: unknown): EvaluationPolicy {
  const candidate = string(value, "policy");
  if (!new Set(["quality", "value", "speed", "privacy", "manual"]).has(candidate)) {
    throw new Error("지원하지 않는 최적화 policy입니다");
  }
  return candidate as EvaluationPolicy;
}

function optimizationCandidate(value: unknown): OptimizationModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("모델 후보가 object여야 합니다");
  const candidate = value as Record<string, unknown>;
  return {
    modelProfileId: string(candidate.modelProfileId, "modelProfileId"),
    modelId: string(candidate.modelId, "modelId"),
    routeId: string(candidate.routeId, "routeId"),
    providerId: string(candidate.providerId, "providerId"),
    verified: boolean(candidate.verified, "verified"),
    supportsStructuredOutput: boolean(candidate.supportsStructuredOutput, "supportsStructuredOutput"),
    supportsTools: boolean(candidate.supportsTools, "supportsTools"),
    supportsStreaming: boolean(candidate.supportsStreaming, "supportsStreaming"),
    dataPolicy:
      candidate.dataPolicy === "local-private"
        ? "local-private"
        : candidate.dataPolicy === "external-allowed"
          ? "external-allowed"
          : (() => {
              throw new Error("dataPolicy가 유효하지 않습니다");
            })(),
  };
}

function optimizationCandidates(value: unknown): readonly OptimizationModelProfile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128)
    throw new Error("모델 후보 목록이 유효하지 않습니다");
  return value.map(optimizationCandidate);
}

function optimizationReceipts(value: unknown): readonly EvaluationReceipt[] {
  if (!Array.isArray(value) || (value.length > 0 && value.length > 1_024))
    throw new Error("모델 receipt 목록이 유효하지 않습니다");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("모델 receipt가 object여야 합니다");
    const receipt = item as Record<string, unknown>;
    return {
      roleKey: optimizationRole(receipt.roleKey),
      modelProfileId: string(receipt.modelProfileId, "modelProfileId"),
      bundleVersion: integer(receipt.bundleVersion, "bundleVersion", 1),
      sampleCount: integer(receipt.sampleCount, "sampleCount", 0),
      qualityScore: Number(receipt.qualityScore),
      latencyMs: Number(receipt.latencyMs),
      costMicros: Number(receipt.costMicros),
      privacyAllowed: boolean(receipt.privacyAllowed, "privacyAllowed"),
      completed: boolean(receipt.completed, "completed"),
      inputChecksum: string(receipt.inputChecksum, "inputChecksum"),
      receiptChecksum: string(receipt.receiptChecksum, "receiptChecksum"),
    };
  });
}

function optimizationRequirements(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("모델 평가 requirements가 object여야 합니다");
  const requirements = value as Record<string, unknown>;
  return {
    requiresTools: boolean(requirements.requiresTools, "requiresTools"),
    requiresStructuredOutput: boolean(requirements.requiresStructuredOutput, "requiresStructuredOutput"),
    requiresStreaming: boolean(requirements.requiresStreaming, "requiresStreaming"),
    dataPolicy:
      requirements.dataPolicy === "local-private"
        ? "local-private"
        : requirements.dataPolicy === "external-allowed"
          ? "external-allowed"
          : (() => {
              throw new Error("requirements dataPolicy가 유효하지 않습니다");
            })(),
  } as const;
}

function registerOptimization(registry: ApplicationCommandRegistry, dependencies: ApplicationDomainDependencies): void {
  const optimization = dependencies.optimization;
  if (!optimization) return;

  register(registry, {
    operation: "optimization.policy.configure",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        [
          "policy",
          "autoOptimize",
          "productionLearning",
          "shadowEnabled",
          "minimumSampleCount",
          "improvementThreshold",
          "governanceDecisionId",
        ],
        ["policy", "autoOptimize", "productionLearning", "shadowEnabled", "governanceDecisionId"],
      ),
    async handle(context, command, value) {
      const configured = await optimization.evaluations.configurePolicy(context, {
        commandId: command.commandId,
        policy: optimizationPolicy(value.policy),
        autoOptimize: boolean(value.autoOptimize, "autoOptimize"),
        productionLearning: boolean(value.productionLearning, "productionLearning"),
        shadowEnabled: boolean(value.shadowEnabled, "shadowEnabled"),
        ...(value.minimumSampleCount === undefined
          ? {}
          : { minimumSampleCount: integer(value.minimumSampleCount, "minimumSampleCount", 1) }),
        ...(value.improvementThreshold === undefined
          ? {}
          : { improvementThreshold: Number(value.improvementThreshold) }),
        governanceDecisionId: string(value.governanceDecisionId, "governanceDecisionId"),
      });
      return result(command, {
        resource: { type: "OptimizationPolicy", id: configured.policyVersionId, revision: configured.version },
        data: configured,
      });
    },
  });

  register(registry, {
    operation: "optimization.bundle.create",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["roleKey", "runtimeVersion", "cases"], ["roleKey", "runtimeVersion", "cases"]),
    async handle(context, command, value) {
      const cases = Array.isArray(value.cases)
        ? value.cases.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
              throw new Error("평가 case가 object여야 합니다");
            const evaluationCase = item as Record<string, unknown>;
            return {
              promptChecksum: string(evaluationCase.promptChecksum, "promptChecksum"),
              toolsChecksum: string(evaluationCase.toolsChecksum, "toolsChecksum"),
              environmentChecksum: string(evaluationCase.environmentChecksum, "environmentChecksum"),
              expectedOutcome: string(evaluationCase.expectedOutcome, "expectedOutcome"),
            };
          })
        : (() => {
            throw new Error("평가 cases가 배열이어야 합니다");
          })();
      const bundle = await optimization.evaluations.createBundle(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        runtimeVersion: string(value.runtimeVersion, "runtimeVersion"),
        cases,
      });
      return result(command, {
        resource: { type: "OptimizationBundle", id: bundle.bundleId, revision: bundle.version },
        data: bundle,
      });
    },
  });

  register(registry, {
    operation: "optimization.evaluation.start",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion", "inputChecksum", "mode"],
        ["roleKey", "bundleId", "modelProfileId", "runtimeVersion", "inputChecksum"],
      ),
    async handle(context, command, value) {
      const run = await optimization.evaluations.startEvaluation(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        bundleId: string(value.bundleId, "bundleId"),
        modelProfileId: string(value.modelProfileId, "modelProfileId"),
        runtimeVersion: string(value.runtimeVersion, "runtimeVersion"),
        inputChecksum: string(value.inputChecksum, "inputChecksum"),
        ...(value.mode === undefined ? {} : { mode: value.mode as "standard" | "shadow" }),
      });
      return result(command, { resource: { type: "OptimizationRun", id: run.runId }, data: run });
    },
  });

  register(registry, {
    operation: "optimization.evaluation.complete",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["runId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "privacyAllowed", "completed"],
        ["runId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "privacyAllowed", "completed"],
      ),
    async handle(context, command, value) {
      const receipt = await optimization.evaluations.completeEvaluation(context, {
        commandId: command.commandId,
        runId: string(value.runId, "runId"),
        sampleCount: integer(value.sampleCount, "sampleCount", 1),
        qualityScore: Number(value.qualityScore),
        latencyMs: Number(value.latencyMs),
        costMicros: Number(value.costMicros),
        privacyAllowed: boolean(value.privacyAllowed, "privacyAllowed"),
        completed: boolean(value.completed, "completed"),
      });
      return result(command, { resource: { type: "OptimizationReceipt", id: receipt.receiptId }, data: receipt });
    },
  });

  register(registry, {
    operation: "optimization.recommend",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["roleKey", "candidates", "receipts", "requirements", "manualModelProfileId"],
        ["roleKey", "candidates", "receipts", "requirements"],
      ),
    async handle(context, command, value) {
      const recommendation = await optimization.evaluations.recommend(context, {
        commandId: command.commandId,
        roleKey: optimizationRole(value.roleKey),
        candidates: optimizationCandidates(value.candidates),
        receipts: optimizationReceipts(value.receipts),
        requirements: optimizationRequirements(value.requirements),
        ...(value.manualModelProfileId === undefined
          ? {}
          : { manualModelProfileId: string(value.manualModelProfileId, "manualModelProfileId") }),
      });
      return result(command, {
        resource: { type: "OptimizationRecommendation", id: recommendation.recommendationId },
        data: recommendation,
      });
    },
  });

  register(registry, {
    operation: "optimization.recommendation.approve",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(value, ["recommendationId", "governanceDecisionId"], ["recommendationId", "governanceDecisionId"]),
    async handle(context, command, value) {
      const approved = await optimization.batches.approveRecommendation(context, {
        commandId: command.commandId,
        recommendationId: string(value.recommendationId, "recommendationId"),
        governanceDecisionId: string(value.governanceDecisionId, "governanceDecisionId"),
      });
      return result(command, {
        resource: { type: "OptimizationRecommendation", id: approved.recommendationId },
        data: approved,
      });
    },
  });

  register(registry, {
    operation: "optimization.batch.create",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["recommendationId", "status"], ["recommendationId", "status"]),
    async handle(context, command, value) {
      const batch = await optimization.batches.createBatch(context, {
        commandId: command.commandId,
        recommendationId: string(value.recommendationId, "recommendationId"),
        status: value.status as never,
      });
      return result(command, {
        resource: { type: "OptimizationBatch", id: batch.batchId, revision: batch.version },
        data: batch,
      });
    },
  });

  register(registry, {
    operation: "optimization.batch.activate",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["batchId"], ["batchId"]),
    async handle(context, command, value) {
      const batch = await optimization.batches.activateBatch(context, {
        commandId: command.commandId,
        batchId: string(value.batchId, "batchId"),
      });
      return result(command, {
        resource: { type: "OptimizationBatch", id: batch.batchId, revision: batch.version },
        data: batch,
      });
    },
  });

  register(registry, {
    operation: "optimization.observation.record",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: (value) =>
      payload(
        value,
        ["batchId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "status"],
        ["batchId", "sampleCount", "qualityScore", "latencyMs", "costMicros", "status"],
      ),
    async handle(context, command, value) {
      const observation = await optimization.batches.recordObservation(context, {
        commandId: command.commandId,
        batchId: string(value.batchId, "batchId"),
        sampleCount: integer(value.sampleCount, "sampleCount", 1),
        qualityScore: Number(value.qualityScore),
        latencyMs: Number(value.latencyMs),
        costMicros: Number(value.costMicros),
        status: value.status as "healthy" | "degraded",
      });
      return result(command, {
        resource: { type: "OptimizationObservation", id: observation.observationId },
        data: observation,
      });
    },
  });

  register(registry, {
    operation: "optimization.recover",
    requiredScopes: ["optimization:write"],
    allowedRoles: ["owner", "admin"],
    recovery: "replay-domain",
    validate: (value) => payload(value, ["observationId"], ["observationId"]),
    async handle(context, command, value) {
      const recovery = await optimization.batches.recover(context, {
        commandId: command.commandId,
        observationId: string(value.observationId, "observationId"),
      });
      return result(command, { resource: { type: "OptimizationRecovery", id: recovery.recoveryId }, data: recovery });
    },
  });
}

export function registerApplicationDomainCommands(
  registry: ApplicationCommandRegistry,
  dependencies: ApplicationDomainDependencies,
): void {
  if (dependencies.works) registerWork(registry, dependencies.works);
  if (dependencies.runtime) registerRuntime(registry, dependencies.runtime);
  if (dependencies.approvals) registerApprovals(registry, dependencies.approvals, dependencies.runtime);
  if (dependencies.assuranceBindings) registerAssuranceBindings(registry, dependencies.assuranceBindings);
  if (dependencies.organization) registerOrganization(registry, dependencies.organization);
  if (dependencies.extension) registerExtension(registry, dependencies.extension);
  if (dependencies.growth) registerGrowth(registry, dependencies.growth);
  registerRouter(registry, dependencies);
  registerSubscriptions(registry, dependencies);
  registerOptimization(registry, dependencies);
}
