import type { TenantContext } from "@massion/identity";
import type { OrganizationService } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import { GROWTH_REFLECTION_MIGRATION } from "./schema.js";

import { createReflectionSnapshot, type ReflectionSnapshot } from "./snapshot.js";
import type { ReflectionSourceReference } from "./snapshot.js";
import type { GrowthTrigger } from "./trigger.js";
import { validateGrowthSuggestionSecurity } from "./security.js";

export type SuggestionTargetKind = "prompt" | "memory" | "policy" | "organization";

export interface SuggestionCandidate {
  readonly targetKind: SuggestionTargetKind;
  readonly operation: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly rationale: string;
  readonly expectedEffect: string;
  readonly riskSummary: string;
  readonly sourceReferenceIds: readonly string[];
}

export interface ReflectionGenerator {
  generate(
    context: TenantContext,
    input: { readonly reflectionRunId: string; readonly snapshot: ReflectionSnapshot },
  ): Promise<readonly SuggestionCandidate[]>;
}

export interface ReflectionSourceVerifier {
  verify(
    context: TenantContext,
    source: ReflectionSourceReference,
  ): Promise<{ readonly checksum: string; readonly capturedRevision: string; readonly fresh: boolean }>;
}

export interface ReflectionRunRecord {
  readonly reflection_run_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly records_run_id: string;
  readonly trigger_id: string;
  readonly configuration_version_id: string;
  readonly snapshot_hash: string;
  readonly status: "planned" | "generating" | "validated" | "completed" | "blocked" | "cancelled";
  readonly version: number;
  readonly attempt: number;
  readonly command_id: string;
  readonly request_hash: string;
}

export interface GrowthSuggestionRecord {
  readonly suggestion_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly reflection_run_id: string;
  readonly target_kind: SuggestionTargetKind;
  readonly operation: string;
  readonly patch_json: string;
  readonly summary: string;
  readonly rationale: string;
  readonly expected_effect: string;
  readonly risk_summary: string;
  readonly source_reference_ids: readonly string[];
  readonly status: "proposed" | "evaluated" | "awaiting-review" | "adopted" | "rejected" | "superseded";
}

const MAX_TEXT = 2_000;
const INJECTION = /ignore previous|system prompt|reveal secrets?|이전\s*지시.*무시|비밀.*공개/iu;
const OPERATIONS: Readonly<Record<SuggestionTargetKind, Readonly<Record<string, readonly string[]>>>> = {
  prompt: { "replace-instruction": ["agentHandle", "instruction"] },
  memory: { "add-entry": ["kind", "key", "value"] },
  policy: { "replace-policy": ["policyId", "policyText"] },
  organization: { "change-node": ["handle", "responsibility"] },
};

function text(value: string, label: string): void {
  if (!value.trim() || value.length > MAX_TEXT) throw new Error(`${label} 크기는 1~2000자여야 합니다`);
  if (INJECTION.test(value)) throw new Error(`${label}에 prompt injection 지시가 포함됐습니다`);
}

export function validateSuggestionCandidate(
  candidate: SuggestionCandidate,
  snapshot: ReflectionSnapshot,
): SuggestionCandidate {
  validateGrowthSuggestionSecurity(candidate);
  text(candidate.summary, "Suggestion summary");
  text(candidate.rationale, "Suggestion rationale");
  text(candidate.expectedEffect, "Suggestion expected effect");
  text(candidate.riskSummary, "Suggestion risk summary");
  const expected = OPERATIONS[candidate.targetKind][candidate.operation];
  if (!expected) throw new Error("지원하지 않는 target 또는 operation입니다");
  const patchKeys = Object.keys(candidate.patch).sort();
  if (patchKeys.length !== expected.length || !expected.every((key) => patchKeys.includes(key))) {
    throw new Error("Suggestion patch schema가 target operation과 일치하지 않습니다");
  }
  for (const value of Object.values(candidate.patch)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 20_000) {
      throw new Error("Suggestion patch 값은 bounded string이어야 합니다");
    }
    if (INJECTION.test(value)) throw new Error("Suggestion patch에 prompt injection 지시가 포함됐습니다");
  }
  if (candidate.sourceReferenceIds.length === 0 || candidate.sourceReferenceIds.length > 100) {
    throw new Error("Suggestion source는 1~100개여야 합니다");
  }
  const known = new Set(snapshot.material.sources.map((source) => source.referenceId));
  if (candidate.sourceReferenceIds.some((id) => !known.has(id))) {
    throw new Error("Suggestion source가 Reflection snapshot에 없습니다");
  }
  return candidate;
}

export class ReflectionService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly generator: ReflectionGenerator,
    private readonly sourceVerifier: ReflectionSourceVerifier,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    generator: ReflectionGenerator,
    sourceVerifier: ReflectionSourceVerifier,
  ): Promise<ReflectionService> {
    await applyMigrations(database, [GROWTH_REFLECTION_MIGRATION]);
    return new ReflectionService(database, organizations, generator, sourceVerifier);
  }

  public async run(
    context: TenantContext,
    input: { readonly commandId: string; readonly trigger: GrowthTrigger; readonly snapshot: ReflectionSnapshot },
  ): Promise<{ readonly run: ReflectionRunRecord; readonly suggestions: readonly GrowthSuggestionRecord[] }> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = growthChecksum({
      commandId: input.commandId,
      triggerId: input.trigger.trigger_id,
      snapshotHash: input.snapshot.hash,
    });
    const [replayed] = await this.database.query<[ReflectionRunRecord[]]>(
      "SELECT * FROM reflection_run WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    if (replayed[0]) {
      if (replayed[0].request_hash !== requestHash)
        throw new Error("같은 commandId에 다른 Reflection 요청을 사용할 수 없습니다");
      return {
        run: replayed[0],
        suggestions: await this.suggestions(context.organizationId, replayed[0].reflection_run_id),
      };
    }
    const canonical = createReflectionSnapshot(input.snapshot.material);
    if (canonical.hash !== input.snapshot.hash) throw new Error("ReflectionSnapshot hash가 일치하지 않습니다");
    for (const source of canonical.material.sources) {
      const verified = await this.sourceVerifier.verify(context, source);
      if (
        !verified.fresh ||
        verified.checksum !== source.checksum ||
        verified.capturedRevision !== source.capturedRevision
      ) {
        throw new Error(`Reflection source가 stale하거나 checksum이 다릅니다: ${source.referenceId}`);
      }
    }
    const [triggers] = await this.database.query<[GrowthTrigger[]]>(
      "SELECT * FROM growth_trigger WHERE organization_id = $organization_id AND trigger_id = $trigger_id LIMIT 1;",
      { organization_id: context.organizationId, trigger_id: input.trigger.trigger_id },
    );
    const trigger = triggers[0];
    if (!trigger || trigger.status !== "claimed" || !trigger.configuration_version_id) {
      throw new Error("claimed Growth trigger와 configuration version이 필요합니다");
    }
    if (
      trigger.work_id !== canonical.material.workId ||
      trigger.records_run_id !== canonical.material.recordsRunId ||
      trigger.work_record_id !== canonical.material.workRecordId ||
      trigger.configuration_version_id !== canonical.material.configurationVersionId
    ) {
      throw new Error("Growth trigger와 ReflectionSnapshot 계보가 일치하지 않습니다");
    }
    const reflectionRunId = crypto.randomUUID();
    const [created] = await this.database.query<[ReflectionRunRecord[]]>(
      "CREATE reflection_run CONTENT { reflection_run_id: $reflection_run_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, trigger_id: $trigger_id, configuration_version_id: $configuration_version_id, snapshot_hash: $snapshot_hash, status: 'generating', version: 1, attempt: 1, command_id: $command_id, request_hash: $request_hash, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
      {
        reflection_run_id: reflectionRunId,
        organization_id: context.organizationId,
        work_id: trigger.work_id,
        records_run_id: trigger.records_run_id,
        trigger_id: trigger.trigger_id,
        configuration_version_id: trigger.configuration_version_id,
        snapshot_hash: canonical.hash,
        command_id: input.commandId,
        request_hash: requestHash,
      },
    );
    if (!created[0]) throw new Error("ReflectionRun 생성 결과가 없습니다");
    try {
      const candidates = await this.generator.generate(context, { reflectionRunId, snapshot: canonical });
      if (candidates.length > 100) throw new Error("Reflection suggestion은 100개 이하여야 합니다");
      const suggestions: GrowthSuggestionRecord[] = [];
      for (const raw of candidates) {
        const candidate = validateSuggestionCandidate(raw, canonical);
        const suggestionId = crypto.randomUUID();
        const [records] = await this.database.query<[GrowthSuggestionRecord[]]>(
          "CREATE growth_suggestion CONTENT { suggestion_id: $suggestion_id, organization_id: $organization_id, work_id: $work_id, reflection_run_id: $reflection_run_id, target_kind: $target_kind, operation: $operation, patch_json: $patch_json, summary: $summary, rationale: $rationale, expected_effect: $expected_effect, risk_summary: $risk_summary, source_reference_ids: $source_reference_ids, status: 'proposed', created_at: time::now() } RETURN AFTER;",
          {
            suggestion_id: suggestionId,
            organization_id: context.organizationId,
            work_id: trigger.work_id,
            reflection_run_id: reflectionRunId,
            target_kind: candidate.targetKind,
            operation: candidate.operation,
            patch_json: canonicalGrowthJson(candidate.patch),
            summary: candidate.summary,
            rationale: candidate.rationale,
            expected_effect: candidate.expectedEffect,
            risk_summary: candidate.riskSummary,
            source_reference_ids: candidate.sourceReferenceIds,
          },
        );
        if (!records[0]) throw new Error("GrowthSuggestion 생성 결과가 없습니다");
        suggestions.push(records[0]);
        for (const sourceId of candidate.sourceReferenceIds) {
          const source = canonical.material.sources.find((reference) => reference.referenceId === sourceId);
          if (!source) throw new Error("검증된 Reflection source를 찾을 수 없습니다");
          await this.database.query(
            "CREATE growth_source_reference CONTENT { source_reference_id: $source_reference_id, organization_id: $organization_id, work_id: $work_id, suggestion_id: $suggestion_id, source_kind: $source_kind, source_id: $source_id, source_checksum: $source_checksum, captured_revision: $captured_revision, created_at: time::now() };",
            {
              source_reference_id: crypto.randomUUID(),
              organization_id: context.organizationId,
              work_id: trigger.work_id,
              suggestion_id: suggestionId,
              source_kind: source.kind,
              source_id: source.referenceId,
              source_checksum: source.checksum,
              captured_revision: source.capturedRevision,
            },
          );
        }
      }
      const [completed] = await this.database.query<[ReflectionRunRecord[]]>(
        "UPDATE reflection_run SET status = 'completed', version += 1, updated_at = time::now() WHERE organization_id = $organization_id AND reflection_run_id = $reflection_run_id RETURN AFTER; UPDATE growth_trigger SET status = 'completed', worker_id = NONE, lease_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND trigger_id = $trigger_id;",
        {
          organization_id: context.organizationId,
          reflection_run_id: reflectionRunId,
          trigger_id: trigger.trigger_id,
        },
      );
      if (!completed[0]) throw new Error("ReflectionRun 완료 결과가 없습니다");
      await this.database.query(
        "CREATE growth_event CONTENT { event_id: $event_id, organization_id: $organization_id, aggregate_type: 'reflection-run', aggregate_id: $aggregate_id, event_type: 'reflection_completed', payload_json: $payload_json, created_at: time::now() };",
        {
          event_id: crypto.randomUUID(),
          organization_id: context.organizationId,
          aggregate_id: reflectionRunId,
          payload_json: canonicalGrowthJson({ suggestionCount: suggestions.length }),
        },
      );
      return { run: completed[0], suggestions };
    } catch (error) {
      await this.database.query(
        "UPDATE reflection_run SET status = 'blocked', version += 1, failure_json = $failure_json, updated_at = time::now() WHERE organization_id = $organization_id AND reflection_run_id = $reflection_run_id; UPDATE growth_trigger SET status = 'blocked', worker_id = NONE, lease_expires_at = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND trigger_id = $trigger_id;",
        {
          organization_id: context.organizationId,
          reflection_run_id: reflectionRunId,
          trigger_id: trigger.trigger_id,
          failure_json: canonicalGrowthJson({
            category: "reflection-validation",
            causeHash: growthChecksum(String(error)),
          }),
        },
      );
      throw error;
    }
  }

  private async suggestions(organizationId: string, reflectionRunId: string): Promise<GrowthSuggestionRecord[]> {
    const [records] = await this.database.query<[GrowthSuggestionRecord[]]>(
      "SELECT * FROM growth_suggestion WHERE organization_id = $organization_id AND reflection_run_id = $reflection_run_id ORDER BY suggestion_id ASC;",
      { organization_id: organizationId, reflection_run_id: reflectionRunId },
    );
    return records;
  }
}
