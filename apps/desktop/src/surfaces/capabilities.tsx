import { useEffect, useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  CommandIdentity,
  DesktopService,
  ExtensionEntryView,
  PermissionKind,
  ContributionKind,
} from "@/desktop-service";
import { projectManifestDeclarations } from "@/desktop-service";
import type { ApprovalView } from "@/model";

import { DecisionActions } from "@/room";
import { GrowthSection, SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"installed" | "all">("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<RegistryDetail>();
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

  const all = entries ?? [];
  const installedCount = all.filter((item) => item.installed).length;
  const normalized = query.trim().toLocaleLowerCase("ko");
  const visible = all.filter(
    (item) =>
      (filter === "all" || item.installed) &&
      (normalized.length === 0 ||
        `${item.packageName} ${item.description}`.toLocaleLowerCase("ko").includes(normalized)),
  );
  const selected = all.find((item) => item.id === selectedId);

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
      className="col-span-3 grid min-h-0 min-w-0 grid-cols-[242px_minmax(0,1fr)_300px] bg-canvas min-[1440px]:grid-cols-[264px_minmax(0,1fr)_332px]"
    >
      <section
        aria-label="확장 목록"
        className="grid min-h-0 grid-rows-[46px_auto_minmax(0,1fr)] border-r border-border bg-chrome"
      >
        <header className="flex items-center gap-2 border-b border-border px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em]">확장</h1>
          <span className="font-mono text-[11px] text-muted">{installedCount}</span>
        </header>
        <div className="grid gap-2 border-b border-border px-2.5 py-2.5">
          <input
            aria-label="확장 검색"
            className="h-7 w-full rounded-[5px] border border-border bg-canvas px-2.5 text-[12px] outline-none placeholder:text-muted focus:border-control"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="이름 또는 설명 검색"
            value={query}
          />
          {/* 업무·개선과 같은 자리, 같은 모양의 필터입니다. */}
          <Tabs
            onValueChange={(value) => {
              setFilter(value as "installed" | "all");
            }}
            value={filter}
          >
            <TabsList aria-label="확장 범위" className="gap-1">
              <TabsTrigger
                className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
                value="all"
              >
                전체 {all.length}
              </TabsTrigger>
              <TabsTrigger
                className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
                value="installed"
              >
                설치됨 {installedCount}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {entries === undefined && !error ? <SurfaceLoading /> : null}
          {entries !== undefined && visible.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted">
              {all.length === 0 ? "설치된 확장도, 받을 수 있는 확장도 없습니다." : "검색과 일치하는 확장이 없습니다."}
            </p>
          ) : (
            <div className="divide-y divide-border border-b border-border">
              {visible.map((item) => (
                <button
                  aria-pressed={item.id === selectedId}
                  className={`relative w-full px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                    item.id === selectedId
                      ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                      : "hover:bg-surface-1"
                  }`}
                  key={item.id}
                  onClick={() => {
                    void select(item);
                  }}
                  type="button"
                >
                  <span className="block truncate text-[13px] font-medium">
                    {extensionDisplayName(item.packageName)}
                  </span>
                  <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]">
                    <span className={item.installed ? "text-secondary" : "text-muted"}>
                      {item.installed
                        ? `● ${extensionStateLabel(item.state)}`
                        : `○ ${provenanceLabel[item.provenance] ?? "받을 수 있음"}`}
                    </span>
                    <span className="shrink-0 font-mono text-muted">{item.version}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border">
        <header className="flex items-center gap-2 border-b border-border px-5">
          {selected ? (
            <>
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
                {extensionDisplayName(selected.packageName)}
              </h2>
              <span className="shrink-0 font-mono text-[11px] text-muted" title={selected.packageName}>
                {selected.version}
              </span>
              <span className="flex-1" />
              {selected.installed ? (
                <span className="shrink-0 text-[11px] text-secondary">{extensionStateLabel(selected.state)}</span>
              ) : (
                <button
                  className="shrink-0 rounded-[5px] bg-gate px-3 py-1 text-[12px] font-medium text-gate-ink hover:brightness-110 disabled:opacity-50"
                  disabled={busy !== ""}
                  onClick={() => {
                    void install(selected.id);
                  }}
                  type="button"
                >
                  {busy === `install:${selected.id}` ? "요청 중" : "설치"}
                </button>
              )}
            </>
          ) : null}
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {error ? <SurfaceError message={error} /> : null}
          {selected ? (
            <article className="mx-auto max-w-[76ch]">
              {selected.description ? (
                <p className="text-[13px] leading-5 text-primary">{selected.description}</p>
              ) : null}

              {/*
               * 헌법 6절: 확장 표면은 "조직에 추가된 Capability를 먼저" 보여야 합니다.
               * 버전·출처보다 위에 둡니다 — 사용자가 판단하는 건 "무엇이 늘어나는가"입니다.
               */}
              <GrowthSection title="조직이 무엇을 할 수 있게 되나">
                {declarations && declarations.contributions.length > 0 ? (
                  <ul className="divide-y divide-border border-y border-border">
                    {declarations.contributions.map((entry) => (
                      <li className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-2 py-2" key={entry.kind}>
                        <span className="text-[12px] text-muted">{contributionLabel[entry.kind]}</span>
                        <span className="min-w-0 text-[12px] text-primary">{entry.items.join(" · ")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] leading-5 text-muted">
                    {busy === selected.id
                      ? "선언을 읽는 중…"
                      : "이 확장이 조직에 무엇을 더하는지 계약이 알려주지 않습니다. 설치 레코드만 있습니다."}
                  </p>
                )}
              </GrowthSection>

              <GrowthSection title="무엇을 요구하나">
                {declarations && declarations.permissions.length > 0 ? (
                  <ul className="divide-y divide-border border-y border-border">
                    {declarations.permissions.map((entry) => (
                      <li className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-2 py-2" key={entry.kind}>
                        <span className="text-[12px] text-muted">{permissionLabel[entry.kind]}</span>
                        <span className="min-w-0 font-mono text-[11px] text-primary">
                          {entry.items.filter((item) => item.length > 0).join(" · ") || "사용함"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] leading-5 text-muted">선언된 권한이 없습니다.</p>
                )}
              </GrowthSection>

              {notice ? <p className="mt-4 text-[12px] text-gate">{notice}</p> : null}
            </article>
          ) : (
            <p className="mx-auto max-w-[76ch] text-[13px] leading-5 text-muted">
              확장을 고르면 조직에 무엇이 늘어나고 무엇을 요구하는지 보여줍니다.
            </p>
          )}
        </div>
      </div>

      <aside aria-label="배경" className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome">
        <header className="flex items-center border-b border-border px-3">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted">배경</h2>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto px-3 py-3">
          {awaitingInstall ? (
            <section aria-label="설치 승인" className="rounded-[7px] border border-gate-border bg-gate-wash p-3">
              <p className="text-[12px] font-medium text-gate">설치가 승인을 기다립니다</p>
              <p className="mt-1 text-[11px] leading-4 text-secondary">
                요청한 권한과 출처를 확인한 뒤 여기서 결정합니다.
              </p>
              <p className="mt-1.5 font-mono text-[11px] text-fg-3" title={`승인 요청 ${awaitingInstall.approvalId}`}>
                {awaitingInstall.approvalId}
              </p>
              {approval === undefined ? (
                <p className="mt-2 text-[11px] text-muted">승인 정보를 불러오는 중입니다.</p>
              ) : (
                <div className="mt-3 flex justify-end">
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
          {selected ? (
            <section>
              <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted">출처</h3>
              <p className="mt-1.5 text-[12px] text-primary">{provenanceLabel[selected.provenance] ?? "알 수 없음"}</p>
              <p className="mt-0.5 font-mono text-[11px] text-fg-3" title="패키지 이름">
                {selected.packageName}
              </p>
            </section>
          ) : null}
          <section>
            <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted">확장이 대체할 수 없는 것</h3>
            {/* 헌법 4.11. 설치 판단 옆에 항상 있어야 하는 경계입니다. */}
            <p className="mt-1.5 text-[11px] leading-4 text-secondary">
              승인, 실행 기록, 기억 권위, 조직 거버넌스는 확장이 가져갈 수 없습니다. 설치·권한·활성화는 사람이
              통제합니다.
            </p>
          </section>
        </div>
      </aside>
    </main>
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
