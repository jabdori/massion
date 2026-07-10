import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type { AssuranceFinding, AssuranceFindingSeverity } from "./contracts.js";

type FindingCategory = AssuranceFinding["category"];

export interface RecordAssuranceFindingInput {
  readonly commandId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId?: string;
  readonly category: FindingCategory;
  readonly severity: AssuranceFindingSeverity;
  readonly message: string;
  readonly location?: Readonly<Record<string, unknown>>;
  readonly evidenceReferenceIds: readonly string[];
  readonly sourceTool: string;
  readonly sourceRule: string;
  readonly controlReferences: readonly string[];
}

export interface ResolveAssuranceFindingInput {
  readonly commandId: string;
  readonly findingId: string;
  readonly status: "resolved" | "accepted";
  readonly reason: string;
}

interface FindingRecord {
  readonly finding_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly assurance_run_id: string;
  readonly criterion_id?: string;
  readonly fingerprint: string;
  readonly category: FindingCategory;
  readonly severity: AssuranceFindingSeverity;
  readonly status: AssuranceFinding["status"];
  readonly message: string;
  readonly location_json?: string;
  readonly evidence_reference_ids: readonly string[];
  readonly source_tool?: string;
  readonly source_rule?: string;
  readonly control_references: readonly string[];
  readonly resolution_reason?: string;
  readonly resolution_actor_id?: string;
  readonly resolved_at?: unknown;
  readonly created_at: unknown;
}

interface RunRecord {
  readonly work_id: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly status: string;
}

interface CriterionRecord {
  readonly criterion_id: string;
}

interface CheckEvidenceRecord {
  readonly artifact_version_ids: readonly string[];
  readonly evidence_brief_ids: readonly string[];
  readonly metric_observation_ids: readonly string[];
  readonly human_attestation_ids: readonly string[];
}

interface EventRecord {
  readonly event_type: string;
  readonly request_hash: string;
  readonly payload_json: string;
}

const CATEGORIES = new Set<FindingCategory>(["correctness", "security", "reliability", "operability", "supply-chain"]);
const SEVERITIES = new Set<AssuranceFindingSeverity>(["critical", "major", "minor", "info"]);

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

export function assuranceFindingFingerprint(input: {
  readonly category: FindingCategory;
  readonly sourceTool: string;
  readonly sourceRule: string;
  readonly location?: Readonly<Record<string, unknown>>;
}): string {
  return sha256(
    canonicalJson({
      category: input.category,
      sourceTool: input.sourceTool,
      sourceRule: input.sourceRule,
      location: input.location ?? null,
    }),
  );
}

function text(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}이 필요합니다`);
  if (normalized.length > maximum) throw new Error(`${label}은 ${String(maximum)}자 이하여야 합니다`);
  return normalized;
}

function normalizedList(values: readonly string[], label: string, maximum: number): readonly string[] {
  if (values.length > maximum) throw new Error(`${label}은 ${String(maximum)}개 이하여야 합니다`);
  const normalized = [...new Set(values.map((value) => text(value, label, 500)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label}에 중복 값이 있습니다`);
  return normalized;
}

function isoDateTime(value: unknown, label: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "toISOString" in value
        ? String((value as { toISOString(): unknown }).toISOString())
        : undefined;
  if (!raw) throw new Error(`${label}을 직렬화할 수 없습니다`);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}이 올바르지 않습니다`);
  return parsed.toISOString();
}

function view(record: FindingRecord): AssuranceFinding {
  return {
    findingId: record.finding_id,
    organizationId: record.organization_id,
    workId: record.work_id,
    assuranceRunId: record.assurance_run_id,
    ...(record.criterion_id ? { criterionId: record.criterion_id } : {}),
    fingerprint: record.fingerprint,
    category: record.category,
    severity: record.severity,
    status: record.status,
    message: record.message,
    ...(record.location_json ? { locationJson: record.location_json } : {}),
    evidenceReferenceIds: record.evidence_reference_ids,
    ...(record.source_tool ? { sourceTool: record.source_tool } : {}),
    ...(record.source_rule ? { sourceRule: record.source_rule } : {}),
    controlReferences: record.control_references,
    ...(record.resolution_reason ? { resolutionReason: record.resolution_reason } : {}),
    ...(record.resolution_actor_id ? { resolutionActorId: record.resolution_actor_id } : {}),
    ...(record.resolved_at ? { resolvedAt: isoDateTime(record.resolved_at, "Finding resolvedAt") } : {}),
    createdAt: isoDateTime(record.created_at, "Finding createdAt"),
  };
}

function acceptedSeverities(profileId: string, profileVersion: string): ReadonlySet<AssuranceFindingSeverity> {
  if (profileVersion !== "1.0.0") return new Set();
  if (profileId === "massion.assurance.software-change.v1") return new Set(["minor", "info"]);
  if (profileId === "massion.assurance.acceptance.v1") return new Set(["info"]);
  return new Set();
}

export class AssuranceFindingStore {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async record(context: TenantContext, input: RecordAssuranceFindingInput): Promise<AssuranceFinding> {
    await this.organizations.verifyTenantContext(context);
    const normalized = this.normalizeRecord(input);
    const requestHash = sha256(
      canonicalJson({ operation: "record_assurance_finding", input: normalized, actorUserId: context.userId }),
    );
    const replayedId = await this.replay(context.organizationId, input.commandId, requestHash, this.database);
    if (replayedId) return view(await this.find(this.database, context.organizationId, replayedId));

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrentId = await this.replay(context.organizationId, input.commandId, requestHash, transaction);
      if (concurrentId) return view(await this.find(transaction, context.organizationId, concurrentId));
      await this.verifyTarget(transaction, context.organizationId, normalized);
      await this.verifyEvidence(transaction, context.organizationId, normalized);
      const fingerprint = assuranceFindingFingerprint(normalized);
      const [existingRecords] = await transaction.query<[FindingRecord[]]>(
        "SELECT * OMIT id FROM assurance_finding WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND fingerprint = $fingerprint LIMIT 1;",
        {
          organization_id: context.organizationId,
          assurance_run_id: normalized.assuranceRunId,
          fingerprint,
        },
      );
      const existing = existingRecords[0];
      if (existing) {
        if (!this.sameFinding(existing, normalized)) throw new Error("Assurance finding fingerprint 충돌입니다");
        await this.recordEvent(
          transaction,
          context,
          normalized,
          requestHash,
          existing.finding_id,
          "assurance_finding_deduplicated",
        );
        return view(existing);
      }
      const findingId = randomUUID();
      const [records] = await transaction.query<[FindingRecord[]]>(
        "CREATE assurance_finding CONTENT { finding_id: $finding_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, fingerprint: $fingerprint, category: $category, severity: $severity, status: 'open', message: $message, location_json: $location_json, evidence_reference_ids: $evidence_reference_ids, source_tool: $source_tool, source_rule: $source_rule, control_references: $control_references, created_at: time::now() } RETURN AFTER;",
        {
          finding_id: findingId,
          organization_id: context.organizationId,
          work_id: normalized.workId,
          assurance_run_id: normalized.assuranceRunId,
          criterion_id: normalized.criterionId,
          fingerprint,
          category: normalized.category,
          severity: normalized.severity,
          message: normalized.message,
          location_json: normalized.location ? canonicalJson(normalized.location) : undefined,
          evidence_reference_ids: normalized.evidenceReferenceIds,
          source_tool: normalized.sourceTool,
          source_rule: normalized.sourceRule,
          control_references: normalized.controlReferences,
        },
      );
      const created = records[0];
      if (!created) throw new Error("AssuranceFinding 생성 결과가 없습니다");
      await this.recordEvent(transaction, context, normalized, requestHash, findingId, "assurance_finding_recorded");
      return view(created);
    });
  }

  public async resolve(context: TenantContext, input: ResolveAssuranceFindingInput): Promise<AssuranceFinding> {
    if ("resolutionActorId" in (input as unknown as Record<string, unknown>)) {
      throw new Error("Finding resolution actor는 caller가 지정할 수 없습니다");
    }
    await this.organizations.verifyTenantContext(context);
    const commandId = text(input.commandId, "Finding resolution command ID");
    const findingId = text(input.findingId, "Finding ID");
    const reason = text(input.reason, "Finding resolution 사유", 2_000);
    if (!(["resolved", "accepted"] as const).includes(input.status)) {
      throw new Error("Finding resolution status가 올바르지 않습니다");
    }
    const normalized = { commandId, findingId, status: input.status, reason };
    const requestHash = sha256(
      canonicalJson({ operation: "resolve_assurance_finding", input: normalized, actorUserId: context.userId }),
    );
    const replayedId = await this.replay(context.organizationId, commandId, requestHash, this.database);
    if (replayedId) return view(await this.find(this.database, context.organizationId, replayedId));

    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const concurrentId = await this.replay(context.organizationId, commandId, requestHash, transaction);
      if (concurrentId) return view(await this.find(transaction, context.organizationId, concurrentId));
      const finding = await this.find(transaction, context.organizationId, findingId);
      if (finding.status !== "open") throw new Error("Open Assurance finding만 resolve할 수 있습니다");
      const run = await this.findRun(transaction, context.organizationId, finding.work_id, finding.assurance_run_id);
      if (input.status === "accepted") {
        if (["critical", "major"].includes(finding.severity)) {
          throw new Error(`${finding.severity} Assurance finding은 수용할 수 없습니다`);
        }
        if (!acceptedSeverities(run.profile_id, run.profile_version).has(finding.severity)) {
          throw new Error("Assurance profile이 해당 finding severity 수용을 허용하지 않습니다");
        }
      }
      const [records] = await transaction.query<[FindingRecord[]]>(
        "UPDATE assurance_finding SET status = $status, resolution_reason = $resolution_reason, resolution_actor_id = $resolution_actor_id, resolved_at = time::now() WHERE organization_id = $organization_id AND finding_id = $finding_id RETURN AFTER;",
        {
          status: input.status,
          resolution_reason: reason,
          resolution_actor_id: context.userId,
          organization_id: context.organizationId,
          finding_id: findingId,
        },
      );
      const updated = records[0];
      if (!updated) throw new Error("AssuranceFinding resolution 결과가 없습니다");
      await this.recordEvent(
        transaction,
        context,
        { assuranceRunId: finding.assurance_run_id, commandId },
        requestHash,
        findingId,
        `assurance_finding_${input.status}`,
      );
      return view(updated);
    });
  }

  private normalizeRecord(input: RecordAssuranceFindingInput): RecordAssuranceFindingInput {
    const commandId = text(input.commandId, "Finding command ID");
    const workId = text(input.workId, "Work ID");
    const assuranceRunId = text(input.assuranceRunId, "Assurance run ID");
    const criterionId = input.criterionId ? text(input.criterionId, "Assurance criterion ID") : undefined;
    if (!CATEGORIES.has(input.category)) throw new Error("Finding category가 올바르지 않습니다");
    if (!SEVERITIES.has(input.severity)) throw new Error("Finding severity가 올바르지 않습니다");
    const message = text(input.message, "Finding message", 4_000);
    const sourceTool = text(input.sourceTool, "Finding source tool");
    const sourceRule = text(input.sourceRule, "Finding source rule");
    const evidenceReferenceIds = normalizedList(input.evidenceReferenceIds, "Finding evidence reference", 100);
    if (evidenceReferenceIds.length === 0) throw new Error("Finding에는 evidence reference가 필요합니다");
    const controlReferences = normalizedList(input.controlReferences, "Finding control reference", 50);
    if (input.location && canonicalJson(input.location).length > 4_000)
      throw new Error("Finding location은 4000자 이하여야 합니다");
    return {
      commandId,
      workId,
      assuranceRunId,
      ...(criterionId ? { criterionId } : {}),
      category: input.category,
      severity: input.severity,
      message,
      ...(input.location ? { location: input.location } : {}),
      evidenceReferenceIds,
      sourceTool,
      sourceRule,
      controlReferences,
    };
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor,
  ): Promise<string | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT event_type, request_hash, payload_json FROM assurance_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (event.request_hash !== requestHash)
      throw new Error("같은 commandId를 다른 Assurance finding payload에 재사용할 수 없습니다");
    const payload = JSON.parse(event.payload_json) as { findingId?: unknown };
    if (typeof payload.findingId !== "string") throw new Error("Assurance finding Event payload가 올바르지 않습니다");
    return payload.findingId;
  }

  private async find(executor: QueryExecutor, organizationId: string, findingId: string): Promise<FindingRecord> {
    const [records] = await executor.query<[FindingRecord[]]>(
      "SELECT * OMIT id FROM assurance_finding WHERE organization_id = $organization_id AND finding_id = $finding_id LIMIT 1;",
      { organization_id: organizationId, finding_id: findingId },
    );
    if (!records[0]) throw new Error("Assurance finding을 찾을 수 없습니다");
    return records[0];
  }

  private async findRun(
    executor: QueryExecutor,
    organizationId: string,
    workId: string,
    assuranceRunId: string,
  ): Promise<RunRecord> {
    const [runs] = await executor.query<[RunRecord[]]>(
      "SELECT work_id, profile_id, profile_version, status FROM assurance_run WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id LIMIT 1;",
      { organization_id: organizationId, work_id: workId, assurance_run_id: assuranceRunId },
    );
    if (!runs[0]) throw new Error("Assurance finding의 run을 찾을 수 없습니다");
    return runs[0];
  }

  private async verifyTarget(
    executor: QueryExecutor,
    organizationId: string,
    input: RecordAssuranceFindingInput,
  ): Promise<void> {
    const run = await this.findRun(executor, organizationId, input.workId, input.assuranceRunId);
    if (!["planned", "running"].includes(run.status))
      throw new Error("활성 Assurance run에만 finding을 기록할 수 있습니다");
    if (input.criterionId) {
      const [criteria] = await executor.query<[CriterionRecord[]]>(
        "SELECT criterion_id FROM assurance_criterion WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id LIMIT 1;",
        {
          organization_id: organizationId,
          work_id: input.workId,
          assurance_run_id: input.assuranceRunId,
          criterion_id: input.criterionId,
        },
      );
      if (!criteria[0]) throw new Error("Assurance finding criterion을 찾을 수 없습니다");
    }
  }

  private async verifyEvidence(
    executor: QueryExecutor,
    organizationId: string,
    input: RecordAssuranceFindingInput,
  ): Promise<void> {
    const [checks] = await executor.query<[CheckEvidenceRecord[]]>(
      `SELECT artifact_version_ids, evidence_brief_ids, metric_observation_ids, human_attestation_ids
       FROM assurance_check
       WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id
       ${input.criterionId ? "AND criterion_id = $criterion_id" : ""};`,
      {
        organization_id: organizationId,
        work_id: input.workId,
        assurance_run_id: input.assuranceRunId,
        criterion_id: input.criterionId,
      },
    );
    const attached = new Set(
      checks.flatMap((check) => [
        ...check.artifact_version_ids,
        ...check.evidence_brief_ids,
        ...check.metric_observation_ids,
        ...check.human_attestation_ids,
      ]),
    );
    for (const referenceId of input.evidenceReferenceIds) {
      if (!attached.has(referenceId))
        throw new Error(`Finding reference가 같은 run의 check evidence가 아닙니다: ${referenceId}`);
      const [artifacts] = await executor.query<[{ checksum: string; content_json: string }[]]>(
        "SELECT checksum, content_json FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $reference_id LIMIT 1;",
        { organization_id: organizationId, work_id: input.workId, reference_id: referenceId },
      );
      if (artifacts[0]) {
        if (sha256(artifacts[0].content_json) !== artifacts[0].checksum) {
          throw new Error("Finding ArtifactVersion evidence checksum이 일치하지 않습니다");
        }
        continue;
      }
      const [metrics] = await executor.query<[{ observation_id: string }[]]>(
        "SELECT observation_id FROM assurance_metric_observation WHERE organization_id = $organization_id AND work_id = $work_id AND observation_id = $reference_id LIMIT 1;",
        { organization_id: organizationId, work_id: input.workId, reference_id: referenceId },
      );
      const [attestations] = await executor.query<[{ attestation_id: string }[]]>(
        "SELECT attestation_id FROM assurance_human_attestation WHERE organization_id = $organization_id AND work_id = $work_id AND assurance_run_id = $assurance_run_id AND attestation_id = $reference_id LIMIT 1;",
        {
          organization_id: organizationId,
          work_id: input.workId,
          assurance_run_id: input.assuranceRunId,
          reference_id: referenceId,
        },
      );
      const [briefs] = await executor.query<[{ evidence_brief_id: string }[]]>(
        "SELECT evidence_brief_id FROM evidence_brief WHERE organization_id = $organization_id AND work_id = $work_id AND evidence_brief_id = $reference_id LIMIT 1;",
        { organization_id: organizationId, work_id: input.workId, reference_id: referenceId },
      );
      if (!metrics[0] && !attestations[0] && !briefs[0]) {
        throw new Error(`Finding check evidence 실체를 찾을 수 없습니다: ${referenceId}`);
      }
    }
  }

  private sameFinding(existing: FindingRecord, input: RecordAssuranceFindingInput): boolean {
    return (
      existing.work_id === input.workId &&
      existing.assurance_run_id === input.assuranceRunId &&
      existing.criterion_id === input.criterionId &&
      existing.category === input.category &&
      existing.severity === input.severity &&
      existing.message === input.message &&
      existing.location_json === (input.location ? canonicalJson(input.location) : undefined) &&
      canonicalJson(existing.evidence_reference_ids) === canonicalJson(input.evidenceReferenceIds) &&
      existing.source_tool === input.sourceTool &&
      existing.source_rule === input.sourceRule &&
      canonicalJson(existing.control_references) === canonicalJson(input.controlReferences)
    );
  }

  private async recordEvent(
    executor: QueryExecutor,
    context: TenantContext,
    input: { readonly assuranceRunId: string; readonly commandId: string },
    requestHash: string,
    findingId: string,
    eventType: string,
  ): Promise<void> {
    const [events] = await executor.query<[{ sequence: number }[]]>(
      "SELECT sequence FROM assurance_event WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      { organization_id: context.organizationId, assurance_run_id: input.assuranceRunId },
    );
    const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    await executor.query(
      "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: $assurance_run_id, command_id: $command_id, sequence: $sequence, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        assurance_run_id: input.assuranceRunId,
        command_id: input.commandId,
        sequence,
        event_type: eventType,
        request_hash: requestHash,
        payload_json: canonicalJson({ findingId }),
        actor_user_id: context.userId,
      },
    );
  }
}
