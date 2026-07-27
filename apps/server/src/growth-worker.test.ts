import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import { metricObservationChecksum } from "@massion/assurance";
import type { GrowthGateway, GrowthTrigger } from "@massion/growth";

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
      metricObservationChecksum({ ...input, value: 1, unit: "ratio", measuredAt: completedAt, sourceChecksum: "a".repeat(64) }),
    );
  });

  it("효과 표본은 target 버전에 결속된 terminal Assurance 3건만 평균낸다", async () => {
    const worker = new GrowthWorker({
      database: {
        query: vi.fn(async (sql: string, parameters?: { readonly assurance_run_id?: string }) => {
          if (sql.includes("FROM assurance_run"))
            return [
              [
                { assurance_run_id: "assurance-1", work_id: "work-1", status: "passed", profile_id: "profile", profile_version: "1", completed_at: "2026-07-01T00:00:00.000Z" },
                { assurance_run_id: "assurance-2", work_id: "work-2", status: "failed", profile_id: "profile", profile_version: "1", completed_at: "2026-07-02T00:00:00.000Z" },
                { assurance_run_id: "assurance-3", work_id: "work-3", status: "passed", profile_id: "profile", profile_version: "1", completed_at: "2026-07-03T00:00:00.000Z" },
              ],
            ];
          if (sql.includes("FROM work WHERE")) return [[{ prompt_version_id: "prompt-work" }]];
          if (sql.includes("FROM prompt_version")) return [[{ prompt_definition_version_id: "prompt-v1", memory_version_ids: [] }]];
          if (sql.includes("FROM work_verification"))
            return [[{ verification_id: `verification-${parameters?.assurance_run_id?.slice(-1)}`, evidence_artifact_version_id: "artifact-1" }]];
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
      gateway: {} as never,
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
});
