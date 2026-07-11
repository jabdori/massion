import type { CollaborationGraphSnapshot } from "@massion/application";

export interface DashboardView {
  readonly runningAgents: number;
  readonly pendingApprovals: number;
  readonly activeWorks: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly costText: string;
}

export function buildDashboard(snapshot: CollaborationGraphSnapshot): DashboardView {
  const totals = snapshot.executions.reduce(
    (result, execution) => ({
      inputTokens: result.inputTokens + execution.inputTokens,
      outputTokens: result.outputTokens + execution.outputTokens,
      costMicros: result.costMicros + execution.costMicros,
    }),
    { inputTokens: 0, outputTokens: 0, costMicros: 0 },
  );
  return {
    runningAgents: snapshot.nodes.filter((node) => node.executionStatus === "running").length,
    pendingApprovals: snapshot.pendingApprovals.length,
    activeWorks: snapshot.works.filter((work) => !["completed", "failed", "cancelled"].includes(work.status)).length,
    ...totals,
    costText: `$${(totals.costMicros / 1_000_000).toFixed(6)}`,
  };
}

export type TuiLayout =
  | { readonly mode: "wide" | "compact"; readonly width: number; readonly height: number }
  | {
      readonly mode: "unsupported";
      readonly width: number;
      readonly height: number;
      readonly requiredWidth: 80;
      readonly requiredHeight: 24;
    };

export function layoutForTerminal(width: number, height: number): TuiLayout {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error("terminal 크기가 유효하지 않습니다");
  if (width < 80 || height < 24) return { mode: "unsupported", width, height, requiredWidth: 80, requiredHeight: 24 };
  return { mode: width >= 120 ? "wide" : "compact", width, height };
}
