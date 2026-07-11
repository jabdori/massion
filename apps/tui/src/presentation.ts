import type { CollaborationGraphNode, CollaborationGraphSnapshot } from "@massion/application";

import type { TuiState, TuiView } from "./state.js";
import { buildDashboard } from "./view-model.js";

const VIEWS: ReadonlyArray<{ readonly view: TuiView; readonly label: string }> = [
  { view: "overview", label: "1 개요" },
  { view: "agents", label: "2 협업 맵" },
  { view: "works", label: "3 업무" },
  { view: "chat", label: "4 대화" },
  { view: "approvals", label: "5 승인" },
  { view: "operations", label: "6 운영" },
];

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

function statusMark(status: string): string {
  if (["active", "running", "completed", "passed", "live"].includes(status)) return "●";
  if (["pending", "queued", "waiting_approval", "suspended"].includes(status)) return "◐";
  if (["failed", "blocked", "cancelled", "offline"].includes(status)) return "×";
  return "○";
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
      `연결                ${statusMark(state.connection)} ${state.connection}`,
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
          `역할                ${node.role}`,
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
  return {
    list: snapshot.works.length
      ? snapshot.works
          .map(
            (item) =>
              `${item.workId === work?.workId ? "›" : " "} ${statusMark(item.status)} 업무 ${item.workId} · ${item.status} · r${String(item.revision)}`,
          )
          .join("\n")
      : "아직 업무가 없습니다. `mass run`으로 첫 업무를 시작할 수 있습니다.",
    detail: work
      ? [
          `업무 ${work.workId}`,
          `상태 / revision     ${work.status} / ${String(work.revision)}`,
          `산출물              ${work.artifactIds.length ? work.artifactIds.join(", ") : "없음"}`,
          "",
          "작업(Task)",
          ...(tasks.length
            ? tasks.map((task) => {
                const assignment = snapshot.assignments.find((item) => item.taskId === task.taskId);
                return `${statusMark(task.status)} ${task.title} (${task.taskId}) → ${assignment?.agentHandle ?? "미배정"}`;
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
          "d: 업무 취소  s: 실행 일시정지/재개",
        ].join("\n")
      : "선택할 업무가 없습니다.",
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
          "c: 새 메시지 작성",
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
          "",
          "a: 승인  x: 거절  Delete: 요청 취소",
          "투표 결과와 이유는 감사 기록에 남습니다.",
        ].join("\n")
      : "서버 정책이 승인을 요구할 때 여기에 표시됩니다.",
  };
}

function operations(state: TuiState, snapshot: CollaborationGraphSnapshot): { list: string; detail: string } {
  const routes = Array.isArray(state.queryResults.routes) ? state.queryResults.routes : [];
  const credentials = Array.isArray(state.queryResults.credentials) ? state.queryResults.credentials : [];
  const extensions = snapshot.extensions;
  const suggestions = Array.isArray(state.queryResults.suggestions) ? state.queryResults.suggestions : [];
  const effects = Array.isArray(state.queryResults.effects) ? state.queryResults.effects : [];
  const records = Array.isArray(state.queryResults.records) ? state.queryResults.records : [];
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
  const navigation = VIEWS.map((item) => (item.view === state.view ? `[${item.label}]` : item.label)).join("   ");
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {
      navigation,
      title: "Massion AgentOS",
      list: "Application API에 연결하고 있습니다…",
      detail: state.error ?? "상태·Identity·협업 snapshot을 확인합니다.",
      footer: "Ctrl+C 종료  ? 도움말",
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
              : operations(state, snapshot);
  return {
    navigation,
    title: `Massion AgentOS · ${snapshot.organization.organizationId} · ${statusMark(state.connection)} ${state.connection}`,
    ...content,
    footer: "1–6 화면  j/k 이동  r 새로고침  / 검색  ? 도움말  Ctrl+C 종료",
  };
}
