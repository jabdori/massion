import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHttpTransport, createProtocolClient} from '../../src/client-protocol.ts';
import {createPinnedDatabaseFetch, generateStartCertificate} from '../../src/database-tls.ts';
import {hash} from '../../src/domain.ts';
import {createHttpRpcTransport, SurrealStore, validateJournal} from '../../src/storage.ts';

const repo = resolve(import.meta.dirname, '../..');
const fixtures = ['2026-11-28-tauri-d4c1386', '2026-11-19-tauri-a1e98ec'];
const fixture = process.env.MASSION_SPIKE_FIXTURE ?? fixtures[0];
const ownerCheck = join(homedir(), 'massion-research/owner-check');
const runtime = process.env.MASSION_SPIKE_RUNTIME ?? join(ownerCheck, '2026-11-28-tauri-07905ae/app/Massion.app/Contents/MacOS');
const spike = join(homedir(), 'orca/workspaces/massion/.rust-spike-target/release/massion-core-spike');
const hostNode = join(runtime, 'node');
const surreal = join(runtime, 'surreal');
const fixtureSource = join(ownerCheck, fixture, 'fresh-data-folder');
const scratch = join(repo, '.runtime');
const signal = () => AbortSignal.timeout(5000);
const running = new Set();
let interrupted = false;
for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(name, () => {
    interrupted = true;
    process.exitCode = code;
    void Promise.allSettled([...running].map(child => stop(child)));
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

function launch(program, args, directory, env = {}, fd = false) {
  assert.ok(!interrupted, 'Verification interrupted');
  const child = spawn(program, args, {
    cwd: directory, env: {PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, ...env},
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', ...(fd ? ['pipe', 'pipe'] : [])],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({code, signal}));
  });
  let output = '', diagnostic = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-8192); });
  const process = {child, exited, output: () => output, diagnostic: () => diagnostic.replace(/[a-f0-9]{64}/gi, '[redacted]')};
  running.add(process);
  const remove = () => running.delete(process);
  void exited.then(remove, remove);
  return process;
}

async function stop(process, signal = 'SIGTERM') {
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 12000);
  process.child.kill(signal);
  try { return await process.exited; } finally { clearTimeout(timer); }
}

async function until(probe, processes, description, timeout = 15000) {
  const end = performance.now() + timeout;
  let last;
  while (performance.now() < end) {
    for (const process of processes) {
      if (process.child.exitCode !== null || process.child.signalCode !== null || process.child.pid === undefined) {
        throw new Error(`${description}: process exited (${JSON.stringify(await process.exited)}) ${process.diagnostic()}`);
      }
    }
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(15);
  }
  throw new Error(`Timed out waiting for ${description}`, {cause: last});
}

function client(base) {
  return createProtocolClient(createHttpTransport((path, options) => fetch(base + path, options)));
}

async function ready(port, processes, start) {
  const base = `http://127.0.0.1:${port}`;
  const connected = await until(async () => {
    const caller = client(base);
    return (await caller.connection()).state === 'ready' && caller;
  }, processes, 'protocol negotiation');
  return {base, client: connected, milliseconds: performance.now() - start};
}

async function rustHost(directory, pause = false) {
  const location = join(directory, 'database');
  await mkdir(location, {recursive: true});
  const start = performance.now();
  const rust = launch(spike, ['serve', location, '0', ...(pause ? ['--pause-before-commit'] : [])], directory);
  try {
    const port = await until(() => Number(rust.output().match(/Massion spike: http:\/\/127\.0\.0\.1:(\d+)\n/)?.[1]), [rust], 'Rust bind');
    return {...await ready(port, [rust], start), rust, processes: [rust], close: signal => stop(rust, signal)};
  } catch (error) { await stop(rust); throw error; }
}

async function nodeHost(directory, comparison = false) {
  await regularTree(directory);
  const password = await readFile(join(directory, 'database/password'), 'utf8');
  assert.ok(/^[a-f0-9]{64}$/.test(password), 'Invalid fixture database credential');
  const dbPort = await freePort();
  let port = await freePort();
  while (port === dbPort) port = await freePort();
  const endpoint = `https://127.0.0.1:${dbPort}`;
  const config = join(directory, 'offline-host.json');
  if (!comparison) await writeFile(config, JSON.stringify({version: 1, revision: 'spike', mode: 'local-http-mock',
    connections: [{id: 'spike', label: 'Spike', providerType: 'compatible', baseUrl: 'http://127.0.0.1:1/v1/', models: ['unused']}]}));
  const {certificate, privateKey} = generateStartCertificate();
  const certPath = join(directory, 'spike-cert.pem');
  const keyPath = join(directory, 'spike-key.pem');
  await writeFile(certPath, certificate, {mode: 0o600});
  await writeFile(keyPath, privateKey, {mode: 0o600});
  const pinnedFetch = createPinnedDatabaseFetch(certificate);
  const transport = createHttpRpcTransport({endpoint: `${endpoint}/rpc`, namespace: 'massion', database: 'massion', fetch: pinnedFetch,
    authorization: `Basic ${Buffer.from(`root:${password}`).toString('base64')}`});
  const store = new SurrealStore(transport);
  const start = performance.now();
  const database = launch(surreal, ['start', `surrealkv://${join(directory, 'database')}`, '--bind', `127.0.0.1:${dbPort}`,
    '--no-banner', '--log', 'error', '--deny-net', '--deny-scripting', '--web-crt', certPath, '--web-key', keyPath], directory);
  let core, server;
  async function close() {
    try {
      if (server) return {code: (await server.drain()).status === 'drained' ? 0 : 1};
      if (core) return await stop(core);
    } finally { await stop(database); }
  }
  try {
    await until(async () => (await pinnedFetch(`${endpoint}/health`, {signal: signal()})).ok, [database], 'pinned SurrealDB health');
    if (comparison) {
      const {createWorkbench} = await import('../../src/server.ts');
      server = createWorkbench(store, directory, {scheduleIntervalMs: 0});
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return {...await ready(server.address().port, [database], start), store, transport, close};
    }
    core = launch(hostNode, [join(repo, 'src/server.ts'), '--host-config', config], directory,
      {MASSION_SURREAL_RPC: `${endpoint}/rpc`, MASSION_SURREAL_AUTH_FD: '4', MASSION_SURREAL_CERT_FD: '5', MASSION_PORT: String(port)}, true);
    for (const [fd, data] of [[4, password], [5, certificate]]) {
      core.child.stdio[fd].on('error', () => {});
      core.child.stdio[fd].end(data);
    }
    await until(() => core.output().includes(`Massion development workbench: http://127.0.0.1:${port}\n`), [database, core], 'Node bind');
    return {...await ready(port, [database, core], start), processes: [core, database], close};
  } catch (error) {
    await close();
    throw error;
  }
}

async function fixtureCopy(directory) {
  assert.ok(fixtures.includes(fixture), 'An approved fixture is required');
  await regularTree(fixtureSource);
  await cp(fixtureSource, directory, {recursive: true, errorOnExist: true, force: false});
  await regularTree(directory);
}

async function regularTree(directory) {
  assert.equal(await realpath(directory), directory, 'Directory path must not follow symlinks');
  for (const entry of await readdir(directory, {recursive: true, withFileTypes: true})) {
    assert.ok(entry.isFile() || entry.isDirectory(), 'Fixture can only contain regular files and directories');
  }
}

function createBody() {
  return {id: `mission:${randomUUID()}`, commandId: randomUUID(), purpose: 'Mission 漢字 😀', scope: 'same:literal',
    constraints: ['raw:record', 'e\u0301', 'é'], criteria: {version: 1, description: 'Original receipt', oracle: 'manual-review/v1'}};
}

function create(host, body, feed) {
  return host.client.dispatch('/missions', {body: JSON.stringify(body), ...(feed ? {headers: {'X-Massion-Feed': feed}} : {})});
}

async function read(host, path, feed) {
  const {response, body} = await host.client.query(path, {scope: path, ...(feed ? {headers: {'X-Massion-Feed': feed}} : {})});
  assert.equal(response.status, 200, path);
  return body;
}

async function rustExport(directory) {
  return JSON.parse(execFileSync(spike, ['export', join(directory, 'database')], {
    cwd: directory, env: {PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory}, encoding: 'utf8', maxBuffer: 8 << 20,
  }));
}

function differences(left, right, path = '$') {
  if (Object.is(left, right)) return [];
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return [path];
  return Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).flatMap(key => differences(left[key], right[key], `${path}/${key}`));
}

function assertEqual(actual, expected, label) {
  const changes = differences(actual, expected);
  assert.equal(changes.length, 0, `${label} differing fields: ${changes.join(', ')}`);
}

async function p1(directory) {
  await mkdir(directory);
  const host = await rustHost(directory);
  const body = createBody();
  try {
    const feed = (await read(host, '/read-state')).feedId;
    assert.deepEqual(await host.client.connection(), {state: 'ready', supported: {min: 1, max: 1}, features: {commands: true, queries: true, feedPush: true}, version: 1});
    const applied = await create(host, body, feed);
    assert.equal(applied.response.status, 201);
    const replay = await create(host, body, feed);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, {...applied.body, status: 'replayed'});
    assert.equal(applied.body.revision, 1);
    const conflict = await create(host, {...body, purpose: 'Changed body'}, feed);
    assert.equal(conflict.response.status, 409);
    assert.deepEqual(conflict.body, {status: 'conflict', revision: 1, reason: 'idempotency', feedId: feed});
    const stale = await create(host, {...body, commandId: randomUUID()}, feed);
    assert.equal(stale.response.status, 409);
    assert.deepEqual(stale.body, {status: 'conflict', revision: 1, reason: 'revision', feedId: feed});
    const page = await read(host, '/events?after=0&limit=1', feed);
    assert.deepEqual(page, {feedId: feed, cursor: 1, events: [{aggregateId: body.id, commandId: body.commandId,
      cursor: 1, revision: 1, events: [{actor: 'local-owner', type: 'mission-created'}]}]});
    assert.deepEqual((await read(host, `/read-state?mission=${encodeURIComponent(body.id)}`)).snapshot, {revision: 1, value: applied.body.value});
  } finally { assert.equal((await host.close()).code, 0); }
  const {journal} = await rustExport(directory);
  validateJournal(journal);
  const {commandId, ...input} = body;
  assert.equal(journal.operations[0].fingerprint, hash({actorId: 'local-owner', input, kind: 'create'}));
  assert.equal(journal.operations[0].expectedRevision, 0);
  return {head: journal.head};
}

async function pages(host) {
  const state = await read(host, '/read-state');
  const first = await read(host, '/events?after=0&limit=1', state.feedId);
  return {state, first, next: await read(host, `/events?after=${first.cursor}&limit=1`, state.feedId)};
}

async function p2(directory) {
  await mkdir(directory);
  const a = join(directory, 'node');
  const b = join(directory, 'rust');
  await fixtureCopy(a);
  await fixtureCopy(b);
  const baseline = await nodeHost(a, true);
  let expected, baselinePages, beforeStop, firstEvent, secondEvent;
  const body = createBody();
  // Numeric and Unicode key ordering has to survive a different language and a real stored replay.
  const value = {'2': 3, '10': -0, '😀': 1e21, '\ue000': 1e-7, special: [1e-6, 1e20, 9007199254740992, 'x:y']};
  const enriched = {...body, criteria: {...body.criteria, extra: value}};
  try {
    const journal = await baseline.store.exportJournal();
    const query = await readFile(join(import.meta.dirname, 'inspect.surql'), 'utf8');
    const [rows] = await baseline.transport.query(query, {});
    const snapshots = Object.fromEntries(await Promise.all(rows.states.map(async row => [row.aggregateId, await baseline.store.load(row.aggregateId)])));
    const journalSnapshots = Object.fromEntries(journal.operations.map(op => [op.aggregateId, {revision: op.revision, value: op.value}]));
    assertEqual(snapshots, journalSnapshots, 'All TypeScript snapshots match their latest journal operations');
    expected = {journal, rows};
    baselinePages = await pages(baseline);
    const stream = await openFeed(baseline, baselinePages.state.feedId, 0);
    try {
      assert.equal((await stream.next()).event.reason, 'connected');
      firstEvent = await stream.next();
      secondEvent = await stream.next();
      assert.deepEqual([firstEvent.event.cursor, secondEvent.event.cursor], [1, 2]);
    } finally { stream.close(); }
    beforeStop = await create(baseline, enriched, baselinePages.state.feedId);
    assert.equal(beforeStop.response.status, 201);
  } finally { assert.equal((await baseline.close()).code, 0); }
  assertEqual(await rustExport(b), expected, 'Stopped fixture journal, all snapshots and stored rows');
  const rust = await rustHost(b);
  try {
    assertEqual(await pages(rust), baselinePages, 'Fixture feed identity, cursor and event pages');
    const stream = await openFeed(rust, baselinePages.state.feedId, 0, firstEvent.id);
    try {
      assert.equal((await stream.next()).id, firstEvent.id);
      assertEqual(await stream.next(), secondEvent, 'TypeScript SSE ID resumes the next Rust event');
    } finally { stream.close(); }
  } finally { assert.equal((await rust.close()).code, 0); }

  const forward = await rustHost(a);
  const rustBody = createBody();
  rustBody.criteria.extra = value;
  let applied;
  try {
    const replay = await create(forward, {...enriched, criteria: {extra: Object.fromEntries(Object.entries(value).reverse()), ...body.criteria}}, baselinePages.state.feedId);
    assert.equal(replay.response.status, 200);
    assertEqual(replay.body, {...beforeStop.body, status: 'replayed'}, 'TypeScript write, Rust replay');
    assert.equal((await create(forward, {...enriched, scope: 'different'}, baselinePages.state.feedId)).body.reason, 'idempotency');
    applied = await create(forward, rustBody, baselinePages.state.feedId);
    assert.equal(applied.response.status, 201);
  } finally { assert.equal((await forward.close()).code, 0); }

  const reverse = await nodeHost(a, true);
  try {
    const replay = await create(reverse, rustBody, baselinePages.state.feedId);
    assert.equal(replay.response.status, 200);
    assertEqual(replay.body, {...applied.body, status: 'replayed'}, 'Rust write, TypeScript replay');
    const journal = await reverse.store.exportJournal();
    assert.equal(journal.head, expected.journal.head + 2);
    assert.deepEqual(journal.operations.slice(0, expected.journal.head), expected.journal.operations);
  } finally { assert.equal((await reverse.close()).code, 0); }
  return {fixture, operations: expected.journal.head, snapshots: expected.rows.states.length,
    auditRows: expected.rows.audit.length, eventRows: expected.rows.events.length, outboxRows: expected.rows.outbox.length,
    firstCursor: baselinePages.first.cursor, nextCursor: baselinePages.next.cursor, nextEvents: baselinePages.next.events.length, sseCursor: secondEvent.event.cursor};
}

async function openFeed(host, feed, after, lastEventId) {
  const controller = new AbortController();
  const url = new URL('/protocol/events', host.base);
  url.search = new URLSearchParams({version: '1', requestId: 'feed-spike', generation: '1', feedId: feed, after: String(after)});
  const timer = setTimeout(() => controller.abort(), 10000);
  const response = await fetch(url, {signal: controller.signal, headers: lastEventId ? {'Last-Event-ID': lastEventId} : {}});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {close() { clearTimeout(timer); controller.abort(); }, async next() {
    while (!buffered.includes('\n\n')) {
      const {value, done} = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, {stream: true});
    }
    const at = buffered.indexOf('\n\n');
    const frame = buffered.slice(0, at).split('\n');
    buffered = buffered.slice(at + 2);
    const event = JSON.parse(frame.find(line => line.startsWith('data: ')).slice(6));
    const id = frame.find(line => line.startsWith('id: ')).slice(4);
    assert.equal(id, JSON.stringify([event.feedId, event.cursor]));
    assert.deepEqual([event.version, event.requestId, event.generation, event.kind], [1, 'feed-spike', 1, 'feed']);
    return {id, event};
  }};
}

async function p3(directory) {
  await mkdir(directory);
  const host = await rustHost(directory);
  let feed, last, second, reconnect;
  try {
    feed = (await read(host, '/read-state')).feedId;
    const original = await openFeed(host, feed, 0);
    try {
      assert.equal((await original.next()).event.reason, 'connected');
      const first = createBody();
      assert.equal((await create(host, first, feed)).response.status, 201);
      const event = await original.next();
      assert.deepEqual([event.event.reason, event.event.cursor, event.event.aggregateId], ['revision', 1, first.id]);
      last = event.id;
    } finally { original.close(); }
    second = createBody();
    assert.equal((await create(host, second, feed)).response.status, 201);
    reconnect = await openFeed(host, feed, 0, last);
    assert.deepEqual([(await reconnect.next()).event.cursor, (await reconnect.next()).event.cursor], [1, 2]);
    assert.equal((await host.close()).code, 0);
    assert.equal(await reconnect.next(), null);
  } finally { reconnect?.close(); await host.close(); }
  const reopened = await rustHost(directory);
  try {
    const page = await read(reopened, '/events?after=1&limit=1', feed);
    assert.deepEqual([page.feedId, page.cursor, page.events[0].aggregateId], [feed, 2, second.id]);
    const resumed = await openFeed(reopened, 'different-feed', 1);
    try {
      assert.equal((await resumed.next()).event.reason, 'connected');
      const reset = (await resumed.next()).event;
      assert.deepEqual([reset.reason, reset.feedId, reset.cursor], ['reset', feed, 2]);
    } finally { resumed.close(); }
  } finally { assert.equal((await reopened.close()).code, 0); }
  return {before: 1, after: 2};
}

async function p4(directory) {
  await mkdir(directory);
  const initial = await rustHost(directory);
  const durable = createBody();
  try { assert.equal((await create(initial, durable)).response.status, 201); }
  finally { assert.equal((await initial.close()).code, 0); }
  const before = await rustExport(directory);
  validateJournal(before.journal);
  assert.equal(before.rows.audit.length, 1);
  assert.equal(before.rows.audit[0].commandId, durable.commandId);
  assert.equal(before.rows.events.length, 1);
  assert.equal(before.rows.events[0].payload.type, 'mission-created');
  const crash = await rustHost(directory, true);
  const interrupted = createBody();
  let inFlight;
  try {
    inFlight = create(crash, interrupted).then(() => true, () => false);
    await until(() => crash.rust.output().includes('write-staged-before-commit'), crash.processes, 'staged writes inside open transaction');
    assert.deepEqual(await crash.close('SIGKILL'), {code: null, signal: 'SIGKILL'});
    assert.equal(await inFlight, false);
  } finally { await crash.close('SIGKILL'); }
  assertEqual(await rustExport(directory), before, 'Journal and snapshots after SIGKILL');
  const reopened = await rustHost(directory);
  try {
    assert.equal((await read(reopened, `/read-state?mission=${encodeURIComponent(interrupted.id)}`)).snapshot, null);
    assert.deepEqual((await read(reopened, '/events?after=0')).events.map(event => event.commandId), [durable.commandId]);
    assert.equal((await create(reopened, interrupted)).response.status, 201);
    assert.equal((await create(reopened, interrupted)).body.status, 'replayed');
  } finally { assert.equal((await reopened.close()).code, 0); }
  const after = await rustExport(directory);
  assert.equal(validateJournal(after.journal).head, 2);
  assert.equal(after.rows.audit.length, 2);
  assert.equal(after.rows.events.length, 2);
  return {lastDurable: 1, afterRetry: 2, auditRows: 2, eventRows: 2};
}

async function measure(directory) {
  await mkdir(directory);
  const inputs = [spike, hostNode, surreal, join(runtime, 'Massion')];
  for (const entry of ['node', 'surreal']) {
    const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
    const digest = createHash('sha256').update(await readFile(join(runtime, entry))).digest('hex');
    assert.equal(digest, manifest[entry].sha256);
  }
  const binaryBytes = await Promise.all(inputs.map(async file => (await stat(file)).size));
  const samples = [];
  for (let repetition = 0; repetition < 5; repetition++) {
    for (const [key, start] of repetition % 2 === 0 ? [['node', nodeHost], ['rust', rustHost]] : [['rust', rustHost], ['node', nodeHost]]) {
      const copy = join(directory, `${key}-${repetition}`);
      await fixtureCopy(copy);
      const host = await start(copy);
      try {
        await delay(1000);
        const lines = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {encoding: 'utf8'}).trim().split('\n')
          .map(line => line.trim().split(/\s+/).map(Number));
        const pids = new Set(host.processes.map(({child}) => child.pid));
        for (let count = -1; count !== pids.size;) {
          count = pids.size;
          for (const [pid, parent] of lines) if (pids.has(parent)) pids.add(pid);
        }
        const rows = lines.filter(([pid]) => pids.has(pid));
        assert.equal(rows.length, pids.size);
        samples.push({key, repetition, startupMs: Math.round(host.milliseconds * 100) / 100,
          rssKiB: rows.reduce((sum, row) => sum + row[2], 0), processes: rows.length});
      } finally { assert.equal((await host.close()).code, 0); }
    }
  }
  return {fixture, binaryBytes: {spike: binaryBytes[0], node: binaryBytes[1], surreal: binaryBytes[2], host: binaryBytes[3]}, samples};
}

const cases = {P1: p1, P2: p2, P3: p3, P4: p4, measure};
const requested = process.argv[2] ?? 'all';
assert.ok(requested === 'all' || Object.hasOwn(cases, requested), 'Use P1, P2, P3, P4, measure or all');
await mkdir(scratch, {recursive: true});
assert.equal(await realpath(scratch), scratch, 'Scratch path must stay inside the spike worktree');
const directory = await mkdtemp(join(scratch, 'rust-spike-'));
try {
  for (const name of requested === 'all' ? ['P1', 'P2', 'P3', 'P4'] : [requested]) {
    console.log(JSON.stringify({name, result: await cases[name](join(directory, name))}));
  }
} finally {
  await Promise.allSettled([...running].map(child => stop(child)));
  await rm(directory, {recursive: true, force: true});
}
