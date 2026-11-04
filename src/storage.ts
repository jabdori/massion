import { createHash, randomUUID } from 'node:crypto';

export interface Snapshot<T> { revision: number; value: T }
export interface CommitInput<T> {
  id: string;
  expectedRevision: number;
  commandId: string;
  fingerprint: string;
  value: T;
  events: readonly unknown[];
  outbox: readonly unknown[];
}
export type CommitResult<T> =
  | { status: 'committed' | 'replayed'; revision: number; value: T }
  | { status: 'conflict'; revision: number; reason: 'revision' | 'idempotency' };
export type ReconcileResult<T> = CommitResult<T> | { status: 'unknown' };
export interface StoredEventBatch {
  cursor: number;
  aggregateId: string;
  revision: number;
  commandId: string;
  events: readonly unknown[];
}
export interface EventPage { events: StoredEventBatch[]; cursor: number }
export type OperationIdentity = Pick<CommitInput<unknown>, 'id' | 'commandId' | 'fingerprint'>;
export interface Store<T> {
  load(id: string): Promise<Snapshot<T> | null>;
  readEvents(after: number, limit?: number): Promise<EventPage>;
  commit(input: CommitInput<T>): Promise<CommitResult<T>>;
  reconcile(input: CommitInput<T>): Promise<ReconcileResult<T>>;
  lookupOperation(identity: OperationIdentity): Promise<ReconcileResult<T>>;
}
export interface AuditRecord {
  cursor: number;
  aggregateId: string;
  commandId: string;
  fingerprint: string;
  contentDigest: string;
  expectedRevision: number;
  revision: number;
  recordedAt: string;
}
export interface Operation<T> extends AuditRecord {
  value: T;
  events: readonly unknown[];
  outbox: readonly unknown[];
}

/** Complete operation history for every aggregate in one storage database. */
export interface PortableJournal<T> {
  schemaVersion: 2;
  head: number;
  operations: Operation<T>[];
}
export interface JournalRestoreResult {
  status: 'restored' | 'reconciled';
  head: number;
  checksum: string;
}
export class RestoreOutcomeUnknownError extends Error {
  readonly restoreId: string;
  readonly checksum: string;
  readonly head: number;
  constructor(restoreId: string, checksum: string, head: number, cause?: unknown) {
    super('Restore outcome is unknown; inspect this restore identity before deciding any next action.', { cause });
    this.name = 'RestoreOutcomeUnknownError';
    this.restoreId = restoreId; this.checksum = checksum; this.head = head;
  }
}

export class CommitOutcomeUnknownError extends Error {
  readonly id: string;
  readonly commandId: string;
  readonly fingerprint: string;
  constructor(input: Pick<CommitInput<unknown>, 'id' | 'commandId' | 'fingerprint'>, cause?: unknown) {
    super('Commit outcome is unknown; reconcile this operation before deciding any next action.', { cause });
    this.name = 'CommitOutcomeUnknownError';
    this.id = input.id;
    this.commandId = input.commandId;
    this.fingerprint = input.fingerprint;
  }
}

/** A complete, validated ERR statement result proves the transaction was rejected. */
export class StorageQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'StorageQueryError'; }
}
/** A definite rejected transaction; caller may retry deliberately after reading state. */
export class StorageContentionError extends StorageQueryError {
  readonly retryable = true;
  constructor(message: string) { super(message); this.name = 'StorageContentionError'; }
}
/** A cursor from another/reset database must not silently skip future changes. */
export class EventCursorError extends RangeError {
  readonly after: number;
  readonly head: number;
  constructor(after: number, head: number) {
    super('Event cursor is ahead of this database; obtain a fresh snapshot and cursor.');
    this.name = 'EventCursorError'; this.after = after; this.head = head;
  }
}
export class StorageProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'StorageProtocolError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be nonempty`);
}

function eventBounds(after: number, limit: number): void {
  if (!revision(after)) throw new TypeError('after must be a nonnegative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 through 1000');
}
function eventPage(result: unknown, after: number, limit: number): EventPage {
  if (!object(result) || !revision(result.head) || !Array.isArray(result.events) || result.events.length > limit) {
    throw new StorageProtocolError('Invalid event page');
  }
  if (after > result.head) throw new EventCursorError(after, result.head);
  let cursor = after;
  const events: StoredEventBatch[] = [];
  for (const entry of result.events) {
    if (!object(entry) || !revision(entry.cursor) || entry.cursor <= cursor || entry.cursor > result.head ||
      !revision(entry.revision) || entry.revision === 0 || typeof entry.aggregateId !== 'string' || !entry.aggregateId ||
      typeof entry.commandId !== 'string' || !entry.commandId || !Array.isArray(entry.events)) {
      throw new StorageProtocolError('Invalid or unordered stored event batch');
    }
    cursor = entry.cursor;
    events.push({ cursor, aggregateId: entry.aggregateId, commandId: entry.commandId, revision: entry.revision, events: copy(entry.events) });
  }
  return { events, cursor };
}

/** JSON-only canonicalization prevents lossy values and caller mutation after submission. */
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null) throw new TypeError('Storage values must be finite JSON data');
  if (seen.has(value)) throw new TypeError('Storage values must not contain cycles');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('Sparse or decorated arrays are unsupported');
    result = `[${value.map((entry) => canonical(entry, seen)).join(',')}]`;
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
      throw new TypeError('Storage values must contain plain JSON objects');
    }
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}
/** The storage identity encoding. Keep compatible with all previously committed digests. */
export function canonicalJSON(value: unknown): string { return canonical(value); }
function copy<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function prepare<T>(input: CommitInput<T>): { input: CommitInput<T>; digest: string; operationKey: string; aggregateKey: string } {
  identifier(input.id, 'id');
  identifier(input.commandId, 'commandId');
  identifier(input.fingerprint, 'fingerprint');
  if (!revision(input.expectedRevision) || input.expectedRevision === Number.MAX_SAFE_INTEGER) throw new TypeError('expectedRevision must allow a safe next revision');
  if (!Array.isArray(input.events) || !Array.isArray(input.outbox)) throw new TypeError('events and outbox must be arrays');
  const encoded = canonical(input);
  return { input: JSON.parse(encoded), digest: hash(encoded), operationKey: hash(input.commandId), aggregateKey: hash(input.id) };
}
/** Validate the entire history without mutating storage or invoking domain commands. */
export function validateJournal<T = unknown>(value: unknown): PortableJournal<T> {
  const journal: unknown = copy(value);
  if (!object(journal) || Object.keys(journal).sort().join(',') !== 'head,operations,schemaVersion' ||
    journal.schemaVersion !== 2 || !revision(journal.head) || !Array.isArray(journal.operations) ||
    journal.head !== journal.operations.length) {
    throw new TypeError('Invalid journal schema, head or operation count');
  }
  const commands = new Set<string>();
  const revisions = new Map<string, number>();
  for (const [index, operation] of journal.operations.entries()) {
    if (!object(operation) || Object.keys(operation).sort().join(',') !==
      'aggregateId,commandId,contentDigest,cursor,events,expectedRevision,fingerprint,outbox,recordedAt,revision,value' ||
      operation.cursor !== index + 1 || !revision(operation.expectedRevision) || !revision(operation.revision) ||
      operation.revision !== operation.expectedRevision + 1 || !Array.isArray(operation.events) || !Array.isArray(operation.outbox)) {
      throw new TypeError('Invalid journal operation, revision or global cursor');
    }
    identifier(operation.aggregateId, 'aggregateId'); identifier(operation.commandId, 'commandId');
    identifier(operation.fingerprint, 'fingerprint');
    if (typeof operation.recordedAt !== 'string' || !Number.isFinite(Date.parse(operation.recordedAt)) ||
      new Date(operation.recordedAt).toISOString() !== operation.recordedAt) {
      throw new TypeError('Invalid journal operation timestamp');
    }
    if (commands.has(operation.commandId)) throw new TypeError('Duplicate journal command identity');
    if (operation.expectedRevision !== (revisions.get(operation.aggregateId) ?? 0)) {
      throw new TypeError('Broken journal aggregate revision lineage');
    }
    const { digest } = prepare({
      id: operation.aggregateId, commandId: operation.commandId, fingerprint: operation.fingerprint,
      expectedRevision: operation.expectedRevision, value: operation.value, events: operation.events, outbox: operation.outbox,
    });
    if (operation.contentDigest !== digest) throw new TypeError('Journal operation content digest does not match');
    commands.add(operation.commandId); revisions.set(operation.aggregateId, operation.revision);
  }
  return journal as unknown as PortableJournal<T>;
}
/** Identity covers timestamps and complete ordered journal, in addition to per-command digests. */
export function journalChecksum(journal: PortableJournal<unknown>): string { return hash(canonical(journal)); }

function replay<T>(stored: Operation<T>, input: CommitInput<T>, digest: string): CommitResult<T> {
  if (stored.aggregateId !== input.id || stored.commandId !== input.commandId || stored.fingerprint !== input.fingerprint || stored.contentDigest !== digest) {
    return { status: 'conflict', revision: stored.revision, reason: 'idempotency' };
  }
  return { status: 'replayed', revision: stored.revision, value: copy(stored.value) };
}

/** Test-only reference implementation. It provides no process durability or DB evidence. */
export class InMemoryStore<T> implements Store<T> {
  private readonly states = new Map<string, Snapshot<T>>();
  private readonly operations = new Map<string, Operation<T>>();
  private cursor = 0;
  private readonly clock: () => Date;
  constructor(clock: () => Date = () => new Date()) { this.clock = clock; }
  async load(id: string): Promise<Snapshot<T> | null> {
    identifier(id, 'id');
    return copy(this.states.get(id) ?? null);
  }
  async commit(command: CommitInput<T>): Promise<CommitResult<T>> {
    const { input, digest } = prepare(command);
    const existing = this.operations.get(input.commandId);
    if (existing) return replay(existing, input, digest);
    const actual = this.states.get(input.id)?.revision ?? 0;
    if (actual !== input.expectedRevision) return { status: 'conflict', reason: 'revision', revision: actual };
    const next = actual + 1;
    if (this.cursor === Number.MAX_SAFE_INTEGER) throw new RangeError('Event cursor exhausted');
    const cursor = this.cursor + 1;
    const operation: Operation<T> = {
      cursor,
      aggregateId: input.id, commandId: input.commandId, fingerprint: input.fingerprint,
      contentDigest: digest, expectedRevision: actual, revision: next,
      recordedAt: this.clock().toISOString(), value: input.value, events: input.events, outbox: input.outbox,
    };
    // No await or user callback between the two writes: one JS critical section.
    this.operations.set(input.commandId, operation);
    this.states.set(input.id, { revision: next, value: input.value });
    this.cursor = cursor;
    return { status: 'committed', revision: next, value: copy(input.value) };
  }
  async readEvents(after: number, limit = 100): Promise<EventPage> {
    eventBounds(after, limit);
    const events = [...this.operations.values()].filter((entry) => entry.cursor > after).slice(0, limit);
    return eventPage({ head: this.cursor, events }, after, limit);
  }
  async lookupOperation(identity: OperationIdentity): Promise<ReconcileResult<T>> {
    identifier(identity.id, 'id'); identifier(identity.commandId, 'commandId'); identifier(identity.fingerprint, 'fingerprint');
    const existing = this.operations.get(identity.commandId);
    if (!existing) return { status: 'unknown' };
    if (existing.aggregateId !== identity.id || existing.fingerprint !== identity.fingerprint) return { status: 'conflict', revision: existing.revision, reason: 'idempotency' };
    return { status: 'replayed', revision: existing.revision, value: copy(existing.value) };
  }
  async reconcile(command: CommitInput<T>): Promise<ReconcileResult<T>> {
    const { input, digest } = prepare(command);
    const existing = this.operations.get(input.commandId);
    return existing ? replay(existing, input, digest) : { status: 'unknown' };
  }
  /** Isolated copies of retained audit/event/outbox evidence for unit tests only. */
  inspect(): readonly Operation<T>[] { return copy([...this.operations.values()]); }
}

export interface QueryTransport {
  /** Executes once. Implementations must never automatically retry write queries. */
  query(sql: string, variables: Record<string, unknown>): Promise<unknown[]>;
}
export interface HttpRpcOptions {
  endpoint: string;
  namespace: string;
  database: string;
  /** Caller-owned authorization; never read implicitly from environment or files. */
  authorization?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * SurrealDB 3.3 JSON RPC eagerly interprets record-shaped strings, including
 * nested ordinary data. Encode each JSON variable as a string and decode it in
 * SurrealQL to retain its exact JSON type and content. Values never enter SQL.
 */
function jsonVariableBindings(sql: string, variables: Record<string, unknown>): {
  sql: string; variables: Record<string, string>; statementCount: number;
} {
  const names = Object.keys(variables);
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new TypeError('Query variable names must be simple SurrealQL identifiers');
  }
  let prefix = '__massion_json_';
  while (names.some((name) => name.startsWith(prefix))) prefix += '_';
  const encoded: Record<string, string> = {};
  const bindings = names.map((name, index) => {
    const wireName = `${prefix}${index}`;
    encoded[wireName] = canonical(variables[name]);
    return `LET $${name} = encoding::json::decode($${wireName});`;
  });
  return { sql: bindings.length ? `${bindings.join('\n')}\n${sql}` : sql, variables: encoded, statementCount: bindings.length };
}

/** Structured values travel losslessly in the RPC body, never SQL or URL interpolation. */
export function createHttpRpcTransport(options: HttpRpcOptions): QueryTransport {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('RPC endpoint must be an HTTP(S) URL without credentials, query or fragment');
  }
  if (endpoint.pathname !== '/rpc') throw new TypeError('RPC endpoint must use /rpc');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !loopback) throw new TypeError('Non-loopback RPC requires HTTPS');
  identifier(options.namespace, 'namespace'); identifier(options.database, 'database');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const request = options.fetch ?? globalThis.fetch;
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json', 'Surreal-NS': options.namespace, 'Surreal-DB': options.database });
  if (options.authorization) headers.set('Authorization', options.authorization);
  return {
    async query(sql, variables) {
      const id = randomUUID();
      const bound = jsonVariableBindings(sql, variables);
      const response = await request(endpoint, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ id, method: 'query', params: [bound.sql, bound.variables] }),
      });
      if (!response.ok) throw new StorageProtocolError(`SurrealDB HTTP status ${response.status}`);
      const envelope: unknown = await response.json();
      if (!object(envelope) || envelope.id !== id || 'error' in envelope || !Array.isArray(envelope.result) || envelope.result.length === 0) {
        throw new StorageProtocolError('Invalid or unsuccessful SurrealDB RPC envelope');
      }
      const statements = envelope.result;
      for (const statement of statements) {
        if (!object(statement) || !['OK', 'ERR'].includes(String(statement.status)) || !Object.hasOwn(statement, 'result')) {
          throw new StorageProtocolError('Invalid SurrealDB statement result');
        }
      }
      // Bindings precede the caller's transaction. A failed binding does not
      // prove later statements were rolled back, so keep its outcome ambiguous.
      if (statements.slice(0, bound.statementCount).some((statement) => statement.status === 'ERR')) {
        throw new StorageProtocolError('JSON-variable binding failed; query outcome is not established');
      }
      const failures = statements.filter((statement) => statement.status === 'ERR');
      if (failures.length) {
        // Structured conflict kind is verified against HTTP RPC 3.3.0. Never
        // classify a timeout or generic error string as retryable contention.
        const conflict = failures.find((statement) => statement.kind === 'Query' &&
          object(statement.details) && statement.details.kind === 'TransactionConflict');
        if (conflict) throw new StorageContentionError(String(conflict.result));
        throw new StorageQueryError(String(failures[0].result));
      }
      if (statements.length <= bound.statementCount || statements.slice(0, bound.statementCount).some((statement) => statement.result !== null)) {
        throw new StorageProtocolError('Invalid JSON-variable binding results');
      }
      return statements.slice(bound.statementCount).map((statement) => statement.result);
    },
  };
}

/** Explicit first-schema provisioning. Never called implicitly by load or commit. */
export const SCHEMA_QUERY = `
BEGIN TRANSACTION;
RETURN {
DEFINE TABLE IF NOT EXISTS massion_state SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_operation SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_audit SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_event SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_outbox SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_feed SCHEMALESS;
LET $feed = SELECT * FROM ONLY massion_feed:global;
IF $feed = NONE {
  IF array::len(SELECT id FROM massion_operation LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_state LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_audit LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_event LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_outbox LIMIT 1) > 0 {
    THROW 'Existing operation journal requires an explicit event-cursor migration';
  };
  CREATE massion_feed:global CONTENT { cursor: 0, schemaVersion: 2 };
} ELSE IF $feed.schemaVersion != 2 {
  THROW 'Unsupported storage schema version';
};
DEFINE FIELD IF NOT EXISTS cursor ON massion_feed TYPE int ASSERT $value >= 0 AND $value <= 9007199254740991;
DEFINE FIELD IF NOT EXISTS cursor ON massion_operation TYPE int ASSERT $value > 0 AND $value <= 9007199254740991;
DEFINE INDEX IF NOT EXISTS operation_cursor ON massion_operation FIELDS cursor UNIQUE;
RETURN true;
};
COMMIT TRANSACTION;
`;
export async function initializeSurrealSchema(transport: QueryTransport): Promise<void> {
  const result = await transport.query(SCHEMA_QUERY, {});
  if (oneResult(result) !== true) throw new StorageProtocolError('Schema initialization was not confirmed');
}

export const LOAD_QUERY = `RETURN SELECT aggregateId, revision, value FROM ONLY type::record('massion_state', $aggregateKey);`;
export const OPERATION_QUERY = `RETURN SELECT cursor, aggregateId, commandId, fingerprint, contentDigest, expectedRevision, revision, recordedAt, value, events, outbox FROM ONLY type::record('massion_operation', $operationKey);`;

export const EVENTS_QUERY = `RETURN {
  LET $feed = SELECT * FROM ONLY massion_feed:global;
  IF $feed = NONE OR $feed.schemaVersion != 2 { THROW 'Storage event feed is not initialized'; };
  LET $events = SELECT cursor, aggregateId, revision, commandId, events FROM massion_operation
    WHERE cursor > $after ORDER BY cursor ASC LIMIT $limit;
  RETURN { head: $feed.cursor, events: $events };
};`;

/** Explicit transaction supplies one consistent feed/head and whole-database journal snapshot. */
export const EXPORT_JOURNAL_QUERY = `
BEGIN TRANSACTION;
RETURN {
  LET $feed = SELECT * FROM ONLY massion_feed:global;
  IF $feed = NONE OR $feed.schemaVersion != 2 { THROW 'Storage event feed is not initialized'; };
  LET $operations = SELECT cursor, aggregateId, commandId, fingerprint, contentDigest, expectedRevision,
    revision, recordedAt, value, events, outbox FROM massion_operation ORDER BY cursor ASC;
  RETURN { schemaVersion: 2, head: $feed.cursor, operations: $operations };
};
COMMIT TRANSACTION;
`;

/** Restore identity is read with the same snapshot as the journal used to verify it. */
export const RESTORE_READBACK_QUERY = `
BEGIN TRANSACTION;
RETURN {
  LET $feed = SELECT * FROM ONLY massion_feed:global;
  IF $feed = NONE OR $feed.schemaVersion != 2 { THROW 'Storage event feed is not initialized'; };
  LET $operations = SELECT cursor, aggregateId, commandId, fingerprint, contentDigest, expectedRevision,
    revision, recordedAt, value, events, outbox FROM massion_operation ORDER BY cursor ASC;
  RETURN { restoreId: $feed.restoreId, checksum: $feed.restoredJournalChecksum, restoredHead: $feed.restoredHead,
    journal: { schemaVersion: 2, head: $feed.cursor, operations: $operations } };
};
COMMIT TRANSACTION;
`;

/** Prepared rows are data only. Rebuild projections atomically, holding all historic effects. */
export const RESTORE_JOURNAL_QUERY = `
BEGIN TRANSACTION;
RETURN {
  LET $feed = SELECT * FROM ONLY massion_feed:global;
  IF $feed = NONE OR $feed.schemaVersion != 2 { THROW 'Storage event feed is not initialized'; };
  IF $feed.cursor != 0 OR $feed.restoreId != NONE OR array::len(SELECT id FROM massion_feed) != 1 OR
    array::len(SELECT id FROM massion_operation LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_state LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_audit LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_event LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_outbox LIMIT 1) > 0 {
    THROW 'Journal restore requires a fresh empty initialized database';
  };
  FOR $entry IN $operations {
    LET $row = $entry.operation;
    LET $state = type::record('massion_state', $entry.aggregateKey);
    LET $operation = type::record('massion_operation', $entry.operationKey);
    UPSERT $state CONTENT { aggregateId: $row.aggregateId, revision: $row.revision, value: $row.value };
    CREATE $operation CONTENT {
      cursor: $row.cursor, aggregateId: $row.aggregateId, aggregate: $state, commandId: $row.commandId,
      fingerprint: $row.fingerprint, contentDigest: $row.contentDigest,
      expectedRevision: $row.expectedRevision, revision: $row.revision, recordedAt: $row.recordedAt,
      value: $row.value, events: $row.events, outbox: $row.outbox
    };
    CREATE type::record('massion_audit', $entry.operationKey) CONTENT {
      cursor: $row.cursor, aggregate: $state, operation: $operation, aggregateId: $row.aggregateId,
      commandId: $row.commandId, fingerprint: $row.fingerprint, contentDigest: $row.contentDigest,
      expectedRevision: $row.expectedRevision, revision: $row.revision, recordedAt: $row.recordedAt
    };
    FOR $event IN $entry.eventRows {
      CREATE type::record('massion_event', $event.key) CONTENT {
        cursor: $row.cursor, aggregate: $state, operation: $operation, revision: $row.revision,
        ordinal: $event.ordinal, payload: $event.payload
      };
    };
    FOR $effect IN $entry.outboxRows {
      CREATE type::record('massion_outbox', $effect.key) CONTENT {
        cursor: $row.cursor, aggregate: $state, operation: $operation, revision: $row.revision,
        ordinal: $effect.ordinal, payload: $effect.payload, status: 'restored-held'
      };
    };
  };
  UPDATE massion_feed:global SET cursor = $head, restoreId = $restoreId,
    restoredJournalChecksum = $checksum, restoredHead = $head;
  RETURN { status: 'restored', head: $head, checksum: $checksum, restoreId: $restoreId };
};
COMMIT TRANSACTION;
`;

// Target: SurrealDB 3.x. A single query body is essential for an HTTP transaction.
export const COMMIT_QUERY = `
BEGIN TRANSACTION;
RETURN {
LET $state = type::record('massion_state', $aggregateKey);
LET $operation = type::record('massion_operation', $operationKey);
LET $existing = SELECT * FROM ONLY $operation;
IF $existing != NONE {
  IF $existing.aggregateId != $aggregateId OR $existing.commandId != $commandId OR $existing.fingerprint != $fingerprint OR $existing.contentDigest != $contentDigest {
    RETURN { status: 'conflict', revision: $existing.revision, reason: 'idempotency' };
  };
  RETURN { status: 'replayed', revision: $existing.revision, value: $existing.value };
};
LET $current = SELECT * FROM ONLY $state;
LET $actual = IF $current = NONE { 0 } ELSE { $current.revision };
IF $actual != $expectedRevision {
  RETURN { status: 'conflict', revision: $actual, reason: 'revision' };
};
LET $next = $actual + 1;
LET $feed = SELECT * FROM ONLY massion_feed:global;
IF $feed = NONE OR $feed.schemaVersion != 2 { THROW 'Storage event feed is not initialized'; };
IF $feed.cursor >= 9007199254740991 { THROW 'Event cursor exhausted'; };
LET $cursor = $feed.cursor + 1;
UPDATE massion_feed:global SET cursor = $cursor;
IF $current = NONE {
  CREATE $state CONTENT { aggregateId: $aggregateId, revision: $next, value: $value };
} ELSE {
  UPDATE $state CONTENT { aggregateId: $aggregateId, revision: $next, value: $value };
};
CREATE $operation CONTENT {
  cursor: $cursor,
  aggregateId: $aggregateId, aggregate: $state, commandId: $commandId,
  fingerprint: $fingerprint, contentDigest: $contentDigest,
  expectedRevision: $expectedRevision, revision: $next, recordedAt: $recordedAt,
  value: $value, events: $events, outbox: $outbox
};
CREATE type::record('massion_audit', $operationKey) CONTENT {
  cursor: $cursor,
  aggregate: $state, operation: $operation, aggregateId: $aggregateId,
  commandId: $commandId, fingerprint: $fingerprint, contentDigest: $contentDigest,
  expectedRevision: $expectedRevision, revision: $next, recordedAt: $recordedAt
};
FOR $entry IN $eventRows {
  CREATE type::record('massion_event', $entry.key) CONTENT {
    cursor: $cursor, aggregate: $state, operation: $operation, revision: $next,
    ordinal: $entry.ordinal, payload: $entry.payload
  };
};
FOR $entry IN $outboxRows {
  CREATE type::record('massion_outbox', $entry.key) CONTENT {
    cursor: $cursor, aggregate: $state, operation: $operation, revision: $next,
    ordinal: $entry.ordinal, payload: $entry.payload, status: 'pending'
  };
};
RETURN { status: 'committed', revision: $next, value: $value };
};
COMMIT TRANSACTION;
`;

function oneResult(results: unknown[]): unknown {
  // HTTP RPC 3.3 returns null results for BEGIN/COMMIT around the block.
  if (results.length === 1) return results[0];
  const values = results.filter((value) => value !== null);
  if (values.length !== 1) throw new StorageProtocolError('Expected one transaction RETURN value');
  return values[0];
}
function commitResult<T>(value: unknown): CommitResult<T> {
  if (!object(value) || !revision(value.revision)) throw new StorageProtocolError('Invalid commit result');
  if (value.status === 'conflict' && ['revision', 'idempotency'].includes(String(value.reason))) {
    return { status: 'conflict', revision: value.revision, reason: value.reason as 'revision' | 'idempotency' };
  }
  if (['committed', 'replayed'].includes(String(value.status)) && value.revision > 0 && Object.hasOwn(value, 'value')) {
    return { status: value.status as 'committed' | 'replayed', revision: value.revision, value: copy(value.value) as T };
  }
  throw new StorageProtocolError('Invalid commit result');
}

export class SurrealStore<T> implements Store<T> {
  private commitQueue: Promise<void> = Promise.resolve();
  private readonly transport: QueryTransport;
  private readonly clock: () => Date;
  constructor(transport: QueryTransport, clock: () => Date = () => new Date()) { this.transport = transport; this.clock = clock; }
  async load(id: string): Promise<Snapshot<T> | null> {
    identifier(id, 'id');
    const result = oneResult(await this.transport.query(LOAD_QUERY, { aggregateKey: hash(id) }));
    if (result === null) return null;
    if (!object(result) || result.aggregateId !== id || !revision(result.revision) || result.revision === 0 || !Object.hasOwn(result, 'value')) {
      throw new StorageProtocolError('Invalid stored snapshot');
    }
    return { revision: result.revision, value: copy(result.value) as T };
  }
  async readEvents(after: number, limit = 100): Promise<EventPage> {
    eventBounds(after, limit);
    return eventPage(oneResult(await this.transport.query(EVENTS_QUERY, { after, limit })), after, limit);
  }
  async exportJournal(): Promise<PortableJournal<T>> {
    const result = oneResult(await this.transport.query(EXPORT_JOURNAL_QUERY, {}));
    try { return validateJournal<T>(result); }
    catch (cause) { throw new StorageProtocolError(`Invalid stored journal: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  async restoreJournal(value: PortableJournal<T>): Promise<JournalRestoreResult> {
    // Validate and isolate every byte before queueing or touching the database.
    const journal = validateJournal<T>(value);
    const result = this.commitQueue.then(() => this.restoreOnce(journal));
    this.commitQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async restoreOnce(journal: PortableJournal<T>): Promise<JournalRestoreResult> {
    const checksum = journalChecksum(journal);
    const restoreId = randomUUID();
    const operations = journal.operations.map((operation) => {
      const operationKey = hash(operation.commandId);
      const rows = (values: readonly unknown[]) => values.map((payload, ordinal) => ({ key: `${operationKey}_${ordinal}`, ordinal, payload }));
      return { operation, operationKey, aggregateKey: hash(operation.aggregateId),
        eventRows: rows(operation.events), outboxRows: rows(operation.outbox) };
    });
    try {
      const result = oneResult(await this.transport.query(RESTORE_JOURNAL_QUERY, { operations, head: journal.head, checksum, restoreId }));
      if (!object(result) || result.status !== 'restored' || result.head !== journal.head ||
        result.checksum !== checksum || result.restoreId !== restoreId) {
        throw new StorageProtocolError('Invalid journal restore result');
      }
      return { status: 'restored', head: journal.head, checksum };
    } catch (cause) {
      // A proven rejection is final. Otherwise read exactly once, never replay the write.
      if (cause instanceof StorageQueryError) throw cause;
      try {
        const found = oneResult(await this.transport.query(RESTORE_READBACK_QUERY, {}));
        if (object(found) && found.restoreId === restoreId && found.checksum === checksum && found.restoredHead === journal.head) {
          const actual = validateJournal<T>(found.journal);
          const prefix: PortableJournal<T> = { schemaVersion: 2, head: journal.head, operations: actual.operations.slice(0, journal.head) };
          if (actual.head >= journal.head && journalChecksum(prefix) === checksum) {
            return { status: 'reconciled', head: journal.head, checksum };
          }
        }
      } catch (readError) {
        throw new RestoreOutcomeUnknownError(restoreId, checksum, journal.head, new AggregateError([cause, readError]));
      }
      throw new RestoreOutcomeUnknownError(restoreId, checksum, journal.head, cause);
    }
  }
  private async readOperation(commandId: string): Promise<Operation<T> | null> {
    identifier(commandId, 'commandId');
    const found = oneResult(await this.transport.query(OPERATION_QUERY, { operationKey: hash(commandId) }));
    if (found === null) return null;
    if (!object(found) || !revision(found.cursor) || found.cursor === 0 || !revision(found.revision) || found.revision === 0 ||
      !['aggregateId', 'commandId', 'fingerprint', 'contentDigest', 'recordedAt'].every((key) => typeof found[key] === 'string') ||
      !revision(found.expectedRevision) || !Object.hasOwn(found, 'value') || !Array.isArray(found.events) || !Array.isArray(found.outbox)) {
      throw new StorageProtocolError('Invalid stored operation');
    }
    return found as unknown as Operation<T>;
  }
  async lookupOperation(identity: OperationIdentity): Promise<ReconcileResult<T>> {
    identifier(identity.id, 'id'); identifier(identity.fingerprint, 'fingerprint');
    const existing = await this.readOperation(identity.commandId);
    if (!existing) return { status: 'unknown' };
    if (existing.aggregateId !== identity.id || existing.commandId !== identity.commandId || existing.fingerprint !== identity.fingerprint) {
      return { status: 'conflict', revision: existing.revision, reason: 'idempotency' };
    }
    return { status: 'replayed', revision: existing.revision, value: copy(existing.value) };
  }
  async reconcile(command: CommitInput<T>): Promise<ReconcileResult<T>> {
    const { input, digest } = prepare(command);
    const existing = await this.readOperation(input.commandId);
    return existing ? replay(existing, input, digest) : { status: 'unknown' };
  }
  async commit(command: CommitInput<T>): Promise<CommitResult<T>> {
    // Capture/validate before waiting: callers cannot mutate queued submissions.
    const { input } = prepare(command);
    const result = this.commitQueue.then(() => this.commitOnce(input));
    this.commitQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async commitOnce(command: CommitInput<T>): Promise<CommitResult<T>> {
    const { input, digest, aggregateKey, operationKey } = prepare(command);
    const rows = (values: readonly unknown[]) => values.map((payload, ordinal) => ({ key: `${operationKey}_${ordinal}`, ordinal, payload }));
    const variables = {
      aggregateId: input.id, aggregateKey, operationKey, commandId: input.commandId,
      fingerprint: input.fingerprint, contentDigest: digest, expectedRevision: input.expectedRevision,
      value: input.value, events: input.events, outbox: input.outbox,
      eventRows: rows(input.events), outboxRows: rows(input.outbox), recordedAt: this.clock().toISOString(),
    };
    try {
      return commitResult<T>(oneResult(await this.transport.query(COMMIT_QUERY, variables)));
    } catch (cause) {
      // A timeout, disconnect, malformed response, or proxy error may follow a commit.
      // Read operation identity once; never retransmit COMMIT_QUERY automatically.
      try {
        const known = await this.reconcile(input);
        if (known.status !== 'unknown') return known;
        if (cause instanceof StorageQueryError) {
          // A validated statement error proves this transaction rolled back. A new
          // revision can then explain a write race without string-matching errors.
          const current = await this.load(input.id);
          const actual = current?.revision ?? 0;
          if (actual !== input.expectedRevision) return { status: 'conflict', revision: actual, reason: 'revision' };
          throw cause;
        }
      } catch (readError) {
        if (readError === cause && cause instanceof StorageQueryError) throw cause;
        if (cause instanceof StorageQueryError) throw cause;
        throw new CommitOutcomeUnknownError(input, new AggregateError([cause, readError]));
      }
      throw new CommitOutcomeUnknownError(input, cause);
    }
  }
}
