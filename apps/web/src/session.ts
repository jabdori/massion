import type { WebSessionEnvelope } from "./api.js";

export interface BrowserSessionState {
  readonly status: "checking" | "authenticated" | "anonymous";
  readonly session?: WebSessionEnvelope;
}

export class BrowserSessionStore {
  private state: BrowserSessionState = { status: "checking" };
  private readonly listeners = new Set<() => void>();

  public readonly getSnapshot = (): BrowserSessionState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public authenticate(session: WebSessionEnvelope): void {
    this.set({ status: "authenticated", session });
  }

  public anonymous(): void {
    this.set({ status: "anonymous" });
  }

  private set(value: BrowserSessionState): void {
    this.state = value;
    for (const listener of this.listeners) listener();
  }
}
