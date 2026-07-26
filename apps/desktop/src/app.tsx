import {
  ArrowRightIcon as ArrowRight,
  AtIcon as At,
  BellIcon as Bell,
  BriefcaseIcon as Briefcase,
  CaretDownIcon as CaretDown,
  CaretRightIcon as CaretRight,
  CheckCircleIcon as CheckCircle,
  ClockIcon as Clock,
  DatabaseIcon as Database,
  FileCsvIcon as FileCsv,
  FilePdfIcon as FilePdf,
  GearIcon as Gear,
  HouseIcon as House,
  LightningIcon as Lightning,
  ListChecksIcon as ListChecks,
  MagnifyingGlassIcon as MagnifyingGlass,
  PaperclipIcon as Paperclip,
  PlusIcon as Plus,
  PuzzlePieceIcon as PuzzlePiece,
  ShieldCheckIcon as ShieldCheck,
  StarIcon as Star,
  TreeStructureIcon as TreeStructure,
  UsersThreeIcon as UsersThree,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from "@phosphor-icons/react";
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  AutonomyView,
  CommandIdentity,
  ContributionKind,
  DesktopFilter,
  DesktopService,
  ExtensionEntryView,
  GrowthSignalView,
  GrowthView,
  OrganizationNodeView,
  OrganizationView,
  PermissionKind,
  SettingsView,
  SubscriptionAccountView,
} from "@/desktop-service";
import {
  projectManifestDeclarations,
  projectModelRoutes,
  projectProviderConnections,
  projectSubscriptionAccounts,
} from "@/desktop-service";
import {
  type ActivityView,
  type AgentView,
  type ApprovalView,
  type InboxItem,
  type ArtifactView,
  type StepState,
  type TaskView,
  type RoomView,
  type SpeakerView,
  type WorkStatus,
  type WorkView,
} from "@/model";
import { agentIdentityToken, growthTargetToken } from "@massion/application/client";

import { nativeContextPicker, type NativeContextPicker } from "@/native-context-picker";
import {
  AgentAvatar,
  DecisionActions,
  OpenButton,
  ProposalActivity,
  RoomChapter,
  RoomHandoff,
  RoomMessage,
  RoomReference,
  RoomStatus,
  SpeakerRow,
} from "@/room";
import { useDesktopController } from "@/use-desktop-controller";

const navItems = [
  { label: "홈", icon: House, surface: "home" },
  { label: "업무", icon: Briefcase, surface: "work" },
  { label: "조직", icon: TreeStructure, surface: "organization" },
  { label: "개선", icon: Star, surface: "growth" },
  { label: "확장", icon: PuzzlePiece, surface: "capabilities" },
  { label: "설정", icon: Gear, surface: "settings" },
] as const;

type DesktopSurface = (typeof navItems)[number]["surface"];

type AwaitingRegistryInstall = {
  identity: CommandIdentity;
  request: Record<string, unknown>;
  approvalId: string;
};

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

const stateLabel: Record<StepState, string> = {
  done: "완료",
  active: "진행 중",
  pending: "대기",
  failed: "실패",
};

// 초록은 쓰지 않고 amber는 "사람이 필요함" 전용어입니다. 진행 중만 밝게 두고 나머지는 가라앉힙니다.
const stateClass: Record<StepState, string> = {
  done: "text-muted",
  active: "text-primary",
  pending: "text-muted",
  failed: "text-danger",
};

const workStatusLabel: Record<WorkStatus, string> = {
  active: "진행 중",
  complete: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

const workStatusClass: Record<WorkStatus, string> = {
  active: "text-primary",
  complete: "text-muted",
  failed: "text-danger",
  cancelled: "text-muted",
};

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
                <WorkInspector room={room} work={controller.work} />
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
  return <SettingsSurface service={service} />;
}

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

function WorkEmptySurface({ onCreate }: { onCreate: () => void }) {
  return (
    <main aria-label="업무" className="col-span-2 flex min-h-0 items-center justify-center bg-canvas text-primary">
      <div className="text-center">
        <Briefcase aria-hidden="true" className="mx-auto mb-4 text-muted" size={32} />
        <h1 className="text-lg font-semibold">선택한 상태에 Work가 없습니다.</h1>
        <p className="mt-2 text-sm text-muted">왼쪽에서 상태를 바꾸거나 첫 Work를 만들어주세요.</p>
        <Button className="mt-5" onClick={onCreate} variant="primary">
          <Plus aria-hidden="true" size={16} />첫 Work 만들기
        </Button>
      </div>
    </main>
  );
}

function HomeSurface({
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

function OrganizationSurface({ service }: { service: DesktopService }) {
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
/**
 * 지도가 죽어도 조직 화면 전체가 무너지면 안 됩니다. ReactFlow는 크기 측정이 안 되는 환경
 * (jsdom 등)에서 렌더 중 예외를 던지므로, 지도만 조용히 접고 구조(A)는 계속 보이게 합니다.
 */
class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  public override state = { failed: false };
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  public override render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-muted">
          지도를 그릴 수 없습니다
        </div>
      );
    }
    return this.props.children;
  }
}

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

function ExtensionSurface({
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

/**
 * 3열을 쓰는 이유를 각각 댑니다.
 *  - 목록: 제안이 여러 개일 때 스캔이 필요합니다. 상단 탭으로는 개수가 늘면 못 봅니다.
 *  - 판단: 증거를 위에서 아래로 끝까지 읽는 영역입니다. Work의 실시간 스트림과 달리 흐르지 않습니다.
 *  - 컨텍스트: 기억·효과·정책은 지금 판단할 대상이 아니라 배경입니다.
 */
function GrowthSurface({
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
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                   * 승인·거부 명령이 Application API에 아직 없습니다. 동작하지 않는 버튼을
                   * 동작하는 것처럼 두지 않고, 무엇이 막혀 있는지 화면이 말합니다.
                   */}
                  <span className="flex-1 text-[11px] text-muted">승인·거절 명령이 아직 연결되지 않았습니다</span>
                  <DecisionActions approveName={selected.summary} disabled />
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
                  <li
                    className="rounded-[7px] border border-border bg-surface-1 px-3 py-2.5"
                    key={memory.key}
                  >
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
              <Button disabled={memorySaving || !memoryKey.trim() || !memoryValue.trim()} size="sm" type="submit" variant="outline">
                {memorySaving ? "저장 중…" : "기억 저장"}
              </Button>
            </form>
            {memoryError ? <p role="alert" className="mt-2 text-[11px] leading-5 text-danger">{memoryError}</p> : null}
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

function GrowthSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section aria-label={title} className="mt-7">
      <h3 className="mb-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted">{title}</h3>
      {children}
    </section>
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

function SettingsSurface({ service }: { service: DesktopService }) {
  const [settings, setSettings] = useState<SettingsView>();
  const [autonomy, setAutonomy] = useState<AutonomyView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [autonomySaving, setAutonomySaving] = useState(false);
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
    void Promise.all([service.loadSettings(), service.loadAutonomy()])
      .then(([value, mode]) => {
        if (!disposed) {
          setSettings(value);
          setAutonomy(mode);
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
                          autonomy.mode === "full"
                            ? "border-control bg-surface-2 text-primary"
                            : "border-border text-secondary"
                        }`}
                        disabled={autonomySaving || autonomy.mode === "full"}
                        onClick={() => {
                          void setAutonomyMode("full");
                        }}
                        type="button"
                      >
                        전체 권한
                      </button>
                      <span className="font-mono text-[11px] text-muted">개정 {autonomy.revision}</span>
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
          supportsStructuredOutput: true,
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

function SurfaceLoading() {
  return (
    <div role="status" className="text-sm text-secondary">
      불러오는 중…
    </div>
  );
}
function SurfaceError({ message }: { message: string }) {
  return (
    <p role="alert" className="mb-4 text-sm text-danger">
      {message}
    </p>
  );
}
function surfaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface WorkListProps {
  works: WorkView[];
  selectedId: string;
  filter: DesktopFilter;
  query: string;
  pendingRunId: string | undefined;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onFilterChange: (filter: DesktopFilter) => void;
  onQueryChange: (query: string) => void;
}

function WorkList({
  filter,
  onCreate,
  onFilterChange,
  onQueryChange,
  onSelect,
  pendingRunId,
  query,
  selectedId,
  works,
}: WorkListProps) {
  return (
    <section
      aria-label="Work 목록"
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_auto_minmax(0,1fr)] border-r border-border bg-chrome"
    >
      <header className="flex items-center justify-between border-b border-border px-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.015em]">업무</h2>
        <Button aria-label="새 Work 만들기" onClick={onCreate} size="icon" variant="ghost">
          <Plus aria-hidden="true" size={17} />
        </Button>
      </header>
      <div className="space-y-2 border-b border-border px-2.5 py-2.5">
        <label className="relative block">
          <span className="sr-only">Work 검색</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            size={16}
          />
          <input
            className="h-8 w-full rounded-[5px] border border-border bg-surface-1 pl-8 pr-3 text-[13px] text-primary outline-none placeholder:text-muted focus:border-control"
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            placeholder="Work 검색"
            type="search"
            value={query}
          />
        </label>
        <Tabs
          onValueChange={(value) => {
            onFilterChange(value as DesktopFilter);
          }}
          value={filter}
        >
          <TabsList aria-label="Work 상태" className="gap-1">
            <TabsTrigger
              className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
              value="active"
            >
              진행 중
            </TabsTrigger>
            <TabsTrigger
              className="h-7 rounded-[5px] border px-2.5 text-[12px] data-[active]:border-control data-[active]:bg-surface-2 data-[active]:text-primary"
              value="complete"
            >
              완료
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {works.length || (pendingRunId && filter === "active") ? (
          // 둥근 행에 여백을 주면 사이 구분이 약합니다. 전폭 행과 1px 선이 밀도와 구분감을 같이 만듭니다.
          <div className="divide-y divide-border border-b border-border">
            {pendingRunId && filter === "active" ? (
              <div
                aria-label={`Work 생성 중 ${pendingRunId}`}
                className="border-b border-dashed border-control bg-surface-1 px-3 py-2.5"
                role="status"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-secondary">
                  <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-accent" />
                  Work 생성 중
                </span>
                <span className="mt-2 block truncate font-mono text-[10px] text-muted">{pendingRunId}</span>
              </div>
            ) : null}
            {works.map((work) => {
              const selected = work.id === selectedId;
              return (
                <button
                  aria-pressed={selected}
                  className={`relative w-full px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                    selected
                      ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                      : "hover:bg-surface-1"
                  }`}
                  key={work.id}
                  onClick={() => {
                    onSelect(work.id);
                  }}
                  type="button"
                >
                  <span className="block truncate text-[13px] font-medium text-primary">{work.title}</span>
                  <span className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className={`flex items-center gap-2 ${workStatusClass[work.status]}`}>
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                      {workStatusLabel[work.status]}
                    </span>
                    <time className="font-mono text-muted">{work.updatedAt}</time>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-12 text-center">
            <Briefcase aria-hidden="true" className="mx-auto mb-3 text-muted" size={26} />
            <p className="text-sm text-secondary">{query ? "검색 결과가 없습니다." : "완료된 Work가 없습니다."}</p>
            <p className="mt-1 text-xs text-muted">
              {query ? "검색어를 바꿔보세요." : "완료된 업무가 여기에 표시됩니다."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkActivityProps {
  onCloseRoom: (roomId: string) => void;
  onSelectRoom: (roomId: string) => void;
  room?: RoomView | undefined;
  rooms: RoomView[];
  work: WorkView;
  composer: string;
  announcement: string;
  detailLoading: boolean;
  executionNotice: string | undefined;
  approvalDecisions: Record<string, "approved" | "rejected">;
  pendingApprovals: ReadonlySet<string>;
  pendingDirective: boolean;
  pendingRunAction: "cancel" | "resume" | undefined;
  onComposerChange: (value: string) => void;
  onAnnouncement: (message: string) => void;
  onControlRun: (action: "cancel" | "resume") => void;
  onDecideApproval: (approval: ApprovalView, decision: "approved" | "rejected") => void;
  onSubmitDirective: (mode: "now" | "next-stage") => void;
}

function WorkActivity({
  announcement,
  approvalDecisions,
  composer,
  detailLoading,
  executionNotice,
  onAnnouncement,
  onComposerChange,
  onControlRun,
  onDecideApproval,
  onSubmitDirective,
  pendingApprovals,
  pendingDirective,
  pendingRunAction,
  onCloseRoom,
  onSelectRoom,
  room,
  rooms,
  work,
}: WorkActivityProps) {
  const canCancel = work.run && ["ready", "running", "awaiting-approval", "blocked"].includes(work.run.status);
  const canResume = work.run?.status === "blocked";
  // 방이 있으면 대화는 방이 정본입니다. 없으면 Work의 활동 타임라인이 계속 나옵니다.
  const activities = room ? room.activities : work.activities;
  return (
    <main
      aria-busy={detailLoading || undefined}
      aria-label={work.title}
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_auto_minmax(0,1fr)_auto] bg-canvas"
    >
      <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-[16px] font-semibold tracking-[-0.02em]">{work.title}</h1>
          <Badge tone={work.status === "complete" ? "success" : work.status === "failed" ? "danger" : "accent"}>
            {workStatusLabel[work.status]}
          </Badge>
          {/*
           * 방이 화면의 주인이라는 사실을 헤더가 말해야 합니다.
           * 참가자 얼굴과 라운드·비용이 여기 없으면 중앙이 그냥 대화 목록으로 읽힙니다.
           */}
          {room ? (
            <>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
              <span
                className="flex shrink-0 items-center gap-1.5"
                title={`협업방 참가 ${String(room.participants.length)}명`}
              >
                <SpeakerRow limit={5} speakers={room.participants} />
                <span className="font-mono text-[11px] text-muted">참가 {room.participants.length}</span>
              </span>
              {room.budgets.length ? (
                <span className="hidden shrink-0 font-mono text-[11px] text-muted min-[1360px]:inline">
                  {room.budgets.map((budget) => `${budget.label} ${budget.display}`).join(" · ")}
                </span>
              ) : null}
            </>
          ) : (
            <Badge className="max-[1320px]:hidden">{work.team}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {executionNotice ? (
            <span aria-live="polite" className="mr-2 max-w-48 truncate text-xs text-accent" role="status">
              {executionNotice}
            </span>
          ) : null}
          {work.run?.status === "awaiting-approval" ? (
            <span className="mr-2 text-xs text-gate">승인 결정 대기 중</span>
          ) : null}
          {canResume ? (
            <Button
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("resume");
              }}
              size="sm"
              variant="ghost"
            >
              {pendingRunAction === "resume" ? "재개 중" : "실행 재개"}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              disabled={pendingRunAction !== undefined}
              onClick={() => {
                onControlRun("cancel");
              }}
              size="sm"
              variant="ghost"
            >
              {pendingRunAction === "cancel" ? "취소 중" : "실행 취소"}
            </Button>
          ) : null}
        </div>
      </header>
      {/*
       * 탭 바는 "지금 어느 방에 있나"를 말하는 자리이므로 방이 하나여도 항상 그립니다.
       * 래퍼는 방이 없을 때도 유지합니다. grid 행 수가 흔들리면 본문이 접힙니다.
       */}
      <div>
        {rooms.length > 0 ? (
          <nav aria-label="협업방" className="flex items-center gap-1 border-b border-border px-5 py-1.5">
            {rooms.map((candidate, index) => {
              const current = candidate.roomId === room?.roomId;
              // 어느 방이 사람을 기다리는지. 노랑은 여기서도 같은 뜻입니다.
              const waiting = candidate.activities.some(
                (activity) => activity.kind === "proposal" || activity.kind === "approval",
              );
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className={`flex items-center gap-2 rounded-[5px] px-2.5 py-1 text-left outline-none ${
                    current ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-1"
                  }`}
                  key={candidate.roomId}
                  onClick={() => {
                    onSelectRoom(candidate.roomId);
                  }}
                  type="button"
                >
                  {/*
                   * 탭은 지금 보고 있지 않은 방을 보는 유일한 자리입니다.
                   * 색이 "저 방엔 누가 있나"를 이름보다 빨리 말하므로 아바타를 유지하되,
                   * 폭이 무한히 자라지 않게 둘로 제한하고 나머지는 +N으로 알립니다.
                   */}
                  <SpeakerRow limit={2} speakers={candidate.participants} />
                  <span className="text-[13px] font-medium">{candidate.name}</span>
                  {waiting ? (
                    <span aria-label="확인 필요" className="text-[11px] text-gate">
                      ◇
                    </span>
                  ) : null}
                  {index === 0 ? null : (
                    <span
                      aria-label={`${candidate.name} 닫기`}
                      className="ml-0.5 rounded-[3px] px-1 text-[11px] text-muted hover:text-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseRoom(candidate.roomId);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      ✕
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        ) : null}
      </div>
      <section aria-label={room ? `협업방 ${room.name}` : "Work 활동"} className="min-h-0 overflow-y-auto px-5 py-3">
        <div className="mx-auto max-w-[860px]">
          {room && activities.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              아직 이 방에서 오간 말이 없습니다. 아래에 지시를 쓰면 조직이 시작합니다.
            </p>
          ) : null}
          {activities.map((activity) => (
            <ActivityRow
              approvalDecision={activity.kind === "approval" ? approvalDecisions[activity.approvalId] : undefined}
              approvals={work.approvals}
              key={activity.id}
              onAnnouncement={onAnnouncement}
              onDecideApproval={onDecideApproval}
              onOpenRoom={onSelectRoom}
              pendingApprovals={pendingApprovals}
              value={activity}
            />
          ))}
        </div>
      </section>
      <Composer
        announcement={announcement}
        onAnnouncement={onAnnouncement}
        onChange={onComposerChange}
        onSubmit={onSubmitDirective}
        pending={pendingDirective}
        value={composer}
      />
    </main>
  );
}

interface ActivityRowProps {
  onOpenRoom: (roomId: string) => void;
  value: ActivityView;
  approvalDecision: "approved" | "rejected" | undefined;
  approvals: ApprovalView[];
  pendingApprovals: ReadonlySet<string>;
  onAnnouncement: (message: string) => void;
  onDecideApproval: (approval: ApprovalView, decision: "approved" | "rejected") => void;
}

function ActivityRow({
  approvalDecision,
  approvals,
  onAnnouncement,
  onOpenRoom,
  onDecideApproval,
  pendingApprovals,
  value,
}: ActivityRowProps) {
  const approval = value.kind === "approval" ? approvals.find((item) => item.id === value.approvalId) : undefined;

  // 방 문법은 40px 거터 격자를 쓰지 않습니다. 구분선·상태·인계는 폭 전체를 씁니다.
  if (value.kind === "chapter") {
    return (
      <div className="py-2">
        <RoomChapter label={value.label} time={value.time} until={value.until} />
      </div>
    );
  }
  if (value.kind === "roomStatus") {
    return (
      <div className="py-2">
        <RoomStatus content={value.content} />
      </div>
    );
  }
  if (value.kind === "roomRef") {
    return (
      <div className="py-2">
        <RoomReference
          messageCount={value.messageCount}
          name={value.name}
          onOpen={() => {
            onOpenRoom(value.roomId);
          }}
          participants={value.participants}
          lastLine={value.lastLine}
          time={value.time}
          waiting={value.waiting}
        />
      </div>
    );
  }
  if (value.kind === "handoff") {
    return (
      <div className="py-2">
        <RoomHandoff from={value.from} time={value.time} to={value.to} />
      </div>
    );
  }
  if (value.kind === "room") {
    return (
      <div className="py-2.5">
        <RoomMessage
          speaker={value.speaker}
          content={value.content}
          evidence={value.evidence}
          indented={value.indented}
          quoted={value.quoted}
          recipient={value.recipient}
          signature={value.signature}
          target={value.target}
          time={value.time}
          type={value.messageType}
        />
      </div>
    );
  }
  if (value.kind === "proposal") {
    return (
      <div className="py-2.5">
        <ProposalActivity
          speaker={value.speaker}
          change={value.change}
          content={value.content}
          decided={false}
          disabled={false}
          // ponytail: 조직 변경 command는 슬라이스 4에서 연결합니다. 지금은 결과를 알림으로만 알립니다.
          onApprove={() => {
            onAnnouncement(`${value.change.name} 신설을 승인했습니다.`);
          }}
          onReject={() => {
            onAnnouncement(`${value.change.name} 신설을 거절했습니다.`);
          }}
          time={value.time}
        />
      </div>
    );
  }

  return (
    <article className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-border/70 py-4 last:border-b-0">
      <ActivityMarker value={value} />
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          {value.kind === "message" ? <span className="font-medium text-secondary">{value.author}</span> : null}
          <time className="font-mono">{value.time}</time>
        </div>
        {value.kind === "message" ? (
          <p className="rounded-md border border-border bg-surface-1 px-4 py-3 text-sm leading-6 text-secondary">
            {value.content}
          </p>
        ) : null}
        {value.kind === "plan" ? <PlanActivity title={value.title} steps={value.steps} /> : null}
        {value.kind === "agents" ? <AgentsActivity agents={value.agents} title={value.title} /> : null}
        {value.kind === "approval" ? (
          <ApprovalActivity
            decision={approvalDecision}
            description={value.description}
            disabled={!approval || pendingApprovals.has(value.approvalId)}
            onApprove={() => {
              if (approval) onDecideApproval(approval, "approved");
            }}
            onReject={() => {
              if (approval) onDecideApproval(approval, "rejected");
            }}
            title={value.title}
          />
        ) : null}
        {value.kind === "artifacts" ? <ArtifactsActivity artifacts={value.artifacts} title={value.title} /> : null}
        {value.kind === "event" ? (
          <EventActivity detail={value.detail} status={value.status} title={value.title} />
        ) : null}
      </div>
    </article>
  );
}

// 방 문법(chapter·roomStatus·handoff·room·proposal)은 ActivityRow에서 먼저 반환되므로 여기 오지 않습니다.
type MarkedActivity = Extract<
  ActivityView,
  { kind: "message" | "plan" | "agents" | "approval" | "artifacts" | "event" }
>;

function ActivityMarker({ value }: { value: MarkedActivity }) {
  if (value.kind === "message") {
    return (
      <Avatar
        className={
          value.initials === "M"
            ? "rounded-md border border-accent/60 bg-surface-1 text-accent"
            : "border border-border"
        }
      >
        <AvatarFallback className={value.initials === "M" ? "text-accent" : ""}>{value.initials}</AvatarFallback>
      </Avatar>
    );
  }

  const icons = { plan: ListChecks, agents: UsersThree, approval: ShieldCheck, artifacts: Briefcase, event: Clock };
  const Icon = icons[value.kind];
  return (
    <span className="flex size-8 items-center justify-center rounded-md border border-control text-secondary">
      <Icon aria-hidden="true" size={17} />
    </span>
  );
}

function PlanActivity({ steps, title }: { steps: TaskView[]; title: string }) {
  return (
    <details className="group rounded-md border border-border bg-surface-1" open>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        {title}
        {/* 단계 수를 말합니다. 몇 개 중 몇 개를 보고 있는지 모르면 목록이 거짓말을 합니다. */}
        <span className="font-mono text-[11px] font-normal text-muted">
          {steps.filter((step) => step.state === "done").length} / {steps.length}
        </span>
        <CaretDown
          aria-hidden="true"
          className="ml-auto text-muted transition-transform group-open:rotate-180"
          size={16}
        />
      </summary>
      <ol className="border-t border-border px-4 py-2">
        {steps.map((step, index) => (
          <li className="flex min-h-8 items-center gap-3 text-sm" key={step.id}>
            <span
              className={`flex size-5 items-center justify-center rounded-full border font-mono text-[10px] ${stateClass[step.state]}`}
            >
              {step.state === "done" ? <CheckCircle aria-hidden="true" size={14} weight="fill" /> : index + 1}
            </span>
            <span className="flex-1 text-secondary">{step.title}</span>
            <span className={`text-xs ${stateClass[step.state]}`}>{stateLabel[step.state]}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AgentsActivity({ agents, title }: { agents: AgentView[]; title: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {agents.map((agent) => (
          <div
            className="flex min-w-[122px] items-center gap-2 rounded-md border border-border px-2.5 py-2"
            key={agent.id}
          >
            <Avatar className="size-7">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{agent.name}</span>
                <span className="shrink-0 rounded-[3px] border border-control px-1 text-[10px] text-muted">
                  {agent.role}
                </span>
              </p>
              <p className={agent.state === "active" ? "text-[11px] text-primary" : "text-[11px] text-muted"}>
                {agent.state === "active" ? "진행 중" : "대기"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ApprovalActivityProps {
  title: string;
  description: string;
  decision: "approved" | "rejected" | undefined;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

function ApprovalActivity({ decision, description, disabled, onApprove, onReject, title }: ApprovalActivityProps) {
  return (
    <div
      className={`rounded-[7px] border px-4 py-3 ${decision ? "border-border bg-surface-1" : "border-gate-border bg-gate-wash"}`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[5px] border border-control text-secondary">
          <Database aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{title}</h3>
            {decision ? (
              <Badge tone={decision === "approved" ? "success" : "danger"}>
                {decision === "approved" ? "승인됨" : "거절됨"}
              </Badge>
            ) : (
              <span className="text-xs font-medium text-gate">승인 필요</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
          <p className="text-xs leading-5 text-muted">영향: 승인 전까지 관련 실행이 대기합니다.</p>
        </div>
      </div>
      {!decision ? (
        <div className="mt-3 flex justify-end">
          <DecisionActions
            approveName={title}
            busy={disabled}
            disabled={disabled}
            onApprove={onApprove}
            onReject={onReject}
          />
        </div>
      ) : null}
    </div>
  );
}

function ArtifactsActivity({ artifacts, title }: { artifacts: ArtifactView[]; title: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-2 gap-2">
        {artifacts.map((artifact) => {
          const Icon = artifact.format === "PDF" ? FilePdf : FileCsv;
          return (
            <div
              aria-label={`${artifact.name} 메타데이터`}
              className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 text-left"
              key={artifact.id}
            >
              <Icon
                aria-hidden="true"
                className={artifact.format === "PDF" ? "text-danger" : "text-success"}
                size={24}
                weight="fill"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-primary">{artifact.name}</span>
                <span className="font-mono text-[10px] text-muted">{artifact.size}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted">열기·다운로드 미지원</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventActivity({
  detail,
  status,
  title,
}: {
  detail: string | undefined;
  status: string | undefined;
  title: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {status ? <Badge>{status}</Badge> : null}
      </div>
      {detail ? <p className="mt-1 text-xs leading-5 text-muted">{detail}</p> : null}
    </div>
  );
}

interface ComposerProps {
  value: string;
  announcement: string;
  pending: boolean;
  onChange: (value: string) => void;
  onAnnouncement: (message: string) => void;
  onSubmit: (mode: "now" | "next-stage") => void;
}

function Composer({ announcement, onAnnouncement, onChange, onSubmit, pending, value }: ComposerProps) {
  return (
    <div className="border-t border-border bg-canvas px-5 pb-4 pt-3" data-testid="directive-composer">
      <div className="mx-auto max-w-[860px] rounded-lg border border-control bg-surface-1 p-3 focus-within:border-accent/70">
        <label className="sr-only" htmlFor="directive">
          추가 지시
        </label>
        <Textarea
          aria-label="추가 지시"
          id="directive"
          onChange={(event) => {
            onChange(event.target.value);
          }}
          placeholder="대표에게 추가 지시..."
          value={value}
        />
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-1">
            <Button
              aria-label="파일 첨부"
              onClick={() => {
                onAnnouncement("파일 첨부 준비가 되었습니다.");
              }}
              size="icon"
              variant="ghost"
            >
              <Paperclip aria-hidden="true" size={18} />
            </Button>
            <Button
              aria-label="에이전트 멘션"
              onClick={() => {
                onAnnouncement("멘션할 에이전트를 선택하세요.");
              }}
              size="icon"
              variant="ghost"
            >
              <At aria-hidden="true" size={18} />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={!value.trim() || pending}
              onClick={() => {
                onSubmit("now");
              }}
            >
              <Lightning aria-hidden="true" size={16} />
              지금 반영
            </Button>
            <Button
              aria-label="다음 단계에 반영"
              disabled={!value.trim() || pending}
              onClick={() => {
                onSubmit("next-stage");
              }}
              variant="primary"
            >
              다음 단계
              <ArrowRight aria-hidden="true" size={16} />
            </Button>
          </div>
        </div>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="mt-2 min-h-4 text-right text-[11px] text-muted"
          role="status"
        >
          {announcement}
        </p>
      </div>
    </div>
  );
}

function InspectorRoom({ room }: { room: RoomView }) {
  return (
    <>
      <section aria-labelledby="room-participants" className="border border-border bg-surface-1">
        <h2
          className="border-b border-border px-3.5 py-2.5 text-[10px] font-semibold tracking-[0.08em] text-muted"
          id="room-participants"
        >
          이 방의 참가자 {room.participants.length}
        </h2>
        {room.participants.length ? (
          <ul className="divide-y divide-border">
            {room.participants.map((participant) => (
              <li className="flex items-center gap-2 px-3.5 py-2" key={participant.handle}>
                <AgentAvatar speaker={participant} />
                <span className="truncate text-xs font-medium text-primary">{participant.name}</span>
                <span className="shrink-0 rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                  {participant.role}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3.5 py-3 text-xs text-muted">참가자 정보가 아직 없습니다.</p>
        )}
      </section>

      {room.budgets.length ? (
        <section aria-labelledby="room-budget" className="border border-border bg-surface-1 px-3.5 py-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted" id="room-budget">
            방 한도
          </h2>
          <div className="mt-2.5 grid gap-2.5">
            {room.budgets.map((budget) => (
              <div key={budget.label}>
                <p className="flex items-center justify-between text-xs text-secondary">
                  <span>{budget.label}</span>
                  <span className="font-mono text-[11px] text-muted">{budget.display}</span>
                </p>
                <span aria-hidden="true" className="mt-1 block h-[3px] overflow-hidden rounded-sm bg-bg-3">
                  <span
                    className="block h-full bg-muted"
                    style={{
                      width: `${String(Math.min(100, Math.round((budget.used / Math.max(budget.limit, 1)) * 100)))}%`,
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {room.sharedContexts.length ? (
        <section aria-labelledby="room-shared" className="border border-border bg-surface-1 px-3.5 py-3">
          <h2 className="text-[10px] font-semibold tracking-[0.08em] text-muted" id="room-shared">
            공유 컨텍스트
          </h2>
          <ul className="mt-2 grid gap-1.5">
            {room.sharedContexts.map((reference) => (
              <li className="text-xs text-secondary" key={reference.id}>
                <span className="block truncate">{reference.label}</span>
                <span className="font-mono text-[10px] text-muted">checksum {reference.checksum}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function WorkInspector({ room, work }: { room: RoomView | undefined; work: WorkView }) {
  return (
    <aside
      aria-label="Work 세부 정보"
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome"
    >
      <Tabs className="contents" defaultValue="work" key={work.id}>
        <header className="flex items-end border-b border-border px-2">
          <TabsList aria-label="세부 정보 보기" className="h-full w-full justify-between">
            <TabsTrigger className="h-full flex-1 px-1" value="work">
              편성
            </TabsTrigger>
            <TabsTrigger className="h-full flex-1 px-1" value="artifacts">
              산출물
            </TabsTrigger>
            <TabsTrigger className="h-full flex-1 px-1" value="verification">
              검증
            </TabsTrigger>
          </TabsList>
        </header>
        <div className="min-h-0 overflow-y-auto p-3">
          <TabsContent className="space-y-3" value="work">
            {room ? <InspectorRoom room={room} /> : <InspectorAgents agents={work.agents} />}
            <InspectorTasks progress={work.progress} tasks={work.tasks} />
          </TabsContent>
          <TabsContent value="artifacts">
            {work.artifacts.length ? (
              <section aria-labelledby="artifact-title" className="border border-border bg-surface-1">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold" id="artifact-title">
                  산출물 {work.artifacts.length}
                </h2>
                <div className="divide-y divide-border">
                  {work.artifacts.map((artifact) => (
                    <div className="flex w-full items-center gap-3 px-4 py-3 text-left" key={artifact.id}>
                      {artifact.format === "PDF" ? (
                        <FilePdf aria-hidden="true" className="text-danger" size={20} />
                      ) : (
                        <FileCsv aria-hidden="true" className="text-success" size={20} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-primary">{artifact.name}</span>
                        <span className="font-mono text-[10px] text-muted">
                          {artifact.format} · {artifact.size} · {artifact.createdAt}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">메타데이터만</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <InspectorEmpty icon={Briefcase} message="아직 생성된 산출물이 없습니다." />
            )}
          </TabsContent>
          <TabsContent value="verification">
            <InspectorVerifications values={work.verifications} />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function InspectorTasks({ progress, tasks }: { progress: number; tasks: TaskView[] }) {
  const complete = tasks.filter((task) => task.state === "done").length;
  return (
    <details className="border border-border bg-surface-1" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        <span>
          작업{" "}
          <span className="ml-1 font-mono font-normal text-muted">
            {complete}/{tasks.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-muted" size={15} />
      </summary>
      <div className="px-4 pb-2">
        <div
          aria-label={`작업 진행률 ${String(progress)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="mb-2 h-1 overflow-hidden rounded-full bg-border"
          role="progressbar"
        >
          <span className="block h-full bg-accent" style={{ width: `${String(progress)}%` }} />
        </div>
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li className="flex min-h-10 items-center gap-2 text-xs" key={task.id}>
              <StateIcon state={task.state} />
              <span className="min-w-0 flex-1 truncate text-secondary">{task.title}</span>
              <span className={`shrink-0 ${stateClass[task.state]}`}>{task.time ?? stateLabel[task.state]}</span>
              <CaretRight aria-hidden="true" className="text-muted" size={13} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function InspectorAgents({ agents }: { agents: AgentView[] }) {
  return (
    <section aria-labelledby="agent-title" className="border border-border bg-surface-1 px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold" id="agent-title">
        담당 에이전트
      </h2>
      <ul className="divide-y divide-border">
        {agents.map((agent) => (
          <li className="flex min-h-10 items-center gap-2" key={agent.id}>
            <Avatar className="size-7">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-primary">{agent.name}</span>
              <span className="shrink-0 rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                {agent.role}
              </span>
            </span>
            <span
              className={
                agent.state === "active"
                  ? "flex items-center gap-1 text-[11px] text-primary"
                  : "flex items-center gap-1 text-[11px] text-muted"
              }
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${agent.state === "active" ? "bg-success" : "bg-muted"}`}
              />
              {agent.state === "active" ? "진행 중" : "대기"}
            </span>
            <CaretRight aria-hidden="true" className="text-muted" size={13} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InspectorVerifications({ values }: { values: WorkView["verifications"] }) {
  const complete = values.filter((item) => item.state === "done").length;
  return (
    <details className="border border-border bg-surface-1" open>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70">
        <span>
          검증 기준{" "}
          <span className="ml-1 font-mono font-normal text-muted">
            {complete}/{values.length}
          </span>
        </span>
        <CaretDown aria-hidden="true" className="text-muted" size={15} />
      </summary>
      <ul className="divide-y divide-border px-4 pb-2">
        {values.map((verification) => (
          <li className="py-2.5" key={verification.id}>
            <div className="flex items-center gap-2 text-xs">
              <StateIcon state={verification.state} />
              <span className="min-w-0 flex-1 text-secondary">{verification.title}</span>
              <span className={stateClass[verification.state]}>{stateLabel[verification.state]}</span>
              <CaretRight aria-hidden="true" className="text-muted" size={13} />
            </div>
            {verification.evidence ? (
              <p className="mt-1 pl-6 font-mono text-[10px] text-muted">{verification.evidence}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function StateIcon({ state }: { state: StepState }) {
  if (state === "done")
    return <CheckCircle aria-label="완료" className="shrink-0 text-success" size={16} weight="fill" />;
  if (state === "failed")
    return <WarningCircle aria-label="실패" className="shrink-0 text-danger" size={16} weight="fill" />;
  return (
    <span
      aria-label={stateLabel[state]}
      className={`size-4 shrink-0 rounded-full border ${state === "active" ? "border-accent" : "border-muted"}`}
      role="img"
    />
  );
}

function InspectorEmpty({ icon: Icon, message }: { icon: typeof Briefcase; message: string }) {
  return (
    <div className="px-5 py-14 text-center">
      <Icon aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
      <p className="text-sm text-secondary">{message}</p>
      <p className="mt-1 text-xs text-muted">실행이 산출물을 만들면 여기에 표시됩니다.</p>
    </div>
  );
}

interface NewWorkDialogProps {
  addWorkspacePaths: (files: readonly string[]) => void;
  contextPicker: NativeContextPicker;
  error: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  setText: (value: string) => void;
  setWorkspace: (workspace: import("./desktop-service").DesktopWorkspaceView | undefined) => void;
  removeWorkspacePath: (path: string) => void;
  registerWorkspace: (path: string) => Promise<void>;
  registeringWorkspace: boolean;
  setPickerError: (message: string) => void;
  decideWorkspaceTrust: (decision: "trusted" | "blocked") => Promise<void>;
  start: () => Promise<void>;
  starting: boolean;
  text: string;
  workspace: import("./desktop-service").DesktopWorkspaceView | undefined;
  workspacePaths: readonly string[];
  workspaces: readonly import("./desktop-service").DesktopWorkspaceView[];
  workspacesLoading: boolean;
  onOpenSettings: () => void;
}

function NewWorkDialog({
  addWorkspacePaths,
  contextPicker,
  error,
  open,
  setOpen,
  setText,
  setWorkspace,
  removeWorkspacePath,
  registerWorkspace,
  registeringWorkspace,
  setPickerError,
  decideWorkspaceTrust,
  start,
  starting,
  text,
  workspace,
  workspacePaths,
  workspaces,
  workspacesLoading,
  onOpenSettings,
}: NewWorkDialogProps) {
  const addDirectory = async () => {
    try {
      setPickerError("");
      const path = await contextPicker.pickDirectory();
      if (path !== undefined) await registerWorkspace(path);
    } catch {
      setPickerError("폴더 선택기를 열지 못했습니다.");
    }
  };
  const addFiles = async () => {
    try {
      setPickerError("");
      const paths = await contextPicker.pickFiles();
      addWorkspacePaths(paths);
    } catch {
      setPickerError("파일 선택기를 열지 못했습니다.");
    }
  };
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!starting) setOpen(nextOpen);
      }}
      open={open}
    >
      <DialogContent aria-label="새 Work">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-lg font-semibold">새 Work</DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-6 text-muted">
              대표 에이전트에게 맡길 업무를 입력하면 새 실행이 시작됩니다.
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="새 Work 닫기"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-accent/70"
            disabled={starting}
          >
            <X aria-hidden="true" size={17} />
          </DialogClose>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label className="block text-sm font-medium" htmlFor="new-work-text">
            업무 요청
            <Textarea
              autoFocus
              className="mt-2 min-h-28 border border-control bg-surface-1 px-3 py-2"
              disabled={starting}
              id="new-work-text"
              onChange={(event) => {
                setText(event.target.value);
              }}
              placeholder="예: 파트너 계약의 주요 위험을 검토해줘"
              required
              value={text}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              워크스페이스 <span className="font-normal text-muted">(선택)</span>
            </legend>
            <div className="min-h-[5.5rem] max-h-36 space-y-2 overflow-y-auto rounded-md border border-control bg-surface-1 p-2">
              {workspacesLoading ? (
                <div aria-label="워크스페이스 불러오는 중" className="h-14 animate-pulse rounded bg-surface-2" />
              ) : workspaces.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted">저장된 폴더가 없습니다.</p>
              ) : (
                workspaces.map((item) =>
                  item.trust === "blocked" ? (
                    <div className="rounded px-2 py-1 text-sm text-muted" key={item.workspaceId}>
                      <span className="block font-medium">{item.name} (차단됨)</span>
                      <span className="block font-mono text-xs">{item.path}</span>
                      <span className="block text-xs">차단된 폴더는 선택할 수 없습니다.</span>
                      <Button
                        disabled={registeringWorkspace}
                        onClick={onOpenSettings}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        설정으로 이동
                      </Button>
                    </div>
                  ) : (
                    <button
                      aria-pressed={workspace?.workspaceId === item.workspaceId}
                      className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={starting || registeringWorkspace}
                      key={item.workspaceId}
                      onClick={() => {
                        setWorkspace(item);
                      }}
                      type="button"
                    >
                      <span className="block font-medium">
                        {item.name}{" "}
                        <span className="font-normal text-muted">
                          ({item.trust === "trusted" ? "신뢰됨" : "신뢰 필요"})
                        </span>
                      </span>
                      <span className="block font-mono text-xs text-muted">{item.path}</span>
                    </button>
                  ),
                )
              )}
            </div>
            <p aria-live="polite" className="sr-only">
              {workspace === undefined ? "" : `${workspace.name} 폴더를 선택했습니다.`}
            </p>
            <Button
              disabled={starting || registeringWorkspace}
              onClick={() => {
                void addDirectory();
              }}
              type="button"
              variant="outline"
            >
              폴더 추가
            </Button>
            {workspace?.trust === "pending" ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p>이 폴더 안에서 에이전트가 읽기·쓰기 도구를 사용할 수 있습니다.</p>
                <p className="mt-1 font-mono text-xs text-muted">{workspace.path}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    disabled={starting || registeringWorkspace}
                    onClick={() => {
                      void decideWorkspaceTrust("trusted");
                    }}
                    size="sm"
                    type="button"
                    variant="primary"
                  >
                    신뢰
                  </Button>
                  <Button
                    disabled={starting || registeringWorkspace}
                    onClick={() => {
                      void decideWorkspaceTrust("blocked");
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    차단
                  </Button>
                </div>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              파일 첨부 <span className="font-normal text-muted">(선택)</span>
            </legend>
            <Button
              disabled={
                starting ||
                registeringWorkspace ||
                workspace === undefined ||
                workspace.trust !== "trusted" ||
                workspacePaths.length >= 20
              }
              onClick={() => {
                void addFiles();
              }}
              type="button"
              variant="outline"
            >
              파일 첨부
            </Button>
            <p aria-live="polite" aria-label="파일 첨부 상태" className="sr-only" role="status">
              {workspacePaths.length === 0 ? "" : `파일을 첨부했습니다: ${workspacePaths.join(", ")}`}
            </p>
            {workspacePaths.length > 0 ? (
              <ul aria-live="polite" className="flex flex-wrap gap-2">
                {workspacePaths.map((path) => (
                  <li className="rounded bg-surface-2 px-2 py-1 font-mono text-xs" key={path}>
                    {path}{" "}
                    <button
                      aria-label={`${path} 제거`}
                      className="ml-1 text-muted hover:text-primary"
                      disabled={starting || registeringWorkspace}
                      onClick={() => {
                        removeWorkspacePath(path);
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </fieldset>
          <p aria-live="polite" className="min-h-5 text-xs text-danger" role="status">
            {error}
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose
              className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-secondary outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50"
              disabled={starting}
            >
              취소
            </DialogClose>
            <Button disabled={!text.trim() || starting || registeringWorkspace} type="submit" variant="primary">
              {starting ? "시작 중" : "실행 시작"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
