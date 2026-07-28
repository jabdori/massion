import { useEffect, useMemo, useState } from "react";

import { agentIdentityToken } from "@massion/application/client";

import type {
  DesktopService,
  DesktopWorkspaceView,
  KnowledgeGraphView,
  KnowledgeIndexView,
  KnowledgeLinkView,
  KnowledgeNodeView,
  WorkKnowledgeView,
} from "@/desktop-service";
import type { VerificationCriterionStatus, VerificationView, WorkView } from "@/model";
import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

type LoadedKnowledge = {
  readonly workspaces: readonly DesktopWorkspaceView[];
  readonly activeWorkspaceId: string;
  readonly index: KnowledgeIndexView;
  readonly works: readonly WorkView[];
  readonly graph: KnowledgeGraphView;
  readonly docs: KnowledgeGraphView;
  readonly links: readonly (readonly KnowledgeLinkView[])[];
  readonly nodeLinks: ReadonlyMap<string, readonly KnowledgeLinkView[]>;
  readonly knowledge: readonly WorkKnowledgeView[];
};

type EvidenceEntry = {
  readonly node: KnowledgeNodeView;
  readonly link: KnowledgeLinkView;
  readonly reference?: WorkKnowledgeView["references"][number];
  readonly relationCount: number;
};

type WorkEvidence = {
  readonly work: WorkView;
  readonly evidence: readonly EvidenceEntry[];
};

const pathOf = (node: KnowledgeNodeView) =>
  node.kind === "file" && node.detail
    ? `${node.detail}/${node.label}`
    : node.kind === "artifact"
      ? node.label
      : (node.detail ?? node.label);

export function KnowledgeSurface({
  onOpenWork,
  service,
}: {
  onOpenWork: (workId: string) => void;
  service: DesktopService;
}) {
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [loaded, setLoaded] = useState<LoadedKnowledge>();
  const [error, setError] = useState("");
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setLoaded(undefined);
    setError("");

    void (async () => {
      try {
        const workspaces = await service.loadWorkspaces();
        const preferredWorkspace =
          workspaces.find((workspace) => workspace.trust === "trusted") ?? workspaces[0];
        const activeWorkspaceId =
          workspaceId !== undefined && workspaces.some((workspace) => workspace.workspaceId === workspaceId)
            ? workspaceId
            : preferredWorkspace?.workspaceId;
        if (activeWorkspaceId === undefined) throw new Error("사용할 워크스페이스가 없습니다.");
        if (activeWorkspaceId !== workspaceId) setWorkspaceId(activeWorkspaceId);

        const index = await service.loadKnowledgeIndex(activeWorkspaceId);
        const works = await service.loadIndex({ filter: "active", search: "" });
        const graph = await service.loadKnowledgeGraph(activeWorkspaceId, "file");
        const docs = await service.loadKnowledgeGraph(activeWorkspaceId, "document");
        const links = await Promise.all(
          works.map((work) => service.loadKnowledgeLinks(activeWorkspaceId, `work:${work.id}`)),
        );
        const citedNodeIds = [
          ...new Set(
            links.flatMap((workLinks) =>
              workLinks.filter((link) => link.node.kind !== "work").map((link) => link.node.nodeId),
            ),
          ),
        ];
        const nodeLinks = new Map(
          await Promise.all(
            citedNodeIds.map(async (nodeId) => [
              nodeId,
              await service.loadKnowledgeLinks(activeWorkspaceId, nodeId),
            ] as const),
          ),
        );
        const knowledge = await Promise.all(works.map((work) => service.loadWorkKnowledge(work.id)));

        if (disposed) return;
        setLoaded({ workspaces, activeWorkspaceId, index, works, graph, docs, links, nodeLinks, knowledge });
      } catch (cause) {
        if (disposed) return;
        setError(surfaceErrorMessage(cause, "지식을 불러오지 못했습니다."));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [service, workspaceId]);

  const workEvidence = useMemo(() => {
    if (loaded === undefined) return [];
    return loaded.works.map<WorkEvidence>((work, index) => {
      const knowledge = loaded.knowledge[index];
      const evidence = (loaded.links[index] ?? [])
        .filter((link) => link.node.kind !== "work")
        .map((link) => {
          const path = pathOf(link.node);
          const reference =
            knowledge?.status === "ready"
              ? knowledge.references.find((candidate) => candidate.relativePath === path)
              : undefined;
          return {
            node: link.node,
            link,
            relationCount: loaded.nodeLinks.get(link.node.nodeId)?.length ?? 0,
            ...(reference === undefined ? {} : { reference }),
          };
        });
      return { work, evidence };
    });
  }, [loaded]);

  const citedEvidence = useMemo(() => {
    const byNode = new Map<string, { readonly node: KnowledgeNodeView; readonly count: number }>();
    for (const block of workEvidence) {
      for (const entry of block.evidence) {
        const current = byNode.get(entry.node.nodeId);
        byNode.set(entry.node.nodeId, { node: entry.node, count: (current?.count ?? 0) + 1 });
      }
    }
    return [...byNode.values()].sort((left, right) => right.count - left.count || pathOf(left.node).localeCompare(pathOf(right.node)));
  }, [workEvidence]);

  const uncited = useMemo(() => {
    if (loaded === undefined) return [];
    const indexed = new Map<string, KnowledgeNodeView>();
    for (const node of [...loaded.graph.nodes, ...loaded.docs.nodes]) indexed.set(node.nodeId, node);
    const cited = new Set(citedEvidence.map((entry) => entry.node.nodeId));
    return [...indexed.values()].filter((node) => !cited.has(node.nodeId));
  }, [citedEvidence, loaded]);

  const visibleBlocks = useMemo(
    () =>
      workEvidence
        .filter(
          (block) =>
            selectedEvidenceId === undefined || block.evidence.some((entry) => entry.node.nodeId === selectedEvidenceId),
        )
        .sort((left, right) => right.evidence.length - left.evidence.length || left.work.title.localeCompare(right.work.title)),
    [selectedEvidenceId, workEvidence],
  );

  const citationCount = workEvidence.reduce((total, block) => total + block.evidence.length, 0);
  const verificationCount = loaded?.works.reduce((total, work) => total + work.verifications.length, 0) ?? 0;
  const verificationSummaries = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof verificationIdentity>>();
    for (const work of loaded?.works ?? []) {
      for (const verification of work.verifications) {
        const identity = verificationIdentity(work, verification);
        const current = grouped.get(identity.verifierKey);
        if (current === undefined) {
          grouped.set(identity.verifierKey, identity);
          continue;
        }
        grouped.set(identity.verifierKey, {
          ...current,
          criteriaCount: current.criteriaCount + identity.criteriaCount,
          state:
            current.state === "failed" || identity.state === "failed"
              ? "failed"
              : current.state === "done" && identity.state === "done"
                ? "done"
                : current.state,
        });
      }
    }
    return [...grouped.values()];
  }, [loaded]);

  return (
    <main aria-label="지식" className="col-span-3 grid min-h-0 min-w-0 grid-cols-[300px_minmax(0,1fr)_320px] bg-canvas">
      {error ? (
        <div className="col-span-3 flex min-h-0 items-center justify-center px-6">
          <SurfaceError message={error} />
        </div>
      ) : loaded === undefined ? (
        <div className="col-span-3 flex min-h-0 items-center justify-center px-6">
          <SurfaceLoading />
        </div>
      ) : (
        <>
          <aside aria-label="근거" className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-r border-control bg-surface-1">
            <header className="flex h-12 items-center border-b border-control px-4">
              <h1 className="text-[15px] font-semibold tracking-[-0.008em] text-secondary">지식</h1>
              <span className="ml-auto font-mono text-[11px] text-muted">{workspaceName(loaded)}</span>
            </header>
            <div className="min-h-0 overflow-y-auto px-2 py-3">
              <section aria-label={`워크스페이스 ${loaded.workspaces.length}`}>
                <SectionTitle label="워크스페이스" count={loaded.workspaces.length} />
                <ul className="mt-1 grid gap-0.5">
                  {loaded.workspaces.map((workspace) => (
                    <li key={workspace.workspaceId}>
                      <button
                        aria-pressed={workspace.workspaceId === loaded.activeWorkspaceId}
                        className={rowClass(workspace.workspaceId === loaded.activeWorkspaceId)}
                        onClick={() => {
                          if (workspace.workspaceId !== loaded.activeWorkspaceId) {
                            setSelectedEvidenceId(undefined);
                            setWorkspaceId(workspace.workspaceId);
                          }
                        }}
                        type="button"
                      >
                        <span className="min-w-0 truncate text-[13px] tracking-[-0.005em] text-secondary">{workspace.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-label="색인" className="mt-5">
                <SectionTitle label="색인" />
                <ul className="mt-1 grid gap-0.5">
                  <IndexRow label="상태" value={indexStatusLabel(loaded.index.status)} />
                  {loaded.index.indexVersionId ? <IndexRow label="판" value={loaded.index.indexVersionId} mono /> : null}
                  <IndexRow label="파일" value={formatCount(loaded.index.fileCount)} mono />
                  <IndexRow label="심볼" value={formatCount(loaded.index.symbolCount)} mono />
                  <IndexRow label="관계" value={formatCount(loaded.index.relationCount)} mono />
                  {loaded.index.indexedAt ? <IndexRow label="색인" value={formatIndexedAt(loaded.index.indexedAt)} mono /> : null}
                </ul>
              </section>

              <section aria-label={`제외 ${loaded.index.excluded.length}`} className="mt-5">
                <SectionTitle count={loaded.index.excluded.length} label="제외" />
                <ul className="mt-1 grid gap-0.5">
                  {loaded.index.excluded.map((pattern) => (
                    <li className="flex h-[30px] min-h-[30px] items-center px-2 font-mono text-[11px] text-muted" key={pattern}>
                      {pattern}
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-label={`인용된 근거 ${citedEvidence.length}`} className="mt-5">
                <SectionTitle count={citedEvidence.length} label="인용된 근거" />
                <ul className="mt-1 grid gap-0.5">
                  {citedEvidence.map((entry) => {
                    const selected = entry.node.nodeId === selectedEvidenceId;
                    return (
                      <li key={entry.node.nodeId}>
                        <button
                          aria-pressed={selected}
                          className={`${rowClass(selected)} gap-2`}
                          onClick={() => setSelectedEvidenceId(selected ? undefined : entry.node.nodeId)}
                          type="button"
                        >
                          <KindGlyph kind={entry.node.kind} />
                          <span className="min-w-0 flex-1 truncate text-[13px] tracking-[-0.005em] text-secondary">
                            {entry.node.label}
                          </span>
                          <span className="font-mono text-[11px] tabular-nums text-muted">{entry.count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
              <section aria-label={`판정 ${verificationSummaries.length}`} className="mt-5">
                <SectionTitle count={verificationSummaries.length} label="판정" />
                <ul className="mt-1 grid gap-0.5">
                  {verificationSummaries.map((summary) => (
                    <li
                      className="grid h-[30px] min-h-[30px] grid-cols-[2px_minmax(0,1fr)_auto] items-center gap-2 px-2"
                      key={summary.id}
                    >
                      <span className="h-5 w-[2px]" style={{ backgroundColor: `var(--agent-${summary.accentSlot})` }} />
                      <span className="flex min-w-0 items-center gap-2">
                        <VerificationStatusGlyph state={summary.state} />
                        <span className="min-w-0 truncate text-[13px] text-secondary">
                          {summary.verifierLabel}
                          {summary.verifierRole ? <span className="text-muted"> · {summary.verifierRole}</span> : null}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-muted">기준 {summary.criteriaCount}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </aside>

          <section aria-label="인용 원장" className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] bg-canvas">
            <header className="flex h-12 items-center border-b border-control px-6">
              <h2 className="text-[15px] font-semibold tracking-[-0.008em] text-primary">인용 원장</h2>
              <div className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted">
                <span>
                  근거 {citedEvidence.length} · 인용 {citationCount} · 판정 {verificationCount}
                </span>
                {selectedEvidenceId ? (
                  <>
                    <span>{citedEvidence.find((entry) => entry.node.nodeId === selectedEvidenceId)?.node.label} 인용만</span>
                    <button
                      aria-label="근거 거르기 해제"
                      className="text-secondary transition-colors duration-150 hover:text-secondary"
                      onClick={() => setSelectedEvidenceId(undefined)}
                      type="button"
                    >
                      ×
                    </button>
                  </>
                ) : null}
              </div>
            </header>
            <div className="min-h-0 overflow-y-auto px-6 py-3">
              <ul className="grid gap-2">
                {visibleBlocks.map((block) => (
                  <li key={block.work.id}>
                    <WorkLedgerBlock block={block} onOpenWork={onOpenWork} />
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <aside aria-label="인용 안 됨" className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-l border-control bg-surface-1">
            <header className="flex h-12 items-center border-b border-control px-4">
              <h2 className="text-[15px] font-semibold tracking-[-0.008em] text-secondary">인용 안 됨</h2>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">
                색인 {uncited.length + citedEvidence.length} · 인용 {citedEvidence.length}
              </span>
            </header>
            <div className="min-h-0 overflow-y-auto px-4 py-3">
              <ul className="grid gap-0.5">
                {uncited.map((node) => (
                  <li className="flex h-[30px] min-h-[30px] items-center truncate font-mono text-[11px] text-muted" key={node.nodeId}>
                    {pathOf(node)}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </>
      )}
    </main>
  );
}

function workspaceName(loaded: LoadedKnowledge): string {
  return loaded.workspaces.find((workspace) => workspace.workspaceId === loaded.activeWorkspaceId)?.name ?? "";
}

function rowClass(selected: boolean): string {
  return `flex h-[30px] min-h-[30px] w-full items-center rounded-[4px] px-2 text-left transition-colors duration-150 hover:bg-white/[0.027] ${
    selected ? "bg-white/[0.047]" : ""
  }`;
}

function SectionTitle({ count, label }: { count?: number; label: string }) {
  return (
    <h2 className="text-[12px] leading-[18px] text-muted">
      {label}
      {count === undefined ? null : ` ${count.toLocaleString("ko-KR")}`}
    </h2>
  );
}

function IndexRow({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <li className="flex h-[30px] min-h-[30px] items-center justify-between px-2 text-[12px] text-secondary">
      <span>{label}</span>
      <span className={`${mono ? "font-mono " : ""}text-[11px] tabular-nums text-muted`}>{value}</span>
    </li>
  );
}

function verificationIdentity(work: WorkView, verification: VerificationView) {
  const matched = work.agents.find(
    (agent) =>
      agent.name.toLowerCase() === verification.verifier.toLowerCase() || agent.id === verification.verifier,
  );
  const executors = work.agents.filter((agent) => agent.role !== "검증");
  const separated = !executors.some(
    (agent) =>
      agent.name.toLowerCase() === verification.verifier.toLowerCase() || agent.id === verification.verifier,
  );
  return {
    id: `${work.id}-${verification.id}`,
    verifierKey: matched?.id ?? verification.verifier.toLowerCase(),
    state: verification.state,
    verifierLabel: matched ? matched.name : verification.verifier,
    verifierRole: matched?.role,
    accentSlot: agentIdentityToken(matched?.id ?? verification.verifier).accentSlot,
    criteriaCount: verification.criteria.length,
    separated,
  };
}

function WorkLedgerBlock({ block, onOpenWork }: { block: WorkEvidence; onOpenWork: (workId: string) => void }) {
  return (
    <section aria-label={block.work.title} className="grid gap-0.5">
      <button
        aria-label={block.work.title}
        className="grid h-[30px] min-h-[30px] w-full grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2 rounded-[4px] text-left transition-colors duration-150 hover:bg-white/[0.027]"
        onClick={() => onOpenWork(block.work.id)}
        type="button"
      >
        <span className="text-right font-mono text-[11px] tabular-nums text-muted">{block.work.updatedAt}</span>
        <span className="h-5 w-[2px] bg-transparent" />
        <span className="flex min-w-0 items-center gap-2">
          <WorkStatusGlyph progress={block.work.progress / 100} status={block.work.status} />
          <span className="min-w-0 truncate text-[13px] tracking-[-0.005em] text-secondary">{block.work.title}</span>
        </span>
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted">
          {block.work.status === "active" ? `진행 ${block.work.progress}% · ` : ""}
          실행 {block.work.agents.length} · 근거 {block.evidence.length}
        </span>
        <span aria-hidden="true" className="text-[14px] text-muted">
          ›
        </span>
      </button>

      <AssignmentRow work={block.work} />
      {block.work.verifications.map((verification) => (
        <VerificationRows key={verification.id} work={block.work} verification={verification} />
      ))}
      {block.evidence.map((entry) => (
        <EvidenceRow entry={entry} key={`${block.work.id}-${entry.node.nodeId}`} />
      ))}
      {block.work.artifacts.map((artifact) => (
        <ArtifactRow artifact={artifact} key={`${block.work.id}-${artifact.id}`} />
      ))}
    </section>
  );
}

function AssignmentRow({ work }: { work: WorkView }) {
  return (
    <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2">
      <span aria-hidden="true" />
      <span className="h-5 w-[2px] bg-transparent" />
      <span className="col-start-3 flex min-w-0 truncate pl-8 text-[12px] text-muted">
        <span className="shrink-0">배정</span>
        <span className="ml-2 truncate text-[13px] text-secondary">{work.team}</span>
        {work.agents.map((agent) => {
          const token = agentIdentityToken(agent.id);
          return (
            <span className="ml-2 shrink-0" key={agent.id}>
              <span aria-hidden="true">· </span>
              <span className="text-muted">{agent.role} </span>
              <span className="text-[13px] text-secondary" style={{ color: `var(--agent-${token.accentSlot})` }}>
                {agent.name}
              </span>
            </span>
          );
        })}
      </span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

function VerificationRows({
  work,
  verification,
}: {
  work: WorkView;
  verification: VerificationView;
}) {
  const identity = verificationIdentity(work, verification);
  const counts = criterionCounts(verification);
  const meta = [
    counts.total > 0 ? `기준 ${counts.total}` : "",
    counts.passed > 0 ? `통과 ${counts.passed}` : "",
    counts.failed > 0 ? `미통과 ${counts.failed}` : "",
    counts.blocked > 0 ? `막힘 ${counts.blocked}` : "",
    counts.excluded > 0 ? `제외 ${counts.excluded}` : "",
  ].filter(Boolean);
  if (identity.separated) meta.push("실행 기여자 아님");
  else meta.push("실행 기여자");

  return (
    <>
      <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2">
        <span aria-hidden="true" />
        <span className="h-5 w-[2px]" style={{ backgroundColor: `var(--agent-${identity.accentSlot})` }} />
        <span className="flex min-w-0 items-center gap-2 pl-8">
          <VerificationStatusGlyph state={verification.state} />
          <span className="flex min-w-0 items-center gap-1 truncate text-[13px] tracking-[-0.005em]">
            <span className="truncate text-secondary">판정 {identity.verifierLabel}</span>
            {identity.verifierRole ? <span className="shrink-0 text-muted"> · {identity.verifierRole}</span> : null}
          </span>
        </span>
        <span
          className={`${identity.separated ? "text-muted" : "text-danger"} whitespace-nowrap font-mono text-[11px] tabular-nums`}
        >
          {meta.join(" · ")}
        </span>
        <span aria-hidden="true" />
      </div>
      <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2 overflow-hidden">
        <span aria-hidden="true" />
        <span className="h-5 w-[2px] bg-transparent" />
        <span className="col-start-3 flex min-w-0 items-center gap-5 overflow-hidden pl-8">
          {verification.criteria.map((criterion) => (
            <span className={`${criterionStatusClass(criterion.status)} flex min-w-0 shrink-0 items-center gap-1.5`} key={criterion.key}>
              <CriterionStatusGlyph status={criterion.status} />
              <span className="truncate font-mono text-[11px]">{criterion.key}</span>
            </span>
          ))}
        </span>
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </div>
      {verification.evidence ? (
        <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2">
          <span aria-hidden="true" />
          <span className="h-5 w-[2px] bg-transparent" />
          <span className="col-start-3 min-w-0 truncate pl-8 font-mono text-[11px] text-muted">{verification.evidence}</span>
        </div>
      ) : null}
    </>
  );
}

function EvidenceRow({ entry }: { entry: EvidenceEntry }) {
  const reference = entry.reference;
  const qualified = reference?.qualifiedName
    ? `${reference.qualifiedName}:${reference.startLine}–${reference.endLine}`
    : reference
      ? `${reference.startLine}–${reference.endLine}`
      : undefined;
  return (
    <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2">
      <span aria-hidden="true" />
      <span className="h-5 w-[2px] bg-transparent" />
      <span className="col-start-3 flex min-w-0 items-center gap-2 overflow-hidden pl-8">
        <KindGlyph kind={entry.node.kind} />
        <span className="min-w-0 truncate text-[11px] text-secondary">
          <span className={entry.node.kind === "artifact" ? "text-[13px]" : "font-mono"}>{pathOf(entry.node)}</span>
          {qualified ? <span className="font-mono text-muted"> {qualified}</span> : null}
          {entry.node.group ? <span className="text-muted"> · {entry.node.group}</span> : null}
          {entry.relationCount > 0 ? <span className="text-muted"> · 관계 {entry.relationCount}</span> : null}
        </span>
      </span>
      <span className="whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted">
        {reference?.contentHash}
      </span>
      <span aria-hidden="true" />
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: WorkView["artifacts"][number] }) {
  return (
    <div className="grid h-[30px] min-h-[30px] grid-cols-[44px_2px_minmax(0,1fr)_auto_14px] items-center gap-2">
      <span aria-hidden="true" />
      <span className="h-5 w-[2px] bg-transparent" />
      <span className="col-start-3 flex min-w-0 items-center gap-2 overflow-hidden pl-8">
        <KindGlyph kind="artifact" />
        <span className="min-w-0 truncate text-[13px] tracking-[-0.005em] text-secondary">{artifact.name}</span>
        <span className="shrink-0 text-[12px] text-muted">
          {artifact.format} · {artifact.size}
        </span>
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-muted">{artifact.createdAt}</span>
      <span aria-hidden="true" />
    </div>
  );
}

function criterionCounts(verification: VerificationView) {
  return verification.criteria.reduce(
    (counts, criterion) => {
      counts[criterion.status] += 1;
      counts.total += 1;
      return counts;
    },
    { total: 0, passed: 0, failed: 0, blocked: 0, excluded: 0 },
  );
}

function criterionStatusClass(status: VerificationCriterionStatus): string {
  if (status === "failed") return "text-[12px] text-danger";
  if (status === "blocked") return "text-[12px] text-gate";
  return "text-[12px] text-muted";
}

function indexStatusLabel(status: KnowledgeIndexView["status"]): string {
  if (status === "ready") return "준비됨";
  if (status === "indexing") return "색인 중";
  if (status === "stale") return "오래됨";
  return "없음";
}

function formatCount(value: number): string {
  return value.toLocaleString("ko-KR");
}

function formatIndexedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}.${day} ${hour}:${minute}`;
}

function WorkStatusGlyph({ progress, status }: { progress: number; status: WorkView["status"] }) {
  if (status === "complete") return <StatusGlyph kind="complete" />;
  return <StatusGlyph kind="progress" progress={progress} />;
}

function VerificationStatusGlyph({ state }: { state: VerificationView["state"] }) {
  return <StatusGlyph kind={state === "done" ? "verified" : state === "failed" ? "failed" : "empty"} />;
}

function CriterionStatusGlyph({ status }: { status: VerificationCriterionStatus }) {
  return (
    <StatusGlyph
      kind={status === "passed" ? "complete" : status === "failed" ? "failed" : status === "blocked" ? "gate" : "empty"}
      size="compact"
      muted={status === "passed" || status === "excluded"}
    />
  );
}

function StatusGlyph({
  kind,
  muted = false,
  progress = 0,
  size = "regular",
}: {
  kind: "empty" | "progress" | "complete" | "verified" | "gate" | "failed";
  muted?: boolean;
  progress?: number;
  size?: "compact" | "regular";
}) {
  const sizeClass = size === "compact" ? "size-3" : "size-[14px]";
  const neutralColorClass = muted ? "text-muted" : "text-secondary";
  if (kind === "gate") {
    return (
      <svg aria-hidden="true" className={`${sizeClass} shrink-0 text-gate`} viewBox="0 0 14 14">
        <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "failed") {
    return (
      <svg aria-hidden="true" className={`${sizeClass} shrink-0 text-danger`} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="m4 4 6 6" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "verified") {
    return (
      <svg aria-hidden="true" className={`${sizeClass} shrink-0 ${neutralColorClass}`} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6.5" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="7" cy="7" r="3.5" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "complete") {
    return (
      <svg aria-hidden="true" className={`${sizeClass} shrink-0 ${neutralColorClass}`} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="4.5" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "progress") {
    const amount = Math.max(0, Math.min(1, progress));
    if (amount >= 1) return <StatusGlyph kind="complete" />;
    if (amount <= 0) return <StatusGlyph kind="empty" />;
    const angle = -Math.PI / 2 + amount * Math.PI * 2;
    const endX = 7 + 5 * Math.cos(angle);
    const endY = 7 + 5 * Math.sin(angle);
    return (
      <svg aria-hidden="true" className={`${sizeClass} shrink-0 ${neutralColorClass}`} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
        <path
          d={`M7 2 A5 5 0 ${amount > 0.5 ? 1 : 0} 1 ${endX} ${endY} L7 7Z`}
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className={`${sizeClass} shrink-0 ${neutralColorClass}`} viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function KindGlyph({ kind }: { kind: KnowledgeNodeView["kind"] }) {
  if (kind === "file") {
    return (
      <svg aria-hidden="true" className="size-3 shrink-0 text-muted" viewBox="0 0 12 12">
        <rect x="4" y="1" width="4" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "document") {
    return (
      <svg aria-hidden="true" className="size-3 shrink-0 text-muted" viewBox="0 0 12 12">
        <rect x="1" y="2" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M3 5h6M3 7h6" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "artifact") {
    return (
      <svg aria-hidden="true" className="size-3 shrink-0 text-muted" viewBox="0 0 12 12">
        <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="size-3 shrink-0 text-muted" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
