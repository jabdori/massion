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

function passedRecovery() {
  return {
    work: {
      organization_id: context.organizationId,
      work_id: input.workId,
      status: "verifying",
      revision: 9,
      organization_version_id: "org-v1",
      active_plan_version_id: "plan-1",
      artifact_version_ids: [],
      updated_at: new Date("2026-07-19T00:00:00.000Z"),
    },
    plans: [
      {
        plan_version_id: "plan-1",
        organization_id: context.organizationId,
        work_id: input.workId,
        content_json: "{}",
      },
    ],
    events: [],
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
}

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
          created_at: new Date("2026-07-19T00:00:00.000Z"),
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
      start: async (_context: unknown, value: { targetWorkRevision: number }) => {
        calls.push("start");
        return { recordsRunId: "records-1", status: "planned", targetWorkRevision: value.targetWorkRevision };
      },
      proposeImpacts: async (_context: unknown, value: { readonly evaluatedAt: string }) => {
        calls.push("impact");
        expect(value.evaluatedAt).toBe("2026-07-19T00:00:00.000Z");
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

  it("recoverWork 대기 중 abort하면 Records run을 시작하지 않는다", async () => {
    let releaseRecovery!: (value: { readonly verifications: readonly [] }) => void;
    let enteredRecovery!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      enteredRecovery = resolve;
    });
    const recovery = new Promise<{ readonly verifications: readonly [] }>((resolve) => {
      releaseRecovery = resolve;
    });
    let starts = 0;
    const controller = new AbortController();
    const stage = new CoreRecordsStage({
      works: {
        recoverWork: async () => {
          enteredRecovery();
          return await recovery;
        },
      },
      records: {
        start: async () => {
          starts += 1;
          return { recordsRunId: "records-1", status: "planned" };
        },
      },
      documents: { plan: async () => [] },
    } as never);

    const executing = stage.execute(context, { ...input, signal: controller.signal });
    await recoveryEntered;
    controller.abort();
    releaseRecovery({ verifications: [] });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(starts).toBe(0);
  });

  it("start 직후 abort하면 active Records run을 cancelled로 정리하고 후속 side effect를 열지 않는다", async () => {
    let releaseStart!: (value: {
      readonly recordsRunId: string;
      readonly status: "planned";
      readonly targetWorkRevision: number;
    }) => void;
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const started = new Promise<{
      readonly recordsRunId: string;
      readonly status: "planned";
      readonly targetWorkRevision: number;
    }>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const controller = new AbortController();
    const stage = new CoreRecordsStage({
      works: { recoverWork: async () => passedRecovery() },
      records: {
        start: async () => {
          calls.push("start");
          enteredStart();
          return await started;
        },
        cancel: async (_context: unknown, value: { readonly commandId: string; readonly recordsRunId: string }) => {
          calls.push("cancel");
          expect(value).toEqual({ commandId: `${input.commandId}:cancel`, recordsRunId: "records-1" });
          return { recordsRunId: "records-1", status: "cancelled" };
        },
        proposeImpacts: async () => {
          calls.push("impacts");
          return { assessments: [] };
        },
        finalize: async () => {
          calls.push("finalize");
          return {};
        },
        complete: async () => {
          calls.push("complete");
          return { run: { recordsRunId: "records-1", status: "completed" } };
        },
      },
      documents: {
        plan: async () => {
          calls.push("documents");
          return [];
        },
      },
    } as never);

    const executing = stage.execute(context, { ...input, signal: controller.signal });
    await startEntered;
    controller.abort();
    releaseStart({ recordsRunId: "records-1", status: "planned", targetWorkRevision: 9 });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(calls).toEqual(["start", "cancel"]);
  });

  it("stage cancel은 이미 시작된 active Records run을 cancelled로 정리한다", async () => {
    let releaseImpacts!: (value: { readonly assessments: readonly [] }) => void;
    let enteredImpacts!: () => void;
    const impactsEntered = new Promise<void>((resolve) => {
      enteredImpacts = resolve;
    });
    const impacts = new Promise<{ readonly assessments: readonly [] }>((resolve) => {
      releaseImpacts = resolve;
    });
    const calls: string[] = [];
    const controller = new AbortController();
    const stage = new CoreRecordsStage({
      works: { recoverWork: async () => passedRecovery() },
      records: {
        start: async () => {
          calls.push("start");
          return { recordsRunId: "records-1", status: "planned", targetWorkRevision: 9 };
        },
        cancel: async () => {
          calls.push("cancel");
          return { recordsRunId: "records-1", status: "cancelled" };
        },
        proposeImpacts: async () => {
          calls.push("impacts");
          enteredImpacts();
          return await impacts;
        },
        finalize: async () => {
          calls.push("finalize");
          return {};
        },
        complete: async () => {
          calls.push("complete");
          return { run: { recordsRunId: "records-1", status: "completed" } };
        },
      },
      documents: {
        plan: async () => {
          calls.push("documents");
          return [];
        },
      },
    } as never);

    const executing = stage.execute(context, { ...input, signal: controller.signal });
    await impactsEntered;
    const cancelling = (
      stage as unknown as {
        cancel(tenantContext: typeof context, value: typeof input & { readonly signal: AbortSignal }): Promise<void>;
      }
    ).cancel(context, { ...input, commandId: `${input.commandId}:cancel`, signal: controller.signal });

    await expect(cancelling).resolves.toBeUndefined();
    releaseImpacts({ assessments: [] });
    await expect(executing).rejects.toThrow("Application run cancelled");

    expect(calls).toEqual(["start", "impacts", "cancel"]);
  });

  it("실패한 Records cancellation은 같은 active run에서 다시 시도한다", async () => {
    let releaseImpacts!: (value: { readonly assessments: readonly [] }) => void;
    let enteredImpacts!: () => void;
    const impactsEntered = new Promise<void>((resolve) => {
      enteredImpacts = resolve;
    });
    const impacts = new Promise<{ readonly assessments: readonly [] }>((resolve) => {
      releaseImpacts = resolve;
    });
    let cancellationAttempts = 0;
    const stage = new CoreRecordsStage({
      works: { recoverWork: async () => passedRecovery() },
      records: {
        start: async () => ({ recordsRunId: "records-1", status: "planned", targetWorkRevision: 9 }),
        cancel: async () => {
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) throw new Error("Records cancellation failed");
          return { recordsRunId: "records-1", status: "cancelled" };
        },
        proposeImpacts: async () => {
          enteredImpacts();
          return await impacts;
        },
        finalize: async () => ({}),
        complete: async () => ({ run: { recordsRunId: "records-1", status: "completed" } }),
      },
      documents: { plan: async () => [] },
    } as never);

    const executing = stage.execute(context, input);
    await impactsEntered;

    await expect(stage.cancel(context, { ...input, commandId: `${input.commandId}:cancel` })).rejects.toThrow(
      "Records cancellation failed",
    );
    await expect(stage.cancel(context, { ...input, commandId: `${input.commandId}:cancel` })).resolves.toBeUndefined();

    releaseImpacts({ assessments: [] });
    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(cancellationAttempts).toBe(2);
  });
});
