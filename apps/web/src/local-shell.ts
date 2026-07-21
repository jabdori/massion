// WS-4 결정 §2.2: GUI(native shell) 고유 능력은 주입형 어댑터로 격리합니다.
// 브라우저에서는 어댑터가 없고(undefined), desktop shell이 window.massionShell을 주입합니다.
export interface LocalShellCapabilities {
  pickDirectory?(): Promise<string | undefined>;
  notify?(input: { readonly title: string; readonly body: string }): void;
}

export function localShell(): LocalShellCapabilities | undefined {
  const candidate = (globalThis as { massionShell?: unknown }).massionShell;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate;
}
