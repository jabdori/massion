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

interface WebConsoleStoreOptions {
  readonly maxQueryResources?: number;
}

interface QueryResource {
  readonly identity: string;
  readonly operation: string;
  readonly payload: unknown;
}

export interface ActiveQueryResource {
  readonly identity: string;
  readonly operation: string;
  readonly payload: unknown;
}

interface RetainedQueryResource {
  readonly resource: QueryResource;
  readonly count: number;
}

interface InFlightQuery {
  readonly generation: number;
  readonly origin: "load" | "refresh";
  readonly promise: Promise<unknown>;
}

interface QueryRequestState {
  readonly latest: number;
  readonly active: number;
}

const EMPTY_QUERY_PAYLOAD = Object.freeze({});
const EMPTY_QUERY_ERRORS: Readonly<Record<string, string>> = Object.freeze({});
const DEFAULT_MAX_QUERY_RESOURCES = 256;

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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function normalizeQueryPayload(payload: unknown): unknown {
  if (payload === undefined || typeof payload === "function" || typeof payload === "symbol") {
    return EMPTY_QUERY_PAYLOAD;
  }
  let encoded: unknown;
  try {
    encoded = JSON.stringify(payload);
  } catch (cause) {
    throw new Error("Query payload JSON 직렬화에 실패했습니다", { cause });
  }
  if (typeof encoded !== "string") return EMPTY_QUERY_PAYLOAD;
  try {
    return stableValue(JSON.parse(encoded) as unknown);
  } catch (cause) {
    throw new Error("Query payload JSON 정규화에 실패했습니다", { cause });
  }
}

function queryResource(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): QueryResource {
  const normalized = normalizeQueryPayload(payload);
  return {
    identity: `${operation}:${JSON.stringify(normalized)}`,
    operation,
    payload: normalized,
  };
}

export function createQueryResourceIdentity(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): string {
  return queryResource(operation, payload).identity;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export class WebConsoleStore {
  private state: WebConsoleState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly inFlightQueries = new Map<string, InFlightQuery>();
  private readonly queryRequests = new Map<string, QueryRequestState>();
  private readonly querySuccessGenerations = new Map<string, number>();
  private readonly resourceAccess = new Map<string, number>();
  private readonly retainedResources = new Map<string, RetainedQueryResource>();
  private readonly maxQueryResources: number;
  private accessSequence = 0;
  private requestSequence = 0;
  private activeQueryErrors: Readonly<Record<string, string>> = EMPTY_QUERY_ERRORS;
  private loading: Promise<void> | undefined;
  private resynchronizing: Promise<void> | undefined;

  public constructor(
    private readonly api: StoreApi,
    options: WebConsoleStoreOptions = {},
  ) {
    this.maxQueryResources = options.maxQueryResources ?? DEFAULT_MAX_QUERY_RESOURCES;
    if (!Number.isSafeInteger(this.maxQueryResources) || this.maxQueryResources < 1 || this.maxQueryResources > 10_000)
      throw new Error("Web query resource cache 상한이 유효하지 않습니다");
  }

  public readonly getSnapshot = (): WebConsoleState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getQueryData(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): unknown {
    const identity = createQueryResourceIdentity(operation, payload);
    if (hasOwn(this.state.queries, identity)) this.touch(identity);
    return this.state.queries[identity];
  }

  public getQueryError(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): string | undefined {
    const identity = createQueryResourceIdentity(operation, payload);
    if (hasOwn(this.state.queryErrors, identity)) this.touch(identity);
    return this.state.queryErrors[identity];
  }

  public readonly getActiveQueryErrors = (): Readonly<Record<string, string>> => this.activeQueryErrors;

  public activeQueryResources(): readonly ActiveQueryResource[] {
    return [...this.retainedResources.values()].map(({ resource }) => ({ ...resource }));
  }

  public retainQueryResource(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): () => void {
    const resource = queryResource(operation, payload);
    const current = this.retainedResources.get(resource.identity);
    this.retainedResources.set(resource.identity, { resource, count: (current?.count ?? 0) + 1 });
    this.touch(resource.identity);
    this.refreshActiveQueryErrors();
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const retained = this.retainedResources.get(resource.identity);
      if (!retained) return;
      if (retained.count <= 1) this.retainedResources.delete(resource.identity);
      else this.retainedResources.set(resource.identity, { ...retained, count: retained.count - 1 });
      this.refreshActiveQueryErrors();
      this.pruneCurrentResources();
      this.notify();
    };
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
    await Promise.allSettled([
      this.requestQuery("identity.me", {}, true),
      this.requestSnapshot(true),
      this.requestQuery("work.list", {}, true),
      this.requestQuery("governance.approval.list", {}, true),
      this.requestQuery("application.audit", { limit: 100 }, true),
    ]);
    const audit = this.getQueryData("application.audit", { limit: 100 });
    const auditCursor = this.cursorFromData(audit);
    const auditEvents = this.eventsFromData(audit);
    const useAudit = auditCursor > this.state.cursor || (this.state.cursor === 0 && this.state.events.length === 0);
    this.set({
      status: "ready",
      connection: this.state.connection,
      cursor: useAudit ? auditCursor : this.state.cursor,
      queries: this.state.queries,
      queryErrors: this.state.queryErrors,
      events: useAudit ? this.limitEvents(auditEvents) : this.state.events,
    });
  }

  public refresh(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): Promise<unknown> {
    return this.requestQuery(operation, payload, false);
  }

  private requestQuery(operation: string, payload: unknown, force: boolean): Promise<unknown> {
    const resource = queryResource(operation, payload);
    return this.requestResource(
      resource,
      () => this.api.query(resource.operation, resource.payload),
      force ? "load" : "refresh",
    );
  }

  private requestSnapshot(force: boolean): Promise<unknown> {
    const resource = queryResource("organization.graph.snapshot", EMPTY_QUERY_PAYLOAD);
    return this.requestResource(resource, () => this.api.snapshot(), force ? "load" : "refresh");
  }

  private requestResource(
    resource: QueryResource,
    loader: () => Promise<ApplicationQueryEnvelope>,
    origin: "load" | "refresh",
  ): Promise<unknown> {
    const active = this.inFlightQueries.get(resource.identity);
    if (
      active?.origin === "refresh" &&
      origin === "refresh" &&
      this.isLatestQueryResourceRequest(resource.identity, active.generation)
    ) {
      return active.promise;
    }
    const generation = this.beginQueryResourceRequest(resource.identity);
    const pending = this.performResourceRequest(resource, generation, loader).finally(() => {
      const current = this.inFlightQueries.get(resource.identity);
      if (current?.promise === pending) this.inFlightQueries.delete(resource.identity);
      this.finishQueryResourceRequest(resource.identity);
      this.pruneCurrentResources();
    });
    this.inFlightQueries.set(resource.identity, { generation, origin, promise: pending });
    return pending;
  }

  private async performResourceRequest(
    resource: QueryResource,
    generation: number,
    loader: () => Promise<ApplicationQueryEnvelope>,
  ): Promise<unknown> {
    try {
      const envelope = await loader();
      if (this.isLatestQueryResourceRequest(resource.identity, generation)) {
        this.commitQuerySuccess(resource.identity, envelope.data, generation);
      }
      return envelope.data;
    } catch (error) {
      if (this.isLatestQueryResourceRequest(resource.identity, generation)) {
        this.commitQueryFailure(resource.identity, error);
      }
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
      await this.resync(event.sequence);
      return;
    }
    this.set({
      ...this.state,
      cursor: event.sequence,
      events: this.limitEvents([...this.state.events, event]),
    });
  }

  public setConnection(connection: WebConsoleState["connection"]): void {
    this.set({ ...this.state, connection });
  }

  private resync(minimumCursor: number): Promise<void> {
    if (this.resynchronizing) return this.resynchronizing;
    const previousConnection = this.state.connection;
    const pending = this.performResync(minimumCursor, previousConnection).finally(() => {
      if (this.resynchronizing === pending) this.resynchronizing = undefined;
    });
    this.resynchronizing = pending;
    return pending;
  }

  private async performResync(minimumCursor: number, previousConnection: WebConsoleState["connection"]): Promise<void> {
    const snapshotResource = queryResource("organization.graph.snapshot", EMPTY_QUERY_PAYLOAD);
    const auditResource = queryResource("application.audit", { limit: 1000 });
    const snapshotGeneration = this.beginQueryResourceRequest(snapshotResource.identity);
    const auditGeneration = this.beginQueryResourceRequest(auditResource.identity);
    this.set({ ...this.state, connection: "degraded" });
    try {
      const [snapshotResult, auditResult] = await Promise.allSettled([
        this.api.snapshot(),
        this.api.query(auditResource.operation, auditResource.payload),
      ]);
      if (snapshotResult.status === "fulfilled") {
        if (this.isLatestQueryResourceRequest(snapshotResource.identity, snapshotGeneration))
          this.commitQuerySuccess(snapshotResource.identity, snapshotResult.value.data, snapshotGeneration);
      } else if (this.isLatestQueryResourceRequest(snapshotResource.identity, snapshotGeneration)) {
        this.commitQueryFailure(snapshotResource.identity, snapshotResult.reason);
      }
      if (auditResult.status === "fulfilled") {
        if (this.isLatestQueryResourceRequest(auditResource.identity, auditGeneration))
          this.commitQuerySuccess(auditResource.identity, auditResult.value.data, auditGeneration);
      } else if (this.isLatestQueryResourceRequest(auditResource.identity, auditGeneration)) {
        this.commitQueryFailure(auditResource.identity, auditResult.reason);
      }
      if (snapshotResult.status === "rejected") throw snapshotResult.reason;
      if (auditResult.status === "rejected") throw auditResult.reason;
      const currentSnapshot = this.getQueryData(snapshotResource.operation, snapshotResource.payload);
      const currentAudit = this.getQueryData(auditResource.operation, auditResource.payload);
      const cursor = this.cursorFromData(currentAudit);
      const snapshotRecovered =
        (this.querySuccessGenerations.get(snapshotResource.identity) ?? 0) >= snapshotGeneration;
      const auditRecovered = (this.querySuccessGenerations.get(auditResource.identity) ?? 0) >= auditGeneration;
      if (!snapshotRecovered || !auditRecovered || currentSnapshot === undefined || cursor < minimumCursor) {
        throw new Error("Application event sequence gap을 복구하지 못했습니다");
      }
      this.set({
        ...this.state,
        connection: this.state.connection === "degraded" ? previousConnection : this.state.connection,
        cursor,
        events: this.limitEvents(this.eventsFromData(currentAudit)),
      });
    } finally {
      this.finishQueryResourceRequest(snapshotResource.identity);
      this.finishQueryResourceRequest(auditResource.identity);
      this.pruneCurrentResources();
    }
  }

  private beginQueryResourceRequest(identity: string): number {
    const current = this.queryRequests.get(identity);
    this.requestSequence += 1;
    const generation = this.requestSequence;
    this.queryRequests.set(identity, { latest: generation, active: (current?.active ?? 0) + 1 });
    this.touch(identity);
    return generation;
  }

  private finishQueryResourceRequest(identity: string): void {
    const current = this.queryRequests.get(identity);
    if (!current) return;
    if (current.active <= 1) {
      this.queryRequests.delete(identity);
      if (!hasOwn(this.state.queries, identity) && !hasOwn(this.state.queryErrors, identity)) {
        this.resourceAccess.delete(identity);
        this.querySuccessGenerations.delete(identity);
      }
      return;
    }
    this.queryRequests.set(identity, { ...current, active: current.active - 1 });
  }

  private isLatestQueryResourceRequest(identity: string, generation: number): boolean {
    return this.queryRequests.get(identity)?.latest === generation;
  }

  private commitQuerySuccess(identity: string, data: unknown, generation: number): void {
    this.touch(identity);
    this.querySuccessGenerations.set(identity, generation);
    const queryErrors = Object.fromEntries(Object.entries(this.state.queryErrors).filter(([key]) => key !== identity));
    const bounded = this.boundedResources({ ...this.state.queries, [identity]: data }, queryErrors);
    this.set({ ...this.state, ...bounded });
  }

  private commitQueryFailure(identity: string, error: unknown): void {
    this.touch(identity);
    const bounded = this.boundedResources(this.state.queries, {
      ...this.state.queryErrors,
      [identity]: publicError(error),
    });
    this.set({ ...this.state, ...bounded });
  }

  private boundedResources(
    sourceQueries: Readonly<Record<string, unknown>>,
    sourceErrors: Readonly<Record<string, string>>,
  ): Pick<WebConsoleState, "queries" | "queryErrors"> {
    let queries = { ...sourceQueries };
    let queryErrors = { ...sourceErrors };
    const identities = new Set([...Object.keys(queries), ...Object.keys(queryErrors)]);
    while (identities.size > this.maxQueryResources) {
      const candidate = [...identities]
        .filter((identity) => !this.inFlightQueries.has(identity))
        .filter((identity) => !this.retainedResources.has(identity))
        .sort(
          (left, right) =>
            (this.resourceAccess.get(left) ?? Number.NEGATIVE_INFINITY) -
            (this.resourceAccess.get(right) ?? Number.NEGATIVE_INFINITY),
        )[0];
      if (!candidate) break;
      queries = Object.fromEntries(Object.entries(queries).filter(([key]) => key !== candidate));
      queryErrors = Object.fromEntries(Object.entries(queryErrors).filter(([key]) => key !== candidate));
      identities.delete(candidate);
      this.resourceAccess.delete(candidate);
      this.querySuccessGenerations.delete(candidate);
    }
    return { queries, queryErrors };
  }

  private pruneCurrentResources(): void {
    const bounded = this.boundedResources(this.state.queries, this.state.queryErrors);
    if (bounded.queries === this.state.queries && bounded.queryErrors === this.state.queryErrors) return;
    if (
      Object.keys(bounded.queries).length === Object.keys(this.state.queries).length &&
      Object.keys(bounded.queryErrors).length === Object.keys(this.state.queryErrors).length
    )
      return;
    this.set({ ...this.state, ...bounded });
  }

  private touch(identity: string): void {
    this.accessSequence += 1;
    this.resourceAccess.set(identity, this.accessSequence);
  }

  private refreshActiveQueryErrors(): void {
    const entries = Object.entries(this.state.queryErrors).filter(([identity]) => this.retainedResources.has(identity));
    if (entries.length === 0) {
      this.activeQueryErrors = EMPTY_QUERY_ERRORS;
      return;
    }
    const next = Object.fromEntries(entries);
    const currentEntries = Object.entries(this.activeQueryErrors);
    if (
      currentEntries.length === entries.length &&
      currentEntries.every(([identity, error]) => next[identity] === error)
    )
      return;
    this.activeQueryErrors = next;
  }

  private cursorFromData(data: unknown): number {
    if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
    const cursor = (data as Record<string, unknown>).cursor;
    return Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) : 0;
  }

  private eventsFromData(data: unknown): PublicApplicationEvent[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const events = (data as Record<string, unknown>).events;
    return Array.isArray(events)
      ? (events.filter((event) => event && typeof event === "object") as PublicApplicationEvent[])
      : [];
  }

  private limitEvents(source: readonly PublicApplicationEvent[]): PublicApplicationEvent[] {
    const events = [...source];
    while (events.length > 1_000 || JSON.stringify(events).length > 4 * 1024 * 1024) events.shift();
    return events;
  }

  private set(value: WebConsoleState): void {
    this.state = value;
    this.refreshActiveQueryErrors();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
