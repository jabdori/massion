import { describe, expect, it } from "vitest";

import { evaluateDocumentationImpacts, type DocumentationImpactEvaluationInput } from "./impact.js";

function input(): DocumentationImpactEvaluationInput {
  return {
    organizationId: "organization-1",
    workId: "work-1",
    recordsRunId: "records-run-1",
    verificationReferenceId: "verification-1",
    evaluatedAt: "2026-07-11T00:00:00.000Z",
    proposals: [],
    sources: [
      {
        referenceId: "verification-1",
        organizationId: "organization-1",
        workId: "work-1",
        sourceType: "verification",
      },
      {
        referenceId: "message-decision",
        organizationId: "organization-1",
        workId: "work-1",
        sourceType: "message",
      },
      {
        referenceId: "event-public-api",
        organizationId: "organization-1",
        workId: "work-1",
        sourceType: "event",
      },
      {
        referenceId: "artifact-migration",
        organizationId: "organization-1",
        workId: "work-1",
        sourceType: "artifact",
      },
    ],
  };
}

describe("deterministic documentation impact evaluator", () => {
  it("WorkRecord는 항상 필요하고 나머지는 근거 있는 not-applicable로 채운다", () => {
    const result = evaluateDocumentationImpacts(input());

    expect(result["work-record"].outcome).toBe("required");
    expect(result["work-record"].sourceReferenceIds).toEqual(["verification-1"]);
    expect(result.adr).toMatchObject({ outcome: "not-applicable", ruleId: "adr.none.v1" });
    expect(result.changelog).toMatchObject({ outcome: "not-applicable", ruleId: "changelog.none.v1" });
    expect(result.runbook).toMatchObject({ outcome: "not-applicable", ruleId: "runbook.none.v1" });
  });

  it("검증된 proposal을 ADR·Changelog·Runbook required 판정으로 변환한다", () => {
    const original = input();
    const value: DocumentationImpactEvaluationInput = {
      ...original,
      proposals: [
        {
          kind: "decision",
          ruleHint: "architecture-decision",
          reason: "사용자가 구조 결정을 승인했습니다",
          sourceReferenceIds: ["message-decision"],
        },
        {
          kind: "user-visible",
          ruleHint: "public-api-change",
          reason: "공개 API 동작이 변경됐습니다",
          sourceReferenceIds: ["event-public-api"],
        },
        {
          kind: "operational",
          ruleHint: "database-migration",
          reason: "운영 migration 절차가 추가됐습니다",
          sourceReferenceIds: ["artifact-migration"],
        },
      ],
    };

    const result = evaluateDocumentationImpacts(value);
    expect(result.adr).toMatchObject({ outcome: "required", ruleId: "adr.decision.v1" });
    expect(result.changelog).toMatchObject({ outcome: "required", ruleId: "changelog.user-visible.v1" });
    expect(result.runbook).toMatchObject({ outcome: "required", ruleId: "runbook.operational.v1" });
  });

  it("source와 proposal 순서가 달라도 같은 판정을 만든다", () => {
    const original = input();
    const proposals = [
      {
        kind: "decision" as const,
        ruleHint: "architecture-decision",
        reason: "두 번째 결정 근거",
        sourceReferenceIds: ["message-decision"],
      },
      {
        kind: "decision" as const,
        ruleHint: "architecture-decision",
        reason: "첫 번째 결정 근거",
        sourceReferenceIds: ["message-decision"],
      },
    ];
    const forward = evaluateDocumentationImpacts({ ...original, proposals });
    const reverse = evaluateDocumentationImpacts({
      ...original,
      proposals: [...proposals].reverse(),
      sources: [...original.sources].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.adr.sourceReferenceIds).toEqual(["message-decision"]);
  });

  it("caller의 판정 주입과 다른 tenant·잘못된 source 종류를 거부한다", () => {
    const injectedOriginal = input();
    const injected = {
      ...injectedOriginal,
      proposals: [
        {
          kind: "decision",
          ruleHint: "architecture-decision",
          reason: "주입 시도",
          sourceReferenceIds: ["message-decision"],
          outcome: "required",
        },
      ],
    } as unknown as DocumentationImpactEvaluationInput;
    expect(() => evaluateDocumentationImpacts(injected)).toThrow("outcome 주입");

    const otherTenantOriginal = input();
    const otherTenant: DocumentationImpactEvaluationInput = {
      ...otherTenantOriginal,
      sources: otherTenantOriginal.sources.map((source, index) =>
        index === 1 ? { ...source, organizationId: "organization-2" } : source,
      ),
      proposals: [
        {
          kind: "decision",
          ruleHint: "architecture-decision",
          reason: "다른 조직 자료",
          sourceReferenceIds: ["message-decision"],
        },
      ],
    };
    expect(() => evaluateDocumentationImpacts(otherTenant)).toThrow("소유권");

    const wrongTypeOriginal = input();
    const wrongType: DocumentationImpactEvaluationInput = {
      ...wrongTypeOriginal,
      proposals: [
        {
          kind: "decision",
          ruleHint: "architecture-decision",
          reason: "Event는 결정 message가 아닙니다",
          sourceReferenceIds: ["event-public-api"],
        },
      ],
    };
    expect(() => evaluateDocumentationImpacts(wrongType)).toThrow("source 종류");
  });
});
