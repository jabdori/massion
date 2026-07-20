import { describe, expect, it } from "vitest";

import { CoreEvidenceStage } from "./core-evidence-stage.js";

const context = {
  userId: "evidence-user",
  organizationId: "evidence-org",
  membershipId: "evidence-member",
  role: "owner" as const,
};
const input = {
  runId: "evidence-run-0001",
  workId: "evidence-work-0001",
  commandId: "evidence-run-0001:evidence",
  correlationId: "evidence-correlation-0001",
  request: {},
};

describe("CoreEvidenceStage", () => {
  it("evidence가 없어도 빈 evidence로 진행하고 같은 Work의 fresh brief가 있으면 검증 후 통과한다", async () => {
    const plan = {
      content_json: JSON.stringify({ evidenceRequests: [{ key: "source", question: "근거?", required: true }] }),
    };
    const withoutEvidence = new CoreEvidenceStage({
      works: { getActivePlan: async () => plan },
      briefs: {
        getBrief: async () => {
          throw new Error("not called");
        },
      },
    } as never);
    await expect(withoutEvidence.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { evidenceBriefIds: [] },
    });
    const complete = new CoreEvidenceStage({
      works: { getActivePlan: async () => plan },
      briefs: {
        getBrief: async () => ({
          evidenceBriefId: "brief-1",
          workId: input.workId,
          status: "ready",
          checksum: "a".repeat(64),
        }),
      },
    } as never);
    await expect(
      complete.execute(context, { ...input, request: { evidenceBriefIds: ["brief-1"] } }),
    ).resolves.toMatchObject({ outcome: "advanced", data: { evidenceBriefIds: ["brief-1"] } });
  });

  it("다른 Work·stale·failed brief를 거부한다", async () => {
    const stage = new CoreEvidenceStage({
      works: { getActivePlan: async () => ({ content_json: JSON.stringify({ evidenceRequests: [] }) }) },
      briefs: {
        getBrief: async () => ({
          evidenceBriefId: "brief-1",
          workId: "other-work",
          status: "ready",
          checksum: "a".repeat(64),
        }),
      },
    } as never);
    await expect(
      stage.execute(context, { ...input, request: { evidenceBriefIds: ["brief-1"] } }),
    ).resolves.toMatchObject({ outcome: "blocked", reason: "evidence-invalid" });
  });
});
