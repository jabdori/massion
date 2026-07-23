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

/**
 * Core Office 8팀 전부. `CORE_OFFICE_HANDLES`와 같은 집합이어야 합니다.
 *
 * 이전에는 다섯 개뿐이었고 그중 `evidence`·`delivery`는 실제로 존재하지 않는 handle이라,
 * `evidence-research`·`records-documentation`·`governance`·`growth`가 전부 fallback으로
 * 떨어져 화면에 handle이 그대로 나왔습니다("Quill · evidence-research").
 * fallback은 조용해서 타입도 테스트도 잡지 못합니다 — 여기 8개가 다 있어야 합니다.
 */
export const AGENT_ROLES: readonly AgentRoleToken[] = [
  { handle: "representative", abbreviation: "REP", label: "Representative", friendlyLabel: "사용자 요청 접수" },
  { handle: "context-strategy", abbreviation: "CTX", label: "Context & Strategy", friendlyLabel: "맥락 구성" },
  { handle: "evidence-research", abbreviation: "EVD", label: "Evidence & Research", friendlyLabel: "근거 조사" },
  { handle: "governance", abbreviation: "GOV", label: "Governance", friendlyLabel: "정책 승인" },
  { handle: "delivery-coordination", abbreviation: "DLV", label: "Delivery Coordination", friendlyLabel: "실행 조정" },
  { handle: "assurance", abbreviation: "ASR", label: "Assurance", friendlyLabel: "독립 검증" },
  { handle: "records-documentation", abbreviation: "REC", label: "Records & Documentation", friendlyLabel: "기록 정리" },
  { handle: "growth", abbreviation: "GRW", label: "Growth", friendlyLabel: "개선 제안" },
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

// ── 개선 제안의 대상 ───────────────────────────────────────────────
//
// 도메인 `growth_suggestion.target_kind` enum을 사람의 말로 옮깁니다.
// 무엇을 바꾸는지는 위험도와 직결되므로 화면에 반드시 보여야 하지만,
// 원시 enum 값(`prompt`)을 그대로 노출하지 않습니다.

export interface GrowthTargetToken {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
}

const GROWTH_TARGETS: Readonly<Record<string, GrowthTargetToken>> = {
  prompt: { kind: "prompt", label: "지시문", description: "에이전트가 받는 지시가 바뀝니다." },
  memory: { kind: "memory", label: "기억", description: "조직이 기억하는 내용이 바뀝니다." },
  policy: { kind: "policy", label: "정책", description: "실행과 승인 규칙이 바뀝니다." },
  organization: { kind: "organization", label: "조직", description: "부서·팀·역할 구성이 바뀝니다." },
};

export function growthTargetToken(kind: string): GrowthTargetToken {
  return GROWTH_TARGETS[kind] ?? { kind, label: kind, description: "" };
}

// ── 에이전트 정체성 ────────────────────────────────────────────────
//
// 역할은 배지이고 이름은 정체성입니다. 같은 역할이 병렬로 돌 때
// 화면이 역할만 보여주면 어떤 에이전트가 말하는지 구분할 수 없습니다.
// 정체성 정본은 도메인의 agent_handle이며, 이름과 색은 거기서 파생합니다.
//
// 이름은 고유명사이므로 번역하지 않습니다. 어떤 로케일에서도 같은 이름으로 부릅니다.

export interface AgentIdentityToken {
  /** 도메인 정체성. OrganizationNode.handle이자 Assignment의 agent_handle입니다. */
  readonly handle: string;
  /** 표시 이름. 로케일과 무관하게 고정입니다. */
  readonly name: string;
  /** 아바타 한 글자. 이름 첫 글자이며 풀 안에서 고유합니다. */
  readonly initial: string;
  /** 색 팔레트 인덱스. 역할이 아니라 정체성에 붙으므로 병렬 동일 역할도 색이 갈립니다. */
  readonly accentSlot: number;
  /** 역할 배지 문구. */
  readonly roleLabel: string;
  /** Core Office 내장 노드인지. 아니면 설치되거나 동적으로 만들어진 노드입니다. */
  readonly builtin: boolean;
}

/**
 * 첫 글자가 서로 겹치지 않는 24개 호출부호.
 * 아바타가 한 글자만 보여주므로 동시 표시 24개까지 이니셜이 유일합니다.
 */
export const AGENT_CALL_SIGNS: readonly string[] = [
  "Atlas", "Lyra", "Quill", "Onyx", "Vega", "Iris", "Cedar", "Sage",
  "Brook", "Dune", "Ember", "Flint", "Grove", "Haven", "Juno", "Kite",
  "Mira", "Nova", "Prism", "Reef", "Terra", "Umbra", "Wren", "Zephyr",
] as const;

/** Core Office 8개는 이름과 색 슬롯을 고정합니다. 재시작해도 같은 이름과 같은 색입니다. */
const CORE_OFFICE_IDENTITY: Readonly<Record<string, { readonly name: string; readonly accentSlot: number }>> = {
  "representative": { name: "Atlas", accentSlot: 0 },
  "context-strategy": { name: "Lyra", accentSlot: 1 },
  "evidence-research": { name: "Quill", accentSlot: 2 },
  "evidence": { name: "Quill", accentSlot: 2 },
  "governance": { name: "Onyx", accentSlot: 3 },
  "delivery-coordination": { name: "Vega", accentSlot: 4 },
  "delivery": { name: "Vega", accentSlot: 4 },
  "assurance": { name: "Iris", accentSlot: 5 },
  "records-documentation": { name: "Cedar", accentSlot: 6 },
  "growth": { name: "Sage", accentSlot: 7 },
};

/** Core Office가 선점하지 않은 나머지 호출부호. 동적·설치 노드가 여기서 이름을 받습니다. */
const ASSIGNABLE_CALL_SIGNS = AGENT_CALL_SIGNS.slice(8);

const AGENT_ACCENT_SLOT_COUNT = 8;

/** FNV-1a. 같은 handle이면 어느 표면에서든 같은 이름과 색이 나와야 하므로 결정론적이어야 합니다. */
function handleHash(handle: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < handle.length; index += 1) {
    hash ^= handle.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function agentIdentityToken(handle: string, roleLabel?: string): AgentIdentityToken {
  const label = roleLabel ?? agentRoleToken(handle).friendlyLabel;
  const builtinIdentity = CORE_OFFICE_IDENTITY[handle];
  if (builtinIdentity) {
    return {
      handle,
      name: builtinIdentity.name,
      initial: builtinIdentity.name.slice(0, 1),
      accentSlot: builtinIdentity.accentSlot,
      roleLabel: label,
      builtin: true,
    };
  }

  const hash = handleHash(handle);
  const name = ASSIGNABLE_CALL_SIGNS[hash % ASSIGNABLE_CALL_SIGNS.length] ?? handle;
  return {
    handle,
    name,
    initial: name.slice(0, 1),
    // Core Office 슬롯과 겹쳐도 이름이 다르므로 구분됩니다. 색은 보조 신호입니다.
    accentSlot: hash % AGENT_ACCENT_SLOT_COUNT,
    roleLabel: label,
    builtin: false,
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
