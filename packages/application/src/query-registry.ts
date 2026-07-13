import type { ExtensionGateway } from "@massion/extension-host";
import type { AssuranceBindingStore } from "@massion/assurance";
import type { GrowthGateway } from "@massion/growth";
import type { MembershipRole, OrganizationService, TenantContext } from "@massion/identity";
import type { ModelRouter, ProviderService } from "@massion/router";
import {
  isOptimizationRoleKey,
  type ModelOptimizationStore,
  type OptimizationBatchService,
} from "@massion/model-optimization";
import type { RuntimeExecutionStore } from "@massion/runtime";

import { ApplicationError } from "./errors.js";
import type { ApplicationEventStore } from "./event-store.js";
import type { ApplicationReadModel } from "./read-model.js";
import type { CollaborationGraphSnapshotProjector } from "./snapshot.js";
import type { WebSessionService } from "./web-session.js";
import type {
  SubscriptionAccountQueries,
  SubscriptionConnectorQueries,
  SubscriptionPolicyStore,
  SubscriptionPolicyView,
  SubscriptionProviderDirectory,
  SubscriptionProviderView,
  SubscriptionQuotaQueries,
} from "./subscription-operations.js";
import { BuiltinSubscriptionProviderDirectory } from "./subscription-operations.js";
import {
  runtimeSubscriptionLineage,
  runtimeSubscriptionLineagesByCorrelation,
} from "./runtime-subscription-lineage.js";

export interface ApplicationQueryResultV1 {
  readonly schemaVersion: "massion.application.v1";
  readonly operation: string;
  readonly data: unknown;
}

export interface ApplicationQueryDescriptor<Payload = unknown> {
  readonly operation: string;
  readonly requiredScopes: readonly string[];
  readonly allowedRoles: readonly MembershipRole[];
  validate(payload: unknown): Payload;
  handle(context: TenantContext, payload: Payload): Promise<unknown>;
}

export interface ApplicationQueryDependencies {
  readonly readModel: ApplicationReadModel;
  readonly snapshot?: CollaborationGraphSnapshotProjector;
  readonly runtime?: Pick<RuntimeExecutionStore, "listEvents" | "getRecovery" | "listByCorrelation">;
  readonly assuranceBindings?: Pick<AssuranceBindingStore, "get" | "getActive">;
  readonly extension?: Pick<ExtensionGateway, "list">;
  readonly growth?: Pick<
    GrowthGateway,
    | "resolveConfiguration"
    | "getActiveEvaluationStrategy"
    | "getActiveMemories"
    | "listSuggestions"
    | "listEffectEvaluations"
  >;
  readonly memberships?: Pick<OrganizationService, "listMembers">;
  readonly audit?: Pick<ApplicationEventStore, "read">;
  readonly webSessions?: Pick<WebSessionService, "list">;
  readonly providers?: Pick<ProviderService, "listProviders" | "listEndpoints" | "listCredentials">;
  readonly router?: Pick<ModelRouter, "listModels" | "listRoutes" | "listCandidates" | "readAttempt">;
  readonly status?: (context: TenantContext) => Promise<unknown>;
  readonly subscriptionAccounts?: SubscriptionAccountQueries;
  readonly subscriptionConnectors?: SubscriptionConnectorQueries;
  readonly subscriptionProviders?: SubscriptionProviderDirectory;
  readonly subscriptionQuota?: SubscriptionQuotaQueries;
  readonly subscriptionPolicy?: SubscriptionPolicyStore;
  readonly optimization?: {
    readonly evaluations: Pick<ModelOptimizationStore, "getActivePolicy" | "listReceipts">;
    readonly batches: Pick<OptimizationBatchService, "getActiveBatch">;
  };
}

const OPERATION = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

function object(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application query payload는 object여야 합니다");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Application query payload에 알 수 없는 필드가 있습니다: ${unknown}`);
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value;
}

function boundedInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000)
    throw new Error(`${label}가 유효하지 않습니다`);
  return value as number;
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("after가 유효하지 않습니다");
  return value as number;
}

export class ApplicationQueryRegistry {
  private readonly descriptors = new Map<string, ApplicationQueryDescriptor>();

  public register<Payload>(descriptor: ApplicationQueryDescriptor<Payload>): void {
    if (
      !OPERATION.test(descriptor.operation) ||
      descriptor.requiredScopes.length === 0 ||
      descriptor.allowedRoles.length === 0
    ) {
      throw new Error("Application query descriptor가 유효하지 않습니다");
    }
    if (this.descriptors.has(descriptor.operation)) throw new Error("Application query operation 중복입니다");
    this.descriptors.set(descriptor.operation, descriptor);
  }

  public async query(
    context: TenantContext,
    callerScopes: readonly string[],
    operation: string,
    input: unknown,
  ): Promise<ApplicationQueryResultV1> {
    const descriptor = this.descriptors.get(operation);
    if (!descriptor) {
      throw new ApplicationError({
        category: "validation",
        severity: "error",
        retryable: false,
        userMessage: "지원하지 않는 Application query operation입니다",
        operatorCode: "APP_QUERY_UNKNOWN",
      });
    }
    if (
      !callerScopes.includes("application:*") &&
      descriptor.requiredScopes.some((scope) => !callerScopes.includes(scope))
    ) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Application query scope가 부족합니다",
        operatorCode: "APP_QUERY_SCOPE_REQUIRED",
      });
    }
    if (!descriptor.allowedRoles.includes(context.role)) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "조직 역할에 이 query 권한이 없습니다",
        operatorCode: "APP_QUERY_ROLE_REQUIRED",
      });
    }
    return {
      schemaVersion: "massion.application.v1",
      operation,
      data: await descriptor.handle(context, descriptor.validate(input)),
    };
  }
}

function assuranceBindingView(binding: Awaited<ReturnType<AssuranceBindingStore["get"]>>): unknown {
  return {
    bindingVersionId: binding.bindingVersionId,
    workId: binding.workId,
    planVersionId: binding.planVersionId,
    version: binding.version,
    revision: binding.revision,
    status: binding.status,
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    bindings: binding.bindings,
    criteriaChecksum: binding.criteriaChecksum,
    checksum: binding.checksum,
    authorHandle: binding.authorHandle,
    createdAt: binding.createdAt,
    activatedAt: binding.activatedAt,
  };
}

const EVERY_ROLE: readonly MembershipRole[] = ["owner", "admin", "member"];

function publicWork(value: Awaited<ReturnType<ApplicationReadModel["works"]>>[number]) {
  return {
    workId: value.workId,
    status: value.status,
    revision: value.revision,
    artifactIds: value.artifactIds,
  };
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new Error(`${label} 시각이 유효하지 않습니다`);
}

function publicSubscriptionProvider(provider: SubscriptionProviderView) {
  const runtimeCapabilities = provider.runtimeCapabilities;
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    authKinds: provider.authKinds,
    executionKind: provider.executionKind,
    connectionSurface: provider.connectionSurface,
    billingKinds: provider.billingKinds,
    modelDiscovery: provider.modelDiscovery,
    quotaDiscovery: provider.quotaDiscovery,
    protocols: provider.protocols,
    ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
    availability: provider.availability,
    officialDocumentation: provider.officialDocumentation,
    credentialPolicies: provider.credentialPolicies,
    verified: provider.verified,
    ...(runtimeCapabilities
      ? {
          runtimeCapabilities: {
            ...(runtimeCapabilities.minimumVersion === undefined
              ? {}
              : { minimumVersion: runtimeCapabilities.minimumVersion }),
            accountIsolation: runtimeCapabilities.accountIsolation,
            output: runtimeCapabilities.output,
            cancellation: runtimeCapabilities.cancellation,
            session: runtimeCapabilities.session,
            permissionBridge: runtimeCapabilities.permissionBridge,
            multipleAccounts: runtimeCapabilities.multipleAccounts,
            maturity: runtimeCapabilities.maturity,
            ...(runtimeCapabilities.approvalModes === undefined
              ? {}
              : { approvalModes: runtimeCapabilities.approvalModes }),
            ...(runtimeCapabilities.approvalModesBySurface === undefined
              ? {}
              : {
                  approvalModesBySurface: {
                    ...(runtimeCapabilities.approvalModesBySurface.server === undefined
                      ? {}
                      : { server: runtimeCapabilities.approvalModesBySurface.server }),
                    ...(runtimeCapabilities.approvalModesBySurface.edge === undefined
                      ? {}
                      : { edge: runtimeCapabilities.approvalModesBySurface.edge }),
                  },
                }),
          },
        }
      : {}),
  };
}

function publicSubscriptionPolicy(policy: SubscriptionPolicyView) {
  return {
    providerId: policy.providerId,
    credentialPolicy: policy.credentialPolicy,
    approvalMode: policy.approvalMode,
    version: policy.version,
    source: policy.source,
    ...(policy.updatedAt === undefined ? {} : { updatedAt: policy.updatedAt }),
  };
}

function publicQuota(quota: Awaited<ReturnType<SubscriptionQuotaQueries["current"]>>) {
  if (!quota) return undefined;
  return {
    accountId: quota.accountId,
    windows: quota.windows.map((window) => ({
      kind: window.kind,
      ...(window.limit === undefined ? {} : { limit: window.limit }),
      ...(window.remaining === undefined ? {} : { remaining: window.remaining }),
      ...(window.remainingRatio === undefined ? {} : { remainingRatio: window.remainingRatio }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      observedAt: window.observedAt,
      confidence: window.confidence,
    })),
    ...(quota.minimumRemainingRatio === undefined ? {} : { minimumRemainingRatio: quota.minimumRemainingRatio }),
    ...(quota.earliestResetAt === undefined ? {} : { earliestResetAt: quota.earliestResetAt }),
    exhausted: quota.exhausted,
    observedAt: quota.observedAt,
  };
}

async function subscriptionAccountRows(
  context: TenantContext,
  dependencies: Pick<
    ApplicationQueryDependencies,
    "subscriptionAccounts" | "subscriptionConnectors" | "subscriptionQuota"
  >,
  accountId?: string,
) {
  const accounts = (await dependencies.subscriptionAccounts?.list(context, "organization")) ?? [];
  return await Promise.all(
    accounts
      .filter((account) => accountId === undefined || account.account_id === accountId)
      .map(async (account) => {
        const canReadQuota = account.owner_user_id === context.userId || context.role !== "member";
        const [connector, quota] = await Promise.all([
          dependencies.subscriptionConnectors?.get(context, account.connector_id),
          canReadQuota ? dependencies.subscriptionQuota?.current(context, account.account_id) : undefined,
        ]);
        return { account, connector, quota: publicQuota(quota) };
      }),
  );
}

export function registerApplicationQueries(
  registry: ApplicationQueryRegistry,
  dependencies: ApplicationQueryDependencies,
): void {
  registry.register({
    operation: "identity.me",
    requiredScopes: ["identity:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: (context) =>
      Promise.resolve({
        userId: context.userId,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        role: context.role,
      }),
  });
  if (dependencies.memberships) {
    registry.register({
      operation: "identity.memberships",
      requiredScopes: ["identity:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        ((await dependencies.memberships?.listMembers(context)) ?? []).map((member) => ({
          membershipId: member.membershipId,
          userId: member.userId,
          displayName: member.displayName,
          ...(context.role === "member" ? {} : { email: member.email }),
          role: member.role,
          status: member.status,
          revision: member.revision,
          createdAt: member.createdAt,
        })),
    });
  }
  if (dependencies.webSessions) {
    registry.register({
      operation: "application.sessions",
      requiredScopes: ["identity:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await dependencies.webSessions?.list(context),
    });
  }
  if (dependencies.audit) {
    registry.register({
      operation: "application.audit",
      requiredScopes: ["audit:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["after", "limit"]),
      handle: async (context, value) =>
        await dependencies.audit?.read(context, {
          after: cursor(value.after),
          limit: boundedInteger(value.limit, "limit", 100),
        }),
    });
  }
  registry.register({
    operation: "work.list",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: async (context) => (await dependencies.readModel.works(context)).map(publicWork),
  });
  registry.register({
    operation: "work.get",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const work = (await dependencies.readModel.works(context)).find((candidate) => candidate.workId === workId);
      if (!work)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Work를 찾을 수 없습니다",
          operatorCode: "APP_WORK_NOT_FOUND",
        });
      return publicWork(work);
    },
  });
  registry.register({
    operation: "work.tasks",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.tasks(context))
        .filter((task) => task.workId === text(value.workId, "workId"))
        .map((task) => ({
          workId: task.workId,
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          revision: task.revision,
        })),
  });
  registry.register({
    operation: "work.assignments",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.assignments(context))
        .filter((assignment) => assignment.workId === text(value.workId, "workId"))
        .map((assignment) => ({
          workId: assignment.workId,
          taskId: assignment.taskId,
          agentHandle: assignment.agentHandle,
          status: assignment.status,
          revision: assignment.revision,
        })),
  });
  registry.register({
    operation: "work.rooms",
    requiredScopes: ["collaboration:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.rooms(context))
        .filter((room) => room.workId === text(value.workId, "workId"))
        .map((room) => ({
          workId: room.workId,
          roomId: room.roomId,
          name: room.name,
          kind: room.kind,
          status: room.status,
          participantIds: room.participantIds,
          lastMessageSequence: room.lastMessageSequence,
        })),
  });
  if (dependencies.readModel.messages) {
    registry.register({
      operation: "work.messages",
      requiredScopes: ["collaboration:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "roomId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const roomId = text(value.roomId, "roomId");
        return ((await dependencies.readModel.messages?.(context)) ?? [])
          .filter((message) => message.workId === workId && message.roomId === roomId)
          .map((message) => ({
            messageId: message.messageId,
            sequence: message.sequence,
            messageType: message.messageType,
            authorKind: message.authorKind,
            authorId: message.authorId,
            content: message.content,
            createdAt: message.createdAt,
          }));
      },
    });
  }
  if (dependencies.readModel.records) {
    registry.register({
      operation: "work.records",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) =>
        ((await dependencies.readModel.records?.(context)) ?? [])
          .filter((record) => record.workId === text(value.workId, "workId"))
          .map((record) => ({
            recordId: record.recordId,
            version: record.version,
            summary: record.summary,
            artifactIds: record.artifactIds,
            verificationIds: record.verificationIds,
            finalizedAt: record.finalizedAt,
          })),
    });
  }
  registry.register({
    operation: "runtime.execution.get",
    requiredScopes: ["runtime:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["executionId"]),
    handle: async (context, value) => {
      const executionId = text(value.executionId, "executionId");
      const execution = (await dependencies.readModel.executions(context)).find(
        (candidate) => candidate.executionId === executionId,
      );
      if (!execution)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Runtime execution을 찾을 수 없습니다",
          operatorCode: "APP_EXECUTION_NOT_FOUND",
        });
      return {
        executionId: execution.executionId,
        workId: execution.workId,
        ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
        agentHandle: execution.agentHandle,
        modelRoute: execution.modelRoute,
        status: execution.status,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        costMicros: execution.costMicros,
      };
    },
  });
  registry.register({
    operation: "governance.approval.list",
    requiredScopes: ["approval:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: async (context) =>
      (await dependencies.readModel.approvals(context)).map((approval) => ({
        approvalId: approval.approvalId,
        action: approval.action,
        status: approval.status,
        requestedBy: approval.requestedBy,
        expiresAt: approval.expiresAt,
        ...(approval.displayPreview === undefined ? {} : { displayPreview: approval.displayPreview }),
      })),
  });
  registry.register({
    operation: "governance.approval.get",
    requiredScopes: ["approval:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["approvalId"]),
    handle: async (context, value) => {
      const approvalId = text(value.approvalId, "approvalId");
      const approval = (await dependencies.readModel.approvals(context)).find(
        (candidate) => candidate.approvalId === approvalId,
      );
      if (!approval)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Approval을 찾을 수 없습니다",
          operatorCode: "APP_APPROVAL_NOT_FOUND",
        });
      return {
        approvalId: approval.approvalId,
        action: approval.action,
        status: approval.status,
        requestedBy: approval.requestedBy,
        expiresAt: approval.expiresAt,
        ...(approval.displayPreview === undefined ? {} : { displayPreview: approval.displayPreview }),
      };
    },
  });
  registry.register({
    operation: "organization.list",
    requiredScopes: ["organization:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: (context) =>
      Promise.resolve([
        { organizationId: context.organizationId, membershipId: context.membershipId, role: context.role },
      ]),
  });
  if (dependencies.snapshot) {
    registry.register({
      operation: "organization.graph.snapshot",
      requiredScopes: ["organization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await dependencies.snapshot?.project(context),
    });
  }
  if (dependencies.runtime) {
    registry.register({
      operation: "runtime.execution.events",
      requiredScopes: ["runtime:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["executionId", "afterSequence"]),
      handle: async (context, value) => {
        const events = await dependencies.runtime?.listEvents(
          context,
          text(value.executionId, "executionId"),
          value.afterSequence === undefined ? 0 : Number(value.afterSequence),
        );
        return (events ?? []).map((event) => ({
          eventId: event.event_id,
          sequence: event.sequence,
          type: event.event_type,
          createdAt: event.created_at,
        }));
      },
    });
  }
  if (dependencies.runtime && dependencies.router) {
    registry.register({
      operation: "runtime.execution.subscription-lineage",
      requiredScopes: ["runtime:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => {
        const parsed = object(value, ["executionId", "correlationId"]);
        if ((parsed.executionId === undefined) === (parsed.correlationId === undefined)) {
          throw new Error("executionId와 correlationId 중 하나만 필요합니다");
        }
        return parsed;
      },
      handle: async (context, value) => {
        const runtime = dependencies.runtime as NonNullable<ApplicationQueryDependencies["runtime"]>;
        const router = dependencies.router as NonNullable<ApplicationQueryDependencies["router"]>;
        return value.executionId === undefined
          ? await runtimeSubscriptionLineagesByCorrelation(
              context,
              text(value.correlationId, "correlationId"),
              runtime,
              router,
            )
          : await runtimeSubscriptionLineage(context, text(value.executionId, "executionId"), runtime, router);
      },
    });
  }
  if (dependencies.extension) {
    registry.register({
      operation: "extension.list",
      requiredScopes: ["extension:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await dependencies.extension?.list(context),
    });
  }
  if (dependencies.growth) {
    registry.register({
      operation: "growth.memories",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["requesterUserId"]),
      handle: async (context, value) => {
        const requesterUserId =
          value.requesterUserId === undefined ? context.userId : text(value.requesterUserId, "requesterUserId");
        if (requesterUserId !== context.userId && context.role === "member") {
          throw new ApplicationError({
            category: "authorization",
            severity: "error",
            retryable: false,
            userMessage: "다른 사용자의 기억을 조회할 권한이 없습니다",
            operatorCode: "APP_MEMORY_USER_REQUIRED",
          });
        }
        return ((await dependencies.growth?.getActiveMemories(context, requesterUserId)) ?? []).map((memory) => ({
          memoryVersionId: memory.memoryVersionId,
          scope: memory.scope,
          subjectId: memory.subjectId,
          version: memory.version,
          status: memory.status,
          entryKeys: memory.entries.map((entry) => entry.key),
          sourceReferenceIds: [...new Set(memory.entries.flatMap((entry) => entry.sourceReferenceIds))].sort(),
          checksum: memory.checksum,
        }));
      },
    });
    registry.register({
      operation: "growth.configuration.get",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["requesterUserId"]),
      handle: async (context, value) =>
        await dependencies.growth?.resolveConfiguration(
          context,
          value.requesterUserId === undefined ? undefined : text(value.requesterUserId, "requesterUserId"),
        ),
    });
    registry.register({
      operation: "growth.suggestions",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "status", "limit"]),
      handle: async (context, value) =>
        (
          (await dependencies.growth?.listSuggestions(context, {
            ...(value.workId === undefined ? {} : { workId: text(value.workId, "workId") }),
            ...(value.status === undefined ? {} : { status: text(value.status, "status") as never }),
            limit: boundedInteger(value.limit, "limit", 100),
          })) ?? []
        ).map((suggestion) => ({
          suggestionId: suggestion.suggestion_id,
          workId: suggestion.work_id,
          targetKind: suggestion.target_kind,
          operation: suggestion.operation,
          summary: suggestion.summary,
          rationale: suggestion.rationale,
          expectedEffect: suggestion.expected_effect,
          riskSummary: suggestion.risk_summary,
          status: suggestion.status,
        })),
    });
    registry.register({
      operation: "growth.effects",
      requiredScopes: ["growth:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["adoptionId", "limit"]),
      handle: async (context, value) =>
        await dependencies.growth?.listEffectEvaluations(context, {
          ...(value.adoptionId === undefined ? {} : { adoptionId: text(value.adoptionId, "adoptionId") }),
          limit: boundedInteger(value.limit, "limit", 100),
        }),
    });
  }
  const assuranceBindings = dependencies.assuranceBindings;
  if (assuranceBindings) {
    registry.register({
      operation: "assurance.binding.get",
      requiredScopes: ["assurance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["bindingVersionId"]),
      handle: async (context, value) =>
        assuranceBindingView(await assuranceBindings.get(context, text(value.bindingVersionId, "bindingVersionId"))),
    });
    registry.register({
      operation: "assurance.binding.active",
      requiredScopes: ["assurance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "planVersionId"]),
      handle: async (context, value) => {
        const active = await assuranceBindings.getActive(
          context,
          text(value.workId, "workId"),
          text(value.planVersionId, "planVersionId"),
        );
        return active ? assuranceBindingView(active) : undefined;
      },
    });
  }
  if (dependencies.providers) {
    registry.register({
      operation: "router.credentials",
      requiredScopes: ["router:read"],
      allowedRoles: ["owner", "admin"],
      validate: (value) => object(value, ["providerId"]),
      handle: async (context, value) =>
        (
          await dependencies.providers?.listCredentials(
            context,
            value.providerId === undefined ? undefined : text(value.providerId, "providerId"),
          )
        )?.map((credential) => ({
          credentialId: credential.credential_id,
          providerId: credential.provider_id,
          endpointId: credential.endpoint_id,
          label: credential.label,
          status: credential.status,
          priority: credential.priority,
          weight: credential.weight,
          requestCount: credential.request_count,
          inputTokens: credential.input_tokens,
          outputTokens: credential.output_tokens,
          costMicros: credential.cost_micros,
        })) ?? [],
    });
  }
  if (dependencies.router) {
    registry.register({
      operation: "router.routes",
      requiredScopes: ["router:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        ((await dependencies.router?.listRoutes(context)) ?? []).map((route) => ({
          routeId: route.route_id,
          name: route.name,
          routeKind: route.route_kind,
          credentialPolicy: route.credential_policy,
          dataPolicy: route.data_policy,
          equivalenceGroup: route.equivalence_group,
          spentMicros: route.spent_micros,
          totalBudgetMicros: route.total_budget_micros,
          enabled: route.enabled,
        })),
    });
  }
  if (dependencies.providers && dependencies.router) {
    registry.register({
      operation: "router.catalog",
      requiredScopes: ["router:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const [providers, endpoints, models, candidates] = await Promise.all([
          dependencies.providers?.listProviders(context),
          dependencies.providers?.listEndpoints(context),
          dependencies.router?.listModels(context),
          dependencies.router?.listCandidates(context),
        ]);
        return {
          providers: (providers ?? []).map((provider) => ({
            providerId: provider.provider_id,
            displayName: provider.display_name,
            adapterKind: provider.adapter_kind,
            enabled: provider.enabled,
          })),
          endpoints: (endpoints ?? []).map((endpoint) => ({
            endpointId: endpoint.endpoint_id,
            providerId: endpoint.provider_id,
            name: endpoint.name,
            baseUrl: endpoint.base_url,
            local: endpoint.local,
            gatewayKind: endpoint.gateway_kind,
            enabled: endpoint.enabled,
          })),
          models: (models ?? []).map((model) => ({
            modelProfileId: model.model_profile_id,
            providerId: model.provider_id,
            endpointId: model.endpoint_id,
            modelId: model.model_id,
            routeKind: model.route_kind,
            equivalenceGroup: model.equivalence_group,
            verified: model.verified,
            enabled: model.enabled,
          })),
          candidates: (candidates ?? []).map((candidate) => ({
            candidateId: candidate.candidate_id,
            routeId: candidate.route_id,
            modelProfileId: candidate.model_profile_id,
            priority: candidate.priority,
            enabled: candidate.enabled,
          })),
        };
      },
    });
  }
  const subscriptionProviders = dependencies.subscriptionProviders ?? new BuiltinSubscriptionProviderDirectory();
  registry.register({
    operation: "subscription.providers",
    requiredScopes: ["subscription:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, []),
    handle: async (context) => (await subscriptionProviders.list(context)).map(publicSubscriptionProvider),
  });
  if (dependencies.subscriptionAccounts) {
    registry.register({
      operation: "subscription.accounts",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) =>
        (await subscriptionAccountRows(context, dependencies)).map(({ account, connector, quota }) => ({
          accountId: account.account_id,
          providerId: account.provider_id,
          alias: account.alias,
          scope: account.scope,
          canManage: account.owner_user_id === context.userId,
          connectorId: account.connector_id,
          ...(connector === undefined
            ? {}
            : {
                connectorLocation: connector.location,
                connectorExecutionKind: connector.execution_kind,
                connectorStatus: connector.status,
              }),
          billingKind: account.billing_kind,
          status: account.status,
          version: account.version,
          ...(account.cooldown_until === undefined
            ? {}
            : { cooldownUntil: timestamp(account.cooldown_until, "구독 계정 cooldown") }),
          ...(quota === undefined
            ? {}
            : {
                windows: quota.windows,
                minimumRemainingRatio: quota.minimumRemainingRatio,
                earliestResetAt: quota.earliestResetAt,
                quotaExhausted: quota.exhausted,
                quotaObservedAt: quota.observedAt,
              }),
        })),
    });
  }
  if (dependencies.subscriptionAccounts && dependencies.subscriptionQuota) {
    registry.register({
      operation: "subscription.quota",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["accountId"]),
      handle: async (context, value) =>
        (
          await subscriptionAccountRows(
            context,
            dependencies,
            value.accountId === undefined ? undefined : text(value.accountId, "accountId"),
          )
        ).flatMap(({ quota }) => (quota === undefined ? [] : [quota])),
    });
  }
  if (dependencies.subscriptionPolicy) {
    registry.register({
      operation: "subscription.policy",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["providerId"]),
      handle: async (context, value) =>
        (
          await dependencies.subscriptionPolicy?.list(
            context,
            value.providerId === undefined ? undefined : text(value.providerId, "providerId"),
          )
        )?.map(publicSubscriptionPolicy) ?? [],
    });
  }
  if (dependencies.subscriptionAccounts && dependencies.subscriptionConnectors && dependencies.subscriptionQuota) {
    registry.register({
      operation: "subscription.doctor",
      requiredScopes: ["subscription:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["accountId"]),
      handle: async (context, value) =>
        (
          await subscriptionAccountRows(
            context,
            dependencies,
            value.accountId === undefined ? undefined : text(value.accountId, "accountId"),
          )
        ).map(({ account, connector, quota }) => {
          const action =
            account.status === "needs-reauth"
              ? "reauth"
              : connector?.status !== "ready"
                ? "reconnect"
                : quota?.exhausted || account.status === "cooldown"
                  ? "wait-for-reset"
                  : account.status === "active"
                    ? "none"
                    : "inspect";
          return {
            accountId: account.account_id,
            providerId: account.provider_id,
            alias: account.alias,
            accountStatus: account.status,
            connectorId: account.connector_id,
            connectorLocation: connector?.location,
            connectorStatus: connector?.status ?? "unavailable",
            quotaStatus: quota === undefined ? "unknown" : quota.exhausted ? "exhausted" : "available",
            ...(quota?.earliestResetAt === undefined ? {} : { earliestResetAt: quota.earliestResetAt }),
            action,
          };
        }),
    });
  }
  if (dependencies.optimization) {
    registry.register({
      operation: "optimization.policy",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => {
        const policy = await dependencies.optimization?.evaluations.getActivePolicy(context);
        return policy === undefined ? [] : [policy];
      },
    });
    registry.register({
      operation: "optimization.receipts",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = value.roleKey === undefined ? undefined : text(value.roleKey, "roleKey");
        if (roleKey !== undefined && !isOptimizationRoleKey(roleKey))
          throw new Error("지원하지 않는 최적화 roleKey입니다");
        return await dependencies.optimization?.evaluations.listReceipts(context, roleKey);
      },
    });
    registry.register({
      operation: "optimization.batch.active",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = text(value.roleKey, "roleKey");
        if (!isOptimizationRoleKey(roleKey)) throw new Error("지원하지 않는 최적화 roleKey입니다");
        const active = await dependencies.optimization?.batches.getActiveBatch(context, roleKey);
        return active === undefined ? [] : [active];
      },
    });
  }
  if (dependencies.status) {
    registry.register({
      operation: "system.status",
      requiredScopes: ["system:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await dependencies.status?.(context),
    });
  }
}
