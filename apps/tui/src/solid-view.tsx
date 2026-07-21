// OpenTUI Solid 렌더 계층: OpenTuiView가 만든 view model을 반응형으로 그립니다.
// 로직·키 처리·문자열 구성은 open-tui.ts가 소유하고, 이 파일은 표현만 담당합니다.
import { TextAttributes, type CliRenderer, type InputRenderable } from "@opentui/core";
import { render } from "@opentui/solid";
import { Show, type Accessor } from "solid-js";

export interface SolidPanelModel {
  readonly mode: "wide" | "compact";
  readonly title: string;
  readonly navigation: string;
  readonly listTitle: string;
  readonly listContent: string;
  readonly detailTitle: string;
  readonly detailContent: string;
  readonly footer: string;
}

export interface SolidModalModel {
  readonly key: string;
  readonly title: string;
  readonly placeholder: string;
  readonly height: number;
  readonly helpText?: string;
  readonly paletteText?: string;
  readonly contextText?: string;
}

export interface SolidComposerModel {
  readonly focused: boolean;
  readonly placeholder: string;
}

export interface SolidViewModel {
  readonly noColor: boolean;
  readonly unsupported?: { readonly width: number; readonly height: number };
  readonly panel?: SolidPanelModel;
  readonly modal?: SolidModalModel;
  readonly composer?: SolidComposerModel;
}

export interface SolidViewHandlers {
  onInput(value: string): void;
  onSubmit(value: string): void;
  onInputMount(input: InputRenderable): void;
  onComposerSubmit(value: string): void;
  onComposerMount(input: InputRenderable): void;
}

export function mountSolidView(
  renderer: CliRenderer,
  model: Accessor<SolidViewModel>,
  handlers: SolidViewHandlers,
): Promise<void> {
  // exactOptionalPropertyTypes 아래에서 undefined를 넘기지 않도록 spread로 색을 적용합니다.
  const paint = <Key extends string>(key: Key, value: string): Partial<Record<Key, string>> =>
    model().noColor ? {} : ({ [key]: value } as Record<Key, string>);

  // reconciler가 renderable을 재사용하므로 input 초기화는 open-tui.ts가 ref로 직접 수행합니다.
  const ModalBox = () => {
    const modal = () => model().modal;
    let inputReference: InputRenderable | undefined;
    return (
      <box
        height={modal()?.height ?? 5}
        width="100%"
        border
        borderStyle="double"
        {...paint("borderColor", "#F3B35B")}
        title={modal()?.title ?? ""}
        paddingX={1}
        flexDirection="column"
      >
        <Show
          when={modal()?.helpText === undefined}
          fallback={<text {...paint("fg", "#C6D0F5")}>{modal()?.helpText ?? ""}</text>}
        >
          <Show when={modal()?.contextText !== undefined}>
            <text {...paint("fg", "#A5ADCE")}>{modal()?.contextText ?? ""}</text>
          </Show>
          <input
            id="modal-input"
            ref={(input: InputRenderable) => {
              inputReference = input;
              handlers.onInputMount(input);
            }}
            width="100%"
            focused
            placeholder={modal()?.placeholder ?? ""}
            maxLength={65_536}
            {...paint("backgroundColor", "#232634")}
            {...paint("textColor", "#C6D0F5")}
            {...paint("cursorColor", "#8BD5CA")}
            onInput={(value) => {
              handlers.onInput(value);
            }}
            onSubmit={(value) => {
              handlers.onSubmit(typeof value === "string" ? value : (inputReference?.value ?? ""));
            }}
          />
          <Show when={modal()?.paletteText !== undefined}>
            <text {...paint("fg", "#C6D0F5")}>{modal()?.paletteText ?? ""}</text>
          </Show>
        </Show>
      </box>
    );
  };

  const Panel = (props: { readonly title: string; readonly content: string; readonly width: `${number}%` }) => (
    <box
      width={props.width}
      height="100%"
      border
      borderStyle="rounded"
      {...paint("borderColor", "#414559")}
      title={props.title}
      titleAlignment="left"
      padding={1}
      overflow="hidden"
    >
      <text {...paint("fg", "#C6D0F5")} selectable width="100%">
        {props.content}
      </text>
    </box>
  );

  return render(
    () => (
      <Show
        when={model().unsupported === undefined && model().panel}
        fallback={
          <Show when={model().unsupported}>
            {(size) => (
              <box width="100%" height="100%" alignItems="center" justifyContent="center">
                <text attributes={TextAttributes.BOLD} {...paint("fg", "#F3B35B")}>
                  {`Massion TUI는 최소 80×24가 필요합니다.\n현재 크기: ${String(size().width)}×${String(size().height)}`}
                </text>
              </box>
            )}
          </Show>
        }
      >
        {(panel) => (
          <box width="100%" height="100%" flexDirection="column" {...paint("backgroundColor", "#0B0D10")}>
            <box height={3} width="100%" paddingX={2} alignItems="center" {...paint("backgroundColor", "#151A21")}>
              <text attributes={TextAttributes.BOLD} {...paint("fg", "#8BD5CA")}>
                {panel().title}
              </text>
            </box>
            <box height={3} width="100%" paddingX={2} alignItems="center">
              <text {...paint("fg", "#C6D0F5")}>{panel().navigation}</text>
            </box>
            <box flexDirection="row" flexGrow={1} width="100%" gap={1} paddingX={1}>
              <Panel
                title={panel().listTitle}
                content={panel().listContent}
                width={panel().mode === "wide" ? "40%" : "38%"}
              />
              <Panel
                title={panel().detailTitle}
                content={panel().detailContent}
                width={panel().mode === "wide" ? "60%" : "62%"}
              />
            </box>
            <Show when={model().composer !== undefined}>
              <box height={3} width="100%" paddingX={1} alignItems="center">
                <input
                  id="composer-input"
                  ref={(input: InputRenderable) => {
                    handlers.onComposerMount(input);
                  }}
                  width="100%"
                  focused={model().composer?.focused === true && model().modal === undefined}
                  placeholder={model().composer?.placeholder ?? ""}
                  maxLength={65_536}
                  {...paint("backgroundColor", "#1B1F27")}
                  {...paint("textColor", "#C6D0F5")}
                  {...paint("cursorColor", "#8BD5CA")}
                  onSubmit={(value) => {
                    handlers.onComposerSubmit(typeof value === "string" ? value : "");
                  }}
                />
              </box>
            </Show>
            <Show when={model().modal !== undefined}>
              <ModalBox />
            </Show>
            <box height={2} width="100%" paddingX={2} alignItems="center" {...paint("backgroundColor", "#151A21")}>
              <text {...paint("fg", "#A5ADCE")}>{panel().footer}</text>
            </box>
          </box>
        )}
      </Show>
    ),
    renderer,
  );
}
