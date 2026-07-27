import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopService, OrganizationNodeView, OrganizationView } from "@/desktop-service";
import type { SpeakerView } from "@/model";
import { agentIdentityToken } from "@massion/application/client";

import { AgentAvatar } from "@/room";
import { MapBoundary, SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

export function OrganizationSurface({ service }: { service: DesktopService }) {
  const [organization, setOrganization] = useState<OrganizationView>();
  const [selectedHandle, setSelectedHandle] = useState<string>();
  const [collapsedHandles, setCollapsedHandles] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const structureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    void service
      .loadOrganization()
      .then((value) => {
        if (!disposed) setOrganization(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "조직 정보를 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  const nodes = organization?.nodes ?? [];
  const root = nodes.find((node) => node.parentHandle === undefined);
  const workTeams = nodes.filter((node) => node.scope === "work");
  const selected = nodes.find((node) => node.handle === selectedHandle);
  const identity = selected ? agentIdentityToken(selected.handle, roleTextOf(selected)) : undefined;
  const children = selected ? nodes.filter((node) => node.parentHandle === selected.handle) : [];
  const parent =
    selected?.parentHandle === undefined ? undefined : nodes.find((node) => node.handle === selected.parentHandle);

  useEffect(() => {
    if (!selectedHandle) return;
    structureRef.current
      ?.querySelector(`[data-node="${selectedHandle}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [collapsedHandles, selectedHandle]);

  // 어느 표면에서 골라도 접힌 상위 단위를 먼저 열고 같은 선택 상태를 공유합니다.
  const select = (handle: string) => {
    const ancestors = new Set<string>();
    let current = nodes.find((node) => node.handle === handle);
    while (current?.parentHandle) {
      ancestors.add(current.parentHandle);
      current = nodes.find((node) => node.handle === current?.parentHandle);
    }
    setCollapsedHandles((collapsed) => {
      const next = new Set([...collapsed].filter((candidate) => !ancestors.has(candidate)));
      return next.size === collapsed.size ? collapsed : next;
    });
    setSelectedHandle(handle);
  };
  const toggle = (handle: string) => {
    setCollapsedHandles((current) => {
      const next = new Set(current);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  };

  return (
    <main
      aria-label="조직"
      // 구조 패널과 지도 컬럼을 50:50으로 둡니다. 지도가 좁아 노드가 겹치던 것을 펴줍니다.
      className="col-span-3 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-canvas"
    >
      {/* 본문 = 구조(A). 읽는 화면입니다: 부서는 상자, 구성원은 칩. */}
      <section aria-label="조직 구조" className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border">
        <header className="flex items-center gap-2 border-b border-border px-5">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em]">조직</h1>
          {organization?.version === undefined ? null : (
            <span className="font-mono text-[11px] text-muted">v{organization.version}</span>
          )}
        </header>
        <div ref={structureRef} className="min-h-0 overflow-y-auto px-5 py-4">
          {error ? <SurfaceError message={error} /> : null}
          {!organization && !error ? <SurfaceLoading /> : null}
          {organization && nodes.length === 0 ? (
            <p className="text-sm text-muted">조직에 아직 아무도 없습니다.</p>
          ) : null}
          {root ? (
            <div className="mx-auto max-w-[720px]">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">영속 조직</p>
              <OrgUnit
                node={root}
                all={nodes}
                collapsedHandles={collapsedHandles}
                depth={0}
                selectedHandle={selected?.handle}
                onSelect={select}
                onToggle={toggle}
              />
              {workTeams.length > 0 ? (
                <>
                  <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                    지금 편성된 임시 팀 · {workTeams.length}
                  </p>
                  <div className="space-y-2">
                    {workTeams.map((team) => (
                      <OrgTempTeam
                        key={team.handle}
                        team={team}
                        all={nodes}
                        selected={team.handle === selected?.handle}
                        onSelect={select}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* 우측 = 지도(B) + 선택 노드 상세. 지도는 라벨이 아니라 모양과 "지금 여기"를 읽습니다. */}
      <aside aria-label="조직 지도" className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)_minmax(0,1fr)] bg-chrome">
        <header className="flex items-center border-b border-border px-3">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted">지도</h2>
          <span className="ml-auto text-[10px] text-muted">눌러서 이동</span>
        </header>
        <div className="min-h-0 border-b border-border">
          {nodes.length > 0 ? (
            <MapBoundary>
              <OrgMap nodes={nodes} selectedHandle={selected?.handle} onSelect={select} />
            </MapBoundary>
          ) : null}
        </div>
        <div className="min-h-0 overflow-y-auto px-3 py-3">
          {selected && identity ? (
            <>
              <div className="flex items-center gap-2">
                <AgentAvatar speaker={speakerOf(selected)} />
                <span className="text-[13px] font-medium">{identity.name}</span>
                <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                  {roleTextOf(selected)}
                </span>
                <span className="ml-auto text-[11px] text-muted">{nodeStatusLabel(selected.status)}</span>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-secondary">{selected.responsibility}</p>
              <ul className="mt-3 divide-y divide-border border-y border-border">
                <li className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2 py-2">
                  <span className="text-[11px] text-muted">직책</span>
                  <span className="text-[12px] text-primary">{nodeRoleTextOf(selected.role)}</span>
                </li>
                <li className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2 py-2">
                  <span className="text-[11px] text-muted">위</span>
                  <span className="text-[12px] text-primary">
                    {parent === undefined ? "없음 — 꼭대기" : agentIdentityToken(parent.handle).name}
                  </span>
                </li>
                <li className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2 py-2">
                  <span className="text-[11px] text-muted">아래</span>
                  <span className="text-[12px] text-primary">
                    {children.length === 0
                      ? "없음"
                      : children.map((child) => agentIdentityToken(child.handle).name).join(" · ")}
                  </span>
                </li>
                <li className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2 py-2">
                  <span className="text-[11px] text-muted">기간</span>
                  <span className="text-[12px] text-primary">{scopeTextOf(selected.scope)}</span>
                </li>
              </ul>
              {extraCapabilitiesOf(selected).length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">더해진 역량</p>
                  <p className="mt-1 text-[12px] leading-5 text-primary">{extraCapabilitiesOf(selected).join(" · ")}</p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-[11px] leading-4 text-muted">
              구조나 지도에서 하나를 누르면 그 자리·소속·머무는 기간을 봅니다. 편성·분리·병합은 계약에 명령이 열리면 이
              지도에서 하게 됩니다.
            </p>
          )}
        </div>
      </aside>
    </main>
  );
}

// ── 조직 구조 (A) ─────────────────────────────────────────────────
function hasNestedNodes(node: OrganizationNodeView, all: readonly OrganizationNodeView[]): boolean {
  return all.some((candidate) => candidate.parentHandle === node.handle && candidate.scope !== "work");
}
function unitWordOf(node: OrganizationNodeView): string {
  return node.role === "orchestrator" ? "총괄" : "조율";
}

function OrgUnit({
  node,
  all,
  collapsedHandles,
  depth,
  selectedHandle,
  onSelect,
  onToggle,
}: {
  node: OrganizationNodeView;
  all: readonly OrganizationNodeView[];
  collapsedHandles: ReadonlySet<string>;
  depth: number;
  selectedHandle: string | undefined;
  onSelect: (handle: string) => void;
  onToggle: (handle: string) => void;
}) {
  const token = agentIdentityToken(node.handle, roleTextOf(node));
  const children = all.filter((candidate) => candidate.parentHandle === node.handle && candidate.scope !== "work");
  const members = children.filter((child) => !hasNestedNodes(child, all));
  const subUnits = children.filter((child) => hasNestedNodes(child, all));
  const selected = node.handle === selectedHandle;
  const collapsed = collapsedHandles.has(node.handle);
  return (
    <div
      className="rounded-[7px] border border-border"
      style={{ background: depth === 0 ? "var(--bg-2)" : "var(--bg-1)" }}
    >
      <div className="flex items-stretch border-b border-border">
        <button
          aria-pressed={selected}
          data-node={node.handle}
          className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left outline-none ${selected ? "bg-surface-2" : "hover:bg-surface-1"}`}
          onClick={() => {
            onSelect(node.handle);
          }}
          type="button"
        >
          <AgentAvatar speaker={speakerOf(node)} />
          <span className="text-[13px] font-medium">{token.name}</span>
          <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">{unitWordOf(node)}</span>
          <span className="truncate text-[11px] text-muted">{roleTextOf(node)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {[
              members.length > 0 ? `구성원 ${String(members.length)}` : "",
              subUnits.length > 0 ? `하위 단위 ${String(subUnits.length)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        {children.length > 0 ? (
          <button
            aria-expanded={!collapsed}
            aria-label={`${token.name} 하위 ${collapsed ? "펼치기" : "접기"}`}
            className="mx-1 my-1 flex w-7 shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-surface-2 hover:text-primary"
            onClick={() => {
              onToggle(node.handle);
            }}
            type="button"
          >
            {collapsed ? <CaretRight aria-hidden="true" size={14} /> : <CaretDown aria-hidden="true" size={14} />}
          </button>
        ) : null}
      </div>
      {!collapsed && members.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 p-2.5">
          {members.map((member) => {
            const active = member.handle === selectedHandle;
            return (
              <button
                key={member.handle}
                aria-pressed={active}
                data-node={member.handle}
                className={`inline-flex items-center gap-1.5 rounded-[5px] border py-1 pl-1.5 pr-2 text-[12px] outline-none ${active ? "border-control bg-surface-2" : "border-border bg-surface-1 hover:border-control"}`}
                onClick={() => {
                  onSelect(member.handle);
                }}
                type="button"
              >
                <AgentAvatar speaker={speakerOf(member)} />
                <span className="font-medium">{agentIdentityToken(member.handle).name}</span>
                <span className="text-[11px] text-muted">{roleTextOf(member)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!collapsed && subUnits.length > 0 ? (
        <div
          className="space-y-2 py-2 pl-3 pr-2.5"
          style={{ borderLeft: "2px solid var(--line-strong)", marginLeft: 14 }}
        >
          {subUnits.map((child) => (
            <OrgUnit
              key={child.handle}
              node={child}
              all={all}
              collapsedHandles={collapsedHandles}
              depth={depth + 1}
              selectedHandle={selectedHandle}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OrgTempTeam({
  team,
  all,
  selected,
  onSelect,
}: {
  team: OrganizationNodeView;
  all: readonly OrganizationNodeView[];
  selected: boolean;
  onSelect: (handle: string) => void;
}) {
  const parent = all.find((node) => node.handle === team.parentHandle);
  return (
    <button
      aria-pressed={selected}
      data-node={team.handle}
      className={`block w-full rounded-[7px] border border-dashed border-agent-provisional px-3 py-2.5 text-left outline-none ${selected ? "bg-surface-1" : "hover:bg-surface-1"}`}
      onClick={() => {
        onSelect(team.handle);
      }}
      type="button"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar speaker={speakerOf(team)} />
        <span className="text-[13px] font-medium">{agentIdentityToken(team.handle).name}</span>
        <span className="text-[11px] text-muted">{team.name}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted">
        {parent ? `${agentIdentityToken(parent.handle).name} 아래 편성 · ` : ""}업무가 끝나면 사라집니다
      </p>
    </button>
  );
}

// ── 조직 지도 (B) ─────────────────────────────────────────────────

const ORG_MAP_NODE_W = 132;
const ORG_MAP_ROW_H = 74;

function OrgMapNode({
  data,
}: {
  data: { node: OrganizationNodeView; selected: boolean; unit: boolean; onSelect: (handle: string) => void };
}) {
  const { node, selected, unit, onSelect } = data;
  const name = agentIdentityToken(node.handle).name;
  return (
    <div
      className="rounded-[6px] p-0.5"
      style={{
        outline: selected ? "2px solid var(--focus-ring)" : "none",
        outlineOffset: 1,
        border: unit && node.scope !== "work" ? "1px solid var(--agent-4)" : "1px solid transparent",
        borderRadius: 7,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <button
        aria-label={`지도에서 ${name} 선택`}
        aria-pressed={selected}
        className="nopan block rounded-[5px]"
        onClick={() => {
          onSelect(node.handle);
        }}
        type="button"
      >
        <AgentAvatar speaker={speakerOf(node)} />
      </button>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const orgMapNodeTypes = { orgMap: OrgMapNode };

function OrgMap({
  nodes,
  selectedHandle,
  onSelect,
}: {
  nodes: readonly OrganizationNodeView[];
  selectedHandle: string | undefined;
  onSelect: (handle: string) => void;
}) {
  const flow = useRef<ReactFlowInstance>(null);
  const { rfNodes, rfEdges } = useMemo(() => {
    const childrenOf = (handle: string) => nodes.filter((node) => node.parentHandle === handle);
    const pos = new Map<string, { x: number; y: number }>();
    let cursor = 0;
    const place = (node: OrganizationNodeView, depth: number): number => {
      const kids = childrenOf(node.handle);
      let x: number;
      if (kids.length === 0) {
        x = cursor * ORG_MAP_NODE_W;
        cursor += 1;
      } else {
        const xs = kids.map((kid) => place(kid, depth + 1));
        const first = xs[0] ?? 0;
        const last = xs[xs.length - 1] ?? first;
        x = (first + last) / 2;
      }
      pos.set(node.handle, { x, y: depth * ORG_MAP_ROW_H });
      return x;
    };
    const rootNode = nodes.find((node) => node.parentHandle === undefined);
    if (rootNode) place(rootNode, 0);
    const rfNodes: RFNode[] = nodes.map((node) => ({
      id: node.handle,
      type: "orgMap",
      position: pos.get(node.handle) ?? { x: 0, y: 0 },
      data: { node, selected: node.handle === selectedHandle, unit: hasNestedNodes(node, nodes), onSelect },
      draggable: false,
      selectable: true,
    }));
    const rfEdges: RFEdge[] = nodes
      .filter((node) => node.parentHandle !== undefined)
      .map((node) => ({
        id: `${node.parentHandle ?? ""}-${node.handle}`,
        source: node.parentHandle ?? "",
        target: node.handle,
        type: "smoothstep",
        style: {
          stroke: node.scope === "work" ? "var(--agent-provisional)" : "var(--line-strong)",
          strokeDasharray: node.scope === "work" ? "4 4" : undefined,
          strokeWidth: 1.5,
        },
      }));
    return { rfNodes, rfEdges };
  }, [nodes, onSelect, selectedHandle]);

  useEffect(() => {
    if (!selectedHandle || !flow.current) return;
    const selected = rfNodes.find((node) => node.id === selectedHandle);
    if (!selected) return;
    void flow.current.setCenter(selected.position.x + 12, selected.position.y + 12, {
      duration: 180,
      zoom: Math.max(flow.current.getZoom(), 0.65),
    });
  }, [rfNodes, selectedHandle]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={orgMapNodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.3}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
      onInit={(instance) => {
        flow.current = instance;
      }}
    >
      <Background color="var(--line)" gap={20} />
    </ReactFlow>
  );
}

/**
 * 배지에 들어가는 짧은 역할 문구.
 *
 * 내장 노드는 AGENT_ROLES의 표준 문구를 씁니다 — `Reflection, 개선안 평가…`의 첫 구절을 쓰면
 * "Reflection"만 남습니다. 하지만 scope:"work"로 편성된 동적 노드는 AGENT_ROLES에 없어
 * roleLabel이 handle로 떨어지므로(`quant-analysis`), 그때만 책임 첫 구절을 씁니다.
 */
function roleTextOf(node: OrganizationNodeView): string {
  const token = agentIdentityToken(node.handle);
  if (token.builtin) return token.roleLabel;
  return node.responsibility.split(",")[0]?.trim() || token.roleLabel;
}

function speakerOf(node: OrganizationNodeView): SpeakerView {
  const token = agentIdentityToken(node.handle, roleTextOf(node));
  return {
    handle: token.handle,
    name: token.name,
    initial: token.initial,
    accentSlot: token.accentSlot,
    role: token.roleLabel,
    // scope:"work" 노드는 채우지 않고 점선으로만 그립니다. 협업방과 같은 문법입니다.
    ...(node.scope === "work" ? { provisional: true } : {}),
  };
}

/** NodeRole. room.tsx의 표와 같은 값을 쓰지만 여기서는 "직책"으로 읽힙니다. */
function nodeRoleTextOf(role: string): string {
  const labels: Record<string, string> = { orchestrator: "총괄", coordinator: "조율", operator: "실행" };
  return labels[role] ?? role;
}

function nodeStatusLabel(status: string): string {
  const labels: Record<string, string> = { active: "일하는 중", inactive: "쉬는 중", retired: "물러남" };
  return labels[status] ?? status;
}

function scopeTextOf(scope: OrganizationNodeView["scope"]): string {
  if (scope === "work") return "이 업무가 끝나면 사라집니다";
  if (scope === "persistent") return "조직에 계속 남습니다";
  // 계약이 scope를 주지 않습니다. 모르는 것을 "영속"으로 단정하면 임시 팀이 영구로 보입니다.
  return "알 수 없습니다 — 계약이 범위를 알려주지 않습니다";
}

/**
 * 노드 자신을 가리키는 capability(handle과 1:1, 또는 representative의 request-coordination)를
 * 뺀 나머지. 여기 남는 것이 Extension·전문 조직이 실제로 더한 역량입니다.
 */
function extraCapabilitiesOf(node: OrganizationNodeView): readonly string[] {
  const own = new Set([node.handle, "request-coordination"]);
  return node.capabilities.filter((capability) => !own.has(capability));
}
