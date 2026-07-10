import { describe, expect, it } from "vitest";

import { decideAssuranceVerdict, type AssuranceVerdictDecisionInput } from "./verdict.js";

function input(overrides: Partial<AssuranceVerdictDecisionInput> = {}): AssuranceVerdictDecisionInput {
  return {
    cancellationRequested: false,
    snapshotStatus: "fresh",
    identityValid: true,
    bindingValid: true,
    independenceValid: true,
    verifierSucceeded: true,
    requiredEvidenceComplete: true,
    criteria: [{ criterionId: "criterion-1", status: "passed" }],
    checks: [{ criterionId: "criterion-1", bindingKey: "check-1", status: "passed", outputHash: "a".repeat(64) }],
    findings: [],
    ...overrides,
  };
}

describe("deterministic Assurance verdict", () => {
  it("explicit cancellation은 다른 결과보다 우선하며 Work projection 없는 cancelled를 반환한다", () => {
    expect(
      decideAssuranceVerdict(
        input({
          cancellationRequested: true,
          snapshotStatus: "stale",
          criteria: [{ criterionId: "criterion-1", status: "failed" }],
        }),
      ),
    ).toEqual({ status: "cancelled", evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it.each([
    { label: "stale snapshot", change: { snapshotStatus: "stale" as const } },
    { label: "invalid snapshot", change: { snapshotStatus: "invalid" as const } },
    { label: "identity", change: { identityValid: false } },
    { label: "binding", change: { bindingValid: false } },
    { label: "independence", change: { independenceValid: false } },
  ])("$label 무결성 실패는 다른 check를 신뢰하지 않고 blocked다", ({ change }) => {
    const decision = decideAssuranceVerdict(
      input({ ...change, criteria: [{ criterionId: "criterion-1", status: "failed" }] }),
    );
    expect(decision).toMatchObject({ status: "blocked", failure: { category: "assurance_integrity_blocked" } });
  });

  it.each([
    {
      label: "criterion failed",
      change: { criteria: [{ criterionId: "criterion-1", status: "failed" as const }] },
    },
    {
      label: "exit mismatch check",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "failed" as const }],
        checks: [
          {
            criterionId: "criterion-1",
            bindingKey: "check-failed",
            status: "failed" as const,
            outputHash: "b".repeat(64),
          },
          { criterionId: "criterion-1", bindingKey: "check-timeout", status: "blocked" as const },
        ],
      },
    },
    {
      label: "open critical finding",
      change: { findings: [{ findingId: "finding-1", severity: "critical" as const, status: "open" as const }] },
    },
    {
      label: "open major finding",
      change: { findings: [{ findingId: "finding-1", severity: "major" as const, status: "open" as const }] },
    },
    {
      label: "open minor finding",
      change: { findings: [{ findingId: "finding-1", severity: "minor" as const, status: "open" as const }] },
    },
    {
      label: "valid SARIF security finding",
      change: { findings: [{ findingId: "sarif-1", severity: "major" as const, status: "open" as const }] },
    },
    {
      label: "evidence checksum tamper finding",
      change: { findings: [{ findingId: "tamper-1", severity: "critical" as const, status: "open" as const }] },
    },
    {
      label: "metric threshold false",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "failed" as const }],
        checks: [
          { criterionId: "criterion-1", bindingKey: "metric-1", status: "failed" as const, outputHash: "d".repeat(64) },
        ],
      },
    },
    {
      label: "human reject",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "failed" as const }],
        checks: [
          { criterionId: "criterion-1", bindingKey: "human-1", status: "failed" as const, outputHash: "e".repeat(64) },
        ],
      },
    },
  ])("확정 실패인 $label은 blocked check가 섞여도 failed다", ({ change }) => {
    const decision = decideAssuranceVerdict(input(change));
    expect(decision).toMatchObject({ status: "failed", failure: { category: "assurance_criterion_failed" } });
  });

  it.each([
    { label: "verifier 미완료", change: { verifierSucceeded: false } },
    { label: "required evidence missing", change: { requiredEvidenceComplete: false } },
    { label: "criterion pending", change: { criteria: [{ criterionId: "criterion-1", status: "pending" as const }] } },
    { label: "criterion blocked", change: { criteria: [{ criterionId: "criterion-1", status: "blocked" as const }] } },
    {
      label: "invalid SARIF check",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "blocked" as const }],
        checks: [{ criterionId: "criterion-1", bindingKey: "inspection-1", status: "blocked" as const }],
      },
    },
    {
      label: "timeout check",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "blocked" as const }],
        checks: [{ criterionId: "criterion-1", bindingKey: "timeout-1", status: "blocked" as const }],
      },
    },
    {
      label: "output bound check",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "blocked" as const }],
        checks: [{ criterionId: "criterion-1", bindingKey: "output-limit-1", status: "blocked" as const }],
      },
    },
    { label: "evidence missing", change: { requiredEvidenceComplete: false } },
    {
      label: "metric missing",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "blocked" as const }],
        checks: [{ criterionId: "criterion-1", bindingKey: "metric-1", status: "blocked" as const }],
      },
    },
    {
      label: "human missing",
      change: {
        criteria: [{ criterionId: "criterion-1", status: "blocked" as const }],
        checks: [{ criterionId: "criterion-1", bindingKey: "human-1", status: "blocked" as const }],
      },
    },
    { label: "criterion 없음", change: { criteria: [], checks: [] } },
    { label: "check coverage 없음", change: { checks: [] } },
    {
      label: "cancelled check 재사용",
      change: { checks: [{ criterionId: "criterion-1", bindingKey: "check-1", status: "cancelled" as const }] },
    },
  ])("판정 불능인 $label은 blocked다", ({ change }) => {
    const decision = decideAssuranceVerdict(input(change));
    expect(decision).toMatchObject({ status: "blocked", failure: { category: "assurance_evidence_blocked" } });
  });

  it("excluded criterion, resolved finding, accepted minor와 open info는 통과를 막지 않는다", () => {
    const decision = decideAssuranceVerdict(
      input({
        criteria: [
          { criterionId: "criterion-1", status: "passed" },
          { criterionId: "criterion-excluded", status: "excluded" },
        ],
        findings: [
          { findingId: "finding-resolved", severity: "critical", status: "resolved" },
          { findingId: "finding-accepted", severity: "minor", status: "accepted" },
          { findingId: "finding-info", severity: "info", status: "open" },
        ],
      }),
    );
    expect(decision).toEqual({ status: "passed", evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it("unknown criterion check·중복 binding·output hash 없는 passed check는 fail-closed blocked다", () => {
    for (const checks of [
      [{ criterionId: "unknown", bindingKey: "check-1", status: "passed" as const, outputHash: "a".repeat(64) }],
      [
        { criterionId: "criterion-1", bindingKey: "check-1", status: "passed" as const, outputHash: "a".repeat(64) },
        { criterionId: "criterion-1", bindingKey: "check-1", status: "passed" as const, outputHash: "a".repeat(64) },
      ],
      [{ criterionId: "criterion-1", bindingKey: "check-1", status: "passed" as const }],
    ]) {
      expect(decideAssuranceVerdict(input({ checks }))).toMatchObject({ status: "blocked" });
    }
  });

  it("런타임에 위조된 criterion·check·finding 배열도 예외 없이 fail-closed blocked다", () => {
    for (const forged of [
      { criteria: null },
      { checks: "passed" },
      { findings: [{ findingId: "finding-1", severity: "unknown", status: "open" }] },
      { criteria: [{ criterionId: "criterion-1", status: "forged" }] },
      { checks: [{ criterionId: "criterion-1", bindingKey: "check-1", status: "passed", outputHash: 7 }] },
    ]) {
      expect(decideAssuranceVerdict({ ...input(), ...forged } as never)).toMatchObject({ status: "blocked" });
    }
  });

  it("caller의 verdict·target 판정 주입을 거부한다", () => {
    expect(() => decideAssuranceVerdict({ ...input(), verdict: "passed" } as never)).toThrow("caller verdict");
    expect(() => decideAssuranceVerdict({ ...input(), target: "passed" } as never)).toThrow("caller verdict");
  });
});
