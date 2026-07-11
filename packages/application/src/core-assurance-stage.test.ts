import { describe, expect, it } from "vitest";

import { CoreAssuranceStage } from "./core-assurance-stage.js";

const context = {
  userId: "assurance-user",
  organizationId: "assurance-org",
  membershipId: "assurance-member",
  role: "owner" as const,
};
const input = {
  runId: "assurance-run-root",
  workId: "assurance-work",
  commandId: "assurance-run-root:assurance",
  correlationId: "assurance-correlation",
  request: { assurance: { bindingVersionId: "binding-1", profileId: "profile-1", profileVersion: "1.0.0" } },
};

describe("CoreAssuranceStage", () => {
  it("snapshot→independent verifier→run→checks→decide 순서와 service verdict를 사용한다", async () => {
    const calls: string[] = [];
    const assurance = {
      prepareSnapshot: async () => {
        calls.push("snapshot");
        return { snapshot: { hash: "a".repeat(64) } };
      },
      start: async () => {
        calls.push("start");
        return { run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } };
      },
      get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
      decide: async () => {
        calls.push("decide");
        return {
          run: { assuranceRunId: "assurance-1", status: "passed", version: 3, projectedWorkRevision: 8 },
          decision: { status: "passed" },
        };
      },
    };
    const stage = new CoreAssuranceStage({
      works: { getWork: async () => ({ revision: 7 }), getActivePlan: async () => ({ plan_version_id: "plan-1" }) },
      runner: {
        execute: async () => {
          calls.push("verifier");
          return { executionId: "verifier-execution", status: "succeeded" };
        },
      },
      assurance,
      checks: {
        execute: async () => {
          calls.push("checks");
          return { outcome: "ready" };
        },
      },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { assuranceRunId: "assurance-1", verdict: "passed" },
    });
    expect(calls).toEqual(["snapshot", "verifier", "start", "checks", "decide"]);
  });

  it("human check는 approval 대기로, failed verdict는 명시 차단으로 반환한다", async () => {
    const base = {
      works: { getWork: async () => ({ revision: 7 }), getActivePlan: async () => ({ plan_version_id: "plan-1" }) },
      runner: { execute: async () => ({ executionId: "verifier", status: "succeeded" }) },
      assurance: {
        prepareSnapshot: async () => ({ snapshot: { hash: "a".repeat(64) } }),
        start: async () => ({ run: { assuranceRunId: "assurance-1", status: "planned", version: 1 } }),
        get: async () => ({ assuranceRunId: "assurance-1", status: "running", version: 2 }),
        decide: async () => ({
          run: { assuranceRunId: "assurance-1", status: "failed", version: 2 },
          decision: { status: "failed" },
        }),
      },
    };
    const waiting = new CoreAssuranceStage({
      ...base,
      checks: { execute: async () => ({ outcome: "awaiting-approval", approvalId: "approval-1" }) },
    } as never);
    await expect(waiting.execute(context, input)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      approvalId: "approval-1",
    });
    const failed = new CoreAssuranceStage({
      ...base,
      checks: { execute: async () => ({ outcome: "ready" }) },
    } as never);
    await expect(failed.execute(context, input)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "assurance-failed",
    });
  });
});
