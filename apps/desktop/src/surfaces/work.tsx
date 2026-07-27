import {
  ArrowRight,
  At,
  Briefcase,
  CaretDown,
  CaretRight,
  CheckCircle,
  Clock,
  Database,
  FileCsv,
  FilePdf,
  Lightning,
  ListChecks,
  MagnifyingGlass,
  Paperclip,
  Plus,
  ShieldCheck,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { DesktopFilter, DesktopService } from "@/desktop-service";
import type {
  ActivityView,
  AgentView,
  ApprovalView,
  ArtifactView,
  RoomView,
  TaskView,
  WorkStatus,
  WorkView,
} from "@/model";
import type { WorkKnowledgeViewV1 } from "@massion/application/client";
import type { NativeContextPicker } from "@/native-context-picker";

import {
  AgentAvatar,
  DecisionActions,
  ProposalActivity,
  RoomChapter,
  RoomHandoff,
  RoomMessage,
  RoomReference,
  RoomStatus,
  SpeakerRow,
} from "@/room";
import { stateClass, stateLabel, criterionStatusClass, criterionStatusLabel, StateIcon } from "@/ui/state";
import { surfaceErrorMessage } from "@/ui/surface";

const workStatusLabel: Record<WorkStatus, string> = {
  active: "진행 중",
  complete: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

const workStatusClass: Record<WorkStatus, string> = {
  active: "text-primary",
  complete: "text-muted",
  failed: "text-danger",
  cancelled: "text-muted",
};

export function WorkEmptySurface({ onCreate }: { onCreate: () => void }) {
  return (
    <main aria-label="업무" className="col-span-2 flex min-h-0 items-center justify-center bg-canvas text-primary">
      <div className="text-center">
        <Briefcase aria-hidden="true" className="mx-auto mb-4 text-muted" size={32} />
        <h1 className="text-lg font-semibold">선택한 상태에 Work가 없습니다.</h1>
        <p className="mt-2 text-sm text-muted">왼쪽에서 상태를 바꾸거나 첫 Work를 만들어주세요.</p>
        <Button className="mt-5" onClick={onCreate} variant="primary">
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
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_auto_minmax(0,1fr)] border-r border-border bg-chrome"
    >
      <header className="flex items-center justify-between border-b border-border px-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.015em]">업무</h2>
        <Button aria-label="새 Work 만들기" onClick={onCreate} size="icon" variant="ghost">
          <Plus aria-hidden="true" size={17} />
        </Button>
      </header>
      <div className="space-y-2 border-b border-border px-2.5 py-2.5">
        <label className="relative block">
          <span className="sr-only">Work 검색</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            size={16}
          />
          <input
            className="h-8 w-full rounded-[5px] border border-border bg-surface-1 pl-8 pr-3 text-[13px] text-primary outline-none placeholder:text-muted focus:border-control"
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
              className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
              value="active"
            >
              진행 중
            </TabsTrigger>
            <TabsTrigger
              className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
              value="complete"
            >
              완료
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {works.length || (pendingRunId && filter === "active") ? (
          // 둥근 행에 여백을 주면 사이 구분이 약합니다. 전폭 행과 1px 선이 밀도와 구분감을 같이 만듭니다.
          <div className="divide-y divide-border border-b border-border">
            {pendingRunId && filter === "active" ? (
              <div
                aria-label={`Work 생성 중 ${pendingRunId}`}
                className="border-b border-dashed border-control bg-surface-1 px-3 py-2.5"
                role="status"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-secondary">
                  <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-accent" />
                  Work 생성 중
                </span>
                <span className="mt-2 block truncate font-mono text-[10px] text-muted">{pendingRunId}</span>
              </div>
            ) : null}
            {works.map((work) => {
              const selected = work.id === selectedId;
              return (
                <button
                  aria-pressed={selected}
                  className={`relative w-full px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                    selected
                      ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                      : "hover:bg-surface-1"
                  }`}
                  key={work.id}
                  onClick={() => {
                    onSelect(work.id);
                  }}
                  type="button"
                >
                  <span className="block truncate text-[13px] font-medium text-primary">{work.title}</span>
                  <span className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className={`flex items-center gap-2 ${workStatusClass[work.status]}`}>
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                      {workStatusLabel[work.status]}
                    </span>
                    <time className="font-mono text-muted">{work.updatedAt}</time>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-12 text-center">
            <Briefcase aria-hidden="true" className="mx-auto mb-3 text-muted" size={26} />
            <p className="text-sm text-secondary">{query ? "검색 결과가 없습니다." : "완료된 Work가 없습니다."}</p>
            <p className="mt-1 text-xs text-muted">
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
  // 방이 있으면 대화는 방이 정본입니다. 없으면 Work의 활동 타임라인이 계속 나옵니다.
  const activities = room ? room.activities : work.activities;
  return (
    <main
      aria-busy={detailLoading || undefined}
      aria-label={work.title}
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_auto_minmax(0,1fr)_auto] bg-canvas"
    >
      <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-[16px] font-semibold tracking-[-0.02em]">{work.title}</h1>
          <Badge tone={work.status === "complete" ? "success" : work.status === "failed" ? "danger" : "accent"}>
            {workStatusLabel[work.status]}
          </Badge>
          {/*
           * 방이 화면의 주인이라는 사실을 헤더가 말해야 합니다.
           * 참가자 얼굴과 라운드·비용이 여기 없으면 중앙이 그냥 대화 목록으로 읽힙니다.
           */}
          {room ? (
            <>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
              <span
                className="flex shrink-0 items-center gap-1.5"
                title={`협업방 참가 ${String(room.participants.length)}명`}
              >
                <SpeakerRow limit={5} speakers={room.participants} />
                <span className="font-mono text-[11px] text-muted">참가 {room.participants.length}</span>
              </span>
              {room.budgets.length ? (
                <span className="hidden shrink-0 font-mono text-[11px] text-muted min-[1360px]:inline">
                  {room.budgets.map((budget) => `${budget.label} ${budget.display}`).join(" · ")}
                </span>
              ) : null}
            </>
          ) : (
            <Badge className="max-[1320px]:hidden">{work.team}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {executionNotice ? (
            <span aria-live="polite" className="mr-2 max-w-48 truncate text-xs text-accent" role="status">
              {executionNotice}
            </span>
          ) : null}
          {work.run?.status === "awaiting-approval" ? (
            <span className="mr-2 text-xs text-gate">승인 결정 대기 중</span>
          ) : null}
          {canResume ? (
            <Button
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("resume");
              }}
              size="sm"
              variant="ghost"
            >
              {pendingRunAction === "resume" ? "재개 중" : "실행 재개"}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("cancel");
              }}
              size="sm"
              variant="ghost"
            >
              {pendingRunAction === "cancel" ? "취소 중" : "실행 취소"}
            </Button>
          ) : null}
        </div>
      </header>
      {/*
       * 탭 바는 "지금 어느 방에 있나"를 말하는 자리이므로 방이 하나여도 항상 그립니다.
       * 래퍼는 방이 없을 때도 유지합니다. grid 행 수가 흔들리면 본문이 접힙니다.
       */}
      <div>
        {work.run ? <RunStatusCard run={work.run} /> : null}
        {rooms.length > 0 ? (
          <nav aria-label="협업방" className="flex items-center gap-1 border-b border-border px-5 py-1.5">
            {rooms.map((candidate, index) => {
              const current = candidate.roomId === room?.roomId;
              // 어느 방이 사람을 기다리는지. 노랑은 여기서도 같은 뜻입니다.
              const waiting = candidate.activities.some(
                (activity) => activity.kind === "proposal" || activity.kind === "approval",
              );
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={`flex items-center gap-2 rounded-[5px] px-2.5 py-1 text-left outline-none ${
                    current ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-1"
                  }`}
                  key={candidate.roomId}
                  onClick={() => {
                    onSelectRoom(candidate.roomId);
                  }}
                  type="button"
                >
                  {/*
                   * 탭은 지금 보고 있지 않은 방을 보는 유일한 자리입니다.
                   * 색이 "저 방엔 누가 있나"를 이름보다 빨리 말하므로 아바타를 유지하되,
                   * 폭이 무한히 자라지 않게 둘로 제한하고 나머지는 +N으로 알립니다.
                   */}
                  <SpeakerRow limit={2} speakers={candidate.participants} />
                  <span className="text-[13px] font-medium">{candidate.name}</span>
                  {waiting ? (
                    <span aria-label="확인 필요" className="text-[11px] text-gate">
                      ◇
                    </span>
                  ) : null}
                  {index === 0 ? null : (
                    <span
                      aria-label={`${candidate.name} 닫기`}
                      className="ml-0.5 rounded-[3px] px-1 text-[11px] text-muted hover:text-primary"
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
      <section aria-label={room ? `협업방 ${room.name}` : "Work 활동"} className="min-h-0 overflow-y-auto px-5 py-3">
        <div className="mx-auto max-w-[860px]">
          {room && activities.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              아직 이 방에서 오간 말이 없습니다. 아래에 지시를 쓰면 조직이 시작합니다.
            </p>
          ) : null}
          {activities.map((activity) => (
            <ActivityRow
              approvalDecision={activity.kind === "approval" ? approvalDecisions[activity.approvalId] : undefined}
              approvals={work.approvals}
              key={activity.id}
              onAnnouncement={onAnnouncement}
              onDecideApproval={onDecideApproval}
              onOpenRoom={onSelectRoom}
              pendingApprovals={pendingApprovals}
              value={activity}
            />
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
  const active = ["ready", "running"].includes(run.status);
  if (!blocked && !awaitingApproval && !active) return null;

  if (blocked) {
    return (
      <section aria-label="실행 상태" className="border-b border-danger/40 bg-surface-1 px-5 py-3" role="status">
        <div className="mx-auto flex max-w-[860px] items-start gap-3">
          <WarningCircle aria-hidden="true" className="mt-0.5 shrink-0 text-danger" size={18} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-primary">실행이 멈췄습니다</p>
            <p className="mt-1 text-[12px] leading-5 text-danger">{blockedReasonText(run.blockedReason)}</p>
            <p className="mt-1 text-[11px] text-muted">
              현재 단계: {runStageText(run.stage)}
              {run.blockedReason ? (
                <code className="ml-2 font-mono text-[10px] text-muted">{run.blockedReason}</code>
              ) : null}
            </p>
            <p className="mt-1 text-[11px] text-muted">상단의 실행 재개를 누르면 이 단계부터 다시 시도합니다.</p>
          </div>
        </div>
      </section>
    );
  }

  if (awaitingApproval) {
    return (
      <section aria-label="실행 상태" className="border-b border-gate/40 bg-surface-1 px-5 py-3" role="status">
        <div className="mx-auto flex max-w-[860px] items-start gap-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-gate" size={18} />
          <div>
            <p className="text-[13px] font-semibold text-primary">사람의 결정을 기다리는 중입니다</p>
            <p className="mt-1 text-[12px] leading-5 text-gate">
              수신함에서 승인 여부를 결정하면 다음 단계로 진행합니다.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="실행 상태" className="border-b border-control/40 bg-surface-1 px-5 py-3" role="status">
      <div className="mx-auto flex max-w-[860px] items-center gap-3">
        <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
        <p className="text-[13px] font-medium text-primary">실행 중</p>
        <span className="text-[12px] text-secondary">{runStageText(run.stage)}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">개정 {run.leaseGeneration}</span>
      </div>
    </section>
  );
}

interface ActivityRowProps {
  onOpenRoom: (roomId: string) => void;
  value: ActivityView;
  approvalDecision: "approved" | "rejected" | undefined;
  approvals: ApprovalView[];
  pendingApprovals: ReadonlySet<string>;
  onAnnouncement: (message: string) => void;
  onDecideApproval: (approval: ApprovalView, decision: "approved" | "rejected") => void;
}

function ActivityRow({
  approvalDecision,
  approvals,
  onAnnouncement,
  onOpenRoom,
  onDecideApproval,
  pendingApprovals,
  value,
}: ActivityRowProps) {
  const approval = value.kind === "approval" ? approvals.find((item) => item.id === value.approvalId) : undefined;

  // 방 문법은 40px 거터 격자를 쓰지 않습니다. 구분선·상태·인계는 폭 전체를 씁니다.
  if (value.kind === "chapter") {
    return (
      <div className="py-2">
        <RoomChapter label={value.label} time={value.time} until={value.until} />
      </div>
    );
  }
  if (value.kind === "roomStatus") {
    return (
      <div className="py-2">
        <RoomStatus content={value.content} />
      </div>
    );
  }
  if (value.kind === "roomRef") {
    return (
      <div className="py-2">
        <RoomReference
          messageCount={value.messageCount}
          name={value.name}
          onOpen={() => {
            onOpenRoom(value.roomId);
          }}
          participants={value.participants}
          lastLine={value.lastLine}
          time={value.time}
          waiting={value.waiting}
        />
      </div>
    );
  }
  if (value.kind === "handoff") {
    return (
      <div className="py-2">
        <RoomHandoff from={value.from} time={value.time} to={value.to} />
      </div>
    );
  }
  if (value.kind === "room") {
    return (
      <div className="py-2.5">
        <RoomMessage
          speaker={value.speaker}
          content={value.content}
          evidence={value.evidence}
          indented={value.indented}
          quoted={value.quoted}
          recipient={value.recipient}
          signature={value.signature}
          target={value.target}
          time={value.time}
          type={value.messageType}
        />
      </div>
    );
  }
  if (value.kind === "proposal") {
    return (
      <div className="py-2.5">
        <ProposalActivity
          speaker={value.speaker}
          change={value.change}
          content={value.content}
          decided={false}
          disabled={false}
          // ponytail: 조직 변경 command는 슬라이스 4에서 연결합니다. 지금은 결과를 알림으로만 알립니다.
          onApprove={() => {
            onAnnouncement(`${value.change.name} 신설을 승인했습니다.`);
          }}
          onReject={() => {
            onAnnouncement(`${value.change.name} 신설을 거절했습니다.`);
          }}
          time={value.time}
        />
      </div>
    );
  }

  return (
    <article className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-border/70 py-4 last:border-b-0">
      <ActivityMarker value={value} />
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          {value.kind === "message" ? <span className="font-medium text-secondary">{value.author}</span> : null}
          <time className="font-mono">{value.time}</time>
        </div>
        {value.kind === "message" ? (
          <p className="rounded-md border border-border bg-surface-1 px-4 py-3 text-sm leading-6 text-secondary">
            {value.content}
          </p>
        ) : null}
        {value.kind === "plan" ? <PlanActivity title={value.title} steps={value.steps} /> : null}
        {value.kind === "agents" ? <AgentsActivity agents={value.agents} title={value.title} /> : null}
        {value.kind === "approval" ? (
          <ApprovalActivity
            decision={approvalDecision}
            description={value.description}
            disabled={!approval || pendingApprovals.has(value.approvalId)}
            onApprove={() => {
              if (approval) onDecideApproval(approval, "approved");
            }}
            onReject={() => {
              if (approval) onDecideApproval(approval, "rejected");
            }}
            title={value.title}
          />
        ) : null}
        {value.kind === "artifacts" ? <ArtifactsActivity artifacts={value.artifacts} title={value.title} /> : null}
        {value.kind === "event" ? (
          <EventActivity detail={value.detail} status={value.status} title={value.title} />
        ) : null}
      </div>
    </article>
  );
}

// 방 문법(chapter·roomStatus·handoff·room·proposal)은 ActivityRow에서 먼저 반환되므로 여기 오지 않습니다.
type MarkedActivity = Extract<
  ActivityView,
  { kind: "message" | "plan" | "agents" | "approval" | "artifacts" | "event" }
>;

function ActivityMarker({ value }: { value: MarkedActivity }) {
  if (value.kind === "message") {
    return (
      <Avatar
        className={
          value.initials === "M"
            ? "rounded-md border border-accent/60 bg-surface-1 text-accent"
            : "border border-border"
        }
      >
        <AvatarFallback className={value.initials === "M" ? "text-accent" : ""}>{value.initials}</AvatarFallback>
      </Avatar>
    );
  }

  const icons = { plan: ListChecks, agents: UsersThree, approval: ShieldCheck, artifacts: Briefcase, event: Clock };
  const Icon = icons[value.kind];
  return (
    <span className="flex size-8 items-center justify-center rounded-md border border-control text-secondary">
      <Icon aria-hidden="true" size={17} />
    </span>
  );
}

function PlanActivity({ steps, title }: { steps: TaskView[]; title: string }) {
  return (
    <details className="group rounded-md border border-border bg-surface-1" open>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        {title}
        {/* 단계 수를 말합니다. 몇 개 중 몇 개를 보고 있는지 모르면 목록이 거짓말을 합니다. */}
        <span className="font-mono text-[11px] font-normal text-muted">
          {steps.filter((step) => step.state === "done").length} / {steps.length}
        </span>
        <CaretDown
          aria-hidden="true"
          className="ml-auto text-muted transition-transform group-open:rotate-180"
          size={16}
        />
      </summary>
      <ol className="border-t border-border px-4 py-2">
        {steps.map((step, index) => (
          <li className="flex min-h-8 items-center gap-3 text-sm" key={step.id}>
            <span
              className={`flex size-5 items-center justify-center rounded-full border font-mono text-[10px] ${stateClass[step.state]}`}
            >
              {step.state === "done" ? <CheckCircle aria-hidden="true" size={14} weight="fill" /> : index + 1}
            </span>
            <span className="flex-1 text-secondary">{step.title}</span>
            <span className={`text-xs ${stateClass[step.state]}`}>{stateLabel[step.state]}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AgentsActivity({ agents, title }: { agents: AgentView[]; title: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {agents.map((agent) => (
          <div
            className="flex min-w-[122px] items-center gap-2 rounded-md border border-border px-2.5 py-2"
            key={agent.id}
          >
            <Avatar className="size-7">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{agent.name}</span>
                <span className="shrink-0 rounded-[3px] border border-control px-1 text-[10px] text-muted">
                  {agent.role}
                </span>
              </p>
              <p className={agent.state === "active" ? "text-[11px] text-primary" : "text-[11px] text-muted"}>
                {agent.state === "active" ? "진행 중" : "대기"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ApprovalActivityProps {
  title: string;
  description: string;
  decision: "approved" | "rejected" | undefined;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

function ApprovalActivity({ decision, description, disabled, onApprove, onReject, title }: ApprovalActivityProps) {
  return (
    <div
      className={`rounded-[7px] border px-4 py-3 ${decision ? "border-border bg-surface-1" : "border-gate-border bg-gate-wash"}`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[5px] border border-control text-secondary">
          <Database aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{title}</h3>
            {decision ? (
              <Badge tone={decision === "approved" ? "success" : "danger"}>
                {decision === "approved" ? "승인됨" : "거절됨"}
              </Badge>
            ) : (
              <span className="text-xs font-medium text-gate">승인 필요</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
          <p className="text-xs leading-5 text-muted">영향: 승인 전까지 관련 실행이 대기합니다.</p>
        </div>
      </div>
      {!decision ? (
        <div className="mt-3 flex justify-end">
          <DecisionActions
            approveName={title}
            busy={disabled}
            disabled={disabled}
            onApprove={onApprove}
            onReject={onReject}
          />
        </div>
      ) : null}
    </div>
  );
}

function ArtifactsActivity({ artifacts, title }: { artifacts: ArtifactView[]; title: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-2 gap-2">
        {artifacts.map((artifact) => {
          const Icon = artifact.format === "PDF" ? FilePdf : FileCsv;
          return (
            <div
              aria-label={`${artifact.name} 메타데이터`}
              className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 text-left"
              key={artifact.id}
            >
              <Icon
                aria-hidden="true"
                className={artifact.format === "PDF" ? "text-danger" : "text-success"}
                size={24}
                weight="fill"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-primary">{artifact.name}</span>
                <span className="font-mono text-[10px] text-muted">{artifact.size}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted">열기·다운로드 미지원</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventActivity({
  detail,
  status,
  title,
}: {
  detail: string | undefined;
  status: string | undefined;
  title: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {status ? <Badge>{status}</Badge> : null}
      </div>
      {detail ? <p className="mt-1 text-xs leading-5 text-muted">{detail}</p> : null}
    </div>
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
    <div className="border-t border-border bg-canvas px-5 pb-4 pt-3" data-testid="directive-composer">
      <div className="mx-auto max-w-[860px] rounded-lg border border-control bg-surface-1 p-3 focus-within:border-accent/70">
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
    <>
      <section aria-labelledby="room-participants" className="border border-border bg-surface-1">
        <h2
          className="border-b border-border px-3.5 py-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted"
          id="room-participants"
        >
          이 방의 참가자 {room.participants.length}
        </h2>
        {room.participants.length ? (
          <ul className="divide-y divide-border">
            {room.participants.map((participant) => (
              <li className="flex items-center gap-2 px-3.5 py-2" key={participant.handle}>
                <AgentAvatar speaker={participant} />
                <span className="truncate text-xs font-medium text-primary">{participant.name}</span>
                <span className="shrink-0 rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                  {participant.role}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3.5 py-3 text-xs text-muted">참가자 정보가 아직 없습니다.</p>
        )}
      </section>

      {room.budgets.length ? (
        <section aria-labelledby="room-budget" className="border border-border bg-surface-1 px-3.5 py-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted" id="room-budget">
            방 한도
          </h2>
          <div className="mt-2.5 grid gap-2.5">
            {room.budgets.map((budget) => (
              <div key={budget.label}>
                <p className="flex items-center justify-between text-xs text-secondary">
                  <span>{budget.label}</span>
                  <span className="font-mono text-[11px] text-muted">{budget.display}</span>
                </p>
                <span aria-hidden="true" className="mt-1 block h-[3px] overflow-hidden rounded-sm bg-bg-3">
                  <span
                    className="block h-full bg-muted"
                    style={{
                      width: `${String(Math.min(100, Math.round((budget.used / Math.max(budget.limit, 1)) * 100)))}%`,
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {room.sharedContexts.length ? (
        <section aria-labelledby="room-shared" className="border border-border bg-surface-1 px-3.5 py-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted" id="room-shared">
            공유 컨텍스트
          </h2>
          <ul className="mt-2 grid gap-1.5">
            {room.sharedContexts.map((reference) => (
              <li className="text-xs text-secondary" key={reference.id}>
                <span className="block truncate">{reference.label}</span>
                <span className="font-mono text-[10px] text-muted">checksum {reference.checksum}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
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
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome"
    >
      <Tabs
        className="contents"
        onValueChange={(value) => {
          setTab(value === null ? "work" : String(value));
        }}
        value={tab}
      >
        <header className="flex items-end border-b border-border px-2">
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
        <div className="min-h-0 overflow-y-auto p-3">
          <TabsContent className="space-y-3" value="work">
            {room ? <InspectorRoom room={room} /> : <InspectorAgents agents={work.agents} />}
            <InspectorTasks progress={work.progress} tasks={work.tasks} />
          </TabsContent>
          <TabsContent value="artifacts">
            {work.artifacts.length ? (
              <section aria-labelledby="artifact-title" className="border border-border bg-surface-1">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold" id="artifact-title">
                  산출물 {work.artifacts.length}
                </h2>
                <div className="divide-y divide-border">
                  {work.artifacts.map((artifact) => (
                    <div className="flex w-full items-center gap-3 px-4 py-3 text-left" key={artifact.id}>
                      {artifact.format === "PDF" ? (
                        <FilePdf aria-hidden="true" className="text-danger" size={20} />
                      ) : (
                        <FileCsv aria-hidden="true" className="text-success" size={20} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-primary">{artifact.name}</span>
                        <span className="font-mono text-[10px] text-muted">
                          {artifact.format} · {artifact.size} · {artifact.createdAt}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">메타데이터만</span>
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
      <section aria-label="사용한 지식" className="border border-danger/50 bg-surface-1 px-3.5 py-3">
        <h2 className="text-sm font-semibold">사용한 지식</h2>
        <p className="mt-1.5 text-xs leading-5 text-danger">{error}</p>
      </section>
    );
  if (knowledge === undefined)
    return (
      <section aria-busy="true" aria-label="사용한 지식 불러오는 중" className="space-y-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </section>
    );
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
      <section aria-label="사용한 지식" className="border border-danger/50 bg-surface-1 px-3.5 py-3">
        <h2 className="text-sm font-semibold">사용한 지식</h2>
        <p className="mt-1.5 text-xs leading-5 text-danger">
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
    <section aria-label="사용한 지식" className="border border-border bg-surface-1">
      <header className="border-b border-border px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">사용한 지식</h2>
          <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">{freshness}</span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted">{freshnessDetail}</p>
      </header>
      {knowledge.references.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-muted">사용한 코드 범위가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-border">
          {knowledge.references.map((reference) => (
            <li key={reference.referenceId}>
              <button
                aria-label={`${reference.relativePath} 출처 보기`}
                className="flex w-full items-center gap-2 px-3.5 py-3 text-left outline-none hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!sharedContextAvailable}
                onClick={onOpenSharedContext}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-primary">{reference.relativePath}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {reference.qualifiedName ?? "코드 범위"} · {reference.startLine}–{reference.endLine}
                  </span>
                </span>
                {sharedContextAvailable ? (
                  <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={14} />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharedContextAvailable ? (
        <p className="border-t border-border px-3.5 py-2.5 text-[11px] leading-4 text-muted">
          항목을 누르면 Core Office가 공유한 출처로 이동합니다.
        </p>
      ) : null}
    </section>
  );
}

function InspectorTasks({ progress, tasks }: { progress: number; tasks: TaskView[] }) {
  const complete = tasks.filter((task) => task.state === "done").length;
  return (
    <details className="border border-border bg-surface-1" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        <span>
          작업{" "}
          <span className="ml-1 font-mono font-normal text-muted">
            {complete}/{tasks.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-muted" size={15} />
      </summary>
      <div className="px-4 pb-2">
        <div
          aria-label={`작업 진행률 ${String(progress)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="mb-2 h-1 overflow-hidden rounded-full bg-border"
          role="progressbar"
        >
          <span className="block h-full bg-accent" style={{ width: `${String(progress)}%` }} />
        </div>
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li className="flex min-h-10 items-center gap-2 text-xs" key={task.id}>
              <StateIcon state={task.state} />
              <span className="min-w-0 flex-1 truncate text-secondary">{task.title}</span>
              <span className={`shrink-0 ${stateClass[task.state]}`}>{task.time ?? stateLabel[task.state]}</span>
              <CaretRight aria-hidden="true" className="text-muted" size={13} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function InspectorAgents({ agents }: { agents: AgentView[] }) {
  return (
    <section aria-labelledby="agent-title" className="border border-border bg-surface-1 px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold" id="agent-title">
        담당 에이전트
      </h2>
      <ul className="divide-y divide-border">
        {agents.map((agent) => (
          <li className="flex min-h-10 items-center gap-2" key={agent.id}>
            <Avatar className="size-7">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-primary">{agent.name}</span>
              <span className="shrink-0 rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                {agent.role}
              </span>
            </span>
            <span
              className={
                agent.state === "active"
                  ? "flex items-center gap-1 text-[11px] text-primary"
                  : "flex items-center gap-1 text-[11px] text-muted"
              }
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${agent.state === "active" ? "bg-success" : "bg-muted"}`}
              />
              {agent.state === "active" ? "진행 중" : "대기"}
            </span>
            <CaretRight aria-hidden="true" className="text-muted" size={13} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InspectorVerifications({ values }: { values: WorkView["verifications"] }) {
  const complete = values.filter((item) => item.state === "done").length;
  return (
    <details className="border border-border bg-surface-1" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        <span>
          검증 기준{" "}
          <span className="ml-1 font-mono font-normal text-muted">
            {complete}/{values.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-muted" size={15} />
      </summary>
      <ul className="divide-y divide-border px-4 pb-2">
        {values.map((verification) => (
          <li className="py-2.5" key={verification.id}>
            <div className="flex items-center gap-2 text-xs">
              <StateIcon state={verification.state} />
              <span className="text-muted">판정</span>
              <span className="min-w-0 flex-1 truncate text-secondary">{verification.verifier}</span>
              <span className={stateClass[verification.state]}>{stateLabel[verification.state]}</span>
              <CaretRight aria-hidden="true" className="text-muted" size={13} />
            </div>
            {verification.criteria.length === 0 ? null : (
              <ul className="mt-1.5 space-y-1 pl-6">
                {verification.criteria.map((criterion) => (
                  <li className="flex items-center gap-2 text-[11px]" key={criterion.key}>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted">{criterion.key}</span>
                    <span className={criterionStatusClass[criterion.status]}>
                      {criterionStatusLabel[criterion.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {verification.evidence ? (
              <p className="mt-1 pl-6 font-mono text-[10px] text-muted">{verification.evidence}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function InspectorEmpty({ detail, icon: Icon, message }: { detail?: string; icon: typeof Briefcase; message: string }) {
  return (
    <div className="px-5 py-14 text-center">
      <Icon aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
      <p className="text-sm text-secondary">{message}</p>
      <p className="mt-1 text-xs text-muted">{detail ?? "실행이 산출물을 만들면 여기에 표시됩니다."}</p>
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
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-accent/70"
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
            <div className="min-h-[5.5rem] max-h-36 space-y-2 overflow-y-auto rounded-md border border-control bg-surface-1 p-2">
              {workspacesLoading ? (
                <div aria-label="워크스페이스 불러오는 중" className="h-14 animate-pulse rounded bg-surface-2" />
              ) : workspaces.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted">저장된 폴더가 없습니다.</p>
              ) : (
                workspaces.map((item) =>
                  item.trust === "blocked" ? (
                    <div className="rounded px-2 py-1 text-sm text-muted" key={item.workspaceId}>
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
                      className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
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
              <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
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
                  <li className="rounded bg-surface-2 px-2 py-1 font-mono text-xs" key={path}>
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
              className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-secondary outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50"
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
