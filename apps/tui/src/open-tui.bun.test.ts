import { afterEach, describe, expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";
import { InputRenderable, KeyEvent } from "@opentui/core";

import { OpenTuiView } from "./open-tui.js";
import { createTuiState, reduceTuiState } from "./state.js";
import { testSnapshot } from "./state.test.js";
import { decodeSnapshot } from "./wire.js";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

function emitKey(name: string): void {
  setup?.renderer.keyInput.emit(
    "keypress",
    new KeyEvent({
      name,
      sequence: name,
      raw: name,
      number: false,
      source: "raw",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    }),
  );
}

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("OpenTUI 실제 renderer", () => {
  test("협업 상태와 키보드 도움말을 120×40 frame에 그린다", async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });
    const state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: () => undefined,
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Massion AgentOS");
    expect(frame).toContain("진행 중 업무");
    expect(frame).toContain("Ctrl+C 종료");
  });

  test("80×24 미만에서는 잘린 정보 대신 최소 크기를 안내한다", async () => {
    setup = await createTestRenderer({ width: 60, height: 20 });
    const state = createTuiState();
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: () => undefined,
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("최소 80×24");
  });

  test("대화 단축키는 입력을 열고 Ctrl+C 첫 입력은 modal만 닫는다", async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    state = reduceTuiState(state, { type: "view.selected", view: "chat" });
    let destroyed = false;
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      loadView: () => Promise.resolve(),
      destroy: () => {
        destroyed = true;
      },
    });
    view.render();
    setup.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "c",
        sequence: "c",
        raw: "c",
        number: false,
        source: "raw",
        ctrl: false,
        shift: false,
        meta: false,
        option: false,
        eventType: "press",
        repeated: false,
      }),
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("협업방에 메시지 보내기");
    setup.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "c",
        sequence: "\u0003",
        raw: "\u0003",
        number: false,
        source: "raw",
        ctrl: true,
        shift: false,
        meta: false,
        option: false,
        eventType: "press",
        repeated: false,
      }),
    );
    await setup.renderOnce();
    expect(destroyed).toBe(false);
    expect(setup.captureCharFrame()).not.toContain("협업방에 메시지 보내기");
  });

  test("새 업무 단축키는 빈 입력을 보내지 않고 성공하면 업무 화면을 선택한다", async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    const started: string[] = [];
    const loaded: string[] = [];
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: (text) => (started.push(text), Promise.resolve()),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      loadView: (selected) => (loaded.push(selected), Promise.resolve()),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();

    emitKey("n");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("새 업무 시작");

    let input = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    input.value = "   ";
    input.submit();
    await Bun.sleep(0);
    expect(started).toEqual([]);
    expect(setup.captureCharFrame()).toContain("업무 내용을 입력해 주세요");

    input = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    input.value = "릴리스 준비 상태를 점검해 주세요";
    input.submit();
    await Bun.sleep(0);
    await setup.renderOnce();

    expect(started).toEqual(["릴리스 준비 상태를 점검해 주세요"]);
    expect(loaded).toEqual(["works"]);
    expect(state.view).toBe("works");
    expect(setup.captureCharFrame()).toContain("새 업무 요청을 시작했습니다");
  });

  test("구독 계정을 80×24에서 선택하고 공유·공유 해제·연결 해제를 각각 확인한 뒤 실행한다", async () => {
    setup = await createTestRenderer({ width: 80, height: 24 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "accounts" });
    const account = (scope: string, accountId = "account-1", alias = "업무용 Codex") => ({
      accountId,
      providerId: "openai-codex",
      alias,
      scope,
      canManage: true,
      status: "active",
      version: 7,
      connectorStatus: "ready",
      token: "never-render-token",
      ownerUserId: "never-render-owner",
      profileFingerprint: "never-render-fingerprint",
      publicKey: "never-render-public-key",
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionAccounts",
      value: [account("personal"), account("personal", "account-2", "개인 Codex")],
    });
    const calls: string[] = [];
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => (calls.push("share"), Promise.resolve()),
      unshareSubscriptionAccount: () => (calls.push("unshare"), Promise.resolve()),
      disconnectSubscriptionAccount: () => (calls.push("disconnect"), Promise.resolve()),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();
    await setup.renderOnce();
    const initial = setup.captureCharFrame();
    expect(initial).toContain("업무용 Codex");
    for (const forbidden of [
      "never-render-token",
      "never-render-owner",
      "never-render-fingerprint",
      "never-render-public-key",
    ])
      expect(initial).not.toContain(forbidden);

    emitKey("j");
    expect(state.selection.accountId).toBe("account-2");
    emitKey("k");
    expect(state.selection.accountId).toBe("account-1");

    emitKey("s");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("계정 공유 확인");
    expect(calls).toEqual([]);
    const shareInput = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    shareInput.value = "SHARE";
    shareInput.submit();
    await Bun.sleep(0);
    expect(calls).toEqual(["share"]);

    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionAccounts",
      value: [account("organization")],
    });
    view.render();
    emitKey("u");
    const unshareInput = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    unshareInput.value = "UNSHARE";
    unshareInput.submit();
    await Bun.sleep(0);
    expect(calls).toEqual(["share", "unshare"]);

    emitKey("d");
    const disconnectInput = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    disconnectInput.value = "DISCONNECT";
    disconnectInput.submit();
    await Bun.sleep(0);
    expect(calls).toEqual(["share", "unshare", "disconnect"]);
  });

  test("구독 정책 탭에서 계정 선택 정책과 승인 방식을 함께 변경한다", async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "policy" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionProviders",
      value: [
        {
          providerId: "openai-codex",
          displayName: "OpenAI Codex",
          connectionSurface: "server-and-edge",
          credentialPolicies: ["adaptive", "round-robin"],
          runtimeCapabilities: {
            approvalModes: ["automatic", "deny"],
            approvalModesBySurface: {
              server: ["automatic", "review", "deny"],
              edge: ["automatic", "deny"],
            },
          },
        },
      ],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionAccounts",
      value: [{ accountId: "codex-edge", providerId: "openai-codex", connectorLocation: "edge" }],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionPolicy",
      value: [{ providerId: "openai-codex", credentialPolicy: "adaptive", approvalMode: "review", version: 4 }],
    });
    const calls: unknown[] = [];
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      configureSubscriptionPolicy: (...input) => (calls.push(input), Promise.resolve()),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();

    emitKey("e");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("구독 정책 변경");
    const rejected = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    rejected.value = "round-robin review";
    rejected.submit();
    await Bun.sleep(0);
    expect(calls).toEqual([]);
    expect(setup.captureCharFrame()).toContain("automatic, deny");

    const input = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    input.value = "round-robin automatic";
    input.submit();
    await Bun.sleep(0);

    expect(calls).toEqual([["openai-codex", "round-robin", "automatic", 4]]);
  });

  test("공개 연결 표면이 unavailable인 Provider는 정책 modal을 열지 않는다", async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "policy" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionProviders",
      value: [
        {
          providerId: "google-antigravity-cli",
          displayName: "Google Antigravity CLI",
          connectionSurface: "unavailable",
          credentialPolicies: ["adaptive"],
          runtimeCapabilities: {},
        },
      ],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionPolicy",
      value: [{ providerId: "google-antigravity-cli", credentialPolicy: "adaptive", approvalMode: "deny", version: 1 }],
    });
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      configureSubscriptionPolicy: () => Promise.resolve(),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();

    emitKey("e");
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("modal-input")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("공개 연결을 지원하지 않습니다");
  });

  test("운영 화면의 모델 평가실 modal은 JSON mutation을 허용 목록 command로 전달한다", async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    let state = reduceTuiState(createTuiState(), {
      type: "snapshot.loaded",
      snapshot: decodeSnapshot(testSnapshot),
    });
    const calls: Array<{ readonly operation: string; readonly payload: Record<string, unknown> }> = [];
    const view = new OpenTuiView(setup.renderer, {
      state: () => state,
      dispatch: (action) => {
        state = reduceTuiState(state, action);
      },
      refresh: () => Promise.resolve(),
      startWork: () => Promise.resolve(),
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
      shareSubscriptionAccount: () => Promise.resolve(),
      unshareSubscriptionAccount: () => Promise.resolve(),
      disconnectSubscriptionAccount: () => Promise.resolve(),
      optimizationCommand: (operation, payload) => (calls.push({ operation, payload }), Promise.resolve()),
      loadView: () => Promise.resolve(),
      destroy: () => setup?.renderer.destroy(),
    });
    view.render();

    emitKey("6");
    emitKey("o");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("모델 평가실 변경");
    const input = setup.renderer.root.findDescendantById("modal-input") as InputRenderable;
    input.value = '{"operation":"optimization.batch.activate","payload":{"batchId":"batch-uat"}}';
    input.submit();
    await Bun.sleep(0);

    expect(calls).toEqual([{ operation: "optimization.batch.activate", payload: { batchId: "batch-uat" } }]);
  });
});
