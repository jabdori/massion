import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../../src/storage.ts';
import type {CommitInput} from '../../src/storage.ts';
import {verifyDisposableDatabase} from './owned-process.ts';
const command=(overrides:Partial<CommitInput<{title:string}>>={}):CommitInput<{title:string}>=>({id:'work-1',commandId:'command-1',fingerprint:'canonical-command-1',expectedRevision:0,value:{title:'Accepted snapshot'},events:[{type:'work.created'}],outbox:[{effectId:'effect-1'}],...overrides});
const now=()=>new Date('2026-10-03T00:00:00.000Z');
const endpoint=process.env.MASSION_TEST_SURREAL_RPC;
// This child runs only under its own nested launcher; it never stops the suite DB.
await verifyDisposableDatabase();
  // Same crash/journal/export/import assertions in a separately owned DB lifetime.
  const { spawn } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const { setTimeout: delay } = await import('node:timers/promises');
  const binary = process.env.MASSION_TEST_SURREAL_BINARY;
  const data = process.env.MASSION_TEST_SURREAL_DATA;
  const originalPid = Number(process.env.MASSION_TEST_SURREAL_PID);
  assert.ok(binary && data && Number.isSafeInteger(originalPid) && originalPid > 1);
  assert.equal(originalPid,Number(process.env.SURREAL_TEST_PID));
  assert.equal(data,join(process.env.SURREAL_TEST_RUNTIME!,'data'));
  assert.equal(binary,process.env.SURREAL_TEST_BINARY);
  const url = new URL(endpoint!);
  assert.equal(url.hostname, '127.0.0.1');
  const transport = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: 'massion_storage_tests' });
  await initializeSurrealSchema(transport);
  const store = new SurrealStore(transport, now);
  const input = command({ id: `restart-${randomUUID()}`, commandId: `restart-${randomUUID()}` });
  await store.commit(input);
  const journalQuery = `RETURN {
    feed: (SELECT * FROM massion_feed ORDER BY id),
    states: (SELECT * FROM massion_state ORDER BY id),
    operations: (SELECT * FROM massion_operation ORDER BY id),
    audits: (SELECT * FROM massion_audit ORDER BY id),
    events: (SELECT * FROM massion_event ORDER BY id),
    outbox: (SELECT * FROM massion_outbox ORDER BY id)
  };`;
  const before = await transport.query(journalQuery, {});
  const feedBefore = await store.readEvents(0, 1000);
  await verifyDisposableDatabase();
  process.kill(originalPid, 'SIGKILL');
  const stopDeadline = Date.now() + 10_000;
  while (true) {
    let state = '';
    try { state = (await readFile(`/proc/${originalPid}/stat`, 'utf8')).split(') ')[1]?.split(' ')[0] ?? ''; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    if (state === 'Z' || state === 'X') break;
    assert.ok(Date.now() < stopDeadline, 'original process did not exit');
    await delay(20);
  }
  const server = spawn(binary!, ['start', `surrealkv://${data}`, '--bind', `${url.hostname}:${url.port}`, '--unauthenticated',
    '--no-banner', '--log', 'error', '--default-namespace', 'massion_storage_tests', '--default-database', 'massion_storage_tests',
    '--deny-net', '--deny-scripting'], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  let log = '';
  server.stderr?.on('data', (chunk) => { log += String(chunk); });
  try {
    const startDeadline = Date.now() + 10_000;
    while (true) {
      assert.equal(server.exitCode, null, `replacement server exited: ${log}`);
      try { if ((await fetch(new URL('/ready', url), { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* startup */ }
      assert.ok(Date.now() < startDeadline, `replacement server not ready: ${log}`);
      await delay(20);
    }
    const restarted = new SurrealStore(transport, now);
    assert.deepEqual(await restarted.load(input.id), { revision: 1, value: input.value });
    assert.deepEqual(await restarted.lookupOperation(input), { status: 'replayed', revision: 1, value: input.value });
    assert.deepEqual(await transport.query(journalQuery, {}), before);
    assert.deepEqual(await restarted.readEvents(0, 1000), feedBefore);

    const headers = { 'Surreal-NS': 'massion_storage_tests', 'Surreal-DB': 'massion_storage_tests', 'Content-Type': 'application/json' };
    const exported = await fetch(new URL('/export', url), {
      method: 'POST', headers, body: JSON.stringify({ users: false, accesses: false, params: false, functions: false, analyzers: false, tables: true, records: true }),
    });
    assert.equal(exported.status, 200);
    const backup = await exported.text();
    assert.match(backup, /OPTION IMPORT/);
    const restoredDatabase = `restore_${randomUUID().replaceAll('-', '')}`;
    // Only the generated identifier is interpolated in this disposable test setup.
    await transport.query(`DEFINE DATABASE ${restoredDatabase};`, {});
    const imported = await fetch(new URL('/import', url), {
      method: 'POST', headers: { 'Surreal-NS': 'massion_storage_tests', 'Surreal-DB': restoredDatabase, Accept: 'application/json' }, body: backup,
    });
    assert.equal(imported.status, 200, await imported.text());
    const restoredTransport = createHttpRpcTransport({ endpoint: endpoint!, namespace: 'massion_storage_tests', database: restoredDatabase });
    const restored = new SurrealStore(restoredTransport, now);
    assert.deepEqual(await restored.load(input.id), { revision: 1, value: input.value });
    assert.deepEqual(await restored.lookupOperation(input), { status: 'replayed', revision: 1, value: input.value });
    assert.deepEqual(await restoredTransport.query(journalQuery, {}), before);
    assert.deepEqual(await restored.readEvents(0, 1000), feedBefore);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => { server.once('exit', () => resolve()); });
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(force);
    }
  }
console.log('Owned isolated crash/restart/export/import assertions passed');
