import { agentIdentityToken } from "@massion/application/client";

import type {
  ComplianceCode,
  NodeRole,
  OrganizationChangeView,
  RoomMessageType,
  RoomQuote,
  SpeakerView,
} from "@/model";

/**
 * 협업방 문법. 메시지 타입 10종은 색이 아니라 배치와 표기로 구분합니다.
 * 색은 화자 식별에만 쓰고, 노랑은 사람이 필요한 곳에만 씁니다.
 */

/**
 * 도메인 열거값은 화면에 그대로 나오면 안 됩니다. `role operator`는 사람의 말이 아니고,
 * `orphan 없음`은 규칙 코드를 읽으라는 요구입니다. 값은 도메인 것을 그대로 들고 있되
 * 문구는 이 표가 소유합니다. 새 값이 생기면 여기서 타입이 깨져 번역을 강제합니다.
 */
const nodeRoleLabel: Record<NodeRole, string> = {
  orchestrator: "총괄",
  coordinator: "조율",
  operator: "실행",
};

/** ComplianceFinding.code 5종. 화면에 나오는 건 "통과한 검사"이므로 긍정문으로 씁니다. */
const complianceLabel: Record<ComplianceCode, string> = {
  "core-office": "코어 오피스 8팀 보존",
  orphan: "부모 없는 노드 없음",
  cycle: "순환 없음",
  scope: "범위 위반 없음",
  "inactive-parent": "중단된 부모 없음",
};

const scopeLabel: Record<OrganizationChangeView["scope"], string> = {
  work: "이 업무에서만",
  persistent: "조직에 남습니다",
};

/**
 * 승인·거절 한 쌍. 같은 결정을 네 위치(업무 타임라인·수신함·조직 변경 제안·개선)가
 * 각자 다른 버튼으로 그리고 있었습니다. 같은 것은 같게 보여야 하므로 여기서만 만듭니다.
 * 거절은 항상 왼쪽·중성이고, 승인만 gate를 씁니다. 노랑은 "지금 사람이 필요함"이라
 * 결정 버튼 둘 다에 칠하면 어느 쪽이 진행인지 읽히지 않습니다.
 */
export function DecisionActions({
  approveName,
  approveDisabled = false,
  busy = false,
  disabled = false,
  onApprove,
  onReject,
  rejectDisabled = false,
}: {
  approveName: string;
  approveDisabled?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  rejectDisabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        aria-label={`${approveName} 거절`}
        className="rounded-[5px] border border-control px-3 py-1 text-[12px] text-secondary hover:border-fg-3 hover:text-primary disabled:opacity-50"
        disabled={disabled || rejectDisabled}
        onClick={onReject}
        type="button"
      >
        {busy ? "처리 중" : "거절"}
      </button>
      <button
        aria-label={`${approveName} 승인`}
        className="rounded-[5px] bg-gate px-3 py-1 text-[12px] font-medium text-gate-ink hover:brightness-110 disabled:opacity-50"
        disabled={disabled || approveDisabled}
        onClick={onApprove}
        type="button"
      >
        {busy ? "처리 중" : "승인"}
      </button>
    </div>
  );
}

/**
 * 다른 화면·다른 방으로 실제로 이동시키는 버튼. 카드 전체를 버튼으로 두지 않기로 했으므로
 * 이 버튼이 유일한 진입점이고, 그래서 배경을 가진 면으로 서 있어야 눈에 걸립니다.
 * 테두리만 있는 이전 형태는 카드 테두리와 구분되지 않아 있는 줄도 몰랐습니다.
 */
export function OpenButton({ label, onOpen, small = false }: { label: string; onOpen: () => void; small?: boolean }) {
  return (
    <button
      aria-label={label}
      className={`shrink-0 rounded-[5px] border border-control bg-raised font-medium text-primary hover:border-fg-3 hover:bg-surface ${
        small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]"
      }`}
      onClick={onOpen}
      type="button"
    >
      열기 ›
    </button>
  );
}

/**
 * 색 슬롯은 역할이 아니라 handle에서 옵니다. Tailwind가 정적 클래스만 뽑으므로 배열로 둡니다.
 * 배정은 @massion/application의 agentIdentityToken이 소유합니다.
 */
const SLOT_TEXT = [
  "text-agent-0",
  "text-agent-1",
  "text-agent-2",
  "text-agent-3",
  "text-agent-4",
  "text-agent-5",
  "text-agent-6",
  "text-agent-7",
] as const;

const SLOT_FILL = [
  "bg-agent-0 text-bg-0",
  "bg-agent-1 text-bg-0",
  "bg-agent-2 text-bg-0",
  "bg-agent-3 text-bg-0",
  "bg-agent-4 text-bg-0",
  "bg-agent-5 text-bg-0",
  "bg-agent-6 text-bg-0",
  "bg-agent-7 text-bg-0",
] as const;

export function speakerText(speaker: Pick<SpeakerView, "accentSlot" | "human">): string {
  if (speaker.human === true || speaker.accentSlot < 0) return "text-primary";
  return SLOT_TEXT[speaker.accentSlot % SLOT_TEXT.length] ?? "text-primary";
}

export function speakerFill(speaker: Pick<SpeakerView, "accentSlot" | "human" | "provisional">): string {
  // scope:"work"이거나 아직 승인되지 않은 노드는 채우지 않고 점선으로만 표기합니다.
  if (speaker.provisional === true) return "border border-dashed border-agent-provisional text-agent-provisional";
  if (speaker.human === true || speaker.accentSlot < 0) return "bg-user text-primary";
  return SLOT_FILL[speaker.accentSlot % SLOT_FILL.length] ?? "bg-user text-primary";
}

const typeLabel: Record<RoomMessageType, string> = {
  question: "질문",
  answer: "답변",
  proposal: "제안",
  challenge: "반론",
  review_request: "검토 요청",
  change_request: "수정 요구",
  evidence: "근거",
  decision: "결정",
  handoff: "인계",
  status: "상태",
};

export function AgentAvatar({ speaker }: { speaker: SpeakerView }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[8px] font-semibold ${speakerFill(speaker)}`}
    >
      {speaker.initial}
    </span>
  );
}

/**
 * 아바타 줄. 참가자가 늘어나도 폭이 무한히 자라지 않게 상한을 두되,
 * 잘린 사실을 말없이 감추지 않고 `+N`으로 표시합니다.
 */
export function SpeakerRow({ limit = 5, speakers }: { limit?: number; speakers: readonly SpeakerView[] }) {
  const shown = speakers.slice(0, limit);
  const hidden = speakers.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((speaker) => (
        <AgentAvatar key={speaker.handle} speaker={speaker} />
      ))}
      {hidden > 0 ? (
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-control text-[8px] font-semibold text-muted"
          title={speakers
            .slice(limit)
            .map((speaker) => speaker.name)
            .join(" · ")}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** 이름이 정체성이고 역할은 배지입니다. 같은 역할이 병렬로 돌아도 이름으로 구분됩니다. */
export function SpeakerName({ speaker }: { speaker: SpeakerView }) {
  return (
    <>
      <span className={`text-[12px] font-medium ${speakerText(speaker)}`}>{speaker.name}</span>
      <span className="rounded-[3px] border border-control px-1.5 text-[10px] font-medium text-muted">
        {speaker.role}
      </span>
      {/* 조직이 모델을 배치하므로 "누가 말했나"에는 "무엇으로 말했나"가 따라붙습니다. */}
      {speaker.modelId === undefined ? null : (
        <span className="font-mono text-[10px] text-muted" title="이 발화를 만든 모델">
          {speaker.modelId}
        </span>
      )}
    </>
  );
}

function TypeTag({ speaker, type }: { speaker?: SpeakerView; type: RoomMessageType }) {
  // 반론은 화자 색을 띱니다. 무엇에 대한 반론인지가 인용으로 이미 보이므로 색이 화자를 가리킵니다.
  const toned =
    type === "challenge" && speaker ? `${speakerText(speaker)} border-current` : "text-muted border-control";
  return (
    <span className={`rounded-[3px] border px-1.5 text-[10px] font-semibold tracking-[0.06em] ${toned}`}>
      {typeLabel[type]}
    </span>
  );
}

/** 챕터 구분선. 6단계 전환 지점에만 놓고 대화를 담지 않습니다. */
export function RoomChapter({ label, time, until }: { label: string; time: string; until?: string | undefined }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="text-[10px] font-semibold tracking-[0.08em] text-muted">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <time className="font-mono text-[11px] text-muted">{until ? `${time} – ${until}` : `${time} –`}</time>
    </div>
  );
}

/**
 * 발언이 아니므로 아바타를 주지 않습니다.
 * 라이브 리전으로 만들지 않습니다. 화면의 알림 영역이 이미 role="status"이고,
 * 방의 상태 줄까지 읽어주면 스크린리더가 같은 사실을 두 번 말합니다.
 */
export function RoomStatus({ content }: { content: string }) {
  return <p className="py-1 text-center font-mono text-[11px] text-muted">— {content} —</p>;
}

/** 조직이 일을 넘겼다는 사실은 한 줄 텍스트보다 크게 보여야 합니다. */
export function RoomHandoff({ from, time, to }: { from: SpeakerView; time: string; to?: SpeakerView | undefined }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span aria-hidden="true" className={`h-px flex-1 ${speakerFill(from)} opacity-60`} />
      <span className="font-mono text-[11px] text-muted">
        인계 · <span className={speakerText(from)}>{from.name}</span>
        {/* 받는 쪽은 도메인이 구조화하지 않습니다. 모르면 넘긴 쪽만 말하고 지어내지 않습니다. */}
        {to ? (
          <>
            {" → "}
            <span className={speakerText(to)}>{to.name}</span>
          </>
        ) : null}{" "}
        · {time}
      </span>
      <span aria-hidden="true" className={`h-px flex-1 ${to ? speakerFill(to) : "bg-border"} opacity-60`} />
    </div>
  );
}

export interface RoomMessageProps {
  speaker: SpeakerView;
  content: string;
  evidence?: { label: string; checksum: string } | undefined;
  indented?: boolean | undefined;
  quoted?: RoomQuote | undefined;
  recipient?: string | undefined;
  signature?: { by: string; revision: number } | undefined;
  target?: string | undefined;
  time: string;
  type: Exclude<RoomMessageType, "handoff" | "status" | "proposal">;
}

export function RoomMessage({
  speaker,
  content,
  evidence,
  indented,
  quoted,
  recipient,
  signature,
  target,
  time,
  type,
}: RoomMessageProps) {
  return (
    <article className={`grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 ${indented ? "pl-[27px]" : ""}`}>
      <AgentAvatar speaker={speaker} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SpeakerName speaker={speaker} />
          <TypeTag speaker={speaker} type={type} />
          <time className="font-mono text-[11px] text-muted">
            {recipient ? `→ ${recipient} · ` : ""}
            {target ? `${target} · ` : ""}
            {time}
          </time>
        </div>
        {quoted ? (
          <blockquote className="my-1.5 border-l-2 border-control pl-2.5 text-[12px] text-muted">
            {quoted.author} · {quoted.time} — {quoted.content}
          </blockquote>
        ) : null}
        <p className="text-[13px] leading-5 text-primary">{content}</p>
        {evidence ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-[3px] border border-current px-1.5 text-[10px] font-semibold tracking-[0.06em] ${speakerText(speaker)}`}
            >
              근거
            </span>
            <span className="text-[12px] text-secondary">{evidence.label}</span>
            <span className="font-mono text-[11px] text-muted">checksum {evidence.checksum}</span>
          </p>
        ) : null}
        {signature ? (
          <p className="mt-1.5 font-mono text-[11px] text-muted">
            서명 {signature.by} · 개정 {signature.revision}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export interface ProposalActivityProps {
  speaker: SpeakerView;
  change: OrganizationChangeView;
  content: string;
  decided: boolean;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  time: string;
}

/**
 * 조직 변경 제안. 추가되는 역량·수명·영향·되돌리기를 버튼보다 먼저 보입니다.
 * 사람이 결정해야 하므로 gate 색을 쓰는 자리입니다.
 */
export function ProposalActivity({
  speaker,
  change,
  content,
  decided,
  disabled,
  onApprove,
  onReject,
  time,
}: ProposalActivityProps) {
  return (
    <article className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5">
      <AgentAvatar speaker={speaker} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SpeakerName speaker={speaker} />
          <span className="rounded-[3px] border border-gate px-1.5 text-[10px] font-semibold tracking-[0.06em] text-gate">
            제안
          </span>
          <time className="font-mono text-[11px] text-muted">{time}</time>
        </div>
        <p className="text-[13px] leading-5 text-primary">{content}</p>

        <section
          aria-label={`조직 변경 제안 ${change.name}`}
          className={`mt-2 rounded-[7px] border ${decided ? "border-border bg-surface-1" : "border-gate-border bg-gate-wash"}`}
        >
          <header className="flex items-center gap-2.5 border-b border-gate-border px-3.5 py-2.5">
            <AgentAvatar
              speaker={{
                handle: change.handle,
                name: change.name,
                initial: change.name.slice(0, 1),
                accentSlot: -1,
                role: change.role,
                provisional: true,
              }}
            />
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-medium">{change.name} 신설</h4>
              {/*
               * handle은 h4의 이름과 같은 것을 두 번 말하는 자리였습니다. 감사에 필요하므로
               * 지우지 않고 title로 내립니다. 부모는 handle이 아니라 이름으로 말합니다.
               */}
              <p className="text-[11px] text-muted" title={change.handle}>
                {agentIdentityToken(change.parentHandle).name} 아래 · {nodeRoleLabel[change.role]} 역할 ·{" "}
                {scopeLabel[change.scope]}
              </p>
            </div>
            <span className="text-[11px] font-medium text-gate">{decided ? "처리됨" : "승인 필요"}</span>
          </header>

          <div className="grid gap-x-6 gap-y-3 px-3.5 py-3 min-[900px]:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">추가되는 역량</p>
              <p className="mt-1 text-[12px] text-secondary">{change.capabilities.join(" · ")}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">영향</p>
              <p className="mt-1 text-[12px] text-secondary">
                노드 {change.impactNodes}개 · 참조 {change.impactReferences}건
              </p>
              <p className="text-[11px] text-muted" title={change.impactHandles.join(" · ")}>
                {change.impactHandles.map((handle) => agentIdentityToken(handle).name).join(" · ")}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">이 업무가 끝나면</p>
              <p className="mt-1 text-[12px] text-secondary">{change.lifetime}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">되돌리기</p>
              <p className="mt-1 font-mono text-[11px] text-muted">
                조직 버전 {change.fromVersion} → {change.toVersion}
                {change.revertable ? " · Revert 가능" : " · Revert 불가"}
              </p>
            </div>
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-gate-border px-3.5 py-2.5">
            <p className="flex-1 text-[11px] text-muted">
              조직 검사 통과 · {change.compliance.map((code) => complianceLabel[code]).join(" · ")}
            </p>
            {decided ? null : (
              <DecisionActions
                approveName={`${change.name} 신설`}
                disabled={disabled}
                onApprove={onApprove}
                onReject={onReject}
              />
            )}
          </footer>
        </section>
      </div>
    </article>
  );
}

/**
 * 하위 협업방 참조. 대표 방 안에서 갈라진 지점에 인라인으로 나타납니다.
 * 모든 방을 탭으로 자동 추가하면 탭 바가 감당하지 못하므로, 누를 때만 엽니다.
 */
export function RoomReference({
  lastLine,
  messageCount,
  name,
  onOpen,
  participants,
  time,
  waiting,
}: {
  lastLine: string;
  messageCount: number;
  name: string;
  onOpen: () => void;
  participants: SpeakerView[];
  time: string;
  waiting: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-[7px] border px-3.5 py-2.5 ${
        waiting ? "border-gate-border bg-gate-wash" : "border-border bg-surface-1"
      }`}
    >
      <SpeakerRow limit={3} speakers={participants} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{name}</span>
          <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
            갈라진 방 · {messageCount}
          </span>
          {waiting ? <span className="text-[11px] text-gate">◇ 확인 필요</span> : null}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-muted">{lastLine}</p>
      </div>
      <time className="shrink-0 font-mono text-[11px] text-muted">{time}</time>
      {/*
       * 카드 전체를 버튼으로 두지 않습니다. 오클릭 한 번에 읽던 대화의 맥락을 잃습니다.
       * 진입은 명시적 버튼으로만 합니다.
       */}
      <OpenButton label={`협업방 ${name} 열기`} onOpen={onOpen} />
    </div>
  );
}
