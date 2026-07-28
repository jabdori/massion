import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import type { DesktopService, GrowthSignalView, GrowthView } from "@/desktop-service";
import { agentIdentityToken, growthTargetToken } from "@massion/application/client";

import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

const growthAgentAccent = [
  "text-agent-0",
  "text-agent-1",
  "text-agent-2",
  "text-agent-3",
  "text-agent-4",
  "text-agent-5",
  "text-agent-6",
  "text-agent-7",
] as const;
const growthAgentAccentBg = [
  "bg-agent-0",
  "bg-agent-1",
  "bg-agent-2",
  "bg-agent-3",
  "bg-agent-4",
  "bg-agent-5",
  "bg-agent-6",
  "bg-agent-7",
] as const;

type GrowthSuggestion = GrowthView["suggestions"][number];
type GrowthEffect = GrowthView["effects"][number];
type GrowthOrigin = GrowthSignalView["origin"];

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
  const waitingCount = suggestions.filter((item) => item.status === "awaiting-review").length;
  const explicitMemory = growth?.memories[0];
  const memoryEntries = explicitMemory?.entries ?? [];
  const memoryRevision = explicitMemory?.revision ?? 0;

  const saveMemory = async (event: FormEvent<HTMLFormElement>) => {
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
      <main aria-label="개선" className="col-span-3 min-h-0 overflow-y-auto bg-canvas px-6 py-6">
        <SurfaceError message={error} />
        <button
          className="mt-3 h-[30px] rounded-[4px] border border-line-strong px-3 text-[13px] text-fg-2 transition-colors duration-150 hover:bg-white/[0.027]"
          onClick={onRetry}
          type="button"
        >
          다시 불러오기
        </button>
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
    <main aria-label="개선" className="col-span-3 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_320px] bg-canvas">
      <section className="grid min-h-0 grid-rows-[48px_auto_minmax(0,1fr)_48px]">
        <header className="flex min-w-0 items-center gap-3 border-b border-line-strong px-4">
          <h1 className="text-[15px] font-semibold text-fg">개선</h1>
          <span className="text-[13px] text-fg-4">{waitingCount}</span>
          <div className="ml-4 flex items-center gap-1">
            <button
              aria-pressed={filter === "waiting"}
              className={`h-[30px] rounded-[4px] px-2 text-[13px] transition-colors duration-150 ${filter === "waiting" ? "bg-white/[0.047] text-fg-2" : "text-fg-4 hover:bg-white/[0.027]"}`}
              onClick={() => setFilter("waiting")}
              type="button"
            >
              승인 대기 {waitingCount}
            </button>
            <button
              aria-pressed={filter === "all"}
              className={`h-[30px] rounded-[4px] px-2 text-[13px] transition-colors duration-150 ${filter === "all" ? "bg-white/[0.047] text-fg-2" : "text-fg-4 hover:bg-white/[0.027]"}`}
              onClick={() => setFilter("all")}
              type="button"
            >
              전체 {suggestions.length}
            </button>
          </div>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-4">
            {selected?.revision === undefined ? "" : `rev ${String(selected.revision)}`}
          </span>
        </header>

        <div className="min-w-0 px-4 py-2">
          {visible.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-fg-4">
              {suggestions.length === 0 ? "조직이 아직 바꾸자고 제안한 것이 없습니다." : "승인을 기다리는 제안이 없습니다."}
            </p>
          ) : (
            <div className="grid gap-0.5">
              {visible.map((suggestion) => (
                <GrowthSuggestionRow
                  current={suggestion.suggestionId === selected?.suggestionId}
                  key={suggestion.suggestionId}
                  onSelect={setSelectedId}
                  suggestion={suggestion}
                />
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-4">
          {selected ? (
            <article className="min-w-0">
              <h2 className="mb-4 truncate text-[17px] font-semibold text-fg-2" title={selected.summary}>{selected.summary}</h2>
              <GrowthGateBand suggestion={selected} />

              <GrowthSection className="mt-6" title="신호">
                <GrowthSignalGroups evaluation={selected.evaluation} />
              </GrowthSection>

              <div className="mt-6 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-8">
                <div className="min-w-0">
                  <GrowthSection title="왜">
                    {selected.rationale ? <p className="text-[13px] leading-5 text-fg-2">{selected.rationale}</p> : null}
                  </GrowthSection>
                  <GrowthSection className="mt-6" title="승인하면">
                    <dl className="grid gap-0.5">
                      {selected.expectedEffect ? (
                        <div className="grid min-h-[30px] grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                          <dt className="text-[12px] text-fg-4">나아지는 것</dt>
                          <dd className="text-[13px] text-fg-2">{selected.expectedEffect}</dd>
                        </div>
                      ) : null}
                      {selected.riskSummary ? (
                        <div className="grid min-h-[30px] grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
                          <dt className="text-[12px] text-fg-4">감수할 것</dt>
                          <dd className="text-[13px] text-fg-2">{selected.riskSummary}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </GrowthSection>
                </div>
                <div className="min-w-0">
                  <GrowthSection title="어디서 나왔나">
                    <div className="grid gap-0.5">
                      {selected.sourceReferenceIds?.map((reference) => (
                        <GrowthSourceRow key={reference} onOpenWork={onOpenWork} reference={reference} />
                      ))}
                      {selected.reflectionRunId ? <GrowthSourceRow reference={`reflection:${selected.reflectionRunId}`} /> : null}
                    </div>
                  </GrowthSection>
                  {selected.patch?.length ? (
                    <GrowthSection className="mt-6" title="무엇이 바뀌나">
                      <div className="grid gap-0.5">{selected.patch.map((line) => <GrowthPatchRows key={line.path} line={line} />)}</div>
                    </GrowthSection>
                  ) : null}
                </div>
              </div>

              {growth.effects.length ? <GrowthEffectBlock effects={growth.effects} suggestions={suggestions} /> : null}
            </article>
          ) : (
            <p className="text-[13px] text-fg-4">상세를 표시할 제안이 없습니다.</p>
          )}
        </div>

        <footer className="flex min-w-0 items-center gap-3 border-t border-line-strong bg-canvas px-4">
          {decisionError ? (
            <span className="min-w-0 truncate text-[12px] text-halt" role="alert">{decisionError}</span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">결정은 이 상세의 근거를 확인한 뒤 기록합니다.</span>
          )}
          {selected ? (
            <>
              <button
                aria-label={`${selected.summary} 거절`}
                className="h-[30px] shrink-0 rounded-[4px] border border-line-strong px-3 text-[13px] text-fg-2 transition-colors duration-150 hover:bg-white/[0.027] disabled:opacity-50"
                disabled={decisionSaving || selected.revision === undefined || selected.status !== "awaiting-review"}
                onClick={() => { void rejectSelected(); }}
                type="button"
              >
                {decisionSaving ? "처리 중" : "거절"}
              </button>
              <button
                aria-label={`${selected.summary} 승인`}
                className="h-[30px] shrink-0 rounded-[4px] bg-gate px-3 text-[13px] font-medium text-gate-ink transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
                disabled={decisionSaving || selected.revision === undefined || selected.status !== "awaiting-review"}
                onClick={() => { void approveSelected(); }}
                type="button"
              >
                {decisionSaving ? "처리 중" : "승인"}
              </button>
            </>
          ) : null}
        </footer>
      </section>

      <aside aria-label="원장" className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-l border-line-strong bg-chrome">
        <header className="flex items-center border-b border-line-strong px-3">
          <span className="text-[13px] font-medium text-fg-2">원장</span>
        </header>
        <div className="min-h-0 overflow-y-auto p-3">
          <GrowthLedgerEvents
            effects={growth.effects}
            onSelect={setSelectedId}
            selectedId={selected?.suggestionId}
            suggestions={suggestions}
          />

          {growth.configuration ? (
            <section className="mt-6" aria-label="개선 정책">
              <h2 className="mb-2 text-[13px] font-medium text-fg-4">개선 정책</h2>
              <p className="truncate text-[13px] text-fg-2" title={growth.configuration.reflectionEnabled ? "완료된 실행에서 개선 후보를 찾습니다." : "개선 후보 수집이 중지돼 있습니다."}>
                {growth.configuration.reflectionEnabled ? "완료된 실행에서 개선 후보를 찾습니다." : "개선 후보 수집이 중지돼 있습니다."}
              </p>
              <label className="mt-3 grid gap-1 text-[12px] text-fg-4">
                반영 방식
                <select
                  aria-label="개선 반영 방식"
                  className="h-[30px] rounded-[4px] border border-line bg-surface-2 px-2 text-[13px] text-fg-2 outline-none focus:border-line-strong disabled:opacity-50"
                  disabled={configurationSaving}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "review" || value === "auto") void configureAdoptionMode(value);
                  }}
                  value={growth.configuration.adoptionMode}
                >
                  <option value="review">검토 후 반영</option>
                  <option value="auto">검증되면 자동 반영</option>
                </select>
              </label>
              {configurationError ? <p className="mt-2 truncate text-[12px] text-halt" role="alert">{configurationError}</p> : null}
              <p className="mt-2 truncate font-mono text-[11px] text-fg-4" title={growth.configuration.governanceDecisionId}>
                {growth.configuration.governanceDecisionId}
              </p>
            </section>
          ) : null}

          <section className="mt-6" aria-label="내 기억">
            <h2 className="mb-2 flex items-baseline gap-2 text-[13px] font-medium text-fg-4">
              내 기억 <span className="font-mono font-normal">{memoryEntries.length}</span>
            </h2>
            {memoryEntries.length === 0 ? (
              <p className="text-[13px] text-fg-4">직접 저장한 기억이 없습니다.</p>
            ) : (
              <div className="grid gap-0.5">
                {memoryEntries.map((memory) => (
                  <div className="flex h-[30px] min-w-0 items-center gap-2 rounded-[4px] px-2 hover:bg-white/[0.027]" key={memory.key}>
                    <span className="w-24 shrink-0 truncate text-[13px] text-fg-3" title={memory.key}>{memory.key}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2" title={memory.value}>{memory.value}</span>
                    <button
                      aria-label="앞으로 사용하지 않음"
                      className="h-[30px] w-[30px] shrink-0 rounded-[4px] text-[14px] text-fg-4 transition-colors duration-150 hover:bg-white/[0.027] hover:text-fg disabled:opacity-50"
                      disabled={memorySaving}
                      onClick={() => { void forgetMemory(memory.key); }}
                      title="앞으로 사용하지 않음"
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <form aria-label="개인 기억 저장" className="mt-6 flex flex-col gap-2" onSubmit={(event) => void saveMemory(event)}>
            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
              <input
                aria-label="기억 키"
                className="h-[30px] min-w-0 rounded-[4px] border border-line bg-surface-2 px-2 text-[13px] text-fg-2 outline-none placeholder:text-fg-4 focus:border-line-strong"
                disabled={memorySaving}
                maxLength={120}
                onChange={(event) => { setMemoryKey(event.target.value); }}
                placeholder="기억 키"
                value={memoryKey}
              />
              <select
                aria-label="기억 종류"
                className="h-[30px] rounded-[4px] border border-line bg-surface-2 px-2 text-[13px] text-fg-2 outline-none focus:border-line-strong"
                disabled={memorySaving}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "fact" || value === "preference" || value === "procedure") setMemoryKind(value);
                }}
                value={memoryKind}
              >
                <option value="fact">사실</option>
                <option value="preference">선호</option>
                <option value="procedure">절차</option>
              </select>
            </div>
            <textarea
              aria-label="기억 내용"
              className="h-[64px] resize-none rounded-[4px] border border-line bg-surface-2 p-2 text-[13px] text-fg-2 outline-none placeholder:text-fg-4 focus:border-line-strong"
              disabled={memorySaving}
              maxLength={4000}
              onChange={(event) => { setMemoryValue(event.target.value); }}
              placeholder="다음 업무부터 기억할 내용을 적어주세요"
              value={memoryValue}
            />
            <button
              className="h-[30px] self-end rounded-[4px] border border-line px-3 text-[13px] text-fg-2 transition-colors duration-150 hover:bg-white/[0.027] disabled:opacity-50"
              disabled={memorySaving || !memoryKey.trim() || !memoryValue.trim()}
              type="submit"
            >
              {memorySaving ? "저장 중…" : "기억 저장"}
            </button>
            {memoryError ? <p className="truncate text-[12px] text-halt" role="alert">{memoryError}</p> : null}
          </form>
        </div>
      </aside>
    </main>
  );
}

function GrowthSuggestionRow({
  current,
  onSelect,
  suggestion,
}: {
  current: boolean;
  onSelect: (suggestionId: string) => void;
  suggestion: GrowthSuggestion;
}) {
  const glyph = growthSuggestionGlyph(suggestion);
  const identity = growthSuggestionTargetIdentity(suggestion);
  const target = growthTargetToken(suggestion.targetKind);
  const counts = growthSignalCounts(suggestion.evaluation?.signals);
  return (
    <button
      aria-pressed={current}
      className={`grid h-[30px] w-full min-w-0 grid-cols-[16px_minmax(0,1fr)_minmax(160px,220px)_72px_120px_64px_48px] items-center gap-2 rounded-[4px] px-2 text-left transition-colors duration-150 ${current ? "bg-white/[0.047]" : "hover:bg-white/[0.027]"}`}
      onClick={() => onSelect(suggestion.suggestionId)}
      type="button"
    >
      <span aria-hidden="true" className={`text-[16px] leading-none ${glyph.className}`}>{glyph.value}</span>
      <span className="min-w-0 truncate text-[13px] text-fg-2" title={suggestion.summary}>{suggestion.summary}</span>
      <span className="flex min-w-0 items-center gap-2">
        {identity ? (
          <>
            <span aria-hidden="true" className={`h-4 w-[2px] shrink-0 ${growthAgentAccentBg[identity.accentSlot] ?? growthAgentAccentBg[0]}`} />
            <span className={`min-w-0 truncate text-[13px] ${growthAgentAccent[identity.accentSlot] ?? growthAgentAccent[0]}`} title={identity.name}>{identity.name}</span>
            <span className="min-w-0 truncate text-[12px] text-fg-4" title={identity.roleLabel}>{identity.roleLabel}</span>
          </>
        ) : null}
      </span>
      <span className="truncate text-[12px] text-fg-4" title={target.description}>{target.label}</span>
      <span className="truncate font-mono text-[11px] text-fg-4" title={suggestion.operation}>{suggestion.operation}</span>
      <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-fg-4">
        <span className={counts.independentPassed === 0 ? "text-halt" : undefined}>독립 {counts.independent}</span>
        <span>·</span>
        <span>결정론 {counts.deterministic}</span>
        <span>·</span>
        <span>자기 {counts.self}</span>
      </span>
      <span className={`truncate text-[12px] ${glyph.className}`}>{suggestion.status === "awaiting-review" ? "승인 대기" : growthSuggestionStatus(suggestion.status)}</span>
      <time className="text-right font-mono text-[11px] text-fg-4">{growthClock(suggestion.createdAt)}</time>
    </button>
  );
}

function GrowthGateBand({ suggestion }: { suggestion: GrowthSuggestion }) {
  const evaluation = suggestion.evaluation;
  const counts = growthSignalCounts(evaluation?.signals);
  const gate = growthGateState(suggestion);
  const blockers = growthBlockers(suggestion);
  return (
    <div className="rounded-[4px] bg-surface-2 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`text-[20px] font-semibold leading-7 ${gate.className}`}>{gate.glyph} {gate.label}</span>
        {evaluation ? (
          <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-fg-4" title={evaluation.evaluationRunId}>
            평가 {evaluation.strategyVersionId} · {evaluation.evaluationRunId}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-1 text-[13px] text-fg-2">
        <span className="flex items-baseline gap-2"><span>독립 검증</span><span className={`font-mono ${counts.independentPassed === 0 ? "text-halt" : "text-fg-2"}`}>{counts.independentPassed} / 최소 1</span></span>
        <span className="flex items-baseline gap-2"><span>결정론</span><span className="font-mono">{counts.deterministic}</span></span>
        <span className="flex items-baseline gap-2 text-fg-4"><span>자기평가</span><span className="font-mono">{counts.self}</span><span>· 계산 제외</span></span>
      </div>
      {blockers.length ? (
        <div className="mt-3 grid gap-0.5">
          {blockers.map((blocker) => (
            <div className="flex h-[30px] min-w-0 items-center gap-2 text-[13px] text-halt" key={blocker}>
              <span aria-hidden="true">⊘</span><span className="truncate">{blocker}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GrowthSignalGroups({ evaluation }: { evaluation: GrowthSuggestion["evaluation"] }) {
  if (evaluation === undefined) return null;
  return (
    <div className="grid gap-3">
      {(["independent", "deterministic", "model-self"] as const).map((origin) => {
        const signals = evaluation.signals.filter((signal) => signal.origin === origin);
        if (!signals.length) return null;
        const independentPassed = signals.filter((signal) => signal.outcome === "passed").length;
        return (
          <div className={origin === "model-self" ? "opacity-60" : undefined} key={origin}>
            <div className="grid min-w-0 grid-cols-[128px_minmax(0,1fr)] gap-4">
              <div className="pt-1">
                <div className="text-[13px] text-fg-2">{growthSignalOriginLabel[origin]}</div>
                <div className="font-mono text-[11px] text-fg-4">{signals.length}</div>
                {origin === "independent" ? (
                  <div className={`text-[12px] ${independentPassed === 0 ? "text-halt" : "text-fg-4"}`}>최소 1 강제</div>
                ) : origin === "model-self" ? (
                  <div className="text-[12px] text-fg-4">계산 제외</div>
                ) : null}
              </div>
              <div className="grid gap-0.5">{signals.map((signal) => <GrowthSignalRow key={signal.signalId} signal={signal} />)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GrowthSection({ children, className = "", title }: { children: ReactNode; className?: string; title: string }) {
  return (
    <section aria-label={title} className={className} role="region">
      <h3 className="mb-2 text-[13px] font-medium text-fg-4">{title}</h3>
      {children}
    </section>
  );
}

function GrowthSignalRow({ signal }: { signal: GrowthSignalView }) {
  const glyph = growthSignalGlyph(signal);
  return (
    <div className="grid h-[30px] min-w-0 grid-cols-[16px_44px_minmax(0,1fr)_168px_56px] items-center gap-2 rounded-[4px] px-2 transition-colors duration-150 hover:bg-white/[0.027]">
      <span aria-hidden="true" className={`text-[16px] leading-none ${glyph.className}`}>{glyph.value}</span>
      <span className={`truncate text-[12px] ${signal.group === "conflict" ? "text-halt" : "text-fg-4"}`}>{growthSignalGroupLabel[signal.group]}</span>
      <span className="min-w-0 truncate text-[13px] text-fg-2" title={signal.note}>{signal.note}</span>
      <span className="max-w-[168px] truncate font-mono text-[11px] text-fg-4" title={`${signal.adapterId} ${signal.adapterVersion}`}>
        {signal.adapterId} {signal.adapterVersion}
      </span>
      <span className={`text-right font-mono text-[11px] tabular-nums ${signal.outcome === "failed" ? "text-halt" : signal.origin === "model-self" ? "text-fg-4" : "text-fg-2"}`}>
        {signal.score.toFixed(2)}
      </span>
    </div>
  );
}

function GrowthSourceRow({ onOpenWork, reference }: { onOpenWork?: (workId: string) => void; reference: string }) {
  const separator = reference.indexOf(":");
  const kind = separator < 0 ? "" : reference.slice(0, separator);
  const id = separator < 0 ? reference : reference.slice(separator + 1);
  const display = kind === "organization" ? agentIdentityToken(id).name : id;
  return (
    <div className="grid h-[30px] min-w-0 grid-cols-[56px_minmax(0,1fr)_20px] items-center gap-2">
      <span className="truncate text-[12px] text-fg-4">{kind === "reflection" ? "회고" : growthSourceLabel[kind] ?? (kind === "" ? "근거" : kind)}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-fg-2" title={reference}>{display}</span>
      {kind === "work" ? (
        <button
          aria-label={`업무 ${id} 열기`}
          className="h-[30px] w-[20px] rounded-[4px] text-[16px] text-fg-4 transition-colors duration-150 hover:text-fg"
          onClick={() => onOpenWork?.(id)}
          title={`업무 ${id} 열기`}
          type="button"
        >
          ›
        </button>
      ) : <span />}
    </div>
  );
}

function GrowthPatchRows({ line }: { line: NonNullable<GrowthSuggestion["patch"]>[number] }) {
  const identity = line.targetHandle === undefined ? undefined : agentIdentityToken(line.targetHandle);
  const accent = identity === undefined ? "" : growthAgentAccent[identity.accentSlot] ?? growthAgentAccent[0];
  const accentBg = identity === undefined ? "bg-line-strong" : growthAgentAccentBg[identity.accentSlot] ?? growthAgentAccentBg[0];
  return (
    <div className="grid gap-0.5">
      <div className="grid h-[30px] min-w-0 grid-cols-[2px_minmax(0,auto)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2">
        <span className={`h-full w-[2px] ${accentBg}`} />
        {identity ? <span className={`truncate text-[13px] ${accent}`} title={identity.name}>{identity.name}</span> : null}
        {identity ? <span className="truncate text-[12px] text-fg-4" title={identity.roleLabel}>{identity.roleLabel}</span> : null}
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-4" title={line.path}>{line.path}</span>
      </div>
      <div className="grid h-[30px] min-w-0 grid-cols-[16px_minmax(0,1fr)] items-center gap-2">
        <span className="font-mono text-[11px] text-fg-4">−</span>
        <span className="min-w-0 truncate text-[13px] text-fg-4 line-through" title={line.before}>{line.before}</span>
      </div>
      <div className="grid h-[30px] min-w-0 grid-cols-[16px_minmax(0,1fr)] items-center gap-2">
        <span className="font-mono text-[11px] text-fg-2">+</span>
        <span className="min-w-0 truncate text-[13px] text-fg-2" title={line.after}>{line.after}</span>
      </div>
    </div>
  );
}

function GrowthEffectBlock({ effects, suggestions }: { effects: readonly GrowthEffect[]; suggestions: readonly GrowthSuggestion[] }) {
  return (
    <section aria-label="채택 뒤" className="mt-6" role="region">
      <h3 className="mb-2 text-[13px] font-medium text-fg-4">채택된 개선의 효과</h3>
      <div className="rounded-[4px] bg-surface-2 p-4">
        <div className="grid gap-4">
          {effects.map((effect) => {
            const glyph = growthEffectGlyph(effect.result);
            const measure = effect.measure;
            const maximum = measure === undefined ? 0 : Math.max(measure.baseline, measure.score, 0);
            const barWidth = (value: number) => (maximum > 0 ? Math.min(100, Math.max(0, (value / maximum) * 100)) : 0);
            const adoptedSuggestion = suggestions.find((suggestion) => suggestion.adoption?.adoptionId === effect.adoptionId);
            const beforeVersionId = adoptedSuggestion?.adoption?.beforeVersionId;
            const beforeChecksum = adoptedSuggestion?.adoption?.beforeChecksum;
            return (
              <div key={effect.effectEvaluationId}>
                <div className="flex h-[30px] min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={`shrink-0 text-[16px] leading-none ${glyph.className}`}>{glyph.value}</span>
                  <span className={`min-w-0 truncate text-[15px] font-semibold ${glyph.className}`}>{growthEffectStatus(effect.result)}</span>
                  {measure ? <span className="shrink-0 text-[13px] text-fg-3">{measure.unit}</span> : null}
                  {measure ? <span className="shrink-0 text-[12px] text-fg-4">{measure.direction === "lower" ? "낮을수록 좋음" : "높을수록 좋음"}</span> : null}
                  {measure ? <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-4">표본 {measure.observationCount} / 최소 {measure.minimumObservations}</span> : null}
                  <span className="min-w-0 max-w-[180px] shrink-0 truncate font-mono text-[11px] text-fg-4" title={effect.adoptionId}>{effect.adoptionId}</span>
                </div>
                <div className="grid grid-cols-4 text-[12px]">
                  {(["improved", "stable", "degraded", "inconclusive"] as const).map((result) => (
                    <span className={effect.result === result ? "text-fg-2" : "text-fg-4"} key={result}>{growthEffectScaleLabel(result)}</span>
                  ))}
                </div>
                {measure ? (
                  <div className="mt-2 grid gap-0.5">
                    <GrowthMeasureRow label="채택 전" value={measure.baseline} width={barWidth(measure.baseline)} tone="before" />
                    <GrowthMeasureRow label="채택 뒤" value={measure.score} width={barWidth(measure.score)} tone="after" />
                  </div>
                ) : null}
                {beforeVersionId && beforeChecksum ? (
                  <div className="grid h-[30px] min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
                    <span className="text-[12px] text-fg-4">되돌리면</span>
                    <span className="truncate font-mono text-[11px] text-fg-2" title={`${beforeVersionId} · ${beforeChecksum}`}>
                      {beforeVersionId} · {beforeChecksum}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GrowthMeasureRow({ label, tone, value, width }: { label: string; tone: "before" | "after"; value: number; width: number }) {
  return (
    <div className="grid h-[30px] grid-cols-[48px_minmax(0,1fr)_52px] items-center gap-2">
      <span className="text-[12px] text-fg-4">{label}</span>
      <span className="h-2 rounded-[4px] bg-white/[0.047]">
        <span className={`block h-2 rounded-[4px] transition-[width] duration-[250ms] ease-linear ${tone === "before" ? "bg-fg-4" : "bg-fg-2"}`} style={{ width: `${width}%` }} />
      </span>
      <span className="text-right font-mono text-[11px] text-fg-4">{value}</span>
    </div>
  );
}

type GrowthLedgerEvent = {
  key: string;
  label: string;
  meta: string | undefined;
  timestamp: number | undefined;
  minute: string | undefined;
  suggestionId: string | undefined;
  targetHandle: string | undefined;
};

function GrowthLedgerEvents({
  effects,
  onSelect,
  selectedId,
  suggestions,
}: {
  effects: readonly GrowthEffect[];
  onSelect: (suggestionId: string) => void;
  selectedId: string | undefined;
  suggestions: readonly GrowthSuggestion[];
}) {
  const events = growthLedgerEvents(suggestions, effects);
  if (events.length === 0) return null;
  let previousMinute: string | undefined;
  return (
    <section aria-label="이 표면의 사건">
      <h2 className="mb-2 text-[13px] font-medium text-fg-4">이 표면의 사건</h2>
      <div className="grid gap-0.5">
        {events.map((event) => {
          const time = event.minute !== undefined && event.minute !== previousMinute ? growthClockFromTimestamp(event.timestamp) : "";
          if (event.minute !== undefined) previousMinute = event.minute;
          const identity = event.targetHandle === undefined ? undefined : agentIdentityToken(event.targetHandle);
          const rail = identity === undefined ? "bg-line-strong" : growthAgentAccentBg[identity.accentSlot] ?? growthAgentAccentBg[0];
          const current = event.suggestionId !== undefined && event.suggestionId === selectedId;
          const content = (
            <>
              <span className="text-right font-mono text-[11px] tabular-nums text-fg-4">{time}</span>
              <span className={`h-full w-[2px] ${rail}`} />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] text-fg-2">{event.label}</span>
                {event.meta ? <span className="min-w-0 truncate font-mono text-[11px] text-fg-4" title={event.meta}>{event.meta}</span> : null}
              </span>
              {event.suggestionId !== undefined ? <span aria-hidden="true" className="text-[16px] text-fg-4">›</span> : <span />}
            </>
          );
          const className = `grid h-[30px] min-w-0 grid-cols-[40px_2px_minmax(0,1fr)_16px] items-center gap-2 rounded-[4px] px-1 transition-colors duration-150 hover:bg-white/[0.027] ${current ? "bg-white/[0.047]" : ""}`;
          return event.suggestionId !== undefined ? (
            <button
              aria-label={`${event.label} ${event.meta ?? ""}`.trim()}
              className={className}
              key={event.key}
              onClick={() => onSelect(event.suggestionId ?? "")}
              type="button"
            >
              {content}
            </button>
          ) : (
            <div className={className} key={event.key}>{content}</div>
          );
        })}
      </div>
    </section>
  );
}

function growthLedgerEvents(suggestions: readonly GrowthSuggestion[], effects: readonly GrowthEffect[]): GrowthLedgerEvent[] {
  const events: GrowthLedgerEvent[] = [];
  suggestions.forEach((suggestion) => {
    const targetHandle = growthSuggestionTargetHandle(suggestion);
    const proposalTime = growthTimestamp(suggestion.createdAt);
    events.push({
      key: `${suggestion.suggestionId}-proposal`,
      label: "제안 올라옴",
      meta: suggestion.reflectionRunId,
      minute: growthMinute(proposalTime),
      suggestionId: suggestion.suggestionId,
      targetHandle,
      timestamp: proposalTime,
    });
    if (suggestion.evaluation) {
      events.push({
        key: `${suggestion.suggestionId}-evaluation`,
        label: "평가 실행",
        meta: suggestion.evaluation.evaluationRunId,
        minute: undefined,
        suggestionId: suggestion.suggestionId,
        targetHandle,
        timestamp: undefined,
      });
    }
    if (suggestion.adoption) {
      events.push({
        key: `${suggestion.suggestionId}-adoption`,
        label: "채택 실행",
        meta: suggestion.adoption.commandId,
        minute: undefined,
        suggestionId: suggestion.suggestionId,
        targetHandle,
        timestamp: undefined,
      });
    }
  });
  effects.forEach((effect, effectIndex) => {
    const suggestion = effect.suggestionId ? suggestions.find((item) => item.suggestionId === effect.suggestionId) : suggestions.find((item) => item.adoption?.adoptionId === effect.adoptionId);
    events.push({
      key: `${effect.effectEvaluationId}-effect`,
      label: "효과 측정",
      meta: effect.effectEvaluationId,
      minute: undefined,
      suggestionId: suggestion?.suggestionId,
      targetHandle: suggestion === undefined ? undefined : growthSuggestionTargetHandle(suggestion),
      timestamp: -effects.length + effectIndex,
    });
  });
  return events.sort((left, right) => (right.timestamp ?? Number.NEGATIVE_INFINITY) - (left.timestamp ?? Number.NEGATIVE_INFINITY));
}

function growthSuggestionTargetHandle(suggestion: GrowthSuggestion): string | undefined {
  const handles = suggestion.patch?.map((line) => line.targetHandle).filter((handle): handle is string => handle !== undefined) ?? [];
  return new Set(handles).size === 1 ? handles[0] : undefined;
}

function growthSuggestionTargetIdentity(suggestion: GrowthSuggestion) {
  const handle = growthSuggestionTargetHandle(suggestion);
  return handle === undefined ? undefined : agentIdentityToken(handle);
}

function growthSignalCounts(signals: readonly GrowthSignalView[] | undefined) {
  return {
    independent: signals?.filter((signal) => signal.origin === "independent").length ?? 0,
    independentPassed: signals?.filter((signal) => signal.origin === "independent" && signal.outcome === "passed").length ?? 0,
    deterministic: signals?.filter((signal) => signal.origin === "deterministic").length ?? 0,
    self: signals?.filter((signal) => signal.origin === "model-self").length ?? 0,
  };
}

function growthSuggestionGlyph(suggestion: GrowthSuggestion): { className: string; value: string } {
  if (suggestion.targetDrifted === true) return { className: "text-halt", value: "⊘" };
  if (suggestion.status === "awaiting-review") return { className: "text-gate", value: "◇" };
  if (suggestion.status === "adopted") return { className: "text-fg-2", value: "●" };
  return { className: "text-halt", value: "⊘" };
}

function growthGateState(suggestion: GrowthSuggestion): { className: string; glyph: string; label: string } {
  if (suggestion.targetDrifted === true || suggestion.evaluation?.outcome === "blocked") return { className: "text-halt", glyph: "⊘", label: "차단됨" };
  if (suggestion.evaluation?.outcome === "eligible") return { className: "text-fg-2", glyph: "◉", label: "승인 가능" };
  return { className: "text-halt", glyph: "⊘", label: "요건 미달" };
}

function growthEffectGlyph(result: GrowthEffect["result"]): { className: string; value: string } {
  if (result === "improved") return { className: "text-fg", value: "◉" };
  if (result === "stable") return { className: "text-fg-2", value: "●" };
  if (result === "degraded") return { className: "text-halt", value: "⊘" };
  return { className: "text-fg-4", value: "○" };
}

function growthSignalGlyph(signal: GrowthSignalView): { className: string; value: string } {
  if (signal.outcome === "failed") return { className: "text-halt", value: "⊘" };
  if (signal.outcome === "unavailable" || signal.origin === "model-self") return { className: "text-fg-4", value: "○" };
  if (signal.origin === "independent" && signal.outcome === "passed") return { className: "text-fg", value: "◉" };
  return { className: "text-fg-2", value: "●" };
}

const growthSourceLabel: Record<string, string> = {
  work: "업무",
  message: "협업방 발언",
  verification: "검증",
  organization: "조직 변경",
  execution: "실행",
  artifact: "산출물",
};
const growthSignalGroupLabel = { required: "필수", supporting: "보강", conflict: "반대" } as const;
const growthSignalOriginLabel: Record<GrowthOrigin, string> = {
  deterministic: "결정론",
  independent: "독립 검증",
  "model-self": "자기평가",
};

function growthBlockers(suggestion: GrowthSuggestion): string[] {
  const blockers: string[] = [];
  if (suggestion.evaluation === undefined) {
    blockers.push("평가가 아직 실행되지 않았습니다. 평가 없이는 승인할 수 없습니다.");
  } else if (suggestion.evaluation.outcome !== "eligible") {
    const failed = suggestion.evaluation.signals.filter((signal) => signal.group === "required" && signal.outcome === "failed");
    blockers.push(failed.length ? `필수 신호가 통과하지 못했습니다 · ${failed.map((signal) => signal.adapterId).join(" · ")}` : "평가 결과가 승인 요건을 만족하지 않습니다.");
  }
  if (suggestion.targetDrifted === true) blockers.push("제안 이후 대상이 바뀌었습니다. 다시 평가해야 승인할 수 있습니다.");
  return blockers;
}

function growthSuggestionStatus(status: string): string {
  return status === "awaiting-review" ? "검토 대기" : status === "adopted" ? "반영됨" : status;
}

function growthEffectStatus(result: GrowthEffect["result"]): string {
  return result === "improved" ? "개선 확인" : result === "stable" ? "변화 없음" : result === "degraded" ? "저하 관찰" : "판단 보류";
}

function growthEffectScaleLabel(result: GrowthEffect["result"]): string {
  return growthEffectStatus(result).replace(" ", "\u200b ");
}

function growthTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function growthMinute(timestamp: number | undefined): string | undefined {
  return timestamp === undefined ? undefined : growthClockFromTimestamp(timestamp);
}

function growthClockFromTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "" : new Date(timestamp).toTimeString().slice(0, 5);
}

function growthClock(createdAt: string | undefined): string {
  return growthClockFromTimestamp(growthTimestamp(createdAt));
}
