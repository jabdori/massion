import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  COMMIT_QUERY, EVENTS_QUERY, LOAD_QUERY, OPERATION_QUERY,
  CommitOutcomeUnknownError, EventCursorError, InMemoryStore, StorageContentionError, StorageProtocolError, StorageQueryError, SurrealStore, createHttpRpcTransport, initializeSurrealSchema,
} from '../src/storage.ts';
import type { CommitInput, QueryTransport } from '../src/storage.ts';

const command = (overrides: Partial<CommitInput<{ title: string }>> = {}): CommitInput<{ title: string }> => ({
  id: 'work-1', commandId: 'command-1', fingerprint: 'canonical-command-1', expectedRevision: 0,
  value: { title: 'Accepted snapshot' }, events: [{ type: 'work.created' }], outbox: [{ effectId: 'effect-1' }], ...overrides,
});
const now = () => new Date('2026-10-03T00:00:00.000Z');

test('test-only memory store retains state, audit, events and outbox together', async () => {
  const store = new InMemoryStore<{ title: string }>(now);
  assert.equal(await store.load('work-1'), null);
  const input = command();
  assert.deepEqual(await store.commit(input), { status: 'committed', revision: 1, value: input.value });
  const [operation] = store.inspect();
  assert.ok(operation);
  assert.deepEqual(operation.events, input.events);
  assert.deepEqual(operation.outbox, input.outbox);
  assert.equal(operation.recordedAt, now().toISOString());
  assert.equal(operation.expectedRevision, 0);
  assert.equal(operation.revision, 1);
  input.value.title = 'Changed by caller';
  assert.equal((await store.load(input.id))?.value.title, 'Accepted snapshot');
  operation.value.title = 'Changed inspected copy';
  assert.equal((await store.load(input.id))?.value.title, 'Accepted snapshot');
});

test('same revision concurrent commands have one winner, without extra journal entries', async () => {
  const store = new InMemoryStore();
  const results = await Promise.all([store.commit(command()), store.commit(command({ commandId: 'command-2' }))]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['committed', 'conflict']);
  assert.equal(store.inspect().length, 1);
  assert.equal((await store.load('work-1'))?.revision, 1);
});

test('replay returns original revision and value after later state updates', async () => {
  const store = new InMemoryStore();
  const first = command();
  await store.commit(first);
  await store.commit(command({ commandId: 'command-2', expectedRevision: 1, value: { title: 'New state' } }));
  assert.deepEqual(await store.commit(first), { status: 'replayed', revision: 1, value: first.value });
  assert.deepEqual(await store.lookupOperation(first), { status: 'replayed', revision: 1, value: first.value });
  assert.equal((await store.load(first.id))?.revision, 2);
  assert.equal(store.inspect().length, 2);
});

test('idempotency collision covers fingerprint, aggregate, state, events and outbox', async () => {
  const store = new InMemoryStore();
  await store.commit(command());
  for (const change of [
    { fingerprint: 'other' }, { id: 'work-2' }, { value: { title: 'Changed' } },
    { events: [{ type: 'changed' }] }, { outbox: [] }, { expectedRevision: 1 },
  ]) {
    assert.deepEqual(await store.commit(command(change)), { status: 'conflict', revision: 1, reason: 'idempotency' });
  }
  assert.equal(store.inspect().length, 1);
  assert.deepEqual(await store.lookupOperation({ id: 'work-1', commandId: 'command-1', fingerprint: 'other' }), { status: 'conflict', revision: 1, reason: 'idempotency' });
});

test('invalid JSON or revision is rejected before changing any memory state', async () => {
  const store = new InMemoryStore();
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), [, 1]]) {
    await assert.rejects(store.commit({ ...command(), value }), TypeError);
  }
  await assert.rejects(store.commit(command({ expectedRevision: -1 })), TypeError);
  await assert.rejects(store.commit(command({ expectedRevision: Number.MAX_SAFE_INTEGER })), TypeError);
  assert.equal(store.inspect().length, 0);
});

test('canonical identity is independent of property insertion order', async () => {
  const store = new InMemoryStore();
  const first = { ...command(), value: { x: 1, y: 2 } };
  await store.commit(first);
  assert.equal((await store.commit({ ...first, value: { y: 2, x: 1 } })).status, 'replayed');
});

function mockedStore(handler: QueryTransport['query']) { return new SurrealStore({ query: handler }, now); }

test('adapter sends one variable-bound transaction with every journal component', async () => {
  const input = command({ id: "'; DELETE massion_state; --" });
  const store = mockedStore(async (sql, variables) => {
    assert.equal(sql, COMMIT_QUERY);
    assert.ok(!sql.includes(input.id));
    assert.equal(variables.aggregateId, input.id);
    assert.deepEqual(variables.value, input.value);
    assert.deepEqual(variables.events, input.events);
    assert.deepEqual(variables.outbox, input.outbox);
    assert.equal((variables.eventRows as unknown[]).length, 1);
    assert.equal((variables.outboxRows as unknown[]).length, 1);
    assert.match(sql, /BEGIN TRANSACTION/);
    assert.match(sql, /massion_audit/);
    assert.match(sql, /massion_event/);
    assert.match(sql, /massion_outbox/);
    assert.match(sql, /COMMIT TRANSACTION/);
    return [{ status: 'committed', revision: 1, value: input.value }];
  });
  assert.equal((await store.commit(input)).status, 'committed');
});

test('connection loss after committed write resolves by operation identity without retransmission', async () => {
  const input = command();
  const reference = new InMemoryStore(now);
  let writes = 0;
  const store = mockedStore(async (sql) => {
    if (sql === COMMIT_QUERY) {
      writes += 1;
      await reference.commit(input);
      throw new Error('connection dropped after server commit');
    }
    assert.equal(sql, OPERATION_QUERY);
    return [reference.inspect()[0]];
  });
  assert.deepEqual(await store.commit(input), { status: 'replayed', revision: 1, value: input.value });
  assert.equal(writes, 1);
});

test('absent operation after timeout remains unknown and does not retry', async () => {
  let writes = 0;
  let reads = 0;
  const store = mockedStore(async (sql) => {
    if (sql === COMMIT_QUERY) { writes += 1; throw new Error('timeout'); }
    reads += 1;
    assert.equal(sql, OPERATION_QUERY);
    return [null];
  });
  await assert.rejects(store.commit(command()), (error: unknown) => error instanceof CommitOutcomeUnknownError && error.commandId === 'command-1');
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(await store.reconcile(command()), { status: 'unknown' });
  assert.equal(writes, 1);
});

test('readback failure and malformed success are also ambiguous, never success', async () => {
  for (const failRead of [true, false]) {
    const store = mockedStore(async (sql) => {
      if (sql === COMMIT_QUERY) return [{ status: 'committed', revision: 1 }];
      if (failRead) throw new Error('read unavailable');
      return [null];
    });
    await assert.rejects(store.commit(command()), CommitOutcomeUnknownError);
  }
});

test('known transaction rejection plus advanced snapshot gives explicit revision conflict', async () => {
  const store = mockedStore(async (sql) => {
    if (sql === COMMIT_QUERY) throw new StorageQueryError('transaction rejected');
    if (sql === OPERATION_QUERY) return [null];
    assert.equal(sql, LOAD_QUERY);
    return [{ aggregateId: 'work-1', revision: 1, value: { title: 'Other winner' } }];
  });
  assert.deepEqual(await store.commit(command()), { status: 'conflict', revision: 1, reason: 'revision' });
});

test('known query rejection without a revision race is surfaced, not retried', async () => {
  const failure = new StorageQueryError('schema rejected an event');
  const store = mockedStore(async (sql) => {
    if (sql === COMMIT_QUERY) throw failure;
    return [null];
  });
  await assert.rejects(store.commit(command()), (error) => error === failure);
});

test('HTTP RPC encodes structured variables and validates matching response IDs', async () => {
  const transport = createHttpRpcTransport({
    endpoint: 'http://127.0.0.1:8000/rpc', namespace: 'tests', database: 'tests',
    fetch: (async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:8000/rpc');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Surreal-NS'), 'tests');
      assert.equal(headers.get('Surreal-DB'), 'tests');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.method, 'query');
      assert.equal(body.params[0], 'LET $data = encoding::json::decode($__massion_json_0);\nRETURN $data;');
      assert.deepEqual(body.params[1], { __massion_json_0: JSON.stringify({ n: 3, quote: "a'b" }) });
      assert.ok(!body.params[0].includes("a'b"));
      return Response.json({ id: body.id, result: [{ status: 'OK', result: null }, { status: 'OK', result: { quote: "a'b", n: 3 } }] });
    }) as typeof fetch,
  });
  assert.deepEqual(await transport.query('RETURN $data;', { data: { quote: "a'b", n: 3 } }), [{ quote: "a'b", n: 3 }]);
});

test('RPC JSON bindings reject injected names, avoid collisions and preserve result positions', async () => {
  let calls = 0;
  const transport = createHttpRpcTransport({ endpoint: 'http://localhost:8000/rpc', namespace: 'tests', database: 'tests',
    fetch: (async (_url, init) => {
      calls += 1;
      const { id, params } = JSON.parse(String(init?.body));
      assert.equal(params[0], 'LET $__massion_json_0 = encoding::json::decode($__massion_json__0);\nRETURN $__massion_json_0; RETURN 2;');
      assert.deepEqual(params[1], { __massion_json__0: '"run:verifier:assignment"' });
      return Response.json({ id, result: [{ status: 'OK', result: null }, { status: 'OK', result: 'run:verifier:assignment' }, { status: 'OK', result: 2 }] });
    }) as typeof fetch });
  await assert.rejects(transport.query('RETURN 1;', { 'x; DELETE massion_state;': 1 }), TypeError);
  assert.equal(calls, 0);
  assert.deepEqual(await transport.query('RETURN $__massion_json_0; RETURN 2;', { __massion_json_0: 'run:verifier:assignment' }), ['run:verifier:assignment', 2]);
});

test('failed or malformed pre-transaction JSON bindings never prove commit rollback', async () => {
  for (const binding of [{ status: 'ERR', result: 'decoding failed' }, { status: 'OK', result: 'unexpected binding result' }]) {
    const transport = createHttpRpcTransport({ endpoint: 'http://localhost:8000/rpc', namespace: 'tests', database: 'tests',
      fetch: (async (_url, init) => {
        const { id } = JSON.parse(String(init?.body));
        return Response.json({ id, result: [binding, { status: 'OK', result: { status: 'committed', revision: 1 } }] });
      }) as typeof fetch });
    await assert.rejects(transport.query('RETURN $value;', { value: 'run:executor:assignment' }), StorageProtocolError);
  }
});

test('HTTP RPC rejects error statuses anywhere in response and protocol violations', async () => {
  for (const kind of ['statement', 'wrong-id', 'empty', 'http', 'rpc-error']) {
    const transport = createHttpRpcTransport({
      endpoint: 'http://localhost:8000/rpc', namespace: 'tests', database: 'tests',
      fetch: (async (_url, init) => {
        const { id } = JSON.parse(String(init?.body));
        if (kind === 'http') return new Response('', { status: 503 });
        if (kind === 'rpc-error') return Response.json({ id, error: { code: -1, message: 'error' } });
        return Response.json({ id: kind === 'wrong-id' ? 'wrong' : id, result: kind === 'empty' ? [] : [
          { status: 'OK', result: { status: 'committed', revision: 1 } },
          { status: kind === 'statement' ? 'ERR' : 'OK', result: 'commit conflict' },
        ] });
      }) as typeof fetch,
    });
    await assert.rejects(transport.query('RETURN 1;', {}), kind === 'statement' ? StorageQueryError : StorageProtocolError);
  }
  assert.throws(() => createHttpRpcTransport({ endpoint: 'http://example.com/rpc', namespace: 'n', database: 'd' }), TypeError);
  assert.throws(() => createHttpRpcTransport({ endpoint: 'https://name:password@example.com/rpc', namespace: 'n', database: 'd' }), TypeError);
});

test('HTTP conflict classification uses structured kind, not message guesses', async () => {
  for (const structured of [true, false]) {
    const transport = createHttpRpcTransport({ endpoint: 'http://localhost:8000/rpc', namespace: 'tests', database: 'tests',
      fetch: (async (_url, init) => {
        const { id } = JSON.parse(String(init?.body));
        return Response.json({ id, result: [
          { status: 'ERR', result: 'The query was not executed due to a failed transaction', kind: 'Query', details: { kind: 'NotExecuted' } },
          { status: 'ERR', result: 'Cannot COMMIT: Transaction conflict', kind: 'Query', details: { kind: structured ? 'TransactionConflict' : 'Other' } },
        ] });
      }) as typeof fetch });
    await assert.rejects(transport.query('RETURN 1;', {}), (error: unknown) => structured
      ? error instanceof StorageContentionError && error.retryable
      : error instanceof StorageQueryError && !(error instanceof StorageContentionError));
  }
});

test('event feed orders committed operations globally with bounded cursor pagination', async () => {
  const store = new InMemoryStore(now);
  assert.deepEqual(await store.readEvents(0), { events: [], cursor: 0 });
  const first = command();
  await store.commit(first);
  await store.commit(command({ id: 'other-work', commandId: 'other-command', events: [] }));
  await store.commit(first);
  await store.commit(command({ commandId: 'losing-revision' }));
  const page = await store.readEvents(0, 1);
  assert.deepEqual(page, { events: [{ cursor: 1, aggregateId: first.id, revision: 1, commandId: first.commandId, events: first.events }], cursor: 1 });
  assert.deepEqual(await store.readEvents(page.cursor), { events: [{ cursor: 2, aggregateId: 'other-work', revision: 1, commandId: 'other-command', events: [] }], cursor: 2 });
  assert.deepEqual(await store.readEvents(2), { events: [], cursor: 2 });
  (page.events[0]!.events as unknown[]).push('caller mutation');
  assert.deepEqual((await store.readEvents(0, 1)).events[0]!.events, first.events);
});

test('event cursors and limits reject invalid numbers and future positions', async () => {
  const store = new InMemoryStore();
  const remote = mockedStore(async () => { throw new Error('invalid inputs must not query'); });
  for (const target of [store, remote]) {
    for (const after of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0' as unknown as number]) {
      await assert.rejects(target.readEvents(after), TypeError);
    }
    for (const limit of [0, -1, 1001, 1.5, NaN, Infinity, '1' as unknown as number]) {
      await assert.rejects(target.readEvents(0, limit), TypeError);
    }
  }
  await assert.rejects(store.readEvents(1), (error: unknown) => error instanceof EventCursorError && error.head === 0 && error.after === 1);
});

test('event transport validates increasing safe cursors and preserves entire event payload', async () => {
  const event = { type: 'approved', actorId: 'owner', command: { type: 'approve', scope: 'fixture' } };
  const store = mockedStore(async (sql, vars) => {
    assert.equal(sql, EVENTS_QUERY); assert.deepEqual(vars, { after: 3, limit: 10 });
    return [{ head: 4, events: [{ cursor: 4, aggregateId: 'mission', revision: 2, commandId: 'approval', events: [event] }] }];
  });
  assert.deepEqual((await store.readEvents(3, 10)).events[0]!.events, [event]);
  for (const result of [
    { head: 2, events: [{ cursor: 1, aggregateId: 'm', revision: 1, commandId: 'c', events: [] }] },
    { head: 2, events: [{ cursor: 3, aggregateId: 'm', revision: 1, commandId: 'c', events: [] }] },
    { head: 2, events: [{ cursor: 2, aggregateId: 'm', revision: 0, commandId: 'c', events: [] }] },
    { head: 2.5, events: [] },
  ]) await assert.rejects(mockedStore(async () => [result]).readEvents(1), StorageProtocolError);
  await assert.rejects(mockedStore(async () => [{ head: 2, events: [] }]).readEvents(3), EventCursorError);
});

test('one-host commit queue serializes writes and recovers after rejected operation', async () => {
  let active = 0;
  let maximum = 0;
  let writes = 0;
  const store = mockedStore(async (sql, variables) => {
    if (sql !== COMMIT_QUERY) return [null];
    active += 1; maximum = Math.max(maximum, active); writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (variables.commandId === 'reject') throw new StorageQueryError('invalid value');
    return [{ status: 'committed', revision: 1, value: variables.value }];
  });
  const rejected = store.commit(command({ commandId: 'reject' }));
  const queued = command({ commandId: 'accepted' });
  const accepted = store.commit(queued);
  queued.value.title = 'caller changed after queueing';
  await assert.rejects(rejected, StorageQueryError);
  assert.deepEqual(await accepted, { status: 'committed', revision: 1, value: { title: 'Accepted snapshot' } });
  assert.equal(maximum, 1); assert.equal(writes, 2);
});

const endpoint = process.env.MASSION_TEST_SURREAL_RPC;
test('actual SurrealDB conformance: atomic journal, revision race, replay and response-loss readback', { skip: !endpoint }, async () => {
  // This test is opt-in and must only target a fresh, disposable database.
  assert.ok(endpoint?.startsWith('http://127.0.0.1:'));
  const transport = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' });
  await initializeSurrealSchema(transport);
  const store = new SurrealStore(transport, now);
  const prefix = randomUUID();
  const first = command({ id: `work-${prefix}`, commandId: `command-${prefix}` });
  assert.equal(await store.load(first.id), null);
  const committed = await store.commit(first);
  assert.deepEqual(committed, { status: 'committed', revision: 1, value: first.value });
  const restartedClient = new SurrealStore(transport, now);
  assert.deepEqual(await restartedClient.load(first.id), { revision: 1, value: first.value });
  const journal = await transport.query(`RETURN {
    operations: (SELECT * FROM massion_operation WHERE commandId = $commandId),
    audits: (SELECT * FROM massion_audit WHERE commandId = $commandId),
    events: (SELECT * FROM massion_event WHERE operation.commandId = $commandId),
    outbox: (SELECT * FROM massion_outbox WHERE operation.commandId = $commandId)
  };`, { commandId: first.commandId });
  const retained = journal[0] as Record<string, unknown[]>;
  for (const key of ['operations', 'audits', 'events', 'outbox']) assert.equal(retained[key]!.length, 1, key);
  await store.commit(command({ id: first.id, commandId: `${first.commandId}-later`, expectedRevision: 1, value: { title: 'Later' } }));
  assert.deepEqual(await store.commit(first), { status: 'replayed', revision: 1, value: first.value });
  assert.deepEqual(await store.lookupOperation(first), { status: 'replayed', revision: 1, value: first.value });
  assert.deepEqual(await store.commit({ ...first, events: [] }), { status: 'conflict', revision: 1, reason: 'idempotency' });
  const racers = Array.from({ length: 12 }, (_, n) => command({ id: `${first.id}-race`, commandId: `${first.commandId}-race-${n}` }));
  const raceResults = await Promise.all(racers.map((input) => new SurrealStore(transport, now).commit(input)));
  assert.equal(raceResults.filter((result) => result.status === 'committed').length, 1);
  assert.equal(raceResults.filter((result) => result.status === 'conflict').length, 11);
  const racedJournal = await transport.query(`RETURN {
    operations: (SELECT * FROM massion_operation WHERE aggregateId = $aggregateId),
    audits: (SELECT * FROM massion_audit WHERE aggregateId = $aggregateId),
    events: (SELECT * FROM massion_event WHERE aggregate = type::record('massion_state', $aggregateKey)),
    outbox: (SELECT * FROM massion_outbox WHERE aggregate = type::record('massion_state', $aggregateKey))
  };`, { aggregateId: racers[0]!.id, aggregateKey: createHash('sha256').update(racers[0]!.id).digest('hex') });
  for (const rows of Object.values(racedJournal[0] as Record<string, unknown[]>)) assert.equal(rows.length, 1);
  const duplicate = command({ id: `${first.id}-duplicate`, commandId: `${first.commandId}-duplicate` });
  const duplicateResults = await Promise.all(Array.from({ length: 12 }, () => new SurrealStore(transport, now).commit(duplicate)));
  assert.equal(duplicateResults.filter((result) => result.status === 'committed').length, 1);
  assert.equal(duplicateResults.filter((result) => result.status === 'replayed').length, 11);
  let writes = 0;
  const lostResponse = new SurrealStore({ query: async (sql, variables) => {
    const result = await transport.query(sql, variables);
    if (sql === COMMIT_QUERY) { writes += 1; throw new Error('injected response loss after real commit'); }
    return result;
  } }, now);
  const uncertain = command({ id: `${first.id}-lost`, commandId: `${first.commandId}-lost` });
  assert.deepEqual(await lostResponse.commit(uncertain), { status: 'replayed', revision: 1, value: uncertain.value });
  assert.equal(writes, 1);
  // A failure deliberately inserted after the journal writes must roll all of them back.
  const broken = command({ id: `${first.id}-rollback`, commandId: `${first.commandId}-rollback` });
  const failing = new SurrealStore({ query: (sql, variables) => transport.query(sql === COMMIT_QUERY ? sql.replace("RETURN { status: 'committed'", "THROW 'injected failure';\nRETURN { status: 'committed'") : sql, variables) }, now);
  await assert.rejects(failing.commit(broken), StorageQueryError);
  assert.equal(await store.load(broken.id), null);
  assert.deepEqual(await store.lookupOperation(broken), { status: 'unknown' });
  const rollbackJournal = await transport.query(`RETURN {
    audits: (SELECT * FROM massion_audit WHERE commandId = $commandId),
    events: (SELECT * FROM massion_event WHERE operation = type::record('massion_operation', $operationKey)),
    outbox: (SELECT * FROM massion_outbox WHERE operation = type::record('massion_operation', $operationKey))
  };`, { commandId: broken.commandId, operationKey: createHash('sha256').update(broken.commandId).digest('hex') });
  for (const rows of Object.values(rollbackJournal[0] as Record<string, unknown[]>)) assert.equal(rows.length, 0);
});

test('actual SurrealDB event reconnect, replay suppression, rollback and cross-store contention', { skip: !endpoint }, async () => {
  const transport = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' });
  await initializeSurrealSchema(transport);
  const store = new SurrealStore(transport, now);
  const baseline = await store.readEvents(0, 1000);
  const prefix = randomUUID();
  const first = command({ id: `feed-${prefix}`, commandId: `feed-${prefix}` });
  await store.commit(first);
  const page = await store.readEvents(baseline.cursor, 1);
  assert.equal(page.cursor, baseline.cursor + 1);
  assert.deepEqual(page.events, [{ cursor: page.cursor, aggregateId: first.id, revision: 1, commandId: first.commandId, events: first.events }]);
  const later = command({ id: `later-${prefix}`, commandId: `later-${prefix}`, events: [{ actorId: 'owner', type: 'changed', scope: 'fixture' }] });
  await store.commit(later);
  await store.commit(first);
  assert.equal((await store.commit({ ...first, commandId: `${first.commandId}-stale` })).status, 'conflict');
  const reconnect = new SurrealStore(transport, now);
  const next = await reconnect.readEvents(page.cursor);
  assert.deepEqual(next.events, [{ cursor: page.cursor + 1, aggregateId: later.id, revision: 1, commandId: later.commandId, events: later.events }]);
  assert.deepEqual(await reconnect.readEvents(next.cursor), { events: [], cursor: next.cursor });
  await assert.rejects(reconnect.readEvents(next.cursor + 1), EventCursorError);
  const failed = command({ id: `failed-${prefix}`, commandId: `failed-${prefix}` });
  const failing = new SurrealStore({ query: (sql, variables) => transport.query(sql === COMMIT_QUERY ? sql.replace("RETURN { status: 'committed'", "THROW 'injected failure';\nRETURN { status: 'committed'") : sql, variables) }, now);
  await assert.rejects(failing.commit(failed), StorageQueryError);
  assert.deepEqual(await reconnect.readEvents(next.cursor), { events: [], cursor: next.cursor });
  const queued = Array.from({ length: 6 }, (_, n) => command({ id: `queued-${prefix}-${n}`, commandId: `queued-${prefix}-${n}` }));
  const queuedResults = await Promise.all(queued.map((input) => store.commit(input)));
  assert.ok(queuedResults.every((result) => result.status === 'committed'));
  const queuedPage = await reconnect.readEvents(next.cursor);
  assert.equal(queuedPage.events.length, 6);
  assert.deepEqual(queuedPage.events.map((entry) => entry.cursor), Array.from({ length: 6 }, (_, n) => next.cursor + n + 1));

  // Separate instances deliberately bypass the one-host queue. Hold the same
  // counter snapshot long enough to establish an actual cross-store conflict.
  const contendedTransport: QueryTransport = { query: (sql, vars) => transport.query(sql === COMMIT_QUERY ? sql.replace('UPDATE massion_feed:global', 'SLEEP 50ms;\nUPDATE massion_feed:global') : sql, vars) };
  const contenders = [0, 1].map((n) => new SurrealStore(contendedTransport, now).commit(command({ id: `contention-${prefix}-${n}`, commandId: `contention-${prefix}-${n}` })));
  const outcomes = await Promise.allSettled(contenders);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof StorageContentionError, String(rejection.reason));
  assert.equal(rejection.reason.retryable, true);
  const tail = await reconnect.readEvents(queuedPage.cursor);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.cursor, queuedPage.cursor + 1);
});

test('actual SurrealDB initializer refuses legacy journal without fabricating cursor history', { skip: !endpoint }, async () => {
  const transport = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' });
  const database = `legacy_${randomUUID().replaceAll('-', '')}`;
  await transport.query(`DEFINE DATABASE ${database};`, {});
  const legacy = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database });
  await legacy.query(`DEFINE TABLE massion_operation SCHEMALESS; CREATE massion_operation:legacy CONTENT { commandId: 'legacy' };`, {});
  await assert.rejects(initializeSurrealSchema(legacy), StorageQueryError);
  const retained = await legacy.query('SELECT * FROM massion_operation;', {});
  assert.equal((retained[0] as Record<string, unknown>[])[0]!.commandId, 'legacy');
  assert.equal(Object.hasOwn((retained[0] as Record<string, unknown>[])[0]!, 'cursor'), false);
});

test('actual SurrealDB preserves nested opaque colon IDs and full JSON source/output payloads', { skip: !endpoint }, async () => {
  const options = { endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' };
  const transport = createHttpRpcTransport(options);
  await initializeSurrealSchema(transport);
  const suffix = randomUUID();
  const value = {
    id: 'mission:readiness:review',
    assignments: [
      { id: 'run:executor:assignment', taskId: 'task:source:analysis', source: 'run:executor:assignment' },
      { id: 'run:verifier:assignment', taskId: 'task:source:review', output: 'run:verifier:assignment' },
    ],
    source: { uri: 'https://example.invalid/source:a:b', content: 'source:opaque:full', text: 'Quote: "preserve me"\nBackslash: \\ 🧭 한글' },
    output: { content: 'result:opaque:full', receipt: '{"id":"run:executor:assignment","output":"a:b:c"}', empty: '', nil: null },
    literals: ['person:tobie:extra', '2026-10-03T06:30:00.000Z', 'NONE', 'null', 'true', '1.25', '550e8400-e29b-41d4-a716-446655440000'],
    arrays: [[{ id: 'nested:one:two', more: [true, false, null, 0, 1.25, 1e100, 1e-100] }]],
    'opaque:key:full': { 'nested:key': 'value:with:colons' },
  };
  const input: CommitInput<typeof value> = {
    id: `mission:${suffix}:aggregate`, commandId: `command:${suffix}:commit`, fingerprint: `fingerprint:${suffix}:full`,
    expectedRevision: 0, value,
    events: [{ id: 'event:accepted:full', actorId: 'actor:verifier:full', command: { id: 'command:review:full', source: value.source, output: value.output } }],
    outbox: [{ id: 'outbox:effect:full', target: 'target:artifact:full', payload: value }],
  };
  const original = structuredClone(input);
  assert.deepEqual(await transport.query('RETURN $value;', { value }), [value], 'RPC echo must preserve JSON before storage');
  for (const scalar of [null, true, false, 0, 1.25, 'source:opaque:full', '', ['nested:id:full']]) {
    assert.deepEqual(await transport.query('RETURN $scalar;', { scalar }), [scalar]);
  }
  assert.deepEqual(await transport.query('RETURN type::of($value.assignments[0].id);', { value }), ['string']);
  const store = new SurrealStore<typeof value>(transport, now);
  const before = await store.readEvents(0, 1000);
  assert.deepEqual(await store.commit(input), { status: 'committed', revision: 1, value: original.value });
  assert.deepEqual(input, original, 'commit cannot mutate caller input');
  const fresh = new SurrealStore<typeof value>(createHttpRpcTransport(options), now);
  assert.deepEqual(await fresh.load(input.id), { revision: 1, value: original.value });
  assert.deepEqual(await fresh.lookupOperation(input), { status: 'replayed', revision: 1, value: original.value });
  assert.deepEqual(await fresh.reconcile(input), { status: 'replayed', revision: 1, value: original.value });
  const [operations, eventRows, outboxRows] = await transport.query(`
    SELECT * FROM massion_operation WHERE commandId = $commandId;
    SELECT payload FROM massion_event WHERE operation.commandId = $commandId ORDER BY ordinal;
    SELECT payload FROM massion_outbox WHERE operation.commandId = $commandId ORDER BY ordinal;
  `, { commandId: input.commandId });
  const operation = (operations as Record<string, unknown>[])[0]!;
  assert.deepEqual({ id: operation.aggregateId, commandId: operation.commandId, fingerprint: operation.fingerprint, expectedRevision: operation.expectedRevision,
    value: operation.value, events: operation.events, outbox: operation.outbox }, original, 'entire commit input must survive the durable journal');
  assert.deepEqual((eventRows as { payload: unknown }[]).map((entry) => entry.payload), original.events);
  assert.deepEqual((outboxRows as { payload: unknown }[]).map((entry) => entry.payload), original.outbox);
  assert.deepEqual((await fresh.readEvents(before.cursor)).events, [{ cursor: before.cursor + 1, aggregateId: input.id, revision: 1, commandId: input.commandId, events: original.events }]);
  assert.deepEqual(await fresh.commit(input), { status: 'replayed', revision: 1, value: original.value });
  assert.deepEqual(await fresh.readEvents(before.cursor + 1), { events: [], cursor: before.cursor + 1 });
});

test('actual SurrealDB crash restart and clean backup restore retain exact snapshots and journal', {
  skip: !endpoint || process.env.MASSION_TEST_SURREAL_RESTART !== '1',
}, async t => {
  const {runIsolatedStorageRestart}=await import('./support/storage-restart.ts');
  const evidence=await runIsolatedStorageRestart();t.diagnostic(JSON.stringify(evidence));
});
