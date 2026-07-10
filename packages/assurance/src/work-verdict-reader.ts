import { createHash } from "node:crypto";

import type { QueryExecutor } from "@massion/storage";
import type {
  AssuranceProjectionCriterion,
  AssuranceProjectionCriterionStatus,
  AssuranceProjectionVerdict,
  AssuranceVerdictProjection,
  AssuranceVerdictReader,
  MarkAssuranceProjectionInput,
  ReadAssuranceVerdictInput,
} from "@massion/work";

import type { AssuranceRun } from "./contracts.js";
import { verifyAssuranceVerdictIndependence } from "./database-independence.js";
import { buildDatabaseAssuranceSnapshot } from "./database-snapshot.js";

interface RunRecord {
  readonly assurance_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly plan_version_id: string;
  readonly binding_version_id: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly verifier_handle: string;
  readonly snapshot_hash: string;
  readonly status: string;
  readonly verdict?: string;
  readonly version: number;
  readonly projected_work_revision?: number;
  readonly completed_at?: unknown;
  readonly verifier_execution_id: string;
}

interface CriterionRecord {
  readonly criterion_key: string;
  readonly status: string;
  readonly exclusion_rule?: string;
  readonly exclusion_reason?: string;
  readonly exclusion_actor_id?: string;
}

interface CheckRecord {
  readonly check_id: string;
  readonly criterion_id: string;
  readonly status: string;
  readonly output_hash?: string;
  readonly artifact_version_ids: readonly string[];
  readonly evidence_brief_ids: readonly string[];
  readonly metric_observation_ids: readonly string[];
  readonly human_attestation_ids: readonly string[];
}

interface FindingRecord {
  readonly finding_id: string;
  readonly fingerprint: string;
  readonly severity: string;
  readonly status: string;
  readonly evidence_reference_ids: readonly string[];
}

interface BindingRecord {
  readonly binding_version_id: string;
}

const VERDICTS = new Set<AssuranceProjectionVerdict>(["passed", "failed", "blocked"]);
const CRITERION_STATUSES = new Set<AssuranceProjectionCriterionStatus>(["passed", "failed", "blocked", "excluded"]);

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
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (value && typeof value === "object" && "toISOString" in value) {
    const convert = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof convert === "function") return String(convert.call(value));
  }
  throw new Error("Terminal Assurance run 완료 시각이 유효하지 않습니다");
}

function verdict(value: string): AssuranceProjectionVerdict {
  if (!VERDICTS.has(value as AssuranceProjectionVerdict))
    throw new Error("Terminal Assurance verdict가 유효하지 않습니다");
  return value as AssuranceProjectionVerdict;
}

function criteria(records: readonly CriterionRecord[]): AssuranceProjectionCriterion[] {
  if (records.length === 0 || records.length > 100) throw new Error("Terminal Assurance criterion이 필요합니다");
  return records.map((record) => {
    if (!CRITERION_STATUSES.has(record.status as AssuranceProjectionCriterionStatus)) {
      throw new Error(`Terminal이 아닌 Assurance criterion입니다: ${record.criterion_key}`);
    }
    return {
      criterionKey: record.criterion_key,
      status: record.status as AssuranceProjectionCriterionStatus,
    };
  });
}

export class AssuranceRunVerdictReader implements AssuranceVerdictReader {
  public async readTerminalVerdict(
    executor: QueryExecutor,
    input: ReadAssuranceVerdictInput,
  ): Promise<AssuranceVerdictProjection | undefined> {
    const [runs] = await executor.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const run = runs[0];
    if (!run) return undefined;
    if (!VERDICTS.has(run.status as AssuranceProjectionVerdict) || run.verdict !== run.status) {
      throw new Error("Assurance run이 terminal verdict 상태가 아닙니다");
    }
    if (run.projected_work_revision !== undefined) throw new Error("Assurance run은 이미 Work에 투영됐습니다");
    await verifyAssuranceVerdictIndependence(executor, runView(run));
    const [criterionRecords] = await executor.query<[CriterionRecord[]]>(
      "SELECT criterion_key, status, exclusion_rule, exclusion_reason, exclusion_actor_id FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY criterion_key ASC;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const exclusions = Object.fromEntries(
      criterionRecords
        .filter((criterion) => criterion.status === "excluded")
        .map((criterion) => {
          if (!criterion.exclusion_rule || !criterion.exclusion_reason || !criterion.exclusion_actor_id) {
            throw new Error(`Excluded criterion metadata가 불완전합니다: ${criterion.criterion_key}`);
          }
          return [
            criterion.criterion_key,
            {
              rule: criterion.exclusion_rule,
              reason: criterion.exclusion_reason,
              actorId: criterion.exclusion_actor_id,
            },
          ];
        }),
    );
    const fresh = await buildDatabaseAssuranceSnapshot(executor, input.organizationId, {
      workId: run.work_id,
      targetWorkRevision: run.target_work_revision,
      planVersionId: run.plan_version_id,
      bindingVersionId: run.binding_version_id,
      profileId: run.profile_id,
      profileVersion: run.profile_version,
      ...(Object.keys(exclusions).length > 0 ? { criterionExclusions: exclusions } : {}),
    });
    if (fresh.snapshot.hash !== run.snapshot_hash) {
      throw new Error("Assurance run snapshot이 현재 DB material과 일치하지 않습니다");
    }
    const [bindings] = await executor.query<[BindingRecord[]]>(
      "SELECT binding_version_id FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id AND plan_version_id = $plan_version_id AND profile_id = $profile_id AND profile_version = $profile_version AND status = 'active' LIMIT 1;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        binding_version_id: run.binding_version_id,
        plan_version_id: run.plan_version_id,
        profile_id: run.profile_id,
        profile_version: run.profile_version,
      },
    );
    if (!bindings[0]) throw new Error("Assurance run의 활성 binding을 찾을 수 없습니다");
    const [checks] = await executor.query<[CheckRecord[]]>(
      "SELECT check_id, criterion_id, status, output_hash, artifact_version_ids, evidence_brief_ids, metric_observation_ids, human_attestation_ids FROM assurance_check WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY check_id ASC;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const [findings] = await executor.query<[FindingRecord[]]>(
      "SELECT finding_id, fingerprint, severity, status, evidence_reference_ids FROM assurance_finding WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY finding_id ASC;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const projectionCriteria = criteria(criterionRecords);
    const projectionVerdict = verdict(run.status);
    const evidenceHash = sha256(
      canonicalJson({
        assuranceRunId: run.assurance_run_id,
        snapshotHash: run.snapshot_hash,
        criteria: projectionCriteria,
        checks,
        findings,
      }),
    );
    return {
      assuranceRunId: run.assurance_run_id,
      organizationId: run.organization_id,
      workId: run.work_id,
      targetWorkRevision: run.target_work_revision,
      snapshotHash: run.snapshot_hash,
      profileId: run.profile_id,
      profileVersion: run.profile_version,
      bindingVersionId: run.binding_version_id,
      verifierHandle: run.verifier_handle,
      verifierExecutionId: run.verifier_execution_id,
      verdict: projectionVerdict,
      criteria: projectionCriteria,
      evidenceHash,
      completedAt: isoDateTime(run.completed_at),
    };
  }

  public async markProjected(executor: QueryExecutor, input: MarkAssuranceProjectionInput): Promise<void> {
    const [current] = await executor.query<[RunRecord[]]>(
      "SELECT * OMIT id FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      {
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
      },
    );
    const run = current[0];
    if (!run || !["passed", "failed"].includes(run.status) || run.projected_work_revision !== undefined) {
      throw new Error("투영 가능한 terminal Assurance run을 찾을 수 없습니다");
    }
    if (input.projectedWorkRevision !== run.target_work_revision + 1) {
      throw new Error("Assurance projected Work revision이 target 다음 revision이 아닙니다");
    }
    const [updated] = await executor.query<[RunRecord[]]>(
      "UPDATE assurance_run SET projected_work_revision = $projected_work_revision, version = $version, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND version = $expected_version RETURN AFTER;",
      {
        projected_work_revision: input.projectedWorkRevision,
        version: run.version + 1,
        organization_id: input.organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
        expected_version: run.version,
      },
    );
    if (!updated[0]) throw new Error("Assurance run projection 경쟁으로 갱신하지 못했습니다");
  }
}

function runView(
  record: RunRecord,
): Pick<
  AssuranceRun,
  "organizationId" | "workId" | "targetWorkRevision" | "assuranceRunId" | "verifierHandle" | "verifierExecutionId"
> {
  return {
    assuranceRunId: record.assurance_run_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    targetWorkRevision: record.target_work_revision,
    verifierHandle: record.verifier_handle,
    verifierExecutionId: record.verifier_execution_id,
  };
}
