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
export type OperationIdentity = Pick<CommitInput<unknown>, 'id' | 'commandId' | 'fingerprint'>;
export interface Store<T> {
  load(id: string): Promise<Snapshot<T> | null>;
  commit(input: CommitInput<T>): Promise<CommitResult<T>>;
  reconcile(input: CommitInput<T>): Promise<ReconcileResult<T>>;
  lookupOperation(identity: OperationIdentity): Promise<ReconcileResult<T>>;
}
export interface AuditRecord {
  aggregateId: string;
  commandId: string;
  fingerprint: string;
  contentDigest: string;
  expectedRevision: number;
  revision: number;
  recordedAt: string;
}
interface Operation<T> extends AuditRecord {
  value: T;
  events: readonly unknown[];
  outbox: readonly unknown[];
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
    const operation: Operation<T> = {
      aggregateId: input.id, commandId: input.commandId, fingerprint: input.fingerprint,
      contentDigest: digest, expectedRevision: actual, revision: next,
      recordedAt: this.clock().toISOString(), value: input.value, events: input.events, outbox: input.outbox,
    };
    // No await or user callback between the two writes: one JS critical section.
    this.operations.set(input.commandId, operation);
    this.states.set(input.id, { revision: next, value: input.value });
    return { status: 'committed', revision: next, value: copy(input.value) };
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

/** Structured vars travel in the RPC body, never in SQL or URL interpolation. */
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
      const response = await request(endpoint, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ id, method: 'query', params: [sql, variables] }),
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
      const failure = statements.find((statement) => statement.status === 'ERR');
      if (failure) throw new StorageQueryError(String(failure.result));
      return statements.map((statement) => statement.result);
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
RETURN true;
};
COMMIT TRANSACTION;
`;
export async function initializeSurrealSchema(transport: QueryTransport): Promise<void> {
  const result = await transport.query(SCHEMA_QUERY, {});
  if (oneResult(result) !== true) throw new StorageProtocolError('Schema initialization was not confirmed');
}

export const LOAD_QUERY = `RETURN SELECT aggregateId, revision, value FROM ONLY type::record('massion_state', $aggregateKey);`;
export const OPERATION_QUERY = `RETURN SELECT aggregateId, commandId, fingerprint, contentDigest, expectedRevision, revision, recordedAt, value, events, outbox FROM ONLY type::record('massion_operation', $operationKey);`;

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
IF $current = NONE {
  CREATE $state CONTENT { aggregateId: $aggregateId, revision: $next, value: $value };
} ELSE {
  UPDATE $state CONTENT { aggregateId: $aggregateId, revision: $next, value: $value };
};
CREATE $operation CONTENT {
  aggregateId: $aggregateId, aggregate: $state, commandId: $commandId,
  fingerprint: $fingerprint, contentDigest: $contentDigest,
  expectedRevision: $expectedRevision, revision: $next, recordedAt: $recordedAt,
  value: $value, events: $events, outbox: $outbox
};
CREATE type::record('massion_audit', $operationKey) CONTENT {
  aggregate: $state, operation: $operation, aggregateId: $aggregateId,
  commandId: $commandId, fingerprint: $fingerprint, contentDigest: $contentDigest,
  expectedRevision: $expectedRevision, revision: $next, recordedAt: $recordedAt
};
FOR $entry IN $eventRows {
  CREATE type::record('massion_event', $entry.key) CONTENT {
    aggregate: $state, operation: $operation, revision: $next,
    ordinal: $entry.ordinal, payload: $entry.payload
  };
};
FOR $entry IN $outboxRows {
  CREATE type::record('massion_outbox', $entry.key) CONTENT {
    aggregate: $state, operation: $operation, revision: $next,
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
  private async readOperation(commandId: string): Promise<Operation<T> | null> {
    identifier(commandId, 'commandId');
    const found = oneResult(await this.transport.query(OPERATION_QUERY, { operationKey: hash(commandId) }));
    if (found === null) return null;
    if (!object(found) || !revision(found.revision) || found.revision === 0 ||
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
