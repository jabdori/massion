import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useRef, useState } from "react";

import type {
  AutonomyView,
  DesktopService,
  EmergencyView,
  ModelRouteView,
  SettingsView,
  SubscriptionAccountView,
} from "@/desktop-service";
import { projectModelRoutes, projectProviderConnections, projectSubscriptionAccounts } from "@/desktop-service";

import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const sectionRefs = useRef<Partial<Record<(typeof SETTINGS_AREAS)[number]["id"], HTMLElement | null>>>({});
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
  const models = settings ? modelProfiles(settings.catalog) : [];
  const credentials = settings ? credentialItems(settings.credentials) : [];
  const endpoints = settings ? catalogEndpoints(settings.catalog) : undefined;
  const budgetSpentMicros = routes.reduce((sum, route) => sum + route.spentMicros, 0);
  const budgetTotalMicros = routes.reduce((sum, route) => sum + route.totalBudgetMicros, 0);
  const minimumRemainingRatio = accounts.reduce<number | undefined>((minimum, account) => {
    if (account.minimumRemainingRatio === undefined) return minimum;
    return minimum === undefined ? account.minimumRemainingRatio : Math.min(minimum, account.minimumRemainingRatio);
  }, undefined);
  const fullAccess = autonomy?.mode === "full-access" || autonomy?.runtimePermissionStatus === "full-access";
  const emergencyActive = emergency?.active === true || autonomy?.emergencyStopActive === true;
  const mainRing = emergencyActive ? "ring-2 ring-inset ring-emergency" : fullAccess ? "ring-2 ring-inset ring-halt" : "";
  const localRoutes = routes.filter((route) => route.primaryLocal === true);
  const externalRoutes = routes.filter((route) => route.primaryLocal === false);
  const localConnections = connections.flatMap((connection) => {
    const localEndpoints = connection.endpoints.filter((endpoint) => endpoint.local && endpoint.baseUrl.length > 0);
    return localEndpoints.length > 0 ? [{ ...connection, endpoints: localEndpoints }] : [];
  });
  const externalConnections = connections.flatMap((connection) => {
    const externalEndpoints = connection.endpoints.filter((endpoint) => !endpoint.local && endpoint.baseUrl.length > 0);
    return externalEndpoints.length > 0 ? [{ ...connection, endpoints: externalEndpoints }] : [];
  });
  const localModels = modelsForSide(models, endpoints, true);
  const externalModels = modelsForSide(models, endpoints, false);

  return (
    <main
      aria-label="설정"
      className={`col-span-3 grid min-h-0 min-w-0 grid-cols-[264px_minmax(0,1fr)] bg-canvas ${mainRing}`}
    >
      <section
        aria-label="설정 구역"
        className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-r border-line-strong bg-chrome"
      >
        <header className="flex items-center border-b border-line-strong px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.008em] text-primary">설정</h1>
        </header>
        <div className="min-h-0 overflow-y-auto px-2 py-2">
          <div className="space-y-[2px]">
            {SETTINGS_AREAS.map((item) => (
              <button
                aria-pressed={item.id === areaId}
                className={`flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left text-[13px] leading-5 tracking-[-0.005em] text-fg-2 outline-none transition-colors duration-150 hover:duration-0 hover:bg-white/[0.027] motion-reduce:transition-none ${
                  item.id === areaId ? "bg-white/[0.047]" : ""
                }`}
                key={item.id}
                ref={(node) => {
                  sectionRefs.current[item.id] = node;
                }}
                onClick={() => {
                  setAreaId(item.id);
                  setNotice("");
                  const target = sectionRefs.current[item.id];
                  if (target && typeof target.scrollIntoView === "function") {
                    target.scrollIntoView({ block: "start", behavior: "auto" });
                  }
                }}
                type="button"
              >
                <span className="truncate">{item.title}</span>
                {item.id === "routes" ? <span className="font-mono text-[11px] tabular-nums text-fg-4">{routes.length}</span> : null}
                {item.id === "providers" ? (
                  <span className="font-mono text-[11px] tabular-nums text-fg-4">{connections.length}</span>
                ) : null}
                {item.id === "accounts" ? (
                  <span className="font-mono text-[11px] tabular-nums text-fg-4">{accounts.length}</span>
                ) : null}
                {item.id === "autonomy" && autonomy ? (
                  <span className="text-[13px] text-fg-4">{autonomyModeShortLabel(autonomy.mode)}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="mt-8">
            <SummaryLabel>운영 요약</SummaryLabel>
            <div className="mt-1 space-y-[2px]">
              {autonomy ? (
                <SummaryRow label="실행 모드" value={autonomyModeLabel(autonomy.mode)} mono={false} />
              ) : null}
              {autonomy ? (
                <SummaryRow label="실행 상태" value={runtimeStatusLabel(autonomy, emergency)} mono={false} />
              ) : null}
              {autonomy ? <SummaryRow label="개정" value={String(autonomy.revision)} /> : null}
              {endpoints ? (
                <SummaryRow label="이 컴퓨터" value={String(endpoints.filter((endpoint) => endpoint.local).length)} />
              ) : null}
              {endpoints ? (
                <SummaryRow label="외부로 나감" value={String(endpoints.filter((endpoint) => !endpoint.local).length)} />
              ) : null}
              {routes.length > 0 ? (
                <>
                  <SummaryRow
                    label="예산"
                    value={`${costText(budgetSpentMicros)} / ${costText(budgetTotalMicros)}`}
                    {...(budgetTotalMicros > 0 ? { progress: budgetSpentMicros / budgetTotalMicros } : {})}
                  />
                </>
              ) : null}
              {minimumRemainingRatio !== undefined ? (
                <>
                  <SummaryRow label="최소 잔여 할당량" value={`${Math.round(minimumRemainingRatio * 100)}%`} progress={minimumRemainingRatio} />
                </>
              ) : null}
              {settings ? (
                <SummaryRow
                  label="모델 프로필"
                  value={`${models.length}개${models.some((model) => model.verified) ? ` · 검증 ${models.filter((model) => model.verified).length}` : ""}`}
                />
              ) : null}
              {settings ? <SummaryRow label="자격 증명" value={String(credentials.length)} /> : null}
            </div>
          </div>
        </div>
      </section>

      <div className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)]">
        <header className="flex items-center justify-between border-b border-line-strong px-5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.008em] text-primary">운영 기반</h2>
          <span className="font-mono text-[11px] tabular-nums text-fg-4">
            경로 {routes.length} · Provider {connections.length} · 계정 {accounts.length}
          </span>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {error ? <SurfaceError message={error} /> : null}
          {!settings && !error ? <SurfaceLoading /> : null}
          {settings ? (
            <div className="w-full">
              <section
                aria-label="자율성 경계"
                ref={(node) => {
                  sectionRefs.current.autonomy = node;
                }}
              >
                <div className="flex min-h-[30px] items-center justify-between gap-4">
                  <p className="text-[12px] leading-[18px] text-fg-4">권한 경계</p>
                  {autonomy ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex h-7 items-center gap-0.5 rounded-[4px] border border-line p-0.5">
                        {(["automatic", "review", "full-access"] as const).map((mode) => (
                          <button
                            className={`h-6 rounded-[4px] px-2 text-[12px] leading-[18px] ${
                              autonomy.mode === mode ? "bg-white/[0.047] text-primary" : "text-fg-4"
                            }`}
                            disabled={autonomySaving || autonomy.mode === mode}
                            key={mode}
                            onClick={() => {
                              void setAutonomyMode(mode);
                            }}
                            type="button"
                          >
                            {autonomyModeLabel(mode)}
                          </button>
                        ))}
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-fg-4">개정 {autonomy.revision}</span>
                    </div>
                  ) : null}
                </div>
                {autonomy ? (
                  <>
                    <p className="mt-2 text-[13px] leading-5 text-fg-2">
                      {autonomy.mode === "automatic"
                        ? "미리 승인된 범위에서는 사람을 기다리지 않고 실행합니다. 위험한 실행과 조직 변경은 여전히 수신함에서 확인을 받습니다."
                        : autonomy.mode === "review"
                          ? "실행 전에 사람의 확인을 받습니다. 조직이 더 자주 멈추는 대신 개입 지점이 많아집니다."
                          : "사용자 책임 하에 정책과 불변식이 요구한 승인까지 모두 자동 통과합니다. 위험한 실행과 조직 변경도 묻지 않고 진행합니다."}
                    </p>
                    {fullAccessPending ? (
                      <div className="mt-4 rounded-[4px] border border-halt bg-surface-1 p-3" role="alert">
                        <p className="text-[13px] leading-5 text-fg-2">
                          에이전트가 현재 macOS 사용자와 같은 범위에서 파일을 읽고 변경·삭제하며, 명령과 네트워크 요청을
                          실행하고 연결된 계정과 확장을 사용할 수 있습니다. 그 결과에 대한 책임은 사용자에게 있습니다.
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            className="h-7 rounded-[4px] border border-line px-3 text-[12px] text-fg-2"
                            onClick={() => setFullAccessPending(false)}
                            type="button"
                          >
                            취소
                          </button>
                          <button
                            className="h-7 rounded-[4px] border border-halt px-3 text-[12px] text-halt"
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
                  </>
                ) : null}
              </section>
              <div className="mt-6 grid min-w-0 grid-cols-2">
                <div
                  className="flex min-w-0 flex-col gap-6 pr-5"
                  ref={(node) => {
                    sectionRefs.current.routes = node;
                  }}
                >
                  {localRoutes.length > 0 ? (
                    <BoundaryBand
                      endpoints={boundaryEndpoints(routes, endpoints, models, true)}
                      label="이 컴퓨터"
                      routes={localRoutes}
                    />
                  ) : null}
                  <section>
                    <div className="flex min-h-[30px] items-center justify-between gap-3">
                      <p className="text-[12px] leading-[18px] text-fg-4">사람이 필요한 지점</p>
                      <button
                        className="h-7 shrink-0 rounded-[4px] border border-halt px-3 text-[12px] text-halt disabled:opacity-50"
                        disabled={autonomySaving || emergency?.active === true}
                        onClick={() => {
                          void activateEmergency();
                        }}
                        type="button"
                      >
                        {emergency?.active === true ? "긴급 정지 활성" : "긴급 정지"}
                      </button>
                    </div>
                    <div className="mt-1 space-y-[2px]">
                      {autonomy?.mode === "full-access" || autonomy?.runtimePermissionStatus === "full-access" ? (
                        <p className="h-[30px] rounded-[4px] pl-8 pr-2 text-[13px] leading-[30px] text-halt">⊘ 사람 확인 지점 없음</p>
                      ) : (
                        (autonomy?.mode === "review" ? ["모든 실행", "위험한 실행", "조직 변경"] : ["위험한 실행", "조직 변경"]).map(
                          (label) => (
                            <p className="h-[30px] rounded-[4px] pl-8 pr-2 text-[13px] leading-[30px] text-fg-2" key={label}>
                              <span className="mr-2 inline-block w-6 text-center text-gate">◇</span>
                              {label}
                            </p>
                          ),
                        )
                      )}
                      <p className="h-[30px] rounded-[4px] pl-8 pr-2 text-[13px] leading-[30px] text-fg-2">
                        <span className="mr-2 inline-block w-6 text-center text-gate">{fullAccess ? "" : "◇"}</span>
                        긴급 정지 해제 승인
                      </p>
                      {emergency?.active === true ? (
                        <div className="flex h-[30px] items-center gap-2 pl-8 pr-2">
                          <span className="truncate text-[12px] text-halt">{emergency.reason ?? "새 실행 차단 중"}</span>
                          <button
                            className="h-7 shrink-0 rounded-[4px] border border-line-strong px-3 text-[12px] text-fg-2 disabled:opacity-50"
                            disabled={autonomySaving || emergency.approvalId !== undefined}
                            onClick={() => {
                              void requestEmergencyRelease();
                            }}
                            type="button"
                          >
                            {emergency.approvalId === undefined ? "해제 승인 요청" : "해제 승인 대기"}
                          </button>
                        </div>
                      ) : null}
                      {autonomy?.emergencyStopActive ? <p className="h-[30px] pl-8 pr-2 text-[12px] leading-[30px] text-halt">긴급 정지로 제한됨</p> : null}
                    </div>
                  </section>
                  {localConnections.length > 0 ? (
                    <section
                      ref={(node) => {
                        sectionRefs.current.providers = node;
                      }}
                    >
                      <SectionIntro title="Provider" background="Provider와 endpoint를 이 컴퓨터와 외부 경계로 나눠 보여줍니다." />
                      <div className="mt-1 space-y-[2px]">
                        {localConnections.map((connection) => (
                          <div key={connection.providerId}>
                            <div className="flex h-[30px] items-center justify-between gap-3 rounded-[4px] pl-8 pr-2">
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="truncate text-[13px] tracking-[-0.005em] text-fg-2">{connection.displayName}</span>
                                {connection.adapterKind ? <span className="font-mono text-[11px] text-fg-4">{connection.adapterKind}</span> : null}
                              </div>
                              <span className="shrink-0 text-[12px] text-fg-4">{connection.enabled ? "사용 중" : "꺼짐"}</span>
                            </div>
                            {connection.endpoints.map((endpoint) => (
                              <div className="flex h-[30px] items-center gap-3 rounded-[4px] pl-8" key={`${endpoint.name}-${endpoint.baseUrl}`}>
                                <span className="w-16 shrink-0 text-[12px] text-fg-3">이 컴퓨터</span>
                                <span className="truncate font-mono text-[11px] text-fg-4">{endpoint.baseUrl}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {localModels.length > 0 ? (
                    <section>
                      <SectionIntro title="모델" background="이 컴퓨터에서 실행되는 모델과 검증 상태입니다." />
                      <ModelList models={localModels} />
                    </section>
                  ) : null}
                  <section
                    ref={(node) => {
                      sectionRefs.current.local = node;
                    }}
                  >
                    <SectionIntro title="이 컴퓨터의 daemon" background="이 컴퓨터에서 도는 daemon과 데이터가 있는 곳입니다." />
                    <p className="mt-1 text-[13px] leading-5 text-fg-3">조회가 아직 계약에 없습니다.</p>
                  </section>
                </div>
                <div className={`flex min-w-0 flex-col gap-6 pl-5 ${fullAccess ? "border-l-2 border-halt bg-halt/[0.06]" : "border-l border-line-strong"}`}>
                  {externalRoutes.length > 0 ? (
                    <BoundaryBand
                      endpoints={boundaryEndpoints(routes, endpoints, models, false)}
                      label="외부로 나감"
                      routes={externalRoutes}
                    />
                  ) : null}
                  {routes.some((route) => route.candidateCount === 0) ? (
                    <section>
                      <SectionIntro title="실행되지 않는 요청" background="후보 모델이 없는 요청은 실행되지 않습니다." />
                      <div className="mt-1 space-y-[2px]">
                        {routes
                          .filter((route) => route.candidateCount === 0)
                          .map((route) => (
                            <p className="h-[30px] rounded-[4px] pl-8 pr-2 text-[13px] leading-[30px] text-halt" key={route.routeId}>
                              ⊘ {routeKindLabel(route.routeKind)} 쓸 수 있는 모델이 없어 실행되지 않습니다
                            </p>
                          ))}
                      </div>
                    </section>
                  ) : null}
                  {externalConnections.length > 0 ? (
                    <section>
                      <SectionIntro title="Provider" background="외부 Provider와 endpoint 주소입니다." />
                      <div className="mt-1 space-y-[2px]">
                        {externalConnections.map((connection) => (
                          <div key={connection.providerId}>
                            <div className="flex h-[30px] items-center justify-between gap-3 rounded-[4px] pl-8 pr-2">
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="truncate text-[13px] tracking-[-0.005em] text-fg-2">{connection.displayName}</span>
                                {connection.adapterKind ? <span className="font-mono text-[11px] text-fg-4">{connection.adapterKind}</span> : null}
                              </div>
                              <span className="shrink-0 text-[12px] text-fg-4">{connection.enabled ? "사용 중" : "꺼짐"}</span>
                            </div>
                            {connection.endpoints.map((endpoint) => (
                              <div className="flex h-[30px] items-center gap-3 rounded-[4px] pl-8" key={`${endpoint.name}-${endpoint.baseUrl}`}>
                                <span className="w-16 shrink-0 text-[12px] text-fg-3">외부</span>
                                <span className="truncate font-mono text-[11px] text-fg-4">{endpoint.baseUrl}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {externalModels.length > 0 ? (
                    <section>
                      <SectionIntro title="모델" background="외부 endpoint에 연결된 모델과 검증 상태입니다." />
                      <ModelList models={externalModels} />
                    </section>
                  ) : null}
                  <section
                    ref={(node) => {
                      sectionRefs.current.accounts = node;
                    }}
                  >
                    <SectionIntro title="계정" background="구독 계정별 잔여량과 초기화 시각을 보여줍니다." />
                    {accounts.length === 0 ? (
                      <p className="mt-1 text-[13px] leading-5 text-fg-3">연결된 구독 계정이 없습니다.</p>
                    ) : (
                      <div className="mt-1 space-y-[2px]">
                        {accounts.map((account) => (
                          <div className="flex h-[30px] items-center justify-between gap-3 rounded-[4px] pl-8 pr-2" key={account.accountId}>
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="truncate text-[13px] tracking-[-0.005em] text-fg-2">{account.alias}</span>
                              {account.billingKind ? <span className="shrink-0 text-[12px] text-fg-4">{billingKindLabel(account.billingKind)}</span> : null}
                            </div>
                            <span className="flex shrink-0 items-center gap-2">
                              {account.minimumRemainingRatio !== undefined ? <SummaryProgress value={account.minimumRemainingRatio} /> : null}
                              <span className="font-mono text-[11px] tabular-nums text-fg-4">{quotaText(account)}</span>
                              {account.earliestResetAt !== undefined && resetText(account.earliestResetAt) ? (
                                <span className="font-mono text-[11px] tabular-nums text-fg-4">{resetText(account.earliestResetAt)}</span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                  {credentials.length > 0 ? (
                    <section>
                      <SectionIntro title="자격 증명" background="저장된 자격 증명의 식별 정보만 표시합니다." />
                      <div className="mt-1 space-y-[2px]">
                        {credentials.map((credential) => (
                          <div className="flex h-[30px] items-center gap-4 rounded-[4px] pl-8 pr-2" key={credential.credentialId}>
                            {credential.label ? <span className="text-[13px] tracking-[-0.005em] text-fg-2">{credential.label}</span> : null}
                            {credential.credentialType ? <span className="font-mono text-[11px] text-fg-4">{credential.credentialType}</span> : null}
                            {credential.providerId ? <span className="font-mono text-[11px] text-fg-4">{credential.providerId}</span> : null}
                          </div>
                        ))}
                      </div>
                      <p className="mt-1 text-[13px] leading-5 text-fg-3">저장된 값은 다시 표시되지 않습니다.</p>
                    </section>
                  ) : null}
                </div>
              </div>
              <section className="mt-6 w-full">
                <div className="flex min-h-[30px] items-center justify-between gap-3">
                  <p className="text-[12px] leading-[18px] text-fg-4">관리</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      className="h-6 rounded-[4px] border border-line px-3 text-[12px] text-fg-3 transition-colors duration-150 hover:duration-0 hover:bg-white/[0.027] hover:text-fg motion-reduce:transition-none"
                      onClick={() => {
                        setZaiFormOpen((open) => !open);
                      }}
                      type="button"
                    >
                      Z.ai GLM-5.2 연결
                    </button>
                    <button
                      className="h-6 rounded-[4px] border border-line px-3 text-[12px] text-fg-3 transition-colors duration-150 hover:duration-0 hover:bg-white/[0.027] hover:text-fg motion-reduce:transition-none"
                      onClick={() => {
                        setProviderFormOpen((open) => !open);
                      }}
                      type="button"
                    >
                      다른 Provider 연결
                    </button>
                    <button
                      className="h-6 rounded-[4px] border border-line px-3 text-[12px] text-fg-3 transition-colors duration-150 hover:duration-0 hover:bg-white/[0.027] hover:text-fg motion-reduce:transition-none"
                      onClick={() => setAdvancedOpen((open) => !open)}
                      type="button"
                    >
                      고급 라우팅 설정
                    </button>
                  </div>
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
                <RouterConfiguration
                  onRefresh={setSettings}
                  open={advancedOpen}
                  service={service}
                  settings={settings}
                />
                {notice ? <p className="mt-3 text-[13px] leading-5 text-fg-3">{notice}</p> : null}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

const SETTINGS_AREAS = [
  {
    id: "routes",
    title: "모델 경로",
    hint: "어떤 요청이 어느 모델로",
    background: "요청 종류별 모델 경로와 예산을 보여줍니다.",
  },
  {
    id: "providers",
    title: "Provider 연결",
    hint: "모델을 어디서 받나",
    background: "Provider와 endpoint를 이 컴퓨터와 외부 경계로 나눠 보여줍니다.",
  },
  {
    id: "accounts",
    title: "구독 계정",
    hint: "남은 할당량",
    background: "구독 계정별 잔여량과 초기화 시각을 보여줍니다.",
  },
  {
    id: "autonomy",
    title: "실행 자율성",
    hint: "언제 사람을 기다리나",
    background: "실행 전 사람 확인이 필요한 경계를 정합니다.",
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

type CatalogEndpoint = {
  endpointId: string;
  providerId: string;
  name: string;
  baseUrl: string;
  local: boolean;
};

type CredentialItem = {
  credentialId: string;
  providerId: string;
  label: string;
  credentialType: string;
};

type SettingsModel = {
  modelProfileId: string;
  providerId: string;
  endpointId: string;
  modelId: string;
  routeKind: string;
  verified: boolean;
};

function modelsForSide(
  models: readonly SettingsModel[],
  endpoints: readonly CatalogEndpoint[] | undefined,
  local: boolean,
): readonly SettingsModel[] {
  if (!endpoints) return [];
  return models.filter((model) => endpoints.some((endpoint) => endpoint.endpointId === model.endpointId && endpoint.local === local));
}

function autonomyModeShortLabel(mode: AutonomyView["mode"]): string {
  return mode === "automatic" ? "자동" : mode === "review" ? "검토" : "전체 권한";
}

function autonomyModeLabel(mode: AutonomyView["mode"]): string {
  return mode === "automatic" ? "자동 실행" : mode === "review" ? "검토 후 실행" : "전체 권한";
}

function runtimeStatusLabel(autonomy: AutonomyView, emergency: EmergencyView | undefined): string {
  return autonomy.emergencyStopActive || emergency?.active === true
    ? "긴급 정지로 제한됨"
    : autonomy.runtimePermissionStatus === "full-access"
      ? "전체 권한"
      : "정책 적용";
}

function ModelList({ models }: { models: readonly SettingsModel[] }) {
  return (
    <div className="mt-1 space-y-[2px]">
      {models.map((model) => (
        <div className="flex h-[30px] items-center justify-between gap-3 rounded-[4px] pl-8 pr-2" key={model.modelProfileId}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-6 shrink-0 text-center text-[14px] leading-5 text-fg-3">{model.verified ? "◉" : "●"}</span>
            <span className="truncate font-mono text-[11px] text-fg-2">{model.modelId}</span>
            {model.routeKind ? <span className="shrink-0 text-[13px] tracking-[-0.005em] text-fg-2">{routeKindLabel(model.routeKind)}</span> : null}
          </div>
          <span className="shrink-0 text-[12px] text-fg-4">{model.verified ? "검증됨" : "미검증"}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-[18px] text-fg-4">{children}</p>;
}

function SummaryRow({ label, value, mono = true, progress }: { label: string; value?: React.ReactNode; mono?: boolean; progress?: number }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex min-h-[30px] items-center justify-between gap-2 px-2">
      <span className="text-[13px] leading-5 tracking-[-0.005em] text-fg-3">{label}</span>
      <span className={`flex items-center gap-2 ${mono ? "font-mono text-[11px] tabular-nums text-fg-4" : "text-[13px] text-fg-2"}`}>
        {progress !== undefined ? <SummaryProgress value={progress} /> : null}
        {value}
      </span>
    </div>
  );
}

function SummaryProgress({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, value * 100));
  return (
    <span className="inline-block h-[2px] w-[96px] shrink-0 bg-line align-middle" aria-hidden="true">
      <span
        className="block h-[2px] bg-fg-3 transition-[width] duration-[250ms] ease-linear motion-reduce:transition-none"
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function SectionIntro({ title, background }: { title: string; background: string | undefined }) {
  return (
    <div className="w-full">
      <p className="text-[12px] leading-[18px] text-fg-4">{title}</p>
      {background ? (
        <p className="mt-1 text-[13px] leading-5 text-fg-3">{background}</p>
      ) : null}
    </div>
  );
}

function BoundaryBand({ endpoints, label, routes }: {
  endpoints: readonly string[];
  label: string;
  routes: readonly ModelRouteView[];
}) {
  return (
    <section className="w-full min-w-0">
      <div className="flex h-[30px] items-center justify-between gap-2">
        <span className="text-[12px] leading-[18px] text-fg-4">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-fg-4">{routes.length}</span>
      </div>
      {endpoints.length > 0 ? (
        <div className="space-y-[2px]">
          {endpoints.map((endpoint) => (
            <div className="flex h-[30px] items-center gap-3 rounded-[4px] pl-8" key={endpoint}>
              <span className="w-16 shrink-0 text-[12px] text-fg-3">{label}</span>
              <span className="truncate font-mono text-[11px] text-fg-4">{endpoint}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-1 space-y-[2px]">
        {routes.map((route) => (
          <div className="flex h-[30px] items-center gap-2 rounded-[4px] pl-8 pr-2 transition-colors duration-150 hover:duration-0 hover:bg-white/[0.027] motion-reduce:transition-none" key={route.routeId}>
              <span className="w-6 shrink-0 text-center text-[14px] leading-5 text-fg-3">
                {route.primaryVerified === true ? "◉" : "●"}
              </span>
              <span className="truncate text-[13px] leading-5 tracking-[-0.005em] text-fg-2">{routeKindLabel(route.routeKind)}</span>
              {route.primaryModelId ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-fg-3">{route.primaryModelId}</span>
              ) : null}
              {route.totalBudgetMicros > 0 ? (
                <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums text-fg-4">
                  <SummaryProgress value={route.spentMicros / route.totalBudgetMicros} />
                  <span>{costText(route.spentMicros)} / {costText(route.totalBudgetMicros)}</span>
                </span>
              ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function catalogEndpoints(value: unknown): readonly CatalogEndpoint[] | undefined {
  const endpoints = value && typeof value === "object" ? (value as { endpoints?: unknown }).endpoints : undefined;
  if (!Array.isArray(endpoints)) return undefined;
  return endpoints.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.endpointId !== "string" ||
      typeof record.providerId !== "string" ||
      typeof record.name !== "string" ||
      typeof record.baseUrl !== "string" ||
      typeof record.local !== "boolean"
    ) {
      return [];
    }
    return [
      {
        endpointId: record.endpointId,
        providerId: record.providerId,
        name: record.name,
        baseUrl: record.baseUrl,
        local: record.local,
      },
    ];
  });
}

function boundaryEndpoints(
  routes: readonly ModelRouteView[],
  endpoints: readonly CatalogEndpoint[] | undefined,
  models: readonly { modelProfileId: string; providerId: string; endpointId: string; modelId: string; routeKind: string; verified: boolean }[],
  local: boolean,
): readonly string[] {
  if (!endpoints) return [];
  const urls = routes.flatMap((route) => {
    if (!route.primaryModelId) return [];
    const model = models.find((item) => item.modelId === route.primaryModelId);
    const endpoint = model ? endpoints.find((item) => item.endpointId === model.endpointId) : undefined;
    return endpoint?.local === local && endpoint.baseUrl ? [endpoint.baseUrl] : [];
  });
  return [...new Set(urls)];
}

function credentialItems(value: unknown): readonly CredentialItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const credentialId = typeof record.credentialId === "string" ? record.credentialId : `credential-${index}`;
    return [
      {
        credentialId,
        providerId: typeof record.providerId === "string" ? record.providerId : "",
        label: typeof record.label === "string" ? record.label : "",
        credentialType: typeof record.credentialType === "string" ? record.credentialType : "",
      },
    ];
  });
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
      className="mt-5 grid w-full grid-cols-2 gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsField label="연결 이름">
        <Input
          aria-label="연결 이름"
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
          onChange={(event) => {
            setSecret(event.target.value);
          }}
          required
          type="password"
          value={secret}
        />
      </SettingsField>
      <p className="col-span-2 text-[12px] leading-[18px] text-fg-3">
        API Key는 로컬 자격 증명 저장소에만 기록되며, 이 화면에는 다시 표시되지 않습니다.
      </p>
      <div className="col-span-2 flex justify-end">
        <Button className="rounded-[4px] text-[12px]" disabled={saving} type="submit">
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
      className="mt-5 grid w-full grid-cols-2 gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsField label="Provider ID">
        <Input
          aria-label="Provider ID"
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
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
          className="rounded-[4px] border-line-strong bg-canvas text-[13px]"
          onChange={(event) => {
            setSecret(event.target.value);
          }}
          required
          type="password"
          value={secret}
        />
      </SettingsField>
      <label className="col-span-2 flex items-center gap-2 text-[13px] text-fg-2">
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
        <Button className="rounded-[4px] text-[12px]" disabled={saving} type="submit">
          {saving ? "연결 중…" : "Provider 연결 추가"}
        </Button>
      </div>
    </form>
  );
}
function SettingsField({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="grid gap-2 text-[12px] leading-[18px] text-fg-4">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RouterConfiguration({
  service,
  settings,
  onRefresh,
  open,
}: {
  service: DesktopService;
  settings: SettingsView;
  onRefresh: (settings: SettingsView) => void;
  open: boolean;
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
  const refresh = async () => {
    onRefresh(await service.loadSettings());
  };
  const input = "rounded-[4px] border-line-strong bg-canvas text-[13px]";
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
    <>
      {open ? (
        <div className="mt-5 grid gap-5">
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
            <label className="text-[13px] text-fg-2">
              <input
                checked={model.verified}
                onChange={(event) => {
                  setModel({ ...model, verified: event.target.checked });
                }}
                type="checkbox"
              />{" "}
              검증됨
            </label>
            <Button className="rounded-[4px] text-[12px]" disabled={busy !== ""} type="submit">
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
            <Button className="rounded-[4px] text-[12px]" disabled={busy !== ""} type="submit">
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
            <Button
              className="rounded-[4px] text-[12px]"
              disabled={busy !== "" || !candidate.routeId || !candidate.modelProfileId}
              type="submit"
            >
              후보 연결
            </Button>
          </form>
        </div>
      ) : null}
    </>
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

function modelProfiles(value: unknown): readonly {
  modelProfileId: string;
  providerId: string;
  endpointId: string;
  modelId: string;
  routeKind: string;
  verified: boolean;
}[] {
  const models = value && typeof value === "object" ? (value as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.modelProfileId === "string" &&
      typeof record.providerId === "string" &&
      typeof record.endpointId === "string" &&
      typeof record.modelId === "string"
      ? [
          {
            modelProfileId: record.modelProfileId,
            providerId: record.providerId,
            endpointId: record.endpointId,
            modelId: record.modelId,
            routeKind: typeof record.routeKind === "string" ? record.routeKind : "",
            verified: record.verified === true,
          },
        ]
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
