#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { ApplicationHttpClient } from "@massion/application";
import { createCliRenderer, type CliRenderer } from "@opentui/core";

import { TuiCommands } from "./commands.js";
import { TuiController } from "./controller.js";
import { OpenTuiView } from "./open-tui.js";
import { loadTuiProfile, resolveTuiConfigPath } from "./profile.js";
import { createTuiState, reduceTuiState, type TuiAction, type TuiState, type TuiView } from "./state.js";

export interface TuiArguments {
  readonly profile?: string;
  readonly configPath?: string;
  readonly help: boolean;
}

export function parseTuiArguments(argv: readonly string[]): TuiArguments {
  let profile: string | undefined;
  let configPath: string | undefined;
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
    } else throw new Error(`알 수 없는 TUI 인자입니다: ${String(argument)}`);
  }
  return { ...(profile === undefined ? {} : { profile }), ...(configPath === undefined ? {} : { configPath }), help };
}

const HELP = `Massion AgentOS 터미널 사용자 인터페이스\n\n사용법: massion [--profile <name>] [--config <path>]\n사전 준비: massion init으로 안전한 local profile을 생성해 주세요.\n`;

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
    const workId = state().selection.workId;
    const roomId = state().selection.roomId;
    if (workId && roomId) {
      const messages = await controller.query("work.messages", { workId, roomId });
      dispatch({ type: "query.loaded", key: "messages", value: messages });
    }
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
      const records = await controller.query("work.records", { workId });
      dispatch({ type: "query.loaded", key: "records", value: records });
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
    renderer = await (dependencies.createRenderer ?? (async () => await createCliRenderer({ exitOnCtrlC: false })))();
    const abort = new AbortController();
    renderer.on("destroy", () => {
      abort.abort();
    });
    let state = createTuiState();
    const dispatch = (action: TuiAction): void => {
      state = reduceTuiState(state, action);
      view.render();
    };
    const getState = (): TuiState => state;
    const controller = new TuiController(client, dispatch, getState);
    const commands = new TuiCommands(client, () => controller.identity.userId);
    const refresh = async (): Promise<void> => {
      await controller.refresh();
    };
    const view = new OpenTuiView(renderer, {
      state: getState,
      dispatch,
      refresh,
      startWork: async (text) => await commands.startRun(text),
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
