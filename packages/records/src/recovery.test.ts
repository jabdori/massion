import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import type { RecordsRun } from "./contracts.js";

import { classifyRecordsRecovery, RecordsRecovery, recordsRecoveryCommands } from "./recovery.js";

describe("Records recovery crash matrix", () => {
  it.each([
    ["planned", 0, 0, false, false, "assessment-required"],
    ["rendering", 4, 0, false, false, "render-required"],
    ["rendering", 4, 1, false, false, "finalize-required"],
    ["finalized", 4, 1, true, false, "completion-required"],
    ["finalized", 4, 1, true, true, "terminal-required"],
    ["completed", 4, 1, true, true, "terminal-unchanged"],
    ["blocked", 4, 0, false, false, "terminal-unchanged"],
    ["cancelled", 0, 0, false, false, "terminal-unchanged"],
  ] as const)(
    "%s run과 저장 상태를 %s 단계로 분류한다",
    (status, assessmentCount, renderedDocumentCount, workRecordExists, workCompleted, expected) => {
      expect(
        classifyRecordsRecovery({
          status,
          assessmentCount,
          requiredDocumentCount: 1,
          renderedDocumentCount,
          workRecordExists,
          workCompleted,
        }),
      ).toBe(expected);
    },
  );

  it("복구 command ID를 run identity에서 결정적으로 파생한다", () => {
    expect(recordsRecoveryCommands("records-run-1")).toEqual({
      assess: "records-run-1:assess",
      render: "records-run-1:render",
      finalize: "records-run-1:finalize",
      complete: "records-run-1:complete",
      terminal: "records-run-1:terminal",
      recovery: "records-run-1:recovery",
    });
  });

  it("불가능한 assessment·document·WorkRecord 조합은 손상으로 거부한다", () => {
    expect(() =>
      classifyRecordsRecovery({
        status: "rendering",
        assessmentCount: 3,
        requiredDocumentCount: 1,
        renderedDocumentCount: 0,
        workRecordExists: false,
        workCompleted: false,
      }),
    ).toThrow("assessment");
    expect(() =>
      classifyRecordsRecovery({
        status: "rendering",
        assessmentCount: 4,
        requiredDocumentCount: 1,
        renderedDocumentCount: 2,
        workRecordExists: false,
        workCompleted: false,
      }),
    ).toThrow("document");
  });
});

describe("Records recovery orchestration", () => {
  const context = {
    organizationId: "organization-1",
    userId: "user-1",
    membershipId: "membership-1",
    role: "owner",
  } as TenantContext;
  const run = {
    recordsRunId: "records-run-1",
    organizationId: context.organizationId,
    workId: "work-1",
    targetWorkRevision: 9,
    verificationId: "verification-1",
    assuranceRunId: "assurance-run-1",
    snapshotHash: "a".repeat(64),
    rendererVersion: "massion.records.markdown.v1",
    status: "finalized",
    version: 3,
    attempt: 1,
    commandId: "start",
    requestHash: "b".repeat(64),
    createdByUserId: "user-1",
    startedAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  } as RecordsRun;

  it("active crash를 재개하고 ledger·metric을 한 번 기록한다", async () => {
    const continuation = vi.fn(async () => undefined);
    const ledger = { replay: vi.fn(async () => undefined), record: vi.fn(async () => undefined) };
    const metrics = { recordOnce: vi.fn(async () => undefined) };
    const recovery = new RecordsRecovery({
      gateway: { get: vi.fn(async () => run) },
      readiness: {
        inspect: vi.fn(async () => ({
          status: "finalized" as const,
          assessmentCount: 4,
          requiredDocumentCount: 1,
          renderedDocumentCount: 1,
          workRecordExists: true,
          workCompleted: false,
        })),
      },
      continuation: { resume: continuation },
      ledger,
      metrics,
    });

    const result = await recovery.recover(context, { commandId: "recover-1", recordsRunId: "records-run-1" });

    expect(result.stage).toBe("completion-required");
    expect(result.result).toBe("resumed");
    expect(continuation).toHaveBeenCalledWith(
      context,
      run,
      "completion-required",
      recordsRecoveryCommands("records-run-1"),
    );
    expect(ledger.record).toHaveBeenCalledOnce();
    expect(metrics.recordOnce).toHaveBeenCalledOnce();
  });

  it("terminal run은 continuation 없이 terminal-unchanged로 기록한다", async () => {
    const terminal = { ...run, status: "completed", completedAt: "2026-07-11T00:01:00.000Z" } as RecordsRun;
    const continuation = vi.fn(async () => undefined);
    const recovery = new RecordsRecovery({
      gateway: { get: vi.fn(async () => terminal) },
      readiness: {
        inspect: vi.fn(async () => ({
          status: "completed" as const,
          assessmentCount: 4,
          requiredDocumentCount: 1,
          renderedDocumentCount: 1,
          workRecordExists: true,
          workCompleted: true,
        })),
      },
      continuation: { resume: continuation },
      ledger: { replay: vi.fn(async () => undefined), record: vi.fn(async () => undefined) },
      metrics: { recordOnce: vi.fn(async () => undefined) },
    });

    expect(
      await recovery.recover(context, { commandId: "recover-terminal", recordsRunId: terminal.recordsRunId }),
    ).toMatchObject({
      stage: "terminal-unchanged",
      result: "terminal-unchanged",
    });
    expect(continuation).not.toHaveBeenCalled();
  });
});
