import {
  agentRoleToken,
  USER_STAGES,
  userStageProgress,
  workStatusToken,
  type CollaborationGraphNode,
  type CollaborationGraphSnapshot,
} from "@massion/application";

import type { TuiState, TuiView } from "./state.js";
import { buildDashboard, currentInternalStage } from "./view-model.js";

// Guided Workspace: 숫자 키 대신 친화적인 화면 이름만 표시합니다.
const VIEW_LABELS: Readonly<Record<TuiView, string>> = {
  overview: "개요",
  agents: "협업",
  works: "작업",
  chat: "대화",
  approvals: "확인",
  operations: "운영",
  subscriptions: "구독",
};

const SUBSCRIPTION_APPROVAL_MODES = ["automatic", "review", "deny"] as const;

export function safeTerminalText(value: unknown, maximum = 8_192): string {
  if (value === undefined) return "";
  const source = typeof value === "string" ? value : JSON.stringify(value);
  return Array.from(source)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code >= 0 && code <= 8) ||
        (code >= 11 && code <= 12) ||
        (code >= 14 && code <= 31) ||
        (code >= 127 && code <= 159)
        ? "�"
        : character;
    })
    .join("")
    .slice(0, maximum);
}

function approvalPreviewLines(
  preview: CollaborationGraphSnapshot["pendingApprovals"][number]["displayPreview"],
): readonly string[] {
  if (!preview) return ["승인할 실제 실행 내용이 제공되지 않았습니다."];
  if (preview.kind === "command") {
    return [
      `승인 내용           ${safeTerminalText(preview.title, 160)}`,
      `실행 파일           ${safeTerminalText(preview.executable, 256)}`,
      `인수                ${preview.arguments.map((value) => safeTerminalText(value, 256)).join(" ") || "없음"}`,
      ...(preview.cwd === undefined ? [] : [`작업 경로           ${safeTerminalText(preview.cwd, 1_024)}`]),
      ...(preview.reason === undefined ? [] : [`요청 이유           ${safeTerminalText(preview.reason, 1_000)}`]),
    ];
  }
  if (preview.kind === "file-change") {
    return [
      `승인 내용           ${safeTerminalText(preview.title, 160)}`,
      `변경 경로           ${safeTerminalText(preview.path, 1_024)}`,
      `변경 요약           ${safeTerminalText(preview.summary, 1_000)}`,
      ...(preview.reason === undefined ? [] : [`요청 이유           ${safeTerminalText(preview.reason, 1_000)}`]),
    ];
  }
  return [
    `승인 내용           ${safeTerminalText(preview.title, 160)}`,
    ...(preview.reason === undefined ? [] : [`요청 이유           ${safeTerminalText(preview.reason, 1_000)}`]),
  ];
}

// Guided Workspace: 서버 상태 문자열을 공통 디자인 토큰의 의미 체계로 분류합니다.
const RUNNING_STATUSES = new Set(["active", "running", "live"]);
const COMPLETED_STATUSES = new Set(["completed", "passed"]);
const APPROVAL_STATUSES = new Set(["pending", "queued", "waiting_approval"]);
const BLOCKED_STATUSES = new Set(["suspended", "blocked"]);
const FAILED_STATUSES = new Set(["failed"]);
const CANCELLED_STATUSES = new Set(["cancelled", "offline"]);

function classifyStatus(status: string): string {
  if (RUNNING_STATUSES.has(status)) return "running";
  if (COMPLETED_STATUSES.has(status)) return "completed";
  if (APPROVAL_STATUSES.has(status)) return "awaiting-approval";
  if (BLOCKED_STATUSES.has(status)) return "blocked";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (CANCELLED_STATUSES.has(status)) return "cancelled";
  return "ready";
}

function statusMark(status: string): string {
  return workStatusToken(classifyStatus(status)).symbol;
}

function statusLabel(status: string): string {
  return workStatusToken(classifyStatus(status)).friendlyLabel;
}

// 사용자용 4단계 진행 바: "✓ 요청 이해 ── ▶ 작업 진행 ── ○ 결과 확인"
function renderUserStageBar(internalStage: string): string {
  return USER_STAGES.map((stage) => {
    const progress = userStageProgress(internalStage, stage.id);
    const mark = progress === "completed" ? "✓" : progress === "current" ? "▶" : "○";
    return `${mark} ${stage.friendlyLabel}`;
  }).join(" ── ");
}

function workDisplayTitle(snapshot: CollaborationGraphSnapshot, workId: string): string {
  const task = snapshot.tasks.find((item) => item.workId === workId);
  return safeTerminalText(task?.title ?? workId, 80);
}

function recentNews(state: TuiState): readonly string[] {
  const events = state.events.slice(-6);
  if (!events.length) return ["아직 소식이 없어요."];
  return events.map((event) => `${String(event.sequence).padStart(6)}  ${safeTerminalText(event.type, 80)}`);
}

function nodeLine(node: CollaborationGraphNode, selected: boolean): string {
  const work = node.currentWorkId ? ` · 업무 ${node.currentWorkId}` : "";
  return `${selected ? "›" : " "} ${statusMark(node.executionStatus ?? node.status)} ${node.name} (${node.handle})${work}`;
}

function selectedNode(state: TuiState): CollaborationGraphNode | undefined {
  return state.snapshot?.nodes.find((node) => node.handle === state.selection.agentHandle);
}

function overview(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const dashboard = buildDashboard(snapshot);
  return {
    list: [
      `진행 중 업무        ${String(dashboard.activeWorks)}`,
      `실행 중 에이전트    ${String(dashboard.runningAgents)}`,
      `대기 중 승인        ${String(dashboard.pendingApprovals)}`,
      `입력 / 출력 토큰    ${String(dashboard.inputTokens)} / ${String(dashboard.outputTokens)}`,
      `누적 모델 비용      ${dashboard.costText}`,
      "",
      "최근 사건",
      ...state.events
        .slice(-8)
        .map((event) => `${String(event.sequence).padStart(6)}  ${safeTerminalText(event.type, 80)}`),
    ].join("\n"),
    detail: [
      "조직 상태",
      `조직 공개 ID        ${snapshot.organization.organizationId}`,
      `조직 버전           ${String(snapshot.organization.version)}`,
      `Snapshot revision   ${snapshot.revision.slice(0, 12)}…`,
      `Event cursor        ${String(state.cursor)}`,
      `연결                ${statusMark(state.connection)} ${statusLabel(state.connection)}`,
      "",
      state.error ?? "실시간 연결이 정상입니다.",
    ].join("\n"),
  };
}

function agents(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const node = selectedNode(state) ?? snapshot.nodes[0];
  return {
    list: snapshot.nodes.length
      ? snapshot.nodes.map((item) => nodeLine(item, item.handle === node?.handle)).join("\n")
      : "등록된 에이전트가 없습니다.",
    detail: node
     ? [
         `${node.name} (${node.handle})`,
          `역할                ${agentRoleToken(node.role).friendlyLabel}`,
         `책임                ${node.responsibility}`,
          `범위                ${node.scope}`,
          `상태                ${statusMark(node.executionStatus ?? node.status)} ${node.executionStatus ?? node.status}`,
          `현재 업무           ${node.currentWorkId ?? "없음"}`,
          `현재 작업           ${node.currentTaskId ?? "없음"}`,
          `실행 공개 ID        ${node.executionId ?? "없음"}`,
          `모델 경로           ${node.modelRoute ?? "없음"}`,
          `토큰                ${String(node.inputTokens ?? 0)} / ${String(node.outputTokens ?? 0)}`,
          `비용                $${((node.costMicros ?? 0) / 1_000_000).toFixed(6)}`,
          "",
          "기능(Capability)",
          ...(node.capabilities.length ? node.capabilities.map((item) => `• ${item}`) : ["없음"]),
        ].join("\n")
      : "선택할 에이전트가 없습니다.",
  };
}

function works(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const work = snapshot.works.find((item) => item.workId === state.selection.workId) ?? snapshot.works[0];
  const tasks = work ? snapshot.tasks.filter((item) => item.workId === work.workId) : [];
  const executions = work ? snapshot.executions.filter((item) => item.workId === work.workId) : [];
  const list = snapshot.works.length
    ? snapshot.works
        .map(
          (item) =>
            `${item.workId === work?.workId ? "›" : " "} ${statusMark(item.status)} ${workDisplayTitle(snapshot, item.workId)} · ${statusLabel(item.status)}`,
        )
        .join("\n")
    : "아직 작업이 없습니다. n 키를 눌러 첫 작업을 시작해 주세요.";

  if (!work) return { list, detail: "선택할 작업이 없습니다." };

  // 기본(친화적): 4단계 진행 바 + 최근 소식
  if (!state.inspector) {
    const stage = currentInternalStage(snapshot, work.workId);
    return {
      list,
      detail: [
        "작업 진행",
        renderUserStageBar(stage),
        "",
        `상태                ${statusLabel(work.status)}`,
        `산출물              ${work.artifactIds.length ? work.artifactIds.join(", ") : "아직 없어요"}`,
        "",
        "최근 소식",
        ...recentNews(state),
        "",
        "d: 자세히 보기  ·  n: 새 작업  ·  m: 메시지",
      ].join("\n"),
    };
  }

  // 자세히 보기(D): 기술 상세 — 작업·실행·배정
  return {
    list,
    detail: [
      `작업 ${work.workId} · ${statusLabel(work.status)}`,
      `상태 / revision     ${work.status} / ${String(work.revision)}`,
      `산출물              ${work.artifactIds.length ? work.artifactIds.join(", ") : "없음"}`,
      "",
      "작업(Task)",
      ...(tasks.length
        ? tasks.map((task) => {
            const assignment = snapshot.assignments.find((item) => item.taskId === task.taskId);
            const role = assignment ? agentRoleToken(assignment.agentHandle).friendlyLabel : "미배정";
            return `${statusMark(task.status)} ${task.title} (${task.taskId}) → ${role}`;
          })
        : ["없음"]),
      "",
      "실행(Execution)",
      ...(executions.length
        ? executions.map(
            (execution) =>
              `${statusMark(execution.status)} ${execution.agentHandle} · ${execution.status} · ${execution.modelRoute}`,
          )
        : ["없음"]),
      "",
      "d: 간단히 보기  ·  c: 업무 취소  ·  s: 실행 일시정지/재개  ·  t: 작업 배정",
    ].join("\n"),
  };
}

function chat(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const rooms = state.selection.workId
    ? snapshot.rooms.filter((item) => item.workId === state.selection.workId)
    : snapshot.rooms;
  const room = rooms.find((item) => item.roomId === state.selection.roomId) ?? rooms[0];
  const messages = Array.isArray(state.queryResults.messages) ? state.queryResults.messages : [];
  return {
    list: rooms.length
      ? rooms
          .map(
            (item) =>
              `${item.roomId === room?.roomId ? "›" : " "} ${statusMark(item.status)} ${item.name} · ${String(item.participantIds.length)}명`,
          )
          .join("\n")
      : "선택한 업무에 협업방이 없습니다.",
    detail: room
      ? [
          `${room.name} (${room.roomId})`,
          `참여자  ${room.participantIds.join(", ")}`,
          "",
          ...(messages.length
            ? messages.slice(-30).map((message) => {
                const value = message as Record<string, unknown>;
                return `${safeTerminalText(value.authorId, 64)} · ${safeTerminalText(value.messageType, 32)}\n  ${safeTerminalText(value.content, 1_024)}`;
              })
            : ["표시할 메시지가 없습니다."]),
          "",
          "m: 새 메시지 작성",
        ].join("\n")
      : "선택할 협업방이 없습니다.",
  };
}

function approvals(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const approval =
    snapshot.pendingApprovals.find((item) => item.approvalId === state.selection.approvalId) ??
    snapshot.pendingApprovals[0];
  return {
    list: snapshot.pendingApprovals.length
      ? snapshot.pendingApprovals
          .map(
            (item) => `${item.approvalId === approval?.approvalId ? "›" : " "} ◐ ${item.action} · ${item.requestedBy}`,
          )
          .join("\n")
      : "대기 중인 승인이 없습니다. 자동 반영 정책에서는 정상 상태입니다.",
    detail: approval
      ? [
          `승인 요청 ${approval.approvalId}`,
          `행동                ${approval.action}`,
          `요청자              ${approval.requestedBy}`,
          `만료                ${approval.expiresAt}`,
          ...approvalPreviewLines(approval.displayPreview),
          "",
          "a: 승인  x: 거절  Delete: 요청 취소",
          "투표 결과와 이유는 감사 기록에 남습니다.",
        ].join("\n")
      : "서버 정책이 승인을 요구할 때 여기에 표시됩니다.",
  };
}

type PublicRow = Readonly<Record<string, unknown>>;

function rows(value: unknown): readonly PublicRow[] {
  return Array.isArray(value)
    ? (value.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item)) as PublicRow[])
    : [];
}

function text(value: unknown, fallback = "확인 불가"): string {
  return typeof value === "string" || typeof value === "number" ? safeTerminalText(String(value), 256) : fallback;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function subscriptionErrors(state: TuiState): readonly string[] {
  return Object.entries(state.queryErrors)
    .filter(([key]) => key.startsWith("subscription"))
    .map(([key, error]) => `${key}: ${safeTerminalText(error, 180)}`);
}

function subscriptionQuotaText(account: PublicRow, quotaRows: readonly PublicRow[]): string {
  const quota =
    quotaRows.find((item) => item.accountId === account.accountId) ??
    (Array.isArray(account.windows) || account.minimumRemainingRatio !== undefined ? account : undefined);
  const ratio = numeric(quota?.minimumRemainingRatio);
  return ratio === undefined ? "할당량 확인 불가" : `남은 할당량 ${String(Math.round(ratio * 100))}%`;
}

function subscriptionProviderApprovalModes(
  provider: PublicRow | undefined,
  accounts: readonly PublicRow[],
): readonly string[] {
  if (provider?.connectionSurface === "unavailable") return [];
  const runtimeCapabilities =
    provider?.runtimeCapabilities &&
    typeof provider.runtimeCapabilities === "object" &&
    !Array.isArray(provider.runtimeCapabilities)
      ? (provider.runtimeCapabilities as PublicRow)
      : undefined;
  const approvalModesBySurface =
    runtimeCapabilities?.approvalModesBySurface &&
    typeof runtimeCapabilities.approvalModesBySurface === "object" &&
    !Array.isArray(runtimeCapabilities.approvalModesBySurface)
      ? (runtimeCapabilities.approvalModesBySurface as PublicRow)
      : undefined;
  const connectedSurfaces = new Set(
    accounts
      .filter((account) => account.providerId === provider?.providerId)
      .map((account) => account.connectorLocation)
      .filter((surface): surface is "server" | "edge" => surface === "server" || surface === "edge"),
  );
  if (connectedSurfaces.size > 0 && approvalModesBySurface) {
    const supported = new Set<string>();
    for (const surface of connectedSurfaces) {
      for (const mode of strings(approvalModesBySurface[surface])) supported.add(mode);
    }
    return SUBSCRIPTION_APPROVAL_MODES.filter((mode) => supported.has(mode));
  }
  if (!runtimeCapabilities || !Object.hasOwn(runtimeCapabilities, "approvalModes")) {
    return SUBSCRIPTION_APPROVAL_MODES;
  }
  return strings(runtimeCapabilities.approvalModes).filter((mode) =>
    SUBSCRIPTION_APPROVAL_MODES.includes(mode as (typeof SUBSCRIPTION_APPROVAL_MODES)[number]),
  );
}

function subscriptions(state: TuiState): { list: string; detail: string } {
  const providers = rows(state.queryResults.subscriptionProviders);
  const accounts = rows(state.queryResults.subscriptionAccounts);
  const quota = rows(state.queryResults.subscriptionQuota);
  const policies = rows(state.queryResults.subscriptionPolicy);
  const doctors = rows(state.queryResults.subscriptionDoctor);
  const errors = subscriptionErrors(state);
  const tabLine = [
    ["providers", "Provider"],
    ["accounts", "계정"],
    ["quota", "할당량"],
    ["policy", "정책"],
  ] as const;
  const navigation = tabLine.map(([tab, label]) => (state.subscriptionTab === tab ? `[${label}]` : label)).join("  ");

  if (state.subscriptionTab === "providers") {
    const provider = providers[0];
    const runtimeCapabilities =
      provider?.runtimeCapabilities &&
      typeof provider.runtimeCapabilities === "object" &&
      !Array.isArray(provider.runtimeCapabilities)
        ? (provider.runtimeCapabilities as PublicRow)
        : undefined;
    return {
      list: providers.length
        ? providers
            .map(
              (item) =>
                `  ${statusMark(text(item.availability, "unknown"))} ${text(item.displayName)} · ${text(item.availability)}`,
            )
            .join("\n")
        : "등록된 구독 Provider가 없습니다.",
      detail: [
        navigation,
        "",
        provider ? text(provider.displayName) : "Provider를 선택할 수 없습니다.",
        `실행 방식           ${text(provider?.executionKind)}`,
        `인증 방식           ${
          strings(provider?.authKinds)
            .map((item) => text(item))
            .join(", ") || "확인 불가"
        }`,
        `모델 검색           ${text(provider?.modelDiscovery)}`,
        `할당량 검색         ${text(provider?.quotaDiscovery)}`,
        `연결 위치           ${text(provider?.connectionSurface)}`,
        ...(runtimeCapabilities
          ? [
              `계정 격리           ${text(runtimeCapabilities.accountIsolation)}`,
              `실행 성숙도         ${text(runtimeCapabilities.maturity)}`,
              `실행 승인 범위      ${
                strings(runtimeCapabilities.approvalModes)
                  .map((item) => text(item))
                  .join(", ") || "확인 불가"
              }`,
            ]
          : []),
        `공식 문서           ${text(provider?.officialDocumentation)}`,
        "",
        ...errors,
        "←/→ 또는 h/l: 탭 이동",
      ].join("\n"),
    };
  }

  const selected = accounts.find((item) => item.accountId === state.selection.accountId) ?? accounts[0];
  const doctor = doctors.find((item) => item.accountId === selected?.accountId);
  const accountList = accounts.length
    ? accounts
        .map(
          (item) =>
            `${item === selected ? "›" : " "} ${statusMark(text(item.status, "unknown"))} ${text(item.alias)} · ${text(item.providerId)} · ${text(item.scope)}`,
        )
        .join("\n")
    : "연결된 구독 계정이 없습니다.";

  if (state.subscriptionTab === "accounts") {
    const canManage = selected?.canManage === true;
    return {
      list: accountList,
      detail: [
        navigation,
        "",
        selected ? text(selected.alias) : "계정을 선택할 수 없습니다.",
        `Provider            ${text(selected?.providerId)}`,
        `공유 범위           ${text(selected?.scope)}`,
        `계정 상태           ${text(selected?.status)}`,
        `Connector 상태      ${text(doctor?.connectorStatus ?? selected?.connectorStatus)}`,
        `진단 조치           ${text(doctor?.action, "없음")}`,
        subscriptionQuotaText(selected ?? {}, quota),
        `관리 권한           ${canManage ? "있음" : "읽기 전용"}`,
        "",
        ...errors,
        canManage ? "s: 조직 공유  u: 공유 해제  d: 연결 해제" : "소유자만 계정을 변경할 수 있습니다.",
      ].join("\n"),
    };
  }

  if (state.subscriptionTab === "quota") {
    const quotaRow = quota.find((item) => item.accountId === selected?.accountId);
    const windows = rows(quotaRow?.windows ?? selected?.windows);
    return {
      list: accountList,
      detail: [
        navigation,
        "",
        selected ? text(selected.alias) : "계정을 선택할 수 없습니다.",
        subscriptionQuotaText(selected ?? {}, quota),
        ...(windows.length
          ? windows.map((window) => {
              const ratio = numeric(window.remainingRatio);
              return `• ${text(window.kind)} · ${ratio === undefined ? "잔여 비율 확인 불가" : `${String(Math.round(ratio * 100))}%`} · 초기화 ${text(window.resetsAt)}`;
            })
          : ["• Provider가 공개한 할당량 창이 없습니다."]),
        "",
        ...errors,
      ].join("\n"),
    };
  }

  const provider = providers[0];
  const policy = policies.find((item) => item.providerId === provider?.providerId) ?? policies[0];
  const approvalModes = subscriptionProviderApprovalModes(provider, accounts);
  const connectionUnavailable = provider?.connectionSurface === "unavailable";
  const configuredApprovalMode = text(policy?.approvalMode);
  const displayedApprovalMode = configuredApprovalMode
    ? approvalModes.includes(configuredApprovalMode)
      ? configuredApprovalMode
      : `${configuredApprovalMode} (현재 연결에서 사용 불가)`
    : (approvalModes[0] ?? "미지원");
  return {
    list: providers.length
      ? providers
          .map((item) => {
            const configured = policies.find((policyItem) => policyItem.providerId === item.providerId);
            return `  ${text(item.displayName)} · ${text(configured?.credentialPolicy, "서버 기본값")}`;
          })
          .join("\n")
      : "정책을 표시할 Provider가 없습니다.",
    detail: [
      navigation,
      "",
      provider ? text(provider.displayName) : "Provider를 선택할 수 없습니다.",
      `현재 정책           ${text(policy?.credentialPolicy, "서버 기본값")}`,
      `도구 승인 방식      ${displayedApprovalMode}`,
      `정책 version        ${text(policy?.version)}`,
      `선택 가능 정책      ${
        strings(provider?.credentialPolicies)
          .map((item) => text(item))
          .join(", ") || "확인 불가"
      }`,
      `선택 가능 승인      ${approvalModes.join(", ") || "미지원"}`,
      ...(connectionUnavailable ? ["공개 연결           미지원"] : []),
      "",
      ...errors,
      connectionUnavailable
        ? "이 Provider는 공개 연결을 지원하지 않아 정책을 변경할 수 없습니다."
        : "e: 정책 변경 · Web Console 또는 massion subscription policy도 사용 가능",
    ].join("\n"),
  };
}

function operations(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const routes = Array.isArray(state.queryResults.routes) ? state.queryResults.routes : [];
  const credentials = Array.isArray(state.queryResults.credentials) ? state.queryResults.credentials : [];
  const extensions = snapshot.extensions;
  const suggestions = Array.isArray(state.queryResults.suggestions) ? state.queryResults.suggestions : [];
  const effects = Array.isArray(state.queryResults.effects) ? state.queryResults.effects : [];
  const records = Array.isArray(state.queryResults.records) ? state.queryResults.records : [];
  const optimizationPolicy = Array.isArray(state.queryResults.optimizationPolicy)
    ? state.queryResults.optimizationPolicy
    : [];
  const optimizationReceipts = Array.isArray(state.queryResults.optimizationReceipts)
    ? state.queryResults.optimizationReceipts
    : [];
  const optimizationRecommendations = Array.isArray(state.queryResults.optimizationRecommendations)
    ? state.queryResults.optimizationRecommendations
    : [];
  const optimizationObservations = Array.isArray(state.queryResults.optimizationObservations)
    ? state.queryResults.optimizationObservations
    : [];
  const growthConfiguration =
    state.queryResults.growthConfiguration && typeof state.queryResults.growthConfiguration === "object"
      ? (state.queryResults.growthConfiguration as Record<string, unknown>)
      : undefined;
  return {
    list: [
      `모델 경로            ${String(routes.length)}`,
      `Provider 자격 증명   ${String(credentials.length)} (원문 비공개)`,
      `설치 Extension       ${String(extensions.length)}`,
      `Growth 제안          ${String(suggestions.length)}`,
      `Growth 효과 평가     ${String(effects.length)}`,
      `모델 평가 receipt     ${String(optimizationReceipts.length)}`,
      `모델 추천             ${String(optimizationRecommendations.length)}`,
      `실사용 관찰           ${String(optimizationObservations.length)}`,
      `최적화 정책           ${optimizationPolicy.length ? "설정됨" : "기본 review"}`,
      `선택 업무 기록       ${String(records.length)}`,
    ].join("\n"),
    detail: [
      "모델 경로(Provider route)",
      ...(routes.length
        ? routes.slice(0, 12).map((route) => {
            const value = route as Record<string, unknown>;
            return `• ${safeTerminalText(value.name ?? value.routeId, 80)}`;
          })
        : ["• 조회 결과 없음"]),
      `자격 증명 상태       ${credentials.length ? "등록됨" : "없음 또는 조회 권한 없음"}`,
      "",
      "Extension",
      ...(extensions.length
        ? extensions.map((extension) => `• ${extension.packageName}@${extension.packageVersion} · ${extension.state}`)
        : ["• 설치 항목 없음"]),
      "",
      `Growth 반영 정책     ${safeTerminalText(growthConfiguration?.adoptionMode ?? "미설정", 64)}`,
      "Growth와 Records는 서버 정책·검증 계보를 그대로 표시합니다.",
    ].join("\n"),
  };
}

export function present(state: TuiState): {
  readonly navigation: string;
  readonly title: string;
  readonly list: string;
  readonly detail: string;
  readonly footer: string;
} {
  const navigation = `${VIEW_LABELS[state.view]}${state.inspector ? " · 자세히 보기" : ""}`;
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {
      navigation,
      title: "Massion",
      list: "Application API에 연결하고 있습니다…",
      detail: state.error ?? "상태·Identity·협업 snapshot을 확인합니다.",
      footer: "? 도움말  ·  Ctrl+C 종료",
    };
  }
  const content =
    state.view === "overview"
      ? overview(state, snapshot)
      : state.view === "agents"
        ? agents(state, snapshot)
        : state.view === "works"
          ? works(state, snapshot)
          : state.view === "chat"
            ? chat(state, snapshot)
            : state.view === "approvals"
              ? approvals(state, snapshot)
              : state.view === "operations"
                ? operations(state, snapshot)
                : subscriptions(state);
  return {
    navigation,
    title: `Massion · ${statusLabel(state.connection)} · ${snapshot.organization.organizationId}`,
    ...content,
    footer: "Tab 뷰 전환  ·  n 새 작업  ·  m 메시지  ·  d 자세히  ·  / 검색  ·  j/k 이동  ·  r 새로고침  ·  ? 도움말  ·  Ctrl+C 종료",
  };
}
