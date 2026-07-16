import { WebApiError, type ApplicationCommandInput, type ApplicationQueryEnvelope, type WebApiClient } from "./api.js";

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
  readonly queryResourceSoftLimit?: number;
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
const DEFAULT_QUERY_RESOURCE_SOFT_LIMIT = 256;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

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

function isEventCursorExpired(error: unknown): boolean {
  if (!(error instanceof WebApiError) || error.status !== 409) return false;
  if (!error.detail || typeof error.detail !== "object" || Array.isArray(error.detail)) return false;
  return (error.detail as Record<string, unknown>).operatorCode === "APP_EVENT_CURSOR_EXPIRED";
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
  private readonly queryResourceSoftLimit: number;
  private accessSequence = 0;
  private requestSequence = 0;
  private activeQueryErrors: Readonly<Record<string, string>> = EMPTY_QUERY_ERRORS;
  private loading: Promise<void> | undefined;
  private resynchronizing: Promise<void> | undefined;
  private resyncMinimumCursor = 0;

  public constructor(
    private readonly api: StoreApi,
    options: WebConsoleStoreOptions = {},
  ) {
    this.queryResourceSoftLimit = options.queryResourceSoftLimit ?? DEFAULT_QUERY_RESOURCE_SOFT_LIMIT;
    if (
      !Number.isSafeInteger(this.queryResourceSoftLimit) ||
      this.queryResourceSoftLimit < 1 ||
      this.queryResourceSoftLimit > 10_000
    )
      throw new Error("Web query resource cache soft limit이 유효하지 않습니다");
  }

  public readonly getSnapshot = (): WebConsoleState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getQueryData(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): unknown {
    const identity = createQueryResourceIdentity(operation, payload);
    return this.state.queries[identity];
  }

  public getQueryError(operation: string, payload: unknown = EMPTY_QUERY_PAYLOAD): string | undefined {
    const identity = createQueryResourceIdentity(operation, payload);
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
    const minimumSuccessGeneration = this.requestSequence;
    const snapshotIdentity = createQueryResourceIdentity("organization.graph.snapshot");
    const auditIdentity = createQueryResourceIdentity("application.audit", { limit: 100 });
    this.set({
      status: "loading",
      connection: "connecting",
      cursor: this.state.cursor,
      queries: this.state.queries,
      queryErrors: this.state.queryErrors,
      events: this.state.events,
    });
    const results = await Promise.allSettled([
      this.requestQuery("identity.me", {}, true),
      this.requestSnapshot(true),
      this.requestQuery("work.list", {}, true),
      this.requestQuery("governance.approval.list", {}, true),
      this.requestQuery("application.audit", { limit: 100 }, true),
    ]);
    await Promise.all([
      this.waitForNewerQuery(snapshotIdentity, minimumSuccessGeneration),
      this.waitForNewerQuery(auditIdentity, minimumSuccessGeneration),
    ]);
    const audit = this.getQueryData("application.audit", { limit: 100 });
    const snapshot = this.getQueryData("organization.graph.snapshot");
    const snapshotFailure: unknown = results[1].status === "rejected" ? (results[1].reason as unknown) : undefined;
    const auditFailure: unknown = results[4].status === "rejected" ? (results[4].reason as unknown) : undefined;
    const freshSnapshot =
      snapshot !== undefined && (this.querySuccessGenerations.get(snapshotIdentity) ?? 0) > minimumSuccessGeneration;
    const freshAudit =
      this.hasAuditCursor(audit) && (this.querySuccessGenerations.get(auditIdentity) ?? 0) > minimumSuccessGeneration;
    const criticalFailure = !freshSnapshot
      ? (snapshotFailure ?? new Error("초기 snapshot 응답이 유효하지 않습니다"))
      : !freshAudit
        ? (auditFailure ?? new Error("초기 audit cursor 응답이 유효하지 않습니다"))
        : undefined;
    if (criticalFailure !== undefined) {
      const error = new Error("Web 초기 운영 상태를 복구하지 못했습니다", { cause: criticalFailure });
      this.set({ ...this.state, status: "error", connection: "degraded", error: error.message });
      throw error;
    }
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
    if (
      (this.state.cursor === 0 && event.sequence !== 1) ||
      (this.state.cursor > 0 && event.sequence !== this.state.cursor + 1)
    ) {
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

  public recoverExpiredCursor(): Promise<void> {
    if (this.state.cursor >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(new Error("Application event cursor가 안전한 정수 상한에 도달했습니다"));
    return this.resync(this.state.cursor + 1);
  }

  private resync(minimumCursor: number): Promise<void> {
    this.resyncMinimumCursor = Math.max(this.resyncMinimumCursor, minimumCursor);
    if (this.resynchronizing) return this.resynchronizing;
    const previousConnection = this.state.connection;
    const pending = this.performResync(minimumCursor, previousConnection).finally(() => {
      if (this.resynchronizing === pending) {
        this.resynchronizing = undefined;
        this.resyncMinimumCursor = 0;
      }
    });
    this.resynchronizing = pending;
    return pending;
  }

  private async performResync(minimumCursor: number, previousConnection: WebConsoleState["connection"]): Promise<void> {
    const snapshotResource = queryResource("organization.graph.snapshot", EMPTY_QUERY_PAYLOAD);
    const snapshotGeneration = this.beginQueryResourceRequest(snapshotResource.identity);
    const startCursor = this.state.cursor;
    this.set({ ...this.state, connection: "degraded" });
    try {
      const [snapshotResult, auditResult] = await Promise.allSettled([
        this.api.snapshot(),
        this.readAuditRange(startCursor, minimumCursor),
      ]);
      if (!this.isLatestQueryResourceRequest(snapshotResource.identity, snapshotGeneration)) {
        await this.waitForNewerQuery(snapshotResource.identity, snapshotGeneration);
        const newerSnapshotSucceeded =
          (this.querySuccessGenerations.get(snapshotResource.identity) ?? 0) > snapshotGeneration;
        const targetCursor = Math.max(minimumCursor, this.resyncMinimumCursor);
        if (newerSnapshotSucceeded && this.state.cursor >= targetCursor) {
          const recoveredState = this.withoutError(this.state);
          this.set({
            ...recoveredState,
            connection: recoveredState.connection === "degraded" ? previousConnection : recoveredState.connection,
          });
          return;
        }
        throw new Error("Application event sequence gap을 복구하지 못했습니다");
      }
      if (snapshotResult.status === "rejected") {
        this.commitQueryFailure(snapshotResource.identity, snapshotResult.reason);
        throw snapshotResult.reason;
      }
      this.commitQuerySuccess(snapshotResource.identity, snapshotResult.value.data, snapshotGeneration);
      if (auditResult.status === "rejected") throw auditResult.reason;
      let recovered = auditResult.value;
      while (recovered.cursor < this.resyncMinimumCursor) {
        const additional = await this.readAuditRange(recovered.cursor, this.resyncMinimumCursor);
        recovered = {
          cursor: additional.cursor,
          events: this.mergeEvents(recovered.events, additional.events),
        };
      }
      const targetCursor = Math.max(minimumCursor, this.resyncMinimumCursor);
      if (recovered.cursor < targetCursor) throw new Error("Application event sequence gap을 복구하지 못했습니다");
      const recoveredState = this.withoutError(this.state);
      this.set({
        ...recoveredState,
        connection: recoveredState.connection === "degraded" ? previousConnection : recoveredState.connection,
        cursor: recovered.cursor,
        events: this.mergeEvents(recoveredState.events, recovered.events),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Application event sequence gap을 복구하지 못했습니다");
      this.set({ ...this.state, connection: "degraded", error: error.message });
      throw error;
    } finally {
      this.finishQueryResourceRequest(snapshotResource.identity);
      this.pruneCurrentResources();
    }
  }

  private async readAuditRange(
    startCursor: number,
    initialMinimumCursor: number,
  ): Promise<{ readonly cursor: number; readonly events: readonly PublicApplicationEvent[] }> {
    let cursor = startCursor;
    let events: PublicApplicationEvent[] = [];
    let restartedFromRetention = false;
    for (let page = 0; page < 10_000; page += 1) {
      const targetCursor = Math.max(initialMinimumCursor, this.resyncMinimumCursor);
      if (cursor >= targetCursor) return { cursor, events };
      let envelope: ApplicationQueryEnvelope;
      try {
        envelope = await this.api.query("application.audit", { after: cursor, limit: 1000 });
      } catch (cause) {
        if (cursor > 0 && !restartedFromRetention && isEventCursorExpired(cause)) {
          cursor = 0;
          events = [];
          restartedFromRetention = true;
          continue;
        }
        throw cause;
      }
      const nextCursor = this.cursorFromData(envelope.data);
      if (nextCursor <= cursor) throw new Error("Application audit cursor가 복구 중 전진하지 않았습니다");
      events = this.mergeEvents(events, this.eventsFromData(envelope.data));
      cursor = nextCursor;
    }
    throw new Error("Application audit gap 복구 page 상한을 초과했습니다");
  }

  private async waitForNewerQuery(identity: string, generation: number): Promise<void> {
    const active = this.inFlightQueries.get(identity);
    if (active && active.generation > generation) await active.promise.catch(() => undefined);
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
    while (identities.size > this.queryResourceSoftLimit) {
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

  private hasAuditCursor(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const cursor = (data as Record<string, unknown>).cursor;
    return Number.isSafeInteger(cursor) && (cursor as number) >= 0;
  }

  private eventsFromData(data: unknown): PublicApplicationEvent[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const events = (data as Record<string, unknown>).events;
    return Array.isArray(events)
      ? (events.filter((event) => event && typeof event === "object") as PublicApplicationEvent[])
      : [];
  }

  private limitEvents(source: readonly PublicApplicationEvent[]): PublicApplicationEvent[] {
    const candidates = source.slice(-1_000);
    const events: PublicApplicationEvent[] = [];
    let bytes = 2;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const event = candidates[index];
      if (!event) continue;
      const eventBytes = UTF8_ENCODER.encode(JSON.stringify(event)).byteLength + (events.length === 0 ? 0 : 1);
      if (bytes + eventBytes > MAX_EVENT_BYTES) break;
      events.push(event);
      bytes += eventBytes;
    }
    return events.reverse();
  }

  private mergeEvents(
    current: readonly PublicApplicationEvent[],
    recovered: readonly PublicApplicationEvent[],
  ): PublicApplicationEvent[] {
    const bySequence = new Map<number, PublicApplicationEvent>();
    for (const event of [...current, ...recovered]) {
      if (Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.type)
        bySequence.set(event.sequence, event);
    }
    return this.limitEvents([...bySequence.values()].sort((left, right) => left.sequence - right.sequence));
  }

  private withoutError(state: WebConsoleState): WebConsoleState {
    const value = { ...state };
    delete value.error;
    return value;
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
