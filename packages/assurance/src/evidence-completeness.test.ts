import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "@massion/storage";

import { evaluateAssuranceEvidenceCompleteness } from "./service.js";

const references = ["artifact-1", "brief-1", "metric-1", "attestation-1"] as const;

function executor(missing?: string): QueryExecutor {
  return {
    query: vi.fn(async (_sql: string, parameters?: Readonly<Record<string, unknown>>) => {
      const ids = (parameters?.ids as readonly string[] | undefined) ?? [];
      return [ids.filter((id) => id !== missing).map((id) => ({ id }))];
    }),
  } as unknown as QueryExecutor;
}

async function evaluate(missing?: string) {
  const criteria = ["artifact", "brief", "metric", "human"].map((kind) => ({
    criterion_id: `criterion-${kind}`,
    criterion_key: `criterion:${kind}`,
    status: "passed",
  }));
  const checks = [
    {
      criterion_id: "criterion-artifact",
      command_key: "check:artifact",
      status: "passed",
      output_hash: "a".repeat(64),
      artifact_version_ids: ["artifact-1"],
      evidence_brief_ids: [],
      metric_observation_ids: [],
      human_attestation_ids: [],
    },
    {
      criterion_id: "criterion-brief",
      command_key: "check:brief",
      status: "passed",
      output_hash: "b".repeat(64),
      artifact_version_ids: [],
      evidence_brief_ids: ["brief-1"],
      metric_observation_ids: [],
      human_attestation_ids: [],
    },
    {
      criterion_id: "criterion-metric",
      command_key: "check:metric",
      status: "passed",
      output_hash: "c".repeat(64),
      artifact_version_ids: [],
      evidence_brief_ids: [],
      metric_observation_ids: ["metric-1"],
      human_attestation_ids: [],
    },
    {
      criterion_id: "criterion-human",
      command_key: "check:human",
      status: "passed",
      output_hash: "d".repeat(64),
      artifact_version_ids: [],
      evidence_brief_ids: [],
      metric_observation_ids: [],
      human_attestation_ids: ["attestation-1"],
    },
  ];
  return await evaluateAssuranceEvidenceCompleteness(executor(missing), {
    organizationId: "organization-1",
    workId: "work-1",
    bindingsJson: JSON.stringify([
      {
        bindingKey: "check:artifact",
        criterionKey: "criterion:artifact",
        kind: "test",
        requiredEvidenceKinds: ["artifact-version"],
      },
      {
        bindingKey: "check:brief",
        criterionKey: "criterion:brief",
        kind: "evidence",
        evidenceKinds: ["evidence-brief"],
      },
      { bindingKey: "check:metric", criterionKey: "criterion:metric", kind: "metric" },
      { bindingKey: "check:human", criterionKey: "criterion:human", kind: "human" },
    ]),
    criteria,
    checks,
    findings: [],
  });
}

describe("Assurance 판정 증거 참조 완전성", () => {
  it("모든 evidence record가 같은 tenant·Work에 존재할 때만 완전하다", async () => {
    await expect(evaluate()).resolves.toEqual({
      bindingValid: true,
      structurallyValid: true,
      requiredEvidenceComplete: true,
    });
  });

  it.each(references)("참조된 %s record가 없으면 불완전하다", async (missing) => {
    await expect(evaluate(missing)).resolves.toMatchObject({ requiredEvidenceComplete: false });
  });
});
