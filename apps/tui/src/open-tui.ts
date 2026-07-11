import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";

import { present, safeTerminalText } from "./presentation.js";
import type { TuiAction, TuiState, TuiView } from "./state.js";
import { layoutForTerminal } from "./view-model.js";

interface OpenTuiActions {
  readonly state: () => TuiState;
  readonly dispatch: (action: TuiAction) => void;
  readonly refresh: () => Promise<void>;
  readonly postMessage: (content: string) => Promise<unknown>;
  readonly vote: (vote: "approve" | "reject", reason: string) => Promise<unknown>;
  readonly cancelApproval: (reason: string) => Promise<unknown>;
  readonly cancelWork: (reason: string) => Promise<unknown>;
  readonly assignTask: (agentHandle: string) => Promise<unknown>;
  readonly controlExecution: (operation: "cancel" | "suspend" | "resume", reason: string) => Promise<unknown>;
  readonly loadView: (view: TuiView) => Promise<void>;
  readonly destroy: () => void;
}

type Modal =
  | { readonly kind: "message"; readonly title: string; readonly placeholder: string }
  | { readonly kind: "search"; readonly title: string; readonly placeholder: string }
  | { readonly kind: "vote"; readonly title: string; readonly placeholder: string; readonly vote: "approve" | "reject" }
  | { readonly kind: "cancel-work"; readonly title: string; readonly placeholder: string }
  | { readonly kind: "cancel-approval"; readonly title: string; readonly placeholder: string }
  | { readonly kind: "assign-task"; readonly title: string; readonly placeholder: string }
  | {
      readonly kind: "runtime";
      readonly title: string;
      readonly placeholder: string;
      readonly operation: "cancel" | "suspend" | "resume";
    }
  | { readonly kind: "help"; readonly title: string; readonly placeholder: string };

const VIEW_KEYS: Readonly<Record<string, TuiView>> = {
  "1": "overview",
  "2": "agents",
  "3": "works",
  "4": "chat",
  "5": "approvals",
  "6": "operations",
};

export class OpenTuiView {
  private tree: Renderable | undefined;
  private input: InputRenderable | undefined;
  private modal: Modal | undefined;
  private search = "";
  private busy = false;
  private notice = "";
  private readonly noColor = process.env.NO_COLOR !== undefined;

  public constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: OpenTuiActions,
  ) {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      void this.key(key);
    });
    this.renderer.on("resize", () => {
      this.render();
    });
  }

  public render(): void {
    if (this.tree) {
      this.renderer.root.remove(this.tree);
      this.tree.destroyRecursively();
    }
    const layout = layoutForTerminal(this.renderer.width, this.renderer.height);
    if (layout.mode === "unsupported") {
      const root = new BoxRenderable(this.renderer, {
        id: "massion-tui-small",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      });
      root.add(
        new TextRenderable(this.renderer, {
          content: `Massion TUI는 최소 80×24가 필요합니다.\n현재 크기: ${String(layout.width)}×${String(layout.height)}`,
          ...this.paint("fg", "#F3B35B"),
          attributes: TextAttributes.BOLD,
        }),
      );
      this.tree = root;
      this.renderer.root.add(root);
      return;
    }

    const output = present(this.actions.state());
    const root = new BoxRenderable(this.renderer, {
      id: "massion-tui-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      ...this.paint("backgroundColor", "#0B0D10"),
    });
    root.add(this.header(output.title));
    root.add(this.navigation(output.navigation));
    const body = new BoxRenderable(this.renderer, {
      id: "body",
      flexDirection: "row",
      flexGrow: 1,
      width: "100%",
      gap: 1,
      paddingX: 1,
    });
    const list = this.filtered(output.list);
    const detail = this.filtered(output.detail);
    body.add(this.panel("목록 / 맵", list, layout.mode === "wide" ? "46%" : "40%"));
    body.add(this.panel("상세", detail, layout.mode === "wide" ? "54%" : "60%"));
    root.add(body);
    if (this.modal) root.add(this.modalPanel());
    root.add(this.footer(this.notice || output.footer));
    this.tree = root;
    this.renderer.root.add(root);
    this.input?.focus();
    this.renderer.requestRender();
  }

  private paint<Key extends string>(key: Key, value: string): Partial<Record<Key, string>> {
    return this.noColor ? {} : ({ [key]: value } as Record<Key, string>);
  }

  private header(content: string): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      id: "header",
      height: 3,
      width: "100%",
      paddingX: 2,
      alignItems: "center",
      ...this.paint("backgroundColor", "#151A21"),
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: safeTerminalText(content, 512),
        ...this.paint("fg", "#8BD5CA"),
        attributes: TextAttributes.BOLD,
      }),
    );
    return box;
  }

  private navigation(content: string): BoxRenderable {
    const box = new BoxRenderable(this.renderer, { height: 3, width: "100%", paddingX: 2, alignItems: "center" });
    box.add(new TextRenderable(this.renderer, { content, ...this.paint("fg", "#C6D0F5") }));
    return box;
  }

  private panel(title: string, content: string, width: `${number}%`): BoxRenderable {
    const panel = new BoxRenderable(this.renderer, {
      width,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      ...this.paint("borderColor", "#414559"),
      title,
      titleAlignment: "left",
      padding: 1,
      overflow: "hidden",
    });
    panel.add(
      new TextRenderable(this.renderer, {
        content: safeTerminalText(content),
        ...this.paint("fg", "#C6D0F5"),
        selectable: true,
        width: "100%",
      }),
    );
    return panel;
  }

  private footer(content: string): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      height: 2,
      width: "100%",
      paddingX: 2,
      alignItems: "center",
      ...this.paint("backgroundColor", "#151A21"),
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: safeTerminalText(content, 512),
        ...this.paint("fg", "#A5ADCE"),
      }),
    );
    return box;
  }

  private modalPanel(): BoxRenderable {
    const modal = this.modal;
    const box = new BoxRenderable(this.renderer, {
      height: modal?.kind === "help" ? 8 : 5,
      width: "100%",
      border: true,
      borderStyle: "double",
      ...this.paint("borderColor", "#F3B35B"),
      title: modal?.title ?? "입력",
      paddingX: 1,
      flexDirection: "column",
    });
    if (modal?.kind === "help") {
      box.add(
        new TextRenderable(this.renderer, {
          content:
            "1–6 화면 이동 · j/k 또는 화살표 항목 이동 · r 새로고침 · / 검색\n" +
            "c 메시지 · a 승인 · x 거절 · Delete 승인 취소 · d 업무 취소 · t 작업 배정\n" +
            "s 실행 일시정지/재개 · z 실행 취소\n" +
            "Esc 입력 닫기 · Ctrl+C 입력 취소/종료 · 선택한 텍스트는 복사할 수 있습니다.",
          ...this.paint("fg", "#C6D0F5"),
        }),
      );
      return box;
    }
    const input = new InputRenderable(this.renderer, {
      id: "modal-input",
      width: "100%",
      value: "",
      placeholder: modal?.placeholder ?? "입력 후 Enter",
      maxLength: 65_536,
      ...this.paint("backgroundColor", "#232634"),
      ...this.paint("textColor", "#C6D0F5"),
      ...this.paint("cursorColor", "#8BD5CA"),
    });
    input.on(InputRenderableEvents.ENTER, () => {
      void this.submit(input.value);
    });
    box.add(input);
    this.input = input;
    return box;
  }

  private filtered(content: string): string {
    if (!this.search) return content;
    const query = this.search.toLocaleLowerCase();
    const lines = content.split("\n").filter((line) => line.toLocaleLowerCase().includes(query));
    return lines.length ? lines.join("\n") : `검색 결과가 없습니다: ${safeTerminalText(this.search, 128)}`;
  }

  private async key(key: KeyEvent): Promise<void> {
    if (key.eventType === "release") return;
    if (this.modal) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        this.modal = undefined;
        this.input = undefined;
        this.render();
      }
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.actions.destroy();
      return;
    }
    const view = VIEW_KEYS[key.name];
    if (view) {
      this.actions.dispatch({ type: "view.selected", view });
      this.render();
      await this.actions.loadView(view);
      return;
    }
    if (key.name === "r")
      await this.runAction(async () => {
        await this.actions.refresh();
      });
    else if (key.name === "?") this.open({ kind: "help", title: "키보드 도움말", placeholder: "" });
    else if (key.name === "/")
      this.open({ kind: "search", title: "현재 화면 검색", placeholder: "검색어를 입력해 주세요" });
    else if (key.name === "c" && this.actions.state().view === "chat")
      this.open({ kind: "message", title: "협업방에 메시지 보내기", placeholder: "메시지를 입력해 주세요" });
    else if (key.name === "a" && this.actions.state().view === "approvals")
      this.open({ kind: "vote", vote: "approve", title: "승인 이유", placeholder: "승인 근거를 입력해 주세요" });
    else if (key.name === "x" && this.actions.state().view === "approvals")
      this.open({ kind: "vote", vote: "reject", title: "거절 이유", placeholder: "거절 근거를 입력해 주세요" });
    else if (key.name === "delete" && this.actions.state().view === "approvals")
      this.open({
        kind: "cancel-approval",
        title: "승인 요청 취소",
        placeholder: "승인 요청을 취소하는 이유를 입력해 주세요",
      });
    else if (key.name === "d" && this.actions.state().view === "works")
      this.open({ kind: "cancel-work", title: "업무 취소 확인", placeholder: "취소 이유를 입력해 주세요" });
    else if (key.name === "t" && this.actions.state().view === "works")
      this.open({ kind: "assign-task", title: "작업 배정·재배정", placeholder: "에이전트 handle을 입력해 주세요" });
    else if (key.name === "s" && this.actions.state().view === "works") {
      const execution = this.selectedExecution();
      if (execution) {
        const operation = execution.status === "suspended" ? "resume" : "suspend";
        this.open({
          kind: "runtime",
          operation,
          title: operation === "resume" ? "실행 재개 확인" : "실행 일시정지 확인",
          placeholder: operation === "resume" ? "재개 이유를 입력해 주세요" : "일시정지 이유를 입력해 주세요",
        });
      }
    } else if (key.name === "z" && this.actions.state().view === "works" && this.selectedExecution()) {
      this.open({
        kind: "runtime",
        operation: "cancel",
        title: "실행 취소 확인",
        placeholder: "실행을 취소하는 이유를 입력해 주세요",
      });
    } else if (["j", "down", "k", "up"].includes(key.name)) {
      this.moveSelection(["j", "down"].includes(key.name) ? 1 : -1);
    }
  }

  private open(modal: Modal): void {
    this.modal = modal;
    this.notice = "";
    this.render();
  }

  private async submit(value: string): Promise<void> {
    const modal = this.modal;
    if (!modal) return;
    const content = value.trim();
    if (!content && modal.kind !== "search") {
      this.notice = "내용 또는 이유를 입력해야 합니다.";
      this.render();
      return;
    }
    this.modal = undefined;
    this.input = undefined;
    if (modal.kind === "search") {
      this.search = content;
      this.render();
      return;
    }
    await this.runAction(async () => {
      if (modal.kind === "message") await this.actions.postMessage(content);
      else if (modal.kind === "vote") await this.actions.vote(modal.vote, content);
      else if (modal.kind === "cancel-approval") await this.actions.cancelApproval(content);
      else if (modal.kind === "cancel-work") await this.actions.cancelWork(content);
      else if (modal.kind === "assign-task") await this.actions.assignTask(content);
      else if (modal.kind === "runtime") await this.actions.controlExecution(modal.operation, content);
    });
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = "요청을 서버에서 처리하고 있습니다…";
    this.render();
    try {
      await action();
      this.notice = "서버 정본에 반영되었습니다.";
      await this.actions.loadView(this.actions.state().view);
    } catch {
      this.notice = "요청을 완료하지 못했습니다. 서버 정책과 연결 상태를 확인해 주세요.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private selectedExecution(): { readonly executionId: string; readonly status: string } | undefined {
    const state = this.actions.state();
    return state.snapshot?.executions.find((execution) => execution.workId === state.selection.workId);
  }

  private moveSelection(delta: number): void {
    const state = this.actions.state();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const values =
      state.view === "agents"
        ? snapshot.nodes.map((item) => item.handle)
        : state.view === "works"
          ? snapshot.works.map((item) => item.workId)
          : state.view === "chat"
            ? snapshot.rooms
                .filter((item) => !state.selection.workId || item.workId === state.selection.workId)
                .map((item) => item.roomId)
            : state.view === "approvals"
              ? snapshot.pendingApprovals.map((item) => item.approvalId)
              : [];
    if (!values.length) return;
    const current =
      state.view === "agents"
        ? state.selection.agentHandle
        : state.view === "works"
          ? state.selection.workId
          : state.view === "chat"
            ? state.selection.roomId
            : state.selection.approvalId;
    const index = current === undefined ? 0 : Math.max(0, values.indexOf(current));
    const next = values[(index + delta + values.length) % values.length];
    if (!next) return;
    const selection =
      state.view === "agents"
        ? { agentHandle: next }
        : state.view === "works"
          ? { workId: next }
          : state.view === "chat"
            ? { roomId: next }
            : { approvalId: next };
    this.actions.dispatch({ type: "selection.changed", selection });
    this.render();
    void this.actions.loadView(state.view);
  }
}
