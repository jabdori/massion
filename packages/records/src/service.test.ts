import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import type {
  CompleteRecordsProjectionResult,
  FinalizeRecordsProjectionInput,
  FinalizeRecordsProjectionResult,
} from "@massion/work";

import type { RecordsRun } from "./contracts.js";
import type { DocumentationImpactEvaluation } from "./impact.js";
import { RecordsService } from "./service.js";

const context: TenantContext = {
  organizationId: "organization-1",
  userId: "user-1",
  membershipId: "membership-1",
  role: "owner",
};
const now = "2026-07-11T00:00:00.000Z";

function run(status: RecordsRun["status"] = "planned"): RecordsRun {
  return {
    recordsRunId: "records-run-1",
    organizationId: context.organizationId,
    workId: "work-1",
    targetWorkRevision: 9,
    verificationId: "verification-1",
    assuranceRunId: "assurance-run-1",
    snapshotHash: "a".repeat(64),
    rendererVersion: "massion.records.markdown.v1",
    status,
    version: status === "planned" ? 1 : 2,
    attempt: 1,
    commandId: "records:start",
    requestHash: "b".repeat(64),
    createdByUserId: context.userId,
    startedAt: now,
    updatedAt: now,
  };
}

function dependencies() {
  let current = run();
  const runStore = {
    start: vi.fn(async () => current),
    get: vi.fn(async () => current),
    cancel: vi.fn(async () => {
      current = { ...run("cancelled"), completedAt: now };
      return current;
    }),
    recordImpacts: vi.fn(async (_context, _commandId, _recordsRunId, evaluation: DocumentationImpactEvaluation) => {
      current = run("rendering");
      return { run: current, assessments: Object.values(evaluation) };
    }),
    complete: vi.fn(async () => {
      current = { ...run("completed"), version: 4, completedAt: now };
      return current;
    }),
  };
  const workPort = {
    finalize: vi.fn(async (_context: TenantContext, input: FinalizeRecordsProjectionInput) => {
      current = { ...run("finalized"), version: 3 };
      return { input } as unknown as FinalizeRecordsProjectionResult;
    }),
    complete: vi.fn(
      async (_context: TenantContext, input: unknown) => ({ input }) as unknown as CompleteRecordsProjectionResult,
    ),
  };
  return { runStore, workPort };
}

describe("Records service orchestration", () => {
  it("start를 RecordsRunStore에 위임한다", async () => {
    const deps = dependencies();
    const service = new RecordsService(deps.runStore, deps.workPort);
    const input = {
      commandId: "records:start",
      workId: "work-1",
      targetWorkRevision: 9,
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      snapshotHash: "a".repeat(64),
      rendererVersion: "massion.records.markdown.v1",
    };

    expect(await service.start(context, input)).toEqual(run());
    expect(deps.runStore.start).toHaveBeenCalledWith(context, input);
  });

  it("active Records run cancellation을 RecordsRunStore에 위임한다", async () => {
    const deps = dependencies();
    const service = new RecordsService(deps.runStore, deps.workPort);
    const cancellation = { commandId: "records:cancel", recordsRunId: "records-run-1" };

    const result = await (
      service as unknown as {
        cancel(context: TenantContext, input: typeof cancellation): Promise<RecordsRun>;
      }
    ).cancel(context, cancellation);

    expect(result).toMatchObject({ recordsRunId: "records-run-1", status: "cancelled" });
    expect(deps.runStore.cancel).toHaveBeenCalledWith(context, cancellation);
  });

  it("네 impact를 deterministic 평가해 저장하고 rendering으로 전이한다", async () => {
    const deps = dependencies();
    const service = new RecordsService(deps.runStore, deps.workPort);
    const result = await service.proposeImpacts(context, {
      commandId: "records:impact",
      recordsRunId: "records-run-1",
      evaluatedAt: now,
      proposals: [
        {
          kind: "decision",
          ruleHint: "architecture-decision",
          reason: "구조 결정을 승인했습니다",
          sourceReferenceIds: ["message-1"],
        },
      ],
      sources: [
        {
          referenceId: "verification-1",
          organizationId: context.organizationId,
          workId: "work-1",
          sourceType: "verification",
        },
        {
          referenceId: "message-1",
          organizationId: context.organizationId,
          workId: "work-1",
          sourceType: "message",
        },
      ],
    });

    expect(result.run.status).toBe("rendering");
    expect(result.assessments).toHaveLength(4);
    expect(result.assessments.find((assessment) => assessment.kind === "adr")?.outcome).toBe("required");
    expect(deps.runStore.recordImpacts).toHaveBeenCalledOnce();
  });

  it("typed source를 renderer 결과로 바꿔 caller summary 없이 Work port에 전달한다", async () => {
    const deps = dependencies();
    await deps.runStore.recordImpacts(context, "prepare", "records-run-1", {} as DocumentationImpactEvaluation);
    const service = new RecordsService(deps.runStore, deps.workPort);
    await service.finalize(context, {
      commandId: "records:finalize",
      recordsRunId: "records-run-1",
      expectedWorkRevision: 9,
      documentSources: [
        {
          kind: "changelog",
          title: "Records gate",
          sourceReferenceIds: ["event-1"],
          category: "security",
          audience: "Massion 사용자",
          notableChange: "검증된 기록이 없으면 완료할 수 없습니다.",
        },
      ],
    });

    const projected = deps.workPort.finalize.mock.calls[0]?.[1];
    expect(projected).toMatchObject({
      workId: "work-1",
      expectedRevision: 9,
      recordsRunId: "records-run-1",
      verificationId: "verification-1",
    });
    expect(projected?.documents[0]).toMatchObject({
      kind: "changelog",
      rendererVersion: "massion.records.markdown.v1",
    });
    expect(projected?.documents[0]?.markdownChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(projected).not.toHaveProperty("summary");
  });

  it("planned run의 finalize와 다른 renderer version 결과를 거부한다", async () => {
    const deps = dependencies();
    const service = new RecordsService(deps.runStore, deps.workPort);
    await expect(
      service.finalize(context, {
        commandId: "records:finalize",
        recordsRunId: "records-run-1",
        expectedWorkRevision: 9,
        documentSources: [],
      }),
    ).rejects.toThrow("rendering");
  });

  it("N+3 Work completion 뒤 Records run을 terminal completed로 확정한다", async () => {
    const deps = dependencies();
    await deps.runStore.recordImpacts(context, "prepare", "records-run-1", {} as DocumentationImpactEvaluation);
    await deps.workPort.finalize(context, {} as FinalizeRecordsProjectionInput);
    const service = new RecordsService(deps.runStore, deps.workPort);

    const result = await service.complete(context, { recordsRunId: "records-run-1" });

    expect(result.run.status).toBe("completed");
    expect(deps.workPort.complete).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ commandId: "records-run-1:complete", expectedRevision: 10 }),
    );
    expect(deps.runStore.complete).toHaveBeenCalledWith(context, {
      commandId: "records-run-1:terminal",
      recordsRunId: "records-run-1",
      expectedVersion: 3,
    });
  });
});
