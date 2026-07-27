import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopService, OrganizationNodeView, OrganizationView } from "@/desktop-service";
import { agentIdentityToken } from "@massion/application/client";
import type { ActivityView, VerificationView, WorkView } from "@/model";
import { SurfaceError, surfaceErrorMessage } from "@/ui/surface";

type WorkRelation = "execution" | "judgment";

interface WorkHistoryEntry {
  work: WorkView;
  relation: WorkRelation;
}

interface LedgerEvent {
  id: string;
  time: string;
  body: string;
  meta: string;
  subject?: OrganizationNodeView;
  targetHandle?: string;
  human?: boolean;
}

const ROOM_MESSAGE_LABELS: Readonly<Record<string, string>> = {
  question: "질문",
  answer: "답변",
  evidence: "근거",
  challenge: "반론",
  change_request: "변경 요청",
  decision: "결정",
  review_request: "검토 요청",
};

export function OrganizationSurface({ service }: { service: DesktopService }) {
  const [organization, setOrganization] = useState<OrganizationView>();
  const [works, setWorks] = useState<WorkView[]>([]);
  const [selectedHandle, setSelectedHandle] = useState<string>();
  const [error, setError] = useState("");
  const structureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [org, active, complete] = await Promise.all([
          service.loadOrganization(),
          service.loadIndex({ filter: "active", search: "" }),
          service.loadIndex({ filter: "complete", search: "" }),
        ]);
        const summaries = [...active, ...complete].slice(0, 8);
        const loadedWorks = await Promise.all(
          summaries.map((summary) => service.loadWork(summary.id).catch(() => summary)),
        );
        if (!disposed) {
          setOrganization(org);
          setWorks(loadedWorks);
        }
      } catch (cause: unknown) {
        if (!disposed) setError(surfaceErrorMessage(cause, "조직 정보를 불러오지 못했습니다."));
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [service]);

  const nodes = organization?.nodes ?? [];
  const root = nodes.find((node) => node.parentHandle === undefined);
  const workTeams = nodes.filter((node) => node.scope === "work");

  useEffect(() => {
    if (!root) return;
    if (!selectedHandle || !nodes.some((node) => node.handle === selectedHandle)) setSelectedHandle(root.handle);
  }, [nodes, root, selectedHandle]);

  const selected = nodes.find((node) => node.handle === selectedHandle) ?? root;
  const descendants = useMemo(() => (selected ? descendantsOf(selected, nodes) : []), [nodes, selected]);
  const selectedWorkHistory = useMemo(() => (selected ? workHistoryFor(selected, works) : []), [selected, works]);
  const selectedVerifications = useMemo(
    () => (selected ? verificationsFor(descendants, works) : []),
    [descendants, selected, works],
  );
  const ledgerEvents = useMemo(
    () => (selected ? ledgerEventsFor(descendants, nodes, works, selectedWorkHistory) : []),
    [descendants, nodes, selected, selectedWorkHistory, works],
  );
  const orphanAgents = useMemo(() => agentsOutsideOrganization(works, nodes), [nodes, works]);

  useEffect(() => {
    if (!selectedHandle) return;
    const target = Array.from(structureRef.current?.querySelectorAll<HTMLElement>("[data-node]") ?? []).find(
      (element) => element.dataset.node === selectedHandle,
    );
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedHandle]);

  const select = (handle: string) => {
    setSelectedHandle(handle);
  };

  return (
    <main aria-label="조직" className="col-span-3 grid min-h-0 min-w-0 grid-cols-[340px_minmax(0,1fr)_320px] bg-bg-0">
      <section aria-label="조직 구조" className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] bg-bg-1">
        <header className="flex h-12 items-center gap-2 border-b border-line-strong px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.008em] text-fg-2">조직</h1>
          {organization?.version === undefined ? null : (
            <span className="font-mono text-[11px] text-fg-4">v{organization.version}</span>
          )}
        </header>
        <div ref={structureRef} className="min-h-0 overflow-y-auto px-2 py-3">
          {error ? <SurfaceError message={error} /> : null}
          {!organization && !error ? <p className="px-2 text-[13px] text-fg-3">불러오는 중입니다.</p> : null}
          {organization && nodes.length === 0 ? (
            <p className="px-2 text-[13px] text-fg-3">조직에 아직 자리가 없습니다.</p>
          ) : null}
          {root ? (
            <>
              <p className="flex h-6 items-center px-2 text-[12px] text-fg-4">영속 조직</p>
              <div className="space-y-0.5">
                {nodes
                  .filter((node) => node.scope !== "work")
                  .map((node) => (
                    <OrganizationRow
                      key={node.handle}
                      node={node}
                      depth={depthOf(node, nodes)}
                      selected={node.handle === selected?.handle}
                      involvementCount={involvementCount(node, works)}
                      hasChildren={hasChildren(node, nodes)}
                      onSelect={select}
                    />
                  ))}
              </div>
              {workTeams.length > 0 ? (
                <>
                  <p className="mt-4 flex h-6 items-center px-2 text-[12px] text-fg-4">임시 편성 {workTeams.length}</p>
                  <div className="space-y-0.5">
                    {workTeams.map((node) => (
                      <OrganizationRow
                        key={node.handle}
                        node={node}
                        depth={depthOf(node, nodes)}
                        selected={node.handle === selected?.handle}
                        involvementCount={involvementCount(node, works)}
                        hasChildren={hasChildren(node, nodes)}
                        onSelect={select}
                      />
                    ))}
                  </div>
                </>
              ) : null}
              {orphanAgents.length > 0 ? (
                <>
                  <p className="mt-4 flex h-6 items-center px-2 text-[12px] text-fg-4">
                    조직 그래프에 없는 실행자 {orphanAgents.length}
                  </p>
                  <div className="space-y-0.5">
                    {orphanAgents.map((agent) => (
                      <div key={agent.id} className="flex h-[30px] w-full items-center gap-2 rounded px-2">
                        <span
                          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center"
                          aria-hidden="true"
                        >
                          <span
                            className="h-[6px] w-[6px]"
                            style={{
                              boxSizing: "border-box",
                              border: "1px dashed var(--agent-provisional)",
                              backgroundColor: "transparent",
                            }}
                          />
                        </span>
                        <span className="min-w-0 truncate text-[13px] text-fg-2">{agent.name}</span>
                        <span className="shrink-0 text-[12px] text-fg-4">{agent.role}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-[12px] text-fg-4">
                          관여 {agent.involvement}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <section
        aria-label="자리"
        className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-l border-line-strong bg-bg-0"
      >
        <header className="flex h-12 items-center gap-2 border-b border-line-strong px-3">
          {selected ? <NodeMarker node={selected} hasChildren={hasChildren(selected, nodes)} /> : null}
          {selected ? (
            <>
              <h2 className="text-[17px] font-semibold tracking-[-0.012em] text-fg">
                {agentIdentityToken(selected.handle).name}
              </h2>
              <span className="text-[13px] text-fg-3">{nodeRoleTextOf(selected.role)}</span>
              <StatusGlyph kind={nodeStatusGlyph(selected.status)} />
              <span className="ml-auto font-mono text-[11px] text-fg-4">{selected.handle}</span>
            </>
          ) : (
            <h2 className="text-[15px] font-semibold tracking-[-0.008em] text-fg-2">자리</h2>
          )}
        </header>
        <div className="min-h-0 overflow-y-auto px-3 pb-6">
          {selected ? (
            <NodeDetail
              node={selected}
              nodes={nodes}
              history={selectedWorkHistory}
              verifications={selectedVerifications}
              onSelect={select}
            />
          ) : (
            <p className="mt-4 text-[13px] text-fg-3">조직에 선택할 자리가 없습니다.</p>
          )}
        </div>
      </section>

      <aside
        aria-label="원장"
        className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-l border-line-strong bg-bg-1"
      >
        <header className="flex h-12 items-center gap-2 border-b border-line-strong px-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.008em] text-fg-2">원장</h2>
          {selected ? (
            <span className="ml-auto text-[12px] text-fg-4">
              {descendants.length > 1 ? `이 자리와 아래 ${String(descendants.length - 1)}` : "이 자리"}
            </span>
          ) : null}
        </header>
        <div className="min-h-0 overflow-y-auto px-2 py-3">
          {selected && ledgerEvents.length > 0 ? (
            <div className="space-y-0.5">
              {ledgerEvents.map((event, index) => (
                <LedgerRow
                  key={event.id}
                  event={event}
                  previousTime={ledgerEvents[index - 1]?.time}
                  onSelect={select}
                />
              ))}
            </div>
          ) : selected ? (
            <p className="px-2 text-[13px] text-fg-3">이 자리에 아직 쌓인 사건이 없습니다.</p>
          ) : null}
        </div>
      </aside>
    </main>
  );
}

function OrganizationRow({
  node,
  depth,
  selected,
  involvementCount: count,
  hasChildren: childExists,
  onSelect,
}: {
  node: OrganizationNodeView;
  depth: number;
  selected: boolean;
  involvementCount: number;
  hasChildren: boolean;
  onSelect: (handle: string) => void;
}) {
  const identity = agentIdentityToken(node.handle, roleTextOf(node));
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-node={node.handle}
      onClick={() => {
        onSelect(node.handle);
      }}
      className={`flex h-[30px] w-full items-center gap-2 rounded px-2 text-left transition-[background-color] duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)] ${selected ? "bg-[rgb(255_255_255_/_0.047)]" : "hover:bg-[rgb(255_255_255_/_0.027)]"}`}
      style={{ paddingLeft: 8 + depth * 20 }}
    >
      <NodeMarker node={node} hasChildren={childExists} />
      <span className={`min-w-0 truncate text-[13px] ${selected ? "text-fg" : "text-fg-2"}`}>{identity.name}</span>
      <span className="shrink-0 text-[12px] text-fg-4">{nodeRoleTextOf(node.role)}</span>
      {node.scope === "work" ? <span className="shrink-0 text-[12px] text-fg-4">임시</span> : null}
      {count > 0 ? <span className="ml-auto shrink-0 tabular-nums text-[12px] text-fg-4">{count}</span> : null}
    </button>
  );
}

function NodeMarker({ node, hasChildren }: { node: OrganizationNodeView; hasChildren: boolean }) {
  const identity = agentIdentityToken(node.handle);
  if (node.scope === "work") {
    return (
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden="true">
        <span className="h-1 w-1" style={{ boxSizing: "border-box", border: "1px solid var(--agent-provisional)" }} />
      </span>
    );
  }
  if (node.role === "orchestrator" || node.role === "coordinator" || hasChildren) {
    const accent = accentColor(identity.accentSlot);
    return (
      <span
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded"
        aria-hidden="true"
        style={{
          backgroundColor: `color-mix(in srgb, ${accent} 22%, transparent)`,
          border: `1px solid ${accent}`,
        }}
      >
        <span className="text-[11px] leading-none text-fg-2">{identity.initial}</span>
      </span>
    );
  }
  return (
    <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden="true">
      <span className="h-1 w-1" style={{ backgroundColor: accentColor(identity.accentSlot) }} />
    </span>
  );
}

function NodeDetail({
  node,
  nodes,
  history,
  verifications,
  onSelect,
}: {
  node: OrganizationNodeView;
  nodes: readonly OrganizationNodeView[];
  history: readonly WorkHistoryEntry[];
  verifications: readonly { work: WorkView; verification: VerificationView }[];
  onSelect: (handle: string) => void;
}) {
  const parent = node.parentHandle ? nodes.find((candidate) => candidate.handle === node.parentHandle) : undefined;
  const children = nodes.filter((candidate) => candidate.parentHandle === node.handle);
  const siblings = node.parentHandle
    ? nodes.filter((candidate) => candidate.parentHandle === node.parentHandle && candidate.handle !== node.handle)
    : [];
  const related = [
    ...(parent ? [{ node: parent, relation: "위" }] : []),
    ...siblings.map((candidate) => ({ node: candidate, relation: "같은 층" })),
    ...children.map((candidate) => ({ node: candidate, relation: "아래" })),
  ];
  const lineage = lineageOf(node, nodes);
  const extras = extraCapabilitiesOf(node);

  return (
    <>
      <DetailSectionHeader label="자리" />
      <div className="space-y-0.5">
        {lineage.length > 1 ? (
          <DefinitionRow label="계보">
            <span className="flex min-w-0 items-center gap-1 truncate">
              {lineage.map((ancestor, index) => (
                <span key={ancestor.handle} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <span className="text-[12px] text-fg-4">›</span> : null}
                  <button
                    type="button"
                    aria-pressed={ancestor.handle === node.handle}
                    onClick={() => {
                      onSelect(ancestor.handle);
                    }}
                    className="truncate text-[13px] text-fg-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]"
                  >
                    {agentIdentityToken(ancestor.handle).name}
                  </button>
                </span>
              ))}
            </span>
          </DefinitionRow>
        ) : null}
        <DefinitionRow label="직책">{nodeRoleTextOf(node.role)}</DefinitionRow>
        {node.scope ? <DefinitionRow label="범위">{scopeTextOf(node.scope)}</DefinitionRow> : null}
        <DefinitionRow label="상태">{nodeStatusLabel(node.status)}</DefinitionRow>
        <DefinitionRow label="책임" valueClassName="line-clamp-1">
          {node.responsibility}
        </DefinitionRow>
        {extras.length > 0 ? <DefinitionRow label="역량">{extras.join(" · ")}</DefinitionRow> : null}
      </div>

      {history.length > 0 ? (
        <>
          <DetailSectionHeader label="이 자리가 걸어온 업무" count={history.length} />
          <div className="space-y-0.5">
            {history.map((entry, index) => (
              <div
                key={`${entry.work.id}-${entry.relation}-${String(index)}`}
                className="grid h-[30px] grid-cols-[20px_minmax(0,1fr)_auto_52px] items-center gap-2 rounded px-2"
              >
                <StatusGlyph kind={workStatusGlyph(entry.work)} />
                <span className="min-w-0 truncate text-[13px] text-fg-2">{entry.work.title}</span>
                <span className="text-[12px] text-fg-4">{entry.relation === "execution" ? "실행 배치" : "판정"}</span>
                <span className="font-mono text-right text-[11px] tabular-nums text-fg-4">{entry.work.updatedAt}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {verifications.length > 0 ? (
        <>
          <DetailSectionHeader
            label={
              verifications.some(
                ({ verification }) =>
                  !verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name),
              )
                ? "이 자리와 아래에서 이뤄진 판정"
                : "판정"
            }
            count={verifications.length}
          />
          <div className="space-y-0.5">
            {verifications.map(({ work, verification }) => (
              <VerificationBlock
                key={`${work.id}-${verification.id}`}
                nodes={nodes}
                work={work}
                verification={verification}
              />
            ))}
          </div>
        </>
      ) : null}

      {related.length > 0 ? (
        <>
          <DetailSectionHeader label="이어진 자리" count={related.length} />
          <div className="space-y-0.5">
            {related.map(({ node: relatedNode, relation }) => (
              <button
                key={relatedNode.handle}
                type="button"
                aria-pressed={relatedNode.handle === node.handle}
                onClick={() => {
                  onSelect(relatedNode.handle);
                }}
                className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded px-2 text-left transition-[background-color] duration-150 hover:bg-[rgb(255_255_255_/_0.027)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]"
              >
                <NodeMarker node={relatedNode} hasChildren={hasChildren(relatedNode, nodes)} />
                <span className="min-w-0 truncate text-[13px] text-fg-2">
                  {agentIdentityToken(relatedNode.handle).name}
                </span>
                <span className="shrink-0 text-[12px] text-fg-4">{relation}</span>
                <span className="shrink-0 text-[12px] text-fg-4">{nodeRoleTextOf(relatedNode.role)}</span>
                <span className="ml-auto min-w-0 truncate text-[12px] text-fg-4">{relatedNode.responsibility}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function VerificationBlock({
  nodes,
  work,
  verification,
}: {
  nodes: readonly OrganizationNodeView[];
  work: WorkView;
  verification: VerificationView;
}) {
  const counts = criterionCounts(verification);
  const contributors = work.agents.map((agent) => agent.name).filter(Boolean);
  const separated = !work.agents.some((agent) => verifierMatches(verification.verifier, agent.id, agent.name));
  const verifierNode = nodes.find((node) =>
    verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name),
  );
  const verifier = agentIdentityToken(verifierNode?.handle ?? verification.verifier);
  const verificationGlyph = verificationGlyphFor(verification);
  return (
    <div className="space-y-0.5">
      <div className="flex h-[30px] items-center gap-2 rounded px-2">
        <span
          aria-label={verificationGlyph.label}
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center text-[14px] ${verificationGlyph.className}`}
        >
          {verificationGlyph.symbol}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{work.title}</span>
        <span className="flex min-w-0 shrink-0 items-center gap-1 text-[12px] text-fg-3">
          <span
            className="h-1 w-1 shrink-0"
            aria-hidden="true"
            style={{ backgroundColor: accentColor(verifier.accentSlot) }}
          />
          <span className="max-w-[104px] truncate">{verifier.name}</span>
        </span>
        <span className="shrink-0 tabular-nums text-[12px] text-fg-4">
          {[
            counts.passed > 0 ? `통과 ${String(counts.passed)}` : "",
            counts.failed > 0 ? `미통과 ${String(counts.failed)}` : "",
            counts.blocked > 0 ? `막힘 ${String(counts.blocked)}` : "",
            counts.excluded > 0 ? `제외 ${String(counts.excluded)}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {verification.criteria.map((criterion) => (
        <div
          key={criterion.key}
          className="grid h-[30px] grid-cols-[20px_132px_minmax(0,1fr)] items-center gap-2 rounded px-2"
        >
          <CriterionGlyph status={criterion.status} />
          <span className="font-mono text-[11px] text-fg-3">{criterion.key}</span>
          <span className="text-[12px] text-fg-2">{criterionStatusLabel(criterion.status)}</span>
        </div>
      ))}
      {verification.evidence ? (
        <div className="grid h-[30px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2 rounded px-2">
          <span className="text-[12px] text-fg-4">근거</span>
          <span className="min-w-0 truncate text-[13px] text-fg-2">{verification.evidence}</span>
        </div>
      ) : null}
      {contributors.length > 0 ? (
        <div className="grid h-[30px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2 rounded px-2">
          <span className="text-[12px] text-fg-4">실행 기여자</span>
          <span className="min-w-0 truncate text-[13px] text-fg-2">
            {contributors.join(" · ")}
            {separated ? <span className="text-fg-4"> · 판정자와 분리됨</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function DefinitionRow({
  label,
  children,
  valueClassName = "",
}: {
  label: string;
  children: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid h-[30px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2 rounded px-2">
      <span className="text-[12px] text-fg-4">{label}</span>
      <span className={`min-w-0 truncate text-[13px] text-fg-2 ${valueClassName}`}>{children}</span>
    </div>
  );
}

function DetailSectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <p className="mt-4 flex h-6 items-center px-2 text-[12px] text-fg-4">
      {label}
      {count === undefined ? null : <span className="ml-1 tabular-nums">{count}</span>}
    </p>
  );
}

function LedgerRow({
  event,
  previousTime,
  onSelect,
}: {
  event: LedgerEvent;
  previousTime: string | undefined;
  onSelect: (handle: string) => void;
}) {
  const time = event.time === previousTime ? "" : event.time;
  const content = (
    <>
      <span className="font-mono text-right text-[11px] tabular-nums text-fg-4">{time}</span>
      <span className="flex items-center justify-center" aria-hidden="true">
        {event.human ? (
          <span className="h-[6px] w-[6px] rounded-full bg-fg-4" />
        ) : (
          <span
            className="h-1 w-1"
            style={{ backgroundColor: event.subject ? subjectColor(event.subject) : "var(--fg-4)" }}
          />
        )}
      </span>
      <span
        className="h-4 w-0.5"
        aria-hidden="true"
        style={{
          backgroundColor: event.human ? "var(--fg-4)" : event.subject ? subjectColor(event.subject) : "var(--fg-4)",
        }}
      />
      <span aria-hidden="true" />
      <span className="min-w-0 truncate text-[13px] text-fg-2">{event.body}</span>
      <span className="ml-2 min-w-0 truncate text-[12px] text-fg-4">{event.meta}</span>
      <span className="text-right text-[12px] text-fg-4" aria-hidden="true">
        {event.human ? "" : event.targetHandle ? "›" : ""}
      </span>
    </>
  );
  const className =
    "grid h-[30px] w-full grid-cols-[40px_6px_2px_8px_minmax(0,1fr)_auto_12px] items-center gap-0 rounded px-2 text-left";
  return event.targetHandle ? (
    <button
      type="button"
      aria-pressed={false}
      onClick={() => {
        onSelect(event.targetHandle as string);
      }}
      className={`${className} transition-[background-color] duration-150 hover:bg-[rgb(255_255_255_/_0.027)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]`}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function StatusGlyph({ kind }: { kind: GlyphKind }) {
  const glyph = glyphFor(kind);
  return (
    <span
      aria-label={glyph.label}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center text-[14px] ${glyph.className}`}
    >
      {glyph.symbol}
    </span>
  );
}

function CriterionGlyph({ status }: { status: VerificationView["criteria"][number]["status"] }) {
  const glyph =
    status === "passed"
      ? { symbol: "●", className: "text-fg-4", label: "통과" }
      : status === "failed"
        ? { symbol: "⊘", className: "text-halt", label: "미통과" }
        : status === "blocked"
          ? { symbol: "⊘", className: "text-gate", label: "막힘" }
          : { symbol: "○", className: "text-fg-4", label: "제외" };
  return (
    <span
      aria-label={glyph.label}
      className={`inline-flex h-5 w-5 items-center justify-center text-[14px] ${glyph.className}`}
    >
      {glyph.symbol}
    </span>
  );
}

function verificationGlyphFor(verification: VerificationView): { symbol: string; className: string; label: string } {
  if (verification.criteria.every((criterion) => criterion.status === "passed")) {
    return { symbol: "◉", className: "text-fg-2", label: "검증 완료" };
  }
  if (verification.criteria.some((criterion) => criterion.status === "blocked")) {
    return { symbol: "⊘", className: "text-gate", label: "막힘" };
  }
  return { symbol: "⊘", className: "text-halt", label: "미통과" };
}

type GlyphKind = "complete" | "verified" | "gate" | "blocked" | "pending";

function glyphFor(kind: GlyphKind): { symbol: string; className: string; label: string } {
  if (kind === "verified") return { symbol: "◉", className: "text-fg-2", label: "검증 완료" };
  if (kind === "complete") return { symbol: "●", className: "text-fg-4", label: "완료" };
  if (kind === "gate") return { symbol: "◇", className: "text-gate", label: "사람이 필요함" };
  if (kind === "blocked") return { symbol: "⊘", className: "text-halt", label: "막힘" };
  return { symbol: "○", className: "text-fg-4", label: "미시작" };
}

function workStatusGlyph(work: WorkView): GlyphKind {
  if (work.status === "complete") return hasPassedVerification(work) ? "verified" : "complete";
  if (work.status === "failed") return "blocked";
  if (work.approvals.some((approval) => approval.status === "pending")) return "gate";
  return "pending";
}

function nodeStatusGlyph(status: string): GlyphKind {
  return status === "active" ? "complete" : "pending";
}

function hasPassedVerification(work: WorkView): boolean {
  return work.verifications.some(
    (verification) =>
      verification.state === "done" && verification.criteria.some((criterion) => criterion.status === "passed"),
  );
}

function workHistoryFor(node: OrganizationNodeView, works: readonly WorkView[]): WorkHistoryEntry[] {
  return [...works].reverse().flatMap((work) => {
    const entries: WorkHistoryEntry[] = [];
    if (work.agents.some((agent) => agent.id === node.handle)) entries.push({ work, relation: "execution" });
    if (
      work.verifications.some((verification) =>
        verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name),
      )
    ) {
      entries.push({ work, relation: "judgment" });
    }
    return entries;
  });
}

function verificationsFor(scope: readonly OrganizationNodeView[], works: readonly WorkView[]) {
  return [...works]
    .reverse()
    .flatMap((work) =>
      work.verifications
        .filter((verification) =>
          scope.some((node) =>
            verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name),
          ),
        )
        .map((verification) => ({ work, verification })),
    );
}

function ledgerEventsFor(
  descendants: readonly OrganizationNodeView[],
  nodes: readonly OrganizationNodeView[],
  works: readonly WorkView[],
  history: readonly WorkHistoryEntry[],
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const nodeByHandle = new Map(nodes.map((node) => [node.handle, node]));
  const descendantHandles = new Set(descendants.map((node) => node.handle));
  const historyWorkIds = new Set(history.map((entry) => entry.work.id));
  for (const work of [...works].reverse()) {
    for (const activity of work.activities) {
      const event = activityLedgerEvent(activity, work, nodeByHandle, descendantHandles, historyWorkIds);
      if (event) events.push(event);
    }
    for (const subject of descendants) {
      if (work.agents.some((agent) => agent.id === subject.handle)) {
        events.push({
          id: `${work.id}-${subject.handle}-assignment`,
          time: work.updatedAt,
          body: `${work.title} 배치`,
          meta: agentIdentityToken(subject.handle).name,
          subject,
          targetHandle: subject.handle,
        });
      }
      const matchingVerifications = work.verifications.filter((verification) =>
        verifierMatches(verification.verifier, subject.handle, agentIdentityToken(subject.handle).name),
      );
      if (matchingVerifications.length > 0) {
        const counts = criterionCountsFor(matchingVerifications);
        events.push({
          id: `${work.id}-${subject.handle}-judgment`,
          time: work.updatedAt,
          body: `${work.title} 판정`,
          meta: verificationMeta(counts),
          subject,
          targetHandle: subject.handle,
        });
      }
    }
  }
  for (const subject of descendants.filter((candidate) => candidate.scope === "work")) {
    const parent = subject.parentHandle
      ? nodes.find((candidate) => candidate.handle === subject.parentHandle)
      : undefined;
    events.push({
      id: `${subject.handle}-formation`,
      time: "",
      body: `${agentIdentityToken(subject.handle).name} 편성`,
      meta: parent ? `${agentIdentityToken(parent.handle).name} 아래` : "",
      subject,
      targetHandle: subject.handle,
    });
  }
  return events;
}

function activityLedgerEvent(
  activity: ActivityView,
  work: WorkView,
  nodeByHandle: ReadonlyMap<string, OrganizationNodeView>,
  descendantHandles: ReadonlySet<string>,
  historyWorkIds: ReadonlySet<string>,
): LedgerEvent | undefined {
  if (activity.kind === "message") {
    if (!historyWorkIds.has(work.id)) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: `${work.title} 요청`,
      meta: activity.author,
      human: true,
    };
  }

  if (activity.kind === "room") {
    const subject = nodeByHandle.get(activity.speaker.handle);
    const messageType = ROOM_MESSAGE_LABELS[activity.messageType];
    if (!subject || !descendantHandles.has(subject.handle) || !messageType) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: messageType,
      meta: activity.content,
      subject,
      targetHandle: subject.handle,
    };
  }

  if (activity.kind === "handoff") {
    const subject = nodeByHandle.get(activity.from.handle);
    if (!subject || !descendantHandles.has(subject.handle)) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: "인계",
      meta: activity.to ? `${activity.from.name} → ${activity.to.name}` : activity.from.name,
      subject,
      targetHandle: subject.handle,
    };
  }

  if (activity.kind === "proposal") {
    const subject = nodeByHandle.get(activity.speaker.handle);
    if (!subject || !descendantHandles.has(subject.handle)) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: "조직 변경 제안",
      meta: activity.content,
      subject,
      targetHandle: subject.handle,
    };
  }

  return undefined;
}

function criterionCounts(verification: VerificationView) {
  return criterionCountsFor([verification]);
}

function criterionCountsFor(verifications: readonly VerificationView[]) {
  return verifications.reduce(
    (counts, verification) => {
      for (const criterion of verification.criteria) counts[criterion.status] += 1;
      return counts;
    },
    { passed: 0, failed: 0, blocked: 0, excluded: 0 },
  );
}

function verificationMeta(counts: ReturnType<typeof criterionCountsFor>): string {
  return [
    counts.passed > 0 ? `통과 ${String(counts.passed)}` : "",
    counts.blocked > 0 ? `막힘 ${String(counts.blocked)}` : "",
    counts.failed > 0 ? `미통과 ${String(counts.failed)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function verifierMatches(verifier: string, handle: string, name: string): boolean {
  const value = verifier.trim().toLowerCase();
  return value === handle.toLowerCase() || value === name.toLowerCase();
}

function criterionStatusLabel(status: VerificationView["criteria"][number]["status"]): string {
  return status === "passed" ? "통과" : status === "failed" ? "미통과" : status === "blocked" ? "막힘" : "제외";
}

function descendantsOf(node: OrganizationNodeView, nodes: readonly OrganizationNodeView[]): OrganizationNodeView[] {
  const result: OrganizationNodeView[] = [node];
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index];
    if (!current) break;
    result.push(...nodes.filter((candidate) => candidate.parentHandle === current.handle));
  }
  return result;
}

function lineageOf(node: OrganizationNodeView, nodes: readonly OrganizationNodeView[]): OrganizationNodeView[] {
  const result: OrganizationNodeView[] = [node];
  let current = node;
  while (current.parentHandle) {
    const parent = nodes.find((candidate) => candidate.handle === current.parentHandle);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

function depthOf(node: OrganizationNodeView, nodes: readonly OrganizationNodeView[]): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>();
  while (current.parentHandle && !seen.has(current.handle)) {
    seen.add(current.handle);
    const parent = nodes.find((candidate) => candidate.handle === current.parentHandle);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function hasChildren(node: OrganizationNodeView, nodes: readonly OrganizationNodeView[]): boolean {
  return nodes.some((candidate) => candidate.parentHandle === node.handle);
}

function involvementCount(node: OrganizationNodeView, works: readonly WorkView[]): number {
  return works.reduce((count, work) => {
    const assigned = work.agents.some((agent) => agent.id === node.handle);
    const judged = work.verifications.some((verification) =>
      verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name),
    );
    return count + (assigned ? 1 : 0) + (judged ? 1 : 0);
  }, 0);
}

function agentsOutsideOrganization(
  works: readonly WorkView[],
  nodes: readonly OrganizationNodeView[],
): Array<{ id: string; name: string; role: string; involvement: number }> {
  const nodeHandles = new Set(nodes.map((node) => node.handle));
  const agents = new Map<string, { id: string; name: string; role: string; involvement: number }>();
  for (const work of works) {
    for (const agent of work.agents) {
      if (nodeHandles.has(agent.id)) continue;
      const existing = agents.get(agent.id);
      if (existing) {
        existing.involvement += 1;
      } else {
        agents.set(agent.id, { id: agent.id, name: agent.name, role: agent.role, involvement: 1 });
      }
    }
  }
  return [...agents.values()];
}

function roleTextOf(node: OrganizationNodeView): string {
  const token = agentIdentityToken(node.handle);
  return token.builtin ? token.roleLabel : node.responsibility.split(",")[0]?.trim() || token.roleLabel;
}

function nodeRoleTextOf(role: string): string {
  return ({ orchestrator: "총괄", coordinator: "조율", operator: "실행" } as Record<string, string>)[role] ?? role;
}

function nodeStatusLabel(status: string): string {
  return ({ active: "일하는 중", inactive: "쉬는 중", retired: "물러남" } as Record<string, string>)[status] ?? status;
}

function scopeTextOf(scope: "persistent" | "work"): string {
  return scope === "work" ? "이 업무가 끝나면 사라집니다" : "조직에 계속 남습니다";
}

function extraCapabilitiesOf(node: OrganizationNodeView): readonly string[] {
  const own = new Set([node.handle, "request-coordination"]);
  return node.capabilities.filter((capability) => !own.has(capability));
}

function accentColor(slot: number): string {
  return slot >= 0 && slot <= 7 ? `var(--agent-${String(slot)})` : "var(--fg-4)";
}

function subjectColor(node: OrganizationNodeView): string {
  return accentColor(agentIdentityToken(node.handle).accentSlot);
}
