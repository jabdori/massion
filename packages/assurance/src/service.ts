import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type {
  AssuranceCheckStatus,
  AssuranceCriterionStatus,
  AssuranceFailure,
  AssuranceFindingSeverity,
  AssuranceFindingStatus,
  AssuranceRun,
  AssuranceRunResult,
} from "./contracts.js";
import { verifyAssuranceVerdictIndependence } from "./database-independence.js";
import { buildDatabaseAssuranceSnapshot } from "./database-snapshot.js";
import { AssuranceRunStore, type TransitionAssuranceRunInput } from "./run-store.js";
import {
  decideAssuranceVerdict,
  type AssuranceVerdictDecision,
  type AssuranceVerdictDecisionInput,
} from "./verdict.js";

export interface AssuranceDecisionSourceResult {
  readonly run: AssuranceRun;
  readonly decisionInput: AssuranceVerdictDecisionInput;
}

export interface AssuranceDecisionSource {
  read(context: TenantContext, assuranceRunId: string): Promise<AssuranceDecisionSourceResult>;
}

export interface AssuranceRunDecisionGateway {
  get(context: TenantContext, assuranceRunId: string): Promise<AssuranceRun>;
  transition(context: TenantContext, input: TransitionAssuranceRunInput): Promise<AssuranceRunResult>;
}

export interface DecideAssuranceInput {
  readonly commandId: string;
  readonly assuranceRunId: string;
  readonly expectedVersion: number;
  readonly cancellationRequested?: boolean;
}

export interface DecideAssuranceResult {
  readonly run: AssuranceRun;
  readonly decision: AssuranceVerdictDecision;
}

export interface AtomicAssuranceDependencies {
  readonly database: MassionDatabase;
  readonly source: DatabaseAssuranceDecisionSource;
  readonly runs: AssuranceRunStore;
}

const ASSURANCE_SERVICE_CONSTRUCTION = Symbol("massion.assurance.service.construction");

interface CriterionRecord {
  readonly criterion_id: string;
  readonly criterion_key: string;
  readonly status: string;
  readonly exclusion_rule?: string;
  readonly exclusion_reason?: string;
  readonly exclusion_actor_id?: string;
}

interface CheckRecord {
  readonly criterion_id: string;
  readonly command_key: string;
  readonly status: string;
  readonly output_hash?: string;
  readonly artifact_version_ids: readonly string[];
  readonly evidence_brief_ids: readonly string[];
  readonly metric_observation_ids: readonly string[];
  readonly human_attestation_ids: readonly string[];
}

interface FindingRecord {
  readonly finding_id: string;
  readonly severity: string;
  readonly status: string;
}

interface BindingRecord {
  readonly bindings_json: string;
}

interface RuntimeRecord {
  readonly status: string;
  readonly output_json?: string;
}

interface WorkRevisionRecord {
  readonly revision: number;
}

interface BindingIdentity {
  readonly bindingKey: string;
  readonly criterionKey: string;
  readonly kind?: unknown;
  readonly requiredEvidenceKinds?: unknown;
  readonly evidenceAllowlist?: unknown;
  readonly evidenceKinds?: unknown;
}

const CRITERION_STATUSES = new Set<AssuranceCriterionStatus>(["pending", "passed", "failed", "blocked", "excluded"]);
const CHECK_STATUSES = new Set<AssuranceCheckStatus>([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);
const FINDING_SEVERITIES = new Set<AssuranceFindingSeverity>(["critical", "major", "minor", "info"]);
const FINDING_STATUSES = new Set<AssuranceFindingStatus>(["open", "resolved", "accepted"]);

function text(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label}가 필요합니다`);
}

function legacyTerminalEvidenceHash(run: AssuranceRun): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        legacySchema: "massion.assurance.terminal.v0",
        assuranceRunId: run.assuranceRunId,
        status: run.status,
        verdict: run.verdict ?? null,
        failure: run.failure ?? null,
        completedAt: run.completedAt ?? null,
      }),
    )
    .digest("hex");
}

function terminalDecision(run: AssuranceRun): AssuranceVerdictDecision {
  const evidenceHash = run.decisionEvidenceHash ?? legacyTerminalEvidenceHash(run);
  if (run.status === "cancelled") return { status: "cancelled", evidenceHash };
  if (run.status === "passed" || run.status === "failed" || run.status === "blocked") {
    return {
      status: run.status,
      evidenceHash,
      ...(run.failure ? { failure: run.failure } : {}),
    };
  }
  throw new Error("Active Assurance run에는 terminal decision이 없습니다");
}

function failure(decision: AssuranceVerdictDecision): AssuranceFailure | undefined {
  if (decision.status === "failed" || decision.status === "blocked") return decision.failure;
  return undefined;
}

function bindings(value: string): readonly BindingIdentity[] | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    decoded.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof (item as { bindingKey?: unknown }).bindingKey !== "string" ||
        !(item as { bindingKey: string }).bindingKey.trim() ||
        typeof (item as { criterionKey?: unknown }).criterionKey !== "string" ||
        !(item as { criterionKey: string }).criterionKey.trim(),
    )
  ) {
    return undefined;
  }
  const normalized = decoded as BindingIdentity[];
  if (new Set(normalized.map((item) => item.bindingKey)).size !== normalized.length) return undefined;
  return normalized;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function passedEvidenceMatchesBinding(
  binding: BindingIdentity,
  check: CheckRecord,
  checks: readonly CheckRecord[],
): boolean {
  if (check.status !== "passed") return true;
  if (binding.kind === "test") {
    const required = stringArray(binding.requiredEvidenceKinds);
    return Boolean(
      required &&
      (!required.some((kind) => ["artifact-version", "code-change"].includes(kind)) ||
        check.artifact_version_ids.length > 0),
    );
  }
  if (binding.kind === "inspection") {
    const allowlist = stringArray(binding.evidenceAllowlist);
    const references = [...check.artifact_version_ids, ...check.evidence_brief_ids];
    return Boolean(
      allowlist &&
      references.length > 0 &&
      check.artifact_version_ids.every((id) => allowlist.includes("artifact-version") || allowlist.includes(id)) &&
      check.evidence_brief_ids.every((id) => allowlist.includes("evidence-brief") || allowlist.includes(id)),
    );
  }
  if (binding.kind === "evidence") {
    const kinds = stringArray(binding.evidenceKinds);
    return Boolean(
      kinds &&
      (!kinds.some((kind) => kind !== "check-result") ||
        check.artifact_version_ids.length + check.evidence_brief_ids.length > 0) &&
      (!kinds.includes("artifact-version") || check.artifact_version_ids.length > 0) &&
      (!kinds.includes("evidence-brief") || check.evidence_brief_ids.length > 0) &&
      (!kinds.includes("check-result") ||
        checks.some(
          (peer) =>
            peer !== check && peer.criterion_id !== check.criterion_id && peer.status === "passed" && peer.output_hash,
        )),
    );
  }
  return binding.kind === "metric" || binding.kind === "human";
}

async function referenceCount(
  executor: QueryExecutor,
  table: string,
  idField: string,
  organizationId: string,
  workId: string,
  ids: readonly string[],
): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const [records] = await executor.query<[Record<string, unknown>[]]>(
    `SELECT ${idField} FROM ${table} WHERE organization_id = $organization_id AND work_id = $work_id AND ${idField} IN $ids;`,
    { organization_id: organizationId, work_id: workId, ids: unique },
  );
  return records.length;
}

export async function evaluateAssuranceEvidenceCompleteness(
  executor: QueryExecutor,
  input: {
    readonly organizationId: string;
    readonly workId: string;
    readonly bindingsJson?: string;
    readonly criteria: readonly CriterionRecord[];
    readonly checks: readonly CheckRecord[];
    readonly findings: readonly FindingRecord[];
  },
): Promise<{
  readonly bindingValid: boolean;
  readonly structurallyValid: boolean;
  readonly requiredEvidenceComplete: boolean;
}> {
  const decodedBindings = input.bindingsJson ? bindings(input.bindingsJson) : undefined;
  const criterionIds = new Set(input.criteria.map((criterion) => criterion.criterion_id));
  const activeCriteria = input.criteria.filter((criterion) => criterion.status !== "excluded");
  const criterionKeyById = new Map(
    input.criteria.map((criterion) => [criterion.criterion_id, criterion.criterion_key]),
  );
  const expectedBindings = decodedBindings?.filter((binding) =>
    activeCriteria.some((criterion) => criterion.criterion_key === binding.criterionKey),
  );
  const structurallyValid =
    input.criteria.length > 0 &&
    new Set(input.criteria.map((criterion) => criterion.criterion_id)).size === input.criteria.length &&
    input.criteria.every((criterion) => CRITERION_STATUSES.has(criterion.status as AssuranceCriterionStatus)) &&
    input.checks.every(
      (check) =>
        criterionIds.has(check.criterion_id) &&
        CHECK_STATUSES.has(check.status as AssuranceCheckStatus) &&
        [
          check.artifact_version_ids,
          check.evidence_brief_ids,
          check.metric_observation_ids,
          check.human_attestation_ids,
        ].every((ids) => new Set(ids).size === ids.length),
    ) &&
    input.findings.every(
      (finding) =>
        FINDING_SEVERITIES.has(finding.severity as AssuranceFindingSeverity) &&
        FINDING_STATUSES.has(finding.status as AssuranceFindingStatus),
    );
  const allReferenceKinds = [
    ["artifact_version", "artifact_version_id", input.checks.flatMap((check) => check.artifact_version_ids)],
    ["evidence_brief", "evidence_brief_id", input.checks.flatMap((check) => check.evidence_brief_ids)],
    ["assurance_metric_observation", "observation_id", input.checks.flatMap((check) => check.metric_observation_ids)],
    ["assurance_human_attestation", "attestation_id", input.checks.flatMap((check) => check.human_attestation_ids)],
  ] as const;
  let referencesComplete = true;
  for (const [table, field, ids] of allReferenceKinds) {
    if ((await referenceCount(executor, table, field, input.organizationId, input.workId, ids)) !== new Set(ids).size) {
      referencesComplete = false;
    }
  }
  const requiredEvidenceComplete =
    structurallyValid &&
    referencesComplete &&
    expectedBindings !== undefined &&
    expectedBindings.length > 0 &&
    activeCriteria.every((criterion) =>
      expectedBindings.some((binding) => binding.criterionKey === criterion.criterion_key),
    ) &&
    expectedBindings.every((binding) =>
      input.checks.some(
        (check) =>
          criterionKeyById.get(check.criterion_id) === binding.criterionKey &&
          check.command_key === binding.bindingKey &&
          ["passed", "failed", "blocked", "cancelled"].includes(check.status) &&
          (check.status === "cancelled" || /^[a-f0-9]{64}$/u.test(check.output_hash ?? "")) &&
          passedEvidenceMatchesBinding(binding, check, input.checks),
      ),
    );
  return {
    bindingValid: decodedBindings !== undefined && expectedBindings !== undefined,
    structurallyValid,
    requiredEvidenceComplete,
  };
}

/** 현재 DB 정본만 읽어 결정론적 판정 입력을 만드는 production source입니다. */
export class DatabaseAssuranceDecisionSource implements AssuranceDecisionSource {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runs: AssuranceRunStore,
  ) {}

  public async read(context: TenantContext, assuranceRunId: string): Promise<AssuranceDecisionSourceResult> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(
      async (transaction) => await this.readInTransaction(context, assuranceRunId, transaction),
    );
  }

  public async readInTransaction(
    context: TenantContext,
    assuranceRunId: string,
    transaction: QueryExecutor,
  ): Promise<AssuranceDecisionSourceResult> {
    const run = await this.runs.getInTransaction(context, assuranceRunId, transaction);
    if (run.organizationId !== context.organizationId || run.assuranceRunId !== assuranceRunId) {
      throw new Error("Assurance decision source identity가 일치하지 않습니다");
    }
    const parameters = {
      organization_id: context.organizationId,
      work_id: run.workId,
      assurance_run_id: run.assuranceRunId,
    };
    const [criterionRecords] = await transaction.query<[CriterionRecord[]]>(
      "SELECT criterion_id, criterion_key, status, exclusion_rule, exclusion_reason, exclusion_actor_id FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY criterion_key ASC;",
      parameters,
    );
    const [checkRecords] = await transaction.query<[CheckRecord[]]>(
      "SELECT criterion_id, command_key, status, output_hash, artifact_version_ids, evidence_brief_ids, metric_observation_ids, human_attestation_ids FROM assurance_check WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY command_key ASC;",
      parameters,
    );
    const [findingRecords] = await transaction.query<[FindingRecord[]]>(
      "SELECT finding_id, severity, status FROM assurance_finding WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY finding_id ASC;",
      parameters,
    );
    const [bindingRecords] = await transaction.query<[BindingRecord[]]>(
      "SELECT bindings_json FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id AND plan_version_id = $plan_version_id AND profile_id = $profile_id AND profile_version = $profile_version AND status = 'active' LIMIT 1;",
      {
        ...parameters,
        binding_version_id: run.bindingVersionId,
        plan_version_id: run.planVersionId,
        profile_id: run.profileId,
        profile_version: run.profileVersion,
      },
    );
    const [verifierRecords] = await transaction.query<[RuntimeRecord[]]>(
      "SELECT status, output_json FROM runtime_execution WHERE organization_id = $organization_id AND work_id = $work_id AND execution_id = $execution_id AND agent_handle = $agent_handle LIMIT 1;",
      {
        organization_id: context.organizationId,
        work_id: run.workId,
        execution_id: run.verifierExecutionId,
        agent_handle: run.verifierHandle,
      },
    );
    const [workRecords] = await transaction.query<[WorkRevisionRecord[]]>(
      "SELECT revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: context.organizationId, work_id: run.workId },
    );

    let snapshotStatus: AssuranceVerdictDecisionInput["snapshotStatus"];
    const exclusions = Object.fromEntries(
      criterionRecords
        .filter((criterion) => criterion.status === "excluded")
        .flatMap((criterion) =>
          criterion.exclusion_rule && criterion.exclusion_reason && criterion.exclusion_actor_id
            ? [
                [
                  criterion.criterion_key,
                  {
                    rule: criterion.exclusion_rule,
                    reason: criterion.exclusion_reason,
                    actorId: criterion.exclusion_actor_id,
                  },
                ] as const,
              ]
            : [],
        ),
    );
    try {
      const current = await buildDatabaseAssuranceSnapshot(transaction, context.organizationId, {
        workId: run.workId,
        targetWorkRevision: run.targetWorkRevision,
        planVersionId: run.planVersionId,
        bindingVersionId: run.bindingVersionId,
        profileId: run.profileId,
        profileVersion: run.profileVersion,
        ...(Object.keys(exclusions).length > 0 ? { criterionExclusions: exclusions } : {}),
      });
      snapshotStatus = current.snapshot.hash === run.snapshotHash ? "fresh" : "stale";
    } catch {
      snapshotStatus = workRecords[0]?.revision === run.targetWorkRevision ? "invalid" : "stale";
    }

    let independenceValid: boolean;
    try {
      await verifyAssuranceVerdictIndependence(transaction, run);
      independenceValid = true;
    } catch {
      independenceValid = false;
    }

    const evidence = await evaluateAssuranceEvidenceCompleteness(transaction, {
      organizationId: context.organizationId,
      workId: run.workId,
      ...(bindingRecords[0]?.bindings_json ? { bindingsJson: bindingRecords[0].bindings_json } : {}),
      criteria: criterionRecords,
      checks: checkRecords,
      findings: findingRecords,
    });
    const verifier = verifierRecords[0];
    const verifierSucceeded =
      verifier?.status === "succeeded" &&
      typeof verifier.output_json === "string" &&
      (() => {
        try {
          JSON.parse(verifier.output_json);
          return true;
        } catch {
          return false;
        }
      })();
    return {
      run,
      decisionInput: {
        cancellationRequested: false,
        snapshotStatus,
        identityValid: run.organizationId === context.organizationId && run.verifierHandle === "assurance",
        bindingValid: evidence.bindingValid,
        independenceValid,
        verifierSucceeded,
        requiredEvidenceComplete: evidence.requiredEvidenceComplete,
        criteria: evidence.structurallyValid
          ? criterionRecords.map((criterion) => ({
              criterionId: criterion.criterion_id,
              status: criterion.status as AssuranceCriterionStatus,
            }))
          : [],
        checks: evidence.structurallyValid
          ? checkRecords.map((check) => ({
              criterionId: check.criterion_id,
              bindingKey: check.command_key,
              status: check.status as AssuranceCheckStatus,
              ...(check.output_hash ? { outputHash: check.output_hash } : {}),
            }))
          : [],
        findings: evidence.structurallyValid
          ? findingRecords.map((finding) => ({
              findingId: finding.finding_id,
              severity: finding.severity as AssuranceFindingSeverity,
              status: finding.status as AssuranceFindingStatus,
            }))
          : [],
      },
    };
  }
}

export class AssuranceService {
  public constructor(
    private readonly source: AssuranceDecisionSource,
    private readonly runs: AssuranceRunDecisionGateway,
    private readonly atomic: AtomicAssuranceDependencies | undefined,
    constructionToken: typeof ASSURANCE_SERVICE_CONSTRUCTION,
  ) {
    if (constructionToken !== ASSURANCE_SERVICE_CONSTRUCTION) {
      throw new Error("AssuranceService는 create() factory로 생성해야 합니다");
    }
  }

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<AssuranceService> {
    const runs = await AssuranceRunStore.create(database, organizations);
    const source = new DatabaseAssuranceDecisionSource(database, organizations, runs);
    return new AssuranceService(source, runs, { database, source, runs }, ASSURANCE_SERVICE_CONSTRUCTION);
  }

  public async decide(context: TenantContext, input: DecideAssuranceInput): Promise<DecideAssuranceResult> {
    const caller = input as unknown as Readonly<Record<string, unknown>>;
    const injected = ["verdict", "target", "failure", "status"].find((key) => key in caller);
    if (injected) throw new Error(`caller verdict 주입은 허용되지 않습니다: ${injected}`);
    text(input.commandId, "Assurance decision command ID");
    text(input.assuranceRunId, "Assurance decision run ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("Assurance decision expected version이 올바르지 않습니다");
    }
    if (input.cancellationRequested !== undefined && typeof input.cancellationRequested !== "boolean") {
      throw new Error("Assurance cancellation 요청이 올바르지 않습니다");
    }
    if (this.atomic) return await this.decideAtomically(context, input, this.atomic);
    const current = await this.runs.get(context, input.assuranceRunId);
    if (current.assuranceRunId !== input.assuranceRunId) throw new Error("Assurance decision run이 일치하지 않습니다");
    if (["passed", "failed", "blocked", "cancelled"].includes(current.status)) {
      const decision = terminalDecision(current);
      const decisionFailure = failure(decision);
      const transitioned = await this.runs.transition(context, {
        commandId: input.commandId,
        assuranceRunId: input.assuranceRunId,
        expectedVersion: input.expectedVersion,
        target: decision.status,
        decisionEvidenceHash: decision.evidenceHash,
        ...(decisionFailure ? { failure: decisionFailure } : {}),
      });
      return { run: transitioned.run, decision };
    }
    if (current.version !== input.expectedVersion)
      throw new Error("Assurance decision run version이 일치하지 않습니다");
    if (input.cancellationRequested === true) {
      const decision = decideAssuranceVerdict({
        cancellationRequested: true,
        snapshotStatus: "invalid",
        identityValid: false,
        bindingValid: false,
        independenceValid: false,
        verifierSucceeded: false,
        requiredEvidenceComplete: false,
        criteria: [],
        checks: [],
        findings: [],
      });
      const transitioned = await this.runs.transition(context, {
        commandId: input.commandId,
        assuranceRunId: input.assuranceRunId,
        expectedVersion: input.expectedVersion,
        target: "cancelled",
        decisionEvidenceHash: decision.evidenceHash,
      });
      return { run: transitioned.run, decision };
    }
    const source = await this.source.read(context, input.assuranceRunId);
    if (source.run.assuranceRunId !== current.assuranceRunId || source.run.version !== current.version) {
      throw new Error("Assurance decision source run이 일치하지 않습니다");
    }
    const decision = decideAssuranceVerdict({
      ...source.decisionInput,
      cancellationRequested: false,
    });
    const decisionFailure = failure(decision);
    const transitioned = await this.runs.transition(context, {
      commandId: input.commandId,
      assuranceRunId: input.assuranceRunId,
      expectedVersion: input.expectedVersion,
      target: decision.status,
      decisionEvidenceHash: decision.evidenceHash,
      ...(decisionFailure ? { failure: decisionFailure } : {}),
    });
    return { run: transitioned.run, decision };
  }

  private async decideAtomically(
    context: TenantContext,
    input: DecideAssuranceInput,
    atomic: AtomicAssuranceDependencies,
  ): Promise<DecideAssuranceResult> {
    return await atomic.database.transaction(async (transaction) => {
      const current = await atomic.runs.getInTransaction(context, input.assuranceRunId, transaction);
      if (current.assuranceRunId !== input.assuranceRunId) {
        throw new Error("Assurance decision run이 일치하지 않습니다");
      }
      if (["passed", "failed", "blocked", "cancelled"].includes(current.status)) {
        const decision = terminalDecision(current);
        const decisionFailure = failure(decision);
        const transitioned = await atomic.runs.transitionInTransaction(
          context,
          {
            commandId: input.commandId,
            assuranceRunId: input.assuranceRunId,
            expectedVersion: input.expectedVersion,
            target: decision.status,
            decisionEvidenceHash: decision.evidenceHash,
            ...(decisionFailure ? { failure: decisionFailure } : {}),
          },
          transaction,
        );
        return { run: transitioned.run, decision };
      }
      if (current.version !== input.expectedVersion) {
        throw new Error("Assurance decision run version이 일치하지 않습니다");
      }
      if (input.cancellationRequested === true) {
        const decision = decideAssuranceVerdict({
          cancellationRequested: true,
          snapshotStatus: "invalid",
          identityValid: false,
          bindingValid: false,
          independenceValid: false,
          verifierSucceeded: false,
          requiredEvidenceComplete: false,
          criteria: [],
          checks: [],
          findings: [],
        });
        const transitioned = await atomic.runs.transitionInTransaction(
          context,
          {
            commandId: input.commandId,
            assuranceRunId: input.assuranceRunId,
            expectedVersion: input.expectedVersion,
            target: "cancelled",
            decisionEvidenceHash: decision.evidenceHash,
          },
          transaction,
        );
        return { run: transitioned.run, decision };
      }
      const source = await atomic.source.readInTransaction(context, input.assuranceRunId, transaction);
      if (source.run.assuranceRunId !== current.assuranceRunId || source.run.version !== current.version) {
        throw new Error("Assurance decision source run이 일치하지 않습니다");
      }
      const decision = decideAssuranceVerdict({ ...source.decisionInput, cancellationRequested: false });
      const decisionFailure = failure(decision);
      const transitioned = await atomic.runs.transitionInTransaction(
        context,
        {
          commandId: input.commandId,
          assuranceRunId: input.assuranceRunId,
          expectedVersion: input.expectedVersion,
          target: decision.status,
          decisionEvidenceHash: decision.evidenceHash,
          ...(decisionFailure ? { failure: decisionFailure } : {}),
        },
        transaction,
      );
      return { run: transitioned.run, decision };
    });
  }
}

/** 패키지 공개 API에 노출하지 않는 unit/concurrency test seam입니다. */
export function createAssuranceServiceTestHarness(
  source: AssuranceDecisionSource,
  runs: AssuranceRunDecisionGateway,
  atomic?: AtomicAssuranceDependencies,
): AssuranceService {
  return new AssuranceService(source, runs, atomic, ASSURANCE_SERVICE_CONSTRUCTION);
}
