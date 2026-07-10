import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import { verifyAssuranceCompletionIndependence } from "./database-independence.js";
import { buildCompletedDatabaseAssuranceSnapshot } from "./database-snapshot.js";
import { classifyAssuranceFollowUpEvents } from "./snapshot.js";
import {
  type AssuranceCheckStatus,
  type AssuranceCriterionStatus,
  type AssuranceFindingSeverity,
  type AssuranceFindingStatus,
} from "./contracts.js";
import { decideAssuranceVerdict } from "./verdict.js";
import { evaluateAssuranceEvidenceCompleteness } from "./service.js";

export interface AssuranceCompletionAuditFinding {
  readonly workId: string;
  readonly code:
    "verification" | "run-verdict" | "lineage" | "record" | "artifact" | "snapshot" | "independence" | "evidence-guard";
  readonly message: string;
}

export interface AssuranceCompletionLineage {
  readonly workId: string;
  readonly workRevision: number;
  readonly workArtifactVersionIds: readonly string[];
  readonly verificationId: string;
  readonly verificationPassed: boolean;
  readonly verificationAssuranceRunId: string;
  readonly verificationTargetWorkRevision: number;
  readonly verificationProjectedWorkRevision: number;
  readonly verificationSnapshotHash: string;
  readonly verificationProfileId: string;
  readonly verificationProfileVersion: string;
  readonly verificationBindingVersionId: string;
  readonly verificationEvidenceArtifactVersionId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly runVerdict?: string;
  readonly runTargetWorkRevision: number;
  readonly runProjectedWorkRevision?: number;
  readonly runSnapshotHash: string;
  readonly runProfileId: string;
  readonly runProfileVersion: string;
  readonly runBindingVersionId: string;
  readonly runDecisionEvidenceHash?: string;
  readonly decisionEvidenceValid: boolean;
  readonly runDecisionGuardRevision?: number;
  readonly currentEvidenceGuardRevision?: number;
  readonly recordFinalized: boolean;
  readonly recordRecordedWorkRevision: number;
  readonly recordVerificationIds: readonly string[];
  readonly evidenceArtifactChecksumValid: boolean;
  readonly evidenceArtifactLineageValid: boolean;
  readonly snapshotFresh: boolean;
  readonly independenceValid: boolean;
}

interface WorkRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly revision: number;
  readonly artifact_version_ids: readonly string[];
}

interface VerificationRecord {
  readonly verification_id: string;
  readonly passed: boolean;
  readonly assurance_run_id: string;
  readonly target_work_revision: number;
  readonly projected_work_revision: number;
  readonly snapshot_hash: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly binding_version_id: string;
  readonly evidence_artifact_version_id: string;
  readonly verifier_id: string;
  readonly criteria_json: string;
}

interface AssuranceRunRecord {
  readonly assurance_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly plan_version_id: string;
  readonly binding_version_id: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly verifier_handle: string;
  readonly verifier_execution_id: string;
  readonly snapshot_hash: string;
  readonly status: string;
  readonly verdict?: string;
  readonly projected_work_revision?: number;
  readonly decision_evidence_hash?: string;
  readonly decision_guard_revision?: number;
  readonly completed_at?: unknown;
}

interface FinalRecord {
  readonly version: number;
  readonly recorded_work_revision: number;
  readonly verification_ids: readonly string[];
  readonly finalized: boolean;
}

interface ArtifactRecord {
  readonly artifact_version_id: string;
  readonly checksum: string;
  readonly content_json: string;
  readonly creator_agent_handle?: string;
  readonly creator_execution_id?: string;
}

interface GuardRecord {
  readonly revision: number;
}

interface EventRecord {
  readonly sequence: number;
  readonly event_type: string;
}

interface AssuranceEventRecord {
  readonly sequence: number;
  readonly event_type: string;
  readonly payload_json: string;
}

interface CriterionRecord {
  readonly criterion_id: string;
  readonly criterion_key: string;
  readonly status: string;
  readonly exclusion_rule?: string;
  readonly exclusion_reason?: string;
  readonly exclusion_actor_id?: string;
}

interface CheckRecord {
  readonly check_id: string;
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
  readonly fingerprint: string;
  readonly severity: string;
  readonly status: string;
  readonly evidence_reference_ids: readonly string[];
}

interface BindingEvidenceRecord {
  readonly bindings_json: string;
}

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

function isoDateTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (value && typeof value === "object" && "toISOString" in value) {
    const convert = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof convert === "function") return String(convert.call(value));
  }
  return undefined;
}

function finding(
  lineage: AssuranceCompletionLineage,
  code: AssuranceCompletionAuditFinding["code"],
  message: string,
): AssuranceCompletionAuditFinding {
  return { workId: lineage.workId, code, message };
}

export function auditAssuranceCompletionLineage(
  lineage: AssuranceCompletionLineage,
): AssuranceCompletionAuditFinding[] {
  const findings: AssuranceCompletionAuditFinding[] = [];
  if (!lineage.verificationPassed) {
    findings.push(finding(lineage, "verification", "완료 Work의 최신 Verification이 passed가 아닙니다"));
  }
  if (lineage.runStatus !== "passed" || lineage.runVerdict !== "passed") {
    findings.push(finding(lineage, "run-verdict", "연결된 Assurance run이 passed terminal 원장이 아닙니다"));
  }
  const exactLineage =
    lineage.verificationAssuranceRunId === lineage.runId &&
    lineage.verificationTargetWorkRevision === lineage.runTargetWorkRevision &&
    lineage.verificationProjectedWorkRevision === lineage.verificationTargetWorkRevision + 1 &&
    lineage.runProjectedWorkRevision === lineage.verificationProjectedWorkRevision &&
    lineage.verificationSnapshotHash === lineage.runSnapshotHash &&
    lineage.verificationProfileId === lineage.runProfileId &&
    lineage.verificationProfileVersion === lineage.runProfileVersion &&
    lineage.verificationBindingVersionId === lineage.runBindingVersionId &&
    lineage.decisionEvidenceValid;
  if (!exactLineage) {
    findings.push(finding(lineage, "lineage", "WorkVerification과 Assurance run의 exact lineage가 다릅니다"));
  }
  if (
    !lineage.recordFinalized ||
    lineage.recordRecordedWorkRevision !== lineage.workRevision - 1 ||
    !lineage.recordVerificationIds.includes(lineage.verificationId)
  ) {
    findings.push(
      finding(lineage, "record", "최신 확정 WorkRecord가 Verification과 완료 revision을 포함하지 않습니다"),
    );
  }
  if (
    !lineage.workArtifactVersionIds.includes(lineage.verificationEvidenceArtifactVersionId) ||
    !lineage.evidenceArtifactChecksumValid ||
    !lineage.evidenceArtifactLineageValid
  ) {
    findings.push(finding(lineage, "artifact", "Verification evidence Artifact의 checksum 또는 lineage가 다릅니다"));
  }
  if (!lineage.snapshotFresh) {
    findings.push(finding(lineage, "snapshot", "완료 Work의 Assurance snapshot이 현재 material과 다릅니다"));
  }
  if (!lineage.independenceValid) {
    findings.push(finding(lineage, "independence", "완료 Work의 verifier 독립성이 유효하지 않습니다"));
  }
  if (
    lineage.runDecisionGuardRevision === undefined ||
    lineage.currentEvidenceGuardRevision === undefined ||
    lineage.currentEvidenceGuardRevision <= lineage.runDecisionGuardRevision
  ) {
    findings.push(finding(lineage, "evidence-guard", "판정·투영 뒤 Assurance evidence guard가 변경됐습니다"));
  }
  return findings;
}

function startSnapshotManifest(payloadJson: string | undefined): string | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson) as Readonly<Record<string, unknown>>;
    return typeof payload.snapshotCanonicalJson === "string" ? payload.snapshotCanonicalJson : undefined;
  } catch {
    return undefined;
  }
}

function eventDecisionEvidenceHash(payloadJson: string | undefined): string | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson) as Readonly<Record<string, unknown>>;
    return typeof payload.decisionEvidenceHash === "string" ? payload.decisionEvidenceHash : undefined;
  } catch {
    return undefined;
  }
}

export class AssuranceComplianceAuditor {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async auditCompletedWorks(context: TenantContext): Promise<AssuranceCompletionAuditFinding[]> {
    await this.organizations.verifyTenantContext(context);
    const [works] = await this.database.query<[WorkRecord[]]>(
      "SELECT organization_id, work_id, revision, artifact_version_ids FROM work WHERE organization_id = $organization_id AND status = 'completed' ORDER BY work_id ASC;",
      { organization_id: context.organizationId },
    );
    const findings: AssuranceCompletionAuditFinding[] = [];
    for (const work of works) findings.push(...(await this.auditWork(context, work)));
    return findings.sort((left, right) =>
      `${left.workId}:${left.code}:${left.message}`.localeCompare(`${right.workId}:${right.code}:${right.message}`),
    );
  }

  public async assertRestoredCompliance(context: TenantContext): Promise<void> {
    const findings = await this.auditCompletedWorks(context);
    if (findings.length > 0) {
      throw new Error(`복원된 completed Work의 Assurance 준수 위반입니다: ${JSON.stringify(findings)}`);
    }
  }

  public async assertDatabaseCompliance(): Promise<void> {
    const [works] = await this.database.query<[WorkRecord[]]>(
      "SELECT organization_id, work_id, revision, artifact_version_ids FROM work WHERE status = 'completed' ORDER BY organization_id ASC, work_id ASC;",
    );
    const findings: AssuranceCompletionAuditFinding[] = [];
    for (const work of works) {
      findings.push(...(await this.auditWork({ organizationId: work.organization_id }, work)));
    }
    if (findings.length > 0) {
      throw new Error(`복원된 completed Work의 Assurance 준수 위반입니다: ${JSON.stringify(findings)}`);
    }
  }

  private async auditWork(
    context: { readonly organizationId: string },
    work: WorkRecord,
  ): Promise<AssuranceCompletionAuditFinding[]> {
    const parameters = { organization_id: context.organizationId, work_id: work.work_id };
    const [verifications] = await this.database.query<[VerificationRecord[]]>(
      "SELECT * OMIT id FROM work_verification WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at DESC LIMIT 1;",
      parameters,
    );
    const verification = verifications[0];
    if (!verification) {
      return [{ workId: work.work_id, code: "verification", message: "완료 Work의 Verification이 없습니다" }];
    }
    const [runs] = await this.database.query<[AssuranceRunRecord[]]>(
      "SELECT * OMIT id FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { ...parameters, assurance_run_id: verification.assurance_run_id },
    );
    const run = runs[0];
    if (!run) {
      return [{ workId: work.work_id, code: "lineage", message: "Verification의 Assurance run이 없습니다" }];
    }
    const [records] = await this.database.query<[FinalRecord[]]>(
      "SELECT version, recorded_work_revision, verification_ids, finalized FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND finalized = true ORDER BY version DESC LIMIT 1;",
      parameters,
    );
    const record = records[0];
    const [artifacts] = await this.database.query<[ArtifactRecord[]]>(
      "SELECT artifact_version_id, checksum, content_json, creator_agent_handle, creator_execution_id FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id LIMIT 1;",
      { ...parameters, artifact_version_id: verification.evidence_artifact_version_id },
    );
    const artifact = artifacts[0];
    const [guards] = await this.database.query<[GuardRecord[]]>(
      "SELECT revision FROM assurance_evidence_guard WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { ...parameters, assurance_run_id: run.assurance_run_id },
    );
    const [events] = await this.database.query<[EventRecord[]]>(
      "SELECT sequence, event_type FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
      parameters,
    );
    const [startEvents] = await this.database.query<[AssuranceEventRecord[]]>(
      "SELECT sequence, event_type, payload_json FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND (event_type = 'assurance_run_started' OR event_type = 'assurance_run_passed') ORDER BY sequence ASC;",
      { ...parameters, assurance_run_id: run.assurance_run_id },
    );
    const [criterionRecords] = await this.database.query<[CriterionRecord[]]>(
      "SELECT criterion_id, criterion_key, status, exclusion_rule, exclusion_reason, exclusion_actor_id FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY criterion_key ASC;",
      { ...parameters, assurance_run_id: run.assurance_run_id },
    );
    const [checkRecords] = await this.database.query<[CheckRecord[]]>(
      "SELECT check_id, criterion_id, command_key, status, output_hash, artifact_version_ids, evidence_brief_ids, metric_observation_ids, human_attestation_ids FROM assurance_check WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY check_id ASC;",
      { ...parameters, assurance_run_id: run.assurance_run_id },
    );
    const [findingRecords] = await this.database.query<[FindingRecord[]]>(
      "SELECT finding_id, fingerprint, severity, status, evidence_reference_ids FROM assurance_finding WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id ORDER BY finding_id ASC;",
      { ...parameters, assurance_run_id: run.assurance_run_id },
    );
    const [bindingRecords] = await this.database.query<[BindingEvidenceRecord[]]>(
      "SELECT bindings_json FROM assurance_binding_version WHERE organization_id = $organization_id AND work_id = $work_id AND binding_version_id = $binding_version_id LIMIT 1;",
      { ...parameters, binding_version_id: run.binding_version_id },
    );
    const followUp = classifyAssuranceFollowUpEvents(run.target_work_revision, events);
    const manifest = startSnapshotManifest(
      startEvents.find((event) => event.event_type === "assurance_run_started")?.payload_json,
    );
    const terminalDecisionEvidenceHash = eventDecisionEvidenceHash(
      startEvents.find((event) => event.event_type === "assurance_run_passed")?.payload_json,
    );
    const exclusions = Object.fromEntries(
      criterionRecords
        .filter((criterion) => criterion.status === "excluded")
        .map((criterion) => [
          criterion.criterion_key,
          {
            rule: criterion.exclusion_rule ?? "",
            reason: criterion.exclusion_reason ?? "",
            actorId: criterion.exclusion_actor_id ?? "",
          },
        ]),
    );
    const snapshotFresh = await (async () => {
      if (followUp.status !== "allowed" || followUp.stage !== "completed") {
        return false;
      }
      try {
        const rebuilt = await buildCompletedDatabaseAssuranceSnapshot(this.database, context.organizationId, {
          workId: run.work_id,
          targetWorkRevision: run.target_work_revision,
          planVersionId: run.plan_version_id,
          bindingVersionId: run.binding_version_id,
          profileId: run.profile_id,
          profileVersion: run.profile_version,
          evidenceArtifactVersionId: verification.evidence_artifact_version_id,
          ...(Object.keys(exclusions).length > 0 ? { criterionExclusions: exclusions } : {}),
        });
        return (
          rebuilt.snapshot.hash === run.snapshot_hash &&
          (manifest === undefined ||
            (sha256(manifest) === run.snapshot_hash && rebuilt.snapshot.canonicalJson === manifest))
        );
      } catch {
        return false;
      }
    })();
    const projectionCriteria = criterionRecords.map((criterion) => ({
      criterionKey: criterion.criterion_key,
      status: criterion.status,
    }));
    const projectionChecks = checkRecords.map((check) => ({
      check_id: check.check_id,
      criterion_id: check.criterion_id,
      status: check.status,
      ...(check.output_hash ? { output_hash: check.output_hash } : {}),
      artifact_version_ids: check.artifact_version_ids,
      evidence_brief_ids: check.evidence_brief_ids,
      metric_observation_ids: check.metric_observation_ids,
      human_attestation_ids: check.human_attestation_ids,
    }));
    const projectionEvidenceHash = sha256(
      canonicalJson({
        assuranceRunId: run.assurance_run_id,
        snapshotHash: run.snapshot_hash,
        criteria: projectionCriteria,
        checks: projectionChecks,
        findings: findingRecords,
      }),
    );
    const completedAt = isoDateTime(run.completed_at);
    const expectedEvidenceContent = completedAt
      ? canonicalJson({
          schema: "massion.verification-evidence.v1",
          assuranceRunId: run.assurance_run_id,
          targetWorkRevision: run.target_work_revision,
          snapshotHash: run.snapshot_hash,
          profileId: run.profile_id,
          profileVersion: run.profile_version,
          bindingVersionId: run.binding_version_id,
          verifierHandle: run.verifier_handle,
          verifierExecutionId: run.verifier_execution_id,
          verdict: "passed",
          criteria: projectionCriteria,
          evidenceHash: projectionEvidenceHash,
          completedAt,
        })
      : undefined;
    const independenceValid = await (async () => {
      try {
        await verifyAssuranceCompletionIndependence(this.database, {
          assuranceRunId: run.assurance_run_id,
          organizationId: run.organization_id,
          workId: run.work_id,
          targetWorkRevision: run.target_work_revision,
          verifierHandle: run.verifier_handle,
          verifierExecutionId: run.verifier_execution_id,
        });
        return true;
      } catch {
        return false;
      }
    })();
    const evidence = await evaluateAssuranceEvidenceCompleteness(this.database, {
      organizationId: context.organizationId,
      workId: run.work_id,
      ...(bindingRecords[0]?.bindings_json ? { bindingsJson: bindingRecords[0].bindings_json } : {}),
      criteria: criterionRecords,
      checks: checkRecords,
      findings: findingRecords,
    });
    const recomputedDecisionEvidenceHash = decideAssuranceVerdict({
      cancellationRequested: false,
      snapshotStatus: snapshotFresh ? "fresh" : "stale",
      identityValid: run.organization_id === context.organizationId && run.verifier_handle === "assurance",
      bindingValid: evidence.bindingValid,
      independenceValid,
      verifierSucceeded: independenceValid,
      requiredEvidenceComplete: evidence.requiredEvidenceComplete,
      criteria: evidence.structurallyValid
        ? criterionRecords.map((criterion) => ({
            criterionId: criterion.criterion_id,
            status: criterion.status as AssuranceCriterionStatus,
          }))
        : [],
      checks: evidence.structurallyValid
        ? [...checkRecords]
            .sort((left, right) => left.command_key.localeCompare(right.command_key))
            .map((check) => ({
              criterionId: check.criterion_id,
              bindingKey: check.command_key,
              status: check.status as AssuranceCheckStatus,
              ...(check.output_hash ? { outputHash: check.output_hash } : {}),
            }))
        : [],
      findings: evidence.structurallyValid
        ? findingRecords.map((record) => ({
            findingId: record.finding_id,
            severity: record.severity as AssuranceFindingSeverity,
            status: record.status as AssuranceFindingStatus,
          }))
        : [],
    }).evidenceHash;
    return auditAssuranceCompletionLineage({
      workId: work.work_id,
      workRevision: work.revision,
      workArtifactVersionIds: work.artifact_version_ids,
      verificationId: verification.verification_id,
      verificationPassed: verification.passed,
      verificationAssuranceRunId: verification.assurance_run_id,
      verificationTargetWorkRevision: verification.target_work_revision,
      verificationProjectedWorkRevision: verification.projected_work_revision,
      verificationSnapshotHash: verification.snapshot_hash,
      verificationProfileId: verification.profile_id,
      verificationProfileVersion: verification.profile_version,
      verificationBindingVersionId: verification.binding_version_id,
      verificationEvidenceArtifactVersionId: verification.evidence_artifact_version_id,
      runId: run.assurance_run_id,
      runStatus: run.status,
      ...(run.verdict ? { runVerdict: run.verdict } : {}),
      runTargetWorkRevision: run.target_work_revision,
      ...(run.projected_work_revision !== undefined ? { runProjectedWorkRevision: run.projected_work_revision } : {}),
      runSnapshotHash: run.snapshot_hash,
      runProfileId: run.profile_id,
      runProfileVersion: run.profile_version,
      runBindingVersionId: run.binding_version_id,
      ...(run.decision_evidence_hash ? { runDecisionEvidenceHash: run.decision_evidence_hash } : {}),
      decisionEvidenceValid:
        /^[a-f0-9]{64}$/u.test(run.decision_evidence_hash ?? "") &&
        recomputedDecisionEvidenceHash === run.decision_evidence_hash &&
        (terminalDecisionEvidenceHash === undefined || terminalDecisionEvidenceHash === run.decision_evidence_hash),
      ...(run.decision_guard_revision !== undefined ? { runDecisionGuardRevision: run.decision_guard_revision } : {}),
      ...(guards[0]?.revision !== undefined ? { currentEvidenceGuardRevision: guards[0].revision } : {}),
      recordFinalized: record?.finalized ?? false,
      recordRecordedWorkRevision: record?.recorded_work_revision ?? -1,
      recordVerificationIds: record?.verification_ids ?? [],
      evidenceArtifactChecksumValid: artifact !== undefined && sha256(artifact.content_json) === artifact.checksum,
      evidenceArtifactLineageValid:
        artifact !== undefined &&
        expectedEvidenceContent !== undefined &&
        artifact.content_json === expectedEvidenceContent &&
        artifact.creator_agent_handle === run.verifier_handle &&
        artifact.creator_execution_id === run.verifier_execution_id &&
        verification.verifier_id === run.verifier_handle &&
        verification.criteria_json === canonicalJson(projectionCriteria),
      snapshotFresh,
      independenceValid,
    });
  }
}
