import { Plus } from "@phosphor-icons/react";
import { Fragment, useEffect, useState } from "react";

import { agentIdentityToken } from "@massion/application/client";

import type { DesktopService, GrowthView, OrganizationNodeView, OrganizationView } from "@/desktop-service";
import type { ActivityView, InboxItem, TaskView, WorkView } from "@/model";
import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

const RAIL = [
  "bg-agent-0",
  "bg-agent-1",
  "bg-agent-2",
  "bg-agent-3",
  "bg-agent-4",
  "bg-agent-5",
  "bg-agent-6",
  "bg-agent-7",
] as const;
const INK = [
  "text-agent-0",
  "text-agent-1",
  "text-agent-2",
  "text-agent-3",
  "text-agent-4",
  "text-agent-5",
  "text-agent-6",
  "text-agent-7",
] as const;

const ROLE_LABEL: Readonly<Record<string, string>> = {
  orchestrator: "총괄",
  coordinator: "조율",
  operator: "실행",
};

const MESSAGE_LABEL: Readonly<Record<string, string>> = {
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

const EFFECT_LABEL: Readonly<Record<string, string>> = {
  improved: "나아짐",
  stable: "그대로",
  degraded: "나빠짐",
  inconclusive: "판단 불가",
};

const EXECUTION_MESSAGE_TYPES = new Set(["question", "answer", "evidence"]);
const EXECUTION_ACTIVITY_KINDS = new Set(["plan", "handoff", "artifacts", "roomStatus", "roomRef", "event"]);

/** 실행 마디에서 실제로 말한 비인간 주체. work.tsx의 독립성 판정과 같은 규칙입니다. */
function executionContributors(work: WorkView): ReadonlySet<string> {
  const handles = new Set<string>();
  for (const activity of work.activities) {
    if (activity.kind === "room") {
      if (EXECUTION_MESSAGE_TYPES.has(activity.messageType) && activity.speaker.human !== true) handles.add(activity.speaker.handle);
      continue;
    }
    if (!EXECUTION_ACTIVITY_KINDS.has(activity.kind)) continue;
    if (activity.kind === "handoff" && activity.from.human !== true) handles.add(activity.from.handle);
  }
  return handles;
}

type Involvement = "executed" | "verified-separate" | "verified-involved" | "none";

function workInvolvement(node: OrganizationNodeView, work: WorkView): Involvement {
  const contributors = executionContributors(work);
  const verification = work.verifications.find((candidate) => matches(node, candidate.verifier));
  const contributed = [...contributors].some((handle) => matches(node, handle));
  if (verification) return contributed ? "verified-involved" : "verified-separate";
  return contributed ? "executed" : "none";
}

type GrowthSuggestion = GrowthView["suggestions"][number];

type LedgerRow =
  | { kind: "activity"; workId: string; activity: ActivityView; time: string }
  | { kind: "growth"; workId: string; suggestion: GrowthSuggestion; time: string }
  | { kind: "task"; workId: string; task: TaskView; time: string };

function matches(node: OrganizationNodeView, candidate: string): boolean {
  const value = candidate.trim().toLowerCase();
  if (value === "") return false;
  return value === node.handle.toLowerCase() || value === agentIdentityToken(node.handle, node.role).name.toLowerCase();
}

function identityClasses(node: OrganizationNodeView): { rail: string; ink: string } {
  if (node.scope === "work") return { rail: "bg-agent-provisional", ink: "text-agent-provisional" };
  const slot = agentIdentityToken(node.handle, node.role).accentSlot;
  return { rail: RAIL[slot] ?? RAIL[0], ink: INK[slot] ?? INK[0] };
}

function StatusGlyph({ progress, status }: { progress: number; status: string }) {
  if (status === "complete") {
    return (
      <span className="grid size-[14px] shrink-0 place-items-center" aria-hidden="true">
        <span className="size-[10px] rounded-full bg-fg-3" />
      </span>
    );
  }
  const percent = Math.max(0, Math.min(100, progress));
  if (percent > 0) {
    return (
      <span
        aria-hidden="true"
        className="size-[14px] shrink-0 rounded-full border-[0.5px] border-line-strong"
        style={{ background: `conic-gradient(var(--fg-3) ${percent * 3.6}deg, transparent 0)` }}
      />
    );
  }
  return <span aria-hidden="true" className="size-[14px] shrink-0 rounded-full border-[0.5px] border-line-strong" />;
}

function VerificationGlyph({ state, criteria }: { state: string; criteria: readonly { status: string }[] }) {
  if (state === "done") {
    return (
      <span aria-hidden="true" className="grid size-[14px] shrink-0 place-items-center rounded-full border-[0.5px] border-fg-3">
        <span className="size-[7px] rounded-full bg-fg-3" />
      </span>
    );
  }
  if (state === "failed" || criteria.some((criterion) => criterion.status === "blocked" || criterion.status === "failed")) {
    return (
      <span aria-hidden="true" className="w-[14px] shrink-0 text-center text-[14px] leading-none text-halt">
        ⊘
      </span>
    );
  }
  return <span aria-hidden="true" className="size-[14px] shrink-0 rounded-full border-[0.5px] border-line-strong" />;
}

function WorkCell({ node, work, onOpenWork }: { node: OrganizationNodeView; work: WorkView; onOpenWork: (id: string) => void }) {
  const verification = work.verifications.find((candidate) => matches(node, candidate.verifier));
  const involvement = workInvolvement(node, work);
  if (involvement === "executed") {
    return (
      <button
        type="button"
        onClick={() => onOpenWork(work.id)}
        className="flex h-[30px] min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]"
      >
        <StatusGlyph progress={work.progress} status={work.status} />
        <span className="truncate text-[12px] leading-[18px] text-fg-2">실행</span>
      </button>
    );
  }
  if (involvement === "none" || !verification) return <span className="h-[30px]" aria-hidden="true" />;
  const involved = involvement === "verified-involved";
  return (
    <button
      type="button"
      onClick={() => onOpenWork(work.id)}
      className="flex h-[30px] min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]"
    >
      <VerificationGlyph state={verification.state} criteria={verification.criteria} />
      <span className="truncate text-[12px] leading-[18px] text-fg-2">판정</span>
      <span className={`ml-auto shrink-0 font-mono text-[11px] leading-4 tabular-nums ${involved ? "text-halt" : "text-fg-4"}`}>
        {involved ? "실행에도 참여함" : "실행 기여자 아님"}
      </span>
    </button>
  );
}

function OrganizationTable({
  nodes,
  works,
  onOpenWork,
}: {
  nodes: readonly OrganizationNodeView[];
  works: readonly WorkView[];
  onOpenWork: (id: string) => void;
}) {
  const visibleWorks = works.slice(0, 4);
  const attachedNodes = nodes.filter((node) =>
    works.some(
      (work) =>
        work.agents.some((agent) => matches(node, agent.id) || matches(node, agent.name)) ||
        work.verifications.some((verification) => matches(node, verification.verifier)),
    ),
  );
  const attachedNodeIds = new Set(attachedNodes.map((node) => node.id));
  const waitingNodes = nodes.filter((node) => !attachedNodeIds.has(node.id));
  const attachedColumns = `148px 64px 132px minmax(0,1fr) repeat(${visibleWorks.length},168px)`;
  const waitingColumns = "148px 64px 132px minmax(0,1fr) auto";
  return (
    <section aria-label="조직이 지금 무엇을 하고 있나" className="px-4 pt-4">
      <div className="relative">
        {visibleWorks.map((_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-[0.5px] bg-line-strong"
            style={{ right: `${(visibleWorks.length - index - 1) * 168 + 8}px` }}
          />
        ))}
        <div className="grid gap-y-[2px]" style={{ gridTemplateColumns: attachedColumns }}>
          <h2 className="flex h-8 items-center gap-2 px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
            지금 붙어 있는 곳 <span className="tabular-nums">{attachedNodes.length}</span>
          </h2>
          <span className="h-8" aria-hidden="true" />
          <span className="h-8" aria-hidden="true" />
          <span className="h-8" aria-hidden="true" />
          {visibleWorks.map((work) => (
            <button
              key={work.id}
              type="button"
              onClick={() => onOpenWork(work.id)}
              className="flex h-8 min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]"
            >
              <StatusGlyph progress={work.progress} status={work.status} />
              <span className="truncate text-[13px] font-medium leading-5 tracking-[-0.005em] text-fg-2">{work.title}</span>
            </button>
          ))}

          <span className="flex h-8 min-w-0 items-center border-b-[0.5px] border-line-strong px-2 text-[12px] leading-[18px] text-fg-4">조직</span>
          <span className="flex h-8 min-w-0 items-center border-b-[0.5px] border-line-strong px-2 text-[12px] leading-[18px] text-fg-4">역할</span>
          <span className="flex h-8 min-w-0 items-center border-b-[0.5px] border-line-strong px-2 text-[12px] leading-[18px] text-fg-4">소속</span>
          <span className="flex h-8 min-w-0 items-center border-b-[0.5px] border-line-strong px-2 text-[12px] leading-[18px] text-fg-4">책임</span>
          {visibleWorks.map((work) => (
            <span
              key={work.id}
              className={`flex h-8 min-w-0 items-center gap-2 border-b-[0.5px] border-line-strong px-2 text-[12px] leading-[18px] ${
                work.run?.status === "blocked" ? "text-halt" : "text-fg-4"
              }`}
            >
              <span className="truncate tabular-nums">{work.run?.status === "blocked" ? "막힘" : `진행 ${Math.round(work.progress)}%`}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] leading-4 tabular-nums text-fg-4">{work.updatedAt}</span>
            </span>
          ))}

          {attachedNodes.map((node) => {
            const identity = agentIdentityToken(node.handle, node.role);
            const colors = identityClasses(node);
            const parent = node.parentHandle === undefined ? undefined : nodes.find((candidate) => candidate.handle === node.parentHandle);
            const parentName = parent ? agentIdentityToken(parent.handle, parent.role).name : "";
            return (
              <Fragment key={node.id}>
                <span className="flex h-[30px] min-w-0 items-center gap-2 px-2">
                  <span aria-hidden="true" className={`h-[18px] w-[2px] shrink-0 rounded-full ${colors.rail}`} />
                  <span className={`truncate text-[13px] leading-5 tracking-[-0.005em] ${colors.ink}`}>{identity.name}</span>
                </span>
                <span className="flex h-[30px] items-center px-2 text-[12px] leading-[18px] text-fg-4">{ROLE_LABEL[node.role] ?? ""}</span>
                <span className="flex h-[30px] min-w-0 items-center px-2 text-[12px] leading-[18px] text-fg-4">{parentName}</span>
                <span className="flex h-[30px] min-w-0 items-center truncate px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
                  {node.responsibility}
                </span>
                {visibleWorks.map((work) => (
                  <WorkCell key={work.id} node={node} work={work} onOpenWork={onOpenWork} />
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-y-[2px]" style={{ gridTemplateColumns: waitingColumns }}>
        <h2 className="flex h-8 items-center gap-2 px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
          대기 중인 조직 <span className="tabular-nums">{waitingNodes.length}</span>
        </h2>
        <span className="h-8" aria-hidden="true" />
        <span className="h-8" aria-hidden="true" />
        <span className="h-8" aria-hidden="true" />
        <span className="h-8" aria-hidden="true" />
        {waitingNodes.map((node) => {
          const identity = agentIdentityToken(node.handle, node.role);
          const colors = identityClasses(node);
          const parent = node.parentHandle === undefined ? undefined : nodes.find((candidate) => candidate.handle === node.parentHandle);
          const parentName = parent ? agentIdentityToken(parent.handle, parent.role).name : "";
          return (
            <Fragment key={node.id}>
              <span className="flex h-[30px] min-w-0 items-center gap-2 px-2">
                <span aria-hidden="true" className={`h-[18px] w-[2px] shrink-0 rounded-full ${colors.rail}`} />
                <span className={`truncate text-[13px] leading-5 tracking-[-0.005em] ${colors.ink}`}>{identity.name}</span>
              </span>
              <span className="flex h-[30px] items-center px-2 text-[12px] leading-[18px] text-fg-4">{ROLE_LABEL[node.role] ?? ""}</span>
              <span className="flex h-[30px] min-w-0 items-center px-2 text-[12px] leading-[18px] text-fg-4">{parentName}</span>
              <span className="flex h-[30px] min-w-0 items-center truncate px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
                {node.responsibility}
              </span>
              <span className="flex h-[30px] min-w-0 items-center justify-end truncate px-2 text-right font-mono text-[11px] leading-4 text-fg-4">
                {node.handle}
              </span>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function findNode(nodes: readonly OrganizationNodeView[], candidate: string): OrganizationNodeView | undefined {
  return nodes.find((node) => matches(node, candidate));
}

function nameForHandle(handle: string, work: WorkView, nodes: readonly OrganizationNodeView[]): string {
  const value = handle.trim().toLowerCase();
  const agent = work.agents.find((candidate) => {
    return (
      candidate.id.trim().toLowerCase() === value ||
      candidate.name.trim().toLowerCase() === value ||
      agentIdentityToken(candidate.id, candidate.role).name.toLowerCase() === value
    );
  });
  if (agent) return agent.name;
  const node = findNode(nodes, handle);
  return node ? agentIdentityToken(node.handle, node.role).name : "";
}

function chainValue(
  work: WorkView,
  organization: OrganizationView | undefined,
  growth: GrowthView | undefined,
  nodes: readonly OrganizationNodeView[],
) {
  const verification = work.verifications[0];
  const suggestions = (growth?.suggestions ?? []).filter((suggestion) => suggestion.workId === work.id);
  const verifierNode = verification ? findNode(nodes, verification.verifier) : undefined;
  const contributors = executionContributors(work);
  const verifierInvolved = verification
    ? [...contributors].some((handle) => (verifierNode ? matches(verifierNode, handle) : handle.toLowerCase() === verification.verifier.toLowerCase()))
    : false;
  const verificationName = verifierNode ? agentIdentityToken(verifierNode.handle, verifierNode.role).name : "";
  const requester = work.activities.find(
    (activity) => activity.kind === "message" || (activity.kind === "room" && activity.speaker.human === true),
  );
  const requestName = requester?.kind === "message" ? requester.author : requester?.kind === "room" ? requester.speaker.name : "";
  const orchestrator = nodes.find((node) => node.role === "orchestrator");
  const orchestratorIdentity = orchestrator ? agentIdentityToken(orchestrator.handle, orchestrator.role) : undefined;
  const executionNames = [...contributors].map((handle) => nameForHandle(handle, work, nodes)).filter(Boolean);
  const criterionMeta = verification
    ? [
        verification.criteria.length > 0 ? `기준 ${verification.criteria.length}` : "",
        ...(["passed", "failed", "blocked", "excluded"] as const).map((status) => {
          const count = verification.criteria.filter((criterion) => criterion.status === status).length;
          return count > 0 ? `${status === "passed" ? "통과" : status === "failed" ? "미통과" : status === "blocked" ? "막힘" : "제외"} ${count}` : "";
        }),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const effectSuggestionId = suggestions[0]?.suggestionId;
  const effect = effectSuggestionId
    ? growth?.effects.find((candidate) => candidate.suggestionId === effectSuggestionId)
    : undefined;
  const rows = [
    { label: "요청", subject: requestName, subjectSlot: "text-fg-3", value: work.summary, meta: `rev ${work.revision}`, valueSlot: "text-fg-2" },
    {
      label: "배치",
      subject: orchestratorIdentity?.name ?? "",
      subjectSlot: orchestrator ? identityClasses(orchestrator).ink : "",
      value: work.agents.map((agent) => agent.name).filter(Boolean).join(" · "),
      meta: [organization?.version === undefined ? "" : `조직 v${organization.version}`, `${work.agents.length}명`].filter(Boolean).join(" · "),
      valueSlot: "text-fg-2",
    },
    {
      label: "실행",
      subject: "",
      subjectSlot: "",
      value: executionNames.join(" · "),
      meta: work.tasks.length > 0 ? `작업 ${work.tasks.filter((task) => task.state === "done").length} / ${work.tasks.length}` : "",
      valueSlot: "text-fg-2",
    },
    {
      label: "판정",
      subject: verificationName,
      subjectSlot: verifierNode ? identityClasses(verifierNode).ink : "",
      value: verification ? (verifierInvolved ? "실행에도 참여함" : "실행 기여자 아님") : "",
      meta: criterionMeta,
      valueSlot: verifierInvolved ? "text-halt" : "text-fg-2",
    },
    {
      label: "개선",
      subject: suggestions.length > 0 ? agentIdentityToken("growth", "operator").name : "",
      subjectSlot: suggestions.length > 0 ? (INK[agentIdentityToken("growth", "operator").accentSlot] ?? INK[0]) : "",
      value: suggestions.map((suggestion) => suggestion.summary).join(" · "),
      meta: suggestions.length > 0 ? `${suggestions.length}건` : "",
      valueSlot: "text-fg-2",
    },
    { label: "효과", subject: "", subjectSlot: "", value: effect ? EFFECT_LABEL[effect.result] ?? "" : "", meta: "", valueSlot: "text-fg-2" },
  ] as const;
  return rows.filter((row) => row.label !== "효과" || row.subject !== "" || row.value !== "" || row.meta !== "");
}

function ChainSection({ work, organization, growth, nodes }: { work: WorkView; organization: OrganizationView | undefined; growth: GrowthView | undefined; nodes: readonly OrganizationNodeView[] }) {
  const rows = chainValue(work, organization, growth, nodes);
  return (
    <section aria-label="사슬" className="px-4 pb-4 pt-4">
      <h2 className="flex h-8 items-center gap-2 px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
        사슬 · <span className="text-fg-2">{work.title}</span>
      </h2>
      <div className="grid gap-y-[2px]">
        {rows.map((row, index) => (
          <div key={row.label} className="grid h-[30px] min-w-0 items-center px-2" style={{ gridTemplateColumns: "344px minmax(0,1fr) auto" }}>
            <span className="flex min-w-0 items-center gap-2">
              {row.label === "판정" && work.verifications[0] ? (
                <VerificationGlyph state={work.verifications[0].state} criteria={work.verifications[0].criteria} />
              ) : row.value ? (
                <span aria-hidden="true" className="grid size-[14px] shrink-0 place-items-center">
                  <span className="size-[10px] rounded-full bg-fg-3" />
                </span>
              ) : (
                <span aria-hidden="true" className="size-[14px] shrink-0 rounded-full border-[0.5px] border-line-strong" />
              )}
              <span className="shrink-0 font-mono text-[11px] leading-4 tabular-nums text-fg-4">{index + 1}</span>
              <span className="shrink-0 text-[12px] leading-[18px] text-fg-4">{row.label}</span>
              {row.subject ? <span className={`ml-auto min-w-0 truncate text-right text-[12px] leading-[18px] ${row.subjectSlot}`}>{row.subject}</span> : null}
            </span>
            <span className={`min-w-0 truncate text-[13px] leading-5 tracking-[-0.005em] ${row.valueSlot}`}>{row.value}</span>
            {row.meta ? <span className="shrink-0 text-right font-mono text-[11px] leading-4 tabular-nums text-fg-4">{row.meta}</span> : <span aria-hidden="true" />}
          </div>
        ))}
      </div>
    </section>
  );
}

function growthTime(createdAt?: string): string {
  if (!createdAt) return "";
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toTimeString().slice(0, 5);
}

const isClockTime = (time: string): boolean => /^\d{2}:\d{2}$/.test(time);

function ledgerRows(works: readonly WorkView[], growth: GrowthView | undefined): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const work of works) {
    const workRows: LedgerRow[] = [
      ...work.activities
        .filter((activity) => activity.kind !== "roomStatus")
        .map((activity) => ({ kind: "activity" as const, workId: work.id, activity, time: activity.time })),
      ...work.tasks
        .filter((task) => task.time && (task.state === "done" || task.state === "active"))
        .map((task) => ({ kind: "task" as const, workId: work.id, task, time: task.time as string })),
    ];
    rows.push(
      ...workRows.filter((row) => isClockTime(row.time)).sort((left, right) => right.time.localeCompare(left.time)),
      ...workRows.filter((row) => !isClockTime(row.time)),
    );
  }
  const growthSuggestions = (growth?.suggestions ?? [])
    .filter((suggestion) => suggestion.createdAt)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  for (const suggestion of growthSuggestions) {
    rows.push({ kind: "growth", workId: suggestion.workId, suggestion, time: growthTime(suggestion.createdAt) });
  }
  return rows;
}

function speakerStyle(speaker: { accentSlot: number; human?: boolean; name: string }): { rail: string; ink: string; name: string } {
  if (speaker.human || speaker.accentSlot < 0) return { rail: "bg-fg-4", ink: "text-fg-3", name: speaker.name };
  return { rail: RAIL[speaker.accentSlot] ?? RAIL[0], ink: INK[speaker.accentSlot] ?? INK[0], name: speaker.name };
}

function activityPresentation(activity: ActivityView): { action: string; meta: string; name: string; rail: string; ink: string; door: boolean } {
  if (activity.kind === "room") {
    const style = speakerStyle(activity.speaker);
    const meta = activity.evidence?.checksum
      ? activity.evidence.checksum
      : activity.signature
        ? `rev ${activity.signature.revision}`
        : activity.recipient
          ? `→ ${activity.recipient}`
          : "";
    return { action: MESSAGE_LABEL[activity.messageType] ?? "", meta, name: style.name, rail: style.rail, ink: style.ink, door: true };
  }
  if (activity.kind === "proposal") {
    const style = speakerStyle(activity.speaker);
    return {
      action: "제안",
      meta: `v${activity.change.fromVersion}→${activity.change.toVersion}`,
      name: style.name,
      rail: style.rail,
      ink: style.ink,
      door: true,
    };
  }
  if (activity.kind === "handoff") {
    const style = speakerStyle(activity.from);
    return { action: "인계", meta: activity.to ? `→ ${activity.to.name}` : "", name: style.name, rail: style.rail, ink: style.ink, door: true };
  }
  if (activity.kind === "approval") return { action: "승인 요청", meta: "", name: "", rail: "bg-gate", ink: "text-gate", door: true };
  if (activity.kind === "plan") return { action: "계획", meta: `단계 ${activity.steps.length}`, name: "", rail: "bg-fg-4", ink: "text-fg-3", door: true };
  if (activity.kind === "artifacts") return { action: "산출물", meta: String(activity.artifacts.length), name: "", rail: "bg-fg-4", ink: "text-fg-3", door: true };
  if (activity.kind === "agents") return { action: "편성", meta: String(activity.agents.length), name: "", rail: "bg-fg-4", ink: "text-fg-3", door: true };
  if (activity.kind === "message") return { action: "발언", meta: "", name: activity.author, rail: "bg-fg-4", ink: "text-fg-3", door: true };
  if (activity.kind === "event") return { action: activity.title, meta: activity.status, name: "", rail: "bg-fg-4", ink: "text-fg-3", door: true };
  if (activity.kind === "chapter") return { action: `${activity.label} 마디`, meta: "", name: "", rail: "bg-fg-4", ink: "text-fg-3", door: false };
  if (activity.kind === "roomRef") return { action: `분기 · ${activity.name}`, meta: String(activity.messageCount), name: "", rail: "bg-fg-4", ink: "text-fg-3", door: true };
  return { action: "방 상태", meta: "", name: "", rail: "bg-fg-4", ink: "text-fg-3", door: false };
}

function LedgerRowView({ row, previousTime, onOpenWork }: { row: LedgerRow; previousTime: string; onOpenWork: (id: string) => void }) {
  const time = row.time !== previousTime ? row.time : "";
  if (row.kind === "growth") {
    const style = speakerStyle({ accentSlot: 7, name: agentIdentityToken("growth", "operator").name });
    const content = `${row.suggestion.summary}`;
    return (
      <button type="button" onClick={() => onOpenWork(row.workId)} className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]">
        <time className="w-[34px] shrink-0 text-right font-mono text-[11px] leading-4 tabular-nums text-fg-4">{time}</time>
        <span aria-hidden="true" className={`h-[18px] w-[2px] shrink-0 rounded-full ${style.rail}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-[-0.005em]">
          <span className={style.ink}>{style.name} </span>
          <span className="text-fg-2">개선 제안 {content}</span>
        </span>
        {row.suggestion.revision === undefined ? null : <span className="shrink-0 font-mono text-[11px] leading-4 tabular-nums text-fg-4">rev {row.suggestion.revision}</span>}
        <span aria-hidden="true" className="shrink-0 text-[13px] leading-5 text-fg-4">›</span>
      </button>
    );
  }

  if (row.kind === "task") {
    return (
      <button type="button" onClick={() => onOpenWork(row.workId)} className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]">
        <LedgerRowContent
          time={time}
          presentation={{
            action: `${row.task.title} ${row.task.state === "done" ? "완료" : "진행"}`,
            meta: "",
            name: "",
            rail: "bg-fg-4",
            ink: "text-fg-3",
            door: true,
          }}
        />
      </button>
    );
  }

  const presentation = activityPresentation(row.activity);
  const content = presentation.door ? (
    <button type="button" onClick={() => onOpenWork(row.workId)} className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]">
      <LedgerRowContent time={time} presentation={presentation} />
    </button>
  ) : (
    <div className="flex h-[30px] w-full min-w-0 items-center gap-2 px-2">
      <LedgerRowContent time={time} presentation={presentation} />
    </div>
  );
  return content;
}

function LedgerRowContent({ time, presentation }: { time: string; presentation: ReturnType<typeof activityPresentation> }) {
  return (
    <>
      <time className="w-[34px] shrink-0 text-right font-mono text-[11px] leading-4 tabular-nums text-fg-4">{time}</time>
      <span aria-hidden="true" className={`h-[18px] w-[2px] shrink-0 rounded-full ${presentation.rail}`} />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-[-0.005em]">
        {presentation.name ? <span className={presentation.ink}>{presentation.name} </span> : null}
        <span className="text-fg-2">{presentation.action}</span>
      </span>
      {presentation.meta ? <span className="shrink-0 font-mono text-[11px] leading-4 tabular-nums text-fg-4">{presentation.meta}</span> : null}
      {presentation.door ? <span aria-hidden="true" className="shrink-0 text-[13px] leading-5 text-fg-4">›</span> : null}
    </>
  );
}

function Ledger({ works, growth, onOpenWork }: { works: readonly WorkView[]; growth: GrowthView | undefined; onOpenWork: (id: string) => void }) {
  const rows = ledgerRows(works, growth);
  let previousTime = "";
  return (
    <aside aria-label="원장" className="flex min-h-0 flex-col overflow-hidden border-l-[0.5px] border-line-strong bg-bg-1 max-[1359px]:hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-line-strong px-4">
        <h2 className="text-[15px] font-semibold leading-6 tracking-[-0.008em] text-fg">원장</h2>
        <span className="ml-auto font-mono text-[11px] leading-4 tabular-nums text-fg-4">{rows.length}</span>
      </header>
      <ul className="grid min-h-0 flex-1 auto-rows-[30px] grid-cols-[minmax(0,1fr)] content-start gap-[2px] overflow-y-auto px-2 py-2">
        {rows.map((row, index) => {
          const rendered = <LedgerRowView key={`${row.kind}-${index}`} row={row} previousTime={previousTime} onOpenWork={onOpenWork} />;
          previousTime = row.time;
          return rendered;
        })}
      </ul>
    </aside>
  );
}

export function HomeSurface({
  inboxItems,
  onCreate,
  onOpenNotifications,
  onOpenWork,
  service,
}: {
  inboxItems: InboxItem[] | undefined;
  onCreate: () => void;
  onOpenNotifications: () => void;
  onOpenWork: (workId: string) => void;
  service: DesktopService;
}) {
  const [works, setWorks] = useState<WorkView[]>();
  const [organization, setOrganization] = useState<OrganizationView>();
  const [growth, setGrowth] = useState<GrowthView>();
  const [workError, setWorkError] = useState("");
  const [organizationError, setOrganizationError] = useState("");
  const [growthError, setGrowthError] = useState("");

  useEffect(() => {
    let disposed = false;
    void service
      .loadIndex({ filter: "active", search: "" })
      .then((value) => {
        if (!disposed) setWorks(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setWorkError(surfaceErrorMessage(cause, "현황을 불러오지 못했습니다."));
      });
    void service
      .loadOrganization()
      .then((value) => {
        if (!disposed) setOrganization(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setOrganizationError(surfaceErrorMessage(cause, "조직 정보를 불러오지 못했습니다."));
      });
    void service
      .loadGrowth()
      .then((value) => {
        if (!disposed) setGrowth(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setGrowthError(surfaceErrorMessage(cause, "개선 제안을 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  const loadedCount = Number(works !== undefined) + Number(organization !== undefined) + Number(growth !== undefined);
  const allWorks = works ?? [];
  const nodes = organization?.nodes ?? [];
  const waiting = inboxItems ?? [];
  const errorMessages = [workError, organizationError, growthError].filter(Boolean);

  return (
    <main
      aria-label="홈"
      className="col-span-3 grid min-h-0 grid-cols-[minmax(0,1fr)_320px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas max-[1359px]:grid-cols-[minmax(0,1fr)]"
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-line-strong px-6">
          <h1 className="text-[15px] font-semibold leading-6 tracking-[-0.008em] text-fg">홈</h1>
          {organization?.version === undefined ? null : (
            <span className="font-mono text-[11px] leading-4 tabular-nums text-fg-4">v{organization.version} · 노드 {nodes.length}</span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onCreate} className="flex h-[30px] items-center gap-2 rounded-[4px] px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-2 transition-colors duration-100 hover:bg-white/[0.027]">
            <Plus aria-hidden="true" size={14} />
            맡길 일을 한 줄로 씁니다
            <span className="font-mono text-[11px] leading-4 text-fg-4">⌘N</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {errorMessages.map((message) => <SurfaceError key={message} message={message} />)}
          {loadedCount === 0 ? <SurfaceLoading /> : null}

          {loadedCount > 0 ? <>
          <section aria-label="나를 기다리는 것">
            <h2 className="flex h-8 items-center gap-2 px-6 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
              나를 기다리는 것 {inboxItems === undefined ? null : <span className="tabular-nums">{waiting.length}</span>}
            </h2>
            {inboxItems !== undefined && waiting.length === 0 ? (
              <div className="px-4">
                <p className="flex h-[30px] items-center px-2 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">지금 사람을 기다리는 항목이 없습니다</p>
              </div>
            ) : (
              <ul className="grid gap-[2px] px-4">
                {waiting.map((item) => {
                  const approval = item.kind === "approval";
                  const growthItem = item.kind === "growth";
                  const title = approval ? item.approval.title : item.title;
                  const description = approval ? item.approval.description : item.reason;
                  const category = approval ? "승인" : growthItem ? "검토" : "막힘";
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={approval || growthItem ? onOpenNotifications : () => onOpenWork(item.workId)}
                        className="flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-100 hover:bg-white/[0.027]"
                      >
                        <span aria-hidden="true" className={`h-[18px] w-[2px] shrink-0 rounded-full ${approval || growthItem ? "bg-gate" : "bg-halt"}`} />
                        <span aria-hidden="true" className={`w-[14px] shrink-0 text-center text-[14px] leading-none ${approval || growthItem ? "text-gate" : "text-halt"}`}>
                          {approval || growthItem ? "◇" : "⊘"}
                        </span>
                        <span className="shrink-0 truncate text-[13px] font-medium leading-5 tracking-[-0.005em] text-fg-2">{title}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-[-0.005em] text-fg-4">{description}</span>
                        <span className="shrink-0 text-[12px] leading-[18px] text-fg-4">{category}</span>
                        <span aria-hidden="true" className="shrink-0 text-[13px] leading-5 text-fg-4">›</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {allWorks[0] ? <ChainSection work={allWorks[0]} organization={organization} growth={growth} nodes={nodes} /> : null}
          {organization ? <OrganizationTable nodes={nodes} works={allWorks} onOpenWork={onOpenWork} /> : null}
          </> : null}
        </div>
      </div>
      <Ledger works={allWorks} growth={growth} onOpenWork={onOpenWork} />
    </main>
  );
}
