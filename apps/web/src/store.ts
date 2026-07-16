import type { ApplicationCommandInput, ApplicationQueryEnvelope, WebApiClient } from "./api.js";

export interface PublicApplicationEvent {
  readonly sequence: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface WebConsoleState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly connection: "offline" | "connecting" | "live" | "degraded";
  readonly cursor: number;
  readonly queries: Readonly<Record<string, unknown>>;
  readonly queryErrors: Readonly<Record<string, string>>;
  readonly events: readonly PublicApplicationEvent[];
  readonly error?: string;
}

type StoreApi = Pick<WebApiClient, "query" | "snapshot" | "command">;

const EMPTY_QUERY_PAYLOAD = Object.freeze({});

const INITIAL: WebConsoleState = {
  status: "idle",
  connection: "offline",
  cursor: 0,
  queries: {},
  queryErrors: {},
  events: [],
};

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다";
}

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Query payload에 순환 참조가 있습니다");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item, seen)]),
  );
  seen.delete(value);
  return result;
}

export function createQueryResourceIdentity(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): string {
  return `${operation}:${JSON.stringify(stableValue(payload))}`;
}

export class WebConsoleStore {
  private state: WebConsoleState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly queries = new Map<string, Promise<unknown>>();
  private loading: Promise<void> | undefined;

  public constructor(private readonly api: StoreApi) {}

  public readonly getSnapshot = (): WebConsoleState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getQueryData(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): unknown {
    return this.state.queries[createQueryResourceIdentity(operation, payload)];
  }

  public getQueryError(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): string | undefined {
    return this.state.queryErrors[createQueryResourceIdentity(operation, payload)];
  }

  public load(): Promise<void> {
    if (this.loading) return this.loading;
    const pending = this.performLoad().finally(() => {
      if (this.loading === pending) this.loading = undefined;
    });
    this.loading = pending;
    return pending;
  }

  private async performLoad(): Promise<void> {
    this.set({
      status: "loading",
      connection: "connecting",
      cursor: this.state.cursor,
      queries: this.state.queries,
      queryErrors: this.state.queryErrors,
      events: this.state.events,
    });
    try {
      const [me, snapshot, works, approvals, audit] = await Promise.all([
        this.api.query("identity.me", {}),
        this.api.snapshot(),
        this.api.query("work.list", {}),
        this.api.query("governance.approval.list", {}),
        this.api.query("application.audit", { limit: 100 }),
      ]);
      const cursor = this.cursorFrom(audit);
      this.set({
        status: "ready",
        connection: "connecting",
        cursor,
        queries: {
          [createQueryResourceIdentity("identity.me")]: me.data,
          [createQueryResourceIdentity("organization.graph.snapshot")]: snapshot.data,
          [createQueryResourceIdentity("work.list")]: works.data,
          [createQueryResourceIdentity("governance.approval.list")]: approvals.data,
          [createQueryResourceIdentity("application.audit", { limit: 100 })]: audit.data,
        },
        queryErrors: {},
        events: this.eventsFrom(audit),
      });
    } catch (error) {
      this.set({ ...this.state, status: "error", connection: "degraded", error: publicError(error) });
      throw error;
    }
  }

  public refresh(operation: string, payload: unknown = {}): Promise<unknown> {
    const identity = createQueryResourceIdentity(operation, payload);
    const active = this.queries.get(identity);
    if (active) return active;
    const pending = this.performRefresh(operation, payload, identity).finally(() => {
      if (this.queries.get(identity) === pending) this.queries.delete(identity);
    });
    this.queries.set(identity, pending);
    return pending;
  }

  private async performRefresh(operation: string, payload: unknown, identity: string): Promise<unknown> {
    try {
      const envelope = await this.api.query(operation, payload);
      const remainingErrors = Object.fromEntries(
        Object.entries(this.state.queryErrors).filter(([key]) => key !== identity),
      );
      this.set({
        ...this.state,
        queries: { ...this.state.queries, [identity]: envelope.data },
        queryErrors: remainingErrors,
      });
      return envelope.data;
    } catch (error) {
      this.set({
        ...this.state,
        queryErrors: { ...this.state.queryErrors, [identity]: publicError(error) },
      });
      throw error;
    }
  }

  public mutate(input: ApplicationCommandInput): Promise<unknown> {
    const active = this.mutations.get(input.commandId);
    if (active) return active;
    const pending = this.api.command(input).finally(() => this.mutations.delete(input.commandId));
    this.mutations.set(input.commandId, pending);
    return pending;
  }

  public async acceptEvent(event: PublicApplicationEvent): Promise<void> {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !event.type) return;
    if (event.sequence <= this.state.cursor) return;
    if (this.state.cursor > 0 && event.sequence !== this.state.cursor + 1) {
      await this.resync();
      return;
    }
    const events = [...this.state.events, event];
    while (events.length > 1_000 || JSON.stringify(events).length > 4 * 1024 * 1024) events.shift();
    this.set({ ...this.state, cursor: event.sequence, events });
  }

  public setConnection(connection: WebConsoleState["connection"]): void {
    this.set({ ...this.state, connection });
  }

  private async resync(): Promise<void> {
    this.set({ ...this.state, connection: "degraded" });
    const snapshot = await this.api.snapshot();
    this.set({
      ...this.state,
      connection: "connecting",
      queries: {
        ...this.state.queries,
        [createQueryResourceIdentity("organization.graph.snapshot")]: snapshot.data,
      },
    });
  }

  private cursorFrom(envelope: ApplicationQueryEnvelope): number {
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
    const cursor = (data as Record<string, unknown>).cursor;
    return Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) : 0;
  }

  private eventsFrom(envelope: ApplicationQueryEnvelope): PublicApplicationEvent[] {
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const events = (data as Record<string, unknown>).events;
    return Array.isArray(events)
      ? (events.filter((event) => event && typeof event === "object") as PublicApplicationEvent[])
      : [];
  }

  private set(value: WebConsoleState): void {
    this.state = value;
    for (const listener of this.listeners) listener();
  }
}
