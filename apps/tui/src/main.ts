#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { ApplicationHttpClient } from "@massion/application";
import { createCliRenderer, type CliRenderer } from "@opentui/core";

import { TuiCommands } from "./commands.js";
import { TuiController } from "./controller.js";
import { loadTuiProfile, resolveTuiConfigPath } from "./profile.js";
import { decodeExecutionDelta } from "./wire.js";
import {
  createTuiState,
  reduceTuiState,
  shouldRingAttentionBell,
  type TuiAction,
  type TuiState,
  type TuiView,
  type TuiWorkspace,
} from "./state.js";

export interface TuiArguments {
  readonly profile?: string;
  readonly configPath?: string;
  readonly workspacePath?: string;
  readonly help: boolean;
}

export function parseTuiArguments(argv: readonly string[]): TuiArguments {
  let profile: string | undefined;
  let configPath: string | undefined;
  let workspacePath: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--profile") {
      profile = argv[index + 1];
      index += 1;
      if (!profile) throw new Error("--profile 값이 필요합니다");
    } else if (argument === "--config") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) throw new Error("--config 값이 필요합니다");
    } else if (argument === "--workspace") {
      workspacePath = argv[index + 1];
      index += 1;
      if (!workspacePath) throw new Error("--workspace 값이 필요합니다");
    } else throw new Error(`알 수 없는 TUI 인자입니다: ${String(argument)}`);
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
    help,
  };
}

const HELP = `Massion AgentOS 터미널 사용자 인터페이스\n\n사용법: massion [--profile <name>] [--config <path>] [--workspace <path>]\n기본값: 현재 디렉토리를 워크스페이스로 연결합니다.\n사전 준비: massion init으로 안전한 local profile을 생성해 주세요.\n`;

// workspace command 응답 data를 화면 상태로 변환합니다.
function decodeWorkspaceData(data: unknown): TuiWorkspace | undefined {
  if (!data || typeof data !== "object") return undefined;
  const workspace = data as Record<string, unknown>;
  if (
    typeof workspace.workspaceId !== "string" ||
    typeof workspace.name !== "string" ||
    typeof workspace.path !== "string" ||
    typeof workspace.trust !== "string" ||
    !Number.isSafeInteger(workspace.revision)
  )
    return undefined;
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: workspace.path,
    trust: workspace.trust,
    revision: workspace.revision as number,
  };
}

// 실행 디렉토리를 Workspace로 등록(멱등)하고 화면 상태에 연결합니다.
// 서버가 workspace 명령을 지원하지 않거나 실패하면 전역 모드로 계속합니다.
async function attachWorkspace(
  commands: TuiCommands,
  dispatch: (action: TuiAction) => void,
  path: string,
): Promise<void> {
  try {
    const registered = (await commands.registerWorkspace(path)) as { readonly data?: unknown };
    const decoded = decodeWorkspaceData(registered.data);
    if (decoded) dispatch({ type: "workspace.attached", workspace: decoded });
  } catch {
    // 전역 모드 유지: workspace 없이도 TUI는 동작해야 합니다.
  }
}

function isMissingConfig(error: unknown, configPath: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly path?: unknown };
  return candidate.code === "ENOENT" && (candidate.path === undefined || candidate.path === configPath);
}

async function loadView(
  controller: TuiController,
  dispatch: (action: TuiAction) => void,
  state: () => TuiState,
  view: TuiView,
) {
  const snapshot = state().snapshot;
  if (!snapshot) return;
  if (view === "chat") {
    await controller.refreshCurrentChatMessages();
    return;
  }
  if (view === "approvals") {
    const approvals = await controller.query("governance.approval.list", {});
    dispatch({ type: "query.loaded", key: "approvals", value: approvals });
    return;
  }
  if (view === "works") {
    const workId = state().selection.workId;
    if (workId) {
      const [records, timeline, provenance] = await Promise.allSettled([
        controller.query("work.records", { workId }),
        controller.query("work.timeline", { workId }),
        controller.query("work.provenance", { workId }),
      ]);
      if (records.status === "fulfilled") dispatch({ type: "query.loaded", key: "records", value: records.value });
      if (timeline.status === "fulfilled") dispatch({ type: "query.loaded", key: "timeline", value: timeline.value });
      if (provenance.status === "fulfilled")
        dispatch({ type: "query.loaded", key: "provenance", value: provenance.value });
    }
    return;
  }
  if (view === "operations") {
    const workId = state().selection.workId;
    const requests: Array<readonly [string, string, unknown]> = [
      ["routes", "router.routes", {}],
      ["credentials", "router.credentials", {}],
      ["growthConfiguration", "growth.configuration.get", {}],
      ["suggestions", "growth.suggestions", { limit: 100 }],
      ["effects", "growth.effects", { limit: 100 }],
      ["optimizationPolicy", "optimization.policy", {}],
      ["optimizationReceipts", "optimization.receipts", {}],
      ["optimizationRecommendations", "optimization.recommendations", {}],
      ["optimizationObservations", "optimization.observations", {}],
    ];
    if (workId) requests.push(["records", "work.records", { workId }]);
    const values = await Promise.allSettled(
      requests.map(async ([key, operation, payload]) => [key, await controller.query(operation, payload)] as const),
    );
    for (const value of values) {
      if (value.status === "fulfilled") dispatch({ type: "query.loaded", key: value.value[0], value: value.value[1] });
    }
    return;
  }
  if (view === "subscriptions") {
    const requests: Array<readonly [string, string]> = [
      ["subscriptionProviders", "subscription.providers"],
      ["subscriptionAccounts", "subscription.accounts"],
      ["subscriptionQuota", "subscription.quota"],
      ["subscriptionPolicy", "subscription.policy"],
      ["subscriptionDoctor", "subscription.doctor"],
    ];
    await Promise.all(
      requests.map(async ([key, operation]) => {
        try {
          dispatch({ type: "query.loaded", key, value: await controller.query(operation, {}) });
        } catch {
          dispatch({ type: "query.failed", key, error: "서버에서 이 구독 정보를 조회하지 못했습니다" });
        }
      }),
    );
  }
}

function selectedSubscriptionAccount(state: TuiState): {
  readonly accountId: string;
  readonly version: number;
  readonly canManage: boolean;
} {
  const accounts = Array.isArray(state.queryResults.subscriptionAccounts)
    ? state.queryResults.subscriptionAccounts.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const account = accounts.find((item) => item.accountId === state.selection.accountId) ?? accounts[0];
  if (typeof account?.accountId !== "string" || !Number.isSafeInteger(account.version))
    throw new Error("변경할 구독 계정이 선택되지 않았습니다");
  if (account.canManage !== true) throw new Error("구독 계정 소유자만 변경할 수 있습니다");
  return { accountId: account.accountId, version: account.version as number, canManage: true };
}

export async function runTui(
  argv = process.argv.slice(2),
  dependencies: {
    readonly createRenderer?: () => Promise<CliRenderer>;
    readonly write?: (value: string) => void;
  } = {},
): Promise<number> {
  let renderer: CliRenderer | undefined;
  try {
    const arguments_ = parseTuiArguments(argv);
    if (arguments_.help) {
      (dependencies.write ?? ((value: string) => process.stdout.write(value)))(HELP);
      return 0;
    }
    const configPath = arguments_.configPath ?? resolveTuiConfigPath();
    let profile;
    try {
      profile = await loadTuiProfile({
        ...(arguments_.profile === undefined ? {} : { profile: arguments_.profile }),
        configPath,
      });
    } catch (error) {
      if (isMissingConfig(error, configPath)) {
        throw new Error("Massion이 아직 초기화되지 않았습니다. 먼저 `massion init`을 실행해 온보딩을 완료해 주세요.", {
          cause: error,
        });
      }
      throw error;
    }
    const client = new ApplicationHttpClient({ baseUrl: profile.endpoint, token: profile.token });
    // solid-view(.tsx)는 vitest(node)에서 변환할 수 없으므로 실행 시점에만 불러옵니다.
    const { OpenTuiView } = await import("./open-tui.js");
    renderer = await (dependencies.createRenderer ?? (async () => await createCliRenderer({ exitOnCtrlC: false })))();
    const abort = new AbortController();
    renderer.on("destroy", () => {
      abort.abort();
    });
    let state = createTuiState();
    const bellEnabled = process.env.NO_BELL === undefined && process.stdout.isTTY;
    const dispatch = (action: TuiAction): void => {
      const previous = state;
      state = reduceTuiState(state, action);
      if (bellEnabled && shouldRingAttentionBell(previous, state)) process.stdout.write("\u0007");
      view.render();
    };
    const getState = (): TuiState => state;
    const controller = new TuiController(client, dispatch, getState);
    const commands = new TuiCommands(client, () => controller.identity.userId);
    await attachWorkspace(commands, dispatch, arguments_.workspacePath ?? process.cwd());
    try {
      dispatch({ type: "query.loaded", key: "autonomy", value: await controller.query("governance.autonomy", {}) });
    } catch {
      // 자율성 조회 실패는 표시 생략으로 처리합니다.
    }
    const refresh = async (): Promise<void> => {
      await controller.refresh();
    };
    const view = new OpenTuiView(renderer, {
      state: getState,
      dispatch,
      refresh,
      startWork: async (text) =>
        await commands.startRun(text, state.workspaceScope ? state.workspace?.workspaceId : undefined),
      toggleAutonomy: async () => {
        const current = state.queryResults.autonomy as { mode?: unknown; revision?: unknown } | undefined;
        const mode = current?.mode === "review" ? "automatic" : "review";
        const revision = Number.isSafeInteger(current?.revision) ? (current?.revision as number) : 0;
        const result = (await commands.setAutonomyMode(mode, revision)) as { readonly data?: unknown };
        dispatch({ type: "query.loaded", key: "autonomy", value: result.data });
        return mode;
      },
      trustWorkspace: async () => {
        const workspace = state.workspace;
        if (!workspace) throw new Error("연결된 워크스페이스가 없습니다");
        const result = (await commands.trustWorkspace(workspace.workspaceId, workspace.revision)) as {
          readonly data?: unknown;
        };
        const decoded = decodeWorkspaceData(result.data);
        if (decoded) dispatch({ type: "workspace.attached", workspace: decoded });
        return result;
      },
      postMessage: async (content) => {
        const { workId, roomId } = state.selection;
        if (!workId || !roomId) throw new Error("메시지를 보낼 협업방이 선택되지 않았습니다");
        return await commands.postMessage({ workId, roomId, content });
      },
      vote: async (vote, reason) => {
        const approvalId = state.selection.approvalId;
        if (!approvalId) throw new Error("투표할 승인 요청이 선택되지 않았습니다");
        return await commands.vote({ approvalId, vote, reason });
      },
      cancelApproval: async (reason) => {
        const approvalId = state.selection.approvalId;
        if (!approvalId) throw new Error("취소할 승인 요청이 선택되지 않았습니다");
        return await commands.cancelApproval(approvalId, reason);
      },
      cancelWork: async () => {
        const work = state.snapshot?.works.find((item) => item.workId === state.selection.workId);
        if (!work) throw new Error("취소할 업무가 선택되지 않았습니다");
        return await commands.cancelWork({ workId: work.workId, revision: work.revision });
      },
      assignTask: async (agentHandle) => {
        const work = state.snapshot?.works.find((item) => item.workId === state.selection.workId);
        const task = state.snapshot?.tasks.find(
          (item) => item.workId === work?.workId && !["completed", "cancelled"].includes(item.status),
        );
        if (!work || !task) throw new Error("배정할 활성 작업이 없습니다");
        return await commands.assignTask({
          workId: work.workId,
          taskId: task.taskId,
          agentHandle,
          revision: work.revision,
        });
      },
      controlExecution: async (operation, reason) => {
        const execution = state.snapshot?.executions.find((item) => item.workId === state.selection.workId);
        if (!execution) throw new Error("제어할 실행이 선택되지 않았습니다");
        if (operation === "cancel") return await commands.cancelExecution(execution.executionId, reason);
        if (operation === "suspend") return await commands.suspendExecution(execution.executionId, reason);
        return await commands.resumeExecution(execution.executionId, { reason });
      },
      shareSubscriptionAccount: async (accountId, version) => {
        const account = selectedSubscriptionAccount(state);
        if (account.accountId !== accountId || account.version !== version)
          throw new Error("구독 계정 version이 변경되었습니다");
        return await commands.shareSubscriptionAccount(accountId, version);
      },
      unshareSubscriptionAccount: async (accountId, version) => {
        const account = selectedSubscriptionAccount(state);
        if (account.accountId !== accountId || account.version !== version)
          throw new Error("구독 계정 version이 변경되었습니다");
        return await commands.unshareSubscriptionAccount(accountId, version);
      },
      disconnectSubscriptionAccount: async (accountId, version) => {
        const account = selectedSubscriptionAccount(state);
        if (account.accountId !== accountId || account.version !== version)
          throw new Error("구독 계정 version이 변경되었습니다");
        return await commands.disconnectSubscriptionAccount(accountId, version);
      },
      configureSubscriptionPolicy: async (providerId, credentialPolicy, approvalMode, version) =>
        await commands.configureSubscriptionPolicy(providerId, credentialPolicy, approvalMode, version),
      optimizationCommand: async (operation, payload) => await commands.optimizationCommand(operation, payload),
      loadView: async (selectedView) => {
        await loadView(controller, dispatch, getState, selectedView);
      },
      destroy: () => {
        renderer?.destroy();
      },
    });
    view.render();
    await view.ready;
    // 휘발성 실행 델타 구독: 끊기면 1초 후 재연결하고, 복구 정본은 work.timeline 재조회가 담당합니다.
    const aborted = (): boolean => abort.signal.aborted;
    const streamDeltas = async (): Promise<void> => {
      while (!aborted()) {
        try {
          for await (const raw of client.streamExecutionDeltas(undefined, abort.signal)) {
            const delta = decodeExecutionDelta(raw);
            if (delta) dispatch({ type: "stream.delta", delta });
          }
        } catch {
          // 연결 실패·중단은 재시도로 처리합니다.
        }
        if (aborted()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    };
    void streamDeltas();
    await controller.run(abort.signal);
    return 0;
  } catch (error) {
    renderer?.destroy();
    (dependencies.write ?? ((value: string) => process.stderr.write(value)))(
      `${error instanceof Error ? error.message : "알 수 없는 TUI 오류"}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]))
  process.exitCode = await runTui();
