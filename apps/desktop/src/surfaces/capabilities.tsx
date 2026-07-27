import { agentIdentityToken } from "@massion/application/client";
import { useEffect, useState, type ReactNode } from "react";

import type {
  CommandIdentity,
  DesktopService,
  ExtensionEntryView,
  OrganizationNodeView,
  PermissionKind,
  ContributionKind,
} from "@/desktop-service";
import { projectManifestDeclarations } from "@/desktop-service";
import type { ApprovalView } from "@/model";

import { DecisionActions } from "@/room";
import { SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

export type AwaitingRegistryInstall = {
  identity: CommandIdentity;
  request: Record<string, unknown>;
  approvalId: string;
};

/**
 * 헌법 4.11이 세는 Capability 종류. `ExtensionContributionDeclaration`
 * (`packages/extension-sdk/src/contracts.ts:27`)의 키를 사람의 말로 옮깁니다.
 * 순서가 곧 화면 순서이며, 조직에 무엇이 늘어나는지 큰 것부터 말합니다.
 */
const contributionLabel: Record<ContributionKind, string> = {
  runtimeTools: "도구",
  organizationTemplates: "전문 조직",
  skills: "Skill",
  surfaceConnectors: "외부 연결",
  growthSignals: "개선 신호",
  growthTargets: "개선 대상",
  eventConsumers: "사건 구독",
  modelEvaluationBundles: "모델 평가 번들",
};

const contributionDescription: Record<ContributionKind, string> = {
  runtimeTools: "실행 중 호출할 수 있는 도구",
  organizationTemplates: "편성할 수 있는 전문 조직",
  skills: "노드에 붙일 수 있는 Skill",
  surfaceConnectors: "요청과 결과가 오가는 외부 표면",
  growthSignals: "개선 평가가 읽는 신호",
  growthTargets: "개선이 바꿀 수 있는 대상",
  eventConsumers: "사건을 받아 도는 구독자",
  modelEvaluationBundles: "모델 평가에 쓰는 번들",
};

/** `ExtensionPermissionDeclaration`(같은 파일 `:16`). 확장이 **요구하는** 것이라 승인 판단의 근거입니다. */
const permissionLabel: Record<PermissionKind, string> = {
  tools: "도구 호출",
  network: "네트워크",
  files: "파일",
  secrets: "비밀 값",
  process: "프로세스 실행",
  mcp: "MCP 서버",
  storage: "저장 공간",
  events: "사건 수신",
};

const permissionDescription: Record<PermissionKind, string> = {
  tools: "다른 확장이 등록한 도구를 호출합니다",
  network: "이 호스트로 나가는 요청",
  files: "이 경로를 읽고 씁니다",
  secrets: "이 비밀 값을 꺼내 씁니다",
  process: "이 프로세스를 실행합니다",
  mcp: "이 MCP 서버에 붙습니다",
  storage: "확장 전용 저장 공간을 씁니다",
  events: "이 사건을 받습니다",
};

const nodeRoleLabel: Record<string, string> = {
  orchestrator: "총괄",
  coordinator: "조율",
  operator: "실행",
};

const provenanceLabel: Record<string, string> = {
  official: "공식",
  verified: "검증됨",
  community: "커뮤니티",
};

export function ExtensionSurface({
  approval,
  approvalBusy,
  awaitingInstall,
  onAwaitingInstallChange,
  onDecideApproval,
  service,
}: {
  approval: ApprovalView | undefined;
  approvalBusy: boolean;
  awaitingInstall: AwaitingRegistryInstall | undefined;
  onAwaitingInstallChange: (value: AwaitingRegistryInstall | undefined) => void;
  onDecideApproval: (approval: ApprovalView, vote: "approve" | "reject") => Promise<void>;
  service: DesktopService;
}) {
  const [entries, setEntries] = useState<readonly ExtensionEntryView[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<RegistryDetail>();
  const [organizationNodes, setOrganizationNodes] = useState<readonly OrganizationNodeView[]>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void service
      .loadExtensions()
      .then((value) => {
        if (disposed) return;
        setEntries(value);
        setSelectedId((current) => current ?? value[0]?.id);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "확장 목록을 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  useEffect(() => {
    let disposed = false;
    void service
      .loadOrganization()
      .then(({ nodes }) => {
        if (!disposed) setOrganizationNodes(nodes);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [service]);

  const all = entries ?? [];
  const selected = all.find((item) => item.id === selectedId);
  const governanceNode = organizationNodes?.find((node) => node.capabilities.includes("governance"));
  const organizationRows =
    organizationNodes?.flatMap((node) =>
      node.status === "active" ? node.capabilities.map((capability) => ({ capability, node })) : [],
    ) ?? [];
  const organizationNodeCount = organizationNodes?.filter(
    (node) => node.status === "active" && node.capabilities.length > 0,
  ).length;

  // 마켓플레이스 항목의 Capability는 registry.info의 manifest에만 있습니다. 고를 때 채웁니다.
  const declarations =
    selected === undefined
      ? undefined
      : selected.contributions.length > 0 || selected.permissions.length > 0
        ? { contributions: selected.contributions, permissions: selected.permissions }
        : projectManifestDeclarations(detail?.version?.manifest);

  const select = async (item: ExtensionEntryView) => {
    setSelectedId(item.id);
    setError("");
    setDetail(undefined);
    if (item.installed) return;
    setBusy(item.id);
    try {
      setDetail(registryDetail(await service.loadRegistryInfo(item.id)));
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "확장 상세 정보를 불러오지 못했습니다."));
    } finally {
      setBusy("");
    }
  };

  const install = async (versionId: string) => {
    setBusy(`install:${versionId}`);
    setError("");
    setNotice("");
    try {
      const request = { versionId, environment: "production", riskClass: "medium", executionId: crypto.randomUUID() };
      const identity = { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
      const result = await service.installRegistry(request, identity);
      const waiting = result.outcome === "awaiting-approval" && result.approvalId !== undefined;
      onAwaitingInstallChange(
        waiting && result.approvalId ? { identity, request, approvalId: result.approvalId } : undefined,
      );
      setNotice(
        waiting
          ? "설치가 승인을 기다립니다."
          : result.installationId
            ? "설치를 요청했습니다."
            : `설치 결과: ${result.outcome}`,
      );
      setEntries(await service.loadExtensions());
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "설치를 요청하지 못했습니다."));
    } finally {
      setBusy("");
    }
  };

  return (
    <main
      aria-label="확장"
      className="col-span-3 grid min-h-0 min-w-0 grid-rows-[48px_32px_32px_minmax(0,1fr)_32px] bg-bg-0"
    >
      <header className="flex min-w-0 items-center gap-3 border-b border-line-strong px-4">
        <h1 className="shrink-0 text-[15px] font-semibold leading-6 tracking-[-0.008em] text-fg-2">확장</h1>
        <span className="shrink-0 text-[13px] leading-5 tabular-nums text-fg-4">{all.length}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {all.map((item) => (
            <button
              aria-label={extensionDisplayName(item.packageName)}
              aria-pressed={item.id === selectedId}
              className={`flex h-[30px] shrink-0 items-center gap-2 rounded-[4px] px-2.5 text-[13px] leading-5 tracking-[-0.005em] transition-colors duration-150 ${
                item.id === selectedId ? "bg-white/[0.047] text-fg" : "text-fg-2 hover:bg-white/[0.027]"
              }`}
              key={item.id}
              onClick={() => {
                void select(item);
              }}
              type="button"
            >
              <span className={item.installed ? "text-fg-3" : "text-fg-4"}>{item.installed ? "◉" : "○"}</span>
              <span className="truncate">{extensionDisplayName(item.packageName)}</span>
              <span className="font-mono text-[11px] text-fg-4">{item.version}</span>
            </button>
          ))}
        </div>
        {organizationNodes !== undefined ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <span className="text-[12px] text-fg-4">조직 능력</span>
            <span className="text-[13px] tabular-nums text-fg-2">{organizationRows.length}</span>
            <span className="px-1 text-[12px] text-fg-4">·</span>
            <span className="text-[12px] text-fg-4">노드</span>
            <span className="text-[13px] tabular-nums text-fg-2">{organizationNodeCount}</span>
          </div>
        ) : null}
        {selected && !selected.installed ? (
          <button
            className="h-[30px] shrink-0 rounded-[4px] bg-gate px-3 text-[13px] font-medium leading-5 text-gate-ink disabled:opacity-50"
            disabled={busy !== ""}
            onClick={() => {
              void install(selected.id);
            }}
            type="button"
          >
            {busy === `install:${selected.id}` ? "요청 중" : "설치"}
          </button>
        ) : null}
      </header>

      <div className="flex min-w-0 items-center gap-2 border-b border-line px-4">
        {selected ? (
          <>
            <h2 className="truncate text-[17px] font-semibold leading-[26px] tracking-[-0.012em] text-fg">
              {extensionDisplayName(selected.packageName)}
            </h2>
            <span className="shrink-0 font-mono text-[11px] text-fg-4">{selected.version}</span>
            {selected.installed ? (
              <span className="shrink-0 text-[13px] leading-5 tracking-[-0.005em] text-fg-3">
                {extensionStateLabel(selected.state)}
              </span>
            ) : null}
            {selected.description ? (
              <span className="ml-auto min-w-0 truncate text-[13px] leading-5 tracking-[-0.005em] text-fg-3">
                {selected.description}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2 border-b border-line px-4 text-[13px] leading-5 tracking-[-0.005em]">
        {governanceNode ? (
          <>
            <span className="text-[12px] text-fg-4">요청</span>
            <span className="font-mono text-[11px] text-fg-3">{selected?.packageName}</span>
            <span className="text-[12px] text-fg-4">→</span>
            <span className="text-[12px] text-fg-4">부여 판정</span>
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: `var(--agent-${agentRailSlot(governanceNode.handle)})` }}
            />
            <span className="shrink-0 text-[13px] font-medium text-fg-2">{governanceNode.name}</span>
            <span className="min-w-0 truncate text-[13px] text-fg-3">{governanceNode.responsibility}</span>
            <span className="ml-auto shrink-0 text-[13px] text-fg-3">설치·권한·활성화는 사람이 통제합니다</span>
          </>
        ) : null}
      </div>

      <div className="min-h-0 overflow-y-auto">
        {awaitingInstall ? (
          <section aria-label="설치 승인" className="flex h-16 items-center gap-2 border-b border-gate-border bg-gate-wash px-4">
            <span className="text-[14px] text-gate">◇</span>
            <span className="text-[13px] leading-5 tracking-[-0.005em] text-gate">설치가 승인을 기다립니다.</span>
            <span className="font-mono text-[11px] text-fg-4">{awaitingInstall.approvalId}</span>
            {approval === undefined ? (
              <span className="ml-auto text-[12px] text-fg-4">승인 정보를 불러오는 중입니다</span>
            ) : (
              <div className="ml-auto flex shrink-0 items-center">
                <DecisionActions
                  approveName={approval.title}
                  busy={approvalBusy}
                  disabled={approvalBusy}
                  onApprove={() => {
                    void onDecideApproval(approval, "approve");
                  }}
                  onReject={() => {
                    void onDecideApproval(approval, "reject");
                  }}
                />
              </div>
            )}
          </section>
        ) : null}

        {error ? <p role="alert" className="px-4 py-3 text-[13px] leading-5 tracking-[-0.005em] text-fg-3">{error}</p> : null}
        {entries === undefined && !error ? <SurfaceLoading /> : null}
        {selected ? (
          <div className="min-w-0 pb-4">
            <div className="grid min-w-0 grid-cols-2">
              <section aria-label="조직이 무엇을 할 수 있게 되나" className="min-w-0">
                <GroupHeader label="조직이 무엇을 할 수 있게 되나" count={contributionRows(declarations).length} />
                {declarations && declarations.contributions.length > 0 ? (
                  <div className="grid gap-0.5">
                    {contributionRows(declarations).map((row, index) => (
                      <LedgerRow
                        description={row.description}
                        glyph={selected.installed ? "◉" : "○"}
                        glyphClassName={selected.installed ? "text-fg-3" : "text-fg-4"}
                        identifier={row.item}
                        identifierWidth="w-[232px]"
                        key={`${row.kind}-${index}`}
                        name={row.name}
                        nameWidth="w-[208px]"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-[30px] items-center px-4 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
                    {busy === selected.id
                      ? "선언을 읽는 중…"
                      : "이 확장이 조직에 무엇을 더하는지 계약이 알려주지 않습니다. 설치 레코드만 있습니다."}
                  </div>
                )}
              </section>

              <section aria-label="이 확장이 요구하는 것" className="min-w-0 border-l border-line">
                <GroupHeader label="이 확장이 요구하는 것" count={permissionRows(declarations).length} />
                {declarations && declarations.permissions.length > 0 ? (
                  <div className="grid gap-0.5">
                    {permissionRows(declarations).map((row, index) => (
                      <LedgerRow
                        description={row.description}
                        glyph={selected.installed ? "◉" : "○"}
                        glyphClassName={selected.installed ? "text-fg-3" : "text-fg-4"}
                        identifier={row.item}
                        identifierWidth="w-[232px]"
                        key={`${row.kind}-${index}`}
                        name={row.name}
                        nameWidth="w-[208px]"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-[30px] items-center px-4 text-[13px] leading-5 tracking-[-0.005em] text-fg-4">
                    선언된 권한이 없습니다.
                  </div>
                )}
              </section>
            </div>

            {organizationNodes !== undefined ? (
              <section aria-label="조직이 이미 보유한 것" className="border-t border-line">
                <GroupHeader label="조직이 이미 보유한 것" count={organizationRows.length} />
                <div className="grid gap-0.5">
                  {organizationRows.map(({ capability, node }) => {
                    const parent = node.parentHandle
                      ? organizationNodes.find((candidate) => candidate.handle === node.parentHandle)
                      : undefined;
                    return (
                      <LedgerRow
                        description={node.responsibility}
                        glyph="●"
                        glyphClassName="text-fg-3"
                        identifier={capability}
                        identifierWidth="w-[232px]"
                        key={`${node.handle}-${capability}`}
                        meta={
                          <span className="text-[12px] text-fg-4">
                            {`${nodeRoleLabel[node.role] ?? node.role}${parent ? ` · ${parent.name}` : ""}`}
                          </span>
                        }
                        name={node.name}
                        nameWidth="w-[208px]"
                        railSlot={agentRailSlot(node.handle)}
                      />
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="flex min-w-0 shrink-0 items-center gap-2 border-t border-line-strong px-4">
        {selected ? (
          <>
            <span className="shrink-0 text-[12px] text-fg-4">출처</span>
            {provenanceLabel[selected.provenance] ? (
              <span className="shrink-0 text-[13px] leading-5 tracking-[-0.005em] text-fg-2">
                {provenanceLabel[selected.provenance]}
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-[11px] text-fg-4">{selected.packageName}</span>
            {notice && !awaitingInstall ? <span className="min-w-0 flex-1 truncate text-[13px] text-gate">{notice}</span> : null}
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-[12px] text-fg-4">확장이 대체할 수 없는 것</span>
          <span className="text-[13px] leading-5 tracking-[-0.005em] text-fg-3">승인 · 실행 기록 · 기억 권위 · 조직 거버넌스</span>
        </div>
      </footer>
    </main>
  );
}

type DeclarationRows = Pick<ExtensionEntryView, "contributions" | "permissions">;
type DeclarationRow = {
  readonly kind: ContributionKind | PermissionKind;
  readonly item: string;
  readonly name: string;
  readonly description: string;
};

function contributionRows(declarations: DeclarationRows | undefined): readonly DeclarationRow[] {
  return (
    declarations?.contributions.flatMap(({ kind, items }) =>
      items.map((item, index) => ({
        kind,
        item,
        name: index === 0 ? contributionLabel[kind] : "",
        description: index === 0 ? contributionDescription[kind] : "",
      })),
    ) ?? []
  );
}

function permissionRows(declarations: DeclarationRows | undefined): readonly DeclarationRow[] {
  return (
    declarations?.permissions.flatMap(({ kind, items }) =>
      items.map((item, index) => ({
        kind,
        item,
        name: index === 0 ? permissionLabel[kind] : "",
        description: index === 0 ? permissionDescription[kind] : "",
      })),
    ) ?? []
  );
}

function agentRailSlot(handle: string): number {
  const slot = agentIdentityToken(handle).accentSlot;
  return slot >= 0 && slot <= 7 ? slot : 0;
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-[30px] items-center gap-2 px-4 text-[13px] leading-5 tracking-[-0.005em] text-fg-3">
      <span aria-hidden="true" className="h-3.5 w-0.5 shrink-0" />
      <span aria-hidden="true" className="w-3.5 shrink-0" />
      <span>{label}</span>
      {count > 0 ? <span className="tabular-nums text-fg-4">{count}</span> : null}
    </div>
  );
}

function LedgerRow({
  description,
  glyph,
  glyphClassName,
  identifier,
  identifierWidth,
  meta,
  name,
  nameWidth,
  railSlot,
}: {
  description: ReactNode;
  glyph: string;
  glyphClassName: string;
  identifier: string;
  identifierWidth: string;
  meta?: ReactNode;
  name: string;
  nameWidth: string;
  railSlot?: number;
}) {
  return (
    <div className="flex h-[30px] min-w-0 items-center gap-2 px-4 transition-colors duration-150 hover:bg-white/[0.027]">
      {railSlot === undefined ? (
        <span aria-hidden="true" className="h-3.5 w-0.5 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className="h-3.5 w-0.5 shrink-0 rounded-full"
          style={{ background: `var(--agent-${railSlot})` }}
        />
      )}
      <span className={`flex size-3.5 shrink-0 items-center justify-center text-[14px] leading-5 ${glyphClassName}`}>
        {glyph}
      </span>
      <span className={`${nameWidth} shrink-0 truncate text-[13px] leading-5 tracking-[-0.005em] text-fg-2`}>{name}</span>
      <span className={`${identifierWidth} shrink-0 truncate font-mono text-[11px] text-fg-3`}>{identifier}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-[-0.005em] text-fg-3">{description}</span>
      {meta ? <span className="w-[260px] shrink-0 truncate">{meta}</span> : null}
    </div>
  );
}

/** `@massion-ext/github` → `github`. 패키지 이름은 식별자이므로 제목 자리에서는 접두어를 뗍니다. */
function extensionDisplayName(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash < 0 ? packageName : packageName.slice(slash + 1);
}

/** ExtensionRuntimeState 6종(`packages/extension-host/src/capability-broker.ts:10`). */
function extensionStateLabel(state: string | undefined): string {
  const labels: Record<string, string> = {
    starting: "시작 중",
    healthy: "동작 중",
    draining: "정리 중",
    stopped: "멈춤",
    failed: "실패",
    blocked: "차단됨",
  };
  return state === undefined ? "설치됨" : (labels[state] ?? state);
}

interface RegistryVersionDetail {
  readonly packageVersion?: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly ownerOrganizationId?: string;
  readonly assessment?: { readonly provenance?: string };
  readonly manifest?: Record<string, unknown>;
}
interface RegistryDetail {
  readonly version?: RegistryVersionDetail;
}
function registryDetail(value: unknown): RegistryDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const candidate = source.version;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const version = candidate as Record<string, unknown>;
  const manifest =
    version.manifest && typeof version.manifest === "object" && !Array.isArray(version.manifest)
      ? (version.manifest as Record<string, unknown>)
      : undefined;
  const assessment =
    version.assessment && typeof version.assessment === "object" && !Array.isArray(version.assessment)
      ? (version.assessment as Record<string, unknown>)
      : undefined;
  return {
    version: {
      ...(typeof version.packageVersion === "string" ? { packageVersion: version.packageVersion } : {}),
      ...(manifest && typeof manifest.description === "string" ? { description: manifest.description } : {}),
      ...(typeof version.visibility === "string" ? { visibility: version.visibility } : {}),
      ...(typeof version.ownerOrganizationId === "string" ? { ownerOrganizationId: version.ownerOrganizationId } : {}),
      ...(assessment && typeof assessment.provenance === "string"
        ? { assessment: { provenance: assessment.provenance } }
        : {}),
      ...(manifest ? { manifest } : {}),
    },
  };
}
