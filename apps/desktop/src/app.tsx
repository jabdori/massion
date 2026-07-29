import {
  ArrowBendDownRightIcon as ArrowBendDownRight,
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
  ListChecksIcon as ListChecks,
  MagnifyingGlassIcon as MagnifyingGlass,
  PaperclipIcon as Paperclip,
  PlugsIcon as Plugs,
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
import {
  KNOWLEDGE_FORCE_DEFAULTS,
  KnowledgeForcePanel,
  KnowledgeGraphCanvas,
  KnowledgeGroupLegend,
  type KnowledgeForceSettings,
} from "@/knowledge-graph";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  AutonomyView,
  CommandIdentity,
  ContributionKind,
  DesktopFilter,
  DesktopService,
  DesktopWorkspaceView,
  ExtensionEntryView,
  GrowthSignalView,
  GrowthView,
  ModelRouteView,
  KnowledgeGraphView,
  KnowledgeIndexView,
  KnowledgeLinkView,
  KnowledgeNodeKind,
  KnowledgeNodeView,
  KnowledgeRelationKind,
  OrganizationNodeView,
  OrganizationView,
  PermissionKind,
  ProviderConnectionView,
  SettingsView,
  SubscriptionAccountView,
} from "@/desktop-service";
import {
  effectiveGrowthMode,
  type GrowthAdoptionMode,
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
  type VerificationCriterionStatus,
  type QueuedDirectiveView,
  type ReasoningEffort,
  type WorkAutonomyMode,
  type WorkStatus,
  type WorkView,
} from "@/model";
import { agentIdentityToken, growthTargetToken, type WorkKnowledgeViewV1 } from "@massion/application/client";

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
  // 업무가 쓰는 재료이고 조직보다 자주 엽니다(ADR-002).
  { label: "지식", icon: Database, surface: "knowledge" },
  { label: "조직", icon: TreeStructure, surface: "organization" },
  { label: "개선", icon: Star, surface: "growth" },
  { label: "확장", icon: PuzzlePiece, surface: "capabilities" },
  // 모델을 공급해 조직이 할 수 있는 일을 늘립니다. 확장과 같은 종류라 나란히 둡니다(헌법 4.11).
  { label: "프로바이더", icon: Plugs, surface: "providers" },
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

const criterionStatusLabel: Record<VerificationCriterionStatus, string> = {
  passed: "통과",
  failed: "미통과",
  blocked: "막힘",
  excluded: "제외",
};

// 통과가 기본값이라 가라앉힙니다. 막힘은 사람이 손대야 풀리므로 gate 예약어를 씁니다.
const criterionStatusClass: Record<VerificationCriterionStatus, string> = {
  passed: "text-muted",
  failed: "text-danger",
  blocked: "text-gate",
  excluded: "text-muted",
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
  /* Work 단위 권한. 도메인의 AutonomyStore가 조직 단위라 계약이 열릴 때까지 화면이 앞세웁니다. */
  const [workAutonomy, setWorkAutonomy] = useState<Record<string, WorkAutonomyMode>>({});
  /* 인풋의 모델 셀렉트가 쓰는 목록. 프로바이더가 켜 둔 모델만 고를 수 있습니다. */
  const [availableModels, setAvailableModels] = useState<readonly string[]>([]);
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
  useEffect(() => {
    let disposed = false;
    void service
      .loadSettings()
      .then((value) => {
        if (disposed) return;
        const ids = projectProviderConnections(value.catalog)
          .flatMap((connection) => connection.models)
          // 임베딩 모델은 지시를 받는 자리가 아닙니다.
          .filter((model) => model.enabled && model.routeKind !== "embedding")
          .map((model) => model.modelId);
        setAvailableModels([...new Set(ids)].sort());
      })
      .catch(() => {
        // 모델 목록을 못 불러와도 인풋은 살아 있어야 합니다. 지금 쓰는 모델만 남습니다.
      });
    return () => {
      disposed = true;
    };
  }, [service]);

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
          // 연결 대상을 읽는 조회가 아직 계약에 없습니다. 인계에 기록.
          connection="local"
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
                  onSetAutonomy={(mode) => {
                    setWorkAutonomy((current) => ({ ...current, [controller.work?.id ?? ""]: mode }));
                  }}
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
                  models={availableModels}
                  onSubmitDirective={(mode, content) => {
                    void controller.submitDirective(mode, content);
                  }}
                  pendingApprovals={controller.pendingApprovals}
                  pendingDirective={controller.pendingDirective}
                  pendingRunAction={controller.pendingRunAction}
                  onCloseRoom={closeRoom}
                  onSelectRoom={openRoom}
                  room={room}
                  rooms={rooms.filter((candidate) => openRoomIds.includes(candidate.roomId))}
                  work={{
                    ...controller.work,
                    ...(workAutonomy[controller.work.id] === undefined
                      ? {}
                      : { autonomyMode: workAutonomy[controller.work.id] }),
                  }}
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
  connection,
  notificationCount,
  onOpenNotifications,
  onSelect,
  onToggle,
}: {
  activeSurface: DesktopSurface;
  collapsed: boolean;
  /** 조직이 이 컴퓨터에 있는지 원격 SurrealDB에 있는지. */
  connection: "local" | "remote";
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
        {/*
         * 조직이 이 컴퓨터에 있는지 다른 데 있는지는 늘 보여야 하는 사실입니다. 캡션으로 떠 있으면
         * 어디에도 속하지 않아 읽히지 않습니다. 선으로 끊고 점을 붙여 상태 줄로 세웁니다.
         */}
        <div className="mt-2 flex items-center gap-2 border-t border-border px-2.5 pt-2.5">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fg-3" />
          <span className="text-[12px] text-secondary group-data-[collapsed=true]/sidebar:hidden">
            {connection === "local" ? "로컬" : "원격"}
          </span>
        </div>
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
  if (surface === "knowledge") return <KnowledgeSurface onOpenWork={onOpenWork} service={service} />;
  if (surface === "providers") return <ProviderSurface service={service} />;
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

/*
 * 지식 표면 (ADR-002). 옵시디언의 그래프 뷰가 기준입니다.
 *
 * 캔버스는 **모양과 연결만** 나르고, 읽는 일은 시트가 합니다. 그래서 캔버스가 목록이 되면
 * 시트와 하는 일이 같아져 그래프가 없는 것과 같습니다. 열은 고정 3열이 아니라
 * 시트가 열릴 때만 셋이 됩니다 — 아무것도 고르지 않았으면 그래프가 폭을 다 씁니다.
 */
const knowledgeNodeKindLabel: Record<KnowledgeNodeKind, string> = {
  work: "업무",
  document: "문서",
  file: "파일",
  symbol: "심볼",
  artifact: "산출물",
  agent: "담당",
};

/**
 * 렌즈 = "무엇의 지도를 볼 것인가".
 *
 * **심볼은 렌즈가 아닙니다.** 심볼 1,800개를 한 캔버스에 펼치면 답하는 질문이 없습니다 —
 * 찾을 방법 없이 점만 많고, 실제로 알고 싶은 "이 심볼이 무엇과 엮였나"는 파일을 눌렀을 때
 * 시트의 «품고 있는 것»과 업무의 `근거` 탭이 이미 답합니다. 자료는 그대로 있고 지도만 뺍니다.
 */
const KNOWLEDGE_LENSES: readonly { kind: KnowledgeNodeKind; title: string; hint: string }[] = [
  { kind: "work", title: "업무별", hint: "어떤 일이 무엇을 썼나" },
  { kind: "document", title: "문서별", hint: "어떤 문서가 무엇을 설명하나" },
  { kind: "file", title: "파일별", hint: "어떤 파일이 어디에 엮이나" },
];

/*
 * 관계 종류 × 방향.
 *
 * 다섯 종류가 **같은 문형**을 씁니다 — `이것이 …` / `이것을 …`. 방향이 조사 하나로만
 * 갈리므로 훑을 때 종류만 눈에 들어오고 방향은 자동으로 읽힙니다.
 * `calls`는 방향이 뒤집히면 뜻이 정반대(부른다 ↔ 불린다)라 방향을 생략할 수 없습니다.
 */
const knowledgeEdgeLabel: Record<KnowledgeRelationKind, { outgoing: string; incoming: string }> = {
  calls: { outgoing: "이것이 부르는 것", incoming: "이것을 부르는 것" },
  imports: { outgoing: "이것이 가져다 쓰는 것", incoming: "이것을 가져다 쓰는 것" },
  implements: { outgoing: "이것이 구현하는 것", incoming: "이것을 구현하는 것" },
  contains: { outgoing: "이것이 담고 있는 것", incoming: "이것을 담고 있는 것" },
  // Work가 파일을 근거로 쓴 것과 문서가 코드를 설명하는 것을 함께 담습니다.
  documents: { outgoing: "이것이 참고한 것", incoming: "이것을 참고한 것" },
};

function KnowledgeSurface({ onOpenWork, service }: { onOpenWork: (workId: string) => void; service: DesktopService }) {
  const [workspaces, setWorkspaces] = useState<readonly DesktopWorkspaceView[]>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [lens, setLens] = useState<KnowledgeNodeKind>("work");
  const [index, setIndex] = useState<KnowledgeIndexView>();
  const [graph, setGraph] = useState<KnowledgeGraphView>();
  const [selectedId, setSelectedId] = useState<string>();
  const [forces, setForces] = useState<KnowledgeForceSettings>(KNOWLEDGE_FORCE_DEFAULTS);
  const [forcesOpen, setForcesOpen] = useState(false);
  const [links, setLinks] = useState<readonly KnowledgeLinkView[]>([]);
  const [selectedNode, setSelectedNode] = useState<KnowledgeNodeView>();
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void service
      .loadWorkspaces()
      .then((items) => {
        if (disposed) return;
        setWorkspaces(items);
        setWorkspaceId((current) => current ?? items[0]?.workspaceId);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "워크스페이스를 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  useEffect(() => {
    if (workspaceId === undefined) return;
    let disposed = false;
    setSelectedId(undefined);
    void Promise.all([service.loadKnowledgeIndex(workspaceId), service.loadKnowledgeGraph(workspaceId, lens)])
      .then(([indexView, graphView]) => {
        if (disposed) return;
        setIndex(indexView);
        setGraph(graphView);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "지식 상태를 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [lens, service, workspaceId]);

  // 고른 노드의 연결은 렌즈와 무관하게 전부 읽습니다.
  useEffect(() => {
    if (workspaceId === undefined || selectedId === undefined || selectedId === "") {
      setLinks([]);
      setSelectedNode(undefined);
      return;
    }
    let disposed = false;
    void service
      .loadKnowledgeLinks(workspaceId, selectedId)
      .then((items) => {
        if (!disposed) setLinks(items);
      })
      .catch(() => {
        if (!disposed) setLinks([]);
      });
    return () => {
      disposed = true;
    };
  }, [selectedId, service, workspaceId]);

  const workspace = workspaces?.find((item) => item.workspaceId === workspaceId);
  // 지도 밖 노드로 건너뛰어도 시트가 유지되도록 마지막으로 안 노드를 기억합니다.
  const onCanvas = graph?.nodes.find((node) => node.nodeId === selectedId);
  const selected = onCanvas ?? selectedNode;

  return (
    <main
      aria-label="지식"
      /* 시트가 열릴 때만 3열이 됩니다. 닫혀 있으면 캔버스가 폭을 다 씁니다. */
      className={`col-span-3 grid min-h-0 min-w-0 bg-canvas ${
        selected
          ? "grid-cols-[242px_minmax(0,1fr)_300px] min-[1440px]:grid-cols-[264px_minmax(0,1fr)_332px]"
          : "grid-cols-[242px_minmax(0,1fr)] min-[1440px]:grid-cols-[264px_minmax(0,1fr)]"
      }`}
    >
      <section
        aria-label="지도 종류"
        className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border bg-chrome"
      >
        <header className="flex items-center gap-2 border-b border-border px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em]">지식</h1>
        </header>
        <div className="min-h-0 overflow-y-auto">
          {error ? <SurfaceError message={error} /> : null}
          {workspaces === undefined && !error ? <SurfaceLoading /> : null}
          {workspaces?.length === 0 ? (
            <p className="px-3 py-8 text-center text-[12px] leading-5 text-muted">
              연결된 워크스페이스가 없습니다. 새 사명을 만들 때 폴더를 고르면 여기에 들어옵니다.
            </p>
          ) : null}
          {workspaces?.length ? (
            <>
              <div className="border-b border-border p-2">
                <label
                  className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
                  htmlFor="knowledge-workspace"
                >
                  워크스페이스
                </label>
                <select
                  className="mt-1 h-8 w-full rounded-[5px] border border-border bg-canvas px-2 text-[12px] outline-none"
                  id="knowledge-workspace"
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                  }}
                  value={workspaceId ?? ""}
                >
                  {workspaces.map((item) => (
                    <option key={item.workspaceId} value={item.workspaceId}>
                      {item.name}
                    </option>
                  ))}
                </select>
                {workspace && workspace.trust !== "trusted" ? (
                  <p className={`mt-1.5 text-[11px] ${workspace.trust === "blocked" ? "text-halt" : "text-gate"}`}>
                    {workspace.trust === "blocked" ? "차단된 폴더입니다" : "신뢰 확인 전이라 읽지 않았습니다"}
                  </p>
                ) : null}
              </div>
              <div className="divide-y divide-border border-b border-border">
                {KNOWLEDGE_LENSES.map((item) => {
                  const current = item.kind === lens;
                  return (
                    <button
                      aria-label={`${item.title} 지도`}
                      aria-pressed={current}
                      className={`relative flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors duration-150 ${
                        current
                          ? "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                          : "hover:bg-surface-1"
                      }`}
                      key={item.kind}
                      onClick={() => {
                        setLens(item.kind);
                      }}
                      type="button"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{item.title}</span>
                        <span className="block truncate text-[11px] text-muted">{item.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {graph && index?.status === "ready" ? (
                <div className="border-b border-border p-3">
                  <KnowledgeGroupLegend graph={graph} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <div className="relative grid min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)] border-r border-border">
        <header className="flex min-w-0 items-center gap-2 border-b border-border px-5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
            {KNOWLEDGE_LENSES.find((item) => item.kind === lens)?.title ?? "지도"}
          </h2>
          {index?.status === "ready" && graph ? (
            /*
             * 지금 지도에 실제로 있는 수를 말합니다. 색인 전체 수(심볼 1,836 등)를 여기 쓰면
             * 도달할 수 없는 것을 광고하게 됩니다 — 「잘린 사실을 감추지 않는다」의 반대입니다.
             * 색인 규모는 아래 배경 열이 소유합니다.
             */
            <span className="shrink-0 text-[11px] text-muted">
              <span className="tabular-nums">{graph.nodes.length.toLocaleString()}</span>개 ·{" "}
              <span className="tabular-nums">{graph.edges.length.toLocaleString()}</span>개 연결
            </span>
          ) : null}
          <span className="flex-1" />
          {index?.status === "ready" ? (
            <span
              className="shrink-0 text-[11px] text-fg-3"
              title={`이 워크스페이스 색인 — 파일 ${index.fileCount.toLocaleString()} · 심볼 ${index.symbolCount.toLocaleString()} · 관계 ${index.relationCount.toLocaleString()}${index.excluded.length ? ` · 제외 ${index.excluded.join(" · ")}` : ""}`}
            >
              색인 <span className="tabular-nums">{index.fileCount.toLocaleString()}</span>개 파일
            </span>
          ) : null}
          <button
            aria-label="힘 조절"
            aria-pressed={forcesOpen}
            className={`shrink-0 rounded-[5px] border px-2 py-0.5 text-[11px] disabled:opacity-40 ${
              forcesOpen ? "border-control bg-surface-2 text-primary" : "border-border text-muted hover:text-primary"
            }`}
            disabled={index?.status !== "ready"}
            onClick={() => {
              setForcesOpen((open) => !open);
            }}
            type="button"
          >
            힘 조절
          </button>
          {/* 버튼 아래에 붙는 팝오버. 캔버스를 덮되 좁게 두고 바깥을 누르면 닫힙니다. */}
          {forcesOpen && index?.status === "ready" ? (
            <>
              <button
                aria-label="힘 조절 닫기"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => {
                  setForcesOpen(false);
                }}
                tabIndex={-1}
                type="button"
              />
              <div className="absolute right-4 top-[42px] z-20 w-52 rounded-[7px] border border-line-strong bg-chrome p-3">
                <KnowledgeForcePanel forces={forces} onChange={setForces} />
              </div>
            </>
          ) : null}
        </header>
        <div className="min-h-0 min-w-0 overflow-hidden">
          {index?.status === "none" ? (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div>
                <p className="text-[13px] leading-5 text-primary">이 워크스페이스는 아직 색인되지 않았습니다.</p>
                <p className="mt-1.5 text-[12px] leading-5 text-muted">
                  {workspace?.trust === "trusted"
                    ? "색인 상태와 관계를 볼 조회가 아직 계약에 없습니다."
                    : "폴더를 신뢰해야 조직이 내용을 읽습니다."}
                </p>
              </div>
            </div>
          ) : null}
          {graph && index?.status === "ready" ? (
            <div className="relative h-full w-full">
              <MapBoundary>
                <KnowledgeGraphCanvas
                  forces={forces}
                  graph={graph}
                  label={KNOWLEDGE_LENSES.find((item) => item.kind === lens)?.title ?? "지도"}
                  onSelect={(nodeId) => {
                    setSelectedId(nodeId);
                  }}
                  selectedId={selectedId}
                />
              </MapBoundary>
            </div>
          ) : null}
        </div>
      </div>

      {selected && graph ? (
        <aside
          aria-label="노드 상세"
          className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome"
        >
          <header className="flex items-center gap-2 border-b border-border px-3">
            <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{selected.label}</h2>
            <button
              aria-label="상세 닫기"
              className="flex size-7 shrink-0 items-center justify-center rounded-[5px] text-muted outline-none hover:bg-surface-2 hover:text-primary"
              onClick={() => {
                setSelectedId(undefined);
              }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </header>
          <div className="min-h-0 space-y-4 overflow-y-auto px-3 py-3">
            <section>
              <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">
                {knowledgeNodeKindLabel[selected.kind]}
              </span>
              {selected.detail === undefined ? null : (
                <p className="mt-1.5 break-words font-mono text-[11px] text-muted">{selected.detail}</p>
              )}
              {/* 업무 노드는 실제로 그 업무로 갑니다. 지도가 막다른 길이 되지 않게. */}
              {selected.kind === "work" ? (
                <button
                  className="mt-2.5 w-full rounded-[5px] border border-control bg-raised px-3 py-1.5 text-[12px] font-medium text-primary hover:border-fg-3 hover:bg-surface"
                  onClick={() => {
                    onOpenWork(selected.nodeId.slice(selected.nodeId.indexOf(":") + 1));
                  }}
                  type="button"
                >
                  이 업무 열기
                </button>
              ) : null}
            </section>
            <KnowledgeLinkList
              links={links}
              onSelect={(node) => {
                setSelectedNode(node);
                setSelectedId(node.nodeId);
              }}
            />
          </div>
        </aside>
      ) : null}
    </main>
  );
}

/** 시트의 "무엇과 이어져 있나". 관계 종류별로 묶고, 누르면 그 노드로 옮겨갑니다. */
function KnowledgeLinkList({
  links,
  onSelect,
}: {
  links: readonly KnowledgeLinkView[];
  onSelect: (node: KnowledgeNodeView) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (links.length === 0) return <p className="text-[11px] text-muted">이어진 것이 없습니다.</p>;
  const groups = new Map<string, KnowledgeLinkView[]>();
  for (const link of links) {
    const label = knowledgeEdgeLabel[link.kind][link.direction];
    const bucket = groups.get(label) ?? [];
    // 같은 대상이 같은 관계로 여러 번 오면 한 줄로 묶습니다. 네 번 나오는데 왜 네 번인지 말할 수 없으면 소음입니다.
    if (bucket.some((existing) => existing.node.nodeId === link.node.nodeId)) continue;
    groups.set(label, [...bucket, link]);
  }
  return (
    <div className="space-y-3">
      {[...groups].map(([label, items]) => {
        const open = expanded.has(label);
        const shown = open ? items : items.slice(0, 8);
        return (
          <section key={label}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              {label} <span className="font-normal tabular-nums">{items.length}</span>
            </p>
            <ul className="mt-1 divide-y divide-border border-y border-border">
              {shown.map((link) => (
                <li key={`${label}-${link.node.nodeId}`}>
                  <button
                    aria-label={`${link.node.label}(으)로 이동`}
                    className="flex w-full items-center gap-2 py-2 text-left outline-none hover:text-primary"
                    onClick={() => {
                      onSelect(link.node);
                    }}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[12px] ${link.unresolved === true ? "text-fg-3" : "text-primary"}`}
                      >
                        {link.node.label}
                      </span>
                      {link.node.detail === undefined ? null : (
                        <span className="block truncate font-mono text-[10px] text-muted">{link.node.detail}</span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-[3px] border border-control px-1 text-[10px] text-muted">
                      {knowledgeNodeKindLabel[link.node.kind]}
                    </span>
                    <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={12} />
                  </button>
                </li>
              ))}
            </ul>
            {/* 잘린 것은 감추지 않고, 접었다 폈다 할 수 있게 둡니다(DESIGN.md). */}
            {items.length > 8 ? (
              <button
                aria-expanded={open}
                className="mt-1 flex items-center gap-1 text-[11px] text-muted outline-none hover:text-primary"
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(label)) next.delete(label);
                    else next.add(label);
                    return next;
                  });
                }}
                type="button"
              >
                <CaretDown
                  aria-hidden="true"
                  className={`transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
                  size={11}
                />
                {open ? "접기" : `더 보기 ${String(items.length - 8)}`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
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
      <h3 className="mb-2.5 text-[12px] font-semibold tracking-[0.01em] text-fg-3">{title}</h3>
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

/**
 * 설정에 남는 것은 «사람이 정한 경계»뿐입니다. 어느 모델이 도는지는 조직이 역할과 난이도로
 * 배치하고(ADR-003), 배치 결과는 프로바이더 표면이 말합니다. 여기서는 한도만 봅니다.
 */
function RouteBudgetRow({ route }: { route: ModelRouteView }) {
  const ratio = route.totalBudgetMicros > 0 ? Math.min(1, route.spentMicros / route.totalBudgetMicros) : undefined;
  return (
    <li className="py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">{route.name}</span>
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
          {route.totalBudgetMicros === 0
            ? "한도 없음"
            : `${costText(route.spentMicros)} / ${costText(route.totalBudgetMicros)}`}
        </span>
      </div>
      {/*
       * 트랙은 값이 없는 행에도 그립니다. 채워진 조각만 그리면 라벨 밑에 짧은 선 하나가 남아
       * 게이지가 아니라 입력 밑줄로 읽힙니다.
       */}
      <div className="mt-2 h-[3px] w-full rounded-full bg-surface-2">
        {ratio === undefined ? null : (
          // 막대는 데이터라 이징하지 않습니다. 중간 프레임이 실제 값과 달라집니다.
          <div
            className={`h-[3px] rounded-full transition-[width] duration-[250ms] ease-linear ${
              ratio >= 0.8 ? "bg-danger" : "bg-fg-3"
            }`}
            style={{ width: `${String(ratio * 100)}%` }}
          />
        )}
      </div>
    </li>
  );
}

/**
 * 자가개선 채택은 실행 자율성과 다른 축입니다. 실행은 「이 일을 사람 없이 해도 되나」이고
 * 자가개선은 「조직이 자기 프롬프트·기억·정책·조직을 사람 없이 고쳐도 되나」입니다.
 * 전체 권한은 둘 다 묻지 않겠다는 선언이므로 여기서 파생되고 따로 고를 수 없습니다.
 */
/**
 * 고른 것이 가장 밝아야 합니다. 전에는 «현재 값»을 disabled로 잠가서 고른 쪽이 제일 흐렸습니다 —
 * 상태 표시와 조작 불가 표시가 같은 시각 신호를 쓰면 읽는 사람이 정확히 반대로 읽습니다.
 */
function ChoiceGroup<T extends string>({
  busy = false,
  locked,
  onSelect,
  options,
  value,
}: {
  busy?: boolean;
  locked?: string;
  onSelect?: (value: T) => void;
  options: readonly { value: T; label: string }[];
  value: T | undefined;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div className="inline-flex gap-0.5 rounded-[5px] border border-border p-0.5">
        {options.map((option) => {
          const active = option.value === value;
          const frozen = onSelect === undefined || busy;
          return (
            <button
              aria-pressed={active}
              className={`rounded-[4px] px-3 py-1 text-[12px] transition-colors duration-150 ${
                active ? "bg-surface-2 text-primary" : "text-muted"
              } ${frozen ? "cursor-default" : "hover:text-secondary"}`}
              disabled={frozen}
              key={option.value}
              onClick={() => {
                onSelect?.(option.value);
              }}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {locked === undefined ? null : <span className="text-[11px] text-muted">{locked}</span>}
    </div>
  );
}

const AUTONOMY_OPTIONS = [
  { value: "automatic", label: "자동" },
  { value: "review", label: "수동" },
  { value: "full-access", label: "바이패스" },
] as const;

const GROWTH_OPTIONS = [
  { value: "review", label: "수동" },
  { value: "auto", label: "자동" },
] as const;

function GrowthAdoptionBoundary({
  autonomy,
  onSelect,
}: {
  autonomy: AutonomyView;
  onSelect: (mode: GrowthAdoptionMode) => void;
}) {
  const derived = autonomy.mode === "full-access";
  const mode = effectiveGrowthMode(autonomy);
  return (
    <GrowthSection title="자가개선">
      <ChoiceGroup
        options={GROWTH_OPTIONS}
        value={mode}
        {...(derived ? { locked: "전체 권한이라 자동으로 고정됩니다" } : { onSelect })}
      />
    </GrowthSection>
  );
}

/** 라벨 축과 값 축 둘만 씁니다. 정렬선이 늘어나면 눈이 매 줄 자리를 다시 찾습니다. */
function ProviderField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-3 py-1.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-secondary">{children}</dd>
    </div>
  );
}

const PROVIDER_ADAPTERS = [
  { value: "openai-compatible", label: "OpenAI 호환" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "subscription-connector", label: "구독 커넥터" },
] as const;

/**
 * 사람이 대는 것은 넷뿐입니다 — 이름·어댑터·주소·키. 나머지(내부 id, endpoint 이름, 자격 종류,
 * 로컬 여부)는 도출합니다. 키는 선택입니다: 지금 없어도 등록하고 나중에 더할 수 있습니다.
 */
function ProviderAddForm({
  draft,
  saving,
  secret,
  setDraft,
  setSecret,
  submit,
}: {
  draft: { displayName: string; adapterKind: string; baseUrl: string };
  saving: boolean;
  secret: string;
  setDraft: (next: { displayName: string; adapterKind: string; baseUrl: string }) => void;
  setSecret: (value: string) => void;
  submit: (event: React.SyntheticEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form
      aria-label="프로바이더 추가"
      className="grid gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label className="grid gap-1.5">
        <span className="text-[12px] text-muted">이름</span>
        <input
          className="rounded-[4px] border border-border bg-canvas px-2.5 py-1.5 text-[13px] text-secondary outline-none placeholder:text-muted focus-visible:border-fg-3"
          onChange={(event) => {
            setDraft({ ...draft, displayName: event.target.value });
          }}
          placeholder="OpenRouter"
          value={draft.displayName}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-[12px] text-muted">어댑터</span>
        <select
          className="rounded-[4px] border border-border bg-canvas px-2.5 py-1.5 text-[13px] text-secondary outline-none focus-visible:border-fg-3"
          onChange={(event) => {
            setDraft({ ...draft, adapterKind: event.target.value });
          }}
          value={draft.adapterKind}
        >
          {PROVIDER_ADAPTERS.map((adapter) => (
            <option key={adapter.value} value={adapter.value}>
              {adapter.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5">
        <span className="text-[12px] text-muted">Base URL</span>
        <input
          className="rounded-[4px] border border-border bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-secondary outline-none placeholder:text-muted focus-visible:border-fg-3"
          onChange={(event) => {
            setDraft({ ...draft, baseUrl: event.target.value });
          }}
          placeholder="https://openrouter.ai/api/v1"
          value={draft.baseUrl}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="flex items-baseline gap-1.5 text-[12px] text-muted">
          키<span className="text-[11px]">선택 · 나중에 더할 수 있습니다</span>
        </span>
        <input
          autoComplete="off"
          className="rounded-[4px] border border-border bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-secondary outline-none placeholder:text-muted focus-visible:border-fg-3"
          onChange={(event) => {
            setSecret(event.target.value);
          }}
          type="password"
          value={secret}
        />
      </label>
      <div className="flex justify-end">
        <button
          className="rounded-[4px] border border-control px-3 py-1.5 text-[13px] text-secondary transition-colors duration-150 hover:border-fg-3 hover:text-primary disabled:opacity-50"
          disabled={saving || !draft.displayName.trim() || !draft.baseUrl.trim()}
          type="submit"
        >
          추가
        </button>
      </div>
    </form>
  );
}

function ProviderSurface({ service }: { service: DesktopService }) {
  const [settings, setSettings] = useState<SettingsView>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);
  /*
   * 모델 켜고 끄기는 화면이 먼저 세웁니다. 계약에 model.enable 명령이 아직 없어 이 회차는
   * 화면 상태로만 남습니다. 인계: docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md
   */
  const [disabledModels, setDisabledModels] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState("");
  const [draft, setDraft] = useState({ displayName: "", adapterKind: "openai-compatible", baseUrl: "" });

  useEffect(() => {
    let disposed = false;
    void service
      .loadSettings()
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(surfaceErrorMessage(cause, "프로바이더를 불러오지 못했습니다."));
      });
    return () => {
      disposed = true;
    };
  }, [service]);

  const submitProvider = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    /*
     * 사람이 대는 것은 이름·어댑터·주소·키 넷뿐입니다. 나머지는 도출합니다 —
     * 내부 식별자를 사람이 입력하게 하지 않는다는 규칙(DESIGN.md)입니다.
     */
    const providerId = draft.displayName
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
    if (!providerId) {
      setError("프로바이더 이름이 필요합니다.");
      return;
    }
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/u.test(draft.baseUrl.trim());
    const submittedSecret = secret;
    setSecret("");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await service.registerProvider({
        providerId,
        displayName: draft.displayName.trim(),
        adapterKind: draft.adapterKind,
      });
      await service.registerEndpoint({ providerId, name: "api", baseUrl: draft.baseUrl.trim(), local });
      if (submittedSecret.trim()) {
        const refreshed = await service.loadSettings();
        const endpointId = endpointIdFor(refreshed.catalog, providerId, "api", draft.baseUrl.trim());
        if (!endpointId) throw new Error("생성된 endpoint를 확인하지 못했습니다.");
        await service.addCredential({
          providerId,
          endpointId,
          label: "기본 키",
          credentialType: "api_key",
          secret: submittedSecret,
          priority: 0,
          weight: 100,
        });
      }
      setSettings(await service.loadSettings());
      setSelectedId(providerId);
      setAddOpen(false);
      setDraft({ displayName: "", adapterKind: "openai-compatible", baseUrl: "" });
      setNotice("프로바이더를 추가했습니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "프로바이더를 추가하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  };

  const connections = settings ? projectProviderConnections(settings.catalog) : [];
  const accounts = settings ? projectSubscriptionAccounts(settings.accounts) : [];
  const matched = connections.filter(
    (connection) =>
      query.trim() === "" ||
      connection.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
      connection.providerId.includes(query.trim().toLocaleLowerCase()),
  );
  // 그룹은 사용자가 켜고 끈 것으로만 가릅니다. 회로 상태는 분류가 아니라 그 항목의 상태입니다.
  const groups = [
    { title: "준비됨", items: matched.filter((connection) => connection.enabled) },
    { title: "비활성", items: matched.filter((connection) => !connection.enabled) },
  ].filter((group) => group.items.length > 0);
  const selected = matched.find((connection) => connection.providerId === selectedId) ?? matched[0];

  return (
    <main
      aria-label="프로바이더 표면"
      className="col-span-3 grid min-h-0 min-w-0 grid-cols-[242px_minmax(0,1fr)_300px] bg-canvas min-[1440px]:grid-cols-[264px_minmax(0,1fr)_332px]"
    >
      <section className="grid min-h-0 grid-rows-[46px_auto_minmax(0,1fr)_auto] border-r border-border bg-chrome">
        <header className="flex items-center px-3">
          <h1 className="text-[15px] font-semibold tracking-[-0.008em]">프로바이더</h1>
        </header>
        <div className="px-2 pb-2">
          <input
            aria-label="프로바이더 검색"
            className="w-full rounded-[4px] border border-border bg-canvas px-2.5 py-1.5 text-[13px] text-secondary outline-none placeholder:text-muted focus-visible:border-fg-3"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="프로바이더 검색"
            value={query}
          />
        </div>
        <nav className="min-h-0 overflow-y-auto px-2 pb-2">
          {groups.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-muted">
              {connections.length === 0 ? "연결된 프로바이더가 없습니다." : "검색과 맞는 것이 없습니다."}
            </p>
          ) : (
            groups.map((group) => (
              <div className="mb-3 last:mb-0" key={group.title}>
                <div className="mb-1 border-b border-border px-2.5 pb-1.5">
                  <span className="text-[11px] text-muted">{group.title}</span>
                </div>
                <ul>
                  {group.items.map((connection) => (
                    <li key={connection.providerId}>
                      <button
                        aria-current={connection.providerId === selected?.providerId ? "true" : undefined}
                        /* 선택은 채움만으로는 약합니다. 참고 화면처럼 테두리까지 세워 카드로 서게 합니다. */
                        className={`flex w-full items-center gap-2.5 rounded-[4px] border px-2.5 py-2 text-left outline-none transition-colors duration-150 ${
                          connection.providerId === selected?.providerId
                            ? "border-control bg-[rgb(255_255_255/0.047)]"
                            : "border-transparent hover:bg-[rgb(255_255_255/0.027)]"
                        }`}
                        onClick={() => {
                          setSelectedId(connection.providerId);
                        }}
                        type="button"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-secondary">{connection.displayName}</span>
                          <span className="block text-[11px] text-muted">
                            모델 <span className="tabular-nums">{connection.models.length}</span>개
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </nav>
        <div className="border-t border-border p-2">
          <button
            className="w-full rounded-[4px] border border-control px-2.5 py-1.5 text-[13px] text-secondary transition-colors duration-150 hover:border-fg-3 hover:text-primary"
            onClick={() => {
              setAddOpen((open) => !open);
            }}
            type="button"
          >
            프로바이더 추가
          </button>
        </div>
      </section>

      <div className="grid min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)]">
        <header className="flex items-center gap-3 border-b border-border px-5">
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.008em] text-primary">
            {selected?.displayName ?? "프로바이더"}
          </h2>
          {selected ? (
            <span className="shrink-0 text-[11px] text-muted">{selected.enabled ? "활성" : "비활성"}</span>
          ) : null}
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {error ? <p className="mb-3 text-[12px] text-danger">{error}</p> : null}
          {settings === undefined ? (
            <SurfaceLoading />
          ) : selected === undefined ? (
            <p className="text-[12px] text-muted">
              프로바이더를 연결하면 조직이 모델을 쓸 수 있습니다. 연결 전에는 조회·승인·기록만 동작합니다.
            </p>
          ) : (
            <>
              <ProviderOverviewTab accounts={accounts} connection={selected} />
            </>
          )}
          {notice ? <p className="mt-4 text-[12px] text-gate">{notice}</p> : null}
        </div>
      </div>

      <aside className="grid min-h-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome">
        <header className="flex items-baseline gap-2 px-3">
          <h2 className="text-[13px] text-muted">모델</h2>
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {selected === undefined
              ? 0
              : selected.models.filter((model) => !disabledModels.has(model.modelProfileId)).length}
            /{selected?.models.length ?? 0}
          </span>
          {selected === undefined || selected.models.length === 0 ? null : (
            <span className="ml-auto flex gap-1">
              <button
                className="rounded-[4px] border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-150 hover:border-control hover:text-secondary"
                onClick={() => {
                  setDisabledModels(new Set());
                }}
                type="button"
              >
                모두 켜기
              </button>
              <button
                className="rounded-[4px] border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-150 hover:border-control hover:text-secondary"
                onClick={() => {
                  setDisabledModels(new Set(selected.models.map((model) => model.modelProfileId)));
                }}
                type="button"
              >
                모두 끄기
              </button>
            </span>
          )}
        </header>
        <div className="min-h-0 overflow-y-auto px-2 pb-3">
          {selected === undefined ? null : (
            <ProviderModelList
              connection={selected}
              disabled={disabledModels}
              onToggle={(id) => {
                setDisabledModels((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
            />
          )}
        </div>
      </aside>

      {/* 자격 증명 입력은 보호된 포커스가 필요한 작업이라 모달입니다. 보던 프로바이더를 밀어내지 않습니다. */}
      <Dialog onOpenChange={setAddOpen} open={addOpen}>
        <DialogContent aria-label="프로바이더 추가" className="w-[520px]">
          <div className="grid max-h-[80vh] min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <header className="flex items-start gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-[17px] font-semibold tracking-[-0.012em]">프로바이더 추가</DialogTitle>
                <DialogDescription className="mt-1 text-[12px] leading-5 text-muted">
                  저장한 자격 증명은 화면에 다시 표시되지 않습니다.
                </DialogDescription>
              </div>
              <DialogClose
                aria-label="닫기"
                className="shrink-0 rounded-[4px] p-1 text-muted outline-none hover:text-primary"
              >
                <X aria-hidden="true" size={15} />
              </DialogClose>
            </header>
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <ProviderAddForm
                draft={draft}
                saving={saving}
                secret={secret}
                setDraft={setDraft}
                setSecret={setSecret}
                submit={submitProvider}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

/** 열3. 이 프로바이더가 제공하는 모델 전부. 목록이라 열 하나를 온전히 씁니다. */
function ProviderModelList({
  connection,
  disabled,
  onToggle,
}: {
  connection: ProviderConnectionView;
  disabled: ReadonlySet<string>;
  onToggle: (modelProfileId: string) => void;
}) {
  if (connection.models.length === 0)
    return <p className="px-1 py-2 text-[12px] text-muted">등록된 모델이 없습니다.</p>;
  return (
    <ul>
      {connection.models.map((model) => {
        const on = !disabled.has(model.modelProfileId);
        return (
          <li key={model.modelProfileId}>
            <button
              aria-pressed={on}
              className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-[rgb(255_255_255/0.027)]"
              onClick={() => {
                onToggle(model.modelProfileId);
              }}
              type="button"
            >
              {/* 초록을 쓰지 않으므로 켜짐은 밝은 손잡이, 꺼짐은 가라앉은 트랙으로 가릅니다. */}
              <span
                className={`relative h-3 w-6 shrink-0 rounded-full transition-colors duration-150 ${
                  on ? "bg-control" : "bg-border"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-2 w-2 rounded-full transition-all duration-150 ${
                    on ? "left-3.5 bg-fg" : "left-0.5 bg-fg-3"
                  }`}
                />
              </span>
              <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${on ? "text-secondary" : "text-muted"}`}>
                {model.modelId}
              </span>
              {model.verified ? null : <span className="shrink-0 text-[11px] text-muted">미확인</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ProviderOverviewTab({
  accounts,
  connection,
}: {
  accounts: readonly SubscriptionAccountView[];
  connection: ProviderConnectionView;
}) {
  const mine = accounts.filter((account) => account.providerId.startsWith(connection.providerId));
  // 구독 커넥터는 계정을 갖고, API 어댑터는 키를 갖습니다. 없는 쪽을 빈 목록으로 보이면 잘못된 인상을 줍니다.
  const usesAccounts = connection.adapterKind === "subscription-connector";
  return (
    <>
      <section className="mb-6">
        <h3 className="mb-2 text-[13px] text-muted">연결</h3>
        <dl>
          {connection.endpoints.map((endpoint) => (
            <ProviderField key={endpoint.baseUrl} label="Base URL">
              <span className="font-mono text-[12px]">{endpoint.baseUrl}</span>
              <span className="ml-2 text-[11px] text-muted">{endpoint.local ? "이 컴퓨터" : "외부"}</span>
            </ProviderField>
          ))}
          <ProviderField label="인증">
            {connection.credentialVersion === undefined ? (
              <span className="text-muted">등록되지 않았습니다</span>
            ) : (
              <span>
                {usesAccounts ? "구독 로그인" : "API 키"}
                <span className="ml-2 font-mono text-[11px] tabular-nums text-muted">
                  v{connection.credentialVersion}
                </span>
              </span>
            )}
          </ProviderField>
          <ProviderField label="어댑터">
            <span className="font-mono text-[12px]">{connection.adapterKind}</span>
          </ProviderField>
        </dl>
      </section>

      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-[13px] text-muted">{usesAccounts ? "계정" : "API 키"}</h3>
          <span className="font-mono text-[11px] tabular-nums text-muted">{mine.length}</span>
        </div>
        {mine.length === 0 ? (
          <div className="rounded-[4px] border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[12px] text-muted">
              {usesAccounts ? "연결된 계정이 없습니다." : "등록된 키가 없습니다."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {mine.map((account) => (
              <AccountCard account={account} key={account.accountId} />
            ))}
          </ul>
        )}
        <button
          className="mt-2 w-full rounded-[4px] border border-control px-3 py-1.5 text-[12px] text-secondary transition-colors duration-150 hover:border-fg-3 hover:text-primary"
          type="button"
        >
          {usesAccounts ? "계정 추가" : "API 키 추가"}
        </button>
      </section>
    </>
  );
}

/**
 * 계정 하나. 남은 양이 아니라 «쓴 양»을 먼저 말합니다 — 사용자가 묻는 것은 얼마나 썼나입니다.
 * 막대는 데이터라 이징하지 않습니다.
 */
function AccountCard({ account }: { account: SubscriptionAccountView }) {
  const used = account.minimumRemainingRatio === undefined ? undefined : 1 - account.minimumRemainingRatio;
  return (
    <li className="rounded-[4px] border border-border px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[11px]">
          {account.quotaExhausted === true ? (
            <span className="text-danger">⊘</span>
          ) : (
            <span className="text-muted">●</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">{account.alias}</span>
        <span className="shrink-0 text-[11px] text-muted">{account.billingKind}</span>
      </div>
      {used === undefined ? (
        <p className="mt-1.5 text-[11px] text-muted">사용량을 아직 모릅니다.</p>
      ) : (
        <>
          <div className="mt-2 h-px w-full bg-border">
            <div
              className={`h-px transition-[width] duration-[250ms] ease-linear ${used >= 0.8 ? "bg-danger" : "bg-fg-3"}`}
              style={{ width: `${String(Math.round(used * 100))}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 text-[11px] text-muted">
            <span className="font-mono tabular-nums">{Math.round(used * 100)}% 사용</span>
            {account.earliestResetAt === undefined ? null : (
              <>
                <span>·</span>
                <span className="font-mono">{account.earliestResetAt.slice(5, 16).replace("T", " ")} 리셋</span>
              </>
            )}
            {account.cooldownUntil === undefined ? null : (
              <>
                <span>·</span>
                <span className="font-mono text-danger">{account.cooldownUntil.slice(11, 16)}까지 쿨다운</span>
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function SettingsSurface({ service }: { service: DesktopService }) {
  const [settings, setSettings] = useState<SettingsView>();
  const [autonomy, setAutonomy] = useState<AutonomyView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [autonomySaving, setAutonomySaving] = useState(false);
  const [fullAccessPending, setFullAccessPending] = useState(false);
  /*
   * 자가개선 채택은 실행 자율성과 다른 축이라 따로 고를 수 있어야 합니다. 쓰는 명령이 아직
   * 계약에 없어 화면이 앞세웁니다. 인계: docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md
   */
  const [growthModeOverride, setGrowthModeOverride] = useState<GrowthAdoptionMode>();
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
      setNotice("권한을 저장했습니다.");
    } catch (cause) {
      setError(surfaceErrorMessage(cause, "자율성 경계를 변경하지 못했습니다."));
    } finally {
      setAutonomySaving(false);
    }
  };

  const routes = settings ? projectModelRoutes(settings.routes, settings.catalog) : [];

  return (
    <main aria-label="설정" className="col-span-3 grid min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)] bg-canvas">
      <header className="flex items-center border-b border-border px-5">
        <h1 className="text-[15px] font-semibold tracking-[-0.008em] text-primary">설정</h1>
      </header>
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {error ? <SurfaceError message={error} /> : null}
        {!settings && !error ? <SurfaceLoading /> : null}
        {settings ? (
          <div className="mx-auto max-w-[76ch] pb-8">
            <GrowthSection title="예산">
              {routes.length === 0 ? (
                <p className="text-[12px] text-muted">구성된 모델 경로가 없습니다. 프로바이더를 먼저 연결하십시오.</p>
              ) : (
                <ul className="divide-y divide-border border-y border-border">
                  {routes.map((route) => (
                    <RouteBudgetRow key={route.routeId} route={route} />
                  ))}
                </ul>
              )}
            </GrowthSection>

            {autonomy ? (
              <section aria-label="권한과 자가개선">
                <GrowthSection title="권한">
                  {fullAccessPending ? (
                    <div className="mt-3 rounded-[5px] border border-halt/40 bg-surface-1 p-3" role="alert">
                      <p className="text-[12px] leading-5 text-primary">
                        승인 없이 파일·명령·네트워크·계정을 씁니다. 책임은 사용자에게 있습니다.
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-[5px] border border-border px-3 py-1 text-[12px] text-secondary"
                          onClick={() => {
                            setFullAccessPending(false);
                          }}
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
                          바이패스
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <ChoiceGroup
                    busy={autonomySaving}
                    onSelect={(mode: AutonomyView["mode"]) => {
                      void setAutonomyMode(mode);
                    }}
                    options={AUTONOMY_OPTIONS}
                    value={autonomy.mode}
                  />
                  {/* 고른 값과 실제로 걸린 값이 다를 때만 말합니다. 같으면 위 그룹이 이미 말했습니다. */}
                  {autonomy.emergencyStopActive || autonomy.permissionLimitReason !== undefined ? (
                    <p className="mt-2 text-[11px] text-gate">
                      {autonomy.emergencyStopActive ? "긴급 정지로 제한됨" : "제한됨"}
                      {autonomy.permissionLimitReason === undefined ? "" : ` · ${autonomy.permissionLimitReason}`}
                    </p>
                  ) : null}
                </GrowthSection>
                <GrowthAdoptionBoundary
                  autonomy={
                    growthModeOverride === undefined ? autonomy : { ...autonomy, growthMode: growthModeOverride }
                  }
                  onSelect={setGrowthModeOverride}
                />
              </section>
            ) : null}

            {notice ? <p className="text-[12px] text-gate">{notice}</p> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function costText(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
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
  onSetAutonomy: (mode: WorkAutonomyMode) => void;
  models: readonly string[];
  onSubmitDirective: (mode: "now" | "next-stage", content?: string) => void;
}

function WorkActivity({
  announcement,
  approvalDecisions,
  composer,
  detailLoading,
  models,
  executionNotice,
  onAnnouncement,
  onComposerChange,
  onControlRun,
  onDecideApproval,
  onSetAutonomy,
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
  // 방이 있으면 대화는 방이 정본입니다. 없으면 Work의 활동 타임라인이 계속 나옵니다.
  const activities = room ? room.activities : work.activities;
  const lastModelId = room?.activities.findLast((item) => item.kind === "room")?.speaker.modelId;
  /*
   * 모델·추론 수준·대기 지시는 이 Work에만 겁니다. 도메인이 아직 셋 다 돌려주지 않아 화면이 앞세웁니다.
   * 인계: docs/phases/30-surface-parity-agent-ux/settings-contract-handoff.md
   */
  const [modelOverride, setModelOverride] = useState<string>();
  const [effortOverride, setEffortOverride] = useState<ReasoningEffort>();
  const [queuedOverride, setQueuedOverride] = useState<QueuedDirectiveView[]>();
  useEffect(() => {
    setModelOverride(undefined);
    setEffortOverride(undefined);
    setQueuedOverride(undefined);
  }, [work.id]);
  const modelId = modelOverride ?? work.modelId ?? lastModelId;
  const effort = effortOverride ?? work.reasoningEffort ?? "medium";
  const queued = queuedOverride ?? work.queuedDirectives ?? [];
  const setModelId = setModelOverride;
  const setEffort = setEffortOverride;
  const setQueued = setQueuedOverride;
  /* 권한은 이 Work에만 겁니다. 계약이 열릴 때까지 화면 상태로 둡니다. */
  const cycleAutonomy = () => {
    const order: WorkAutonomyMode[] = ["automatic", "review", "full-access"];
    const next = order[(order.indexOf(work.autonomyMode ?? "automatic") + 1) % order.length] ?? "automatic";
    onAnnouncement(`이 업무 권한을 ${AUTONOMY_LABEL[next]}(으)로 바꿨습니다.`);
    onSetAutonomy(next);
  };

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
          {work.run ? (
            <RunStatusCard onControlRun={onControlRun} pendingRunAction={pendingRunAction} run={work.run} />
          ) : null}
        </div>
      </section>
      <Composer
        announcement={announcement}
        autonomyMode={work.autonomyMode ?? "automatic"}
        effort={effort}
        models={models}
        onAnnouncement={onAnnouncement}
        onApplyQueued={(id) => {
          const directive = queued.find((item) => item.id === id);
          if (directive === undefined) return;
          setQueued(queued.filter((item) => item.id !== id));
          onSubmitDirective("now", directive.content);
        }}
        onAutonomyCycle={() => {
          cycleAutonomy();
        }}
        onChange={onComposerChange}
        onDropQueued={(id) => {
          setQueued(queued.filter((item) => item.id !== id));
        }}
        onEffortChange={setEffort}
        onModelChange={setModelId}
        onStop={() => {
          onControlRun("cancel");
        }}
        onSubmit={() => {
          const content = composer.trim();
          if (!content) return;
          setQueued([...queued, { id: `queued-${String(queued.length)}-${content.slice(0, 12)}`, content }]);
          onSubmitDirective("next-stage");
        }}
        pending={pendingDirective}
        queued={queued}
        running={work.run?.status === "running" || work.run?.status === "ready"}
        value={composer}
        {...(modelId === undefined ? {} : { modelId })}
        {...(work.workspace === undefined ? {} : { workspace: work.workspace })}
      />
    </main>
  );
}

const runStageLabel: Record<string, string> = {
  intake: "요청 접수",
  "context-strategy": "맥락·전략 구성",
  evidence: "근거 확인",
  delivery: "실행",
  assurance: "검증",
  records: "결과 기록",
  terminal: "완료 정리",
};

function runStageText(stage: string): string {
  return runStageLabel[stage] ?? stage;
}

function blockedReasonText(reason: string | undefined): string {
  switch (reason) {
    case "context-strategy-stage-failed":
    case "strategy-failed":
      return "Provider가 전략 계획의 구조화 응답을 완성하지 못했습니다.";
    case "model-unavailable":
      return "사용 가능한 Provider 모델을 찾지 못했습니다.";
    case "evidence-invalid":
      return "업무에 연결된 근거를 검증하지 못했습니다.";
    case "workspace-untrusted":
      return "워크스페이스 신뢰 확인이 필요합니다.";
    default:
      return "실행 단계에서 오류가 발생했습니다.";
  }
}

/**
 * 실행 상태는 스트림 «안»에 놓습니다. 상단 배너로 빼면 대화의 어느 시점에 멈췄는지가 사라지고,
 * 재개 버튼이 원인 설명에서 멀어져 "상단의 무엇을 누르라"는 안내가 필요해집니다.
 */
function RunStatusCard({
  onControlRun,
  pendingRunAction,
  run,
}: {
  onControlRun: (action: "cancel" | "resume") => void;
  pendingRunAction: "cancel" | "resume" | undefined;
  run: NonNullable<WorkView["run"]>;
}) {
  const blocked = run.status === "blocked";
  const awaitingApproval = run.status === "awaiting-approval";
  const active = ["ready", "running"].includes(run.status);
  if (!blocked && !awaitingApproval && !active) return null;

  if (blocked) {
    return (
      <div aria-label="실행 상태" className="my-2 rounded-[4px] border border-danger/40 px-3 py-2.5" role="status">
        <div className="flex items-start gap-2.5">
          <WarningCircle aria-hidden="true" className="mt-0.5 shrink-0 text-danger" size={16} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-danger">{blockedReasonText(run.blockedReason)}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {runStageText(run.stage)}에서 멈춤
              {run.blockedReason ? <span className="ml-1.5 font-mono">{run.blockedReason}</span> : null}
            </p>
          </div>
          <button
            className="shrink-0 rounded-[4px] border border-control px-2.5 py-1 text-[12px] text-secondary transition-colors duration-150 hover:border-fg-3 hover:text-primary disabled:opacity-50"
            disabled={pendingRunAction !== undefined}
            onClick={() => {
              onControlRun("resume");
            }}
            type="button"
          >
            {pendingRunAction === "resume" ? "재개 중" : "다시 시도"}
          </button>
        </div>
      </div>
    );
  }

  if (awaitingApproval) {
    return (
      <div
        aria-label="실행 상태"
        className="my-2 flex items-center gap-2.5 rounded-[4px] border border-gate/40 px-3 py-2.5"
        role="status"
      >
        <ShieldCheck aria-hidden="true" className="shrink-0 text-gate" size={16} />
        <p className="min-w-0 flex-1 text-[13px] text-gate">수신함에서 결정하면 다음 단계로 진행합니다</p>
      </div>
    );
  }

  return (
    <div aria-label="실행 상태" className="my-2 flex items-center gap-2.5 px-1 py-1" role="status">
      <span className="text-[11px] text-muted">{runStageText(run.stage)} 진행 중</span>
      <button
        className="ml-auto shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] text-muted outline-none transition-colors duration-150 hover:text-danger disabled:opacity-50"
        disabled={pendingRunAction !== undefined}
        onClick={() => {
          onControlRun("cancel");
        }}
        type="button"
      >
        {pendingRunAction === "cancel" ? "중단 중" : "중단"}
      </button>
    </div>
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

const AUTONOMY_LABEL: Record<WorkAutonomyMode, string> = {
  automatic: "자동",
  review: "수동",
  "full-access": "바이패스",
};

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "낮음", medium: "보통", high: "높음" };

interface ComposerProps {
  autonomyMode: WorkAutonomyMode;
  effort: ReasoningEffort;
  modelId?: string;
  models: readonly string[];
  queued: readonly QueuedDirectiveView[];
  value: string;
  announcement: string;
  pending: boolean;
  running: boolean;
  workspace?: { name: string; trusted: boolean };
  onAutonomyCycle: () => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onModelChange: (modelId: string) => void;
  onApplyQueued: (id: string) => void;
  onDropQueued: (id: string) => void;
  onChange: (value: string) => void;
  onAnnouncement: (message: string) => void;
  onStop: () => void;
  onSubmit: () => void;
}

/**
 * 인풋은 «이 요청이 어떤 조건으로 나가는가»를 함께 말합니다. 권한·모델·추론 수준이 여기 없으면
 * 사용자는 보낸 뒤에야 조건을 알게 됩니다.
 *
 * 보내기 «전에» 반영 시점을 고르게 하지 않습니다. 보내면 위에 카드로 서고, 무엇이 대기 중인지
 * 보이는 상태에서 「현재 작업 조정」을 고릅니다 — Codex가 같은 자리에 두는 순서입니다.
 */
function Composer({
  announcement,
  autonomyMode,
  effort,
  modelId,
  models,
  onAnnouncement,
  onApplyQueued,
  onAutonomyCycle,
  onChange,
  onDropQueued,
  onEffortChange,
  onModelChange,
  onStop,
  onSubmit,
  pending,
  queued,
  running,
  value,
  workspace,
}: ComposerProps) {
  const fullAccess = autonomyMode === "full-access";
  const selectClass =
    "cursor-pointer rounded-[4px] border border-transparent bg-transparent py-0.5 pl-1.5 pr-0.5 text-[11px] text-muted outline-none transition-colors duration-150 hover:border-border hover:text-secondary focus-visible:border-fg-3";
  return (
    <div className="border-t border-border bg-canvas px-5 pb-4 pt-3" data-testid="directive-composer">
      <div className="mx-auto max-w-[860px]">
        {/* 아직 반영되지 않은 지시. 인풋 위에 서서 처리 시점을 고르게 합니다. */}
        {queued.map((directive) => (
          <div
            className="mb-1.5 flex items-center gap-2 rounded-[4px] border border-border bg-surface-1 px-2.5 py-1.5"
            key={directive.id}
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">{directive.content}</span>
            <button
              className="inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted outline-none transition-colors duration-150 hover:text-primary"
              onClick={() => {
                onApplyQueued(directive.id);
              }}
              type="button"
            >
              <ArrowBendDownRight aria-hidden="true" size={12} />
              현재 작업 조정
            </button>
            <button
              aria-label="대기 지시 삭제"
              className="shrink-0 rounded-[4px] p-0.5 text-muted outline-none transition-colors duration-150 hover:text-danger"
              onClick={() => {
                onDropQueued(directive.id);
              }}
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </button>
          </div>
        ))}
        {/* 문맥 칩. 이 요청이 어느 워크스페이스에서 도는지가 보내기 전에 보여야 합니다. */}
        {workspace === undefined ? null : (
          <div className="mb-2 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-muted">
              <Database aria-hidden="true" size={12} />
              {workspace.name}
            </span>
            {workspace.trusted ? null : (
              <span className="rounded-[4px] border border-gate/40 px-2 py-0.5 text-[11px] text-gate">신뢰 안 됨</span>
            )}
          </div>
        )}
        <div className="rounded-[4px] border border-control bg-surface-1 focus-within:border-fg-3">
          <label className="sr-only" htmlFor="directive">
            추가 지시
          </label>
          <Textarea
            aria-label="추가 지시"
            className="border-0 bg-transparent px-3 pt-3"
            id="directive"
            onChange={(event) => {
              onChange(event.target.value);
            }}
            placeholder="무엇이든 요청하세요"
            value={value}
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <button
              aria-label="파일 첨부"
              className="rounded-[4px] p-1 text-muted outline-none transition-colors duration-150 hover:text-primary"
              onClick={() => {
                onAnnouncement("파일 첨부 준비가 되었습니다.");
              }}
              type="button"
            >
              <Paperclip aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="에이전트 멘션"
              className="rounded-[4px] p-1 text-muted outline-none transition-colors duration-150 hover:text-primary"
              onClick={() => {
                onAnnouncement("멘션할 에이전트를 선택하세요.");
              }}
              type="button"
            >
              <At aria-hidden="true" size={16} />
            </button>
            {/*
             * 권한은 보내기 전에 보이고 그 자리에서 바뀌어야 합니다. 전체 권한만 색을 갖습니다 —
             * 승인과 샌드박스를 우회하는 상태라 안 보면 안 되는 종류입니다.
             */}
            <button
              className={`ml-1 rounded-[4px] border px-2 py-0.5 text-[11px] outline-none transition-colors duration-150 ${
                fullAccess
                  ? "border-gate/50 text-gate"
                  : "border-transparent text-muted hover:border-border hover:text-secondary"
              }`}
              onClick={onAutonomyCycle}
              title="이 업무에만 적용됩니다"
              type="button"
            >
              {AUTONOMY_LABEL[autonomyMode]}
            </button>
            <div className="ml-auto flex items-center gap-1">
              {/* 모델과 추론 수준은 다른 축입니다. 같은 모델을 더 오래 생각하게 할 수 있습니다. */}
              <select
                aria-label="모델"
                className={`${selectClass} font-mono`}
                onChange={(event) => {
                  onModelChange(event.target.value);
                }}
                value={modelId ?? ""}
              >
                {modelId === undefined || models.includes(modelId) ? null : <option value={modelId}>{modelId}</option>}
                {models.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
              <select
                aria-label="추론 수준"
                className={selectClass}
                onChange={(event) => {
                  onEffortChange(event.target.value as ReasoningEffort);
                }}
                value={effort}
              >
                {(["low", "medium", "high"] as const).map((level) => (
                  <option key={level} value={level}>
                    {EFFORT_LABEL[level]}
                  </option>
                ))}
              </select>
              {/* 실행 중에도 지시는 대기열에 들어갑니다. 중단은 보내기를 대체하지 않습니다. */}
              {running ? (
                <button
                  className="ml-1 rounded-[4px] px-2 py-1 text-[12px] text-muted outline-none transition-colors duration-150 hover:text-danger"
                  onClick={onStop}
                  type="button"
                >
                  중단
                </button>
              ) : null}
              <button
                aria-label="보내기"
                className="ml-1 grid size-7 place-items-center rounded-full bg-fg text-canvas outline-none transition-opacity duration-150 hover:opacity-80 disabled:opacity-40"
                disabled={!value.trim() || pending}
                onClick={onSubmit}
                type="button"
              >
                <ArrowRight aria-hidden="true" size={14} />
              </button>
            </div>
          </div>
        </div>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="mt-1.5 min-h-4 text-right text-[11px] text-muted"
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

function WorkInspector({
  room,
  service,
  work,
}: {
  room: RoomView | undefined;
  service: DesktopService;
  work: WorkView;
}) {
  const [tab, setTab] = useState("work");
  const [knowledge, setKnowledge] = useState<WorkKnowledgeViewV1>();
  const [knowledgeError, setKnowledgeError] = useState("");

  useEffect(() => {
    if (tab !== "knowledge") return;
    let disposed = false;
    setKnowledge(undefined);
    setKnowledgeError("");
    void service.loadWorkKnowledge(work.id).then(
      (value) => {
        if (!disposed) setKnowledge(value);
      },
      (cause: unknown) => {
        if (!disposed) setKnowledgeError(surfaceErrorMessage(cause, "사용한 지식을 불러오지 못했습니다."));
      },
    );
    return () => {
      disposed = true;
    };
  }, [service, tab, work.id]);

  return (
    <aside
      aria-label="Work 세부 정보"
      className="grid h-full min-h-0 min-w-0 grid-rows-[46px_minmax(0,1fr)] border-l border-border bg-chrome"
    >
      <Tabs
        className="contents"
        onValueChange={(value) => {
          setTab(value === null ? "work" : String(value));
        }}
        value={tab}
      >
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
            <TabsTrigger className="h-full flex-1 px-1" value="knowledge">
              근거
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
          <TabsContent value="knowledge">
            <WorkKnowledgeInspector
              error={knowledgeError}
              knowledge={knowledge}
              onOpenSharedContext={() => {
                setTab("work");
              }}
              sharedContextAvailable={(room?.sharedContexts.length ?? 0) > 0}
            />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function WorkKnowledgeInspector({
  error,
  knowledge,
  onOpenSharedContext,
  sharedContextAvailable,
}: {
  error: string;
  knowledge: WorkKnowledgeViewV1 | undefined;
  onOpenSharedContext: () => void;
  sharedContextAvailable: boolean;
}) {
  if (error)
    return (
      <section aria-label="사용한 지식" className="border border-danger/50 bg-surface-1 px-3.5 py-3">
        <h2 className="text-sm font-semibold">사용한 지식</h2>
        <p className="mt-1.5 text-xs leading-5 text-danger">{error}</p>
      </section>
    );
  if (knowledge === undefined)
    return (
      <section aria-busy="true" aria-label="사용한 지식 불러오는 중" className="space-y-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </section>
    );
  if (knowledge.status === "not-applicable")
    return (
      <InspectorEmpty
        detail="워크스페이스를 선택한 새 Work에서 코드 근거를 사용할 수 있습니다."
        icon={Database}
        message="이 Work는 워크스페이스 근거를 사용하지 않았습니다."
      />
    );
  if (knowledge.status === "no-match")
    return (
      <InspectorEmpty
        detail="새 Work에서 다른 요청이나 파일 범위로 다시 검색할 수 있습니다."
        icon={MagnifyingGlass}
        message="검색했지만 이 Work에서 사용할 코드 근거를 찾지 못했습니다."
      />
    );
  if (knowledge.status === "blocked")
    return (
      <section aria-label="사용한 지식" className="border border-danger/50 bg-surface-1 px-3.5 py-3">
        <h2 className="text-sm font-semibold">사용한 지식</h2>
        <p className="mt-1.5 text-xs leading-5 text-danger">
          지식 스냅샷을 검증하지 못했습니다. 업무 화면에서 실행을 재개하거나 새 Work를 시작해 주세요.
        </p>
      </section>
    );

  const freshness = knowledge.freshnessStatus === "stale_warning" ? "이후 파일 변경됨" : "현재 스냅샷";
  const freshnessDetail =
    knowledge.freshnessStatus === "stale_warning"
      ? "이 Work는 시작 당시의 근거를 계속 사용합니다. 새 Work는 현재 파일을 다시 읽습니다."
      : "이 Work에서 사용한 파일과 코드 범위입니다.";

  return (
    <section aria-label="사용한 지식" className="border border-border bg-surface-1">
      <header className="border-b border-border px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">사용한 지식</h2>
          <span className="rounded-[3px] border border-control px-1.5 text-[10px] text-muted">{freshness}</span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted">{freshnessDetail}</p>
      </header>
      {knowledge.references.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-muted">사용한 코드 범위가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-border">
          {knowledge.references.map((reference) => (
            <li key={reference.referenceId}>
              <button
                aria-label={`${reference.relativePath} 출처 보기`}
                className="flex w-full items-center gap-2 px-3.5 py-3 text-left outline-none hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!sharedContextAvailable}
                onClick={onOpenSharedContext}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-primary">{reference.relativePath}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {reference.qualifiedName ?? "코드 범위"} · {reference.startLine}–{reference.endLine}
                  </span>
                </span>
                {sharedContextAvailable ? (
                  <CaretRight aria-hidden="true" className="shrink-0 text-muted" size={14} />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharedContextAvailable ? (
        <p className="border-t border-border px-3.5 py-2.5 text-[11px] leading-4 text-muted">
          항목을 누르면 Core Office가 공유한 출처로 이동합니다.
        </p>
      ) : null}
    </section>
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
              <span className="text-muted">판정</span>
              <span className="min-w-0 flex-1 truncate text-secondary">{verification.verifier}</span>
              <span className={stateClass[verification.state]}>{stateLabel[verification.state]}</span>
              <CaretRight aria-hidden="true" className="text-muted" size={13} />
            </div>
            {verification.criteria.length === 0 ? null : (
              <ul className="mt-1.5 space-y-1 pl-6">
                {verification.criteria.map((criterion) => (
                  <li className="flex items-center gap-2 text-[11px]" key={criterion.key}>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted">{criterion.key}</span>
                    <span className={criterionStatusClass[criterion.status]}>
                      {criterionStatusLabel[criterion.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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

function InspectorEmpty({ detail, icon: Icon, message }: { detail?: string; icon: typeof Briefcase; message: string }) {
  return (
    <div className="px-5 py-14 text-center">
      <Icon aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
      <p className="text-sm text-secondary">{message}</p>
      <p className="mt-1 text-xs text-muted">{detail ?? "실행이 산출물을 만들면 여기에 표시됩니다."}</p>
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
