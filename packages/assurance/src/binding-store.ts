import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  GOVERNANCE_DECISION_CONTEXT_MIGRATION,
  GOVERNANCE_DECISION_MIGRATION,
  type GovernanceGate,
} from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { WORK_ASSURANCE_LINK_MIGRATION } from "@massion/work";

import type { AssuranceCriterionMethod } from "./contracts.js";
import { checksumCriterionCoverage } from "./criteria.js";
import {
  ASSURANCE_BINDING_MIGRATION,
  ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
  ASSURANCE_RUN_MIGRATION,
} from "./schema.js";

interface BindingCommon {
  readonly bindingKey: string;
  readonly criterionKey: string;
  readonly executor:
    | { readonly kind: "runtime_agent"; readonly handle: string }
    | { readonly kind: "system_adapter"; readonly adapterId: string };
  readonly requiredEvidenceKinds: readonly string[];
}

export type AssuranceCheckBinding =
  | (BindingCommon & {
      readonly kind: "test";
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly expectedExitCode: number;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
    })
  | (BindingCommon & {
      readonly kind: "inspection";
      readonly inspectorProfile: string;
      readonly evidenceAllowlist: readonly string[];
      readonly maximumFindings: number;
    })
  | (BindingCommon & {
      readonly kind: "evidence";
      readonly evidenceKinds: readonly string[];
      readonly maximumAgeMs: number;
    })
  | (BindingCommon & {
      readonly kind: "metric";
      readonly sourceKind: "artifact_version" | "runtime_execution";
      readonly operator: ">" | ">=" | "=" | "<=" | "<";
      readonly threshold: number;
      readonly unit: string;
      readonly maxAgeMs: number;
    })
  | (BindingCommon & {
      readonly kind: "human";
      readonly eligibleRoles: readonly string[];
      readonly minimumAttestations: number;
    });

export interface RequiredBindingCriterion {
  readonly criterionKey: string;
  readonly method: AssuranceCriterionMethod;
}

export interface ProposeAssuranceBindingInput {
  readonly commandId: string;
  readonly workId: string;
  readonly planVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly authorHandle: string;
  readonly requiredCriteria: readonly RequiredBindingCriterion[];
  readonly bindings: readonly AssuranceCheckBinding[];
}

export interface ActivateAssuranceBindingInput {
  readonly commandId: string;
  readonly bindingVersionId: string;
  readonly expectedRevision: number;
  readonly approvalId?: string;
}

export interface BindingActivationAuthorization {
  readonly decisionId: string;
  readonly approvalId?: string;
}

export interface BindingActivationAuthorizer {
  authorize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly bindingVersionId: string;
      readonly workId: string;
      readonly revision: number;
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<BindingActivationAuthorization>;
}

export class GovernanceBindingActivationAuthorizer implements BindingActivationAuthorizer {
  public constructor(
    private readonly gate: GovernanceGate,
    private readonly options: {
      readonly environment?: string;
      readonly external?: boolean;
      readonly dataClassification?: string;
    } = {},
  ) {}

  public async authorize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly bindingVersionId: string;
      readonly workId: string;
      readonly revision: number;
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<BindingActivationAuthorization> {
    const authorization = await this.gate.authorize(
      context,
      {
        commandId: input.commandId,
        action: "work.execute",
        resource: {
          type: "AssuranceBindingVersion",
          id: input.bindingVersionId,
          revision: input.revision,
          dataClassification: this.options.dataClassification ?? "internal",
        },
        environment: this.options.environment ?? "local",
        riskClass: "assurance-binding-activation",
        external: this.options.external ?? false,
        executionId: `assurance-binding:${input.bindingVersionId}:${input.commandId}`,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      executor,
    );
    return {
      decisionId: authorization.decision.decisionId,
      ...(authorization.permit ? { approvalId: authorization.permit.approval_id } : {}),
    };
  }
}

export interface AssuranceBindingVersion {
  readonly bindingVersionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly planVersionId: string;
  readonly version: number;
  readonly revision: number;
  readonly status: "draft" | "active" | "superseded";
  readonly profileId: string;
  readonly profileVersion: string;
  readonly bindings: readonly AssuranceCheckBinding[];
  readonly criteriaChecksum: string;
  readonly checksum: string;
  readonly authorHandle: string;
  readonly createdByUserId: string;
  readonly governanceDecisionId?: string;
  readonly governanceApprovalId?: string;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly supersededAt?: string;
}

interface BindingRecord {
  readonly binding_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly plan_version_id: string;
  readonly version: number;
  readonly revision: number;
  readonly status: AssuranceBindingVersion["status"];
  readonly profile_id: string;
  readonly profile_version: string;
  readonly bindings_json: string;
  readonly criteria_checksum: string;
  readonly checksum: string;
  readonly author_handle: string;
  readonly created_by_user_id: string;
  readonly governance_decision_id?: string;
  readonly governance_approval_id?: string;
  readonly created_at: unknown;
  readonly activated_at?: unknown;
  readonly superseded_at?: unknown;
}

interface BindingEventRecord {
  readonly binding_version_id: string;
  readonly request_hash: string;
}

interface BindingProjectionSource {
  readonly binding_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly bindings_json: string;
}

const ALLOWED_EXECUTABLES = new Set(["git", "node", "npm", "npx", "pnpm"]);
const BINDING_KINDS = new Set<AssuranceCriterionMethod>(["test", "inspection", "evidence", "metric", "human"]);
const EXECUTOR_KINDS = new Set(["runtime_agent", "system_adapter"]);
const METRIC_SOURCE_KINDS = new Set(["artifact_version", "runtime_execution"]);
const METRIC_OPERATORS = new Set([">", ">=", "=", "<=", "<"]);
const MEMBERSHIP_ROLES = new Set(["owner", "admin", "member"]);

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoDateTime(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw) throw new Error("Assurance binding datetime을 직렬화할 수 없습니다");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("Assurance binding datetime이 올바르지 않습니다");
  return date.toISOString();
}

function text(value: string, label: string, maximum = 200): void {
  if (!value.trim()) throw new Error(`${label}이 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
}

function stringList(values: readonly string[], label: string, maximum: number, maximumLength = 500): void {
  if (values.length > maximum) throw new Error(`${label}은 ${String(maximum)}개 이하여야 합니다`);
  for (const value of values) text(value, label, maximumLength);
}

function validateExecutor(executor: AssuranceCheckBinding["executor"]): void {
  if (!EXECUTOR_KINDS.has(executor.kind)) throw new Error(`지원하지 않는 executor kind입니다: ${executor.kind}`);
  if (executor.kind === "runtime_agent") text(executor.handle, "Binding executor handle");
  else text(executor.adapterId, "Binding system adapter ID");
}

function validateBinding(binding: AssuranceCheckBinding): void {
  if (!BINDING_KINDS.has(binding.kind)) throw new Error(`지원하지 않는 binding kind입니다: ${binding.kind}`);
  text(binding.bindingKey, "Binding key", 100);
  text(binding.criterionKey, "Criterion key", 100);
  validateExecutor(binding.executor);
  stringList(binding.requiredEvidenceKinds, "Required evidence kind", 20, 200);
  if (binding.kind === "test") {
    if (!ALLOWED_EXECUTABLES.has(binding.executable))
      throw new Error(`허용 executable이 아닙니다: ${binding.executable}`);
    stringList(binding.args, "Command argument", 50);
    text(binding.cwd, "Command cwd", 500);
    if (isAbsolute(binding.cwd) || binding.cwd.split(/[\\/]/u).includes(".."))
      throw new Error("Command cwd는 상대 경로여야 합니다");
    if (!Number.isSafeInteger(binding.expectedExitCode)) throw new Error("Expected exit code는 정수여야 합니다");
    if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs < 1_000 || binding.timeoutMs > 3_600_000)
      throw new Error("Command timeout은 1초 이상 1시간 이하여야 합니다");
    if (
      !Number.isSafeInteger(binding.maxOutputBytes) ||
      binding.maxOutputBytes < 1 ||
      binding.maxOutputBytes > 10_000_000
    )
      throw new Error("Command output limit은 1~10000000 byte여야 합니다");
  } else if (binding.kind === "inspection") {
    text(binding.inspectorProfile, "Inspector profile");
    stringList(binding.evidenceAllowlist, "Inspection evidence allowlist", 100);
    if (
      !Number.isSafeInteger(binding.maximumFindings) ||
      binding.maximumFindings < 1 ||
      binding.maximumFindings > 1_000
    )
      throw new Error("Inspection finding 상한은 1~1000이어야 합니다");
  } else if (binding.kind === "evidence") {
    stringList(binding.evidenceKinds, "Evidence kind", 20);
    if (binding.evidenceKinds.length === 0) throw new Error("Evidence binding에는 evidence kind가 필요합니다");
    if (!Number.isSafeInteger(binding.maximumAgeMs) || binding.maximumAgeMs < 0)
      throw new Error("Evidence freshness가 올바르지 않습니다");
  } else if (binding.kind === "metric") {
    if (!METRIC_SOURCE_KINDS.has(binding.sourceKind)) throw new Error("Metric source kind가 올바르지 않습니다");
    if (!METRIC_OPERATORS.has(binding.operator)) throw new Error("Metric operator가 올바르지 않습니다");
    if (!Number.isFinite(binding.threshold)) throw new Error("Metric threshold는 유한한 수여야 합니다");
    text(binding.unit, "Metric unit", 100);
    if (!Number.isSafeInteger(binding.maxAgeMs) || binding.maxAgeMs < 0)
      throw new Error("Metric freshness가 올바르지 않습니다");
  } else {
    stringList(binding.eligibleRoles, "Human eligible role", 20);
    if (binding.eligibleRoles.length === 0) throw new Error("Human binding에는 eligible role이 필요합니다");
    if (binding.eligibleRoles.some((role) => !MEMBERSHIP_ROLES.has(role)))
      throw new Error("Human eligible role이 Membership role이 아닙니다");
    if (
      !Number.isSafeInteger(binding.minimumAttestations) ||
      binding.minimumAttestations < 1 ||
      binding.minimumAttestations > 10
    )
      throw new Error("Human attestation 수는 1~10이어야 합니다");
  }
}

function method(binding: AssuranceCheckBinding): AssuranceCriterionMethod {
  return binding.kind;
}

function validateProposal(input: ProposeAssuranceBindingInput, allowedAuthors: ReadonlySet<string>): void {
  text(input.commandId, "Binding command ID");
  text(input.workId, "Work ID");
  text(input.planVersionId, "PlanVersion ID");
  text(input.profileId, "Profile ID");
  text(input.profileVersion, "Profile version");
  if (!allowedAuthors.has(input.authorHandle))
    throw new Error(`Assurance binding을 작성할 수 없는 handle입니다: ${input.authorHandle}`);
  if (input.requiredCriteria.length === 0 || input.requiredCriteria.length > 100)
    throw new Error("Required criterion은 1~100개여야 합니다");
  if (input.bindings.length === 0 || input.bindings.length > 100) throw new Error("Check binding은 1~100개여야 합니다");
  const required = new Map<string, AssuranceCriterionMethod>();
  for (const criterion of input.requiredCriteria) {
    text(criterion.criterionKey, "Required criterion key", 100);
    if (!BINDING_KINDS.has(criterion.method))
      throw new Error(`지원하지 않는 criterion method입니다: ${criterion.method}`);
    if (required.has(criterion.criterionKey))
      throw new Error(`Required criterion key가 중복됐습니다: ${criterion.criterionKey}`);
    required.set(criterion.criterionKey, criterion.method);
  }
  const keys = new Set<string>();
  const covered = new Set<string>();
  const evidenceByCriterion = new Map<string, Set<string>>();
  for (const binding of input.bindings) {
    validateBinding(binding);
    if (keys.has(binding.bindingKey)) throw new Error(`Binding key가 중복됐습니다: ${binding.bindingKey}`);
    keys.add(binding.bindingKey);
    const expected = required.get(binding.criterionKey);
    if (!expected || expected !== method(binding))
      throw new Error(`Criterion coverage method가 일치하지 않습니다: ${binding.criterionKey}`);
    covered.add(binding.criterionKey);
    const evidence = evidenceByCriterion.get(binding.criterionKey) ?? new Set<string>();
    for (const kind of binding.requiredEvidenceKinds) evidence.add(kind);
    evidenceByCriterion.set(binding.criterionKey, evidence);
  }
  const missing = [...required.keys()].filter((key) => !covered.has(key));
  if (missing.length) throw new Error(`Criterion coverage가 누락됐습니다: ${missing.join(",")}`);
  for (const [criterionKey, evidence] of evidenceByCriterion) {
    if (evidence.size > 20)
      throw new Error(`Criterion required evidence kind 합집합은 20개 이하여야 합니다: ${criterionKey}`);
  }
}

function guardKey(organizationId: string, workId: string, planVersionId: string): string {
  return sha256(canonicalJson({ organizationId, workId, planVersionId }));
}

export function assuranceBindingIdentityChecksum(binding: AssuranceCheckBinding): string {
  const executorId = binding.executor.kind === "system_adapter" ? binding.executor.adapterId : binding.executor.handle;
  return sha256([binding.bindingKey, binding.criterionKey, binding.kind, binding.executor.kind, executorId].join("|"));
}

async function projectBindingChecks(
  executor: QueryExecutor,
  source: Pick<BindingProjectionSource, "binding_version_id" | "organization_id" | "work_id">,
  bindings: readonly AssuranceCheckBinding[],
): Promise<void> {
  for (const binding of bindings) {
    const identityChecksum = assuranceBindingIdentityChecksum(binding);
    await executor.query(
      "CREATE assurance_binding_check_manifest CONTENT { binding_version_id: $binding_version_id, organization_id: $organization_id, work_id: $work_id, identity_checksum: $identity_checksum, created_at: time::now() };",
      {
        binding_version_id: source.binding_version_id,
        organization_id: source.organization_id,
        work_id: source.work_id,
        identity_checksum: identityChecksum,
      },
    );
    await executor.query(
      "CREATE assurance_binding_check CONTENT { binding_version_id: $binding_version_id, organization_id: $organization_id, work_id: $work_id, binding_key: $binding_key, criterion_key: $criterion_key, kind: $kind, executor_kind: $executor_kind, executor_id: $executor_id, source_kind: $source_kind, metric_operator: $metric_operator, metric_threshold: $metric_threshold, metric_unit: $metric_unit, metric_max_age_ms: $metric_max_age_ms, eligible_roles: $eligible_roles, minimum_attestations: $minimum_attestations, identity_checksum: $identity_checksum, created_at: time::now() };",
      {
        binding_version_id: source.binding_version_id,
        organization_id: source.organization_id,
        work_id: source.work_id,
        binding_key: binding.bindingKey,
        criterion_key: binding.criterionKey,
        kind: binding.kind,
        executor_kind: binding.executor.kind,
        executor_id: binding.executor.kind === "system_adapter" ? binding.executor.adapterId : binding.executor.handle,
        source_kind: binding.kind === "metric" ? binding.sourceKind : undefined,
        metric_operator: binding.kind === "metric" ? binding.operator : undefined,
        metric_threshold: binding.kind === "metric" ? binding.threshold : undefined,
        metric_unit: binding.kind === "metric" ? binding.unit : undefined,
        metric_max_age_ms: binding.kind === "metric" ? binding.maxAgeMs : undefined,
        eligible_roles: binding.kind === "human" ? binding.eligibleRoles : [],
        minimum_attestations: binding.kind === "human" ? binding.minimumAttestations : undefined,
        identity_checksum: identityChecksum,
      },
    );
  }
}

export async function backfillAssuranceBindingChecks(database: MassionDatabase): Promise<void> {
  await database.transaction(async (transaction) => {
    const [sources] = await transaction.query<[BindingProjectionSource[]]>(
      "SELECT binding_version_id, organization_id, work_id, bindings_json FROM assurance_binding_version;",
    );
    for (const source of sources) {
      const [existing] = await transaction.query<[{ binding_key: string }[]]>(
        "SELECT binding_key FROM assurance_binding_check WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
        { organization_id: source.organization_id, binding_version_id: source.binding_version_id },
      );
      if (existing.length > 0) continue;
      const decoded = JSON.parse(source.bindings_json) as unknown;
      if (!Array.isArray(decoded)) throw new Error("Assurance binding projection JSON이 배열이 아닙니다");
      const bindings = decoded as readonly AssuranceCheckBinding[];
      for (const binding of bindings) validateBinding(binding);
      await projectBindingChecks(transaction, source, bindings);
    }
  });
}

export class AssuranceBindingStore {
  private readonly allowedAuthors: ReadonlySet<string>;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly authorizer: BindingActivationAuthorizer,
    options: { readonly allowedAuthorHandles: readonly string[] },
  ) {
    this.allowedAuthors = new Set(options.allowedAuthorHandles);
  }

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    authorizer: BindingActivationAuthorizer,
    options: { readonly allowedAuthorHandles: readonly string[] },
  ): Promise<AssuranceBindingStore> {
    await applyMigrations(database, [
      GOVERNANCE_DECISION_MIGRATION,
      ASSURANCE_RUN_MIGRATION,
      GOVERNANCE_DECISION_CONTEXT_MIGRATION,
      ASSURANCE_BINDING_MIGRATION,
      WORK_ASSURANCE_LINK_MIGRATION,
      ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
    ]);
    await backfillAssuranceBindingChecks(database);
    return new AssuranceBindingStore(database, organizations, authorizer, options);
  }

  public async propose(context: TenantContext, input: ProposeAssuranceBindingInput): Promise<AssuranceBindingVersion> {
    await this.organizations.verifyTenantContext(context);
    validateProposal(input, this.allowedAuthors);
    const hash = sha256(canonicalJson({ operation: "propose", input }));
    const replayed = await this.replay(context.organizationId, input.commandId, hash);
    if (replayed) return await this.get(context, replayed.binding_version_id);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrent = await this.replay(context.organizationId, input.commandId, hash, transaction);
      if (concurrent)
        return this.view(await this.find(transaction, context.organizationId, concurrent.binding_version_id));
      const [versions] = await transaction.query<[{ version: number }[]]>(
        "SELECT version FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: input.workId },
      );
      const version = versions.reduce((maximum, candidate) => Math.max(maximum, candidate.version), 0) + 1;
      const bindingVersionId = randomUUID();
      const criteriaChecksum = checksumCriterionCoverage(input.requiredCriteria);
      const bindingsJson = canonicalJson([...input.bindings].sort((a, b) => a.bindingKey.localeCompare(b.bindingKey)));
      const checksum = sha256(
        canonicalJson({
          workId: input.workId,
          planVersionId: input.planVersionId,
          profileId: input.profileId,
          profileVersion: input.profileVersion,
          criteriaChecksum,
          bindingsJson,
        }),
      );
      const [records] = await transaction.query<[BindingRecord[]]>(
        "CREATE assurance_binding_version CONTENT { binding_version_id: $binding_version_id, organization_id: $organization_id, work_id: $work_id, plan_version_id: $plan_version_id, version: $version, revision: 1, status: 'draft', profile_id: $profile_id, profile_version: $profile_version, bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: $author_handle, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          binding_version_id: bindingVersionId,
          organization_id: context.organizationId,
          work_id: input.workId,
          plan_version_id: input.planVersionId,
          version,
          profile_id: input.profileId,
          profile_version: input.profileVersion,
          bindings_json: bindingsJson,
          criteria_checksum: criteriaChecksum,
          checksum,
          author_handle: input.authorHandle,
          created_by_user_id: context.userId,
        },
      );
      if (!records[0]) throw new Error("Assurance binding draft 생성 결과가 없습니다");
      await projectBindingChecks(
        transaction,
        {
          binding_version_id: bindingVersionId,
          organization_id: context.organizationId,
          work_id: input.workId,
        },
        input.bindings,
      );
      await this.event(transaction, context, bindingVersionId, input.commandId, 1, "assurance_binding_proposed", hash);
      return this.view(records[0]);
    });
  }

  public async activate(
    context: TenantContext,
    input: ActivateAssuranceBindingInput,
  ): Promise<AssuranceBindingVersion> {
    await this.organizations.verifyTenantContext(context);
    text(input.commandId, "Binding activation command ID");
    text(input.bindingVersionId, "BindingVersion ID");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new Error("Expected binding revision이 올바르지 않습니다");
    const hash = sha256(canonicalJson({ operation: "activate", input }));
    const replayed = await this.replay(context.organizationId, input.commandId, hash);
    if (replayed) return await this.get(context, replayed.binding_version_id);
    const current = await this.get(context, input.bindingVersionId);
    if (current.revision !== input.expectedRevision) throw new Error("Assurance binding revision 충돌입니다");
    if (current.status !== "draft") throw new Error("Draft Assurance binding만 활성화할 수 있습니다");
    if (current.version !== (await this.latestVersion(context.organizationId, current.workId))) {
      throw new Error("가장 최신 Assurance binding draft만 활성화할 수 있습니다");
    }
    const authorization = input.approvalId
      ? undefined
      : await this.authorizer.authorize(context, {
          commandId: input.commandId,
          bindingVersionId: current.bindingVersionId,
          workId: current.workId,
          revision: current.revision,
        });
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrent = await this.replay(context.organizationId, input.commandId, hash, transaction);
      if (concurrent)
        return this.view(await this.find(transaction, context.organizationId, concurrent.binding_version_id));
      const draft = await this.find(transaction, context.organizationId, input.bindingVersionId);
      if (draft.revision !== input.expectedRevision || draft.status !== "draft")
        throw new Error("Assurance binding activation precondition이 바뀌었습니다");
      const latestVersion = await this.latestVersion(context.organizationId, draft.work_id, transaction);
      if (draft.version !== latestVersion) {
        throw new Error(
          `가장 최신 Assurance binding draft만 활성화할 수 있습니다: ${String(draft.version)} != ${String(latestVersion)}`,
        );
      }
      const authorized =
        authorization ??
        (await this.authorizer.authorize(
          context,
          {
            commandId: input.commandId,
            bindingVersionId: current.bindingVersionId,
            workId: current.workId,
            revision: current.revision,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          },
          transaction,
        ));
      const [active] = await transaction.query<[BindingRecord[]]>(
        "SELECT * OMIT id FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND plan_version_id = $plan_version_id AND status = 'active' LIMIT 1;",
        { organization_id: context.organizationId, work_id: draft.work_id, plan_version_id: draft.plan_version_id },
      );
      if (active[0]) {
        await transaction.query(
          "UPDATE assurance_binding_version SET status = 'superseded', revision = $revision, active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
          {
            revision: active[0].revision + 1,
            organization_id: context.organizationId,
            binding_version_id: active[0].binding_version_id,
          },
        );
        await this.event(
          transaction,
          context,
          active[0].binding_version_id,
          `${input.commandId}:supersede`,
          active[0].revision + 1,
          "assurance_binding_superseded",
          sha256(canonicalJson({ operation: "supersede", replacement: draft.binding_version_id })),
        );
      }
      const [records] = await transaction.query<[BindingRecord[]]>(
        "UPDATE assurance_binding_version SET status = 'active', revision = $revision, active_guard_key = $active_guard_key, governance_decision_id = $governance_decision_id, governance_approval_id = $governance_approval_id, activated_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id RETURN AFTER;",
        {
          revision: draft.revision + 1,
          active_guard_key: guardKey(context.organizationId, draft.work_id, draft.plan_version_id),
          governance_decision_id: authorized.decisionId,
          governance_approval_id: authorized.approvalId,
          organization_id: context.organizationId,
          binding_version_id: draft.binding_version_id,
        },
      );
      if (!records[0]) throw new Error("Assurance binding 활성화 결과가 없습니다");
      await this.event(
        transaction,
        context,
        draft.binding_version_id,
        input.commandId,
        2,
        "assurance_binding_activated",
        hash,
      );
      return this.view(records[0]);
    });
  }

  public async get(context: TenantContext, bindingVersionId: string): Promise<AssuranceBindingVersion> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, bindingVersionId));
  }

  public async getActive(
    context: TenantContext,
    workId: string,
    planVersionId: string,
  ): Promise<AssuranceBindingVersion | undefined> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[BindingRecord[]]>(
      "SELECT * OMIT id FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND plan_version_id = $plan_version_id AND status = 'active' LIMIT 1;",
      { organization_id: context.organizationId, work_id: workId, plan_version_id: planVersionId },
    );
    return records[0] ? this.view(records[0]) : undefined;
  }

  public async readiness(
    context: TenantContext,
    workId: string,
    planVersionId: string,
    profile: { readonly profileId: string; readonly version: string },
  ): Promise<
    | { readonly status: "ready"; readonly binding: AssuranceBindingVersion }
    | {
        readonly status: "binding_required";
        readonly workId: string;
        readonly planVersionId: string;
        readonly profileId: string;
        readonly profileVersion: string;
        readonly action: "propose_assurance_binding";
      }
  > {
    const binding = await this.getActive(context, workId, planVersionId);
    return binding && binding.profileId === profile.profileId && binding.profileVersion === profile.version
      ? { status: "ready", binding }
      : {
          status: "binding_required",
          workId,
          planVersionId,
          profileId: profile.profileId,
          profileVersion: profile.version,
          action: "propose_assurance_binding",
        };
  }

  private async replay(
    organizationId: string,
    commandId: string,
    hash: string,
    executor: QueryExecutor = this.database,
  ): Promise<BindingEventRecord | undefined> {
    const [events] = await executor.query<[BindingEventRecord[]]>(
      "SELECT * OMIT id FROM assurance_binding_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_hash !== hash)
      throw new Error("같은 command ID에 다른 binding 명령을 사용할 수 없습니다");
    return events[0];
  }

  private async latestVersion(
    organizationId: string,
    workId: string,
    executor: QueryExecutor = this.database,
  ): Promise<number> {
    const [records] = await executor.query<[{ version: number }[]]>(
      "SELECT version FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id;",
      { organization_id: organizationId, work_id: workId },
    );
    if (records.length === 0) throw new Error(`Assurance binding version을 찾을 수 없습니다: ${workId}`);
    return records.reduce((maximum, record) => Math.max(maximum, record.version), 0);
  }

  private async find(
    executor: QueryExecutor,
    organizationId: string,
    bindingVersionId: string,
  ): Promise<BindingRecord> {
    const [records] = await executor.query<[BindingRecord[]]>(
      "SELECT * OMIT id FROM assurance_binding_version WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id LIMIT 1;",
      { organization_id: organizationId, binding_version_id: bindingVersionId },
    );
    if (!records[0]) throw new Error(`Assurance binding을 찾을 수 없습니다: ${bindingVersionId}`);
    return records[0];
  }

  private async event(
    executor: QueryExecutor,
    context: TenantContext,
    bindingVersionId: string,
    commandId: string,
    sequence: number,
    eventType: string,
    requestHash: string,
  ): Promise<void> {
    await executor.query(
      "CREATE assurance_binding_event CONTENT { event_id: $event_id, organization_id: $organization_id, binding_version_id: $binding_version_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_hash: $request_hash, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        binding_version_id: bindingVersionId,
        command_id: commandId,
        sequence,
        event_type: eventType,
        request_hash: requestHash,
        actor_user_id: context.userId,
      },
    );
  }

  private view(record: BindingRecord): AssuranceBindingVersion {
    return {
      bindingVersionId: record.binding_version_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      planVersionId: record.plan_version_id,
      version: record.version,
      revision: record.revision,
      status: record.status,
      profileId: record.profile_id,
      profileVersion: record.profile_version,
      bindings: JSON.parse(record.bindings_json) as AssuranceCheckBinding[],
      criteriaChecksum: record.criteria_checksum,
      checksum: record.checksum,
      authorHandle: record.author_handle,
      createdByUserId: record.created_by_user_id,
      ...(record.governance_decision_id ? { governanceDecisionId: record.governance_decision_id } : {}),
      ...(record.governance_approval_id ? { governanceApprovalId: record.governance_approval_id } : {}),
      createdAt: isoDateTime(record.created_at),
      ...(record.activated_at ? { activatedAt: isoDateTime(record.activated_at) } : {}),
      ...(record.superseded_at ? { supersededAt: isoDateTime(record.superseded_at) } : {}),
    };
  }
}
