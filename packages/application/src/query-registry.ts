import type { ExtensionGateway } from "@massion/extension-host";
import type { GrowthGateway } from "@massion/growth";
import type { MembershipRole, TenantContext } from "@massion/identity";
import type { ModelRouter, ProviderService } from "@massion/router";
import type { RuntimeExecutionStore } from "@massion/runtime";

import { ApplicationError } from "./errors.js";
import type { ApplicationReadModel } from "./read-model.js";
import type { CollaborationGraphSnapshotProjector } from "./snapshot.js";

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
  readonly runtime?: Pick<RuntimeExecutionStore, "listEvents" | "getRecovery">;
  readonly extension?: Pick<ExtensionGateway, "list">;
  readonly growth?: Pick<
    GrowthGateway,
    "resolveConfiguration" | "getActiveEvaluationStrategy" | "listSuggestions" | "listEffectEvaluations"
  >;
  readonly providers?: Pick<ProviderService, "listCredentials">;
  readonly router?: Pick<ModelRouter, "listRoutes">;
  readonly status?: () => Promise<unknown>;
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

const EVERY_ROLE: readonly MembershipRole[] = ["owner", "admin", "member"];

function publicWork(value: Awaited<ReturnType<ApplicationReadModel["works"]>>[number]) {
  return {
    workId: value.workId,
    status: value.status,
    revision: value.revision,
    artifactIds: value.artifactIds,
  };
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
  if (dependencies.status) {
    registry.register({
      operation: "system.status",
      requiredScopes: ["system:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async () => await dependencies.status?.(),
    });
  }
}
