import type { PublicApplicationEvent, WebConsoleStore } from "./store.js";

interface LiveConnectionOptions {
  readonly fetcher?: typeof fetch;
  readonly random?: () => number;
}

function parseFrame(frame: string): PublicApplicationEvent | undefined {
  if (frame.startsWith(":")) return undefined;
  const fields = new Map<string, string>();
  for (const line of frame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator >= 0) fields.set(line.slice(0, separator), line.slice(separator + 1).replace(/^ /u, ""));
  }
  const id = fields.get("id");
  const type = fields.get("event");
  const data = fields.get("data");
  if (!id || !type || !data) throw new Error("실시간 사건 frame이 불완전합니다");
  const value = JSON.parse(data) as Record<string, unknown>;
  if (String(value.sequence) !== id || value.type !== type) throw new Error("실시간 사건 식별자가 일치하지 않습니다");
  return value as PublicApplicationEvent;
}

export class LiveEventConnection {
  private readonly fetcher: typeof fetch;
  private readonly random: () => number;
  private controller?: AbortController;
  private running = false;
  private retry = 0;
  private wake: (() => void) | undefined;

  public constructor(
    private readonly store: WebConsoleStore,
    options: LiveConnectionOptions = {},
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.random = options.random ?? Math.random;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener("online", this.reconnect);
    document.addEventListener("visibilitychange", this.visibility);
    void this.loop();
  }

  public stop(): void {
    this.running = false;
    this.controller?.abort();
    this.wake?.();
    window.removeEventListener("online", this.reconnect);
    document.removeEventListener("visibilitychange", this.visibility);
    this.store.setConnection("offline");
  }

  private readonly reconnect = (): void => {
    this.controller?.abort();
    this.wake?.();
  };

  private readonly visibility = (): void => {
    if (document.visibilityState === "visible") this.reconnect();
  };

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.controller = new AbortController();
        this.store.setConnection("connecting");
        const response = await this.fetcher(`/api/v1/events/stream?after=${String(this.store.getSnapshot().cursor)}`, {
          credentials: "include",
          headers: { accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`실시간 연결이 거부됐습니다 (${String(response.status)})`);
        this.retry = 0;
        this.store.setConnection("live");
        await this.consume(response.body);
      } catch (error) {
        if (!this.isRunning()) return;
        if (!(error instanceof DOMException && error.name === "AbortError")) this.store.setConnection("degraded");
      }
      if (!this.isRunning()) return;
      this.retry += 1;
      const maximum = Math.min(30_000, 500 * 2 ** Math.min(this.retry, 6));
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        window.setTimeout(resolve, maximum * (0.75 + this.random() * 0.5));
      });
      this.wake = undefined;
    }
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        if (new Blob([pending]).size > 4 * 1024 * 1024) throw new Error("실시간 수신 buffer 상한을 초과했습니다");
        pending = pending.replaceAll("\r\n", "\n");
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          const event = parseFrame(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
          boundary = pending.indexOf("\n\n");
          if (event) await this.store.acceptEvent(event);
        }
        if (chunk.done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private isRunning(): boolean {
    return this.running;
  }
}
