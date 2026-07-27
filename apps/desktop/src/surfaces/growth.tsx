import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState } from "react";

import type { DesktopService, GrowthSignalView, GrowthView } from "@/desktop-service";
import { agentIdentityToken, growthTargetToken } from "@massion/application/client";

import { DecisionActions, OpenButton } from "@/room";
import { GrowthSection, SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

/**
 * 3열을 쓰는 이유를 각각 댑니다.
 *  - 목록: 제안이 여러 개일 때 스캔이 필요합니다. 상단 탭으로는 개수가 늘면 못 봅니다.
 *  - 판단: 증거를 위에서 아래로 끝까지 읽는 영역입니다. Work의 실시간 스트림과 달리 흐르지 않습니다.
 *  - 컨텍스트: 기억·효과·정책은 지금 판단할 대상이 아니라 배경입니다.
 */
export function GrowthSurface({
  error,
  growth,
  onOpenWork,
  onRetry,
  requestedSuggestionId,
  service,
}: {
  error: string;
  growth: GrowthView | undefined;
  onOpenWork: (workId: string) => void;
  onRetry: () => void;
  requestedSuggestionId: string | undefined;
  service: DesktopService;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<"waiting" | "all">("waiting");
  const [memoryKey, setMemoryKey] = useState("");
  const [memoryKind, setMemoryKind] = useState<"fact" | "preference" | "procedure">("preference");
  const [memoryValue, setMemoryValue] = useState("");
  const [memoryError, setMemoryError] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const [configurationSaving, setConfigurationSaving] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [decisionSaving, setDecisionSaving] = useState(false);
  useEffect(() => {
    if (growth === undefined) return;
    const requested = growth.suggestions.find((suggestion) => suggestion.suggestionId === requestedSuggestionId);
    if (requested !== undefined) setFilter("waiting");
    setSelectedId(
      (current) =>
        requested?.suggestionId ??
        growth.suggestions.find((suggestion) => suggestion.suggestionId === current)?.suggestionId ??
        growth.suggestions[0]?.suggestionId,
    );
  }, [growth, requestedSuggestionId]);

  const suggestions = growth?.suggestions ?? [];
  const visible = filter === "waiting" ? suggestions.filter((item) => item.status === "awaiting-review") : suggestions;
  const selected = visible.find((item) => item.suggestionId === selectedId) ?? visible[0];
  const effect = growth?.effects.find((item) => item.suggestionId === selected?.suggestionId);
  const blockers = growthBlockers(selected);
  const waitingCount = suggestions.filter((item) => item.status === "awaiting-review").length;
  const explicitMemory = growth?.memories[0];
  const memoryEntries = explicitMemory?.entries ?? [];
  const memoryRevision = explicitMemory?.revision ?? 0;

  const saveMemory = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = memoryKey.trim();
    const value = memoryValue.trim();
    if (!key || !value || memorySaving) return;
    setMemorySaving(true);
    setMemoryError("");
    try {
      await service.putExplicitMemory({ key, kind: memoryKind, value, revision: memoryRevision });
      setMemoryKey("");
      setMemoryValue("");
      onRetry();
    } catch (cause) {
      setMemoryError(surfaceErrorMessage(cause, "개인 기억을 저장하지 못했습니다."));
      onRetry();
    } finally {
      setMemorySaving(false);
    }
  };

  const forgetMemory = async (key: string) => {
    if (memorySaving) return;
    setMemorySaving(true);
    setMemoryError("");
    try {
      await service.forgetExplicitMemory({ key, revision: memoryRevision });
      onRetry();
    } catch (cause) {
      setMemoryError(surfaceErrorMessage(cause, "개인 기억을 사용 중지하지 못했습니다."));
      onRetry();
    } finally {
      setMemorySaving(false);
    }
  };

  const configureAdoptionMode = async (adoptionMode: "review" | "auto") => {
    const configuration = growth?.configuration;
    if (configuration === undefined || configuration.adoptionMode === adoptionMode || configurationSaving) return;
    setConfigurationSaving(true);
    setConfigurationError("");
    try {
      await service.configureGrowth({
        reflectionEnabled: configuration.reflectionEnabled,
        adoptionMode,
        ...(configuration.version === undefined ? {} : { expectedVersion: configuration.version }),
      });
      onRetry();
    } catch (cause) {
      setConfigurationError(surfaceErrorMessage(cause, "개선 반영 방식을 바꾸지 못했습니다."));
    } finally {
      setConfigurationSaving(false);
    }
  };

  const rejectSelected = async () => {
    if (selected === undefined || selected.revision === undefined || decisionSaving) return;
    setDecisionSaving(true);
    setDecisionError("");
    try {
      await service.rejectGrowthSuggestion({
        suggestionId: selected.suggestionId,
        expectedRevision: selected.revision,
        reason: "개선 상세에서 사용자가 거절했습니다",
      });
      onRetry();
    } catch (cause) {
      setDecisionError(surfaceErrorMessage(cause, "개선 제안을 거절하지 못했습니다."));
    } finally {
      setDecisionSaving(false);
    }
  };

  const approveSelected = async () => {
    if (selected === undefined || selected.revision === undefined || decisionSaving) return;
    setDecisionSaving(true);
    setDecisionError("");
    try {
      await service.approveGrowthSuggestion({
        suggestionId: selected.suggestionId,
        expectedRevision: selected.revision,
        reason: "개선 상세에서 사용자가 승인했습니다",
      });
      onRetry();
    } catch (cause) {
      setDecisionError(surfaceErrorMessage(cause, "개선 제안을 승인하지 못했습니다."));
    } finally {
      setDecisionSaving(false);
    }
  };

  if (error) {
    return (
      <main aria-label="개선" className="col-span-3 min-h-0 overflow-y-auto bg-canvas px-8 py-7">
        <SurfaceError message={error} />
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          다시 불러오기
        </Button>
      </main>
    );
  }
  if (growth === undefined) {
    return (
      <main aria-label="개선" className="col-span-3 grid min-h-0 place-items-center bg-canvas">
        <SurfaceLoading />
      </main>
    );
  }

  return (
    <main
      aria-label="개선"
      className="col-span-3 grid min-h-0 min-w-0 grid-cols-[242px_minmax(0,1fr)_300px] bg-canvas min-[1440px]:grid-cols-[264px_minmax(0,1fr)_332px]"
    >
      <section
        aria-label="개선 제안 목록"
        className="grid min-h-0 grid-rows-[46px_auto_minmax(0,1fr)] border-r border-border bg-chrome"
      >
        <header className="flex items-center gap-2 border-b border-border px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em]">개선</h1>
          {waitingCount ? <span className="font-mono text-[11px] text-gate">{waitingCount}</span> : null}
        </header>
        {/* 업무 목록과 같은 필터 구역. 표면을 옮겨도 같은 자리에서 같은 일을 합니다. */}
        <div className="border-b border-border px-2.5 py-2.5">
          <Tabs
            onValueChange={(value) => {
              setFilter(value as "waiting" | "all");
            }}
            value={filter}
          >
            <TabsList aria-label="제안 상태" className="gap-1">
              <TabsTrigger
                className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
                value="waiting"
              >
                승인 대기 {waitingCount}
              </TabsTrigger>
              <TabsTrigger
                className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
                value="all"
              >
                전체 {suggestions.length}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {visible.length === 0 ? (
            // 제안이 하나도 없는 것과 필터에 걸리는 게 없는 것은 다른 사실입니다.
            <p className="px-3 py-8 text-center text-sm text-muted">
              {suggestions.length === 0
                ? "조직이 아직 바꾸자고 제안한 것이 없습니다."
                : "승인을 기다리는 제안이 없습니다."}
            </p>
          ) : (
            // grid는 아이템의 min-width가 auto라 긴 제목이 열을 밀어냅니다. 업무 목록과 같은 방식을 씁니다.
            <div className="divide-y divide-border border-b border-border">
              {visible.map((suggestion) => {
                const current = suggestion.suggestionId === selected?.suggestionId;
                const waiting = suggestion.status === "awaiting-review";
                return (
                  <button
                    aria-pressed={current}
                    className={`relative w-full px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                      current
                        ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                        : "hover:bg-surface-1"
                    }`}
                    key={suggestion.suggestionId}
                    onClick={() => {
                      setSelectedId(suggestion.suggestionId);
                    }}
                    type="button"
                  >
                    <span className="block truncate text-[13px] font-medium text-primary">{suggestion.summary}</span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                      <span className={`flex items-center gap-2 ${waiting ? "text-gate" : "text-muted"}`}>
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                        {waiting ? "승인 대기" : growthSuggestionStatus(suggestion.status)}
                      </span>
                      <time className="font-mono text-muted">{growthClock(suggestion.createdAt)}</time>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <div className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)]">
        <header className="flex min-w-0 items-center gap-2 border-b border-border px-4">
          {selected ? (
            <>
              <h2 className="truncate text-[16px] font-semibold tracking-[-0.02em]">{selected.summary}</h2>
              {/* 무엇을 바꾸는지는 위험도와 직결됩니다. 원시 enum이 아니라 사람의 말로 씁니다. */}
              <span
                className="shrink-0 rounded-[3px] border border-control px-1.5 text-[10px] text-muted"
                title={growthTargetToken(selected.targetKind).description}
              >
                {growthTargetToken(selected.targetKind).label}
              </span>
              <span
                className={`shrink-0 text-[11px] ${selected.status === "awaiting-review" ? "text-gate" : "text-muted"}`}
              >
                {selected.status === "awaiting-review" ? "승인 대기" : growthSuggestionStatus(selected.status)}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                {selected.revision === undefined ? "" : `rev ${String(selected.revision)}`}
              </span>
            </>
          ) : null}
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {selected ? (
            <article className="mx-auto max-w-[76ch]">
              {/*
               * growth_suggestion.operation은 스키마에 ASSERT가 없는 자유 문자열입니다(schema.ts:268).
               * 열거가 아니라 문구 표를 만들 수 없으므로 원문을 mono로 강등해 둡니다.
               */}
              <p className="font-mono text-[11px] text-muted" title="개선 작업 종류">
                {selected.operation}
              </p>

              {/* 어떤 작업에서 이 제안이 올라왔는지가 추적 가능해야 합니다. 헌법 목표 3의 완료 조건입니다. */}
              <GrowthSection title="어디서 나왔나">
                <ul className="grid gap-0 divide-y divide-border border-y border-border">
                  {selected.sourceReferenceIds?.map((reference) => (
                    <GrowthSourceRow key={reference} onOpenWork={onOpenWork} reference={reference} />
                  ))}
                  {selected.reflectionRunId ? (
                    <li className="grid grid-cols-[68px_minmax(0,1fr)] items-baseline gap-2 py-2">
                      <span className="text-[12px] text-muted">회고</span>
                      <span className="font-mono text-[11px] text-secondary">{selected.reflectionRunId}</span>
                    </li>
                  ) : null}
                </ul>
              </GrowthSection>

              <GrowthSection title="왜">
                <p className="text-[13px] leading-6 text-primary">{selected.rationale}</p>
              </GrowthSection>

              {selected.evaluation ? (
                <GrowthSection title="평가">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-[3px] border px-1.5 py-0.5 text-[11px] ${
                        selected.evaluation.outcome === "eligible"
                          ? "border-control text-secondary"
                          : "border-danger text-danger"
                      }`}
                    >
                      {growthEvaluationLabel(selected.evaluation.outcome)}
                    </span>
                    <span className="text-[11px] text-muted">
                      평가 전략 {selected.evaluation.strategyVersionId.replace(/^strategy-/u, "")}
                    </span>
                    <span
                      className="font-mono text-[11px] text-muted"
                      title={`평가 실행 ${selected.evaluation.evaluationRunId}`}
                    >
                      {selected.evaluation.evaluationRunId}
                    </span>
                  </div>
                  <ul className="mt-2.5 grid gap-0 divide-y divide-border border-y border-border">
                    {selected.evaluation.signals.map((signal) => (
                      <GrowthSignalRow key={signal.signalId} signal={signal} />
                    ))}
                  </ul>
                  {/* 4.8: LLM 자기평가 하나만으로 자동 채택할 수 없습니다. 화면이 그 구분을 유지합니다. */}
                  <p className="mt-2 text-[11px] leading-5 text-muted">
                    자기평가 신호는 모델이 스스로 매긴 점수이며 독립 근거로 계산하지 않습니다.
                  </p>
                </GrowthSection>
              ) : null}

              {selected.patch?.length ? (
                <GrowthSection title="무엇이 바뀌나">
                  {selected.patch.map((line) => (
                    <div className="grid gap-1" key={line.path}>
                      <p className="text-[11px] text-muted">
                        {line.targetHandle === undefined
                          ? line.path
                          : `${agentIdentityToken(line.targetHandle).name} · ${line.path}`}
                      </p>
                      <p className="rounded-[5px] border border-border bg-surface-1 px-3 py-2 text-[12px] leading-5 text-muted line-through">
                        {line.before}
                      </p>
                      <p className="rounded-[5px] border border-line-strong bg-surface-1 px-3 py-2 text-[12px] leading-5 text-primary">
                        {line.after}
                      </p>
                    </div>
                  ))}
                </GrowthSection>
              ) : null}

              <GrowthSection title="승인하면">
                <dl className="grid gap-1.5 text-[13px] leading-6">
                  <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
                    <dt className="text-[12px] text-muted">나아지는 것</dt>
                    <dd className="text-primary">{selected.expectedEffect}</dd>
                  </div>
                  <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
                    <dt className="text-[12px] text-danger">감수할 것</dt>
                    <dd className="text-primary">{selected.riskSummary}</dd>
                  </div>
                </dl>
              </GrowthSection>

              {effect?.measure ? (
                <GrowthSection title="적용 후 측정">
                  <p className="text-[13px] text-secondary">
                    {effect.measure.unit} {effect.measure.baseline} → {effect.measure.score} (
                    {effect.measure.direction === "lower" ? "낮을수록 좋음" : "높을수록 좋음"})
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    표본 {effect.measure.observationCount} / 최소 {effect.measure.minimumObservations} ·{" "}
                    {growthEffectStatus(effect.result)}
                  </p>
                </GrowthSection>
              ) : null}

              <footer className="mt-7 border-t border-border pt-3.5">
                {blockers.length ? (
                  <ul className="mb-2.5 grid gap-1">
                    {blockers.map((blocker) => (
                      <li className="flex items-start gap-2 text-[12px] leading-5 text-danger" key={blocker}>
                        <span aria-hidden="true">⊘</span>
                        {blocker}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {decisionError ? <p className="mb-2.5 text-[12px] text-danger">{decisionError}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-[11px] text-muted">결정은 이 상세의 근거를 확인한 뒤 기록합니다.</span>
                  <DecisionActions
                    approveName={selected.summary}
                    busy={decisionSaving}
                    onApprove={() => {
                      void approveSelected();
                    }}
                    onReject={() => {
                      void rejectSelected();
                    }}
                    approveDisabled={selected.revision === undefined || selected.status !== "awaiting-review"}
                    rejectDisabled={selected.revision === undefined || selected.status !== "awaiting-review"}
                  />
                </div>
              </footer>
            </article>
          ) : null}
        </div>
      </div>

      <aside aria-label="배경" className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome">
        <header className="flex items-center border-b border-border px-3">
          <span className="text-[13px] font-medium text-secondary">배경</span>
        </header>
        <div className="min-h-0 overflow-y-auto p-3">
          <section aria-label="내 기억">
            <h2 className="mb-2 flex items-baseline gap-2 text-[10px] font-semibold tracking-[0.08em] text-muted">
              내 기억<span className="font-mono text-[11px] font-normal">{memoryEntries.length}</span>
            </h2>
            {memoryEntries.length === 0 ? (
              <p className="text-xs text-muted">직접 저장한 기억이 없습니다.</p>
            ) : (
              <ul className="grid gap-1.5">
                {memoryEntries.map((memory) => (
                  <li className="rounded-[7px] border border-border bg-surface-1 px-3 py-2.5" key={memory.key}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium">{memory.key}</span>
                      <span className="rounded-[3px] border border-control px-1 text-[10px] text-muted">
                        {explicitMemoryKindLabel[memory.kind]}
                      </span>
                      <span className="font-mono text-[10px] text-muted">v{memoryRevision}</span>
                    </div>
                    <p className="mt-1 text-[12px] leading-5 text-primary">{memory.value}</p>
                    <button
                      className="mt-2 text-[11px] text-muted underline-offset-2 hover:text-primary hover:underline disabled:opacity-45"
                      disabled={memorySaving}
                      onClick={() => {
                        void forgetMemory(memory.key);
                      }}
                      type="button"
                    >
                      앞으로 사용하지 않음
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-5 text-muted">
              직접 저장한 기억은 다음 새 업무부터 적용됩니다. 과거 업무의 실행 계보는 바뀌지 않습니다.
            </p>
            <form aria-label="개인 기억 저장" className="mt-3 grid gap-2" onSubmit={(event) => void saveMemory(event)}>
              <Input
                aria-label="기억 키"
                disabled={memorySaving}
                maxLength={120}
                onChange={(event) => {
                  setMemoryKey(event.target.value);
                }}
                placeholder="기억 키"
                value={memoryKey}
              />
              <label className="grid gap-1 text-[11px] text-muted">
                종류
                <select
                  aria-label="기억 종류"
                  className="h-8 rounded-[5px] border border-border bg-surface-1 px-2 text-[12px] text-primary outline-none focus:border-control"
                  disabled={memorySaving}
                  onChange={(event) => {
                    setMemoryKind(event.target.value as "fact" | "preference" | "procedure");
                  }}
                  value={memoryKind}
                >
                  <option value="fact">사실</option>
                  <option value="preference">선호</option>
                  <option value="procedure">절차</option>
                </select>
              </label>
              <Textarea
                aria-label="기억 내용"
                disabled={memorySaving}
                maxLength={4000}
                onChange={(event) => {
                  setMemoryValue(event.target.value);
                }}
                placeholder="다음 업무부터 기억할 내용을 적어주세요"
                rows={3}
                value={memoryValue}
              />
              <Button
                disabled={memorySaving || !memoryKey.trim() || !memoryValue.trim()}
                size="sm"
                type="submit"
                variant="outline"
              >
                {memorySaving ? "저장 중…" : "기억 저장"}
              </Button>
            </form>
            {memoryError ? (
              <p role="alert" className="mt-2 text-[11px] leading-5 text-danger">
                {memoryError}
              </p>
            ) : null}
          </section>

          {growth.effects.some((item) => item.suggestionId === undefined) ? (
            <section aria-label="확인된 효과" className="mt-6">
              <h2 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-muted">확인된 효과</h2>
              <ul className="grid gap-1.5">
                {growth.effects
                  .filter((item) => item.suggestionId === undefined)
                  .map((item) => (
                    <li
                      className="flex flex-wrap items-baseline gap-x-2 rounded-[7px] border border-border bg-surface-1 px-3 py-2 text-[12px]"
                      key={item.effectEvaluationId}
                    >
                      <span className="flex-1 text-secondary">{growthEffectStatus(item.result)}</span>
                      <span className="font-mono text-[10px] text-muted">{item.adoptionId}</span>
                    </li>
                  ))}
              </ul>
              {/* 효과는 adoptionId만 갖고 어느 제안에서 왔는지는 계약에 없습니다. 연결되면 제안 상세로 옮깁니다. */}
              <p className="mt-2 text-[11px] leading-5 text-muted">
                어느 제안에서 온 효과인지는 아직 조회로 연결되지 않았습니다.
              </p>
            </section>
          ) : null}

          {growth.configuration ? (
            <section aria-label="개선 정책" className="mt-6">
              <h2 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-muted">개선 정책</h2>
              <p className="text-[12px] leading-5 text-secondary">
                {growth.configuration.reflectionEnabled
                  ? "완료된 실행에서 개선 후보를 찾습니다."
                  : "개선 후보 수집이 중지돼 있습니다."}
                {growth.configuration.adoptionMode === "review"
                  ? " 승인은 사람의 검토를 거칩니다."
                  : " 정책이 허용한 범위에서 자동 승인합니다."}
              </p>
              <label className="mt-3 grid gap-1 text-[11px] text-muted">
                반영 방식
                <select
                  aria-label="개선 반영 방식"
                  className="h-8 rounded-[5px] border border-border bg-surface-1 px-2 text-[12px] text-primary outline-none focus:border-control disabled:opacity-50"
                  disabled={configurationSaving}
                  onChange={(event) => {
                    void configureAdoptionMode(event.target.value as "review" | "auto");
                  }}
                  value={growth.configuration.adoptionMode}
                >
                  <option value="review">검토 후 반영</option>
                  <option value="auto">검증되면 자동 반영</option>
                </select>
              </label>
              {configurationError ? (
                <p role="alert" className="mt-2 text-[11px] leading-5 text-danger">
                  {configurationError}
                </p>
              ) : null}
              <p className="mt-1.5 text-[10px] leading-4 text-muted">
                이 정책은 승인된 결정에 근거합니다{" "}
                <span className="font-mono">{growth.configuration.governanceDecisionId}</span>
              </p>
            </section>
          ) : null}
        </div>
      </aside>
    </main>
  );
}

/** `kind:id`를 사람이 읽는 한 줄로. 조직 핸들이면 에이전트 이름으로 풉니다. */
function growthSourceLabelOf(reference: string): string {
  const separator = reference.indexOf(":");
  if (separator < 0) return reference;
  const kind = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  return `${growthSourceLabel[kind] ?? kind} ${id}`;
}

const growthSourceLabel: Record<string, string> = {
  work: "업무",
  message: "협업방 발언",
  verification: "검증",
  organization: "조직 변경",
  execution: "실행",
  artifact: "산출물",
};

const explicitMemoryKindLabel = {
  fact: "사실",
  preference: "선호",
  procedure: "절차",
} as const;

/** `kind:id` 형태의 source reference를 사람이 읽는 줄로 풉니다. 업무는 그 자리에서 열 수 있습니다. */
function GrowthSourceRow({ onOpenWork, reference }: { onOpenWork: (workId: string) => void; reference: string }) {
  const separator = reference.indexOf(":");
  const kind = separator < 0 ? "" : reference.slice(0, separator);
  const id = separator < 0 ? reference : reference.slice(separator + 1);
  // organization 참조는 조직 핸들이므로 에이전트 이름으로 풉니다.
  const display = kind === "organization" ? agentIdentityToken(id).name : id;
  return (
    <li className="grid grid-cols-[68px_minmax(0,1fr)_auto] items-baseline gap-2 py-2">
      <span className="text-[12px] text-muted">{growthSourceLabel[kind] ?? (kind === "" ? "근거" : kind)}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-primary" title={reference}>
        {display}
      </span>
      {kind === "work" ? (
        <OpenButton
          label={`업무 ${id} 열기`}
          onOpen={() => {
            onOpenWork(id);
          }}
          small
        />
      ) : (
        <span />
      )}
    </li>
  );
}

const growthSignalGroupLabel = { required: "필수", supporting: "보강", conflict: "반대" } as const;
const growthSignalOriginLabel = {
  deterministic: "결정론",
  independent: "독립 검증",
  "model-self": "자기평가",
} as const;

function GrowthSignalRow({ signal }: { signal: GrowthSignalView }) {
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)_78px_44px] items-baseline gap-2 py-2 text-[12px]">
      {/* 반대 근거는 색으로도 구분합니다. 통과 여부와 다른 축입니다. */}
      <span className={signal.group === "conflict" ? "text-danger" : "text-muted"}>
        {growthSignalGroupLabel[signal.group]}
      </span>
      <span className="min-w-0">
        <span className="block leading-5 text-primary">{signal.note}</span>
        <span className="mt-0.5 block font-mono text-[10px] text-muted">
          {signal.adapterId} {signal.adapterVersion}
        </span>
      </span>
      <span className={signal.origin === "model-self" ? "text-[11px] italic text-muted" : "text-[11px] text-muted"}>
        {growthSignalOriginLabel[signal.origin]}
      </span>
      <span
        className={`text-right font-mono text-[11px] ${signal.outcome === "failed" ? "text-danger" : "text-secondary"}`}
      >
        {signal.score.toFixed(2)}
      </span>
    </li>
  );
}

function growthEvaluationLabel(outcome: "eligible" | "ineligible" | "blocked"): string {
  if (outcome === "eligible") return "승인 가능";
  if (outcome === "ineligible") return "요건 미달";
  return "차단됨";
}

/** 승인을 막는 사유. 도메인이 강제하는 전제조건을 화면이 미리 말합니다. */
function growthBlockers(suggestion: GrowthView["suggestions"][number] | undefined): string[] {
  if (!suggestion) return [];
  const blockers: string[] = [];
  if (suggestion.evaluation === undefined)
    blockers.push("평가가 아직 실행되지 않았습니다. 평가 없이는 승인할 수 없습니다.");
  else if (suggestion.evaluation.outcome !== "eligible") {
    const failed = suggestion.evaluation.signals.filter(
      (signal) => signal.group === "required" && signal.outcome === "failed",
    );
    blockers.push(
      failed.length
        ? `필수 신호가 통과하지 못했습니다 · ${failed.map((signal) => signal.adapterId).join(" · ")}`
        : "평가 결과가 승인 요건을 만족하지 않습니다.",
    );
  }
  if (suggestion.targetDrifted === true)
    blockers.push("제안 이후 대상이 바뀌었습니다. 다시 평가해야 승인할 수 있습니다.");
  return blockers;
}

/** 업무 목록의 시각 표기와 같은 형식을 씁니다. */
function growthClock(createdAt: string | undefined): string {
  if (createdAt === undefined) return "";
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toTimeString().slice(0, 5);
}

function growthSuggestionStatus(status: string): string {
  return status === "awaiting-review" ? "검토 대기" : status === "adopted" ? "반영됨" : status;
}
function growthEffectStatus(result: GrowthView["effects"][number]["result"]): string {
  return result === "improved"
    ? "개선 확인"
    : result === "stable"
      ? "변화 없음"
      : result === "degraded"
        ? "저하 관찰"
        : "판단 보류";
}
