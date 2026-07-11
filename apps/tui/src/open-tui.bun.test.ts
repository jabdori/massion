import { afterEach, describe, expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";
import { KeyEvent } from "@opentui/core";

import { OpenTuiView } from "./open-tui.js";
import { createTuiState, reduceTuiState } from "./state.js";
import { testSnapshot } from "./state.test.js";
import { decodeSnapshot } from "./wire.js";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

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
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
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
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
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
      postMessage: () => Promise.resolve(),
      vote: () => Promise.resolve(),
      cancelApproval: () => Promise.resolve(),
      cancelWork: () => Promise.resolve(),
      assignTask: () => Promise.resolve(),
      controlExecution: () => Promise.resolve(),
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
});
