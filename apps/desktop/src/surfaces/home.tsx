import { Plus, Star } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { DesktopService } from "@/desktop-service";
import type { InboxItem, WorkView } from "@/model";
import { agentIdentityToken } from "@massion/application/client";

import { OpenButton, SpeakerRow } from "@/room";
import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";

function SurfaceFrame({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <main aria-label={title} className="col-span-3 min-h-0 overflow-y-auto bg-canvas px-8 py-7">
      <header className="mb-7 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
      </header>
      {children}
    </main>
  );
}

export function HomeSurface({
  inboxItems,
  onCreate,
  onOpenNotifications,
  onOpenWork,
  service,
}: {
  inboxItems: InboxItem[] | undefined;
  onCreate: () => void;
  onOpenNotifications: () => void;
  onOpenWork: (workId: string) => void;
  service: DesktopService;
}) {
  const [works, setWorks] = useState<WorkView[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void service
      .loadIndex({ filter: "active", search: "" })
      .then((items) => {
        if (!disposed) setWorks(items);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "현황을 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  // 차단은 수신함과 같은 원천(inboxItems)에서 옵니다. 홈이 따로 세지 않아 숫자가 갈리지 않습니다.
  const running = (works ?? []).filter((work) => work.status === "active" && work.run?.status !== "blocked");
  const waiting = inboxItems ?? [];

  return (
    <SurfaceFrame title="홈">
      {error ? <SurfaceError message={error} /> : null}

      {/* 새 사명은 상시 진입점입니다. 현황이 주인공이고 입력은 항상 닿는 곳에 둡니다. */}
      <section aria-label="새 사명" className="mb-7 max-w-4xl">
        <button
          className="flex w-full items-center gap-3 rounded-[7px] border border-line-strong bg-surface-1 px-4 py-3 text-left outline-none hover:bg-surface-2"
          onClick={onCreate}
          type="button"
        >
          <Plus aria-hidden="true" className="text-muted" size={17} />
          <span className="flex-1 text-sm text-muted">맡길 일을 한 줄로 씁니다…</span>
          <span className="font-mono text-[11px] text-muted">⌘N</span>
        </button>
      </section>

      {works === undefined || inboxItems === undefined ? <SurfaceLoading /> : null}

      {works && inboxItems ? (
        <div className="grid max-w-4xl gap-7">
          <section aria-label="나를 기다리는 것">
            <h2 className="mb-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted">
              나를 기다리는 것 {waiting.length ? <span className="text-gate">{waiting.length}</span> : null}
            </h2>
            {waiting.length === 0 ? (
              <p className="text-sm text-muted">지금 사람을 기다리는 항목이 없습니다.</p>
            ) : (
              // 홈은 요약입니다. 승인 처리는 수신함에서, 차단 해결은 업무에서 — 같은 원천을 눌러서 엽니다.
              <ul className="grid gap-1.5">
                {waiting.map((item) =>
                  item.kind === "approval" ? (
                    <li
                      className="flex items-center gap-2.5 rounded-[7px] border border-gate-border bg-gate-wash px-3.5 py-2.5"
                      key={item.id}
                    >
                      <span aria-hidden="true" className="text-gate">
                        ◇
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{item.approval.title}</span>
                        <span className="block truncate text-xs text-secondary">{item.approval.description}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-gate">승인 필요</span>
                      <OpenButton label={`${item.approval.title} 수신함에서 보기`} onOpen={onOpenNotifications} />
                    </li>
                  ) : item.kind === "growth" ? (
                    <li
                      className="flex items-center gap-2.5 rounded-[7px] border border-gate-border bg-gate-wash px-3.5 py-2.5"
                      key={item.id}
                    >
                      <Star aria-hidden="true" className="shrink-0 text-gate" size={15} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{item.title}</span>
                        <span className="block truncate text-xs text-secondary">{item.reason}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-gate">개선 검토</span>
                      <OpenButton label={`${item.title} 수신함에서 보기`} onOpen={onOpenNotifications} />
                    </li>
                  ) : (
                    <li key={item.id}>
                      <button
                        className="flex w-full items-center gap-2.5 rounded-[7px] border border-halt/40 bg-surface-1 px-3.5 py-2.5 text-left outline-none hover:border-halt"
                        onClick={() => {
                          onOpenWork(item.workId);
                        }}
                        type="button"
                      >
                        <span aria-hidden="true" className="text-halt">
                          ⊘
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{item.title}</span>
                          {/* 차단 원인을 구별해 보입니다. 모델 부재와 폴더 신뢰는 할 일이 완전히 다릅니다. */}
                          <span className="block truncate font-mono text-[11px] text-halt">{item.reason}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-halt">막힘</span>
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>

          <section aria-label="지금 도는 것">
            <h2 className="mb-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted">
              지금 도는 것 {running.length}
            </h2>
            {running.length === 0 ? (
              <p className="text-sm text-muted">진행 중인 업무가 없습니다. 위에 한 줄을 쓰면 시작합니다.</p>
            ) : (
              <ul className="grid gap-1.5">
                {running.map((work) => (
                  <li key={work.id}>
                    <button
                      className="flex w-full items-center gap-2.5 rounded-[7px] border border-border bg-surface-1 px-3.5 py-2.5 text-left outline-none hover:border-control"
                      onClick={() => {
                        onOpenWork(work.id);
                      }}
                      type="button"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{work.title}</span>
                        <span className="mt-1 flex items-center gap-2">
                          {/* 색 점만 봐도 어느 업무에 누가 붙어 있는지 읽힙니다. */}
                          <SpeakerRow
                            limit={4}
                            speakers={work.agents.map((agent) => ({
                              handle: agent.id,
                              name: agent.name,
                              initial: agent.initials,
                              accentSlot: agentIdentityToken(agent.id, agent.role).accentSlot,
                              role: agent.role,
                            }))}
                          />
                          <span className="font-mono text-[11px] text-muted">
                            {work.run?.stage ?? work.sourceStatus}
                          </span>
                        </span>
                      </span>
                      <time className="shrink-0 font-mono text-[11px] text-muted">{work.updatedAt}</time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </SurfaceFrame>
  );
}
