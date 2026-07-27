import {
  ArrowRight,
  At,
  Briefcase,
  CaretDown,
  CaretRight,
  Database,
  FileCsv,
  FilePdf,
  Lightning,
  MagnifyingGlass,
  Paperclip,
  Plus,
  X,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { DesktopFilter, DesktopService } from "@/desktop-service";
import type {
  ActivityView,
  AgentView,
  ApprovalView,
  RoomView,
  SpeakerView,
  TaskView,
  WorkStatus,
  WorkView,
} from "@/model";
import type { WorkKnowledgeViewV1 } from "@massion/application/client";
import type { NativeContextPicker } from "@/native-context-picker";

import { speakerText } from "@/room";
import { criterionStatusClass, criterionStatusLabel, stateClass, stateLabel } from "@/ui/state";
import { surfaceErrorMessage } from "@/ui/surface";

const workStatusLabel: Record<WorkStatus, string> = {
  active: "진행 중",
  complete: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

type GlyphKind = "idle" | "running" | "done" | "verified" | "gate" | "halt";

/** 상태는 색이 아니라 모양이 말합니다(LEDGER-SPEC §3). */
function Glyph({ kind, label, progress }: { kind: GlyphKind; label?: string | undefined; progress?: number | undefined }) {
  const aria = label === undefined ? { "aria-hidden": true } : { "aria-label": label };
  if (kind === "gate" || kind === "halt") {
    return (
      <span
        {...aria}
        className={`grid size-[14px] shrink-0 place-items-center text-[13px] leading-[14px] ${
          kind === "gate" ? "text-gate" : "text-halt"
        }`}
      >
        {kind === "gate" ? "◇" : "⊘"}
      </span>
    );
  }
  if (kind === "verified") {
    return (
      <span {...aria} className="grid size-[14px] shrink-0 place-items-center rounded-full text-fg-2">
        <span className="grid size-[14px] place-items-center rounded-full border-[0.5px] border-current">
          <span className="size-2 rounded-full bg-current" />
        </span>
      </span>
    );
  }
  if (kind === "done") {
    return <span {...aria} className="size-[10px] shrink-0 rounded-full bg-fg-3" />;
  }
  const pct = progress === undefined ? undefined : Math.max(0, Math.min(100, progress));
  return (
    <span
      {...aria}
      className={`grid size-[10px] shrink-0 place-items-center rounded-full border-[0.5px] ${
        kind === "idle" ? "border-fg-4" : pct === undefined ? "border-fg-2 text-fg-2" : "border-fg-4 text-fg-3"
      }`}
      style={
        kind === "running" && pct !== undefined
          ? { background: `conic-gradient(currentColor ${String(pct)}%, transparent 0)` }
          : undefined
      }
    >
      {kind === "running" && pct === undefined ? null : null}
    </span>
  );
}

const SLOT_RAIL = [
  "bg-agent-0",
  "bg-agent-1",
  "bg-agent-2",
  "bg-agent-3",
  "bg-agent-4",
  "bg-agent-5",
  "bg-agent-6",
  "bg-agent-7",
] as const;

function railClass(accentSlot: number, human?: boolean): string {
  if (human === true || accentSlot < 0) return "bg-user";
  return SLOT_RAIL[accentSlot % SLOT_RAIL.length] ?? "bg-user";
}

function LedgerRow({
  time,
  speaker,
  label,
  meta,
  glyph,
  indent = false,
  onClick,
  expanded = false,
  mono = false,
}: {
  time?: string | undefined;
  speaker?: SpeakerView | undefined;
  label: ReactNode;
  meta?: ReactNode | undefined;
  glyph?: ReactNode | undefined;
  indent?: boolean | undefined;
  onClick?: (() => void) | undefined;
  expanded?: boolean | undefined;
  mono?: boolean | undefined;
}) {
  const content = (
    <>
      {time ? (
        <time className="w-[38px] shrink-0 text-right font-mono text-[11px] leading-4 text-fg-4 tabular-nums">{time}</time>
      ) : (
        <span aria-hidden="true" className="w-[38px] shrink-0" />
      )}
      {speaker ? (
        <span aria-hidden="true" className={`h-[16px] w-[2px] shrink-0 ${railClass(speaker.accentSlot, speaker.human)}`} />
      ) : (
        <span aria-hidden="true" className="h-[16px] w-[2px] shrink-0 bg-transparent" />
      )}
      {speaker ? <span className={`shrink-0 text-[13px] leading-5 ${speakerText(speaker)}`}>{speaker.name}</span> : null}
      {indent ? <span aria-hidden="true" className="w-8 shrink-0" /> : null}
      <span
        className={`min-w-0 flex-1 truncate leading-5 tracking-[-0.005em] ${
          mono ? "font-mono text-[11px] text-fg-3" : "text-[13px] text-fg-2"
        }`}
      >
        {label}
      </span>
      {meta ? <span className="shrink-0 text-[12px] leading-[18px] text-fg-4">{meta}</span> : null}
      {onClick ? (
        <CaretRight
          aria-hidden="true"
          className={`shrink-0 text-fg-4 transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
          size={12}
        />
      ) : (
        <span aria-hidden="true" className="w-3 shrink-0" />
      )}
      {glyph}
    </>
  );
  const className = `flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left ${
    onClick ? `hover:bg-[rgb(255_255_255/0.027)] ${expanded ? "bg-[rgb(255_255_255/0.047)]" : ""}` : ""
  }`;
  return onClick ? (
    <button className={className} onClick={onClick} type="button">
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function LedgerStage({ index, name, count, summary, dim = false }: { index: number; name: string; count?: number | undefined; summary?: ReactNode | undefined; dim?: boolean | undefined }) {
  return (
    <div className="flex h-[30px] items-center gap-2 px-2">
      <span className="w-[38px] shrink-0 text-right font-mono text-[11px] leading-4 text-fg-4 tabular-nums">{index}</span>
      <span aria-hidden="true" className="w-[2px] shrink-0" />
      <span className={`text-[13px] font-medium leading-5 ${dim ? "text-fg-4" : "text-fg-2"}`}>{name}</span>
      {count ? <span className="text-[12px] leading-[18px] text-fg-4">{count}</span> : null}
      <span className="min-w-0 flex-1" />
      {summary ? <span className="truncate text-[12px] leading-[18px] text-fg-4">{summary}</span> : null}
    </div>
  );
}

export function WorkEmptySurface({ onCreate }: { onCreate: () => void }) {
  return (
    <main aria-label="업무" className="col-span-2 flex min-h-0 items-center justify-center bg-canvas text-primary">
      <div className="text-center">
        <Briefcase aria-hidden="true" className="mx-auto mb-4 text-muted" size={32} />
        <h1 className="text-[17px] font-semibold tracking-[-0.012em] text-fg-2">선택한 상태에 Work가 없습니다.</h1>
        <p className="mt-2 text-[13px] text-fg-4">왼쪽에서 상태를 바꾸거나 첫 Work를 만들어주세요.</p>
        <Button className="mt-5 rounded-[4px]" onClick={onCreate} variant="primary">
          <Plus aria-hidden="true" size={16} />첫 Work 만들기
        </Button>
      </div>
    </main>
  );
}

interface WorkListProps {
  works: WorkView[];
  selectedId: string;
  filter: DesktopFilter;
  query: string;
  pendingRunId: string | undefined;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onFilterChange: (filter: DesktopFilter) => void;
  onQueryChange: (query: string) => void;
}

export function WorkList({
  filter,
  onCreate,
  onFilterChange,
  onQueryChange,
  onSelect,
  pendingRunId,
  query,
  selectedId,
  works,
}: WorkListProps) {
  return (
    <section
      aria-label="Work 목록"
      className="grid h-full min-h-0 min-w-0 grid-rows-[48px_auto_minmax(0,1fr)] border-r border-line-strong bg-bg-1"
    >
      <header className="flex items-center justify-between border-b border-line px-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.008em] text-fg-2">업무</h2>
        <button
          aria-label="새 Work 만들기"
          className="flex size-7 items-center justify-center rounded-[4px] text-fg-4 hover:text-fg-2"
          onClick={onCreate}
          type="button"
        >
          <Plus aria-hidden="true" size={17} />
        </button>
      </header>
      <div className="space-y-1.5 border-b border-line px-2 py-2">
        <label className="relative block">
          <span className="sr-only">Work 검색</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4"
            size={14}
          />
          <input
            className="h-[30px] w-full rounded-[4px] border border-line bg-bg-2 pl-8 pr-2 text-[13px] text-fg-2 placeholder:text-fg-4 outline-none focus:border-line-strong"
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            placeholder="Work 검색"
            type="search"
            value={query}
          />
        </label>
        <Tabs
          onValueChange={(value) => {
            onFilterChange(value as DesktopFilter);
          }}
          value={filter}
        >
          <TabsList aria-label="Work 상태" className="gap-1">
            <TabsTrigger
              className="h-[30px] rounded-[4px] px-2.5 text-[12px] text-fg-4 data-[active]:bg-[rgb(255_255_255/0.047)] data-[active]:text-fg-2"
              value="active"
            >
              진행 중
            </TabsTrigger>
            <TabsTrigger
              className="h-[30px] rounded-[4px] px-2.5 text-[12px] text-fg-4 data-[active]:bg-[rgb(255_255_255/0.047)] data-[active]:text-fg-2"
              value="complete"
            >
              완료
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 py-2">
        {works.length || (pendingRunId && filter === "active") ? (
          <div className="flex flex-col gap-[2px]">
            {pendingRunId && filter === "active" ? (
              <div
                aria-label={`Work 생성 중 ${pendingRunId}`}
                className="flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2"
                role="status"
              >
                <Glyph kind="idle" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">Work 생성 중</span>
                <span className="max-w-[90px] truncate font-mono text-[11px] text-fg-4">{pendingRunId}</span>
              </div>
            ) : null}
            {works.map((work) => {
              const selected = work.id === selectedId;
              const glyph: GlyphKind =
                work.run?.status === "blocked"
                  ? "halt"
                  : work.approvals.some((approval) => approval.status === "pending")
                    ? "gate"
                    : work.status === "complete" && work.verifications.some((verification) => verification.state === "done")
                      ? "verified"
                      : work.status === "complete"
                        ? "done"
                        : work.status === "failed"
                          ? "halt"
                          : "running";
              return (
                <button
                  aria-label={`${work.title} ${workStatusLabel[work.status]} ${work.updatedAt}`}
                  aria-pressed={selected}
                  className={`flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left ${
                    selected ? "bg-[rgb(255_255_255/0.047)]" : "hover:bg-[rgb(255_255_255/0.027)]"
                  }`}
                  key={work.id}
                  onClick={() => {
                    onSelect(work.id);
                  }}
                  type="button"
                >
                  <Glyph kind={glyph} progress={glyph === "running" ? work.progress : undefined} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{work.title}</span>
                  <time className="shrink-0 font-mono text-[11px] text-fg-4">{work.updatedAt}</time>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-2 py-8 text-center">
            <p className="text-[13px] text-fg-3">{query ? "검색 결과가 없습니다." : "완료된 Work가 없습니다."}</p>
            <p className="mt-1 text-[12px] text-fg-4">
              {query ? "검색어를 바꿔보세요." : "완료된 업무가 여기에 표시됩니다."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkActivityProps {
  onCloseRoom: (roomId: string) => void;
  onSelectRoom: (roomId: string) => void;
  room?: RoomView | undefined;
  rooms: RoomView[];
  work: WorkView;
  composer: string;
  announcement: string;
  detailLoading: boolean;
  executionNotice: string | undefined;
  approvalDecisions: Record<string, "approved" | "rejected">;
  pendingApprovals: ReadonlySet<string>;
  pendingDirective: boolean;
  pendingRunAction: "cancel" | "resume" | undefined;
  onComposerChange: (value: string) => void;
  onAnnouncement: (message: string) => void;
  onControlRun: (action: "cancel" | "resume") => void;
  onDecideApproval: (approval: ApprovalView, decision: "approved" | "rejected") => void;
  onSubmitDirective: (mode: "now" | "next-stage") => void;
}

export function WorkActivity({
  announcement,
  approvalDecisions,
  composer,
  detailLoading,
  executionNotice,
  onAnnouncement,
  onComposerChange,
  onControlRun,
  onDecideApproval,
  onSubmitDirective,
  pendingApprovals,
  pendingDirective,
  pendingRunAction,
  onCloseRoom,
  onSelectRoom,
  room,
  rooms,
  work,
}: WorkActivityProps) {
  const canCancel = work.run && ["ready", "running", "awaiting-approval", "blocked"].includes(work.run.status);
  const canResume = work.run?.status === "blocked";
  const activities = room ? room.activities : work.activities;
  const [expandedId, setExpandedId] = useState<string>();

  // 메시지 타입으로만 원장 마디를 배정합니다. 문자열이나 화면 추측으로 분류하지 않습니다.
  const requestActivities = activities.filter(
    (activity) =>
      (activity.kind === "room" && activity.speaker.human === true) ||
      activity.kind === "message" ||
      (activity.kind === "room" && activity.messageType === "decision"),
  );
  const batchActivities = activities.filter((activity) => ["agents", "proposal", "approval"].includes(activity.kind));
  const executionActivities = activities.filter((activity) => {
    if (activity.kind === "room") return ["question", "answer", "evidence"].includes(activity.messageType);
    return ["plan", "handoff", "artifacts", "roomStatus", "roomRef", "event"].includes(activity.kind);
  });
  const judgmentActivities = activities.filter(
    (activity) => activity.kind === "room" && ["challenge", "change_request", "review_request"].includes(activity.messageType),
  );
  const verification = work.verifications[0];
  const verifierSpeaker = verification ? room?.participants.find((participant) => participant.handle === verification.verifier) : undefined;
  const verifierAgent = verification ? work.agents.find((agent) => agent.id === verification.verifier) : undefined;
  const verifierName = verifierSpeaker?.name ?? verifierAgent?.name ?? verification?.verifier;
  const contributors = new Set(
    executionActivities.flatMap((activity) => ("speaker" in activity && !activity.speaker.human ? [activity.speaker.handle] : [])),
  );
  const contributorNames = [...contributors].map(
    (handle) => room?.participants.find((participant) => participant.handle === handle)?.name ?? work.agents.find((agent) => agent.id === handle)?.name ?? handle,
  );
  const independent = verification ? !contributors.has(verification.verifier) : true;
  const workGlyph: GlyphKind =
    work.run?.status === "blocked"
      ? "halt"
      : work.approvals.some((approval) => approval.status === "pending")
        ? "gate"
        : work.status === "complete" && work.verifications.some((item) => item.state === "done")
          ? "verified"
          : work.status === "complete"
            ? "done"
            : work.status === "failed"
              ? "halt"
              : "running";
  const participants = room?.participants ?? [];
  const participantCount = room?.participants.length ?? work.agents.length;

  const renderMessage = (activity: Extract<ActivityView, { kind: "message" | "room" | "proposal" }>, time: string | undefined, meta: ReactNode, speaker?: SpeakerView) => {
    const expanded = expandedId === activity.id;
    const content = activity.content;
    const quoted = activity.kind === "room" ? activity.quoted : undefined;
    return (
      <div key={activity.id}>
        <LedgerRow
          expanded={expanded}
          label={activity.kind === "proposal" ? `조직 제안 ${activity.change.name}` : content}
          meta={meta}
          onClick={() => {
            setExpandedId((current) => (current === activity.id ? undefined : activity.id));
          }}
          speaker={speaker}
          time={time}
        />
        {expanded ? (
          <div className="pl-[80px] pr-2 py-1.5">
            {quoted ? <p className="border-l border-line pl-2 text-[12px] leading-[18px] text-fg-4">{quoted.author} · {quoted.time} · {quoted.content}</p> : null}
            <p className="text-[14px] leading-[21px] tracking-[-0.006em] text-fg-2">{content}</p>
          </div>
        ) : null}
      </div>
    );
  };

  const renderActivity = (activity: ActivityView, time: string | undefined): ReactNode => {
    if (activity.kind === "message") return renderMessage(activity, time, "요청");
    if (activity.kind === "room") {
      if (activity.speaker.human === true && activity.messageType !== "decision") {
        return renderMessage(activity, time, "요청", activity.speaker);
      }
      if (activity.messageType === "question") {
        return renderMessage(activity, time, <>질문{activity.recipient ? ` → ${activity.recipient}` : ""}</>, activity.speaker);
      }
      if (activity.messageType === "answer") {
        return renderMessage(
          activity,
          time,
          <>답변{activity.evidence ? <> · <span className="font-mono">{activity.evidence.checksum}</span></> : null}</>,
          activity.speaker,
        );
      }
      if (activity.messageType === "evidence") {
        return renderMessage(
          activity,
          time,
          activity.evidence ? <>근거 {activity.evidence.label} <span className="font-mono">{activity.evidence.checksum}</span></> : "근거",
          activity.speaker,
        );
      }
      if (activity.messageType === "decision") {
        return renderMessage(
          activity,
          time,
          activity.signature ? `서명 ${activity.signature.by} · rev ${activity.signature.revision}` : undefined,
          activity.speaker,
        );
      }
      if (activity.messageType === "challenge") {
        return renderMessage(
          activity,
          time,
          <>반론{activity.quoted ? <> · {activity.quoted.author} {activity.quoted.time}</> : null}</>,
          activity.speaker,
        );
      }
      if (activity.messageType === "change_request") {
        return renderMessage(activity, time, activity.target ? `수정 요구 · ${activity.target}` : "수정 요구", activity.speaker);
      }
      if (activity.messageType === "review_request") {
        return renderMessage(activity, time, activity.recipient ? `검토 요청 → ${activity.recipient}` : "검토 요청", activity.speaker);
      }
    }
    if (activity.kind === "agents") {
      return (
        <div key={activity.id}>
          <LedgerRow label="편성" meta={undefined} time={time} />
          {work.agents.map((agent) => {
            const speaker = room?.participants.find((participant) => participant.handle === agent.id);
            return <LedgerRow indent key={agent.id} label={speaker ? agent.role : `${agent.name} · ${agent.role}`} speaker={speaker} />;
          })}
        </div>
      );
    }
    if (activity.kind === "proposal") {
      return renderMessage(
        activity,
        time,
        `v${activity.change.fromVersion} → v${activity.change.toVersion} · 영향 노드 ${activity.change.impactNodes}`,
        activity.speaker,
      );
    }
    if (activity.kind === "approval") {
      const approval = work.approvals.find((item) => item.id === activity.approvalId);
      const decision = approvalDecisions[activity.approvalId];
      return (
        <LedgerRow
          key={activity.id}
          glyph={<Glyph kind="gate" label="승인 필요" />}
          label={activity.title}
          meta={
            decision ? (
              <span className="text-fg-4">{decision === "approved" ? "승인됨" : "거절됨"}</span>
            ) : (
              <span className="flex items-center gap-1">
                <button
                  aria-label={`${activity.title} 승인`}
                  className="h-[22px] rounded-[4px] bg-[rgb(255_255_255/0.09)] px-2 text-[12px] text-fg-2 disabled:opacity-40"
                  disabled={!approval || pendingApprovals.has(activity.approvalId)}
                  onClick={() => {
                    if (approval) onDecideApproval(approval, "approved");
                  }}
                  type="button"
                >
                  승인
                </button>
                <button
                  aria-label={`${activity.title} 거절`}
                  className="h-[22px] rounded-[4px] px-2 text-[12px] text-fg-4 hover:text-fg-2 disabled:opacity-40"
                  disabled={!approval || pendingApprovals.has(activity.approvalId)}
                  onClick={() => {
                    if (approval) onDecideApproval(approval, "rejected");
                  }}
                  type="button"
                >
                  거절
                </button>
              </span>
            )
          }
          time={time}
        />
      );
    }
    if (activity.kind === "plan") {
      const done = activity.steps.filter((step) => step.state === "done").length;
      return <LedgerRow key={activity.id} label={`${activity.title} ${done} / ${activity.steps.length}`} time={time} />;
    }
    if (activity.kind === "handoff") {
      return <LedgerRow key={activity.id} label={activity.to ? `인계 ${activity.from.name} → ${activity.to.name}` : `인계 ${activity.from.name}`} speaker={activity.from} time={time} />;
    }
    if (activity.kind === "artifacts") {
      return (
        <div key={activity.id}>
          <LedgerRow label={`${activity.title} ${activity.artifacts.length}`} time={time} />
          {activity.artifacts.map((artifact) => (
            <LedgerRow indent key={artifact.id} label={artifact.name} meta={<span className="font-mono text-[11px]">{artifact.format} · {artifact.size}</span>} />
          ))}
        </div>
      );
    }
    if (activity.kind === "roomStatus") return <LedgerRow key={activity.id} label={activity.content} time={time} />;
    if (activity.kind === "roomRef") {
      return <LedgerRow key={activity.id} label={activity.name} meta={`발언 ${activity.messageCount}`} onClick={() => onSelectRoom(activity.roomId)} time={time} />;
    }
    if (activity.kind === "event") return <LedgerRow key={activity.id} label={activity.title} meta={activity.detail} time={time} />;
    return null;
  };

  const renderActivities = (items: ActivityView[]) => {
    let previousTime: string | undefined;
    return items
      .slice()
      .reverse()
      .map((activity) => {
        const time = "time" in activity && activity.time !== previousTime ? activity.time : undefined;
        previousTime = "time" in activity ? activity.time : previousTime;
        return renderActivity(activity, time);
      });
  };

  const verifierSummary = verification ? (
    <span className={independent ? "" : "text-halt"}>
      {verifierName} · {independent ? "실행 기여자 아님" : "실행에도 참여함"}
    </span>
  ) : undefined;
  return (
    <main
      aria-busy={detailLoading || undefined}
      aria-label={work.title}
      className="grid h-full min-h-0 min-w-0 grid-rows-[48px_auto_minmax(0,1fr)_auto] bg-bg-0"
    >
      <header className="flex min-w-0 items-center gap-3 border-b border-line px-4">
        <Glyph kind={workGlyph} progress={workGlyph === "running" ? work.progress : undefined} />
        <h1 className="truncate text-[17px] font-semibold leading-[26px] tracking-[-0.012em] text-fg">{work.title}</h1>
        <span className="shrink-0 text-[13px] leading-5 text-fg-3">{work.team}{room ? ` · ${room.name}` : ""}</span>
        <span className="flex shrink-0 items-center gap-1" title={`참가 ${String(participantCount)}`}>
          {participants.length ? participants.slice(0, 5).map((participant) => <span aria-hidden="true" className={`size-2 rounded-full ${railClass(participant.accentSlot, participant.human)}`} key={participant.handle} />) : work.agents.slice(0, 5).map((agent) => <span aria-hidden="true" className="size-2 rounded-full bg-user" key={agent.id} />)}
          <span className="text-[12px] text-fg-4">참가 {participantCount}</span>
        </span>
        {room?.budgets.length ? (
          <span className="hidden shrink-0 font-mono text-[11px] text-fg-4 min-[1360px]:inline">
            {room.budgets.map((budget) => `${budget.label} ${budget.display}`).join(" · ")}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {executionNotice ? (
            <span aria-live="polite" className="mr-2 max-w-48 truncate text-[12px] text-fg-4" role="status">
              {executionNotice}
            </span>
          ) : null}
          {work.run?.status === "awaiting-approval" ? (
            <span className="mr-2 text-[12px] text-gate">승인 결정 대기 중</span>
          ) : null}
          {canResume ? (
            <button
              aria-label="실행 재개"
              className="h-[26px] shrink-0 rounded-[4px] px-2 text-[12px] text-fg-3 hover:bg-[rgb(255_255_255/0.047)] hover:text-fg-2 disabled:opacity-40"
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("resume");
              }}
              type="button"
            >
              실행 재개
            </button>
          ) : null}
          {canCancel ? (
            <button
              aria-label="실행 취소"
              className="h-[26px] shrink-0 rounded-[4px] px-2 text-[12px] text-fg-3 hover:bg-[rgb(255_255_255/0.047)] hover:text-fg-2 disabled:opacity-40"
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("cancel");
              }}
              type="button"
            >
              실행 취소
            </button>
          ) : null}
        </div>
      </header>
      <div>
        {work.run && ["blocked", "awaiting-approval", "running"].includes(work.run.status) ? <RunStatusCard run={work.run} /> : null}
        {rooms.length > 1 ? (
          <nav aria-label="협업방" className="flex h-[30px] items-center gap-1 px-4">
            {rooms.map((candidate, index) => {
              const current = candidate.roomId === room?.roomId;
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={`flex h-[30px] items-center gap-2 rounded-[4px] px-2.5 text-[13px] ${
                    current ? "bg-[rgb(255_255_255/0.047)] text-fg-2" : "text-fg-4 hover:bg-[rgb(255_255_255/0.027)]"
                  }`}
                  key={candidate.roomId}
                  onClick={() => {
                    onSelectRoom(candidate.roomId);
                  }}
                  type="button"
                >
                  {candidate.participants.slice(0, 2).map((participant) => <span aria-hidden="true" className={`size-2 rounded-full ${railClass(participant.accentSlot, participant.human)}`} key={participant.handle} />)}
                  <span>{candidate.name}</span>
                  {index === 0 ? null : (
                    <span
                      aria-label={`${candidate.name} 닫기`}
                      className="ml-0.5 px-1 text-[11px] text-fg-4 hover:text-fg-2"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseRoom(candidate.roomId);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      ✕
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        ) : null}
      </div>
      <section aria-label="Work 활동" className="min-h-0 overflow-y-auto px-3 py-2">
        <div className="flex flex-col">
          {[
            {
              index: 6,
              name: "효과",
              count: 0,
              rows: null,
            },
            {
              index: 5,
              name: "개선",
              count: 0,
              rows: null,
            },
            {
              index: 4,
              name: "판정",
              count: judgmentActivities.length + work.verifications.length,
              summary: verifierSummary,
              rows: (
                <>
                  {verification ? (
                    <>
                      <LedgerRow label="판정자" meta={<span className={independent ? "" : "text-halt"}>{independent ? "실행 기여자 아님" : "실행에도 참여함"}</span>} mono={!verifierSpeaker} speaker={verifierSpeaker} />
                      <LedgerRow label="실행 기여자" meta={contributorNames.length ? contributorNames.join(" · ") : undefined} />
                      {work.verifications.map((item) => {
                        const itemSpeaker = room?.participants.find((participant) => participant.handle === item.verifier);
                        return (
                          <div key={item.id}>
                            <LedgerRow
                              glyph={<Glyph kind={item.state === "done" ? "verified" : item.state === "failed" ? "halt" : "running"} />}
                              label={`판정 ${stateLabel[item.state]}`}
                              meta={`기준 ${item.criteria.length}`}
                              speaker={itemSpeaker}
                            />
                            {item.criteria.map((criterion) => (
                              <LedgerRow
                                indent
                                key={criterion.key}
                                label={criterion.key}
                                meta={<span className={criterionStatusClass[criterion.status]}>{criterionStatusLabel[criterion.status]}</span>}
                                mono
                              />
                            ))}
                            {item.evidence ? <LedgerRow indent label="근거" meta={item.evidence} mono /> : null}
                          </div>
                        );
                      })}
                    </>
                  ) : null}
                  {renderActivities(judgmentActivities)}
                </>
              ),
            },
            {
              index: 3,
              name: "실행",
              count: executionActivities.length,
              rows: renderActivities(executionActivities),
            },
            {
              index: 2,
              name: "배치",
              count: batchActivities.length,
              rows: renderActivities(batchActivities),
            },
            {
              index: 1,
              name: "요청",
              count: requestActivities.length + (work.summary ? 1 : 0),
              rows: (
                <>
                  {renderActivities(requestActivities)}
                  {work.summary ? <LedgerRow label={work.summary} meta="개요" /> : null}
                </>
              ),
            },
          ].map((stage, stageIndex) => (
            <div className={stageIndex === 0 ? "" : "mt-4"} key={stage.index}>
              <LedgerStage count={stage.count} dim={stage.count === 0} index={stage.index} name={stage.name} summary={stage.summary} />
              {stage.rows ? <div className="flex flex-col gap-[2px]">{stage.rows}</div> : null}
            </div>
          ))}
        </div>
      </section>
      <Composer
        announcement={announcement}
        onAnnouncement={onAnnouncement}
        onChange={onComposerChange}
        onSubmit={onSubmitDirective}
        pending={pendingDirective}
        value={composer}
      />
    </main>
  );
}

const runStageLabel: Record<string, string> = {
  intake: "요청 접수",
  "context-strategy": "맥락·전략 구성",
  evidence: "근거 확인",
  delivery: "실행",
  assurance: "검증",
  records: "결과 기록",
  terminal: "완료 정리",
};

function runStageText(stage: string): string {
  return runStageLabel[stage] ?? stage;
}

function blockedReasonText(reason: string | undefined): string {
  switch (reason) {
    case "context-strategy-stage-failed":
    case "strategy-failed":
      return "Provider가 전략 계획의 구조화 응답을 완성하지 못했습니다.";
    case "model-unavailable":
      return "사용 가능한 Provider 모델을 찾지 못했습니다.";
    case "evidence-invalid":
      return "업무에 연결된 근거를 검증하지 못했습니다.";
    case "workspace-untrusted":
      return "워크스페이스 신뢰 확인이 필요합니다.";
    default:
      return "실행 단계에서 오류가 발생했습니다.";
  }
}

function RunStatusCard({ run }: { run: NonNullable<WorkView["run"]> }) {
  const blocked = run.status === "blocked";
  const awaitingApproval = run.status === "awaiting-approval";
  const active = run.status === "running";
  if (!blocked && !awaitingApproval && !active) return null;

  if (blocked) {
    return (
      <section aria-label="실행 상태" className="border-b border-line px-4 py-2" role="status">
        <div className="flex items-start gap-2">
          <Glyph kind="halt" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-fg-2">실행이 멈췄습니다</p>
            <p className="mt-1 text-[12px] leading-[18px] text-halt">{blockedReasonText(run.blockedReason)}</p>
            <p className="mt-1 text-[11px] text-fg-4">
              현재 단계: {runStageText(run.stage)}
              {run.blockedReason ? (
                <code className="ml-2 font-mono text-[11px] text-fg-4">{run.blockedReason}</code>
              ) : null}
            </p>
            <p className="mt-1 text-[11px] text-fg-4">상단의 실행 재개를 누르면 이 단계부터 다시 시도합니다.</p>
          </div>
        </div>
      </section>
    );
  }

  if (awaitingApproval) {
    return (
      <section aria-label="실행 상태" className="border-b border-line px-4 py-2" role="status">
        <div className="flex items-start gap-2">
          <Glyph kind="gate" />
          <div>
            <p className="text-[13px] text-fg-2">사람의 결정을 기다리는 중입니다</p>
            <p className="mt-1 text-[12px] leading-[18px] text-gate">
              수신함에서 승인 여부를 결정하면 다음 단계로 진행합니다.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="실행 상태" className="border-b border-line px-4 py-2" role="status">
      <div className="flex items-center gap-2">
        <Glyph kind="running" />
        <p className="text-[13px] text-fg-2">실행 중</p>
        <span className="text-[12px] text-fg-3">{runStageText(run.stage)}</span>
        <span className="ml-auto font-mono text-[11px] text-fg-4">개정 {run.leaseGeneration}</span>
      </div>
    </section>
  );
}

interface ComposerProps {
  value: string;
  announcement: string;
  pending: boolean;
  onChange: (value: string) => void;
  onAnnouncement: (message: string) => void;
  onSubmit: (mode: "now" | "next-stage") => void;
}

function Composer({ announcement, onAnnouncement, onChange, onSubmit, pending, value }: ComposerProps) {
  return (
    <div className="border-t border-line bg-bg-0 px-3 pb-3 pt-2" data-testid="directive-composer">
      <div className="rounded-[4px] border border-line bg-bg-1 p-2 focus-within:border-line-strong">
        <label className="sr-only" htmlFor="directive">
          추가 지시
        </label>
        <Textarea
          aria-label="추가 지시"
          id="directive"
          onChange={(event) => {
            onChange(event.target.value);
          }}
          placeholder="대표에게 추가 지시..."
          value={value}
        />
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-1">
            <Button
              aria-label="파일 첨부"
              className="rounded-[4px]"
              onClick={() => {
                onAnnouncement("파일 첨부 준비가 되었습니다.");
              }}
              size="icon"
              variant="ghost"
            >
              <Paperclip aria-hidden="true" size={18} />
            </Button>
            <Button
              aria-label="에이전트 멘션"
              className="rounded-[4px]"
              onClick={() => {
                onAnnouncement("멘션할 에이전트를 선택하세요.");
              }}
              size="icon"
              variant="ghost"
            >
              <At aria-hidden="true" size={18} />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              className="rounded-[4px]"
              disabled={!value.trim() || pending}
              onClick={() => {
                onSubmit("now");
              }}
            >
              <Lightning aria-hidden="true" size={16} />
              지금 반영
            </Button>
            <Button
              aria-label="다음 단계에 반영"
              className="rounded-[4px]"
              disabled={!value.trim() || pending}
              onClick={() => {
                onSubmit("next-stage");
              }}
              variant="primary"
            >
              다음 단계
              <ArrowRight aria-hidden="true" size={16} />
            </Button>
          </div>
        </div>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="mt-2 min-h-4 text-right text-[11px] text-muted"
          role="status"
        >
          {announcement}
        </p>
      </div>
    </div>
  );
}

function InspectorRoom({ room }: { room: RoomView }) {
  return (
    <div className="flex flex-col gap-4">
      {room.participants.length ? (
        <section aria-labelledby="room-participants" className="rounded-[4px] border border-line bg-bg-2">
          <h2 className="px-2 py-2 text-[13px] leading-5 text-fg-4" id="room-participants">이 방의 참가자 {room.participants.length}</h2>
          <ul className="flex flex-col gap-[2px] px-2 pb-2">
            {room.participants.map((participant) => (
              <li className="flex h-[30px] items-center gap-2 rounded-[4px] px-2" key={participant.handle}>
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${railClass(participant.accentSlot, participant.human)}`} />
                <span className={`min-w-0 flex-1 truncate text-[13px] ${speakerText(participant)}`}>{participant.name}</span>
                <span className="shrink-0 text-[12px] text-fg-4">{participant.role}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {room.budgets.length ? (
        <section aria-labelledby="room-budget" className="rounded-[4px] border border-line bg-bg-2 px-2 py-2">
          <h2 className="text-[13px] leading-5 text-fg-4" id="room-budget">방 한도</h2>
          <div className="mt-2 flex flex-col gap-3">
            {room.budgets.map((budget) => (
              <div key={budget.label}>
                <p className="flex items-center justify-between text-[12px] text-fg-3">
                  <span>{budget.label}</span>
                  <span className="font-mono text-[11px] text-fg-4">{budget.display}</span>
                </p>
                <span aria-hidden="true" className="mt-1 block h-[3px] bg-bg-3">
                  <span
                    className="block h-full bg-fg-4 transition-[width] duration-[250ms] ease-linear"
                    style={{ width: `${String(Math.min(100, Math.round((budget.used / Math.max(budget.limit, 1)) * 100)))}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {room.sharedContexts.length ? (
        <section aria-labelledby="room-shared" className="rounded-[4px] border border-line bg-bg-2 px-2 py-2">
          <h2 className="text-[13px] leading-5 text-fg-4" id="room-shared">공유 컨텍스트</h2>
          <ul className="mt-2 flex flex-col gap-[2px]">
            {room.sharedContexts.map((reference) => (
              <li className="flex h-[30px] items-center justify-between gap-2 rounded-[4px] px-2" key={reference.id}>
                <span className="min-w-0 truncate text-[13px] text-fg-2">{reference.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-fg-4">{reference.checksum}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function WorkInspector({
  room,
  service,
  work,
}: {
  room: RoomView | undefined;
  service: DesktopService;
  work: WorkView;
}) {
  const [tab, setTab] = useState("work");
  const [knowledge, setKnowledge] = useState<WorkKnowledgeViewV1>();
  const [knowledgeError, setKnowledgeError] = useState("");

  useEffect(() => {
    if (tab !== "knowledge") return;
    let disposed = false;
    setKnowledge(undefined);
    setKnowledgeError("");
    void service.loadWorkKnowledge(work.id).then(
      (value) => {
        if (!disposed) setKnowledge(value);
      },
      (cause: unknown) => {
        if (!disposed) setKnowledgeError(surfaceErrorMessage(cause, "사용한 지식을 불러오지 못했습니다."));
      },
    );
    return () => {
      disposed = true;
    };
  }, [service, tab, work.id]);

  return (
    <aside
      aria-label="Work 세부 정보"
      className="grid h-full min-h-0 min-w-0 grid-rows-[48px_minmax(0,1fr)] border-l border-line-strong bg-bg-1"
    >
      <Tabs
        className="contents"
        onValueChange={(value) => {
          setTab(value === null ? "work" : String(value));
        }}
        value={tab}
      >
        <header className="flex items-end px-2">
          <TabsList aria-label="세부 정보 보기" className="h-full w-full justify-between">
            <TabsTrigger className="h-full flex-1 px-1" value="work">
              편성
            </TabsTrigger>
            <TabsTrigger className="h-full flex-1 px-1" value="artifacts">
              산출물
            </TabsTrigger>
            <TabsTrigger className="h-full flex-1 px-1" value="verification">
              검증
            </TabsTrigger>
            <TabsTrigger className="h-full flex-1 px-1" value="knowledge">
              근거
            </TabsTrigger>
          </TabsList>
        </header>
        <div className="min-h-0 overflow-y-auto p-2">
          <TabsContent className="space-y-4" value="work">
            {room ? <InspectorRoom room={room} /> : <InspectorAgents agents={work.agents} />}
            <InspectorTasks progress={work.progress} tasks={work.tasks} />
          </TabsContent>
          <TabsContent value="artifacts">
            {work.artifacts.length ? (
              <section aria-labelledby="artifact-title" className="rounded-[4px] border border-line bg-bg-2">
                <h2 className="px-2 py-2 text-[13px] leading-5 text-fg-4" id="artifact-title">
                  산출물 {work.artifacts.length}
                </h2>
                <div className="flex flex-col gap-[2px] px-2 pb-2">
                  {work.artifacts.map((artifact) => (
                    <div className="flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left" key={artifact.id}>
                      {artifact.format === "PDF" ? (
                        <FilePdf aria-hidden="true" className="text-fg-3" size={16} />
                      ) : (
                        <FileCsv aria-hidden="true" className="text-fg-3" size={16} />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{artifact.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-4">{artifact.format} · {artifact.size} · {artifact.createdAt}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <InspectorEmpty icon={Briefcase} message="아직 생성된 산출물이 없습니다." />
            )}
          </TabsContent>
          <TabsContent value="verification">
            <InspectorVerifications values={work.verifications} />
          </TabsContent>
          <TabsContent value="knowledge">
            <WorkKnowledgeInspector
              error={knowledgeError}
              knowledge={knowledge}
              onOpenSharedContext={() => {
                setTab("work");
              }}
              sharedContextAvailable={(room?.sharedContexts.length ?? 0) > 0}
            />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function WorkKnowledgeInspector({
  error,
  knowledge,
  onOpenSharedContext,
  sharedContextAvailable,
}: {
  error: string;
  knowledge: WorkKnowledgeViewV1 | undefined;
  onOpenSharedContext: () => void;
  sharedContextAvailable: boolean;
}) {
  if (error)
    return (
      <section aria-label="사용한 지식" className="rounded-[4px] border border-line bg-bg-2 px-2 py-2">
        <h2 className="text-[13px] leading-5 text-fg-4">사용한 지식</h2>
        <p className="mt-1.5 text-[12px] leading-[18px] text-halt">{error}</p>
      </section>
    );
  if (knowledge === undefined)
    return <section aria-busy="true" aria-label="사용한 지식 불러오는 중" className="h-8" />;
  if (knowledge.status === "not-applicable")
    return (
      <InspectorEmpty
        detail="워크스페이스를 선택한 새 Work에서 코드 근거를 사용할 수 있습니다."
        icon={Database}
        message="이 Work는 워크스페이스 근거를 사용하지 않았습니다."
      />
    );
  if (knowledge.status === "no-match")
    return (
      <InspectorEmpty
        detail="새 Work에서 다른 요청이나 파일 범위로 다시 검색할 수 있습니다."
        icon={MagnifyingGlass}
        message="검색했지만 이 Work에서 사용할 코드 근거를 찾지 못했습니다."
      />
    );
  if (knowledge.status === "blocked")
    return (
      <section aria-label="사용한 지식" className="rounded-[4px] border border-line bg-bg-2 px-2 py-2">
        <h2 className="text-[13px] leading-5 text-fg-4">사용한 지식</h2>
        <p className="mt-1.5 text-[12px] leading-[18px] text-halt">
          지식 스냅샷을 검증하지 못했습니다. 업무 화면에서 실행을 재개하거나 새 Work를 시작해 주세요.
        </p>
      </section>
    );

  const freshness = knowledge.freshnessStatus === "stale_warning" ? "이후 파일 변경됨" : "현재 스냅샷";
  const freshnessDetail =
    knowledge.freshnessStatus === "stale_warning"
      ? "이 Work는 시작 당시의 근거를 계속 사용합니다. 새 Work는 현재 파일을 다시 읽습니다."
      : "이 Work에서 사용한 파일과 코드 범위입니다.";

  return (
    <section aria-label="사용한 지식" className="rounded-[4px] border border-line bg-bg-2">
      <header className="px-2 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] leading-5 text-fg-4">사용한 지식</h2>
          <span className="text-[12px] text-fg-4">{freshness}</span>
        </div>
        <p className="mt-1 text-[12px] leading-[18px] text-fg-4">{freshnessDetail}</p>
      </header>
      {knowledge.references.length === 0 ? (
        <p className="px-2 py-2 text-[12px] text-fg-4">사용한 코드 범위가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-[2px] px-2 pb-2">
          {knowledge.references.map((reference) => (
            <li key={reference.referenceId}>
              <button
                aria-label={`${reference.relativePath} 출처 보기`}
                className="flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left hover:bg-[rgb(255_255_255/0.027)] disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!sharedContextAvailable}
                onClick={onOpenSharedContext}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-fg-2">{reference.relativePath}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-fg-4">
                    {reference.qualifiedName ?? "코드 범위"} · {reference.startLine}–{reference.endLine}
                  </span>
                </span>
                {sharedContextAvailable ? (
                  <CaretRight aria-hidden="true" className="shrink-0 text-fg-4" size={12} />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharedContextAvailable ? (
        <p className="px-2 py-2 text-[11px] leading-4 text-fg-4">
          항목을 누르면 Core Office가 공유한 출처로 이동합니다.
        </p>
      ) : null}
    </section>
  );
}

function InspectorTasks({ progress, tasks }: { progress: number; tasks: TaskView[] }) {
  const complete = tasks.filter((task) => task.state === "done").length;
  return (
    <details className="rounded-[4px] border border-line bg-bg-2" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-2 text-[13px] leading-5 text-fg-4">
        <span>
          작업{" "}
          <span className="ml-1 font-mono text-[11px] text-fg-4">
            {complete}/{tasks.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-fg-4" size={15} />
      </summary>
      <div className="px-2 pb-2">
        <div
          aria-label={`작업 진행률 ${String(progress)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="mb-2 h-[3px] bg-bg-3"
          role="progressbar"
        >
          <span className="block h-full bg-fg-4 transition-[width] duration-[250ms] ease-linear" style={{ width: `${String(progress)}%` }} />
        </div>
        <ul className="flex flex-col gap-[2px]">
          {tasks.map((task) => (
            <li className="flex h-[30px] items-center gap-2 rounded-[4px] px-2 text-[12px]" key={task.id}>
              <Glyph
                kind={task.state === "done" ? "done" : task.state === "failed" ? "halt" : task.state === "active" ? "running" : "idle"}
                label={stateLabel[task.state]}
              />
              <span className="min-w-0 flex-1 truncate text-fg-2">{task.title}</span>
              <span className={`shrink-0 text-[12px] ${stateClass[task.state]}`}>{task.time ?? stateLabel[task.state]}</span>
              <CaretRight aria-hidden="true" className="text-fg-4" size={13} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function InspectorAgents({ agents }: { agents: AgentView[] }) {
  return (
    <section aria-labelledby="agent-title" className="rounded-[4px] border border-line bg-bg-2 px-2 py-2">
      <h2 className="mb-2 text-[13px] leading-5 text-fg-4" id="agent-title">
        담당 에이전트
      </h2>
      <ul className="flex flex-col gap-[2px]">
        {agents.map((agent) => (
          <li className="flex h-[30px] items-center gap-2 rounded-[4px] px-2" key={agent.id}>
            <Avatar className="size-7">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-[12px] text-fg-2">{agent.name}</span>
              <span className="shrink-0 text-[12px] text-fg-4">{agent.role}</span>
            </span>
            <span
              className={
                agent.state === "active"
                  ? "flex items-center gap-1 text-[12px] text-fg-3"
                  : "flex items-center gap-1 text-[12px] text-fg-4"
              }
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${agent.state === "active" ? "bg-fg-3" : "bg-fg-4"}`}
              />
              {agent.state === "active" ? "진행 중" : "대기"}
            </span>
            <CaretRight aria-hidden="true" className="text-fg-4" size={13} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InspectorVerifications({ values }: { values: WorkView["verifications"] }) {
  const complete = values.filter((item) => item.state === "done").length;
  return (
    <details className="rounded-[4px] border border-line bg-bg-2" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-2 text-[13px] leading-5 text-fg-4">
        <span>
          검증 기준{" "}
          <span className="ml-1 font-mono text-[11px] text-fg-4">
            {complete}/{values.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-fg-4" size={15} />
      </summary>
      <ul className="flex flex-col gap-[2px] px-2 pb-2">
        {values.map((verification) => (
          <li className="rounded-[4px] px-2 py-1" key={verification.id}>
            <div className="flex h-[30px] items-center gap-2 text-[12px]">
              <Glyph
                kind={verification.state === "done" ? "verified" : verification.state === "failed" ? "halt" : verification.state === "active" ? "running" : "idle"}
                label={stateLabel[verification.state]}
              />
              <span className="text-fg-4">판정</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{verification.verifier}</span>
              <span className={`text-[12px] ${stateClass[verification.state]}`}>{stateLabel[verification.state]}</span>
              <CaretRight aria-hidden="true" className="text-fg-4" size={13} />
            </div>
            {verification.criteria.length === 0 ? null : (
              <ul className="mt-1.5 space-y-1 pl-6">
                {verification.criteria.map((criterion) => (
                  <li className="flex items-center gap-2 text-[12px]" key={criterion.key}>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-4">{criterion.key}</span>
                    <span className={`text-[12px] ${criterionStatusClass[criterion.status]}`}>
                      {criterionStatusLabel[criterion.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {verification.evidence ? (
              <p className="mt-1 pl-6 font-mono text-[11px] text-fg-4">{verification.evidence}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function InspectorEmpty({ detail, icon: Icon, message }: { detail?: string | undefined; icon: typeof Briefcase; message: string }) {
  return (
    <div className="px-5 py-14 text-center">
      <Icon aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
      <p className="text-[13px] text-fg-2">{message}</p>
      <p className="mt-1 text-[12px] text-fg-4">{detail ?? "실행이 산출물을 만들면 여기에 표시됩니다."}</p>
    </div>
  );
}

interface NewWorkDialogProps {
  addWorkspacePaths: (files: readonly string[]) => void;
  contextPicker: NativeContextPicker;
  error: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  setText: (value: string) => void;
  setWorkspace: (workspace: import("@/desktop-service").DesktopWorkspaceView | undefined) => void;
  removeWorkspacePath: (path: string) => void;
  registerWorkspace: (path: string) => Promise<void>;
  registeringWorkspace: boolean;
  setPickerError: (message: string) => void;
  decideWorkspaceTrust: (decision: "trusted" | "blocked") => Promise<void>;
  start: () => Promise<void>;
  starting: boolean;
  text: string;
  workspace: import("@/desktop-service").DesktopWorkspaceView | undefined;
  workspacePaths: readonly string[];
  workspaces: readonly import("@/desktop-service").DesktopWorkspaceView[];
  workspacesLoading: boolean;
  onOpenSettings: () => void;
}

export function NewWorkDialog({
  addWorkspacePaths,
  contextPicker,
  error,
  open,
  setOpen,
  setText,
  setWorkspace,
  removeWorkspacePath,
  registerWorkspace,
  registeringWorkspace,
  setPickerError,
  decideWorkspaceTrust,
  start,
  starting,
  text,
  workspace,
  workspacePaths,
  workspaces,
  workspacesLoading,
  onOpenSettings,
}: NewWorkDialogProps) {
  const addDirectory = async () => {
    try {
      setPickerError("");
      const path = await contextPicker.pickDirectory();
      if (path !== undefined) await registerWorkspace(path);
    } catch {
      setPickerError("폴더 선택기를 열지 못했습니다.");
    }
  };
  const addFiles = async () => {
    try {
      setPickerError("");
      const paths = await contextPicker.pickFiles();
      addWorkspacePaths(paths);
    } catch {
      setPickerError("파일 선택기를 열지 못했습니다.");
    }
  };
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!starting) setOpen(nextOpen);
      }}
      open={open}
    >
      <DialogContent aria-label="새 Work">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-lg font-semibold">새 Work</DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-6 text-muted">
              대표 에이전트에게 맡길 업무를 입력하면 새 실행이 시작됩니다.
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="새 Work 닫기"
            className="flex size-8 shrink-0 items-center justify-center rounded-[4px] text-muted outline-none hover:bg-surface-2 hover:text-primary"
            disabled={starting}
          >
            <X aria-hidden="true" size={17} />
          </DialogClose>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label className="block text-sm font-medium" htmlFor="new-work-text">
            업무 요청
            <Textarea
              autoFocus
              className="mt-2 min-h-28 border border-control bg-surface-1 px-3 py-2"
              disabled={starting}
              id="new-work-text"
              onChange={(event) => {
                setText(event.target.value);
              }}
              placeholder="예: 파트너 계약의 주요 위험을 검토해줘"
              required
              value={text}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              워크스페이스 <span className="font-normal text-muted">(선택)</span>
            </legend>
            <div className="min-h-[5.5rem] max-h-36 space-y-2 overflow-y-auto rounded-[4px] border border-control bg-surface-1 p-2">
              {workspacesLoading ? (
                <div aria-label="워크스페이스 불러오는 중" className="h-14 rounded-[4px] bg-surface-2" />
              ) : workspaces.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted">저장된 폴더가 없습니다.</p>
              ) : (
                workspaces.map((item) =>
                  item.trust === "blocked" ? (
                    <div className="rounded-[4px] px-2 py-1 text-sm text-muted" key={item.workspaceId}>
                      <span className="block font-medium">{item.name} (차단됨)</span>
                      <span className="block font-mono text-xs">{item.path}</span>
                      <span className="block text-xs">차단된 폴더는 선택할 수 없습니다.</span>
                      <Button
                        disabled={registeringWorkspace}
                        onClick={onOpenSettings}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        설정으로 이동
                      </Button>
                    </div>
                  ) : (
                    <button
                      aria-pressed={workspace?.workspaceId === item.workspaceId}
                      className="block w-full rounded-[4px] px-2 py-1 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={starting || registeringWorkspace}
                      key={item.workspaceId}
                      onClick={() => {
                        setWorkspace(item);
                      }}
                      type="button"
                    >
                      <span className="block font-medium">
                        {item.name}{" "}
                        <span className="font-normal text-muted">
                          ({item.trust === "trusted" ? "신뢰됨" : "신뢰 필요"})
                        </span>
                      </span>
                      <span className="block font-mono text-xs text-muted">{item.path}</span>
                    </button>
                  ),
                )
              )}
            </div>
            <p aria-live="polite" className="sr-only">
              {workspace === undefined ? "" : `${workspace.name} 폴더를 선택했습니다.`}
            </p>
            <Button
              disabled={starting || registeringWorkspace}
              onClick={() => {
                void addDirectory();
              }}
              type="button"
              variant="outline"
            >
              폴더 추가
            </Button>
            {workspace?.trust === "pending" ? (
              <div className="rounded-[4px] border border-warning/40 bg-warning/10 p-3 text-sm">
                <p>이 폴더 안에서 에이전트가 읽기·쓰기 도구를 사용할 수 있습니다.</p>
                <p className="mt-1 font-mono text-xs text-muted">{workspace.path}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    disabled={starting || registeringWorkspace}
                    onClick={() => {
                      void decideWorkspaceTrust("trusted");
                    }}
                    size="sm"
                    type="button"
                    variant="primary"
                  >
                    신뢰
                  </Button>
                  <Button
                    disabled={starting || registeringWorkspace}
                    onClick={() => {
                      void decideWorkspaceTrust("blocked");
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    차단
                  </Button>
                </div>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              파일 첨부 <span className="font-normal text-muted">(선택)</span>
            </legend>
            <Button
              disabled={
                starting ||
                registeringWorkspace ||
                workspace === undefined ||
                workspace.trust !== "trusted" ||
                workspacePaths.length >= 20
              }
              onClick={() => {
                void addFiles();
              }}
              type="button"
              variant="outline"
            >
              파일 첨부
            </Button>
            <p aria-live="polite" aria-label="파일 첨부 상태" className="sr-only" role="status">
              {workspacePaths.length === 0 ? "" : `파일을 첨부했습니다: ${workspacePaths.join(", ")}`}
            </p>
            {workspacePaths.length > 0 ? (
              <ul aria-live="polite" className="flex flex-wrap gap-2">
                {workspacePaths.map((path) => (
                  <li className="rounded-[4px] bg-surface-2 px-2 py-1 font-mono text-xs" key={path}>
                    {path}{" "}
                    <button
                      aria-label={`${path} 제거`}
                      className="ml-1 text-muted hover:text-primary"
                      disabled={starting || registeringWorkspace}
                      onClick={() => {
                        removeWorkspacePath(path);
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </fieldset>
          <p aria-live="polite" className="min-h-5 text-xs text-danger" role="status">
            {error}
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose
              className="inline-flex h-9 items-center justify-center rounded-[4px] px-3 text-sm text-secondary outline-none hover:bg-surface-2 disabled:opacity-50"
              disabled={starting}
            >
              취소
            </DialogClose>
            <Button disabled={!text.trim() || starting || registeringWorkspace} type="submit" variant="primary">
              {starting ? "시작 중" : "실행 시작"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
