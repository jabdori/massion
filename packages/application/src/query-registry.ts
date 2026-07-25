import { createHash } from "node:crypto";

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
import type { WorkspaceService, WorkspaceView } from "@massion/workspace";

import { projectWorkTimeline, type WorkTimelineSources } from "./timeline.js";

import { ApplicationError } from "./errors.js";
import { ApplicationEventCursorExpiredError, type ApplicationEventStore } from "./event-store.js";
import type {
  ApplicationApprovalSource,
  ApplicationArtifactSource,
  ApplicationDirectiveSource,
  ApplicationExecutionSource,
  ApplicationReadModel,
  ApplicationVerificationSource,
} from "./read-model.js";
import type { ApplicationRunStore, ApplicationRunView } from "./run-store.js";
import type { CollaborationGraphSnapshot, CollaborationGraphSnapshotProjector } from "./snapshot.js";
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
import type { WorkKnowledgeViewV1 } from "./contracts.js";

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
  readonly runs?: Pick<ApplicationRunStore, "get"> & {
    listByWork?(context: TenantContext, workId: string): Promise<readonly ApplicationRunView[]>;
  };
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
  readonly workspaces?: Pick<WorkspaceService, "list" | "get">;
  readonly workTimeline?: WorkTimelineSources;
  readonly workKnowledge?: {
    get(context: TenantContext, workId: string): Promise<WorkKnowledgeViewV1>;
  };
  readonly autonomy?: { get(context: TenantContext): Promise<{ readonly mode: string; readonly revision: number }> };
  readonly provenance?: {
    listByWork(
      context: TenantContext,
      workId: string,
    ): Promise<
      readonly {
        readonly deliveryId: string;
        readonly taskId: string;
        readonly agentHandle: string;
        readonly status: string;
        readonly branchRef?: string;
        readonly commitSha?: string;
        readonly createdAt: unknown;
      }[]
    >;
  };
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
    readonly evaluations: Pick<ModelOptimizationStore, "getActivePolicy" | "listReceipts" | "listRecommendations">;
    readonly batches: Pick<OptimizationBatchService, "getActiveBatch" | "listObservations">;
  };
}

function publicRun(run: ApplicationRunView): Record<string, unknown> {
  return {
    runId: run.runId,
    ...(run.workId === undefined ? {} : { workId: run.workId }),
    stage: run.stage,
    status: run.status,
    ...(run.approvalId === undefined ? {} : { approvalId: run.approvalId }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
    leaseGeneration: run.leaseGeneration,
    ...(run.createdAt === undefined ? {} : { createdAt: run.createdAt }),
    ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }),
  };
}

function publicWorkKnowledge(view: WorkKnowledgeViewV1): WorkKnowledgeViewV1 {
  return {
    workId: view.workId,
    status: view.status,
    ...(view.repositoryId === undefined ? {} : { repositoryId: view.repositoryId }),
    ...(view.repositoryRevisionId === undefined ? {} : { repositoryRevisionId: view.repositoryRevisionId }),
    ...(view.indexVersionId === undefined ? {} : { indexVersionId: view.indexVersionId }),
    ...(view.evidenceBriefId === undefined ? {} : { evidenceBriefId: view.evidenceBriefId }),
    ...(view.freshnessStatus === undefined ? {} : { freshnessStatus: view.freshnessStatus }),
    ...(view.query === undefined ? {} : { query: view.query }),
    references: view.references.map((reference) => ({
      referenceId: reference.referenceId,
      kind: reference.kind,
      relativePath: reference.relativePath,
      ...(reference.qualifiedName === undefined ? {} : { qualifiedName: reference.qualifiedName }),
      startLine: reference.startLine,
      endLine: reference.endLine,
      contentHash: reference.contentHash,
    })),
    ...(view.failureReason === undefined ? {} : { failureReason: view.failureReason }),
  };
}

function organizationGraphSnapshotView(snapshot: CollaborationGraphSnapshot) {
  return {
    version: { version: snapshot.organization.version },
    nodes: snapshot.nodes.map((node) => ({
      node_id: node.nodeId,
      handle: node.handle,
      name: node.name,
      responsibility: node.responsibility,
      ...(node.parentHandle === undefined ? {} : { parent_handle: node.parentHandle }),
      status: node.status,
      role: node.role,
      capabilities: node.capabilities,
      scope: node.scope,
      ...(node.workId === undefined ? {} : { work_id: node.workId }),
    })),
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

const OPTIMIZATION_POLICY_FIELDS = [
  "policyVersionId",
  "organizationId",
  "version",
  "policy",
  "autoOptimize",
  "productionLearning",
  "shadowEnabled",
  "minimumSampleCount",
  "improvementThreshold",
  "observationBudgetMicros",
  "observationRetentionDays",
  "status",
  "checksum",
] as const;
const OPTIMIZATION_RECEIPT_FIELDS = [
  "receiptId",
  "runId",
  "organizationId",
  "roleKey",
  "modelProfileId",
  "bundleVersion",
  "sampleCount",
  "qualityScore",
  "latencyMs",
  "costMicros",
  "privacyAllowed",
  "completed",
  "inputChecksum",
  "receiptChecksum",
] as const;
const OPTIMIZATION_RECOMMENDATION_FIELDS = [
  "recommendationId",
  "organizationId",
  "roleKey",
  "policyVersionId",
  "primaryModelProfileId",
  "fallbackModelProfileIds",
  "excludedJson",
  "receiptIds",
  "status",
  "checksum",
] as const;
const OPTIMIZATION_OBSERVATION_FIELDS = [
  "observationId",
  "organizationId",
  "batchId",
  "sampleCount",
  "qualityScore",
  "latencyMs",
  "costMicros",
  "status",
  "source",
  "policyVersionId",
  "expiresAt",
  "checksum",
] as const;
const OPTIMIZATION_BATCH_FIELDS = [
  "batchId",
  "organizationId",
  "roleKey",
  "version",
  "recommendationId",
  "policyVersionId",
  "status",
  "primaryModelProfileId",
  "fallbackModelProfileIds",
  "parentBatchId",
  "checksum",
] as const;

function projectOptimizationRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

function projectOptimizationList(value: readonly unknown[] | undefined, fields: readonly string[]): readonly unknown[] {
  return (value ?? []).map((item) => projectOptimizationRecord(item, fields));
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("after가 유효하지 않습니다");
  return value as number;
}

function pageCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) throw new Error("cursor가 유효하지 않습니다");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("cursor가 유효하지 않습니다");
  return parsed;
}

function pageLimit(value: unknown, fallback: number): number {
  const limit = boundedInteger(value, "limit", fallback);
  if (limit > 100) throw new Error("limit가 유효하지 않습니다");
  return limit;
}

function page<T>(items: readonly T[], offset: number, limit: number) {
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    ...(offset + selected.length < items.length ? { nextCursor: String(offset + selected.length) } : {}),
  };
}

function searchText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) throw new Error("search가 유효하지 않습니다");
  return value.trim().toLocaleLowerCase();
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
    title: value.title ?? value.workId,
    status: value.status,
    revision: value.revision,
    artifactIds: value.artifactIds,
    artifactVersionIds: value.artifactIds,
    ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

function publicExecution(execution: ApplicationExecutionSource) {
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
    ...(execution.createdAt === undefined ? {} : { createdAt: execution.createdAt }),
    ...(execution.updatedAt === undefined ? {} : { updatedAt: execution.updatedAt }),
  };
}

function publicApproval(approval: ApplicationApprovalSource) {
  return {
    approvalId: approval.approvalId,
    action: approval.action,
    status: approval.status,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    ...(approval.workId === undefined ? {} : { workId: approval.workId }),
    ...(approval.executionId === undefined ? {} : { executionId: approval.executionId }),
    ...(approval.revision === undefined ? {} : { revision: approval.revision }),
    ...(approval.resourceRevision === undefined ? {} : { resourceRevision: approval.resourceRevision }),
    ...(approval.resumeTarget === undefined ? {} : { resumeTarget: approval.resumeTarget }),
    ...(approval.createdAt === undefined ? {} : { createdAt: approval.createdAt }),
    ...(approval.updatedAt === undefined ? {} : { updatedAt: approval.updatedAt }),
    ...(approval.displayPreview === undefined ? {} : { displayPreview: approval.displayPreview }),
  };
}

function publicArtifact(artifact: ApplicationArtifactSource) {
  return {
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    workId: artifact.workId,
    name: artifact.name,
    kind: artifact.kind,
    version: artifact.version,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    createdBy: artifact.createdBy,
    createdAt: artifact.createdAt,
    ...(artifact.sourceArtifactVersionId === undefined
      ? {}
      : { sourceArtifactVersionId: artifact.sourceArtifactVersionId }),
    ...(artifact.creatorAgentHandle === undefined ? {} : { creatorAgentHandle: artifact.creatorAgentHandle }),
    ...(artifact.creatorExecutionId === undefined ? {} : { creatorExecutionId: artifact.creatorExecutionId }),
  };
}

function publicVerification(verification: ApplicationVerificationSource) {
  return {
    verificationId: verification.verificationId,
    workId: verification.workId,
    verifierId: verification.verifierId,
    passed: verification.passed,
    criteria: verification.criteria,
    evidenceArtifactVersionIds: verification.evidenceArtifactVersionIds,
    ...(verification.assuranceRunId === undefined ? {} : { assuranceRunId: verification.assuranceRunId }),
    ...(verification.targetWorkRevision === undefined ? {} : { targetWorkRevision: verification.targetWorkRevision }),
    ...(verification.projectedWorkRevision === undefined
      ? {}
      : { projectedWorkRevision: verification.projectedWorkRevision }),
    ...(verification.profileId === undefined ? {} : { profileId: verification.profileId }),
    ...(verification.profileVersion === undefined ? {} : { profileVersion: verification.profileVersion }),
    ...(verification.bindingVersionId === undefined ? {} : { bindingVersionId: verification.bindingVersionId }),
    createdAt: verification.createdAt,
  };
}

function publicDirective(directive: ApplicationDirectiveSource) {
  return {
    directiveId: directive.directiveId,
    workId: directive.workId,
    runId: directive.runId,
    sequence: directive.sequence,
    content: directive.content,
    mode: directive.mode,
    submittedStage: directive.submittedStage,
    status: directive.status,
    createdAt: directive.createdAt,
    updatedAt: directive.updatedAt,
    ...(directive.failureReason === undefined ? {} : { failureReason: directive.failureReason }),
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

function subscriptionProfileHandle(organizationId: string, accountId: string): string {
  const segment = (value: string): string => createHash("sha256").update(value.trim()).digest("hex");
  return `${segment(organizationId)}/${segment(accountId)}`;
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
      handle: async (context, value) => {
        try {
          return await dependencies.audit?.read(context, {
            after: cursor(value.after),
            limit: boundedInteger(value.limit, "limit", 100),
          });
        } catch (cause) {
          if (cause instanceof ApplicationEventCursorExpiredError) {
            throw new ApplicationError({
              category: "conflict",
              severity: "warning",
              retryable: true,
              userMessage: "감사 사건 보존 범위가 지나 snapshot 재동기화가 필요합니다",
              operatorCode: "APP_EVENT_CURSOR_EXPIRED",
              cause,
            });
          }
          throw cause;
        }
      },
    });
  }
  if (dependencies.runs) {
    const runs = dependencies.runs;
    registry.register({
      operation: "run.get",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["runId"]),
      handle: async (context, value) => publicRun(await runs.get(context, text(value.runId, "runId"))),
    });
    if (runs.listByWork) {
      registry.register({
        operation: "run.list",
        requiredScopes: ["work:read"],
        allowedRoles: EVERY_ROLE,
        validate: (value) => object(value, ["workId"]),
        handle: async (context, value) =>
          (await runs.listByWork?.(context, text(value.workId, "workId")))?.map(publicRun) ?? [],
      });
    }
  }
  if (dependencies.workspaces) {
    const workspaces = dependencies.workspaces;
    const publicWorkspace = (workspace: WorkspaceView) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      path: workspace.path,
      kind: workspace.kind,
      trust: workspace.trust,
      status: workspace.status,
      revision: workspace.revision,
      createdAt: workspace.createdAt,
      lastUsedAt: workspace.lastUsedAt,
    });
    registry.register({
      operation: "workspace.list",
      requiredScopes: ["workspace:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => (await workspaces.list(context)).map(publicWorkspace),
    });
    registry.register({
      operation: "workspace.get",
      requiredScopes: ["workspace:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workspaceId"]),
      handle: async (context, value) =>
        publicWorkspace(await workspaces.get(context, text(value.workspaceId, "workspaceId"))),
    });
  }
  if (dependencies.workTimeline) {
    const timelineSources = dependencies.workTimeline;
    registry.register({
      operation: "work.timeline",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "limit"]),
      handle: async (context, value) => {
        const limit =
          value.limit === undefined
            ? undefined
            : Number.isSafeInteger(value.limit) && Number(value.limit) >= 1
              ? Number(value.limit)
              : (() => {
                  throw new Error("timeline limit이 유효하지 않습니다");
                })();
        return await projectWorkTimeline(timelineSources, context, text(value.workId, "workId"), {
          ...(limit === undefined ? {} : { limit }),
        });
      },
    });
    registry.register({
      operation: "work.activity.list",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId", "cursor", "limit"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const cells = await projectWorkTimeline(timelineSources, context, workId, { limit: 2_000 });
        const activities = [...cells].reverse().map((cell) => ({
          activityId: cell.cellId,
          workId,
          kind:
            cell.kind === "user-message" || cell.kind === "agent-message"
              ? "message"
              : cell.kind === "task"
                ? "task"
                : cell.kind === "artifact"
                  ? "artifact"
                  : cell.kind === "verification"
                    ? "verification"
                    : cell.kind === "record"
                      ? "record"
                      : "work",
          title: cell.title,
          createdAt: cell.createdAt,
          ...(cell.detail === undefined ? {} : { detail: cell.detail }),
          ...(cell.authorId === undefined ? {} : { authorId: cell.authorId }),
          resourceId: cell.cellId,
        }));
        return page(activities, pageCursor(value.cursor), pageLimit(value.limit, 100));
      },
    });
  }
  if (dependencies.autonomy) {
    const autonomy = dependencies.autonomy;
    registry.register({
      operation: "governance.autonomy",
      requiredScopes: ["governance:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => await autonomy.get(context),
    });
  }
  if (dependencies.provenance) {
    const provenance = dependencies.provenance;
    registry.register({
      operation: "work.provenance",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) =>
        (await provenance.listByWork(context, text(value.workId, "workId"))).map((delivery) => ({
          deliveryId: delivery.deliveryId,
          taskId: delivery.taskId,
          agentHandle: delivery.agentHandle,
          status: delivery.status,
          ...(delivery.branchRef === undefined ? {} : { branchRef: delivery.branchRef }),
          ...(delivery.commitSha === undefined ? {} : { commitSha: delivery.commitSha }),
          createdAt: delivery.createdAt,
        })),
    });
  }
  registry.register({
    operation: "work.list",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workspaceId"]),
    handle: async (context, value) => {
      const works = (await dependencies.readModel.works(context)).map(publicWork);
      if (value.workspaceId === undefined) return works;
      const workspaceId = text(value.workspaceId, "workspaceId");
      return works.filter((work) => work.workspaceId === workspaceId);
    },
  });
  registry.register({
    operation: "work.index",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workspaceId", "status", "search", "cursor", "limit"]),
    handle: async (context, value) => {
      const workspaceId = value.workspaceId === undefined ? undefined : text(value.workspaceId, "workspaceId");
      const status = value.status === undefined ? undefined : text(value.status, "status");
      const search = searchText(value.search);
      const works = (await dependencies.readModel.works(context))
        .filter((work) => workspaceId === undefined || work.workspaceId === workspaceId)
        .filter((work) => status === undefined || work.status === status)
        .filter((work) => {
          if (!search) return true;
          return `${work.title ?? ""}\n${work.workId}`.toLocaleLowerCase().includes(search);
        })
        .sort((left, right) => {
          const leftTime = left.updatedAt ?? "";
          const rightTime = right.updatedAt ?? "";
          if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
          return left.workId.localeCompare(right.workId);
        })
        .map(publicWork);
      return page(works, pageCursor(value.cursor), pageLimit(value.limit, 50));
    },
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
    operation: "work.detail",
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
          ...(task.objective === undefined ? {} : { objective: task.objective }),
          ...(task.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: task.acceptanceCriteria }),
          ...(task.dependencyIds === undefined ? {} : { dependencyIds: task.dependencyIds }),
          ...(task.requiredCapabilities === undefined ? {} : { requiredCapabilities: task.requiredCapabilities }),
          ...(task.recommendedAgentHandles === undefined
            ? {}
            : { recommendedAgentHandles: task.recommendedAgentHandles }),
          ...(task.parallelizable === undefined ? {} : { parallelizable: task.parallelizable }),
          ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
          ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
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
          ...(assignment.assignmentId === undefined ? {} : { assignmentId: assignment.assignmentId }),
          ...(assignment.createdAt === undefined ? {} : { createdAt: assignment.createdAt }),
          ...(assignment.updatedAt === undefined ? {} : { updatedAt: assignment.updatedAt }),
        })),
  });
  registry.register({
    operation: "work.executions",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      (await dependencies.readModel.executions(context))
        .filter((execution) => execution.workId === text(value.workId, "workId"))
        .map(publicExecution),
  });
  registry.register({
    operation: "work.artifacts",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      ((await dependencies.readModel.artifacts?.(context)) ?? [])
        .filter((artifact) => artifact.workId === text(value.workId, "workId"))
        .map(publicArtifact),
  });
  registry.register({
    operation: "work.artifact.get",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "artifactVersionId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const artifactVersionId = text(value.artifactVersionId, "artifactVersionId");
      const artifact = ((await dependencies.readModel.artifacts?.(context)) ?? []).find(
        (candidate) => candidate.workId === workId && candidate.artifactVersionId === artifactVersionId,
      );
      if (!artifact)
        throw new ApplicationError({
          category: "not-found",
          severity: "error",
          retryable: false,
          userMessage: "Artifact를 찾을 수 없습니다",
          operatorCode: "APP_ARTIFACT_NOT_FOUND",
        });
      return publicArtifact(artifact);
    },
  });
  registry.register({
    operation: "work.verifications",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) =>
      ((await dependencies.readModel.verifications?.(context)) ?? [])
        .filter((verification) => verification.workId === text(value.workId, "workId"))
        .map(publicVerification),
  });
  registry.register({
    operation: "work.directive.list",
    requiredScopes: ["work:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "runId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const runId = value.runId === undefined ? undefined : text(value.runId, "runId");
      return ((await dependencies.readModel.directives?.(context)) ?? [])
        .filter((directive) => directive.workId === workId && (runId === undefined || directive.runId === runId))
        .map(publicDirective);
    },
  });
  registry.register({
    operation: "work.rooms",
    requiredScopes: ["collaboration:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId"]),
    handle: async (context, value) => {
      const workId = text(value.workId, "workId");
      const messages = (await dependencies.readModel.messages?.(context)) ?? [];
      return (await dependencies.readModel.rooms(context))
        .filter((room) => room.workId === workId)
        .map((room) => {
          // 소비량은 방에 저장돼 있지 않고 메시지의 합입니다.
          const roomMessages = messages.filter((message) => message.roomId === room.roomId);
          const usedTokens = roomMessages.reduce((sum, message) => sum + (message.tokenCount ?? 0), 0);
          const usedCostMicros = roomMessages.reduce((sum, message) => sum + (message.costMicros ?? 0), 0);
          return {
            workId: room.workId,
            roomId: room.roomId,
            name: room.name,
            kind: room.kind,
            status: room.status,
            participantIds: room.participantIds,
            lastMessageSequence: room.lastMessageSequence,
            ...(room.coordinatorHandle === undefined ? {} : { coordinatorHandle: room.coordinatorHandle }),
            ...(room.roundCount === undefined ? {} : { roundCount: room.roundCount }),
            ...(room.maxRounds === undefined ? {} : { maxRounds: room.maxRounds }),
            ...(room.maxTokens === undefined ? {} : { usedTokens, maxTokens: room.maxTokens }),
            ...(room.maxCostMicros === undefined ? {} : { usedCostMicros, maxCostMicros: room.maxCostMicros }),
          };
        });
    },
  });
  if (dependencies.readModel.sharedContexts) {
    registry.register({
      operation: "work.shared-contexts",
      requiredScopes: ["collaboration:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        return ((await dependencies.readModel.sharedContexts?.(context)) ?? [])
          .filter((reference) => reference.workId === workId)
          .map((reference) => ({
            sharedContextReferenceId: reference.sharedContextReferenceId,
            roomId: reference.roomId,
            sourceKind: reference.sourceKind,
            sourceId: reference.sourceId,
            versionId: reference.versionId,
            checksum: reference.checksum,
          }));
      },
    });
  }
  const workKnowledge = dependencies.workKnowledge;
  if (workKnowledge) {
    registry.register({
      operation: "work.knowledge",
      requiredScopes: ["work:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["workId"]),
      handle: async (context, value) => {
        const workId = text(value.workId, "workId");
        const view = await workKnowledge.get(context, workId);
        if (view.workId !== workId) throw new Error("Work knowledge와 요청한 Work가 일치하지 않습니다");
        return publicWorkKnowledge(view);
      },
    });
  }
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
            // 인과 계보. 반론이 무엇을 반박하는지, 답변이 어느 질문에 붙는지가 여기서 옵니다.
            ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
            ...(message.causedByMessageId === undefined ? {} : { causedByMessageId: message.causedByMessageId }),
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
      return publicExecution(execution);
    },
  });
  registry.register({
    operation: "governance.approval.list",
    requiredScopes: ["approval:read"],
    allowedRoles: EVERY_ROLE,
    validate: (value) => object(value, ["workId", "status"]),
    handle: async (context, value) => {
      const workId = value.workId === undefined ? undefined : text(value.workId, "workId");
      const status = value.status === undefined ? undefined : text(value.status, "status");
      return (await dependencies.readModel.approvals(context))
        .filter((approval) => workId === undefined || approval.workId === workId)
        .filter((approval) => status === undefined || approval.status === status)
        .map(publicApproval);
    },
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
      return publicApproval(approval);
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
  const snapshot = dependencies.snapshot;
  if (snapshot) {
    registry.register({
      operation: "organization.graph.snapshot",
      requiredScopes: ["organization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, []),
      handle: async (context) => organizationGraphSnapshotView(await snapshot.project(context)),
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
          ...(connector?.location === "server"
            ? { profileHandle: subscriptionProfileHandle(context.organizationId, account.account_id) }
            : {}),
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
        return policy === undefined ? [] : [projectOptimizationRecord(policy, OPTIMIZATION_POLICY_FIELDS)];
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
        return projectOptimizationList(
          await dependencies.optimization?.evaluations.listReceipts(context, roleKey),
          OPTIMIZATION_RECEIPT_FIELDS,
        );
      },
    });
    registry.register({
      operation: "optimization.recommendations",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["roleKey"]),
      handle: async (context, value) => {
        const roleKey = value.roleKey === undefined ? undefined : text(value.roleKey, "roleKey");
        if (roleKey !== undefined && !isOptimizationRoleKey(roleKey))
          throw new Error("지원하지 않는 최적화 roleKey입니다");
        return projectOptimizationList(
          await dependencies.optimization?.evaluations.listRecommendations(context, roleKey),
          OPTIMIZATION_RECOMMENDATION_FIELDS,
        );
      },
    });
    registry.register({
      operation: "optimization.observations",
      requiredScopes: ["optimization:read"],
      allowedRoles: EVERY_ROLE,
      validate: (value) => object(value, ["batchId"]),
      handle: async (context, value) => {
        const batchId = value.batchId === undefined ? undefined : text(value.batchId, "batchId");
        return projectOptimizationList(
          await dependencies.optimization?.batches.listObservations(context, batchId),
          OPTIMIZATION_OBSERVATION_FIELDS,
        );
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
        return active === undefined ? [] : [projectOptimizationRecord(active, OPTIMIZATION_BATCH_FIELDS)];
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
