import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { metricObservationChecksum } from "@massion/assurance";
import {
  GrowthAdoptionService,
  GrowthEvaluationStore,
  GrowthGateway,
  GrowthTargetRegistry,
  ReflectionService,
  createReflectionSnapshot,
  growthChecksum,
  type GrowthSuggestionDetails,
  type GrowthSuggestionRecord,
  type GrowthTrigger,
} from "@massion/growth";
import { createDatabase } from "@massion/storage";

import { createGrowthEffectMetricReader, GROWTH_EFFECT_METRIC_SOURCE_ID, GrowthWorker } from "./growth-worker.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

const trigger: GrowthTrigger = {
  trigger_id: "trigger-1",
  organization_id: context.organizationId,
  work_id: "work-1",
  records_run_id: "records-1",
  work_record_id: "work-record-1",
  verification_id: "verification-1",
  assurance_run_id: "assurance-1",
  requester_user_id: context.userId,
  configuration_version_id: "configuration-1",
  status: "claimed",
};

describe("Growth worker production loop", () => {
  it("완료 Records의 Reflection 후보를 평가하고 auto 설정이면 채택한다", async () => {
    const candidate = {
      targetKind: "prompt" as const,
      operation: "replace-instruction",
      patch: { agentHandle: "representative", instruction: "완료 기록을 반영합니다" },
      summary: "대표 지시 개선",
      rationale: "완료 기록 근거",
      expectedEffect: "검증 통과율 향상",
      riskSummary: "제한된 Prompt 변경",
      sourceReferenceIds: [trigger.work_record_id],
    };
    const gateway = {
      listSuggestions: vi.fn().mockResolvedValue([]),
      reflect: vi.fn().mockResolvedValue({
        suggestions: [
          {
            suggestion_id: "suggestion-1",
            revision: 1,
            work_id: trigger.work_id,
            reflection_run_id: "reflection-1",
            target_kind: candidate.targetKind,
            operation: candidate.operation,
            patch_json: JSON.stringify(candidate.patch),
            summary: candidate.summary,
            rationale: candidate.rationale,
            expected_effect: candidate.expectedEffect,
            risk_summary: candidate.riskSummary,
            source_reference_ids: candidate.sourceReferenceIds,
            status: "proposed" as const,
          },
        ],
      }),
      recordSignal: vi.fn().mockResolvedValue({ receiptId: "receipt-1" }),
      evaluate: vi
        .fn()
        .mockResolvedValue({ evaluationRunId: "evaluation-1", inputHash: "e".repeat(64), outcome: "eligible" }),
      inspectTarget: vi.fn().mockResolvedValue({
        targetKind: "prompt",
        versionId: "prompt-1",
        revision: 1,
        checksum: "a".repeat(64),
        snapshot: {},
      }),
      resolveConfiguration: vi.fn().mockResolvedValue({ adoptionMode: "auto" }),
      adopt: vi.fn().mockResolvedValue({ adoption: { adoption_id: "adoption-1" } }),
    } as unknown as GrowthGateway;
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("work_record"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id }]];
        if (sql.includes("work_verification"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id }]];
        if (sql.includes("assurance_run"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id }]];
        if (sql.includes("work_event")) return [[]];
        if (sql.includes("work WHERE"))
          return [
            [
              {
                prompt_version_id: "prompt-version-1",
                policy_version_id: "policy-1",
                organization_version_id: "organization-1",
              },
            ],
          ];
        if (sql.includes("prompt_version"))
          return [
            [
              {
                prompt_definition_version_id: "prompt-1",
                prompt_definition_checksum: "a".repeat(64),
                memory_version_ids: [],
                memory_checksums: [],
              },
            ],
          ];
        if (sql.includes("governance_policy_version"))
          return [[{ policy_version_id: "policy-1", checksum: "b".repeat(64) }]];
        if (sql.includes("prompt_definition_version"))
          return [[{ prompt_definition_version_id: "prompt-1", checksum: "a".repeat(64) }]];
        if (sql.includes("memory_version")) return [[]];
        if (sql.includes("organization_version"))
          return [[{ version_id: "organization-1", version: 1, before_json: "{}", after_json: "{}" }]];
        return [[]];
      }),
    } as never;
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 1, existing: 0 }),
        claim: vi.fn().mockResolvedValue({ outcome: "claimed", trigger }),
      } as never,
      gateway,
      runner: {} as never,
    });

    await worker.tick(context);

    expect(gateway.recordSignal).toHaveBeenCalledTimes(5);
    expect(gateway.evaluate).toHaveBeenCalledWith(context, expect.objectContaining({ suggestionId: "suggestion-1" }));
    expect(gateway.adopt).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        suggestionId: "suggestion-1",
        evaluationRunId: "evaluation-1",
        expectedTargetChecksum: "a".repeat(64),
      }),
    );
  });

  it("Reflection snapshot은 현재 대상이 아니라 Work가 고정한 계보를 사용한다", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("work_record"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id, artifact_version_ids: [] }]];
        if (sql.includes("work_verification"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id }]];
        if (sql.includes("assurance_run"))
          return [[{ organization_id: context.organizationId, work_id: trigger.work_id }]];
        if (sql.includes("work_event")) return [[]];
        if (sql.includes("work WHERE"))
          return [
            [
              {
                prompt_version_id: "prompt-version-1",
                policy_version_id: "policy-1",
                organization_version_id: "organization-1",
              },
            ],
          ];
        if (sql.includes("prompt_version"))
          return [
            [
              {
                prompt_definition_version_id: "prompt-fixed",
                prompt_definition_checksum: "d".repeat(64),
                memory_version_ids: ["memory-fixed"],
                memory_checksums: ["e".repeat(64)],
              },
            ],
          ];
        if (sql.includes("governance_policy_version"))
          return [[{ policy_version_id: "policy-1", checksum: "f".repeat(64) }]];
        if (sql.includes("prompt_definition_version"))
          return [[{ prompt_definition_version_id: "prompt-current", checksum: "a".repeat(64) }]];
        if (sql.includes("memory_version"))
          return [[{ memory_version_id: "memory-current", checksum: "b".repeat(64) }]];
        if (sql.includes("organization_version"))
          return [[{ version_id: "organization-1", version: 1, before_json: "{}", after_json: "{}" }]];
        return [[]];
      }),
    } as never;
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {} as never,
      gateway: {} as never,
      runner: {} as never,
    });

    const snapshot = await (
      worker as unknown as {
        snapshot(
          inputContext: TenantContext,
          inputTrigger: GrowthTrigger,
        ): Promise<{ material: { activeVersions: readonly { kind: string; versionId: string }[] } }>;
      }
    ).snapshot(context, trigger);

    expect(snapshot.material.activeVersions).toEqual(
      expect.arrayContaining([
        { kind: "prompt", versionId: "prompt-fixed", checksum: "d".repeat(64) },
        { kind: "memory", versionId: "memory-fixed", checksum: "e".repeat(64) },
        { kind: "policy", versionId: "policy-1", checksum: "f".repeat(64) },
      ]),
    );
    expect(snapshot.material.activeVersions).not.toEqual(
      expect.arrayContaining([{ kind: "prompt", versionId: "prompt-current", checksum: "a".repeat(64) }]),
    );
  });

  it("Growth 효과 metric은 caller 점수가 아니라 terminal Assurance와 artifact에서 계산한다", async () => {
    const completedAt = "2026-07-26T12:00:00.000Z";
    const reader = createGrowthEffectMetricReader();
    const input = {
      organizationId: context.organizationId,
      commandId: "growth-effect-metric:adoption:work:assurance",
      workId: "work-1",
      producer: { kind: "system_adapter" as const, id: GROWTH_EFFECT_METRIC_SOURCE_ID },
      source: { kind: "artifact_version" as const, id: "artifact-1" },
      expectedUnit: "ratio",
      maximumAgeMs: 86_400_000,
    };
    const executor = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("work_verification"))
          return [[{ verification_id: "verification-1", assurance_run_id: "assurance-1", passed: true }]];
        if (sql.includes("artifact_version")) return [[{ checksum: "a".repeat(64) }]];
        return [[{ assurance_run_id: "assurance-1", status: "passed", completed_at: completedAt }]];
      }),
    } as never;
    const result = await reader.observe(executor, input);
    expect(result).toMatchObject({ value: 1, unit: "ratio", measuredAt: completedAt, sourceChecksum: "a".repeat(64) });
    expect(result.checksum).toBe(
      metricObservationChecksum({
        ...input,
        value: 1,
        unit: "ratio",
        measuredAt: completedAt,
        sourceChecksum: "a".repeat(64),
      }),
    );
  });

  it("효과 표본은 target 버전에 결속된 terminal Assurance 3건만 평균낸다", async () => {
    const worker = new GrowthWorker({
      database: {
        query: vi.fn(async (sql: string, parameters?: { readonly assurance_run_id?: string }) => {
          if (sql.includes("FROM assurance_run"))
            return [
              [
                {
                  assurance_run_id: "assurance-1",
                  work_id: "work-1",
                  status: "passed",
                  profile_id: "profile",
                  profile_version: "1",
                  completed_at: "2026-07-01T00:00:00.000Z",
                },
                {
                  assurance_run_id: "assurance-2",
                  work_id: "work-2",
                  status: "failed",
                  profile_id: "profile",
                  profile_version: "1",
                  completed_at: "2026-07-02T00:00:00.000Z",
                },
                {
                  assurance_run_id: "assurance-3",
                  work_id: "work-3",
                  status: "passed",
                  profile_id: "profile",
                  profile_version: "1",
                  completed_at: "2026-07-03T00:00:00.000Z",
                },
              ],
            ];
          if (sql.includes("FROM work WHERE")) return [[{ prompt_version_id: "prompt-work" }]];
          if (sql.includes("FROM prompt_version"))
            return [[{ prompt_definition_version_id: "prompt-v1", memory_version_ids: [] }]];
          if (sql.includes("FROM work_verification"))
            return [
              [
                {
                  verification_id: `verification-${parameters?.assurance_run_id?.slice(-1)}`,
                  evidence_artifact_version_id: "artifact-1",
                },
              ],
            ];
          if (sql.includes("FROM growth_evaluation_run")) return [[{ strategy_version_id: "strategy-1" }]];
          return [[]];
        }),
      } as never,
      organizations: {} as never,
      triggers: {} as never,
      gateway: {} as never,
      runner: {} as never,
      metricObservations: {
        record: vi.fn(async (_context, input: { readonly workId: string; readonly commandId: string }) => ({
          observationId: `metric-${input.workId}`,
          value: input.workId === "work-2" ? 0 : 1,
          checksum: "b".repeat(64),
        })),
      } as never,
    });
    const sample = await (
      worker as unknown as {
        effectSample(
          inputContext: TenantContext,
          adoption: {
            adoption_id: string;
            suggestion_id: string;
            target_kind: "prompt";
            evaluation_run_id: string;
            before_version_id: string;
            status: "observing";
          },
          targetVersionId: string,
          order: "latest" | "earliest",
        ): Promise<{ score: number; observationCount: number; lineage: { targetVersionId: string } }>;
      }
    ).effectSample(
      context,
      {
        adoption_id: "adoption-1",
        suggestion_id: "suggestion-1",
        target_kind: "prompt",
        evaluation_run_id: "evaluation-1",
        before_version_id: "prompt-v1",
        status: "observing",
      },
      "prompt-v1",
      "latest",
    );
    expect(sample).toMatchObject({ score: 2 / 3, observationCount: 3, lineage: { targetVersionId: "prompt-v1" } });
  });

  it("새 trigger가 없어도 관찰 중인 Growth Adoption을 처리한다", async () => {
    const database = { query: vi.fn(async () => [[]]) } as never;
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim: vi.fn().mockResolvedValue({ outcome: "none" }),
      } as never,
      gateway: { listSuggestions: vi.fn().mockResolvedValue([]) } as never,
      runner: {} as never,
      metricObservations: { record: vi.fn() } as never,
    });

    await expect(worker.tick(context)).resolves.toEqual({ outcome: "none" });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("growth_adoption_run"),
      expect.objectContaining({ organization_id: context.organizationId }),
    );
  });

  it("효과 worker의 SurrealDB 정렬 필드는 SELECT projection에도 포함한다", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM growth_adoption_run")) {
          const projection = sql.slice(sql.indexOf("SELECT ") + 7, sql.indexOf(" FROM growth_adoption_run"));
          if (!projection.split(", ").includes("updated_at")) throw new Error("Missing order idiom updated_at");
        }
        return [[]];
      }),
    } as never;
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {} as never,
      gateway: {} as never,
      runner: {} as never,
      metricObservations: { record: vi.fn() } as never,
    });

    await expect(
      (worker as unknown as { processEffects(inputContext: TenantContext): Promise<void> }).processEffects(context),
    ).resolves.toBeUndefined();
  });

  it("한 effect 후보 오류가 다음 effect 후보를 막지 않는다", async () => {
    const attempted: string[] = [];
    const adoption = (id: string) => ({
      adoption_id: id,
      suggestion_id: `suggestion-${id}`,
      target_kind: "prompt" as const,
      evaluation_run_id: `evaluation-${id}`,
      before_version_id: "prompt-1",
      after_version_id: "prompt-2",
      status: "observing" as const,
    });
    const database = {
      query: vi.fn(async (sql: string, parameters?: { readonly adoption_id?: string }) => {
        if (sql.includes("FROM growth_adoption_run")) return [[adoption("broken"), adoption("next")]];
        if (sql.includes("FROM growth_effect_baseline")) {
          attempted.push(parameters?.adoption_id ?? "missing");
          if (parameters?.adoption_id === "broken") throw new Error("broken effect");
          return [[]];
        }
        return [[]];
      }),
    } as never;
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {} as never,
      gateway: {} as never,
      runner: {} as never,
      metricObservations: { record: vi.fn() } as never,
    });

    await expect(
      (worker as unknown as { processEffects(inputContext: TenantContext): Promise<void> }).processEffects(context),
    ).resolves.toBeUndefined();
    expect(attempted).toEqual(["broken", "next"]);
  });
});

const orphanTrigger: GrowthTrigger = {
  ...trigger,
  trigger_id: "trigger-orphan",
  status: "completed",
};
const claimedOrphanTrigger: GrowthTrigger = { ...orphanTrigger, status: "claimed" };

const orphanRows = {
  record: { organization_id: context.organizationId, work_id: trigger.work_id, artifact_version_ids: [] },
  verification: { organization_id: context.organizationId, work_id: trigger.work_id },
  assurance: { organization_id: context.organizationId, work_id: trigger.work_id },
  work: {
    prompt_version_id: "prompt-version-1",
    policy_version_id: "policy-1",
    organization_version_id: "organization-1",
  },
  prompt: {
    prompt_definition_version_id: "prompt-1",
    prompt_definition_checksum: "a".repeat(64),
    memory_version_ids: [],
    memory_checksums: [],
  },
  policy: { policy_version_id: "policy-1", checksum: "b".repeat(64) },
  organization: { version_id: "organization-1", version: 1, before_json: "{}", after_json: "{}" },
};

const orphanSnapshot = createReflectionSnapshot({
  organizationId: context.organizationId,
  workId: orphanTrigger.work_id,
  recordsRunId: orphanTrigger.records_run_id,
  workRecordId: orphanTrigger.work_record_id,
  verificationId: orphanTrigger.verification_id,
  assuranceRunId: orphanTrigger.assurance_run_id,
  configurationVersionId: orphanTrigger.configuration_version_id ?? "unresolved",
  activeVersions: [
    { kind: "prompt", versionId: "prompt-1", checksum: "a".repeat(64) },
    { kind: "policy", versionId: "policy-1", checksum: "b".repeat(64) },
    {
      kind: "organization",
      versionId: "organization-1",
      checksum: growthChecksum({ version: 1, before: "{}", after: "{}" }),
    },
  ],
  sources: [
    {
      kind: "work-record",
      referenceId: orphanTrigger.work_record_id,
      organizationId: context.organizationId,
      workId: orphanTrigger.work_id,
      checksum: growthChecksum(orphanRows.record),
      capturedRevision: "1",
      excerpt: JSON.stringify(orphanRows.record),
    },
    {
      kind: "verification",
      referenceId: orphanTrigger.verification_id,
      organizationId: context.organizationId,
      workId: orphanTrigger.work_id,
      checksum: growthChecksum(orphanRows.verification),
      capturedRevision: "1",
      excerpt: JSON.stringify(orphanRows.verification),
    },
    {
      kind: "assurance",
      referenceId: orphanTrigger.assurance_run_id,
      organizationId: context.organizationId,
      workId: orphanTrigger.work_id,
      checksum: growthChecksum(orphanRows.assurance),
      capturedRevision: "1",
      excerpt: JSON.stringify(orphanRows.assurance),
    },
  ],
});

function orphanSuggestion(
  suggestionId: string,
  status: GrowthSuggestionRecord["status"] = "proposed",
  createdAt = "2026-07-01T00:00:00.000Z",
): GrowthSuggestionRecord {
  return {
    suggestion_id: suggestionId,
    organization_id: context.organizationId,
    work_id: orphanTrigger.work_id,
    reflection_run_id: "reflection-orphan",
    target_kind: "prompt",
    operation: "replace-instruction",
    patch_json: JSON.stringify({ agentHandle: "representative", instruction: "완료 기록을 반영합니다" }),
    summary: "대표 지시 개선",
    rationale: "완료 기록 근거",
    expected_effect: "검증 통과율 향상",
    risk_summary: "제한된 Prompt 변경",
    source_reference_ids: [orphanTrigger.work_record_id],
    revision: 1,
    status,
    created_at: createdAt,
  };
}

function evaluatedDetails(
  suggestion: GrowthSuggestionRecord,
  targetChecksum = "a".repeat(64),
): GrowthSuggestionDetails {
  const patch = JSON.parse(suggestion.patch_json) as Record<string, unknown>;
  const candidate = {
    targetKind: suggestion.target_kind,
    operation: suggestion.operation,
    patch,
    summary: suggestion.summary,
    rationale: suggestion.rationale,
    expectedEffect: suggestion.expected_effect,
    riskSummary: suggestion.risk_summary,
    sourceReferenceIds: suggestion.source_reference_ids,
  };
  const signal = (
    signalId: "lineage" | "target" | "candidate" | "assurance",
    group: "required" | "supporting",
    origin: "deterministic" | "independent",
    sourceId: string,
    sourceChecksum: string,
  ) => ({
    receiptId: `receipt-${signalId}-${suggestion.suggestion_id}`,
    organizationId: context.organizationId,
    commandId: `growth:${suggestion.suggestion_id}:signal:${signalId}`,
    suggestionId: suggestion.suggestion_id,
    signalId,
    group,
    origin,
    adapterId: `growth-worker:${orphanTrigger.trigger_id}`,
    adapterVersion: "1",
    outcome: "passed" as const,
    score: 1,
    unit: "boolean",
    sourceId,
    sourceChecksum,
    fresh: true,
    evidence: {},
    requestHash: growthChecksum({ suggestionId: suggestion.suggestion_id, signalId }),
  });
  const signals = [
    signal("lineage", "required", "deterministic", orphanTrigger.records_run_id, orphanSnapshot.hash),
    signal("target", "required", "deterministic", "prompt-1", targetChecksum),
    signal("candidate", "required", "deterministic", suggestion.suggestion_id, growthChecksum(candidate)),
    signal(
      "assurance",
      "supporting",
      "independent",
      orphanTrigger.assurance_run_id,
      growthChecksum(orphanRows.assurance),
    ),
  ];
  return {
    suggestion,
    patch,
    evaluation: {
      evaluationRunId: `evaluation-${suggestion.suggestion_id}`,
      organizationId: context.organizationId,
      suggestionId: suggestion.suggestion_id,
      strategyVersionId: "strategy-1",
      receiptIds: signals.map((receipt) => receipt.receiptId),
      inputHash: "e".repeat(64),
      outcome: "eligible",
      signals,
    },
  };
}

function orphanDatabase(events?: string[], configurationStatus: "active" | "superseded" = "active") {
  return {
    query: vi.fn(async (sql: string, parameters?: Record<string, unknown>) => {
      if (sql.includes("FROM growth_adoption_run")) {
        events?.push("effects");
        return [[]];
      }
      if (sql.includes("FROM reflection_run"))
        return [
          [
            {
              reflection_run_id: "reflection-orphan",
              organization_id: context.organizationId,
              work_id: orphanTrigger.work_id,
              records_run_id: orphanTrigger.records_run_id,
              trigger_id: orphanTrigger.trigger_id,
              configuration_version_id: orphanTrigger.configuration_version_id,
              runtime_execution_id: "runtime-orphan",
              snapshot_hash: orphanSnapshot.hash,
              status: "completed",
              version: 2,
              attempt: 1,
              command_id: "reflection-orphan-command",
              request_hash: "c".repeat(64),
            },
          ],
        ];
      if (sql.includes("FROM growth_trigger")) return [[orphanTrigger]];
      if (sql.includes("FROM growth_configuration_version"))
        return [
          [
            {
              configuration_version_id: orphanTrigger.configuration_version_id,
              status: configurationStatus,
            },
          ],
        ];
      if (sql.includes("FROM growth_source_reference"))
        return [
          [
            {
              organization_id: context.organizationId,
              work_id: orphanTrigger.work_id,
              suggestion_id: parameters?.suggestion_id,
              source_kind: "work-record",
              source_id: orphanTrigger.work_record_id,
              source_checksum: growthChecksum(orphanRows.record),
              captured_revision: "1",
            },
          ],
        ];
      if (sql.includes("FROM work_record")) return [[orphanRows.record]];
      if (sql.includes("FROM work_verification")) return [[orphanRows.verification]];
      if (sql.includes("FROM assurance_run")) return [[orphanRows.assurance]];
      if (sql.includes("FROM work_event")) return [[]];
      if (sql.includes("FROM work WHERE")) return [[orphanRows.work]];
      if (sql.includes("FROM prompt_version")) return [[orphanRows.prompt]];
      if (sql.includes("FROM governance_policy_version")) return [[orphanRows.policy]];
      if (sql.includes("FROM organization_version")) return [[orphanRows.organization]];
      return [[]];
    }),
  } as never;
}

function resumableGateway(details: readonly GrowthSuggestionDetails[] = []) {
  const byId = new Map(details.map((detail) => [detail.suggestion.suggestion_id, detail]));
  return {
    listSuggestions: vi.fn().mockResolvedValue(details.map((detail) => detail.suggestion)),
    getSuggestionDetails: vi.fn(async (_context, suggestionId: string) => {
      const detail = byId.get(suggestionId);
      if (!detail) throw new Error("Growth Suggestion을 찾을 수 없습니다");
      return detail;
    }),
    reflect: vi.fn().mockResolvedValue({ suggestions: [] }),
    recordSignal: vi.fn(async (_context, input: { readonly signalId: string }) => ({
      receiptId: `receipt-${input.signalId}`,
    })),
    evaluate: vi
      .fn()
      .mockResolvedValue({ evaluationRunId: "evaluation-1", inputHash: "e".repeat(64), outcome: "eligible" }),
    inspectTarget: vi.fn().mockResolvedValue({
      targetKind: "prompt",
      versionId: "prompt-1",
      revision: 1,
      checksum: "a".repeat(64),
      snapshot: {},
    }),
    adopt: vi.fn().mockResolvedValue({ adoption: { adoption_id: "adoption-1" } }),
    quarantine: vi.fn().mockResolvedValue({ status: "superseded", actor: "system:growth-worker" }),
  };
}

describe("Growth worker orphan suggestion recovery", () => {
  it("organization orphan target은 기존 snapshot hash와 별도로 실제 versionId·nodes checksum을 검증한다", async () => {
    const nodes = [{ handle: "engineering", responsibility: "구현", status: "active" }];
    const snapshot = createReflectionSnapshot({
      ...orphanSnapshot.material,
      activeVersions: [
        ...orphanSnapshot.material.activeVersions.filter((version) => version.kind !== "organization"),
        {
          kind: "organization",
          versionId: "organization-1",
          checksum: growthChecksum({ version: 1, before: "[]", after: JSON.stringify(nodes) }),
        },
      ],
    });
    const suggestion = {
      ...orphanSuggestion("suggestion-organization", "evaluated"),
      target_kind: "organization" as const,
      operation: "change-node",
      patch_json: JSON.stringify({ handle: "engineering", responsibility: "구현과 검증" }),
    };
    const target = {
      targetKind: "organization" as const,
      versionId: "organization-1",
      revision: 1,
      checksum: growthChecksum({ versionId: "organization-1", nodes }),
      snapshot: { nodes },
    };
    const worker = new GrowthWorker({
      database: {
        query: vi.fn().mockResolvedValue([[{ version_id: "organization-1", after_json: JSON.stringify(nodes) }]]),
      } as never,
      organizations: {} as never,
      triggers: {} as never,
      gateway: {} as never,
      runner: {} as never,
    });

    await expect(
      Promise.resolve().then(() =>
        (
          worker as unknown as {
            assertOrphanTarget(
              inputSnapshot: typeof snapshot,
              inputSuggestion: GrowthSuggestionRecord,
              inputTarget: typeof target,
            ): void | Promise<void>;
          }
        ).assertOrphanTarget(snapshot, suggestion, target),
      ),
    ).resolves.toBeUndefined();
  });

  it("Reflection 뒤 평가가 중단되면 다음 tick이 같은 command로 평가하고 한 번 채택한다", async () => {
    const suggestion = orphanSuggestion("suggestion-evaluation-crash");
    const gateway = resumableGateway();
    gateway.reflect.mockResolvedValue({ suggestions: [suggestion] });
    gateway.listSuggestions.mockResolvedValueOnce([]).mockResolvedValueOnce([suggestion]);
    gateway.getSuggestionDetails.mockResolvedValue({ suggestion, patch: JSON.parse(suggestion.patch_json) });
    gateway.evaluate.mockRejectedValueOnce(new Error("evaluation crash")).mockResolvedValueOnce({
      evaluationRunId: "evaluation-resumed",
      inputHash: "e".repeat(64),
      outcome: "eligible",
    });
    const triggers = {
      requeueExpired: vi.fn().mockResolvedValue(0),
      backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
      claim: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "claimed", trigger: claimedOrphanTrigger })
        .mockResolvedValue({ outcome: "none" }),
    };
    const worker = new GrowthWorker({
      database: orphanDatabase(),
      organizations: {} as never,
      triggers: triggers as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await expect(worker.tick(context)).rejects.toThrow("evaluation crash");
    await expect(worker.tick(context)).resolves.toEqual({ outcome: "none" });

    expect(gateway.evaluate).toHaveBeenCalledTimes(2);
    expect(gateway.evaluate.mock.calls.map((call) => call[1].commandId)).toEqual([
      `growth:${suggestion.suggestion_id}:evaluate`,
      `growth:${suggestion.suggestion_id}:evaluate`,
    ]);
    expect(gateway.adopt).toHaveBeenCalledTimes(1);
  });

  it("평가 뒤 채택이 중단되면 저장된 eligible 평가와 target checksum으로 채택부터 재개한다", async () => {
    const proposed = orphanSuggestion("suggestion-adoption-crash");
    const evaluated = { ...proposed, status: "evaluated" as const };
    const gateway = resumableGateway();
    gateway.reflect.mockResolvedValue({ suggestions: [proposed] });
    gateway.listSuggestions.mockResolvedValueOnce([]).mockResolvedValueOnce([evaluated]);
    gateway.getSuggestionDetails.mockResolvedValue(evaluatedDetails(evaluated));
    gateway.adopt
      .mockRejectedValueOnce(new Error("adoption crash"))
      .mockResolvedValueOnce({ adoption: { adoption_id: "adoption-resumed" } });
    const worker = new GrowthWorker({
      database: orphanDatabase(),
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim: vi
          .fn()
          .mockResolvedValueOnce({ outcome: "claimed", trigger: claimedOrphanTrigger })
          .mockResolvedValue({ outcome: "none" }),
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await expect(worker.tick(context)).rejects.toThrow("adoption crash");
    await expect(worker.tick(context)).resolves.toEqual({ outcome: "none" });

    expect(gateway.evaluate).toHaveBeenCalledTimes(1);
    expect(gateway.adopt).toHaveBeenCalledTimes(2);
    expect(gateway.adopt.mock.calls[1]?.[1]).toMatchObject({
      commandId: `growth:${evaluated.suggestion_id}:adopt`,
      evaluationRunId: `evaluation-${evaluated.suggestion_id}`,
      expectedEvaluationInputHash: "e".repeat(64),
      expectedTargetChecksum: "a".repeat(64),
    });
  });

  it("효과 뒤 오래된 orphan부터 처리하고 한 후보가 실패해도 다음 후보와 새 trigger를 진행한다", async () => {
    const events: string[] = [];
    const older = orphanSuggestion("suggestion-older", "evaluated", "2026-07-01T00:00:00.000Z");
    const newer = orphanSuggestion("suggestion-newer", "evaluated", "2026-07-02T00:00:00.000Z");
    const gateway = resumableGateway([evaluatedDetails(newer), evaluatedDetails(older, "d".repeat(64))]);
    gateway.listSuggestions.mockImplementation(async () => {
      events.push("orphans");
      return [older, newer];
    });
    gateway.inspectTarget.mockImplementation(async (_context, input) => {
      events.push(`inspect:${input.suggestionId}`);
      return {
        targetKind: "prompt",
        versionId: "prompt-1",
        revision: 1,
        checksum: "a".repeat(64),
        snapshot: {},
      };
    });
    gateway.quarantine.mockImplementation(async (_context, input) => {
      events.push(`quarantine:${input.suggestionId}`);
      return { status: "superseded", actor: "system:growth-worker" };
    });
    gateway.adopt.mockImplementation(async (_context, input) => {
      events.push(`adopt:${input.suggestionId}`);
      return { adoption: { adoption_id: "adoption-newer" } };
    });
    const triggers = {
      requeueExpired: vi.fn().mockResolvedValue(0),
      backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
      claim: vi.fn(async () => {
        events.push("claim");
        return { outcome: "none" };
      }),
    };
    const worker = new GrowthWorker({
      database: orphanDatabase(events),
      organizations: {} as never,
      triggers: triggers as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
      metricObservations: { record: vi.fn() } as never,
    });

    await expect(worker.tick(context)).resolves.toEqual({ outcome: "none" });

    expect(gateway.listSuggestions).toHaveBeenCalledWith(context, {
      status: ["proposed", "evaluated"],
      recoverableOnly: true,
      oldestFirst: true,
      limit: 20,
    });
    expect(events).toEqual([
      "effects",
      "orphans",
      "inspect:suggestion-older",
      "quarantine:suggestion-older",
      "inspect:suggestion-newer",
      "adopt:suggestion-newer",
      "claim",
    ]);
  });

  it("effect 조회·후보 상세 오류를 격리하고 다음 orphan과 trigger를 계속 처리한다", async () => {
    const events: string[] = [];
    const corrupt = { ...orphanSuggestion("suggestion-corrupt"), patch_json: "{" };
    const transient = orphanSuggestion("suggestion-transient", "evaluated", "2026-07-02T00:00:00.000Z");
    const healthy = orphanSuggestion("suggestion-healthy", "evaluated", "2026-07-03T00:00:00.000Z");
    const baseDatabase = orphanDatabase() as unknown as {
      query(sql: string, parameters?: Record<string, unknown>): Promise<unknown>;
    };
    const database = {
      query: vi.fn(async (sql: string, parameters?: Record<string, unknown>) => {
        if (sql.includes("FROM growth_adoption_run")) {
          events.push("effects-failed");
          throw new Error("effect scan unavailable");
        }
        return await baseDatabase.query(sql, parameters);
      }),
    } as never;
    const gateway = resumableGateway([evaluatedDetails(healthy)]);
    gateway.listSuggestions.mockImplementation(async () => {
      events.push("orphans");
      return [corrupt, transient, healthy];
    });
    gateway.getSuggestionDetails.mockImplementation(async (_context, suggestionId) => {
      events.push(`details:${suggestionId}`);
      if (suggestionId === corrupt.suggestion_id) throw new SyntaxError("corrupt patch");
      if (suggestionId === transient.suggestion_id) throw new Error("temporary detail failure");
      return evaluatedDetails(healthy);
    });
    gateway.quarantine.mockImplementation(async (_context, input) => {
      events.push(`quarantine:${input.suggestionId}`);
      return { status: "superseded", actor: "system:growth-worker" };
    });
    gateway.adopt.mockImplementation(async (_context, input) => {
      events.push(`adopt:${input.suggestionId}`);
      return { adoption: { adoption_id: "adoption-healthy" } };
    });
    const claim = vi.fn(async () => {
      events.push("claim");
      return { outcome: "none" };
    });
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim,
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
      metricObservations: { record: vi.fn() } as never,
    });

    await expect(worker.tick(context)).resolves.toEqual({ outcome: "none" });
    expect(events).toEqual([
      "effects-failed",
      "orphans",
      "details:suggestion-corrupt",
      "quarantine:suggestion-corrupt",
      "details:suggestion-transient",
      "details:suggestion-healthy",
      "adopt:suggestion-healthy",
      "claim",
    ]);
    expect(claim).toHaveBeenCalledOnce();
  });

  it("valid JSON이지만 domain patch가 invalid인 proposed orphan은 부분 원장 없이 격리하고 재시도하지 않는다", async () => {
    const events: string[] = [];
    const invalid = { ...orphanSuggestion("suggestion-invalid-patch"), patch_json: "{}" };
    const healthy = orphanSuggestion("suggestion-after-invalid-patch", "evaluated", "2026-07-02T00:00:00.000Z");
    const gateway = resumableGateway([evaluatedDetails(healthy)]);
    let invalidStatus: GrowthSuggestionRecord["status"] = "proposed";
    gateway.listSuggestions.mockResolvedValueOnce([invalid, healthy]).mockResolvedValueOnce([invalid]);
    gateway.getSuggestionDetails.mockImplementation(async (_context, suggestionId) => {
      events.push(`details:${suggestionId}`);
      if (suggestionId === invalid.suggestion_id) {
        return { suggestion: { ...invalid, status: invalidStatus }, patch: {} };
      }
      return evaluatedDetails(healthy);
    });
    gateway.inspectTarget.mockImplementation(async (_context, input) => {
      events.push(`inspect:${input.suggestionId}`);
      return {
        targetKind: "prompt",
        versionId: "prompt-1",
        revision: 1,
        checksum: "a".repeat(64),
        snapshot: {},
      };
    });
    gateway.quarantine.mockImplementation(async (_context, input) => {
      events.push(`quarantine:${input.suggestionId}`);
      invalidStatus = "superseded";
      return { status: "superseded", actor: "system:growth-worker" };
    });
    gateway.adopt.mockImplementation(async (_context, input) => {
      events.push(`adopt:${input.suggestionId}`);
      return { adoption: { adoption_id: "adoption-after-invalid-patch" } };
    });
    const claim = vi.fn(async () => {
      events.push("claim");
      return { outcome: "none" };
    });
    const worker = new GrowthWorker({
      database: orphanDatabase(),
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim,
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await worker.tick(context);
    await worker.tick(context);

    expect(events).toEqual([
      `details:${invalid.suggestion_id}`,
      `quarantine:${invalid.suggestion_id}`,
      `details:${healthy.suggestion_id}`,
      `inspect:${healthy.suggestion_id}`,
      `adopt:${healthy.suggestion_id}`,
      "claim",
      `details:${invalid.suggestion_id}`,
      "claim",
    ]);
    expect(gateway.quarantine).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        suggestionId: invalid.suggestion_id,
        reason: expect.stringContaining("patch schema"),
      }),
    );
    expect(gateway.recordSignal).not.toHaveBeenCalled();
    expect(gateway.evaluate).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("superseded configuration의 proposed orphan은 부분 원장 없이 격리하고 다음 orphan과 trigger를 처리한다", async () => {
    const staleTrigger: GrowthTrigger = {
      ...orphanTrigger,
      trigger_id: "trigger-superseded-configuration",
      configuration_version_id: "configuration-superseded",
    };
    const staleSnapshot = createReflectionSnapshot({
      ...orphanSnapshot.material,
      configurationVersionId: staleTrigger.configuration_version_id ?? "unresolved",
    });
    const stale = {
      ...orphanSuggestion("suggestion-superseded-configuration"),
      reflection_run_id: "reflection-superseded-configuration",
    };
    const healthy = orphanSuggestion("suggestion-after-superseded-configuration", "evaluated");
    const baseDatabase = orphanDatabase() as unknown as {
      query(sql: string, parameters?: Record<string, unknown>): Promise<unknown>;
    };
    const database = {
      query: vi.fn(async (sql: string, parameters?: Record<string, unknown>) => {
        if (sql.includes("FROM reflection_run") && parameters?.reflection_run_id === stale.reflection_run_id) {
          return [
            [
              {
                reflection_run_id: stale.reflection_run_id,
                organization_id: context.organizationId,
                work_id: staleTrigger.work_id,
                records_run_id: staleTrigger.records_run_id,
                trigger_id: staleTrigger.trigger_id,
                configuration_version_id: staleTrigger.configuration_version_id,
                runtime_execution_id: "runtime-superseded-configuration",
                snapshot_hash: staleSnapshot.hash,
                status: "completed",
                version: 2,
                attempt: 1,
                command_id: "reflection-superseded-configuration-command",
                request_hash: "c".repeat(64),
              },
            ],
          ];
        }
        if (sql.includes("FROM growth_trigger") && parameters?.trigger_id === staleTrigger.trigger_id) {
          return [[staleTrigger]];
        }
        if (
          sql.includes("FROM growth_configuration_version") &&
          parameters?.configuration_version_id === staleTrigger.configuration_version_id
        ) {
          return [
            [
              {
                configuration_version_id: staleTrigger.configuration_version_id,
                status: "superseded",
              },
            ],
          ];
        }
        return await baseDatabase.query(sql, parameters);
      }),
    } as never;
    const gateway = resumableGateway([evaluatedDetails(healthy)]);
    let staleStatus: GrowthSuggestionRecord["status"] = "proposed";
    gateway.listSuggestions.mockResolvedValueOnce([stale, healthy]).mockResolvedValueOnce([stale]);
    gateway.getSuggestionDetails.mockImplementation(async (_context, suggestionId) => {
      if (suggestionId === stale.suggestion_id) {
        return {
          suggestion: { ...stale, status: staleStatus },
          patch: JSON.parse(stale.patch_json) as Record<string, unknown>,
        };
      }
      return evaluatedDetails(healthy);
    });
    gateway.quarantine.mockImplementation(async () => {
      staleStatus = "superseded";
      return { status: "superseded", actor: "system:growth-worker" };
    });
    const claim = vi.fn().mockResolvedValue({ outcome: "none" });
    const worker = new GrowthWorker({
      database,
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim,
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await worker.tick(context);
    await worker.tick(context);

    expect(gateway.quarantine).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        suggestionId: stale.suggestion_id,
        reason: expect.stringContaining("active"),
      }),
    );
    expect(gateway.recordSignal).not.toHaveBeenCalled();
    expect(gateway.evaluate).not.toHaveBeenCalled();
    expect(gateway.inspectTarget).toHaveBeenCalledTimes(1);
    expect(gateway.inspectTarget).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ suggestionId: healthy.suggestion_id }),
    );
    expect(gateway.adopt).toHaveBeenCalledTimes(1);
    expect(gateway.adopt).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ suggestionId: healthy.suggestion_id }),
    );
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("evaluated orphan의 required signal command 계보가 다르면 시스템 격리한다", async () => {
    const suggestion = orphanSuggestion("suggestion-forged-signal", "evaluated");
    const detail = evaluatedDetails(suggestion);
    if (!detail.evaluation) throw new Error("평가 fixture가 없습니다");
    const forged: GrowthSuggestionDetails = {
      ...detail,
      evaluation: {
        ...detail.evaluation,
        signals: detail.evaluation.signals.map((signal) =>
          signal.signalId === "target" ? { ...signal, commandId: "forged-target-command" } : signal,
        ),
      },
    };
    const gateway = resumableGateway([forged]);
    const worker = new GrowthWorker({
      database: orphanDatabase(),
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim: vi.fn().mockResolvedValue({ outcome: "none" }),
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await worker.tick(context);

    expect(gateway.quarantine).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ suggestionId: suggestion.suggestion_id }),
    );
    expect(gateway.adopt).not.toHaveBeenCalled();
  });

  it("terminal suggestion은 orphan 조회 결과에 섞여도 다시 평가하거나 채택하지 않는다", async () => {
    const terminal = (["awaiting-review", "adopted", "rejected", "superseded"] as const).map((status, index) => ({
      suggestion: orphanSuggestion(`suggestion-terminal-${String(index)}`, status),
    }));
    const gateway = resumableGateway(terminal);
    const worker = new GrowthWorker({
      database: orphanDatabase(),
      organizations: {} as never,
      triggers: {
        requeueExpired: vi.fn().mockResolvedValue(0),
        backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
        claim: vi.fn().mockResolvedValue({ outcome: "none" }),
      } as never,
      gateway: gateway as unknown as GrowthGateway,
      runner: {} as never,
    });

    await worker.tick(context);

    expect(gateway.recordSignal).not.toHaveBeenCalled();
    expect(gateway.evaluate).not.toHaveBeenCalled();
    expect(gateway.adopt).not.toHaveBeenCalled();
    expect(gateway.quarantine).not.toHaveBeenCalled();
  });

  it("두 worker가 같은 orphan을 동시에 재개해도 signal·evaluation·adoption 원장은 한 건씩만 남긴다", async () => {
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    try {
      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identity.registerPersonalUser({
        email: "growth-worker-concurrent@example.com",
        displayName: "Growth worker concurrent",
      });
      const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const evaluations = await GrowthEvaluationStore.create(database, organizations);
      await evaluations.bootstrap(tenant);
      const reflections = await ReflectionService.create(
        database,
        organizations,
        { generate: vi.fn() },
        { verify: vi.fn() },
        { verify: vi.fn() },
      );
      const before = {
        targetKind: "prompt" as const,
        versionId: "prompt-1",
        revision: 1,
        checksum: "a".repeat(64),
        snapshot: { sections: [{ agentHandle: "representative", instruction: "기존 지시" }] },
      };
      const after = { ...before, versionId: "prompt-2", revision: 2, checksum: "b".repeat(64) };
      const target = {
        inspect: vi.fn().mockResolvedValue(before),
        validate: vi.fn().mockResolvedValue(undefined),
        apply: vi.fn().mockResolvedValue({ before, after }),
        revert: vi.fn(),
      };
      const adoptions = await GrowthAdoptionService.create(
        database,
        organizations,
        {
          authorizeAdoption: vi.fn().mockResolvedValue({
            outcome: "allow",
            decision: { decisionId: "decision-concurrent" },
          }),
        } as never,
        new GrowthTargetRegistry({ prompt: target } as never),
      );
      const gateway = new GrowthGateway({ reflections, evaluations, adoptions } as never);
      await database.query(
        "DEFINE TABLE work_record SCHEMALESS; DEFINE TABLE work_verification SCHEMALESS; DEFINE TABLE assurance_run SCHEMALESS; DEFINE TABLE work_event SCHEMALESS; DEFINE TABLE work SCHEMALESS; DEFINE TABLE prompt_version SCHEMALESS; DEFINE TABLE governance_policy_version SCHEMALESS; DEFINE TABLE organization_version SCHEMALESS; DEFINE TABLE runtime_execution SCHEMALESS; DEFINE TABLE growth_configuration_version SCHEMALESS; CREATE work_record CONTENT { work_record_id: 'work-record-concurrent', organization_id: $organization_id, work_id: 'work-concurrent', artifact_version_ids: [] }; CREATE work_verification CONTENT { verification_id: 'verification-concurrent', organization_id: $organization_id, work_id: 'work-concurrent' }; CREATE assurance_run CONTENT { assurance_run_id: 'assurance-concurrent', organization_id: $organization_id, work_id: 'work-concurrent' }; CREATE work CONTENT { work_id: 'work-concurrent', organization_id: $organization_id, prompt_version_id: 'prompt-version-concurrent', organization_version_id: 'organization-concurrent' }; CREATE prompt_version CONTENT { prompt_version_id: 'prompt-version-concurrent', organization_id: $organization_id, prompt_definition_version_id: 'prompt-1', prompt_definition_checksum: $prompt_checksum, memory_version_ids: [], memory_checksums: [] }; CREATE organization_version CONTENT { version_id: 'organization-concurrent', organization_id: $organization_id, version: 1, before_json: '[]', after_json: '[]' }; CREATE runtime_execution CONTENT { execution_id: 'runtime-concurrent', organization_id: $organization_id, work_id: 'work-concurrent', agent_handle: 'growth', status: 'succeeded' }; CREATE growth_configuration_version CONTENT { configuration_version_id: 'configuration-concurrent', organization_id: $organization_id, adoption_mode: 'auto', status: 'active', checksum: $configuration_checksum };",
        {
          organization_id: tenant.organizationId,
          prompt_checksum: before.checksum,
          configuration_checksum: "c".repeat(64),
        },
      );
      const completedTrigger: GrowthTrigger = {
        trigger_id: "trigger-concurrent",
        organization_id: tenant.organizationId,
        work_id: "work-concurrent",
        records_run_id: "records-concurrent",
        work_record_id: "work-record-concurrent",
        verification_id: "verification-concurrent",
        assurance_run_id: "assurance-concurrent",
        requester_user_id: tenant.userId,
        configuration_version_id: "configuration-concurrent",
        status: "completed",
      };
      const dependencies = {
        database,
        organizations,
        triggers: {
          requeueExpired: vi.fn().mockResolvedValue(0),
          backfill: vi.fn().mockResolvedValue({ created: 0, existing: 0 }),
          claim: vi.fn().mockResolvedValue({ outcome: "none" }),
        } as never,
        gateway,
        runner: {} as never,
      };
      const seedWorker = new GrowthWorker(dependencies);
      const snapshot = await (
        seedWorker as unknown as {
          snapshot(inputContext: TenantContext, inputTrigger: GrowthTrigger): Promise<typeof orphanSnapshot>;
        }
      ).snapshot(tenant, completedTrigger);
      const workRecord = snapshot.material.sources.find((source) => source.kind === "work-record");
      if (!workRecord) throw new Error("동시성 테스트 Work Record source가 없습니다");
      await database.query(
        "CREATE growth_trigger CONTENT { trigger_id: $trigger_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, work_record_id: $work_record_id, verification_id: $verification_id, assurance_run_id: $assurance_run_id, requester_user_id: $requester_user_id, configuration_version_id: $configuration_version_id, status: 'completed', created_at: time::now(), updated_at: time::now() }; CREATE reflection_run CONTENT { reflection_run_id: 'reflection-concurrent', organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, trigger_id: $trigger_id, configuration_version_id: $configuration_version_id, runtime_execution_id: 'runtime-concurrent', snapshot_hash: $snapshot_hash, status: 'completed', version: 2, attempt: 1, command_id: 'reflection-concurrent', request_hash: $snapshot_hash, created_at: time::now(), updated_at: time::now() }; CREATE growth_suggestion CONTENT { suggestion_id: 'suggestion-concurrent', organization_id: $organization_id, work_id: $work_id, reflection_run_id: 'reflection-concurrent', target_kind: 'prompt', operation: 'replace-instruction', patch_json: $patch_json, summary: '동시 복구', rationale: '동일 orphan', expected_effect: '한 번 채택', risk_summary: '제한됨', source_reference_ids: [$source_id], revision: 1, status: 'proposed', created_at: time::now() }; CREATE growth_source_reference CONTENT { source_reference_id: 'source-concurrent', organization_id: $organization_id, work_id: $work_id, suggestion_id: 'suggestion-concurrent', source_kind: $source_kind, source_id: $source_id, source_checksum: $source_checksum, captured_revision: $captured_revision, created_at: time::now() };",
        {
          ...completedTrigger,
          organization_id: tenant.organizationId,
          snapshot_hash: snapshot.hash,
          patch_json: JSON.stringify({ agentHandle: "representative", instruction: "새 지시" }),
          source_id: workRecord.referenceId,
          source_kind: workRecord.kind,
          source_checksum: workRecord.checksum,
          captured_revision: workRecord.capturedRevision,
        },
      );

      const results = await Promise.allSettled([
        new GrowthWorker(dependencies).tick(tenant),
        new GrowthWorker(dependencies).tick(tenant),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const [[signals], [runs], [storedAdoptions]] = await Promise.all([
        database.query<[Array<{ receipt_id: string }>]>(
          "SELECT receipt_id FROM growth_signal_receipt WHERE organization_id = $organization_id AND suggestion_id = 'suggestion-concurrent';",
          { organization_id: tenant.organizationId },
        ),
        database.query<[Array<{ evaluation_run_id: string }>]>(
          "SELECT evaluation_run_id FROM growth_evaluation_run WHERE organization_id = $organization_id AND suggestion_id = 'suggestion-concurrent';",
          { organization_id: tenant.organizationId },
        ),
        database.query<[Array<{ adoption_id: string }>]>(
          "SELECT adoption_id FROM growth_adoption_run WHERE organization_id = $organization_id AND suggestion_id = 'suggestion-concurrent';",
          { organization_id: tenant.organizationId },
        ),
      ]);
      expect(signals).toHaveLength(5);
      expect(runs).toHaveLength(1);
      expect(storedAdoptions).toHaveLength(1);
    } finally {
      await database.close();
    }
  });
});
