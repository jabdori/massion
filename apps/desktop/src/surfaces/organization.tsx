import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopService, OrganizationNodeView, OrganizationView } from "@/desktop-service";
import { agentIdentityToken } from "@massion/application/client";
import type { ActivityView, VerificationView, WorkView } from "@/model";
import { SurfaceError, surfaceErrorMessage } from "@/ui/surface";

type WorkRelation = "execution" | "judgment";

interface WorkHistoryEntry {
  work: WorkView;
  relations: WorkRelation[];
}

interface LedgerEvent {
  id: string;
  time: string;
  body: string;
  meta: string;
  subject?: OrganizationNodeView;
  targetHandle?: string;
  human?: boolean;
  gate?: boolean;
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
  const selectedWorkHistory = useMemo(
    () => (selected ? workHistoryFor(descendants, works) : []),
    [descendants, selected, works],
  );
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
    <main aria-label="조직" className="col-span-3 grid min-h-0 min-w-0 grid-cols-[420px_minmax(0,1fr)_320px] bg-bg-0">
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
              <p className="mt-0 flex h-8 items-center px-2 text-[12px] text-fg-4">영속 조직</p>
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
                  <p className="mt-4 flex h-8 items-center px-2 text-[12px] text-fg-4">임시 편성 {workTeams.length}</p>
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
                  <p className="mt-4 flex h-8 items-center px-2 text-[12px] text-fg-4">
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
                {selected.name}
              </h2>
              <span className="text-[13px] text-fg-3">{nodeRoleTextOf(selected.role)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg-3">{selected.responsibility}</span>
              {selected.scope === "work" ? <span className="shrink-0 text-[12px] text-fg-4">임시</span> : null}
              {selected.status !== "active" ? (
                <span className="shrink-0 text-[12px] text-fg-4">{nodeStatusLabel(selected.status)}</span>
              ) : null}
              <span className="flex shrink-0 items-center gap-1">
                <span className="h-1 w-1 shrink-0" aria-hidden="true" style={{ backgroundColor: subjectColor(selected) }} />
                <span className="font-mono text-[11px] text-fg-4">{agentIdentityToken(selected.handle).name}</span>
                <span className="font-mono text-[11px] text-fg-4">{selected.handle}</span>
              </span>
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
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-node={node.handle}
      onClick={() => {
        onSelect(node.handle);
      }}
      className={`flex h-[30px] w-full items-center gap-2 rounded px-2 text-left transition-[background-color] duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)] ${selected ? "bg-[rgb(255_255_255_/_0.047)]" : "hover:bg-[rgb(255_255_255_/_0.027)]"}`}
      style={{ paddingLeft: 8 + depth * 32 }}
    >
      <NodeMarker node={node} hasChildren={childExists} />
      <span className={`min-w-0 truncate text-[13px] ${selected ? "text-fg" : "text-fg-2"}`}>{node.name}</span>
      <span className="shrink-0 text-[12px] text-fg-4">{nodeRoleTextOf(node.role)}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">{node.responsibility}</span>
      {count > 0 ? <span className="ml-auto shrink-0 tabular-nums text-[12px] text-fg-4">{count}</span> : null}
    </button>
  );
}

function NodeMarker({ node, hasChildren }: { node: OrganizationNodeView; hasChildren: boolean }) {
  if (node.scope === "work") {
    return (
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className="h-1 w-1"
          style={{ boxSizing: "border-box", border: "1px dashed var(--agent-provisional)", backgroundColor: "transparent" }}
        />
      </span>
    );
  }
  if (hasChildren) {
    return (
      <span
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <span className="h-[14px] w-0.5" aria-hidden="true" style={{ backgroundColor: subjectColor(node) }} />
      </span>
    );
  }
  return (
    <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden="true">
      <span className="h-1 w-1" style={{ backgroundColor: subjectColor(node) }} />
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
                    {ancestor.name}
                  </button>
                </span>
              ))}
            </span>
          </DefinitionRow>
        ) : null}
        {extras.length > 0 ? <DefinitionRow label="역량">{extras.join(" · ")}</DefinitionRow> : null}
      </div>

      {history.length > 0 ? (
        <>
          <DetailSectionHeader
            label={descendantsOf(node, nodes).length > 1 ? "이 자리와 아래가 걸어온 업무" : "이 자리가 걸어온 업무"}
            count={history.length}
          />
          <div className="space-y-0.5">
            {history.map((entry) => (
              <WorkHistoryRow key={entry.work.id} entry={entry} nodes={nodes} onSelect={onSelect} />
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
                onSelect={onSelect}
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
                  {relatedNode.name}
                </span>
                <span className="shrink-0 text-[12px] text-fg-4">{relation}</span>
                <span className="shrink-0 text-[12px] text-fg-4">{nodeRoleTextOf(relatedNode.role)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">{relatedNode.responsibility}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function WorkHistoryRow({
  entry,
  nodes,
  onSelect,
}: {
  entry: WorkHistoryEntry;
  nodes: readonly OrganizationNodeView[];
  onSelect: (handle: string) => void;
}) {
  const verification = entry.work.verifications[0];
  const verifierNode = verification ? verifierNodeFor(verification.verifier, nodes) : undefined;
  const verifier = verification ? agentIdentityToken(verifierNode?.handle ?? verification.verifier) : undefined;
  const counts = verification ? criterionSummary(criterionCountsFor(entry.work.verifications)) : "";
  const content = (
    <>
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
        <WorkHistoryGlyph work={entry.work} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{entry.work.title}</span>
      <span className="shrink-0 text-[12px] text-fg-4">
        {entry.relations.map((relation) => (relation === "execution" ? "실행 배치" : "판정")).join(" · ")}
      </span>
      {verifier ? (
        <span className="flex min-w-0 shrink-0 items-center gap-1 text-[12px] text-fg-3">
          <span className="h-1 w-1 shrink-0" aria-hidden="true" style={{ backgroundColor: accentColor(verifier.accentSlot) }} />
          <span className="max-w-[104px] truncate">{verifier.name}</span>
        </span>
      ) : null}
      {counts ? <span className="shrink-0 tabular-nums text-[12px] text-fg-4">{counts}</span> : null}
      <span className="w-[52px] shrink-0 font-mono text-right text-[11px] tabular-nums text-fg-4">
        {entry.work.updatedAt}
      </span>
      {verifierNode ? <span className="w-3 shrink-0 text-right text-[12px] text-fg-4">›</span> : null}
    </>
  );
  const className =
    "flex h-[30px] w-full min-w-0 items-center gap-2 rounded px-2 text-left transition-[background-color] duration-150 hover:bg-[rgb(255_255_255_/_0.027)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]";
  return verifierNode ? (
    <button
      type="button"
      aria-pressed={false}
      onClick={() => {
        onSelect(verifierNode.handle);
      }}
      className={className}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function VerificationBlock({
  nodes,
  work,
  verification,
  onSelect,
}: {
  nodes: readonly OrganizationNodeView[];
  work: WorkView;
  verification: VerificationView;
  onSelect: (handle: string) => void;
}) {
  const counts = criterionCounts(verification);
  const contributors = work.agents.filter((agent) => agent.name);
  const verifierNode = verifierNodeFor(verification.verifier, nodes);
  const verifier = agentIdentityToken(verifierNode?.handle ?? verification.verifier);
  const verificationGlyph = verificationGlyphFor([verification]);
  const row2 = (
    <span className="flex h-[30px] min-w-0 items-center gap-2 rounded px-2 text-left">
      <span className="h-[14px] w-[14px] shrink-0" aria-hidden="true" />
      {contributors.length > 0 ? (
        <>
          <span className="shrink-0 text-[12px] text-fg-4">실행</span>
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-[13px] text-fg-2">
            {contributors.map((agent, index) => {
              const agentNode = nodeForAgent(agent, nodes);
              return (
                <span key={`${agent.id}-${String(index)}`} className="flex shrink-0 items-center gap-1">
                  {index > 0 ? <span className="text-[12px] text-fg-4">·</span> : null}
                  <span
                    className="h-1 w-1 shrink-0"
                    aria-hidden="true"
                    style={{ backgroundColor: agentNode ? subjectColor(agentNode) : accentColor(agentIdentityToken(agent.id).accentSlot) }}
                  />
                  <span>{agent.name}</span>
                </span>
              );
            })}
          </span>
        </>
      ) : null}
      <span className="shrink-0 text-[12px] text-fg-4">판정</span>
      <span className="flex min-w-0 shrink-0 items-center gap-1 text-[13px] text-fg-2">
        <span className="h-1 w-1 shrink-0" aria-hidden="true" style={{ backgroundColor: accentColor(verifier.accentSlot) }} />
        <span className="max-w-[104px] truncate">{verifier.name}</span>
      </span>
      {verifierNode ? <span className="w-3 shrink-0 text-right text-[12px] text-fg-4">›</span> : null}
    </span>
  );
  return (
    <div className="space-y-0.5">
      <div className="flex h-[30px] items-center gap-2 rounded px-2">
        <StatusGlyph glyph={verificationGlyph} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{work.title}</span>
        <span className="shrink-0 tabular-nums text-[12px] text-fg-4">{criterionSummary(counts)}</span>
      </div>
      {verifierNode ? (
        <button
          type="button"
          aria-pressed={false}
          onClick={() => {
            onSelect(verifierNode.handle);
          }}
          className="w-full text-left transition-[background-color] duration-150 hover:bg-[rgb(255_255_255_/_0.027)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]"
        >
          {row2}
        </button>
      ) : (
        row2
      )}
      {verification.criteria.length > 0 ? (
        <div className="flex h-[30px] min-w-0 items-center gap-2 rounded px-2">
          <span className="h-[14px] w-[14px] shrink-0" aria-hidden="true" />
          <span className="shrink-0 text-[12px] text-fg-4">기준</span>
          <span className="min-w-0 flex-1 truncate whitespace-nowrap">
            {verification.criteria.map((criterion, index) => (
              <span key={criterion.key}>
                {index > 0 ? <span className="px-1 text-[12px] text-fg-4">·</span> : null}
                <span className="font-mono text-[11px] text-fg-3">{criterion.key}</span>{" "}
                <span className={`text-[12px] ${criterionStatusClass(criterion.status)}`}>
                  {criterionStatusLabel(criterion.status)}
                </span>
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {verification.evidence ? <DefinitionRow label="근거">{verification.evidence}</DefinitionRow> : null}
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
    <div className="grid h-[30px] grid-cols-[20px_auto_minmax(0,1fr)] items-center gap-2 rounded px-2">
      <span className="h-[14px] w-[14px] shrink-0" aria-hidden="true" />
      <span className="text-[12px] text-fg-4">{label}</span>
      <span className={`min-w-0 truncate text-[13px] text-fg-2 ${valueClassName}`}>{children}</span>
    </div>
  );
}

function DetailSectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <p className="mt-4 flex h-8 items-center px-2 text-[12px] text-fg-4">
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
        {event.human || event.gate ? (
          <span className={`h-[6px] w-[6px] rounded-full ${event.gate ? "bg-gate" : "bg-fg-4"}`} />
        ) : (
          <span
            className="h-4 w-0.5"
            style={{ backgroundColor: event.subject ? subjectColor(event.subject) : "var(--fg-4)" }}
          />
        )}
      </span>
      <span aria-hidden="true" />
      <span className="min-w-0 truncate whitespace-nowrap text-[13px] text-fg-2">{event.body}</span>
      <span className="min-w-0 truncate text-[12px] text-fg-4">{event.meta}</span>
      <span className="text-right text-[12px] text-fg-4" aria-hidden="true">
        {event.human ? "" : event.targetHandle ? "›" : ""}
      </span>
    </>
  );
  const className =
    "grid h-[30px] w-full grid-cols-[40px_8px_8px_minmax(0,auto)_minmax(0,1fr)_12px] items-center gap-0 rounded px-2 text-left";
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

type Glyph = { symbol: string; className: string; label: string };

function StatusGlyph({ kind, glyph }: { kind?: GlyphKind; glyph?: Glyph }) {
  const resolvedGlyph = glyph ?? glyphFor(kind ?? "pending");
  return (
    <span
      aria-label={resolvedGlyph.label}
      className={`inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[14px] ${resolvedGlyph.className}`}
    >
      {resolvedGlyph.symbol}
    </span>
  );
}

function verificationGlyphFor(verifications: readonly VerificationView[]): Glyph {
  const criteria = verifications.flatMap((verification) => verification.criteria);
  if (criteria.length > 0 && criteria.every((criterion) => criterion.status === "passed")) {
    return { symbol: "◉", className: "text-fg-2", label: "검증 완료" };
  }
  if (criteria.some((criterion) => criterion.status === "failed")) {
    return { symbol: "⊘", className: "text-halt", label: "미통과" };
  }
  if (criteria.some((criterion) => criterion.status === "blocked")) {
    return { symbol: "◇", className: "text-gate", label: "막힘" };
  }
  return { symbol: "●", className: "text-fg-4", label: "완료" };
}

type GlyphKind = "complete" | "verified" | "gate" | "blocked" | "pending";

function glyphFor(kind: GlyphKind): { symbol: string; className: string; label: string } {
  if (kind === "verified") return { symbol: "◉", className: "text-fg-2", label: "검증 완료" };
  if (kind === "complete") return { symbol: "●", className: "text-fg-4", label: "완료" };
  if (kind === "gate") return { symbol: "◇", className: "text-gate", label: "사람이 필요함" };
  if (kind === "blocked") return { symbol: "⊘", className: "text-halt", label: "막힘" };
  return { symbol: "○", className: "text-fg-4", label: "미시작" };
}

function WorkHistoryGlyph({ work }: { work: WorkView }) {
  if (work.verifications.length > 0) return <StatusGlyph glyph={verificationGlyphFor(work.verifications)} />;
  if (work.progress > 0) {
    return (
      <span
        aria-hidden="true"
        className="size-[14px] shrink-0 rounded-full"
        style={{
          background: `conic-gradient(var(--fg-3) ${String(work.progress)}%, transparent 0)`,
          boxShadow: "inset 0 0 0 0.5px var(--fg-4)",
        }}
      />
    );
  }
  return <StatusGlyph kind="pending" />;
}

function workHistoryFor(scope: readonly OrganizationNodeView[], works: readonly WorkView[]): WorkHistoryEntry[] {
  return [...works].reverse().flatMap((work) => {
    const relations: WorkRelation[] = [];
    if (work.agents.some((agent) => scope.some((node) => agent.id === node.handle))) {
      relations.push("execution");
    }
    if (
      work.verifications.some((verification) =>
        scope.some((node) => verifierMatches(verification.verifier, node.handle, agentIdentityToken(node.handle).name)),
      )
    ) {
      relations.push("judgment");
    }
    return relations.length > 0 ? [{ work, relations }] : [];
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
    const assignedSubjects = descendants.filter((subject) =>
      work.agents.some((agent) => agentNodeMatches(agent, subject)),
    );
    const firstAssigned = assignedSubjects[0];
    if (firstAssigned) {
      events.push({
        id: `${work.id}-assignment`,
        time: work.updatedAt,
        body: `${work.title} 배치`,
        meta: assignedSubjects.map((subject) => agentIdentityToken(subject.handle).name).join(" · "),
        subject: firstAssigned,
        targetHandle: firstAssigned.handle,
      });
    }
    for (const subject of descendants) {
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
      body: `요청 · ${activity.author}`,
      meta: activity.content,
      human: true,
    };
  }

  if (activity.kind === "approval") {
    if (!historyWorkIds.has(work.id)) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: "승인 요청",
      meta: activity.title,
      gate: true,
    };
  }

  if (activity.kind === "room") {
    const subject = nodeByHandle.get(activity.speaker.handle);
    const messageType = ROOM_MESSAGE_LABELS[activity.messageType];
    if (!subject || !descendantHandles.has(subject.handle) || !messageType) return undefined;
    return {
      id: `${work.id}-${activity.id}`,
      time: activity.time,
      body: activity.recipient
        ? `${messageType} · ${activity.recipient}`
        : activity.target
          ? `${messageType} · ${activity.target}`
          : activity.signature
            ? `${messageType} · 서명 ${activity.signature.by}`
            : messageType,
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

function criterionSummary(counts: ReturnType<typeof criterionCountsFor>): string {
  return [
    counts.passed > 0 ? `통과 ${String(counts.passed)}` : "",
    counts.failed > 0 ? `미통과 ${String(counts.failed)}` : "",
    counts.blocked > 0 ? `막힘 ${String(counts.blocked)}` : "",
    counts.excluded > 0 ? `제외 ${String(counts.excluded)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function verificationMeta(counts: ReturnType<typeof criterionCountsFor>): string {
  return criterionSummary(counts);
}

function verifierMatches(verifier: string, handle: string, name: string): boolean {
  const value = verifier.trim().toLowerCase();
  return value === handle.toLowerCase() || value === name.toLowerCase();
}

function verifierNodeFor(verifier: string, nodes: readonly OrganizationNodeView[]): OrganizationNodeView | undefined {
  return nodes.find((node) => verifierMatches(verifier, node.handle, agentIdentityToken(node.handle).name));
}

function nodeForAgent(agent: WorkView["agents"][number], nodes: readonly OrganizationNodeView[]) {
  return nodes.find((node) => agentNodeMatches(agent, node));
}

function agentNodeMatches(agent: WorkView["agents"][number], node: OrganizationNodeView): boolean {
  const nodeName = agentIdentityToken(node.handle).name;
  return verifierMatches(agent.id, node.handle, nodeName) || verifierMatches(agent.name, node.handle, nodeName);
}

function criterionStatusLabel(status: VerificationView["criteria"][number]["status"]): string {
  return status === "passed" ? "통과" : status === "failed" ? "미통과" : status === "blocked" ? "막힘" : "제외";
}

function criterionStatusClass(status: VerificationView["criteria"][number]["status"]): string {
  return status === "passed"
    ? "text-fg-2"
    : status === "failed"
      ? "text-halt"
      : status === "blocked"
        ? "text-gate"
        : "text-fg-4";
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

function nodeRoleTextOf(role: string): string {
  return ({ orchestrator: "총괄", coordinator: "조율", operator: "실행" } as Record<string, string>)[role] ?? role;
}

function nodeStatusLabel(status: string): string {
  return ({ active: "일하는 중", inactive: "쉬는 중", retired: "물러남" } as Record<string, string>)[status] ?? status;
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
