import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type { OrganizationService } from "@massion/identity";
import type { StructuredAgentRunner, StructuredOutputSpec } from "@massion/runtime";
import type { MassionDatabase } from "@massion/storage";

import type { AssuranceFinding } from "./contracts.js";
import { DEFAULT_INSPECTION_MAXIMUM_AGE_MS } from "./binding-store.js";
import {
  verifyArtifactEvidence,
  verifyEvidenceBriefFreshness,
  type ArtifactEvidence,
  type EvidenceBriefEvidence,
} from "./evidence.js";
import type {
  TrustedAssuranceInspectionExecutionInput,
  TrustedAssuranceInspectionExecutionResult,
  TrustedAssuranceInspectionExecutor,
} from "./checks.js";
import { containsAssuranceCredential, normalizeRepositoryUri } from "./sarif.js";

export interface StructuredInspectionEvidence {
  readonly evidenceReferenceId: string;
  readonly kind: string;
  readonly checksum: string;
  readonly summary: string;
}

export interface ExecuteStructuredInspectionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly correlationId: string;
  readonly inspectorProfile: string;
  readonly evidence: readonly StructuredInspectionEvidence[];
  readonly evidenceReferenceAllowlist: readonly string[];
  readonly controlReferenceAllowlist: readonly string[];
  readonly maximumFindings: number;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
}

export interface StructuredInspectionFinding {
  readonly category: AssuranceFinding["category"];
  readonly severity: AssuranceFinding["severity"];
  readonly message: string;
  readonly location?: { readonly uri: string; readonly line?: number; readonly column?: number };
  readonly evidenceReferenceIds: readonly string[];
  readonly sourceTool: string;
  readonly sourceRule: string;
  readonly controlReferences: readonly string[];
}

export interface StructuredInspectionResult {
  readonly status: "passed" | "blocked";
  readonly outputHash: string;
  readonly summary: string;
  readonly executionId?: string;
  readonly findings: readonly StructuredInspectionFinding[];
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

const CATEGORIES = new Set<AssuranceFinding["category"]>([
  "correctness",
  "security",
  "reliability",
  "operability",
  "supply-chain",
]);
const SEVERITIES = new Set<AssuranceFinding["severity"]>(["critical", "major", "minor", "info"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다`);
  if (value.length > maximum) throw new Error(`${label}는 ${String(maximum)}자 이하여야 합니다`);
  return value;
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}는 object여야 합니다`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowlist = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowlist.has(key));
  if (unsupported) throw new Error(`${label}에 허용되지 않은 필드가 있습니다: ${unsupported}`);
}

function strings(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} 배열이 올바르지 않습니다`);
  const normalized = value.map((item) => text(item, label, 200));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}가 중복됐습니다`);
  return normalized.sort();
}

function positive(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} 범위가 올바르지 않습니다`);
  return value as number;
}

function validateInput(input: ExecuteStructuredInspectionInput): void {
  for (const [label, value] of [
    ["Inspection command ID", input.commandId],
    ["Inspection Work ID", input.workId],
    ["Inspection run ID", input.assuranceRunId],
    ["Inspection criterion ID", input.criterionId],
    ["Inspection Agent handle", input.agentHandle],
    ["Inspection model route", input.modelRoute],
    ["Inspection correlation ID", input.correlationId],
    ["Inspection profile", input.inspectorProfile],
  ] as const) {
    text(value, label, 200);
  }
  if (!Number.isSafeInteger(input.maximumFindings) || input.maximumFindings < 1 || input.maximumFindings > 100) {
    throw new Error("Inspection finding 상한은 1~100이어야 합니다");
  }
  if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 0) {
    throw new Error("Inspection estimated token이 올바르지 않습니다");
  }
  if (!Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0) {
    throw new Error("Inspection estimated cost가 올바르지 않습니다");
  }
  if (input.evidence.length === 0 || input.evidence.length > 100) throw new Error("Inspection evidence가 필요합니다");
  if (input.evidenceReferenceAllowlist.length !== input.evidence.length) {
    throw new Error("Inspection evidence allowlist는 제출 evidence와 정확히 일치해야 합니다");
  }
  const allowlist = new Set(input.evidenceReferenceAllowlist);
  if (allowlist.size !== input.evidenceReferenceAllowlist.length)
    throw new Error("Inspection evidence allowlist가 중복됐습니다");
  for (const reference of input.evidenceReferenceAllowlist) {
    text(reference, "Inspection evidence allowlist reference", 200);
  }
  if (input.controlReferenceAllowlist.length > 50) throw new Error("Inspection control allowlist 상한을 초과했습니다");
  if (new Set(input.controlReferenceAllowlist).size !== input.controlReferenceAllowlist.length) {
    throw new Error("Inspection control allowlist가 중복됐습니다");
  }
  for (const reference of input.controlReferenceAllowlist) {
    text(reference, "Inspection control allowlist reference", 200);
  }
  for (const evidence of input.evidence) {
    text(evidence.evidenceReferenceId, "Inspection evidence reference", 200);
    text(evidence.kind, "Inspection evidence kind", 100);
    if (!/^[a-f0-9]{64}$/u.test(evidence.checksum)) throw new Error("Inspection evidence checksum이 올바르지 않습니다");
    text(evidence.summary, "Inspection evidence summary", 2_000);
    if (containsAssuranceCredential(evidence.summary))
      throw new Error("Inspection evidence summary에 credential이 있습니다");
    if (!allowlist.has(evidence.evidenceReferenceId)) throw new Error("Inspection evidence가 allowlist 밖입니다");
  }
}

function parseOutput(value: unknown, input: ExecuteStructuredInspectionInput): StructuredInspectionFinding[] {
  const output = record(value, "Inspection model output");
  exactKeys(output, ["findings"], "Inspection model output");
  if (!Array.isArray(output.findings) || output.findings.length > input.maximumFindings) {
    throw new Error("Inspection model finding 상한을 초과했습니다");
  }
  const evidenceAllowlist = new Set(input.evidenceReferenceAllowlist);
  const submittedEvidence = new Set(input.evidence.map((evidence) => evidence.evidenceReferenceId));
  const controlAllowlist = new Set(input.controlReferenceAllowlist);
  return output.findings.map((value) => {
    const finding = record(value, "Inspection model finding");
    exactKeys(
      finding,
      ["category", "severity", "message", "location", "evidenceReferenceIds", "sourceRule", "controlReferences"],
      "Inspection model finding",
    );
    const category = text(finding.category, "Inspection finding category", 100) as AssuranceFinding["category"];
    const severity = text(finding.severity, "Inspection finding severity", 20) as AssuranceFinding["severity"];
    if (!CATEGORIES.has(category) || !SEVERITIES.has(severity))
      throw new Error("Inspection finding 분류가 올바르지 않습니다");
    const message = text(finding.message, "Inspection finding message", 4_000);
    if (containsAssuranceCredential(message)) throw new Error("Inspection finding message에 credential이 있습니다");
    const evidenceReferenceIds = strings(finding.evidenceReferenceIds, "Inspection evidence reference", 100);
    if (
      evidenceReferenceIds.length === 0 ||
      evidenceReferenceIds.some((reference) => !evidenceAllowlist.has(reference) || !submittedEvidence.has(reference))
    ) {
      throw new Error("Inspection finding evidence reference가 allowlist 밖입니다");
    }
    const controlReferences = strings(finding.controlReferences, "Inspection control reference", 50);
    if (controlReferences.some((reference) => !controlAllowlist.has(reference))) {
      throw new Error("Inspection finding control reference가 allowlist 밖입니다");
    }
    let location: StructuredInspectionFinding["location"];
    if (finding.location !== undefined) {
      const rawLocation = record(finding.location, "Inspection finding location");
      exactKeys(rawLocation, ["uri", "line", "column"], "Inspection finding location");
      const line = positive(rawLocation.line, "Inspection location line");
      const column = positive(rawLocation.column, "Inspection location column");
      location = {
        uri: normalizeRepositoryUri(rawLocation.uri),
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
      };
    }
    return {
      category,
      severity,
      message,
      ...(location ? { location } : {}),
      evidenceReferenceIds,
      sourceTool: input.inspectorProfile,
      sourceRule: text(finding.sourceRule, "Inspection source rule", 200),
      controlReferences,
    };
  });
}

function outputSpec(input: ExecuteStructuredInspectionInput): StructuredOutputSpec {
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        maxItems: input.maximumFindings,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "severity", "message", "evidenceReferenceIds", "sourceRule", "controlReferences"],
          properties: {
            category: { type: "string", enum: [...CATEGORIES] },
            severity: { type: "string", enum: [...SEVERITIES] },
            message: { type: "string", minLength: 1, maxLength: 4_000 },
            location: {
              type: "object",
              additionalProperties: false,
              required: ["uri"],
              properties: {
                uri: { type: "string", minLength: 1, maxLength: 2_000 },
                line: { type: "integer", minimum: 1 },
                column: { type: "integer", minimum: 1 },
              },
            },
            evidenceReferenceIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
            sourceRule: { type: "string", minLength: 1, maxLength: 200 },
            controlReferences: { type: "array", maxItems: 50, items: { type: "string" } },
          },
        },
      },
    },
  } as const;
  return {
    name: "massion_assurance_findings",
    description: "기존 evidence에서 구조화된 finding만 추출합니다. 통과 판정을 출력하지 않습니다.",
    jsonSchema,
    validate(value) {
      try {
        parseOutput(value, input);
        return { success: true, value };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error("Inspection output 검증 실패") };
      }
    },
  };
}

function blocked(
  input: ExecuteStructuredInspectionInput,
  category: string,
  executionId?: string,
): StructuredInspectionResult {
  return {
    status: "blocked",
    outputHash: sha256(
      canonicalJson({ category, assuranceRunId: input.assuranceRunId, criterionId: input.criterionId }),
    ),
    summary: "Structured inspection을 판정할 수 없습니다",
    ...(executionId ? { executionId } : {}),
    findings: [],
  };
}

export async function executeStructuredInspection(
  runner: StructuredAgentRunner | undefined,
  context: TenantContext,
  input: ExecuteStructuredInspectionInput,
): Promise<StructuredInspectionResult> {
  validateInput(input);
  if (!runner) return blocked(input, "model_runner_unavailable");
  let result;
  try {
    result = await runner.executeStructured(
      context,
      {
        commandId: input.commandId,
        workId: input.workId,
        agentHandle: input.agentHandle,
        modelRoute: input.modelRoute,
        correlationId: input.correlationId,
        estimatedTokens: input.estimatedTokens,
        estimatedCostMicros: input.estimatedCostMicros,
        input: {
          operation: "assurance_inspection",
          assuranceRunId: input.assuranceRunId,
          criterionId: input.criterionId,
          inspectorProfile: input.inspectorProfile,
          evidence: input.evidence,
          evidenceReferenceAllowlist: input.evidenceReferenceAllowlist,
          controlReferenceAllowlist: input.controlReferenceAllowlist,
        },
      },
      outputSpec(input),
    );
  } catch {
    return blocked(input, "model_execution_error");
  }
  if (result.status !== "succeeded") return blocked(input, "model_execution_unavailable", result.executionId);
  let findings: StructuredInspectionFinding[];
  try {
    findings = parseOutput(result.output, input);
  } catch {
    return blocked(input, "model_output_invalid", result.executionId);
  }
  return {
    status: "passed",
    outputHash: sha256(
      canonicalJson({
        assuranceRunId: input.assuranceRunId,
        criterionId: input.criterionId,
        executionId: result.executionId,
        inspectorProfile: input.inspectorProfile,
        findings,
      }),
    ),
    summary: `Structured inspection finding ${String(findings.length)}건`,
    executionId: result.executionId,
    findings,
  };
}

export interface StructuredInspectionEvidenceLoader {
  load(
    context: TenantContext,
    input: TrustedAssuranceInspectionExecutionInput,
  ): Promise<readonly StructuredInspectionEvidence[]>;
}

interface ArtifactEvidenceRecord {
  readonly artifact_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly checksum: string;
  readonly content_json: string;
  readonly created_at: unknown;
}

interface BriefEvidenceRecord {
  readonly evidence_brief_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly index_version_id: string;
  readonly configuration_checksum: string;
  readonly query: string;
  readonly status: EvidenceBriefEvidence["status"];
  readonly references_json: string;
  readonly checksum: string;
  readonly claims_json: string;
  readonly created_at: unknown;
}

function iso(value: unknown, label: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw || Number.isNaN(new Date(raw).getTime())) throw new Error(`${label} 시각이 올바르지 않습니다`);
  return new Date(raw).toISOString();
}

function allowsEvidence(
  binding: TrustedAssuranceInspectionExecutionInput["binding"],
  kind: string,
  id: string,
): boolean {
  return binding.evidenceAllowlist.includes(kind) || binding.evidenceAllowlist.includes(id);
}

/** Inspection prompt evidence를 caller payload가 아니라 tenant DB 정본에서 만드는 loader입니다. */
export class DatabaseStructuredInspectionEvidenceLoader implements StructuredInspectionEvidenceLoader {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async load(
    context: TenantContext,
    input: TrustedAssuranceInspectionExecutionInput,
  ): Promise<readonly StructuredInspectionEvidence[]> {
    await this.organizations.verifyTenantContext(context);
    if (input.artifactVersionIds.length + input.evidenceBriefIds.length === 0) {
      throw new Error("Structured inspection evidence가 필요합니다");
    }
    const evidence: StructuredInspectionEvidence[] = [];
    const observedAt = new Date().toISOString();
    if (input.artifactVersionIds.length > 0) {
      if (input.artifactVersionIds.some((id) => !allowsEvidence(input.binding, "artifact-version", id))) {
        throw new Error("Inspection binding이 ArtifactVersion evidence를 허용하지 않습니다");
      }
      const [records] = await this.database.query<[ArtifactEvidenceRecord[]]>(
        "SELECT artifact_version_id, organization_id, work_id, checksum, content_json, created_at FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id IN $ids;",
        { organization_id: context.organizationId, work_id: input.workId, ids: input.artifactVersionIds },
      );
      if (records.length !== input.artifactVersionIds.length)
        throw new Error("Inspection ArtifactVersion이 완전하지 않습니다");
      for (const record of records) {
        const artifact: ArtifactEvidence = {
          artifactVersionId: record.artifact_version_id,
          organizationId: record.organization_id,
          workId: record.work_id,
          checksum: record.checksum,
          contentJson: record.content_json,
          createdAt: iso(record.created_at, "Inspection ArtifactVersion createdAt"),
        };
        verifyArtifactEvidence({
          organizationId: context.organizationId,
          workId: input.workId,
          allowedArtifactVersionIds: input.artifactVersionIds,
          observedAt,
          maximumAgeMs: input.binding.maximumAgeMs ?? DEFAULT_INSPECTION_MAXIMUM_AGE_MS,
          artifact,
        });
        evidence.push({
          evidenceReferenceId: record.artifact_version_id,
          kind: "artifact-version",
          checksum: record.checksum,
          summary: text(record.content_json, "Inspection ArtifactVersion content", 2_000),
        });
      }
    }
    if (input.evidenceBriefIds.length > 0) {
      if (input.evidenceBriefIds.some((id) => !allowsEvidence(input.binding, "evidence-brief", id))) {
        throw new Error("Inspection binding이 EvidenceBrief evidence를 허용하지 않습니다");
      }
      const [records] = await this.database.query<[BriefEvidenceRecord[]]>(
        "SELECT evidence_brief_id, organization_id, work_id, repository_id, repository_revision_id, index_version_id, configuration_checksum, query, status, references_json, claims_json, checksum, created_at FROM evidence_brief WHERE organization_id = $organization_id AND work_id = $work_id AND evidence_brief_id IN $ids;",
        { organization_id: context.organizationId, work_id: input.workId, ids: input.evidenceBriefIds },
      );
      if (records.length !== input.evidenceBriefIds.length)
        throw new Error("Inspection EvidenceBrief가 완전하지 않습니다");
      for (const record of records) {
        const [indexes] = await this.database.query<
          [{ repository_revision_id: string; index_version_id: string; configuration_checksum: string }[]]
        >(
          "SELECT repository_revision_id, index_version_id, configuration_checksum FROM index_version WHERE organization_id = $organization_id AND repository_id = $repository_id AND current = true AND status = 'ready' LIMIT 1;",
          { organization_id: context.organizationId, repository_id: record.repository_id },
        );
        const current = indexes[0];
        if (!current) throw new Error("Inspection EvidenceBrief repository의 현재 ready IndexVersion이 없습니다");
        verifyEvidenceBriefFreshness({
          organizationId: context.organizationId,
          workId: input.workId,
          observedAt,
          maximumAgeMs: input.binding.maximumAgeMs ?? DEFAULT_INSPECTION_MAXIMUM_AGE_MS,
          current: {
            repositoryRevisionId: current.repository_revision_id,
            indexVersionId: current.index_version_id,
            configurationChecksum: current.configuration_checksum,
          },
          brief: {
            evidenceBriefId: record.evidence_brief_id,
            organizationId: record.organization_id,
            workId: record.work_id,
            repositoryId: record.repository_id,
            repositoryRevisionId: record.repository_revision_id,
            indexVersionId: record.index_version_id,
            configurationChecksum: record.configuration_checksum,
            query: record.query,
            status: record.status,
            referencesJson: record.references_json,
            claimsJson: record.claims_json,
            checksum: record.checksum,
            createdAt: iso(record.created_at, "Inspection EvidenceBrief createdAt"),
          },
        });
        evidence.push({
          evidenceReferenceId: record.evidence_brief_id,
          kind: "evidence-brief",
          checksum: record.checksum,
          summary: text(record.claims_json, "Inspection EvidenceBrief claims", 2_000),
        });
      }
    }
    return evidence.sort((left, right) => left.evidenceReferenceId.localeCompare(right.evidenceReferenceId));
  }
}

/** StructuredAgentRunner 결과와 Check/Finding 원자 저장 경로를 연결하는 trusted executor입니다. */
export class StructuredAssuranceInspectionExecutor implements TrustedAssuranceInspectionExecutor {
  public readonly inspectorProfile: string;

  public constructor(
    private readonly runner: StructuredAgentRunner | undefined,
    private readonly evidenceLoader: StructuredInspectionEvidenceLoader,
    private readonly config: {
      readonly inspectorProfile: string;
      readonly modelRoute: string;
      readonly estimatedTokens: number;
      readonly estimatedCostMicros: number;
    },
  ) {
    this.inspectorProfile = config.inspectorProfile;
  }

  public async execute(
    context: TenantContext,
    input: TrustedAssuranceInspectionExecutionInput,
  ): Promise<TrustedAssuranceInspectionExecutionResult> {
    if (input.binding.inspectorProfile !== this.inspectorProfile) {
      throw new Error("Inspection executor profile이 binding과 일치하지 않습니다");
    }
    let evidence: readonly StructuredInspectionEvidence[];
    try {
      evidence = await this.evidenceLoader.load(context, input);
    } catch {
      return {
        status: "blocked",
        outputHash: sha256(canonicalJson({ category: "inspection_evidence_invalid", input })),
        summary: "Structured inspection evidence를 검증할 수 없습니다",
        evidenceReferenceIds: [],
        artifactVersionIds: [],
        evidenceBriefIds: [],
        metricObservationIds: [],
        humanAttestationIds: [],
        toolName: this.inspectorProfile,
        toolVersion: "1.0.0",
        durationMs: 0,
        findings: [],
      };
    }
    const startedAt = Date.now();
    const result = await executeStructuredInspection(this.runner, context, {
      commandId: input.verificationId,
      workId: input.workId,
      assuranceRunId: input.assuranceRunId,
      criterionId: input.criterionId,
      agentHandle: input.binding.executor.kind === "runtime_agent" ? input.binding.executor.handle : "assurance",
      modelRoute: this.config.modelRoute,
      correlationId: input.verificationId,
      inspectorProfile: this.inspectorProfile,
      evidence,
      evidenceReferenceAllowlist: evidence.map((item) => item.evidenceReferenceId),
      controlReferenceAllowlist: input.controlReferences,
      maximumFindings: input.binding.maximumFindings,
      estimatedTokens: this.config.estimatedTokens,
      estimatedCostMicros: this.config.estimatedCostMicros,
    });
    return {
      status: result.status,
      outputHash: result.outputHash,
      summary: result.summary,
      ...(result.executionId ? { executionId: result.executionId } : {}),
      evidenceReferenceIds: evidence.map((item) => item.evidenceReferenceId),
      artifactVersionIds: input.artifactVersionIds,
      evidenceBriefIds: input.evidenceBriefIds,
      metricObservationIds: [],
      humanAttestationIds: [],
      toolName: this.inspectorProfile,
      toolVersion: "1.0.0",
      durationMs: Math.max(0, Date.now() - startedAt),
      findings: result.findings,
    };
  }
}
