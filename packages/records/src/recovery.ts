import type { RecordsRunStatus } from "./contracts.js";
import type { RecordsRun } from "./contracts.js";
import type { TenantContext } from "@massion/identity";

export type RecordsRecoveryStage =
  | "assessment-required"
  | "render-required"
  | "finalize-required"
  | "completion-required"
  | "terminal-required"
  | "terminal-unchanged";

export interface RecordsRecoveryState {
  readonly status: RecordsRunStatus;
  readonly assessmentCount: number;
  readonly requiredDocumentCount: number;
  readonly renderedDocumentCount: number;
  readonly workRecordExists: boolean;
  readonly workCompleted: boolean;
}

function count(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} count가 유효하지 않습니다`);
  }
}

export function classifyRecordsRecovery(state: RecordsRecoveryState): RecordsRecoveryStage {
  count(state.assessmentCount, "assessment", 4);
  count(state.requiredDocumentCount, "required document", 3);
  count(state.renderedDocumentCount, "rendered document", 3);
  if (state.renderedDocumentCount > state.requiredDocumentCount) {
    throw new Error("rendered document count가 required document count보다 큽니다");
  }
  if (state.status === "planned") {
    if (state.assessmentCount !== 0 || state.renderedDocumentCount !== 0 || state.workRecordExists) {
      throw new Error("planned Records run의 assessment·document·WorkRecord 상태가 손상됐습니다");
    }
    return "assessment-required";
  }
  if (["completed", "blocked", "cancelled"].includes(state.status)) return "terminal-unchanged";
  if (state.assessmentCount !== 4) throw new Error("active Records run에는 네 assessment가 필요합니다");
  if (state.workRecordExists && state.renderedDocumentCount !== state.requiredDocumentCount) {
    throw new Error("WorkRecord 이전에 required document가 모두 렌더링되어야 합니다");
  }
  if (state.workCompleted && !state.workRecordExists) throw new Error("completed Work에는 WorkRecord가 필요합니다");
  if (state.status === "rendering") {
    if (state.renderedDocumentCount < state.requiredDocumentCount) return "render-required";
    if (!state.workRecordExists) return "finalize-required";
    throw new Error("WorkRecord가 있는 run은 finalized 상태여야 합니다");
  }
  if (state.status === "finalized") return state.workCompleted ? "terminal-required" : "completion-required";
  throw new Error(`복구할 수 없는 Records run 상태입니다: ${state.status}`);
}

export function recordsRecoveryCommands(recordsRunId: string): Readonly<Record<string, string>> {
  if (!recordsRunId.trim() || recordsRunId.length > 200) throw new Error("Records recovery run ID가 필요합니다");
  return {
    assess: `${recordsRunId}:assess`,
    render: `${recordsRunId}:render`,
    finalize: `${recordsRunId}:finalize`,
    complete: `${recordsRunId}:complete`,
    terminal: `${recordsRunId}:terminal`,
    recovery: `${recordsRunId}:recovery`,
  };
}

export type RecordsRecoveryResult = "resumed" | "terminal-unchanged";

export interface RecordsRecoveryDependencies {
  readonly gateway: {
    get(context: TenantContext, recordsRunId: string): Promise<RecordsRun>;
  };
  readonly readiness: {
    inspect(context: TenantContext, recordsRunId: string): Promise<RecordsRecoveryState>;
  };
  readonly continuation: {
    resume(
      context: TenantContext,
      run: RecordsRun,
      stage: Exclude<RecordsRecoveryStage, "terminal-unchanged">,
      commands: Readonly<Record<string, string>>,
    ): Promise<void>;
  };
  readonly ledger: {
    replay(
      context: TenantContext,
      input: { readonly commandId: string; readonly recordsRunId: string },
    ): Promise<{ readonly stage: RecordsRecoveryStage; readonly result: RecordsRecoveryResult } | undefined>;
    record(
      context: TenantContext,
      input: {
        readonly commandId: string;
        readonly recordsRunId: string;
        readonly stage: RecordsRecoveryStage;
        readonly result: RecordsRecoveryResult;
      },
    ): Promise<void>;
  };
  readonly metrics: {
    recordOnce(
      context: TenantContext,
      key: string,
      input: {
        readonly name: "records_recovery_total";
        readonly value: number;
        readonly dimensions: { readonly result: RecordsRecoveryResult };
      },
    ): Promise<void>;
  };
}

export class RecordsRecovery {
  public constructor(private readonly dependencies: RecordsRecoveryDependencies) {}

  public async recover(
    context: TenantContext,
    input: { readonly commandId: string; readonly recordsRunId: string },
  ): Promise<{
    readonly run: RecordsRun;
    readonly stage: RecordsRecoveryStage;
    readonly result: RecordsRecoveryResult;
  }> {
    if (!input.commandId.trim() || input.commandId.length > 200)
      throw new Error("Records recovery command ID가 필요합니다");
    if (!input.recordsRunId.trim() || input.recordsRunId.length > 200)
      throw new Error("Records recovery run ID가 필요합니다");
    const replayed = await this.dependencies.ledger.replay(context, input);
    if (replayed) {
      return { run: await this.dependencies.gateway.get(context, input.recordsRunId), ...replayed };
    }
    const run = await this.dependencies.gateway.get(context, input.recordsRunId);
    if (run.organizationId !== context.organizationId || run.recordsRunId !== input.recordsRunId) {
      throw new Error("Records recovery run 계보가 tenant와 일치하지 않습니다");
    }
    const state = await this.dependencies.readiness.inspect(context, input.recordsRunId);
    if (state.status !== run.status) throw new Error("Records recovery readiness status가 run과 다릅니다");
    const stage = classifyRecordsRecovery(state);
    const result: RecordsRecoveryResult = stage === "terminal-unchanged" ? "terminal-unchanged" : "resumed";
    if (stage !== "terminal-unchanged") {
      await this.dependencies.continuation.resume(context, run, stage, recordsRecoveryCommands(run.recordsRunId));
    }
    await this.dependencies.ledger.record(context, {
      commandId: input.commandId,
      recordsRunId: input.recordsRunId,
      stage,
      result,
    });
    await this.dependencies.metrics.recordOnce(context, `${input.recordsRunId}:recovery:${result}`, {
      name: "records_recovery_total",
      value: 1,
      dimensions: { result },
    });
    return { run, stage, result };
  }
}
