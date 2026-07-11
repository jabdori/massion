import type { CollaborationGraphSnapshot } from "@massion/application";

import type { TuiEvent } from "./wire.js";

export type TuiConnection = "connecting" | "live" | "reconnecting" | "offline" | "stopped";
export type TuiView = "overview" | "agents" | "works" | "chat" | "approvals" | "operations";

export interface TuiSelection {
  readonly workId?: string;
  readonly agentHandle?: string;
  readonly roomId?: string;
  readonly approvalId?: string;
}

export interface TuiState {
  readonly connection: TuiConnection;
  readonly view: TuiView;
  readonly snapshot?: CollaborationGraphSnapshot;
  readonly cursor: number;
  readonly needsResync: boolean;
  readonly events: readonly TuiEvent[];
  readonly eventLimit: number;
  readonly selection: TuiSelection;
  readonly queryResults: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export type TuiAction =
  | { readonly type: "connection.changed"; readonly connection: TuiConnection; readonly error?: string }
  | { readonly type: "snapshot.loaded"; readonly snapshot: CollaborationGraphSnapshot }
  | { readonly type: "event.received"; readonly event: TuiEvent }
  | { readonly type: "view.selected"; readonly view: TuiView }
  | { readonly type: "query.loaded"; readonly key: string; readonly value: unknown }
  | { readonly type: "selection.changed"; readonly selection: TuiSelection };

export function createTuiState(input: { readonly eventLimit?: number } = {}): TuiState {
  const eventLimit = input.eventLimit ?? 500;
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 10_000)
    throw new Error("TUI event 보관 상한이 유효하지 않습니다");
  return {
    connection: "connecting",
    view: "overview",
    cursor: 0,
    needsResync: false,
    events: [],
    eventLimit,
    selection: {},
    queryResults: {},
  };
}

function clearError(state: TuiState): TuiState {
  const result: { -readonly [Key in keyof TuiState]: TuiState[Key] } = { ...state };
  delete result.error;
  return result;
}

function validSelection(state: TuiState, snapshot: CollaborationGraphSnapshot): TuiSelection {
  const workId = snapshot.works.some((item) => item.workId === state.selection.workId)
    ? state.selection.workId
    : snapshot.works[0]?.workId;
  const agentHandle = snapshot.nodes.some((item) => item.handle === state.selection.agentHandle)
    ? state.selection.agentHandle
    : snapshot.nodes[0]?.handle;
  const rooms = workId === undefined ? snapshot.rooms : snapshot.rooms.filter((item) => item.workId === workId);
  const roomId = rooms.some((item) => item.roomId === state.selection.roomId)
    ? state.selection.roomId
    : rooms[0]?.roomId;
  const approvalId = snapshot.pendingApprovals.some((item) => item.approvalId === state.selection.approvalId)
    ? state.selection.approvalId
    : snapshot.pendingApprovals[0]?.approvalId;
  return {
    ...(workId === undefined ? {} : { workId }),
    ...(agentHandle === undefined ? {} : { agentHandle }),
    ...(roomId === undefined ? {} : { roomId }),
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "connection.changed") {
    const withoutError = clearError(state);
    return {
      ...withoutError,
      connection: action.connection,
      ...(action.error === undefined ? {} : { error: action.error }),
    };
  }
  if (action.type === "snapshot.loaded") {
    const withoutError = clearError(state);
    return {
      ...withoutError,
      snapshot: action.snapshot,
      selection: validSelection(state, action.snapshot),
      needsResync: false,
    };
  }
  if (action.type === "event.received") {
    if (action.event.sequence <= state.cursor) return state;
    if (state.cursor !== 0 && action.event.sequence !== state.cursor + 1) return { ...state, needsResync: true };
    return {
      ...state,
      cursor: action.event.sequence,
      events: [...state.events, action.event].slice(-state.eventLimit),
    };
  }
  if (action.type === "view.selected") return { ...state, view: action.view };
  if (action.type === "query.loaded") {
    return { ...state, queryResults: { ...state.queryResults, [action.key]: action.value } };
  }
  return { ...state, selection: { ...state.selection, ...action.selection } };
}
