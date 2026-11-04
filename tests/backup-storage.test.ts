import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  EXPORT_JOURNAL_QUERY, RESTORE_JOURNAL_QUERY, RESTORE_READBACK_QUERY,
  InMemoryStore, RestoreOutcomeUnknownError, StorageProtocolError, StorageQueryError,
  SurrealStore, canonicalJSON, createHttpRpcTransport, initializeSurrealSchema, journalChecksum, validateJournal,
} from '../src/storage.ts';
import type { CommitInput, Operation, PortableJournal, QueryTransport } from '../src/storage.ts';

const now = () => new Date('2026-10-03T00:00:00.000Z');
const command = (overrides: Partial<CommitInput<unknown>> = {}): CommitInput<unknown> => ({
  id: 'work:one:full', commandId: 'command:one:full', fingerprint: 'fingerprint:one:full', expectedRevision: 0,
  value: { id: 'work:one:full', content: 'Unicode 🧭 한글\nQuotes: "a"', source: 'source:opaque:full', nullable: null },
  events: [{ type: 'work.created', payload: 'event:opaque:full' }],
  outbox: [{ effectId: 'effect:one:full', payload: { source: 'source:opaque:full' } }], ...overrides,
});
async function fixture() {
  const store = new InMemoryStore<unknown>(now);
  const inputs = [command(), command({ id: 'work:two:full', commandId: 'command:two:full' }),
    command({ commandId: 'command:three:full', expectedRevision: 1, value: { title: 'Updated', nested: [{ runId: 'run:verifier:assignment' }] } })];
  for (const input of inputs) await store.commit(input);
  return { inputs, journal: { schemaVersion: 2, head: 3, operations: [...store.inspect()] } as PortableJournal<unknown> };
}
const digest = (operation: Operation<unknown>) => createHash('sha256').update(canonicalJSON({
  id: operation.aggregateId, commandId: operation.commandId, fingerprint: operation.fingerprint,
  expectedRevision: operation.expectedRevision, value: operation.value, events: operation.events, outbox: operation.outbox,
})).digest('hex');

test('portable journal validates global and per-aggregate history without changing canonical commit identity', async () => {
  const { journal } = await fixture();
  assert.deepEqual(validateJournal(journal), journal);
  for (const operation of journal.operations) assert.equal(operation.contentDigest, digest(operation));
  assert.equal(journalChecksum(journal), createHash('sha256').update(canonicalJSON(journal)).digest('hex'));
  const reordered = { operations: journal.operations, head: journal.head, schemaVersion: 2 as const };
  assert.equal(journalChecksum(reordered), journalChecksum(journal));
  const copied = validateJournal(journal);
  copied.operations[0]!.recordedAt = 'changed';
  assert.equal(journal.operations[0]!.recordedAt, now().toISOString());
  assert.deepEqual(validateJournal({ schemaVersion: 2, head: 0, operations: [] }), { schemaVersion: 2, head: 0, operations: [] });
});

test('restore rejects corrupt digest, lineage, duplicate IDs, cursor, schema and JSON before any database query', async () => {
  const { journal } = await fixture();
  const changes: Array<(value: PortableJournal<unknown>) => void> = [
    (value) => { value.head = 2; },
    (value) => { value.operations[0]!.cursor = 2; },
    (value) => { value.operations[0]!.contentDigest = '0'.repeat(64); },
    (value) => { value.operations[0]!.value = { tampered: true }; },
    (value) => { value.operations[0]!.events = []; },
    (value) => { value.operations[0]!.outbox = []; },
    (value) => { value.operations[0]!.aggregateId = ''; },
    (value) => { value.operations[0]!.fingerprint = ''; },
    (value) => { value.operations[0]!.recordedAt = 'not a timestamp'; },
    (value) => { value.operations[0]!.revision = 2; },
    (value) => { const op = value.operations[2]!; op.expectedRevision = 2; op.revision = 3; op.contentDigest = digest(op); },
    (value) => { const op = value.operations[1]!; op.commandId = value.operations[0]!.commandId; op.contentDigest = digest(op); },
    (value) => { value.operations.reverse(); },
    (value) => { value.operations[0]!.value = { invalid: undefined }; },
    (value) => { value.operations[0]!.value = new Date(); },
    (value) => { (value as unknown as Record<string, unknown>).schemaVersion = 3; },
    (value) => { (value as unknown as Record<string, unknown>).extra = true; },
    (value) => { (value.operations[0] as unknown as Record<string, unknown>).extra = true; },
  ];
  let queries = 0;
  const store = new SurrealStore({ query: async () => { queries += 1; return []; } });
  for (const change of changes) {
    const bad = structuredClone(journal); change(bad);
    await assert.rejects(store.restoreJournal(bad), TypeError);
  }
  assert.equal(queries, 0);
});

test('export uses one transactional whole-database snapshot and validates its head', async () => {
  const { journal } = await fixture();
  let queries = 0;
  const store = new SurrealStore({ query: async (sql, variables) => {
    queries += 1; assert.equal(sql, EXPORT_JOURNAL_QUERY); assert.deepEqual(variables, {});
    assert.match(sql, /BEGIN TRANSACTION/); assert.match(sql, /ORDER BY cursor ASC/); assert.doesNotMatch(sql, /LIMIT/);
    return [null, journal, null];
  } });
  assert.deepEqual(await store.exportJournal(), journal);
  assert.equal(queries, 1);
  journal.head += 1;
  await assert.rejects(store.exportJournal(), StorageProtocolError);
});

test('restore writes every component once with bound data and quarantines only materialized outbox rows', async () => {
  const { journal } = await fixture();
  let writes = 0;
  const store = new SurrealStore({ query: async (sql, variables) => {
    writes += 1; assert.equal(sql, RESTORE_JOURNAL_QUERY);
    assert.match(sql, /BEGIN TRANSACTION/); assert.match(sql, /COMMIT TRANSACTION/);
    for (const table of ['state', 'operation', 'audit', 'event', 'outbox', 'feed']) assert.ok(sql.includes(`massion_${table}`));
    assert.match(sql, /status: 'restored-held'/); assert.doesNotMatch(sql, /status: 'pending'/);
    assert.ok(!sql.includes(journal.operations[0]!.commandId));
    const rows = variables.operations as { operation: Operation<unknown>; eventRows: unknown[]; outboxRows: unknown[] }[];
    assert.deepEqual(rows.map((entry) => entry.operation), journal.operations);
    assert.equal(rows[0]!.eventRows.length, 1); assert.equal(rows[0]!.outboxRows.length, 1);
    return [{ status: 'restored', head: variables.head, checksum: variables.checksum, restoreId: variables.restoreId }];
  } });
  assert.deepEqual(await store.restoreJournal(journal), { status: 'restored', head: journal.head, checksum: journalChecksum(journal) });
  assert.equal(writes, 1);
});

test('lost restore response is reconciled by exact attempt identity and canonical journal checksum without replay', async () => {
  const { journal } = await fixture();
  let writes = 0;
  let marker: Record<string, unknown> = {};
  const store = new SurrealStore({ query: async (sql, variables) => {
    if (sql === RESTORE_JOURNAL_QUERY) {
      writes += 1; marker = { restoreId: variables.restoreId, checksum: variables.checksum, restoredHead: variables.head };
      throw new Error('response lost after commit');
    }
    assert.equal(sql, RESTORE_READBACK_QUERY);
    return [{ ...marker, journal }];
  } });
  assert.deepEqual(await store.restoreJournal(journal), { status: 'reconciled', head: journal.head, checksum: journalChecksum(journal) });
  assert.equal(writes, 1);
});

test('restore captures caller bytes before its write is queued', async () => {
  const { journal } = await fixture();
  const expected = structuredClone(journal);
  const store = new SurrealStore({ query: async (_sql, variables) => {
    assert.deepEqual((variables.operations as { operation: Operation<unknown> }[]).map((entry) => entry.operation), expected.operations);
    return [{ status: 'restored', head: variables.head, checksum: variables.checksum, restoreId: variables.restoreId }];
  } });
  const restoring = store.restoreJournal(journal);
  journal.operations[0]!.value = { changed: true };
  journal.operations.pop(); journal.head = 2;
  assert.equal((await restoring).checksum, journalChecksum(expected));
});

test('restore identity readback verifies original prefix if a later ordinary commit already advanced the feed', async () => {
  const { journal, inputs } = await fixture();
  const later = new InMemoryStore<unknown>(now);
  for (const input of inputs) await later.commit(input);
  await later.commit(command({ commandId: 'later:after:restore', expectedRevision: 2 }));
  const advanced: PortableJournal<unknown> = { schemaVersion: 2, head: 4, operations: [...later.inspect()] };
  let marker: Record<string, unknown> = {};
  const store = new SurrealStore({ query: async (sql, variables) => {
    if (sql === RESTORE_JOURNAL_QUERY) {
      marker = { restoreId: variables.restoreId, checksum: variables.checksum, restoredHead: variables.head };
      throw new Error('response lost');
    }
    assert.equal(sql, RESTORE_READBACK_QUERY);
    return [{ ...marker, journal: advanced }];
  } });
  assert.equal((await store.restoreJournal(journal)).status, 'reconciled');
});

test('unknown restore or mismatched readback remains unknown without another write', async () => {
  const { journal } = await fixture();
  for (const mode of ['absent', 'wrong-attempt', 'wrong-checksum', 'changed-timestamp', 'read-failed', 'malformed-success']) {
    let writes = 0; let reads = 0; let marker: Record<string, unknown> = {};
    const store = new SurrealStore({ query: async (sql, variables) => {
      if (sql === RESTORE_JOURNAL_QUERY) {
        writes += 1; marker = { restoreId: variables.restoreId, checksum: variables.checksum, restoredHead: variables.head };
        if (mode === 'malformed-success') return [{ status: 'restored' }];
        throw new Error('timeout');
      }
      reads += 1; assert.equal(sql, RESTORE_READBACK_QUERY);
      if (mode === 'read-failed') throw new Error('read unavailable');
      if (mode === 'absent' || mode === 'malformed-success') return [{}];
      if (mode === 'wrong-attempt') return [{ ...marker, restoreId: 'other-attempt', journal }];
      if (mode === 'wrong-checksum') return [{ ...marker, checksum: 'different', journal }];
      const changed = structuredClone(journal); changed.operations[0]!.recordedAt = '2026-10-02T00:00:00.000Z';
      return [{ ...marker, journal: changed }];
    } });
    await assert.rejects(store.restoreJournal(journal), (error: unknown) => error instanceof RestoreOutcomeUnknownError &&
      error.head === journal.head && error.checksum === journalChecksum(journal) && !!error.restoreId);
    assert.equal(writes, 1); assert.equal(reads, 1);
  }
});

test('definite restore rejection is surfaced without retry or ambiguous success readback', async () => {
  const { journal } = await fixture();
  let queries = 0;
  const failure = new StorageQueryError('target is not empty');
  const store = new SurrealStore({ query: async () => { queries += 1; throw failure; } });
  await assert.rejects(store.restoreJournal(journal), (error) => error === failure);
  assert.equal(queries, 1);
});

const endpoint = process.env.MASSION_TEST_SURREAL_RPC;
async function database(): Promise<QueryTransport> {
  const namespace = `backup_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' });
  await bootstrap.query(`DEFINE NAMESPACE ${namespace};`, {});
  const transport = createHttpRpcTransport({ endpoint: endpoint!, namespace, database: 'isolated' });
  await transport.query('DEFINE DATABASE isolated;', {});
  return transport;
}
const allRows = `RETURN {
  states: (SELECT * FROM massion_state ORDER BY id), operations: (SELECT * FROM massion_operation ORDER BY id),
  audits: (SELECT * FROM massion_audit ORDER BY id), events: (SELECT * FROM massion_event ORDER BY id),
  outbox: (SELECT * FROM massion_outbox ORDER BY id), feeds: (SELECT * FROM massion_feed ORDER BY id)
};`;

test('actual SurrealDB portable restore retains every journal projection, replay identity and feed with held effects', { skip: !endpoint }, async () => {
  const source = await database(); const target = await database();
  await initializeSurrealSchema(source); await initializeSurrealSchema(target);
  const store = new SurrealStore(source, now); const { inputs } = await fixture();
  for (const input of inputs) await store.commit(input);
  const journal = await store.exportJournal();
  let clockCalls = 0;
  const restored = new SurrealStore(target, () => { clockCalls += 1; return now(); });
  assert.deepEqual(await restored.restoreJournal(journal), { status: 'restored', head: 3, checksum: journalChecksum(journal) });
  assert.equal(clockCalls, 0, 'Restore must retain original timestamps without calling the clock');
  assert.deepEqual(await restored.exportJournal(), journal);
  assert.deepEqual(await restored.readEvents(0), await store.readEvents(0));
  for (const input of inputs) {
    assert.deepEqual(await restored.load(input.id), await store.load(input.id));
    assert.deepEqual(await restored.lookupOperation(input), await store.lookupOperation(input));
    assert.deepEqual(await restored.reconcile(input), await store.reconcile(input));
    assert.equal((await restored.commit(input)).status, 'replayed');
  }
  const original = (await source.query(allRows, {}))[0] as Record<string, Record<string, unknown>[]>;
  const rebuilt = (await target.query(allRows, {}))[0] as Record<string, Record<string, unknown>[]>;
  for (const key of ['states', 'operations', 'audits', 'events']) assert.deepEqual(rebuilt[key], original[key], key);
  assert.deepEqual(rebuilt.outbox, original.outbox!.map((row) => ({ ...row, status: 'restored-held' })));
  assert.equal(rebuilt.feeds![0]!.cursor, 3);
  const beforeRefusal = await target.query(allRows, {});
  await assert.rejects(restored.restoreJournal(journal), StorageQueryError);
  assert.deepEqual(await target.query(allRows, {}), beforeRefusal);
  const next = command({ commandId: 'command:after:restore', expectedRevision: 2 });
  const continuing = new SurrealStore(target, now);
  assert.equal((await continuing.commit(next)).status, 'committed');
  assert.equal((await continuing.readEvents(3)).cursor, 4);
  assert.equal((await continuing.exportJournal()).operations[3]!.revision, 3);
});

test('actual SurrealDB restore rolls back every write and refuses uninitialized or dirty target projections', { skip: !endpoint }, async () => {
  const { journal } = await fixture();
  const target = await database();
  const store = new SurrealStore(target);
  await assert.rejects(store.restoreJournal(journal), StorageQueryError);
  await initializeSurrealSchema(target);
  const before = await target.query(allRows, {});
  const failing = new SurrealStore({ query: (sql, variables) => target.query(sql === RESTORE_JOURNAL_QUERY ?
    sql.replace('UPDATE massion_feed:global SET cursor = $head', "THROW 'injected restore failure';\nUPDATE massion_feed:global SET cursor = $head") : sql, variables) });
  await assert.rejects(failing.restoreJournal(journal), StorageQueryError);
  assert.deepEqual(await target.query(allRows, {}), before);
  for (const table of ['state', 'operation', 'audit', 'event', 'outbox', 'feed']) {
    const dirty = await database(); await initializeSurrealSchema(dirty);
    await dirty.query(`CREATE massion_${table}:orphan CONTENT { cursor: 1 };`, {});
    const prior = await dirty.query(allRows, {});
    await assert.rejects(new SurrealStore(dirty).restoreJournal(journal), StorageQueryError);
    assert.deepEqual(await dirty.query(allRows, {}), prior, table);
  }
});

test('actual SurrealDB lost restore response reconciles once and empty restore cannot be repeated', { skip: !endpoint }, async () => {
  const target = await database(); await initializeSurrealSchema(target);
  const { journal } = await fixture(); let writes = 0;
  const store = new SurrealStore({ query: async (sql, variables) => {
    const result = await target.query(sql, variables);
    if (sql === RESTORE_JOURNAL_QUERY) { writes += 1; throw new Error('injected lost response'); }
    return result;
  } });
  assert.equal((await store.restoreJournal(journal)).status, 'reconciled');
  assert.equal(writes, 1);
  assert.deepEqual(await store.exportJournal(), journal);
  const emptyTarget = await database(); await initializeSurrealSchema(emptyTarget);
  const empty = new SurrealStore(emptyTarget); const emptyJournal: PortableJournal<unknown> = { schemaVersion: 2, head: 0, operations: [] };
  assert.equal((await empty.restoreJournal(emptyJournal)).status, 'restored');
  assert.deepEqual(await empty.exportJournal(), emptyJournal);
  await assert.rejects(empty.restoreJournal(emptyJournal), StorageQueryError);
});


test('actual SurrealDB export sees one journal snapshot while a concurrent command advances the feed', { skip: !endpoint }, async () => {
  const transport = await database(); await initializeSurrealSchema(transport);
  const store = new SurrealStore(transport, now); await store.commit(command());
  const slowExport = new SurrealStore({ query: (sql, variables) => transport.query(sql === EXPORT_JOURNAL_QUERY ?
    sql.replace('LET $operations =', 'SLEEP 300ms;\n  LET $operations =') : sql, variables) });
  const exporting = slowExport.exportJournal();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await store.commit(command({ commandId: 'concurrent:export:write', expectedRevision: 1 }));
  const snapshot = await exporting;
  assert.equal(snapshot.head, 1);
  assert.equal(snapshot.operations.length, 1);
  assert.equal((await store.exportJournal()).head, 2);
});
