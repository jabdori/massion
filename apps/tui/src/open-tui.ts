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
import type { TuiAction, TuiState, TuiSubscriptionTab, TuiView } from "./state.js";
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
  readonly shareSubscriptionAccount: (accountId: string, version: number) => Promise<unknown>;
  readonly unshareSubscriptionAccount: (accountId: string, version: number) => Promise<unknown>;
  readonly disconnectSubscriptionAccount: (accountId: string, version: number) => Promise<unknown>;
  readonly configureSubscriptionPolicy?: (
    providerId: string,
    credentialPolicy: string,
    approvalMode: "automatic" | "review" | "deny",
    version: number,
  ) => Promise<unknown>;
  readonly optimizationCommand?: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly loadView: (view: TuiView) => Promise<void>;
  readonly destroy: () => void;
}

type ApprovalMode = "automatic" | "review" | "deny";
const APPROVAL_MODES: readonly ApprovalMode[] = ["automatic", "review", "deny"];

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
  | {
      readonly kind: "subscription-account";
      readonly title: string;
      readonly placeholder: string;
      readonly operation: "share" | "unshare" | "disconnect";
      readonly confirmation: "SHARE" | "UNSHARE" | "DISCONNECT";
      readonly accountId: string;
      readonly version: number;
    }
  | {
      readonly kind: "subscription-policy";
      readonly title: string;
      readonly placeholder: string;
      readonly providerId: string;
      readonly version: number;
      readonly credentialPolicies: readonly string[];
      readonly approvalModes: readonly ApprovalMode[];
    }
  | { readonly kind: "optimization"; readonly title: string; readonly placeholder: string }
  | { readonly kind: "help"; readonly title: string; readonly placeholder: string };

const VIEW_KEYS: Readonly<Record<string, TuiView>> = {
  "1": "overview",
  "2": "agents",
  "3": "works",
  "4": "chat",
  "5": "approvals",
  "6": "operations",
  "7": "subscriptions",
};

const SUBSCRIPTION_TABS: readonly TuiSubscriptionTab[] = ["providers", "accounts", "quota", "policy"];

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
      const previous = this.tree;
      this.tree = undefined;
      if (this.renderer.root.getChildren().includes(previous)) this.renderer.root.remove(previous);
      else previous.parent = null;
      previous.destroyRecursively();
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
            "1–7 화면 이동 · j/k 또는 화살표 항목 이동 · r 새로고침 · / 검색\n" +
            "c 메시지 · a 승인 · x 거절 · Delete 승인 취소 · d 업무 취소 · t 작업 배정\n" +
            "구독: ←/→ 또는 h/l 탭 · s 공유 · u 공유 해제 · d 연결 해제\n" +
            "s 실행 일시정지/재개 · z 실행 취소\n" +
            '모델 평가실(운영 화면): operations에서 o · JSON {"operation":"...","payload":{...}}\n' +
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

  private dispose(): void {
    const tree = this.tree;
    this.tree = undefined;
    if (tree) {
      if (this.renderer.root.getChildren().includes(tree)) this.renderer.root.remove(tree);
      else tree.parent = null;
      tree.destroyRecursively();
    }
    this.actions.destroy();
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
      this.dispose();
      return;
    }
    const view = VIEW_KEYS[key.name];
    if (view) {
      this.actions.dispatch({ type: "view.selected", view });
      this.render();
      await this.actions.loadView(view);
      return;
    }
    if (this.actions.state().view === "subscriptions" && ["[", "]", "h", "left", "l", "right"].includes(key.name)) {
      const delta = ["]", "l", "right"].includes(key.name) ? 1 : -1;
      const current = SUBSCRIPTION_TABS.indexOf(this.actions.state().subscriptionTab);
      const tab = SUBSCRIPTION_TABS[(current + delta + SUBSCRIPTION_TABS.length) % SUBSCRIPTION_TABS.length];
      if (tab) this.actions.dispatch({ type: "subscription.tab.selected", tab });
      this.render();
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
    } else if (
      this.actions.state().view === "subscriptions" &&
      this.actions.state().subscriptionTab === "accounts" &&
      ["s", "u", "d"].includes(key.name)
    ) {
      this.openSubscriptionAccountAction(key.name === "s" ? "share" : key.name === "u" ? "unshare" : "disconnect");
    } else if (
      key.name === "e" &&
      this.actions.state().view === "subscriptions" &&
      this.actions.state().subscriptionTab === "policy"
    ) {
      this.openSubscriptionPolicyAction();
    } else if (key.name === "o" && this.actions.state().view === "operations") {
      this.open({
        kind: "optimization",
        title: "모델 평가실 변경",
        placeholder: '{"operation":"optimization.batch.activate","payload":{"batchId":"..."}}',
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
    if (modal.kind === "subscription-account" && content !== modal.confirmation) {
      this.notice = `확인하려면 ${modal.confirmation}를 정확히 입력해 주세요.`;
      this.render();
      return;
    }
    let subscriptionPolicyInput:
      { readonly credentialPolicy: string; readonly approvalMode: "automatic" | "review" | "deny" } | undefined;
    if (modal.kind === "subscription-policy") {
      const [credentialPolicy, approvalMode, extra] = content.split(/\s+/u);
      if (
        !credentialPolicy ||
        !approvalMode ||
        extra !== undefined ||
        !modal.credentialPolicies.includes(credentialPolicy) ||
        !modal.approvalModes.includes(approvalMode as ApprovalMode)
      ) {
        this.notice = `계정 선택 정책과 ${modal.approvalModes.join(", ")} 중 하나를 공백으로 구분해 입력해 주세요.`;
        this.render();
        return;
      }
      subscriptionPolicyInput = {
        credentialPolicy,
        approvalMode: approvalMode as "automatic" | "review" | "deny",
      };
    }
    let optimizationInput: { readonly operation: string; readonly payload: Record<string, unknown> } | undefined;
    if (modal.kind === "optimization") {
      try {
        const parsed: unknown = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
        const value = parsed as Record<string, unknown>;
        if (
          typeof value.operation !== "string" ||
          !value.payload ||
          typeof value.payload !== "object" ||
          Array.isArray(value.payload)
        )
          throw new Error("operation/payload");
        optimizationInput = { operation: value.operation, payload: value.payload as Record<string, unknown> };
      } catch {
        this.notice = "operation과 object payload가 있는 JSON을 입력해 주세요.";
        this.render();
        return;
      }
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
      else if (modal.kind === "subscription-account") {
        if (modal.operation === "share") await this.actions.shareSubscriptionAccount(modal.accountId, modal.version);
        else if (modal.operation === "unshare")
          await this.actions.unshareSubscriptionAccount(modal.accountId, modal.version);
        else await this.actions.disconnectSubscriptionAccount(modal.accountId, modal.version);
      } else if (modal.kind === "subscription-policy" && subscriptionPolicyInput) {
        if (!this.actions.configureSubscriptionPolicy) throw new Error("TUI 구독 정책 변경 기능이 구성되지 않았습니다");
        await this.actions.configureSubscriptionPolicy(
          modal.providerId,
          subscriptionPolicyInput.credentialPolicy,
          subscriptionPolicyInput.approvalMode,
          modal.version,
        );
      } else if (modal.kind === "optimization" && optimizationInput) {
        if (!this.actions.optimizationCommand) throw new Error("TUI 모델 평가실 변경 기능이 구성되지 않았습니다");
        await this.actions.optimizationCommand(optimizationInput.operation, optimizationInput.payload);
      }
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

  private selectedSubscriptionAccount():
    | {
        readonly accountId: string;
        readonly alias: string;
        readonly scope: string;
        readonly version: number;
        readonly canManage: boolean;
      }
    | undefined {
    const state = this.actions.state();
    const accounts = Array.isArray(state.queryResults.subscriptionAccounts)
      ? state.queryResults.subscriptionAccounts.filter(
          (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const account = accounts.find((item) => item.accountId === state.selection.accountId) ?? accounts[0];
    if (
      typeof account?.accountId !== "string" ||
      typeof account.alias !== "string" ||
      typeof account.scope !== "string" ||
      !Number.isSafeInteger(account.version)
    )
      return undefined;
    return {
      accountId: account.accountId,
      alias: account.alias,
      scope: account.scope,
      version: account.version as number,
      canManage: account.canManage === true,
    };
  }

  private openSubscriptionAccountAction(operation: "share" | "unshare" | "disconnect"): void {
    const account = this.selectedSubscriptionAccount();
    if (!account) {
      this.notice = "변경할 구독 계정을 선택해 주세요.";
      this.render();
      return;
    }
    if (!account.canManage) {
      this.notice = "구독 계정 소유자만 이 작업을 수행할 수 있습니다.";
      this.render();
      return;
    }
    if (operation === "share" && account.scope === "organization") {
      this.notice = "이미 조직에 공유된 계정입니다.";
      this.render();
      return;
    }
    if (operation === "unshare" && account.scope !== "organization") {
      this.notice = "조직에 공유되지 않은 계정입니다.";
      this.render();
      return;
    }
    const confirmation = operation === "share" ? "SHARE" : operation === "unshare" ? "UNSHARE" : "DISCONNECT";
    const label = operation === "share" ? "계정 공유" : operation === "unshare" ? "공유 해제" : "연결 해제";
    this.open({
      kind: "subscription-account",
      operation,
      confirmation,
      accountId: account.accountId,
      version: account.version,
      title: `${label} 확인 · ${safeTerminalText(account.alias, 80)}`,
      placeholder: `${confirmation}를 입력해 확정해 주세요`,
    });
  }

  private openSubscriptionPolicyAction(): void {
    const state = this.actions.state();
    const providers = Array.isArray(state.queryResults.subscriptionProviders)
      ? state.queryResults.subscriptionProviders.filter(
          (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const policies = Array.isArray(state.queryResults.subscriptionPolicy)
      ? state.queryResults.subscriptionPolicy.filter(
          (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const accounts = Array.isArray(state.queryResults.subscriptionAccounts)
      ? state.queryResults.subscriptionAccounts.filter(
          (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const provider = providers[0];
    const policy = policies.find((candidate) => candidate.providerId === provider?.providerId);
    const credentialPolicies = Array.isArray(provider?.credentialPolicies)
      ? provider.credentialPolicies.filter((value): value is string => typeof value === "string")
      : [];
    const runtimeCapabilities =
      provider?.runtimeCapabilities &&
      typeof provider.runtimeCapabilities === "object" &&
      !Array.isArray(provider.runtimeCapabilities)
        ? (provider.runtimeCapabilities as Record<string, unknown>)
        : undefined;
    const declaredApprovalModes = Array.isArray(runtimeCapabilities?.approvalModes)
      ? runtimeCapabilities.approvalModes.filter(
          (value): value is ApprovalMode => typeof value === "string" && APPROVAL_MODES.includes(value as ApprovalMode),
        )
      : undefined;
    const approvalModesBySurface =
      runtimeCapabilities?.approvalModesBySurface &&
      typeof runtimeCapabilities.approvalModesBySurface === "object" &&
      !Array.isArray(runtimeCapabilities.approvalModesBySurface)
        ? (runtimeCapabilities.approvalModesBySurface as Record<string, unknown>)
        : undefined;
    const connectedSurfaces = new Set(
      accounts
        .filter((account) => account.providerId === provider?.providerId)
        .map((account) => account.connectorLocation)
        .filter((surface): surface is "server" | "edge" => surface === "server" || surface === "edge"),
    );
    const surfaceApprovalModes =
      connectedSurfaces.size > 0 && approvalModesBySurface
        ? APPROVAL_MODES.filter((mode) =>
            [...connectedSurfaces].some((surface) => {
              const modes = approvalModesBySurface[surface];
              return Array.isArray(modes) && modes.includes(mode);
            }),
          )
        : undefined;
    const approvalModes =
      provider?.connectionSurface === "unavailable"
        ? []
        : surfaceApprovalModes !== undefined
          ? surfaceApprovalModes
          : declaredApprovalModes === undefined
            ? APPROVAL_MODES
            : declaredApprovalModes;
    if (provider?.connectionSurface === "unavailable") {
      this.notice = "이 Provider는 공개 연결을 지원하지 않습니다.";
      this.render();
      return;
    }
    if (
      typeof provider?.providerId !== "string" ||
      !Number.isSafeInteger(policy?.version) ||
      credentialPolicies.length === 0 ||
      approvalModes.length === 0
    ) {
      this.notice = "변경할 Provider 정책과 현재 version을 찾을 수 없습니다.";
      this.render();
      return;
    }
    const displayName = typeof provider.displayName === "string" ? provider.displayName : provider.providerId;
    this.open({
      kind: "subscription-policy",
      title: `구독 정책 변경 · ${safeTerminalText(displayName, 80)}`,
      placeholder: `${credentialPolicies.join("|")} <${approvalModes.join("|")}>`,
      providerId: provider.providerId,
      version: policy?.version as number,
      credentialPolicies,
      approvalModes,
    });
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
              : state.view === "subscriptions" && ["accounts", "quota"].includes(state.subscriptionTab)
                ? Array.isArray(state.queryResults.subscriptionAccounts)
                  ? state.queryResults.subscriptionAccounts
                      .filter(
                        (item): item is Record<string, unknown> =>
                          item !== null && typeof item === "object" && !Array.isArray(item),
                      )
                      .flatMap((item) => (typeof item.accountId === "string" ? [item.accountId] : []))
                  : []
                : [];
    if (!values.length) return;
    const current =
      state.view === "agents"
        ? state.selection.agentHandle
        : state.view === "works"
          ? state.selection.workId
          : state.view === "chat"
            ? state.selection.roomId
            : state.view === "approvals"
              ? state.selection.approvalId
              : state.selection.accountId;
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
            : state.view === "approvals"
              ? { approvalId: next }
              : { accountId: next };
    this.actions.dispatch({ type: "selection.changed", selection });
    this.render();
    void this.actions.loadView(state.view);
  }
}
