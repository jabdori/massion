import { agentIdentityToken } from "@massion/application/client";

export type WorkStatus = "active" | "complete" | "failed" | "cancelled";
export type StepState = "done" | "active" | "pending" | "failed";

export interface AgentView {
  id: string;
  role: string;
  name: string;
  initials: string;
  state: "active" | "waiting";
}

export interface TaskView {
  id: string;
  title: string;
  state: StepState;
  time?: string;
}

export interface ArtifactView {
  id: string;
  name: string;
  format: string;
  size: string;
  createdAt: string;
  artifactId?: string;
  artifactVersionId?: string;
  kind?: string;
  mediaType?: string;
  checksum?: string;
  version?: number;
  createdBy?: string;
}

/** `CollaborationMessageType`(packages/work)을 그대로 옮깁니다. 화면 문법이 이 타입에서 갈라집니다. */
export type RoomMessageType =
  | "question"
  | "answer"
  | "proposal"
  | "challenge"
  | "review_request"
  | "change_request"
  | "evidence"
  | "decision"
  | "handoff"
  | "status";

/**
 * 화자 정체성. 역할이 아니라 handle에서 파생하므로 같은 역할이 병렬로 돌아도 갈립니다.
 * name·initial·accentSlot은 @massion/application의 agentIdentityToken이 소유합니다.
 */
export interface SpeakerView {
  /** 도메인 정체성. Assignment의 agent_handle입니다. */
  handle: string;
  /** 표시 이름. 고유명사이므로 번역하지 않습니다. */
  name: string;
  /** 아바타 한 글자. */
  initial: string;
  /** 0–7 색 슬롯. 사람은 -1을 씁니다. */
  accentSlot: number;
  /** 역할 배지 문구. */
  role: string;
  /** 사람 참가자. */
  human?: boolean;
  /** scope:"work"이거나 아직 승인되지 않은 노드. 점선으로 표기합니다. */
  provisional?: boolean;
}

export interface RoomQuote {
  author: string;
  time: string;
  content: string;
}

/** `proposal` 메시지에 붙는 조직 변경. ImpactReport·ComplianceFinding·Revert 가능 여부를 싣습니다. */
/** @massion/organization의 NodeRole. 문구는 room.tsx가 소유합니다. */
export type NodeRole = "orchestrator" | "coordinator" | "operator";

/** @massion/organization의 ComplianceFinding.code. 화면에는 통과한 검사로 나옵니다. */
export type ComplianceCode = "core-office" | "orphan" | "cycle" | "scope" | "inactive-parent";

export interface OrganizationChangeView {
  handle: string;
  name: string;
  scope: "work" | "persistent";
  parentHandle: string;
  // 도메인 값을 그대로 들고 있습니다. 여기서 한글 문구로 굳히면 정렬·필터가 문구에 묶입니다.
  role: NodeRole;
  capabilities: string[];
  impactNodes: number;
  impactReferences: number;
  impactHandles: string[];
  fromVersion: number;
  toVersion: number;
  revertable: boolean;
  compliance: ComplianceCode[];
  lifetime: string;
}

export type ActivityView =
  | { id: string; kind: "message"; time: string; author: string; initials: string; content: string }
  | { id: string; kind: "plan"; time: string; title: string; steps: TaskView[] }
  | { id: string; kind: "agents"; time: string; title: string; agents: AgentView[] }
  | { id: string; kind: "approval"; time: string; approvalId: string; title: string; description: string }
  | { id: string; kind: "artifacts"; time: string; title: string; artifacts: ArtifactView[] }
  | { id: string; kind: "event"; time: string; title: string; detail: string; status: string }
  // 6단계 전환 지점에만 놓는 챕터 구분선. 대화를 접거나 담지 않습니다.
  | { id: string; kind: "chapter"; time: string; stage: string; label: string; until?: string }
  // 발언이 아니므로 아바타를 주지 않고 가운데 한 줄로 둡니다.
  | { id: string; kind: "roomStatus"; time: string; content: string }
  // 다른 방으로 갈라진 지점. 대표 방 안에 인라인으로 나타나고 누를 때만 탭이 열립니다.
  // 방이 늘어나도 탭 바가 감당해야 할 개수는 사용자가 연 것뿐입니다.
  | {
      id: string;
      kind: "roomRef";
      time: string;
      roomId: string;
      name: string;
      participants: SpeakerView[];
      messageCount: number;
      lastLine: string;
      waiting: boolean;
    }
  // 조직이 일을 넘겼다는 사실은 한 줄 텍스트보다 크게 보여야 합니다.
  // 도메인의 handoff 메시지는 넘긴 쪽만 저자로 남기고 받는 쪽을 구조화하지 않습니다.
  // 받는 쪽을 모르면 한쪽만 그립니다. 지어내지 않습니다.
  | { id: string; kind: "handoff"; time: string; from: SpeakerView; to?: SpeakerView }
  | {
      id: string;
      kind: "room";
      time: string;
      messageType: Exclude<RoomMessageType, "handoff" | "status" | "proposal">;
      speaker: SpeakerView;
      content: string;
      /** `question`·`review_request`의 수신자 */
      recipient?: string;
      /** `answer`는 질문 아래 들여써서 짝을 눈에 보이게 합니다. */
      indented?: boolean;
      /** `challenge`는 원본 인용 없이 존재할 수 없습니다. */
      quoted?: RoomQuote;
      /** `evidence`의 첨부와 checksum */
      evidence?: { label: string; checksum: string };
      /** `change_request`의 대상 */
      target?: string;
      /** `decision`의 서명자와 개정 */
      signature?: { by: string; revision: number };
    }
  | {
      id: string;
      kind: "proposal";
      time: string;
      speaker: SpeakerView;
      content: string;
      change: OrganizationChangeView;
      approvalId?: string;
    };

export interface RunView {
  runId: string;
  status: string;
  stage: string;
  leaseGeneration: number;
  approvalId?: string;
  blockedReason?: string;
}

export interface ApprovalView {
  id: string;
  action?: string;
  title: string;
  description: string;
  workId?: string;
  revision: number | undefined;
  status: string;
}

/**
 * 수신함 항목. "사람이 필요한 것"을 한 덩어리로 뭉치지 않고, 해결 방식이 다른 것을 타입으로 가릅니다.
 *  - approval: 실행이 승인을 기다리며 멈춤. gate(노랑). 소유 화면으로 이동해 승인·거절.
 *  - blocked:  실행이 막힘(모델 부재·폴더 신뢰 등). halt(빨강). 원인을 풀러 업무로 이동.
 *  - growth:   개선 제안이 검토를 기다림. 근거를 읽을 수 있는 개선 상세로 이동.
 * 배지·수신함·홈이 모두 이 한 타입의 목록을 봅니다. 숫자가 갈리지 않게.
 */
export type InboxItem =
  | { readonly kind: "approval"; readonly id: string; readonly approval: ApprovalView }
  | {
      readonly kind: "blocked";
      readonly id: string;
      readonly workId: string;
      readonly title: string;
      readonly reason: string;
    }
  | {
      readonly kind: "growth";
      readonly id: string;
      readonly suggestionId: string;
      readonly workId: string;
      readonly title: string;
      readonly reason: string;
    };

export type VerificationCriterionStatus = "passed" | "failed" | "blocked" | "excluded";

export interface VerificationCriterionView {
  key: string;
  status: VerificationCriterionStatus;
}

export interface VerificationView {
  id: string;
  /** 판정한 조직 노드입니다. 실행자와 분리된 주체이므로 제목에 뭉개지 않습니다. */
  verifier: string;
  state: StepState;
  /** 무엇을 기준으로 판정했는지입니다. Assurance 판정 투영이 1개 이상 100개 이하로 보증합니다. */
  criteria: VerificationCriterionView[];
  evidence?: string;
}

export interface WorkView {
  id: string;
  title: string;
  status: WorkStatus;
  revision: number;
  sourceStatus: string;
  team: string;
  updatedAt: string;
  summary: string;
  progress: number;
  run?: RunView;
  activeExecutionId?: string;
  approvals: ApprovalView[];
  tasks: TaskView[];
  agents: AgentView[];
  artifacts: ArtifactView[];
  verifications: VerificationView[];
  activities: ActivityView[];
}

/** 협업방 한 개. work.rooms + work.messages를 화면 문법으로 투영한 결과입니다. */
export interface RoomBudgetView {
  label: string;
  used: number;
  limit: number;
  display: string;
}

export interface SharedContextView {
  id: string;
  label: string;
  checksum: string;
}

export interface RoomView {
  roomId: string;
  name: string;
  status: string;
  participants: SpeakerView[];
  lastMessageSequence: number;
  /** 라운드·토큰·비용. 한도가 없는 항목은 목록에 넣지 않습니다. */
  budgets: RoomBudgetView[];
  sharedContexts: SharedContextView[];
  activities: ActivityView[];
}

export interface DesktopSnapshot {
  works: WorkView[];
}

export type DesktopDataAdapter = () => DesktopSnapshot;

/** 이름·이니셜·색 슬롯은 공유 계층이 정합니다. 표면마다 다르게 부르면 같은 에이전트를 알아볼 수 없습니다. */
function speaker(handle: string, role: string, options?: { provisional?: boolean }): SpeakerView {
  const identity = agentIdentityToken(handle, role);
  return {
    handle: identity.handle,
    name: identity.name,
    initial: identity.initial,
    accentSlot: identity.accentSlot,
    role,
    ...(options?.provisional === true ? { provisional: true } : {}),
  };
}

const me: SpeakerView = { handle: "user", name: "나", initial: "나", accentSlot: -1, role: "사람", human: true };
const atlas = speaker("representative", "조정");
const quill = speaker("evidence-research", "조사");
const vega = speaker("delivery-coordination", "실행");
const iris = speaker("assurance", "검증");

const churnAgents: AgentView[] = [
  { id: atlas.handle, role: atlas.role, name: atlas.name, initials: atlas.initial, state: "active" },
  { id: quill.handle, role: quill.role, name: quill.name, initials: quill.initial, state: "active" },
  { id: vega.handle, role: vega.role, name: vega.name, initials: vega.initial, state: "active" },
  { id: iris.handle, role: iris.role, name: iris.name, initials: iris.initial, state: "waiting" },
];

const churnTasks: TaskView[] = [
  { id: "scope", title: "데이터 범위 확인", state: "done", time: "10:22" },
  { id: "drivers", title: "이탈 요인 분석", state: "active", time: "10:24" },
  { id: "draft", title: "개선안 초안 작성", state: "pending" },
  { id: "validate", title: "개선안 검증", state: "pending" },
  { id: "report", title: "최종 정리 및 보고", state: "pending" },
];

const churnArtifacts: ArtifactView[] = [
  { id: "report", name: "이탈 분석 보고서.pdf", format: "PDF", size: "2.4 MB", createdAt: "10:24" },
  { id: "cohort", name: "코호트 데이터.csv", format: "CSV", size: "1.1 MB", createdAt: "10:24" },
];

const works: WorkView[] = [
  {
    id: "churn-q3",
    title: "3분기 고객 이탈 원인 분석",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    team: "고객 운영팀",
    updatedAt: "10:24",
    summary: "최근 90일의 이탈 신호를 분석하고 실행 가능한 개선안을 정리합니다.",
    progress: 36,
    approvals: [
      {
        id: "approval-crm-access",
        title: "CRM 고객 데이터 읽기",
        description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
        workId: "churn-q3",
        revision: 1,
        status: "pending",
      },
    ],
    tasks: churnTasks,
    agents: churnAgents,
    artifacts: churnArtifacts,
    verifications: [
      {
        id: "verification-churn",
        verifier: "iris",
        state: "done",
        criteria: [
          { key: "data-accuracy", status: "passed" },
          { key: "statistical-significance", status: "passed" },
          { key: "improvement-feasibility", status: "blocked" },
          { key: "expected-impact", status: "excluded" },
        ],
        evidence: "CRM 표본 2,418건 일치",
      },
    ],
    activities: [
      {
        id: "request",
        kind: "room",
        messageType: "question",
        time: "10:21",
        speaker: me,
        content: "최근 90일 이탈 원인을 분석하고 개선안을 정리해줘.",
      },
      {
        id: "accepted",
        kind: "room",
        messageType: "answer",
        time: "10:21",
        speaker: atlas,
        content: "전략·조사·분석을 병렬로 붙이고 검증은 결과가 나온 뒤 독립으로 돌리겠습니다.",
      },
      { id: "chapter-evidence", kind: "chapter", time: "10:22", stage: "evidence", label: "근거", until: "10:24" },
      { id: "plan", kind: "plan", time: "10:22", title: "실행 계획", steps: churnTasks },
      {
        id: "labeling-question",
        kind: "room",
        messageType: "question",
        time: "10:23",
        speaker: vega,
        recipient: quill.name,
        content: "해지 사유 라벨링 기준이 뭔가요? 자유 텍스트를 어떤 축으로 나눴는지 알아야 회귀에 넣습니다.",
      },
      {
        id: "labeling-answer",
        kind: "room",
        messageType: "answer",
        time: "10:23",
        speaker: quill,
        indented: true,
        content: "가격 · 기능 부족 · 지원 불만 · 경쟁사 이동 · 기타 5축입니다.",
        evidence: { label: "라벨링 기준 브리프", checksum: "a3f1c8" },
      },
      {
        id: "cohort-challenge",
        kind: "room",
        messageType: "challenge",
        time: "10:24",
        speaker: iris,
        quoted: { author: quill.name, time: "10:23", content: "가격 · 기능 부족 · 지원 불만 · 경쟁사 이동 · 기타 5축" },
        content:
          "2분기와 3분기의 코호트 정의가 달라서 이 5축으로는 분기 간 비교가 성립하지 않습니다. 정의를 맞추거나 비교 주장을 빼야 합니다.",
      },
      {
        id: "handoff-research-delivery",
        kind: "handoff",
        time: "10:24",
        from: quill,
        to: vega,
      },
      { id: "chapter-delivery", kind: "chapter", time: "10:24", stage: "delivery", label: "실행" },
      {
        id: "quant-proposal",
        kind: "proposal",
        time: "10:25",
        speaker: atlas,
        content:
          "검증의 반론을 받으려면 코호트 정규화와 유의성 검정이 필요한데, 현재 조직에 통계 역량이 없습니다. 이 업무에만 존재하는 임시 팀을 제안합니다.",
        change: {
          handle: "quant-analysis",
          name: "계량분석 팀",
          scope: "work",
          parentHandle: "delivery-coordination",
          role: "operator",
          capabilities: ["코호트 정규화", "유의성 검정", "시계열 분해"],
          impactNodes: 2,
          impactReferences: 3,
          impactHandles: ["delivery-coordination", "assurance"],
          fromVersion: 12,
          toVersion: 13,
          revertable: true,
          compliance: ["orphan", "cycle", "core-office"],
          lifetime: "이 업무가 끝나면 자동으로 사라집니다. 영속 조직은 바뀌지 않습니다.",
        },
      },
      {
        id: "crm-access",
        kind: "approval",
        time: "10:25",
        approvalId: "approval-crm-access",
        title: "CRM 고객 데이터 읽기",
        description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
      },
      {
        id: "cohort-evidence",
        kind: "room",
        messageType: "evidence",
        time: "10:25",
        speaker: quill,
        content: "공개 텍스트 2,116 / 3,412건 분류를 마쳤습니다. 나머지는 CRM 승인 후 진행합니다.",
        evidence: { label: "코호트 데이터.csv", checksum: "7c02b1" },
      },
      { id: "artifacts", kind: "artifacts", time: "10:25", title: "중간 산출물", artifacts: churnArtifacts },
      {
        id: "review-req",
        kind: "room",
        messageType: "review_request",
        time: "10:26",
        speaker: vega,
        recipient: iris.name,
        content: "코호트 재계산 전에 통계 가정이 성립하는지 먼저 봐 주세요.",
      },
      {
        id: "change-req",
        kind: "room",
        messageType: "change_request",
        time: "10:27",
        speaker: iris,
        target: "이탈 분석 보고서.pdf",
        content: "분기 간 비교 문단을 빼거나 코호트 정의를 맞춘 뒤 다시 쓰십시오. 현재 문장은 근거가 없습니다.",
      },
      {
        id: "decision-cohort",
        kind: "room",
        messageType: "decision",
        time: "10:28",
        speaker: atlas,
        content: "코호트 정의를 3분기 기준으로 통일하고 분기 간 비교는 개선안에서 제외합니다.",
        signature: { by: "나", revision: 8 },
      },
      { id: "waiting", kind: "roomStatus", time: "10:29", content: "계량분석 팀 승인을 기다리는 중 · 라운드 6 / 100" },
    ],
  },
  {
    id: "partner-contract",
    title: "파트너 계약서 검토",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    team: "사업 운영팀",
    updatedAt: "어제",
    summary: "갱신 계약의 책임 범위와 해지 조건을 기존 정책에 대조합니다.",
    progress: 22,
    // 차단된 업무. 승인 대기와 달리 사람이 원인을 풀어야 진행됩니다(수신함 halt 항목).
    run: {
      runId: "run-partner",
      status: "blocked",
      stage: "evidence",
      leaseGeneration: 1,
      blockedReason: "신뢰하지 않은 폴더 접근이 필요합니다",
    },
    approvals: [],
    tasks: [
      { id: "terms", title: "계약 조항 검증", state: "active", time: "어제" },
      { id: "risk", title: "위험 조항 정리", state: "pending" },
      { id: "memo", title: "검토 의견 작성", state: "pending" },
    ],
    agents: [
      { id: "legal", role: "정책", name: "차유나", initials: "차", state: "active" },
      { id: "verify", role: "검증", name: "강이든", initials: "강", state: "waiting" },
    ],
    artifacts: [],
    verifications: [
      {
        id: "verification-contract",
        verifier: "onyx",
        state: "failed",
        criteria: [
          { key: "standard-policy-match", status: "failed" },
          { key: "liability-scope", status: "blocked" },
        ],
      },
    ],
    activities: [
      {
        id: "request",
        kind: "message",
        time: "어제",
        author: "배정우",
        initials: "배",
        content: "파트너 갱신 계약에서 불리한 조항이 있는지 확인해줘.",
      },
      {
        id: "accepted",
        kind: "message",
        time: "어제",
        author: "대표 에이전트",
        initials: "M",
        content: "계약 원문과 내부 표준 정책을 대조하고 있습니다.",
      },
    ],
  },
  {
    id: "weekly-ops",
    title: "주간 운영 보고서",
    status: "active",
    revision: 1,
    sourceStatus: "running",
    team: "운영 기획팀",
    updatedAt: "09.02",
    summary: "운영 지표 변화와 이번 주 대응 항목을 한 문서로 정리합니다.",
    progress: 64,
    approvals: [],
    tasks: [
      { id: "collect", title: "지표 수집", state: "done" },
      { id: "write", title: "변동 사유 작성", state: "active" },
      { id: "review", title: "리더 검토", state: "pending" },
    ],
    agents: [{ id: "ops", role: "분석", name: "오재희", initials: "오", state: "active" }],
    artifacts: [],
    verifications: [
      {
        id: "verification-metrics",
        verifier: "vega",
        state: "done",
        criteria: [{ key: "source-metric-match", status: "passed" }],
      },
    ],
    activities: [
      {
        id: "accepted",
        kind: "message",
        time: "09.02",
        author: "대표 에이전트",
        initials: "M",
        content: "지난주 대비 변동 폭이 큰 운영 지표부터 확인하고 있습니다.",
      },
    ],
  },
];

export const fixtureDataAdapter: DesktopDataAdapter = () => ({ works });
