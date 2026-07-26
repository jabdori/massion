import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import type { GrowthGateway, GrowthTrigger } from "@massion/growth";

import { GrowthWorker } from "./growth-worker.js";

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
});
