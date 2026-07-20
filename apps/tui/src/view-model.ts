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

// Guided Workspace: 현재 작업이 어느 내부 단계(intake·delivery …)에 있는지 유도합니다.
// snapshot에는 명시적인 stage 필드가 없으므로, 현재 실행 중인 에이전트의 역할(role)에서 유도합니다.
const AGENT_HANDLE_TO_INTERNAL_STAGE: Readonly<Record<string, string>> = {
  representative: "intake",
  "context-strategy": "context-strategy",
  evidence: "evidence",
  delivery: "delivery",
  assurance: "assurance",
};

const TERMINAL_WORK_STATUSES = new Set(["completed", "cancelled", "failed"]);
const ACTIVE_EXECUTION_STATUSES = new Set(["running", "queued", "suspended"]);

export function currentInternalStage(
  snapshot: CollaborationGraphSnapshot,
  workId: string | undefined,
): string {
  if (!workId) return "intake";
  const work = snapshot.works.find((item) => item.workId === workId);
  if (work && TERMINAL_WORK_STATUSES.has(work.status)) return "records";
  const execution = snapshot.executions.find(
    (item) => item.workId === workId && ACTIVE_EXECUTION_STATUSES.has(item.status),
  );
  if (execution) {
    const node = snapshot.nodes.find((item) => item.handle === execution.agentHandle);
    const stage = node ? AGENT_HANDLE_TO_INTERNAL_STAGE[node.role] : undefined;
    if (stage) return stage;
  }
  if (work?.status === "draft") return "intake";
  return "delivery";
}
