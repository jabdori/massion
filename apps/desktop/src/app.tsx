import {
  BellIcon as Bell,
  BookOpenTextIcon as BookOpenText,
  BriefcaseIcon as Briefcase,
  CaretDownIcon as CaretDown,
  CaretRightIcon as CaretRight,
  GearIcon as Gear,
  HouseIcon as House,
  PuzzlePieceIcon as PuzzlePiece,
  StarIcon as Star,
  TreeStructureIcon as TreeStructure,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DesktopService, GrowthView } from "@/desktop-service";
import type { ApprovalView, InboxItem, RoomView, WorkView } from "@/model";

import { nativeContextPicker, type NativeContextPicker } from "@/native-context-picker";
import { DecisionActions } from "@/room";
import { ExtensionSurface, type AwaitingRegistryInstall } from "@/surfaces/capabilities";
import { GrowthSurface } from "@/surfaces/growth";
import { HomeSurface } from "@/surfaces/home";
import { KnowledgeSurface } from "@/surfaces/knowledge";
import { OrganizationSurface } from "@/surfaces/organization";
import { SettingsSurface } from "@/surfaces/settings";
import { NewWorkDialog, WorkActivity, WorkEmptySurface, WorkInspector, WorkList } from "@/surfaces/work";
import { SurfaceError, SurfaceLoading, surfaceErrorMessage } from "@/ui/surface";
import { useDesktopController } from "@/use-desktop-controller";

const navItems = [
  { label: "홈", icon: House, surface: "home" },
  { label: "업무", icon: Briefcase, surface: "work" },
  { label: "조직", icon: TreeStructure, surface: "organization" },
  { label: "지식", icon: BookOpenText, surface: "knowledge" },
  { label: "개선", icon: Star, surface: "growth" },
  { label: "확장", icon: PuzzlePiece, surface: "capabilities" },
  { label: "설정", icon: Gear, surface: "settings" },
] as const;

type DesktopSurface = (typeof navItems)[number]["surface"];

type ApprovalDestination = { readonly surface: "work"; readonly workId: string } | { readonly surface: "capabilities" };

function approvalDestination(
  approval: ApprovalView,
  registryApprovalId: string | undefined,
): ApprovalDestination | undefined {
  if (approval.workId !== undefined) return { surface: "work", workId: approval.workId };
  if (approval.id === registryApprovalId || approval.action?.startsWith("extension."))
    return { surface: "capabilities" };
  return undefined;
}

interface AppProps {
  contextPicker?: NativeContextPicker;
  service: DesktopService;
}

export function App({ contextPicker = nativeContextPicker, service }: AppProps) {
  const controller = useDesktopController(service);
  const [surface, setSurface] = useState<DesktopSurface>("work");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<ApprovalView[]>();
  const [notificationError, setNotificationError] = useState("");
  const [growth, setGrowth] = useState<GrowthView>();
  const [growthError, setGrowthError] = useState("");
  const [requestedGrowthSuggestionId, setRequestedGrowthSuggestionId] = useState<string>();
  const [pendingNotificationIds, setPendingNotificationIds] = useState<ReadonlySet<string>>(new Set());
  const [awaitingRegistryInstall, setAwaitingRegistryInstall] = useState<AwaitingRegistryInstall>();
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  // 방이 늘어나도 탭 바가 감당해야 할 개수는 사용자가 연 것뿐입니다. 대표 방은 항상 열려 있습니다.
  const [openRoomIds, setOpenRoomIds] = useState<readonly string[]>([]);
  const selectedWorkId = controller.work?.id;
  const refreshNotifications = useCallback(async () => {
    try {
      const pending = await service.loadPendingApprovals();
      setNotifications(pending.filter((approval) => approval.status === "pending"));
      setNotificationError("");
    } catch (cause) {
      setNotificationError(surfaceErrorMessage(cause, "수신함을 불러오지 못했습니다."));
    }
  }, [service]);
  const refreshGrowth = useCallback(async () => {
    try {
      setGrowth(await service.loadGrowth());
      setGrowthError("");
    } catch (cause) {
      setGrowthError(surfaceErrorMessage(cause, "개선 검토를 불러오지 못했습니다."));
    }
  }, [service]);
  useEffect(() => {
    if (controller.phase !== "ready") return;
    void refreshNotifications();
    void refreshGrowth();
  }, [controller.eventRevision, controller.phase, refreshGrowth, refreshNotifications]);
  useEffect(() => {
    if (selectedWorkId === undefined) {
      setRooms([]);
      setSelectedRoomId(undefined);
      setOpenRoomIds([]);
      return;
    }
    let disposed = false;
    // 방을 못 읽어도 화면은 살아 있어야 합니다. 활동 타임라인은 Work 자체에서 계속 나옵니다.
    void service
      .loadRooms(selectedWorkId)
      .then((value) => {
        if (disposed) return;
        setRooms(value);
        setSelectedRoomId(value[0]?.roomId);
        setOpenRoomIds(value[0] ? [value[0].roomId] : []);
      })
      .catch(() => {
        if (!disposed) {
          setRooms([]);
          setSelectedRoomId(undefined);
          setOpenRoomIds([]);
        }
      });
    return () => {
      disposed = true;
    };
  }, [selectedWorkId, service]);
  const room = rooms.find((candidate) => candidate.roomId === selectedRoomId) ?? rooms[0];
  const openRoom = (roomId: string) => {
    setOpenRoomIds((current) => (current.includes(roomId) ? current : [...current, roomId]));
    setSelectedRoomId(roomId);
  };
  const closeRoom = (roomId: string) => {
    setOpenRoomIds((current) => {
      const next = current.filter((id) => id !== roomId);
      if (selectedRoomId === roomId) setSelectedRoomId(next[0]);
      return next;
    });
  };
  useEffect(() => {
    const toggleSidebar = (event: KeyboardEvent) => {
      if (
        event.key === "[" &&
        !(
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
      )
        setSidebarCollapsed((current) => !current);
    };
    window.addEventListener("keydown", toggleSidebar);
    return () => {
      window.removeEventListener("keydown", toggleSidebar);
    };
  }, []);
  const handleApprovalDecision = async (approvalId: string, vote: "approve" | "reject") => {
    const pending = awaitingRegistryInstall;
    if (!pending || pending.approvalId !== approvalId) return;
    if (vote === "reject") {
      setAwaitingRegistryInstall(undefined);
      return;
    }
    setAwaitingRegistryInstall(undefined);
    await service.installRegistry({ ...pending.request, installApprovalId: pending.approvalId }, pending.identity);
  };
  const decideNotification = async (
    approval: ApprovalView,
    vote: "approve" | "reject",
    source: "수신함" | "확장" = "수신함",
  ) => {
    if (pendingNotificationIds.has(approval.id)) return;
    setPendingNotificationIds((current) => new Set(current).add(approval.id));
    setNotificationError("");
    try {
      await service.decideApproval(approval, vote, `데스크톱 ${source}에서 ${vote === "approve" ? "승인" : "거절"}`);
      setNotifications((current) => current?.filter((item) => item.id !== approval.id));
      await handleApprovalDecision(approval.id, vote);
      if (approval.workId !== undefined && approval.workId === selectedWorkId) {
        controller.setSelectedId(approval.workId);
      }
    } catch (cause) {
      setNotificationError(surfaceErrorMessage(cause, "승인 결정을 저장하지 못했습니다."));
      await refreshNotifications();
    } finally {
      setPendingNotificationIds((current) => {
        const next = new Set(current);
        next.delete(approval.id);
        return next;
      });
    }
  };
  const decideWorkApproval = async (approval: ApprovalView, decision: "approved" | "rejected") => {
    await controller.decideApproval(approval, decision);
    await refreshNotifications();
  };
  // 수신함 한 원천. 배지·수신함·홈이 모두 이 배열을 봅니다. 각 표면이 따로 세지 않습니다.
  const inboxItems = useMemo(
    () => buildInboxItems(notifications, controller.works, growth?.suggestions ?? []),
    [growth?.suggestions, notifications, controller.works],
  );
  const inboxError = [notificationError, growthError].filter(Boolean).join(" ");
  const registryApproval =
    awaitingRegistryInstall === undefined
      ? undefined
      : notifications?.find((approval) => approval.id === awaitingRegistryInstall.approvalId);
  const openInbox = () => {
    setNotificationsOpen(true);
    void refreshNotifications();
    void refreshGrowth();
  };
  const openApproval = (approval: ApprovalView) => {
    const destination = approvalDestination(approval, awaitingRegistryInstall?.approvalId);
    if (destination === undefined) return;
    setNotificationsOpen(false);
    if (destination.surface === "work") {
      controller.setSelectedId(destination.workId);
      setSurface("work");
      return;
    }
    setSurface(destination.surface);
  };

  if (controller.phase === "loading") return <DesktopLoading />;
  if (controller.phase === "error") return <DesktopError error={controller.rootError} onRetry={controller.retry} />;
  return (
    <TooltipProvider delay={350}>
      <div
        className="app-shell grid min-h-[720px] min-w-[1180px] grid-cols-[var(--sidebar-width)_242px_minmax(420px,1fr)_300px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas text-primary min-[1440px]:grid-cols-[var(--sidebar-width)_264px_minmax(0,1fr)_332px]"
        data-sidebar-collapsed={sidebarCollapsed}
        data-testid="desktop-shell"
        style={{ "--sidebar-width": sidebarCollapsed ? "4.25rem" : "150px" } as CSSProperties}
      >
        <GlobalRail
          activeSurface={surface}
          collapsed={sidebarCollapsed}
          notificationCount={inboxItems === undefined ? 0 : inboxItems.length}
          onOpenNotifications={openInbox}
          onSelect={setSurface}
          onToggle={() => {
            setSidebarCollapsed((current) => !current);
          }}
        />
        {surface === "work" ? (
          <>
            <WorkList
              filter={controller.filter}
              onCreate={() => {
                controller.newWork.setOpen(true);
              }}
              onFilterChange={controller.setFilter}
              onQueryChange={controller.setQuery}
              onSelect={controller.setSelectedId}
              pendingRunId={controller.pendingCreation?.runId}
              query={controller.query}
              selectedId={controller.selectedId}
              works={controller.visibleWorks}
            />
            {controller.work ? (
              <>
                <WorkActivity
                  announcement={controller.announcement}
                  approvalDecisions={controller.approvalDecisions}
                  detailLoading={controller.detailLoading}
                  executionNotice={controller.executionNotice?.message}
                  composer={controller.composer}
                  onAnnouncement={controller.setAnnouncement}
                  onComposerChange={controller.setComposer}
                  onControlRun={(action) => {
                    void controller.controlRun(action);
                  }}
                  onDecideApproval={(approval, decision) => {
                    void decideWorkApproval(approval, decision);
                  }}
                  onSubmitDirective={(mode) => {
                    void controller.submitDirective(mode);
                  }}
                  pendingApprovals={controller.pendingApprovals}
                  pendingDirective={controller.pendingDirective}
                  pendingRunAction={controller.pendingRunAction}
                  onCloseRoom={closeRoom}
                  onSelectRoom={openRoom}
                  room={room}
                  rooms={rooms.filter((candidate) => openRoomIds.includes(candidate.roomId))}
                  work={controller.work}
                />
                <WorkInspector key={controller.work.id} room={room} service={service} work={controller.work} />
              </>
            ) : (
              <WorkEmptySurface
                onCreate={() => {
                  controller.newWork.setOpen(true);
                }}
              />
            )}
          </>
        ) : (
          <ProductSurface
            approvalBusy={registryApproval === undefined ? false : pendingNotificationIds.has(registryApproval.id)}
            awaitingRegistryInstall={awaitingRegistryInstall}
            growth={growth}
            growthError={growthError}
            inboxItems={inboxItems}
            onAwaitingRegistryInstallChange={(value) => {
              setAwaitingRegistryInstall(value);
              if (value !== undefined) void refreshNotifications();
            }}
            onCreate={() => {
              controller.newWork.setOpen(true);
            }}
            onOpenNotifications={openInbox}
            onEmergencyChanged={() => {
              void refreshNotifications();
            }}
            onRetryGrowth={() => {
              void refreshGrowth();
            }}
            onOpenWork={(workId) => {
              controller.setSelectedId(workId);
              setSurface("work");
            }}
            onDecideApproval={(approval, vote) => decideNotification(approval, vote, "확장")}
            registryApproval={registryApproval}
            service={service}
            surface={surface}
            requestedGrowthSuggestionId={requestedGrowthSuggestionId}
          />
        )}
      </div>
      <InboxPanel
        canOpenApproval={(approval) => approvalDestination(approval, awaitingRegistryInstall?.approvalId) !== undefined}
        error={inboxError}
        items={inboxItems}
        onDecide={decideNotification}
        onOpenChange={setNotificationsOpen}
        onOpenApproval={openApproval}
        onOpenGrowth={(suggestionId) => {
          setNotificationsOpen(false);
          setRequestedGrowthSuggestionId(suggestionId);
          setSurface("growth");
        }}
        onOpenWork={(workId) => {
          setNotificationsOpen(false);
          controller.setSelectedId(workId);
          setSurface("work");
        }}
        onRetry={() => {
          void refreshNotifications();
          void refreshGrowth();
        }}
        open={notificationsOpen}
        pending={pendingNotificationIds}
        works={controller.works}
      />
      <NewWorkDialog
        {...controller.newWork}
        contextPicker={contextPicker}
        onOpenSettings={() => {
          controller.newWork.setOpen(false);
          setSurface("settings");
        }}
      />
    </TooltipProvider>
  );
}

function GlobalRail({
  activeSurface,
  collapsed,
  notificationCount,
  onOpenNotifications,
  onSelect,
  onToggle,
}: {
  activeSurface: DesktopSurface;
  collapsed: boolean;
  notificationCount: number;
  onOpenNotifications: () => void;
  onSelect: (surface: DesktopSurface) => void;
  onToggle: () => void;
}) {
  return (
    <Sidebar aria-label="전역 탐색" collapsed={collapsed} className="min-w-0 bg-chrome">
      <SidebarHeader className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 items-center justify-center text-accent">
          <MassionMark />
        </span>
        <span className="text-[15px] font-semibold tracking-[-0.02em] group-data-[collapsed=true]/sidebar:hidden">
          Massion
        </span>
        <button
          aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
          className="ml-auto rounded p-1 text-muted hover:text-primary group-data-[collapsed=true]/sidebar:ml-0"
          onClick={onToggle}
          type="button"
        >
          {collapsed ? <CaretRight size={16} /> : <CaretDown className="-rotate-90" size={16} />}
        </button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>받은 항목</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label={notificationCount === 0 ? "수신함" : `수신함, 미해결 ${String(notificationCount)}개`}
                onClick={onOpenNotifications}
              >
                <Bell aria-hidden="true" size={21} weight="regular" />
                <span className="flex-1 text-left">수신함</span>
                {notificationCount ? (
                  <span className="rail-label flex min-w-5 items-center justify-center rounded-full bg-gate px-1.5 font-mono text-[11px] font-semibold text-gate-ink">
                    {notificationCount}
                  </span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>운영</SidebarGroupLabel>
          <SidebarMenu>
            {navItems
              .filter((item) => item.surface !== "settings")
              .map(({ icon: Icon, label, surface }) => {
                const current = activeSurface === surface;
                return (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      active={current}
                      aria-label={label}
                      onClick={() => {
                        onSelect(surface);
                      }}
                    >
                      <Icon aria-hidden="true" size={21} weight="regular" />
                      <span className="flex-1 text-left">{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              active={activeSurface === "settings"}
              aria-label="설정"
              onClick={() => {
                onSelect("settings");
              }}
            >
              <Gear aria-hidden="true" size={20} />
              <span>설정</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="mt-2 text-[11px] text-muted group-data-[collapsed=true]/sidebar:hidden">로컬 연결됨</p>
      </SidebarFooter>
    </Sidebar>
  );
}

function ProductSurface({
  approvalBusy,
  awaitingRegistryInstall,
  growth,
  growthError,
  inboxItems,
  onAwaitingRegistryInstallChange,
  onCreate,
  onDecideApproval,
  onEmergencyChanged,
  onOpenNotifications,
  onOpenWork,
  onRetryGrowth,
  requestedGrowthSuggestionId,
  registryApproval,
  service,
  surface,
}: {
  approvalBusy: boolean;
  awaitingRegistryInstall: AwaitingRegistryInstall | undefined;
  growth: GrowthView | undefined;
  growthError: string;
  inboxItems: InboxItem[] | undefined;
  onAwaitingRegistryInstallChange: (value: AwaitingRegistryInstall | undefined) => void;
  onCreate: () => void;
  onDecideApproval: (approval: ApprovalView, vote: "approve" | "reject") => Promise<void>;
  onEmergencyChanged: () => void;
  onOpenNotifications: () => void;
  onOpenWork: (workId: string) => void;
  onRetryGrowth: () => void;
  requestedGrowthSuggestionId: string | undefined;
  registryApproval: ApprovalView | undefined;
  service: DesktopService;
  surface: Exclude<DesktopSurface, "work">;
}) {
  if (surface === "home")
    return (
      <HomeSurface
        inboxItems={inboxItems}
        onCreate={onCreate}
        onOpenNotifications={onOpenNotifications}
        onOpenWork={onOpenWork}
        service={service}
      />
    );
  if (surface === "organization") return <OrganizationSurface service={service} />;
  if (surface === "knowledge") return <KnowledgeSurface onOpenWork={onOpenWork} service={service} />;
  if (surface === "growth")
    return (
      <GrowthSurface
        error={growthError}
        growth={growth}
        onOpenWork={onOpenWork}
        onRetry={onRetryGrowth}
        requestedSuggestionId={requestedGrowthSuggestionId}
        service={service}
      />
    );
  if (surface === "capabilities")
    return (
      <ExtensionSurface
        approval={registryApproval}
        approvalBusy={approvalBusy}
        awaitingInstall={awaitingRegistryInstall}
        onAwaitingInstallChange={onAwaitingRegistryInstallChange}
        onDecideApproval={onDecideApproval}
        service={service}
      />
    );
  return <SettingsSurface onEmergencyChanged={onEmergencyChanged} service={service} />;
}

/**
 * 수신함 한 원천. 승인 대기·차단·검토 대기 개선을 한 목록으로 투영합니다.
 * 막힘(halt)이 승인 대기보다 급하므로 먼저 둡니다. 배지·수신함·홈이 전부 이 결과를 봅니다.
 * approvals가 아직 undefined(로딩 중)면 목록도 undefined로 두어 로딩 상태를 구분합니다.
 */
function buildInboxItems(
  approvals: ApprovalView[] | undefined,
  works: readonly WorkView[],
  suggestions: GrowthView["suggestions"],
): InboxItem[] | undefined {
  if (approvals === undefined) return undefined;
  const blocked: InboxItem[] = works
    .filter((work) => work.run?.status === "blocked")
    .map((work) => ({
      kind: "blocked",
      id: `blocked:${work.id}`,
      workId: work.id,
      title: work.title,
      reason: work.run?.blockedReason ?? "차단됨",
    }));
  const approval: InboxItem[] = approvals.map((item) => ({ kind: "approval", id: item.id, approval: item }));
  const growth: InboxItem[] = suggestions
    .filter((suggestion) => suggestion.status === "awaiting-review")
    .map((suggestion) => ({
      kind: "growth",
      id: `growth:${suggestion.suggestionId}`,
      suggestionId: suggestion.suggestionId,
      workId: suggestion.workId,
      title: suggestion.summary,
      reason: suggestion.rationale,
    }));
  return [...blocked, ...approval, ...growth];
}
function InboxPanel({
  canOpenApproval,
  error,
  items,
  onDecide,
  onOpenChange,
  onOpenApproval,
  onOpenGrowth,
  onOpenWork,
  onRetry,
  open,
  pending,
  works,
}: {
  canOpenApproval: (approval: ApprovalView) => boolean;
  error: string;
  items: InboxItem[] | undefined;
  onDecide: (approval: ApprovalView, vote: "approve" | "reject") => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onOpenApproval: (approval: ApprovalView) => void;
  onOpenGrowth: (suggestionId: string) => void;
  onOpenWork: (workId: string) => void;
  onRetry: () => void;
  open: boolean;
  pending: ReadonlySet<string>;
  works: WorkView[];
}) {
  const workTitles = new Map(works.map((work) => [work.id, work.title]));
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/* 오른쪽에 딱 붙는 시트. 그림자 대신 왼쪽 1px 선으로 가릅니다(DESIGN.md: 그림자 없음). */}
      <DialogContent aria-label="수신함" className="w-[420px] border-l border-border" sheet>
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <DialogTitle className="text-[17px] font-semibold tracking-[-0.02em]">수신함</DialogTitle>
                {items?.length ? <span className="font-mono text-[11px] text-gate">{items.length}</span> : null}
              </div>
              <DialogDescription className="mt-1 text-[12px] leading-5 text-muted">
                사람이 결정하거나 풀어줄 때까지 여기에 남습니다.
              </DialogDescription>
            </div>
            <DialogClose
              aria-label="수신함 닫기"
              className="flex size-8 shrink-0 items-center justify-center rounded-[5px] text-muted outline-none hover:bg-surface-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <X aria-hidden="true" size={17} />
            </DialogClose>
          </header>
          <div className="min-h-0 space-y-2 overflow-y-auto px-4 py-4">
            {error ? (
              <div>
                <SurfaceError message={error} />
                <Button onClick={onRetry} size="sm" type="button" variant="outline">
                  다시 불러오기
                </Button>
              </div>
            ) : null}
            {items === undefined && !error ? <SurfaceLoading /> : null}
            {items?.length === 0 ? (
              <div className="py-12 text-center">
                <Bell aria-hidden="true" className="mx-auto text-muted" size={28} />
                <p className="mt-3 text-[13px] font-medium">수신함이 비어 있습니다.</p>
                <p className="mt-1 text-[12px] text-muted">지금 사람을 기다리거나 막힌 것이 없습니다.</p>
              </div>
            ) : null}
            {items?.map((item) =>
              item.kind === "approval" ? (
                <ApprovalInboxCard
                  key={item.id}
                  approval={item.approval}
                  busy={pending.has(item.id)}
                  onDecide={onDecide}
                  onOpen={() => {
                    onOpenApproval(item.approval);
                  }}
                  routable={canOpenApproval(item.approval)}
                  workTitle={item.approval.workId === undefined ? undefined : workTitles.get(item.approval.workId)}
                />
              ) : item.kind === "growth" ? (
                <GrowthInboxCard
                  key={item.id}
                  item={item}
                  onOpenGrowth={onOpenGrowth}
                  workTitle={workTitles.get(item.workId)}
                />
              ) : (
                <BlockedInboxCard key={item.id} item={item} onOpenWork={onOpenWork} />
              ),
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 승인 대기 카드. gate(노랑)는 "지금 사람 결정이 필요함" 예약색입니다. */
function ApprovalInboxCard({
  approval,
  busy,
  onDecide,
  onOpen,
  routable,
  workTitle,
}: {
  approval: ApprovalView;
  busy: boolean;
  onDecide: (approval: ApprovalView, vote: "approve" | "reject") => Promise<void>;
  onOpen: () => void;
  routable: boolean;
  workTitle: string | undefined;
}) {
  // 감사 식별자(업무·승인 요청 id)는 본문에 슬러그로 찍지 않고 title 툴팁으로 내립니다.
  // 수신함은 읽는 곳이 아니라 처리하는 곳이라 "무엇을·어디서"만 사람의 말로 보입니다.
  const auditTitle = `승인 요청 ${approval.id}${approval.workId === undefined ? "" : ` · 업무 ${approval.workId}`}`;
  const workId = approval.workId;
  return (
    <section className="rounded-[7px] border border-gate-border bg-gate-wash px-3.5 py-3" title={auditTitle}>
      <h3 className="text-[13px] font-medium">
        {!routable ? (
          <span className="flex min-h-6 items-center gap-2">
            <span aria-hidden="true" className="text-gate">
              ◇
            </span>
            <span className="min-w-0 flex-1 truncate">{approval.title}</span>
            <span className="shrink-0 text-[11px] font-normal text-gate">승인 필요</span>
          </span>
        ) : (
          <button
            aria-label={`승인 검토 열기: ${approval.title}`}
            className="flex min-h-6 w-full items-center gap-2 rounded-[3px] text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-gate/70"
            onClick={onOpen}
            type="button"
          >
            <span aria-hidden="true" className="text-gate">
              ◇
            </span>
            <span className="min-w-0 flex-1 truncate">{approval.title}</span>
            <span className="shrink-0 text-[11px] font-normal text-gate">승인 필요</span>
            <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={12} />
          </button>
        )}
      </h3>
      <p className="mt-1.5 text-[12px] leading-5 text-secondary">{approval.description}</p>
      <div className="mt-2 border-t border-gate-border pt-2 text-[11px] text-muted">
        <p>{workTitle ?? (workId === undefined ? "조직 전역" : "연결된 업무")}</p>
        <p className="mt-1">
          해결 전까지 관련 실행이 멈춥니다
          {approval.revision === undefined ? "" : ` · 개정 ${String(approval.revision)}`}
        </p>
      </div>
      {!routable ? (
        <div className="mt-3 flex justify-end">
          <DecisionActions
            approveName={approval.title}
            busy={busy}
            disabled={busy}
            onApprove={() => {
              void onDecide(approval, "approve");
            }}
            onReject={() => {
              void onDecide(approval, "reject");
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

/** 차단 카드. halt(빨강)는 "실행이 막힘" 예약색입니다. 승인·거절이 아니라 원인을 풀러 업무로 갑니다. */
function BlockedInboxCard({
  item,
  onOpenWork,
}: {
  item: Extract<InboxItem, { kind: "blocked" }>;
  onOpenWork: (workId: string) => void;
}) {
  return (
    <section
      className="rounded-[7px] border px-3.5 py-3"
      style={{ borderColor: "var(--halt)", background: "color-mix(in srgb, var(--halt) 8%, transparent)" }}
      title={`업무 ${item.workId}`}
    >
      {/* 제목·상태·꺾쇠를 한 줄에 두고, 꺾쇠는 두 카드 모두 맨 오른쪽에 맞춥니다. */}
      <h3 className="text-[13px] font-medium">
        <button
          aria-label={`업무로 이동: ${item.title}`}
          className="flex min-h-6 w-full items-center gap-2 rounded-[3px] text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-halt/70"
          onClick={() => {
            onOpenWork(item.workId);
          }}
          type="button"
        >
          <span aria-hidden="true" className="text-halt">
            ⊘
          </span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className="shrink-0 text-[11px] font-normal text-halt">막힘</span>
          <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={12} />
        </button>
      </h3>
      {/* 차단 원인을 구별해 보입니다. 모델 부재와 폴더 신뢰는 할 일이 완전히 다릅니다. */}
      <p className="mt-1.5 text-[12px] leading-5 text-halt">{item.reason}</p>
    </section>
  );
}

/** 개선 검토 카드. 수신함에서는 결론을 내리지 않고 근거가 있는 개선 상세로 이동합니다. */
function GrowthInboxCard({
  item,
  onOpenGrowth,
  workTitle,
}: {
  item: Extract<InboxItem, { kind: "growth" }>;
  onOpenGrowth: (suggestionId: string) => void;
  workTitle: string | undefined;
}) {
  return (
    <section
      className="rounded-[7px] border border-gate-border bg-gate-wash px-3.5 py-3"
      title={`개선 제안 ${item.suggestionId}`}
    >
      <h3 className="text-[13px] font-medium">
        <button
          aria-label={`개선 검토 열기: ${item.title}`}
          className="flex min-h-6 w-full items-center gap-2 rounded-[3px] text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-gate/70"
          onClick={() => {
            onOpenGrowth(item.suggestionId);
          }}
          type="button"
        >
          <Star aria-hidden="true" className="shrink-0 text-gate" size={14} />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className="shrink-0 text-[11px] font-normal text-gate">검토 대기</span>
          <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={12} />
        </button>
      </h3>
      <p className="mt-1.5 text-[12px] leading-5 text-secondary">{item.reason}</p>
      <p className="mt-2 border-t border-gate-border pt-2 text-[11px] text-muted">{workTitle ?? "연결된 업무"}</p>
    </section>
  );
}

function DesktopLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="데스크톱 데이터 불러오는 중"
      className="grid min-h-[720px] min-w-[1180px] grid-cols-[160px_272px_minmax(0,1fr)_372px] bg-canvas p-4"
    >
      <Skeleton className="m-2" />
      <Skeleton className="m-2" />
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-2/5" />
        <Skeleton className="h-20 w-4/5" />
        <Skeleton className="h-36 w-full" />
      </div>
      <Skeleton className="m-2" />
    </div>
  );
}

function DesktopError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-[100dvh] min-w-[1180px] items-center justify-center bg-canvas text-primary">
      <div className="max-w-sm text-center">
        <WarningCircle aria-hidden="true" className="mx-auto mb-4 text-danger" size={32} />
        <h1 className="text-lg font-semibold">로컬 AgentOS에 연결하지 못했습니다.</h1>
        <p className="mt-2 text-sm leading-6 text-muted">{error || "daemon 상태를 확인한 뒤 다시 연결해 주세요."}</p>
        <Button className="mt-5" onClick={onRetry}>
          다시 시도
        </Button>
      </div>
    </main>
  );
}

function MassionMark() {
  return (
    <svg aria-hidden="true" fill="none" height="26" viewBox="0 0 28 28" width="28">
      <path
        d="M5 22V7.5L10.5 12 17.5 6 23 9.5V22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4"
      />
    </svg>
  );
}
