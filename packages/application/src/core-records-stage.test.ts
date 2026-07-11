import { describe, expect, it } from "vitest";

import { CoreRecordsStage } from "./core-records-stage.js";

const context = {
  userId: "records-user",
  organizationId: "records-org",
  membershipId: "records-member",
  role: "owner" as const,
};
const input = {
  runId: "records-root-run",
  workId: "records-work",
  commandId: "records-root-run:records",
  correlationId: "records-correlation",
  request: {},
};

describe("CoreRecordsStage", () => {
  it("passed verification 정본으로 start→impact→documents→finalize→complete를 수행한다", async () => {
    const calls: string[] = [];
    const bundle = {
      work: {
        organization_id: context.organizationId,
        work_id: input.workId,
          status: "verifying",
        revision: 9,
        organization_version_id: "org-v1",
        active_plan_version_id: "plan-1",
        artifact_version_ids: ["artifact-v1"],
      },
      plans: [
        {
          plan_version_id: "plan-1",
          organization_id: context.organizationId,
          work_id: input.workId,
          content_json: "{}",
        },
      ],
      events: [
        {
          event_id: "event-1",
          organization_id: context.organizationId,
          work_id: input.workId,
          sequence: 1,
          event_type: "work_created",
          request_json: "{}",
          result_json: "{}",
        },
      ],
      messages: [],
      artifacts: [
        {
          artifact_id: "artifact-1",
          organization_id: context.organizationId,
          work_id: input.workId,
          kind: "result",
          name: "result",
        },
      ],
      artifactVersions: [
        {
          artifact_version_id: "artifact-v1",
          artifact_id: "artifact-1",
          organization_id: context.organizationId,
          work_id: input.workId,
          checksum: "a".repeat(64),
        },
      ],
      verifications: [
        {
          verification_id: "verification-1",
          organization_id: context.organizationId,
          work_id: input.workId,
          passed: true,
          target_work_revision: 8,
          projected_work_revision: 9,
          assurance_run_id: "assurance-1",
          snapshot_hash: "b".repeat(64),
          profile_id: "profile",
          profile_version: "1",
          binding_version_id: "binding",
          evidence_artifact_version_id: "artifact-v1",
        },
      ],
      records: [],
    };
    const records = {
      start: async (_context: unknown, value: any) => {
        calls.push("start");
        return { recordsRunId: "records-1", status: "planned", targetWorkRevision: value.targetWorkRevision };
      },
      proposeImpacts: async () => {
        calls.push("impact");
        return {
          run: { recordsRunId: "records-1", status: "rendering" },
          assessments: [{ kind: "work-record", outcome: "required" }],
        };
      },
      finalize: async () => {
        calls.push("finalize");
        return {};
      },
      complete: async () => {
        calls.push("complete");
        return { run: { recordsRunId: "records-1", status: "completed" } };
      },
    };
    const stage = new CoreRecordsStage({
      works: { recoverWork: async () => bundle },
      records,
      documents: {
        plan: async () => {
          calls.push("documents");
          return [];
        },
      },
    } as never);
    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { recordsRunId: "records-1" },
    });
    expect(calls).toEqual(["start", "impact", "documents", "finalize", "complete"]);
  });

  it("passed verification이 없거나 required 문서가 누락되면 명시 차단한다", async () => {
    const noVerification = new CoreRecordsStage({
      works: { recoverWork: async () => ({ verifications: [] }) },
    } as never);
    await expect(noVerification.execute(context, input)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "passed-verification-required",
    });
  });
});
