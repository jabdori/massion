import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";

import type {
  AutonomyView,
  DesktopService,
  EmergencyView,
  SettingsView,
  SubscriptionAccountView,
} from "@/desktop-service";
import { projectModelRoutes, projectProviderConnections, projectSubscriptionAccounts } from "@/desktop-service";

import { GrowthSection, SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

export function SettingsSurface({
  onEmergencyChanged,
  service,
}: {
  onEmergencyChanged: () => void;
  service: DesktopService;
}) {
  const [settings, setSettings] = useState<SettingsView>();
  const [autonomy, setAutonomy] = useState<AutonomyView>();
  const [emergency, setEmergency] = useState<EmergencyView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [autonomySaving, setAutonomySaving] = useState(false);
  const [fullAccessPending, setFullAccessPending] = useState(false);
  const [zaiFormOpen, setZaiFormOpen] = useState(false);
  const [zaiAlias, setZaiAlias] = useState("Z.ai GLM-5.2");
  const [zaiSecret, setZaiSecret] = useState("");
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [provider, setProvider] = useState({
    providerId: "",
    displayName: "",
    adapterKind: "",
    endpointName: "",
    baseUrl: "",
    local: false,
    credentialLabel: "",
    credentialType: "api_key",
  });
  const [secret, setSecret] = useState("");
  const [areaId, setAreaId] = useState<(typeof SETTINGS_AREAS)[number]["id"]>("routes");
  useEffect(() => {
    let disposed = false;
    void Promise.all([service.loadSettings(), service.loadAutonomy(), service.loadEmergency()])
      .then(([value, mode, emergencyState]) => {
        if (!disposed) {
          setSettings(value);
          setAutonomy(mode);
          setEmergency(emergencyState);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "설정을 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);
  const setAutonomyMode = async (mode: AutonomyView["mode"]) => {
    if (!autonomy || autonomy.mode === mode || autonomySaving) return;
    if (mode === "full-access") {
      setFullAccessPending(true);
      return;
    }
    await commitAutonomyMode(mode);
  };
  const commitAutonomyMode = async (mode: AutonomyView["mode"]) => {
    if (!autonomy || autonomy.mode === mode || autonomySaving) return;
    setAutonomySaving(true);
    setError("");
    setNotice("");
    try {
      setAutonomy(await service.setAutonomy(mode, autonomy.revision));
      setNotice("실행 자율성 경계를 저장했습니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "자율성 경계를 변경하지 못했습니다."));
    } finally {
      setAutonomySaving(false);
    }
  };
  const activateEmergency = async () => {
    if (autonomySaving || emergency?.active === true) return;
    setAutonomySaving(true);
    setError("");
    setNotice("");
    try {
      const state = await service.activateEmergency("사용자 긴급 정지");
      setEmergency(state);
      onEmergencyChanged();
      setNotice("긴급 정지를 활성화했습니다. 새 실행은 차단됩니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "긴급 정지를 활성화하지 못했습니다."));
    } finally {
      setAutonomySaving(false);
    }
  };
  const requestEmergencyRelease = async () => {
    if (!emergency?.active || emergency.approvalId !== undefined || autonomySaving) return;
    setAutonomySaving(true);
    setError("");
    setNotice("");
    try {
      const state = await service.releaseEmergency(undefined, "사용자 긴급 정지 해제 요청");
      setEmergency(state);
      onEmergencyChanged();
      setNotice(
        state.approvalId === undefined
          ? "긴급 정지를 해제했습니다."
          : "해제 승인 요청을 수신함에 보냈습니다. 승인 전까지 새 실행은 계속 차단됩니다.",
      );
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "긴급 정지 해제 승인을 요청하지 못했습니다."));
    } finally {
      setAutonomySaving(false);
    }
  };
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const submittedSecret = secret;
    setSecret("");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await service.registerProvider({
        providerId: provider.providerId,
        displayName: provider.displayName,
        adapterKind: provider.adapterKind,
      });
      await service.registerEndpoint({
        providerId: provider.providerId,
        name: provider.endpointName,
        baseUrl: provider.baseUrl,
        local: provider.local,
      });
      const refreshed = await service.loadSettings();
      const endpointId = endpointIdFor(refreshed.catalog, provider.providerId, provider.endpointName, provider.baseUrl);
      if (!endpointId) throw new Error("생성된 endpoint를 확인하지 못했습니다.");
      await service.addCredential({
        providerId: provider.providerId,
        endpointId,
        label: provider.credentialLabel,
        credentialType: provider.credentialType,
        secret: submittedSecret,
        priority: 0,
        weight: 100,
      });
      setSettings(await service.loadSettings());
      setNotice("Provider 인증 연결을 추가했습니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "Provider 연결을 추가하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  };
  const submitZai = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const submittedSecret = zaiSecret;
    setZaiSecret("");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await service.connectZaiCodingPlan({ alias: zaiAlias, secret: submittedSecret });
      setSettings(await service.loadSettings());
      setNotice("Z.ai GLM-5.2 연결과 Core Route 5개 구성을 완료했습니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "Z.ai GLM-5.2 연결을 추가하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  };
  const setField = (field: keyof typeof provider, value: string | boolean) => {
    setProvider((current) => ({ ...current, [field]: value }));
  };

  const routes = settings ? projectModelRoutes(settings.routes, settings.catalog) : [];
  const connections = settings ? projectProviderConnections(settings.catalog) : [];
  const accounts = settings ? projectSubscriptionAccounts(settings.accounts) : [];
  const area = SETTINGS_AREAS.find((item) => item.id === areaId) ?? SETTINGS_AREAS[0];

  return (
    <main
      aria-label="설정"
      className="col-span-3 grid min-h-0 min-w-0 grid-cols-[242px_minmax(0,1fr)_300px] bg-canvas min-[1440px]:grid-cols-[264px_minmax(0,1fr)_332px]"
    >
      <section
        aria-label="설정 구역"
        className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border bg-chrome"
      >
        <header className="flex items-center border-b border-border px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em]">설정</h1>
        </header>
        <div className="min-h-0 overflow-y-auto">
          {/*
           * 다른 표면의 열1은 "많은 항목 중 하나를 고르는" 목록이고 여기는 구역 넷입니다.
           * 성격은 달라도 골격과 행 문법은 같습니다 — 표면을 옮겨도 같은 자리에서 같은 일을 합니다.
           */}
          <div className="divide-y divide-border border-b border-border">
            {SETTINGS_AREAS.map((item) => (
              <button
                aria-pressed={item.id === area.id}
                className={`relative w-full px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                  item.id === area.id
                    ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                    : "hover:bg-surface-1"
                }`}
                key={item.id}
                onClick={() => {
                  setAreaId(item.id);
                  setNotice("");
                }}
                type="button"
              >
                <span className="block truncate text-[13px] font-medium">{item.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">{item.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border">
        <header className="flex items-center border-b border-border px-5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.015em]">{area.title}</h2>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {error ? <SurfaceError message={error} /> : null}
          {!settings && !error ? <SurfaceLoading /> : null}
          {settings ? (
            <div className="mx-auto max-w-[76ch]">
              {area.id === "routes" ? (
                <>
                  <GrowthSection title="요청이 어디로 가나">
                    {routes.length === 0 ? (
                      <p className="text-[12px] text-muted">
                        구성된 모델 경로가 없습니다. 아래에서 Provider를 먼저 연결하십시오.
                      </p>
                    ) : (
                      <ul className="divide-y divide-border border-y border-border">
                        {routes.map((route) => (
                          <li className="py-2.5" key={route.routeId}>
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-[13px] font-medium">{route.name}</span>
                              {/* 이름이 종류를 이미 말하면 같은 말을 두 번 하지 않습니다. */}
                              {routeKindLabel(route.routeKind) === route.name ? null : (
                                <span className="shrink-0 text-[11px] text-muted">
                                  {routeKindLabel(route.routeKind)}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-muted">
                              {/* 경로가 켜져 있어도 후보가 없으면 실행되지 않습니다. 그 사실이 먼저입니다. */}
                              {!route.enabled
                                ? "꺼져 있습니다"
                                : route.candidateCount === 0
                                  ? "쓸 수 있는 모델이 없어 실행되지 않습니다"
                                  : `모델 ${String(route.candidateCount)}개`}
                              {route.totalBudgetMicros > 0
                                ? ` · 예산 ${costText(route.spentMicros)} / ${costText(route.totalBudgetMicros)}`
                                : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </GrowthSection>
                  <RouterConfiguration onRefresh={setSettings} service={service} settings={settings} />
                </>
              ) : null}

              {area.id === "providers" ? (
                <>
                  <GrowthSection title="연결된 Provider">
                    {connections.length === 0 ? (
                      <p className="text-[12px] text-muted">연결된 Provider가 없습니다.</p>
                    ) : (
                      <ul className="divide-y divide-border border-y border-border">
                        {connections.map((connection) => (
                          <li className="py-2.5" key={connection.providerId}>
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-[13px] font-medium">{connection.displayName}</span>
                              <span className="shrink-0 text-[11px] text-muted">
                                {connection.enabled ? "사용 중" : "꺼짐"}
                              </span>
                            </div>
                            {connection.endpoints.map((endpoint) => (
                              <p className="mt-0.5 text-[11px] text-muted" key={endpoint.baseUrl}>
                                {endpoint.local ? "이 컴퓨터" : "외부"} ·{" "}
                                <span className="font-mono">{endpoint.baseUrl}</span>
                              </p>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </GrowthSection>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      className="rounded-[5px] border border-control px-3 py-1 text-[12px] text-secondary hover:border-fg-3 hover:text-primary"
                      onClick={() => {
                        setZaiFormOpen((open) => !open);
                      }}
                      type="button"
                    >
                      Z.ai GLM-5.2 연결
                    </button>
                    <button
                      className="rounded-[5px] border border-control px-3 py-1 text-[12px] text-secondary hover:border-fg-3 hover:text-primary"
                      onClick={() => {
                        setProviderFormOpen((open) => !open);
                      }}
                      type="button"
                    >
                      다른 Provider 연결
                    </button>
                  </div>
                  {zaiFormOpen ? (
                    <ZaiCodingPlanConnectionForm
                      alias={zaiAlias}
                      saving={saving}
                      secret={zaiSecret}
                      setAlias={setZaiAlias}
                      setSecret={setZaiSecret}
                      submit={submitZai}
                    />
                  ) : null}
                  {providerFormOpen ? (
                    <ProviderConnectionForm
                      provider={provider}
                      saving={saving}
                      secret={secret}
                      setField={setField}
                      setSecret={setSecret}
                      submit={submit}
                    />
                  ) : null}
                </>
              ) : null}

              {area.id === "accounts" ? (
                <GrowthSection title="구독 계정">
                  {accounts.length === 0 ? (
                    <p className="text-[12px] text-muted">연결된 구독 계정이 없습니다.</p>
                  ) : (
                    <ul className="divide-y divide-border border-y border-border">
                      {accounts.map((account) => (
                        <li className="py-2.5" key={account.accountId}>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[13px] font-medium">{account.alias}</span>
                            <span
                              className={`shrink-0 text-[11px] ${account.quotaExhausted === true ? "text-halt" : "text-muted"}`}
                            >
                              {quotaText(account)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {billingKindLabel(account.billingKind)}
                            {account.earliestResetAt === undefined ? "" : ` · ${resetText(account.earliestResetAt)}`}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </GrowthSection>
              ) : null}

              {area.id === "autonomy" && autonomy ? (
                <section aria-label="자율성 경계">
                  <GrowthSection title="실행 자율성">
                    <p className="text-[13px] leading-5 text-secondary">
                      {autonomy.mode === "automatic"
                        ? "미리 승인된 범위에서는 사람을 기다리지 않고 실행합니다. 위험한 실행과 조직 변경은 여전히 수신함에서 확인을 받습니다."
                        : autonomy.mode === "review"
                          ? "실행 전에 사람의 확인을 받습니다. 조직이 더 자주 멈추는 대신 개입 지점이 많아집니다."
                          : "사용자 책임 하에 정책과 불변식이 요구한 승인까지 모두 자동 통과합니다. 위험한 실행과 조직 변경도 묻지 않고 진행합니다."}
                    </p>
                    {fullAccessPending ? (
                      <div className="mt-3 rounded-[5px] border border-halt/40 bg-surface-1 p-3" role="alert">
                        <p className="text-[12px] leading-5 text-primary">
                          에이전트가 현재 macOS 사용자와 같은 범위에서 파일을 읽고 변경·삭제하며, 명령과 네트워크 요청을
                          실행하고 연결된 계정과 확장을 사용할 수 있습니다. 그 결과에 대한 책임은 사용자에게 있습니다.
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            className="rounded-[5px] border border-border px-3 py-1 text-[12px] text-secondary"
                            onClick={() => setFullAccessPending(false)}
                            type="button"
                          >
                            취소
                          </button>
                          <button
                            className="rounded-[5px] border border-halt px-3 py-1 text-[12px] text-halt"
                            onClick={() => {
                              setFullAccessPending(false);
                              void commitAutonomyMode("full-access");
                            }}
                            type="button"
                          >
                            확인하고 켜기
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        className={`rounded-[5px] border px-3 py-1 text-[12px] disabled:opacity-50 ${
                          autonomy.mode === "automatic"
                            ? "border-control bg-surface-2 text-primary"
                            : "border-border text-secondary"
                        }`}
                        disabled={autonomySaving || autonomy.mode === "automatic"}
                        onClick={() => {
                          void setAutonomyMode("automatic");
                        }}
                        type="button"
                      >
                        자동 실행
                      </button>
                      <button
                        className={`rounded-[5px] border px-3 py-1 text-[12px] disabled:opacity-50 ${
                          autonomy.mode === "review"
                            ? "border-control bg-surface-2 text-primary"
                            : "border-border text-secondary"
                        }`}
                        disabled={autonomySaving || autonomy.mode === "review"}
                        onClick={() => {
                          void setAutonomyMode("review");
                        }}
                        type="button"
                      >
                        검토 후 실행
                      </button>
                      <button
                        className={`rounded-[5px] border px-3 py-1 text-[12px] disabled:opacity-50 ${
                          autonomy.mode === "full-access"
                            ? "border-control bg-surface-2 text-primary"
                            : "border-border text-secondary"
                        }`}
                        disabled={autonomySaving || autonomy.mode === "full-access"}
                        onClick={() => {
                          void setAutonomyMode("full-access");
                        }}
                        type="button"
                      >
                        전체 권한
                      </button>
                      <span className="font-mono text-[11px] text-muted">개정 {autonomy.revision}</span>
                    </div>
                    <p className="mt-2 text-[11px] text-muted">
                      실행 상태:{" "}
                      {autonomy.emergencyStopActive
                        ? "긴급 정지로 제한됨"
                        : autonomy.runtimePermissionStatus === "full-access"
                          ? "전체 권한"
                          : "정책 적용"}
                      {autonomy.permissionLimitReason === undefined ? "" : ` · ${autonomy.permissionLimitReason}`}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        className="rounded-[5px] border border-halt px-3 py-1 text-[12px] text-halt disabled:opacity-50"
                        disabled={autonomySaving || emergency?.active === true}
                        onClick={() => {
                          void activateEmergency();
                        }}
                        type="button"
                      >
                        {emergency?.active === true ? "긴급 정지 활성" : "긴급 정지"}
                      </button>
                      {emergency?.active === true ? (
                        <>
                          <span className="text-[11px] text-halt">{emergency.reason ?? "새 실행 차단 중"}</span>
                          <button
                            className="rounded-[5px] border border-control px-3 py-1 text-[12px] text-secondary disabled:opacity-50"
                            disabled={autonomySaving || emergency.approvalId !== undefined}
                            onClick={() => {
                              void requestEmergencyRelease();
                            }}
                            type="button"
                          >
                            {emergency.approvalId === undefined ? "해제 승인 요청" : "해제 승인 대기"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </GrowthSection>
                </section>
              ) : null}

              {area.id === "local" ? (
                <GrowthSection title="로컬 운영 환경">
                  {/* 없는 것을 있는 것처럼 그리지 않습니다. 무엇이 없는지 화면이 말합니다. */}
                  <p className="text-[12px] leading-5 text-muted">
                    daemon 상태·데이터 위치·백업을 볼 조회가 아직 계약에 없습니다. 지금은 하단 표시줄의 연결 상태가
                    유일한 신호입니다.
                  </p>
                </GrowthSection>
              ) : null}

              {notice ? <p className="mt-4 text-[12px] text-gate">{notice}</p> : null}
            </div>
          ) : null}
        </div>
      </div>

      <aside aria-label="배경" className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome">
        <header className="flex items-center border-b border-border px-3">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted">배경</h2>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto px-3 py-3">
          <section>
            <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted">이 구역이 정하는 것</h3>
            <p className="mt-1.5 text-[11px] leading-4 text-secondary">{area.background}</p>
          </section>
          {area.id === "providers" ? (
            <section>
              <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted">자격 증명</h3>
              <p className="mt-1.5 text-[11px] leading-4 text-secondary">
                저장된 값은 화면에 다시 표시되지 않습니다. 새로 입력한 값은 저장 직후 입력란에서 지워집니다.
              </p>
            </section>
          ) : null}
        </div>
      </aside>
    </main>
  );
}

const SETTINGS_AREAS = [
  {
    id: "routes",
    title: "모델 경로",
    hint: "어떤 요청이 어느 모델로",
    background:
      "조직의 요청 종류마다 어느 모델을 쓸지, 예산을 얼마나 줄지 정합니다. 경로가 비면 그 종류의 실행이 멈춥니다.",
  },
  {
    id: "providers",
    title: "Provider 연결",
    hint: "모델을 어디서 받나",
    background: "모델을 제공하는 곳과 그 주소입니다. 이 컴퓨터에서 도는 것과 외부로 나가는 것이 구분되어야 합니다.",
  },
  {
    id: "accounts",
    title: "구독 계정",
    hint: "남은 할당량",
    background: "구독으로 쓰는 계정의 남은 양입니다. 소진되면 그 계정을 쓰는 경로가 멈추므로 미리 보여야 합니다.",
  },
  {
    id: "autonomy",
    title: "실행 자율성",
    hint: "언제 사람을 기다리나",
    background:
      "미리 승인된 범위에서 자동으로 실행할지, 매 실행 전에 사람의 검토를 받을지, 아니면 전체 권한으로 모든 승인을 자동 통과할지 정합니다. 위험 경계는 자동·검토 모드에서 유지되며, 전체 권한에서는 사용자 책임 하에 풀립니다.",
  },
  {
    id: "local",
    title: "로컬 환경",
    hint: "daemon과 데이터",
    background: "이 컴퓨터에서 도는 daemon과 데이터가 있는 곳입니다.",
  },
] as const;

/** RouteKind. 도메인 값을 사람의 말로 옮깁니다. */
function routeKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    reasoning: "추론",
    chat: "대화",
    utility: "보조 작업",
    embedding: "임베딩",
    vision: "이미지",
  };
  return labels[kind] ?? kind;
}

function billingKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    "coding-plan": "구독 요금제",
    "api-key": "사용량 과금",
    subscription: "구독",
  };
  return labels[kind] ?? kind;
}

function costText(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function quotaText(account: SubscriptionAccountView): string {
  if (account.quotaExhausted === true) return "할당량 소진";
  if (account.minimumRemainingRatio === undefined) return account.status === "active" ? "사용 중" : account.status;
  return `${String(Math.round(account.minimumRemainingRatio * 100))}% 남음`;
}

function resetText(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : `${String(at.getMonth() + 1)}월 ${String(at.getDate())}일 초기화`;
}

function ZaiCodingPlanConnectionForm({
  alias,
  saving,
  secret,
  setAlias,
  setSecret,
  submit,
}: {
  alias: string;
  saving: boolean;
  secret: string;
  setAlias: (value: string) => void;
  setSecret: (value: string) => void;
  submit: (event: React.SyntheticEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form
      aria-label="Z.ai GLM-5.2 연결"
      className="mt-5 grid max-w-3xl grid-cols-2 gap-4 border-b border-border pb-5"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsField label="연결 이름">
        <Input
          aria-label="연결 이름"
          onChange={(event) => {
            setAlias(event.target.value);
          }}
          required
          value={alias}
        />
      </SettingsField>
      <SettingsField label="Z.ai API Key">
        <Input
          aria-label="Z.ai API Key"
          onChange={(event) => {
            setSecret(event.target.value);
          }}
          required
          type="password"
          value={secret}
        />
      </SettingsField>
      <p className="col-span-2 text-xs leading-5 text-muted">
        API Key는 로컬 자격 증명 저장소에만 기록되며, 이 화면에는 다시 표시되지 않습니다.
      </p>
      <div className="col-span-2 flex justify-end">
        <Button disabled={saving} type="submit">
          {saving ? "연결 중…" : "연결하고 기본 Route 구성"}
        </Button>
      </div>
    </form>
  );
}
function ProviderConnectionForm({
  provider,
  saving,
  secret,
  setField,
  setSecret,
  submit,
}: {
  provider: {
    providerId: string;
    displayName: string;
    adapterKind: string;
    endpointName: string;
    baseUrl: string;
    local: boolean;
    credentialLabel: string;
    credentialType: string;
  };
  saving: boolean;
  secret: string;
  setField: (field: keyof typeof provider, value: string | boolean) => void;
  setSecret: (value: string) => void;
  submit: (event: React.SyntheticEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form
      aria-label="Provider 연결 추가"
      className="mt-5 grid max-w-3xl grid-cols-2 gap-4 border-b border-border pb-5"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsField label="Provider ID">
        <Input
          aria-label="Provider ID"
          onChange={(event) => {
            setField("providerId", event.target.value);
          }}
          required
          value={provider.providerId}
        />
      </SettingsField>
      <SettingsField label="표시 이름">
        <Input
          aria-label="표시 이름"
          onChange={(event) => {
            setField("displayName", event.target.value);
          }}
          required
          value={provider.displayName}
        />
      </SettingsField>
      <SettingsField label="Adapter kind">
        <Input
          aria-label="Adapter kind"
          onChange={(event) => {
            setField("adapterKind", event.target.value);
          }}
          required
          value={provider.adapterKind}
        />
      </SettingsField>
      <SettingsField label="Endpoint 이름">
        <Input
          aria-label="Endpoint 이름"
          onChange={(event) => {
            setField("endpointName", event.target.value);
          }}
          required
          value={provider.endpointName}
        />
      </SettingsField>
      <SettingsField label="Base URL">
        <Input
          aria-label="Base URL"
          onChange={(event) => {
            setField("baseUrl", event.target.value);
          }}
          required
          type="url"
          value={provider.baseUrl}
        />
      </SettingsField>
      <SettingsField label="Credential label">
        <Input
          aria-label="Credential label"
          onChange={(event) => {
            setField("credentialLabel", event.target.value);
          }}
          required
          value={provider.credentialLabel}
        />
      </SettingsField>
      <SettingsField label="Credential type">
        <Input
          aria-label="Credential type"
          onChange={(event) => {
            setField("credentialType", event.target.value);
          }}
          required
          value={provider.credentialType}
        />
      </SettingsField>
      <SettingsField label="Credential secret">
        <Input
          aria-label="Credential secret"
          onChange={(event) => {
            setSecret(event.target.value);
          }}
          required
          type="password"
          value={secret}
        />
      </SettingsField>
      <label className="col-span-2 flex items-center gap-2 text-sm text-secondary">
        <input
          checked={provider.local}
          onChange={(event) => {
            setField("local", event.target.checked);
          }}
          type="checkbox"
        />
        로컬 endpoint
      </label>
      <div className="col-span-2 flex justify-end">
        <Button disabled={saving} type="submit">
          {saving ? "연결 중…" : "Provider 연결 추가"}
        </Button>
      </div>
    </form>
  );
}
function SettingsField({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5 text-sm text-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RouterConfiguration({
  service,
  settings,
  onRefresh,
}: {
  service: DesktopService;
  settings: SettingsView;
  onRefresh: (settings: SettingsView) => void;
}) {
  const routes = routeItems(settings.routes);
  const models = modelProfiles(settings.catalog);
  const [model, setModel] = useState({
    providerId: "",
    endpointId: "",
    modelId: "",
    routeKind: "chat",
    contextWindow: "128000",
    equivalenceGroup: "general",
    evalScore: "0",
    inputCost: "0",
    outputCost: "0",
    verified: false,
  });
  const [route, setRoute] = useState({ name: "", routeKind: "chat" });
  const [candidate, setCandidate] = useState({
    routeId: routes[0]?.routeId ?? "",
    modelProfileId: models[0]?.modelProfileId ?? "",
    priority: "0",
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const refresh = async () => {
    onRefresh(await service.loadSettings());
  };
  const input = "rounded-[6px] border-border bg-canvas";
  const save = async (kind: string, action: () => Promise<void>, fallback: string) => {
    setBusy(kind);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(surfaceErrorMessage(cause, fallback));
    } finally {
      setBusy("");
    }
  };
  const submitModel = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    await save(
      "model",
      () =>
        service.registerModel({
          providerId: model.providerId,
          endpointId: model.endpointId,
          modelId: model.modelId,
          routeKind: model.routeKind,
          contextWindow: Number(model.contextWindow),
          supportsTools: true,
          // 사용자 모델은 Provider별 capability 편차가 있으므로 검증 전에는 JSON prompt 경로를 사용합니다.
          supportsStructuredOutput: false,
          supportsVision: false,
          supportsStreaming: true,
          equivalenceGroup: model.equivalenceGroup,
          evalScore: Number(model.evalScore),
          inputCostMicrosPerMillion: Number(model.inputCost),
          outputCostMicrosPerMillion: Number(model.outputCost),
          verified: model.verified,
        }),
      "모델 프로필을 등록하지 못했습니다.",
    );
  };
  const submitRoute = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    await save(
      "route",
      () => service.configureRoute({ name: route.name, routeKind: route.routeKind }),
      "라우트를 저장하지 못했습니다.",
    );
  };
  const submitCandidate = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    await save(
      "candidate",
      () =>
        service.addRouteCandidate({
          routeId: candidate.routeId,
          modelProfileId: candidate.modelProfileId,
          priority: Number(candidate.priority),
        }),
      "라우트 후보를 연결하지 못했습니다.",
    );
  };
  return (
    <section className="mt-6 border-t border-border pt-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium tracking-[0.04em] text-muted">모델 라우팅</p>
          <p className="mt-1 text-sm text-secondary">
            {models.length}개 모델 프로필 · {routes.length}개 라우트
          </p>
        </div>
        <Button
          onClick={() => {
            setAdvancedOpen((open) => !open);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          고급 라우팅 설정
        </Button>
      </div>
      {advancedOpen ? (
        <div className="mt-5 grid gap-5 border-t border-border pt-5">
          {error ? <SurfaceError message={error} /> : null}
          <form
            aria-label="모델 프로필 등록"
            className="grid grid-cols-2 gap-4"
            onSubmit={(event) => {
              void submitModel(event);
            }}
          >
            <SettingsField label="모델 Provider ID">
              <Input
                aria-label="모델 Provider ID"
                className={input}
                onChange={(event) => {
                  setModel({ ...model, providerId: event.target.value });
                }}
                required
                value={model.providerId}
              />
            </SettingsField>
            <SettingsField label="모델 Endpoint ID">
              <Input
                aria-label="모델 Endpoint ID"
                className={input}
                onChange={(event) => {
                  setModel({ ...model, endpointId: event.target.value });
                }}
                required
                value={model.endpointId}
              />
            </SettingsField>
            <SettingsField label="모델 ID">
              <Input
                aria-label="모델 ID"
                className={input}
                onChange={(event) => {
                  setModel({ ...model, modelId: event.target.value });
                }}
                required
                value={model.modelId}
              />
            </SettingsField>
            <SettingsField label="Context window">
              <Input
                aria-label="Context window"
                className={input}
                min="1"
                onChange={(event) => {
                  setModel({ ...model, contextWindow: event.target.value });
                }}
                required
                type="number"
                value={model.contextWindow}
              />
            </SettingsField>
            <SettingsField label="동등성 그룹">
              <Input
                aria-label="동등성 그룹"
                className={input}
                onChange={(event) => {
                  setModel({ ...model, equivalenceGroup: event.target.value });
                }}
                required
                value={model.equivalenceGroup}
              />
            </SettingsField>
            <SettingsField label="평가 점수">
              <Input
                aria-label="평가 점수"
                className={input}
                min="0"
                onChange={(event) => {
                  setModel({ ...model, evalScore: event.target.value });
                }}
                required
                step="any"
                type="number"
                value={model.evalScore}
              />
            </SettingsField>
            <SettingsField label="입력 비용 (micros/백만)">
              <Input
                aria-label="입력 비용 (micros/백만)"
                className={input}
                min="0"
                onChange={(event) => {
                  setModel({ ...model, inputCost: event.target.value });
                }}
                required
                type="number"
                value={model.inputCost}
              />
            </SettingsField>
            <SettingsField label="출력 비용 (micros/백만)">
              <Input
                aria-label="출력 비용 (micros/백만)"
                className={input}
                min="0"
                onChange={(event) => {
                  setModel({ ...model, outputCost: event.target.value });
                }}
                required
                type="number"
                value={model.outputCost}
              />
            </SettingsField>
            <label className="text-sm text-secondary">
              <input
                checked={model.verified}
                onChange={(event) => {
                  setModel({ ...model, verified: event.target.checked });
                }}
                type="checkbox"
              />{" "}
              검증됨
            </label>
            <Button disabled={busy !== ""} type="submit">
              모델 등록
            </Button>
          </form>
          <form
            aria-label="라우트 구성"
            className="flex items-end gap-3"
            onSubmit={(event) => {
              void submitRoute(event);
            }}
          >
            <SettingsField label="라우트 이름">
              <Input
                aria-label="라우트 이름"
                className={input}
                onChange={(event) => {
                  setRoute({ ...route, name: event.target.value });
                }}
                required
                value={route.name}
              />
            </SettingsField>
            <Button disabled={busy !== ""} type="submit">
              라우트 저장
            </Button>
          </form>
          <form
            aria-label="라우트 후보 연결"
            className="grid grid-cols-[1fr_1fr_auto] items-end gap-3"
            onSubmit={(event) => {
              void submitCandidate(event);
            }}
          >
            <SettingsField label="라우트">
              <select
                aria-label="라우트"
                className={`h-8 ${input}`}
                onChange={(event) => {
                  setCandidate({ ...candidate, routeId: event.target.value });
                }}
                required
                value={candidate.routeId}
              >
                {routes.map((item) => (
                  <option key={item.routeId} value={item.routeId}>
                    {item.name}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField label="모델 프로필">
              <select
                aria-label="모델 프로필"
                className={`h-8 ${input}`}
                onChange={(event) => {
                  setCandidate({ ...candidate, modelProfileId: event.target.value });
                }}
                required
                value={candidate.modelProfileId}
              >
                {models.map((item) => (
                  <option key={item.modelProfileId} value={item.modelProfileId}>
                    {item.providerId}/{item.modelId}
                  </option>
                ))}
              </select>
            </SettingsField>
            <Button disabled={busy !== "" || !candidate.routeId || !candidate.modelProfileId} type="submit">
              후보 연결
            </Button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function routeItems(value: unknown): readonly { routeId: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.routeId === "string" && typeof record.name === "string"
      ? [{ routeId: record.routeId, name: record.name }]
      : [];
  });
}

function modelProfiles(value: unknown): readonly { modelProfileId: string; providerId: string; modelId: string }[] {
  const models = value && typeof value === "object" ? (value as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.modelProfileId === "string" &&
      typeof record.providerId === "string" &&
      typeof record.modelId === "string"
      ? [{ modelProfileId: record.modelProfileId, providerId: record.providerId, modelId: record.modelId }]
      : [];
  });
}

function endpointIdFor(catalog: unknown, providerId: string, name: string, baseUrl: string): string | undefined {
  if (!catalog || typeof catalog !== "object") return undefined;
  const endpoints = (catalog as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(endpoints)) return undefined;
  return endpoints.find(
    (endpoint): endpoint is { endpointId: string } =>
      !!endpoint &&
      typeof endpoint === "object" &&
      (endpoint as Record<string, unknown>).providerId === providerId &&
      (endpoint as Record<string, unknown>).name === name &&
      (endpoint as Record<string, unknown>).baseUrl === baseUrl &&
      typeof (endpoint as Record<string, unknown>).endpointId === "string",
  )?.endpointId;
}
