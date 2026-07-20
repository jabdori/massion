/**
 * Massion 공통 디자인 토큰 — Web과 TUI가 공유하는 의미 체계
 *
 * Guided Workspace 방향: 복잡한 AgentOS를 보여주는 것이 아니라,
 * AgentOS가 사용자를 대신해 일을 정리해주는 제품으로 보이게 합니다.
 * 내부 기술 용어를 사용자 언어로 번역하는 UX Projection을 제공합니다.
 */

// ── Work / Run 상태 사전 ──────────────────────────────────────────

export interface WorkStatusToken {
  readonly id: string;
  readonly symbol: string;
  readonly label: string; // 기술 상세용
  readonly friendlyLabel: string; // 일반 사용자용
  readonly semantic: "ready" | "running" | "approval" | "blocked" | "failed" | "completed" | "cancelled";
}

export const WORK_STATUS_TOKENS: Readonly<Record<string, WorkStatusToken>> = {
  ready: { id: "ready", symbol: "○", label: "준비됨", friendlyLabel: "시작할 수 있어요", semantic: "ready" },
  running: { id: "running", symbol: "▶", label: "실행 중", friendlyLabel: "진행 중이에요", semantic: "running" },
  "awaiting-approval": { id: "awaiting-approval", symbol: "?", label: "승인 대기", friendlyLabel: "확인이 필요해요", semantic: "approval" },
  blocked: { id: "blocked", symbol: "!", label: "차단됨", friendlyLabel: "잠시 멈췄어요", semantic: "blocked" },
  failed: { id: "failed", symbol: "×", label: "실패", friendlyLabel: "문제가 생겼어요", semantic: "failed" },
  completed: { id: "completed", symbol: "✓", label: "완료", friendlyLabel: "완료됐어요", semantic: "completed" },
  cancelled: { id: "cancelled", symbol: "–", label: "취소됨", friendlyLabel: "취소됐어요", semantic: "cancelled" },
} as const;

export function workStatusToken(status: string): WorkStatusToken {
  return WORK_STATUS_TOKENS[status] ?? { id: status, symbol: "?", label: status, friendlyLabel: status, semantic: "ready" };
}

// ── 사용자용 4단계 진행 (UX Projection) ───────────────────────────
// 내부 6단계(intake→context→evidence→delivery→assurance→records)를
// 사용자가 이해하기 쉬운 4단계로 번역합니다.

export interface UserStageToken {
  readonly id: string;
  readonly friendlyLabel: string;
  readonly technicalLabel: string;
  readonly internalStages: readonly string[];
}

export const USER_STAGES: readonly UserStageToken[] = [
  { id: "understand", friendlyLabel: "요청 이해", technicalLabel: "Intake · Context", internalStages: ["intake", "context-strategy"] },
  { id: "prepare", friendlyLabel: "자료와 계획 준비", technicalLabel: "Strategy · Evidence", internalStages: ["evidence"] },
  { id: "work", friendlyLabel: "작업 진행", technicalLabel: "Delivery · Runtime", internalStages: ["delivery"] },
  { id: "verify", friendlyLabel: "결과 확인", technicalLabel: "Assurance · Records", internalStages: ["assurance", "records"] },
] as const;

export function userStageForInternal(internalStage: string): UserStageToken {
  const found = USER_STAGES.find((stage) => stage.internalStages.includes(internalStage));
  return found ?? USER_STAGES.find((s) => s.id === "understand") ?? { id: "understand", friendlyLabel: "요청 이해", technicalLabel: "Intake · Context", internalStages: ["intake", "context-strategy"] };
}

export function userStageIndex(internalStage: string): number {
  return USER_STAGES.indexOf(userStageForInternal(internalStage));
}

export type StageProgress = "completed" | "current" | "pending";

export function userStageProgress(currentInternalStage: string, targetUserStageId: string): StageProgress {
  const currentIndex = userStageIndex(currentInternalStage);
  const targetIndex = USER_STAGES.findIndex((s) => s.id === targetUserStageId);
  if (targetIndex < currentIndex) return "completed";
  if (targetIndex === currentIndex) return "current";
  return "pending";
}

// ── Agent 역할 (사용자 친화적 번역) ──────────────────────────────

export interface AgentRoleToken {
  readonly handle: string;
  readonly abbreviation: string;
  readonly label: string;
  readonly friendlyLabel: string;
}

export const AGENT_ROLES: readonly AgentRoleToken[] = [
  { handle: "representative", abbreviation: "REP", label: "Representative", friendlyLabel: "요청 정리 담당" },
  { handle: "context-strategy", abbreviation: "CTX", label: "Context & Strategy", friendlyLabel: "계획 담당" },
  { handle: "evidence", abbreviation: "EVD", label: "Evidence & Research", friendlyLabel: "자료 확인 담당" },
  { handle: "delivery", abbreviation: "DLV", label: "Delivery", friendlyLabel: "작성 담당" },
  { handle: "assurance", abbreviation: "ASR", label: "Assurance", friendlyLabel: "결과 검토 담당" },
] as const;

// ── 승인 위험도 (사용자 친화적 영향 표현) ────────────────────────

export interface ApprovalRiskToken {
  readonly id: string;
  readonly friendlyLabel: string;
  readonly description: string;
  readonly semantic: "low" | "medium" | "high";
}

export const APPROVAL_RISK_TOKENS: Readonly<Record<string, ApprovalRiskToken>> = {
  low: {
    id: "low",
    friendlyLabel: "영향이 작습니다",
    description: "문서나 설정 내용만 변경됩니다.",
    semantic: "low",
  },
  medium: {
    id: "medium",
    friendlyLabel: "주의가 필요합니다",
    description: "실행 중인 작업이나 서비스에 영향을 줄 수 있습니다. 문제가 생기면 되돌릴 수 있습니다.",
    semantic: "medium",
  },
  high: {
    id: "high",
    friendlyLabel: "되돌리기 어렵습니다",
    description: "데이터가 변경되거나 삭제될 수 있습니다. 실행 전에 상태를 확인해주세요.",
    semantic: "high",
  },
} as const;

export function approvalRiskToken(risk: string): ApprovalRiskToken {
  return APPROVAL_RISK_TOKENS[risk] ?? APPROVAL_RISK_TOKENS["medium"] ?? {
    id: "medium", friendlyLabel: "주의가 필요합니다", description: "실행 중인 작업에 영향을 줄 수 있습니다.", semantic: "medium",
  };
}

export function approvalRiskFromPreview(preview: { kind?: string }): ApprovalRiskToken {
  const medium: ApprovalRiskToken = APPROVAL_RISK_TOKENS["medium"] ?? {
    id: "medium", friendlyLabel: "주의가 필요합니다", description: "실행 중인 작업에 영향을 줄 수 있습니다.", semantic: "medium",
  };
  if (preview.kind === "command") return medium;
  if (preview.kind === "file-change") return APPROVAL_RISK_TOKENS["low"] ?? {
    id: "low", friendlyLabel: "영향이 작습니다", description: "문서나 설정 내용만 변경됩니다.", semantic: "low",
  };
  return medium;
}

export function agentRoleToken(handle: string): AgentRoleToken {
  return AGENT_ROLES.find((role) => role.handle === handle) ?? {
    handle, abbreviation: handle.slice(0, 3).toUpperCase(), label: handle, friendlyLabel: handle,
  };
}

// ── 의미 색상 토큰 ─────────────────────────────────────────────────

export interface SemanticColorToken {
  readonly id: string;
  readonly dark: { readonly canvas: string; readonly surface: string; readonly accent: string };
  readonly light: { readonly canvas: string; readonly surface: string; readonly accent: string };
  readonly status: {
    readonly ready: string;
    readonly running: string;
    readonly approval: string;
    readonly blocked: string;
    readonly failed: string;
    readonly completed: string;
    readonly cancelled: string;
  };
}

// Guided Workspace: Light theme 기본, 따뜻한 회색 배경
export const DESIGN_TOKENS: SemanticColorToken = {
  id: "massion-guided-workspace",
  light: {
    canvas: "#F8F9FB",
    surface: "#FFFFFF",
    accent: "#5B5FEF",
  },
  dark: {
    canvas: "#14161B",
    surface: "#1C1F26",
    accent: "#7C8AFF",
  },
  status: {
    ready: "#9CA3AF",
    running: "#4F8AF7",
    approval: "#F5A623",
    blocked: "#F97316",
    failed: "#EF4444",
    completed: "#22C55E",
    cancelled: "#9CA3AF",
  },
} as const;
