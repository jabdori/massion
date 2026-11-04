import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { TextArtifactStore } from '../src/text-artifacts.ts';
import type { Artifact } from '../src/domain.ts';

const ROOT_MARKER = '.massion-text-store.json';
const WORK_MARKER = '.massion-text-work.json';
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext, maxBytes?: number): Promise<{ root: string; home: string; store: TextArtifactStore }> {
  const home = await mkdtemp(join(tmpdir(), 'massion-text-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'artifacts');
  return { home, root, store: new TextArtifactStore(root, maxBytes) };
}

async function replaceBytes(path: string, bytes: string | Buffer): Promise<void> {
  await chmod(path, 0o600);
  await writeFile(path, bytes);
  await chmod(path, 0o400);
}

test('stores exact inert UTF-8 bytes in marked work directories and read-only content-addressed snapshots', async t => {
  const { store, root, home } = await fixture(t);
  const text = '\uFEFFReview: café, 日本語, 🌱.\n' + `import { writeFileSync } from 'node:fs'; writeFileSync('${join(home, 'must-not-exist')}', 'executed');`;
  const artifact = await store.write('work-A_1', 3, text);
  assert.deepEqual(artifact, {
    id: 'work-A_1:text', version: 3, sha256: sha256(text),
    path: join(root, 'work-A_1', `${sha256(text)}.txt`), kind: 'text',
  });
  assert.equal(await store.read(artifact), text);
  assert.deepEqual(await readFile(artifact.path), Buffer.from(text));
  assert.equal((await stat(artifact.path)).mode & 0o7777, 0o400);
  assert.equal((await stat(artifact.path)).nlink, 1);
  assert.deepEqual(await store.snapshot(artifact), { sha256: artifact.sha256, path: artifact.path });
  const rootMarker = JSON.parse(await readFile(join(root, ROOT_MARKER), 'utf8'));
  const workMarker = JSON.parse(await readFile(join(root, 'work-A_1', WORK_MARKER), 'utf8'));
  assert.equal(rootMarker.schema, 'massion-text-artifacts/v1');
  assert.equal(workMarker.workId, 'work-A_1');
  assert.equal(workMarker.storeId, rootMarker.storeId);
  assert.equal(rootMarker.directory.inode, String((await stat(root)).ino));
  await assert.rejects(readFile(join(home, 'must-not-exist')), { code: 'ENOENT' });
});

test('same bytes reuse the file across versions while changed bytes preserve old snapshots', async t => {
  const { store, root } = await fixture(t);
  const first = await store.write('work', 1, 'First result');
  const original = await store.snapshot(first);
  const same = await store.write('work', 2, 'First result');
  const different = await store.write('work', 3, 'Second result');
  assert.equal(same.path, first.path);
  assert.equal(same.version, 2);
  assert.notEqual(different.path, first.path);
  assert.equal(await store.read(first), 'First result');
  assert.deepEqual(await store.snapshot(first), original);
  const reopened = new TextArtifactStore(root);
  assert.equal(await reopened.read(different), 'Second result');
  assert.deepEqual(await reopened.write('work', 3, 'Second result'), different);
});

test('concurrent same-byte writes across instances succeed without partial or overwritten bytes', async t => {
  const { store, root } = await fixture(t);
  const text = 'é'.repeat(16_384);
  const artifacts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    (i % 2 ? store : new TextArtifactStore(root)).write('work', i + 1, text)));
  assert.equal(new Set(artifacts.map(artifact => artifact.path)).size, 1);
  assert.deepEqual(await readdir(join(root, 'work')), [WORK_MARKER, `${sha256(text)}.txt`]);
  for (const artifact of artifacts) assert.equal(await store.read(artifact), text);
});

test('concurrent independent processes safely initialize and publish the same bytes', async t => {
  const { store, root } = await fixture(t);
  const moduleUrl = new URL('../src/text-artifacts.ts', import.meta.url).href;
  const run = promisify(execFile);
  const source = `import { TextArtifactStore } from ${JSON.stringify(moduleUrl)};
    const artifact = await new TextArtifactStore(process.argv[1]).write('work', 1, 'same result'.repeat(2800));
    console.log(JSON.stringify(artifact));`;
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    run(process.execPath, ['--input-type=module', '-e', source, root], { env: {}, maxBuffer: 4096, timeout: 10_000 })));
  const artifacts = results.map(result => JSON.parse(result.stdout) as Artifact);
  assert.equal(new Set(artifacts.map(artifact => artifact.path)).size, 1);
  assert.equal(await store.read(artifacts[0]!), 'same result'.repeat(2800));
});

test('validates UTF-8 byte bounds before creating any directories or files', async t => {
  const { store, root } = await fixture(t, 4);
  await assert.rejects(store.write('work', 1, ''), /nonempty UTF-8/);
  await assert.rejects(store.write('work', 1, '\ud800'), /nonempty UTF-8/);
  await assert.rejects(store.write('work', 1, 'ééa'), /byte limit/);
  await assert.rejects(store.write('work', 1, '🌱a'), /byte limit/);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  const exact = await store.write('work', 1, '🌱');
  assert.equal(await store.read(exact), '🌱');
  for (const bad of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new TextArtifactStore(root, bad), /byte bound/);
  }
});

test('rejects unsafe work IDs, versions, roots, and forged descriptor paths', async t => {
  const { store, root, home } = await fixture(t);
  for (const id of ['', '.', '..', '../escape', 'work/path', 'work\\path', 'work:text', '_work', 'a'.repeat(65)]) {
    await assert.rejects(store.write(id, 1, 'text'), /work ID/);
  }
  for (const version of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.write('work', version, 'text'), /version/);
  }
  assert.throws(() => new TextArtifactStore('relative'), /absolute path/);
  assert.throws(() => new TextArtifactStore(`${home}/../escape`), /traversal/);
  const artifact = await store.write('work', 1, 'text');
  const forgeries: Artifact[] = [
    { ...artifact, path: join(home, `${artifact.sha256}.txt`) },
    { ...artifact, path: `${root}/work/../work/${artifact.sha256}.txt` },
    { ...artifact, path: `${root}/work/./${artifact.sha256}.txt` },
    { ...artifact, path: join(root, 'work', 'arbitrary.txt') },
    { ...artifact, id: 'other:text' },
    { ...artifact, id: '../escape:text' },
    { ...artifact, sha256: 'bad' },
    { ...artifact, kind: 'code' },
    { ...artifact, version: 0 },
  ];
  for (const forged of forgeries) {
    await assert.rejects(store.read(forged), /Text artifact boundary/);
    await assert.rejects(store.snapshot(forged), /Text artifact boundary/);
  }
});

test('read and snapshot never initialize a missing store', async t => {
  const { store, root } = await fixture(t);
  const artifact = { id: 'work:text', version: 1, sha256: sha256('text'), path: join(root, 'work', `${sha256('text')}.txt`), kind: 'text' };
  await assert.rejects(store.read(artifact), { code: 'ENOENT' });
  await assert.rejects(store.snapshot(artifact), { code: 'ENOENT' });
  await assert.rejects(readdir(root), { code: 'ENOENT' });
});

test('never adopts populated unmarked roots or work directories or touches their contents', async t => {
  const { store, root } = await fixture(t);
  await mkdir(root);
  await writeFile(join(root, 'user.txt'), 'User-owned root bytes');
  await assert.rejects(store.write('work', 1, 'result'), /nonempty unmarked/);
  assert.deepEqual(await readdir(root), ['user.txt']);
  assert.equal(await readFile(join(root, 'user.txt'), 'utf8'), 'User-owned root bytes');
  const secondRoot = join(root, 'fresh');
  const second = new TextArtifactStore(secondRoot);
  await second.write('first', 1, 'result');
  await mkdir(join(secondRoot, 'work'));
  await writeFile(join(secondRoot, 'work', 'user.txt'), 'User-owned work bytes');
  await assert.rejects(second.write('work', 1, 'result'), /nonempty unmarked/);
  assert.deepEqual(await readdir(join(secondRoot, 'work')), ['user.txt']);
  assert.equal(await readFile(join(secondRoot, 'work', 'user.txt'), 'utf8'), 'User-owned work bytes');
});

test('rejects symlink roots, ancestors and work directories without following their targets', async t => {
  const { home, root, store } = await fixture(t);
  const outside = join(home, 'outside');
  await mkdir(outside);
  await symlink(outside, root);
  await assert.rejects(store.write('work', 1, 'result'), /symlink/);
  await assert.rejects(new TextArtifactStore(join(root, 'nested')).write('work', 1, 'result'), /symlink/);
  assert.deepEqual(await readdir(outside), []);
  await rm(root);
  await store.write('first', 1, 'result');
  await symlink(outside, join(root, 'linked'));
  await assert.rejects(store.write('linked', 1, 'result'), /symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('rejects artifact symlinks and hard links without overwriting an external target', async t => {
  const { store, home } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  const outside = join(home, 'outside.txt');
  await writeFile(outside, 'User-owned external bytes');
  await rm(artifact.path);
  await symlink(outside, artifact.path);
  await assert.rejects(store.write('work', 2, 'result'), /symlink/);
  await assert.rejects(store.read(artifact), /symlink/);
  await assert.rejects(store.snapshot(artifact), /symlink/);
  assert.equal(await readFile(outside, 'utf8'), 'User-owned external bytes');
  await rm(artifact.path);
  await link(outside, artifact.path);
  await assert.rejects(store.write('work', 2, 'result'), /singly linked/);
  await assert.rejects(store.read(artifact), /singly linked/);
  assert.equal(await readFile(outside, 'utf8'), 'User-owned external bytes');
});

test('markers must also be regular singly linked read-only files', async t => {
  const { store, root, home } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  const marker = join(root, 'work', WORK_MARKER);
  const backup = join(home, 'marker-copy');
  await copyFile(marker, backup);
  await rm(marker);
  await symlink(backup, marker);
  await assert.rejects(store.read(artifact), /symlink/);
  await rm(marker);
  await link(backup, marker);
  await assert.rejects(store.snapshot(artifact), /singly linked/);
  await rm(marker);
  await copyFile(backup, marker);
  await chmod(marker, 0o644);
  await assert.rejects(store.read(artifact), /read-only/);
});

test('same-content files with writable or executable modes are rejected instead of repaired', async t => {
  const { store } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  for (const mode of [0o644, 0o500, 0o440]) {
    await chmod(artifact.path, mode);
    await assert.rejects(store.read(artifact), /read-only/);
    await assert.rejects(store.snapshot(artifact), /read-only/);
    await assert.rejects(store.write('work', 2, 'result'), /read-only/);
    assert.equal((await stat(artifact.path)).mode & 0o7777, mode);
  }
});

test('rechecks exact current hashes at read and acceptance, rejecting tampered or oversized bytes', async t => {
  const { store } = await fixture(t, 10);
  const artifact = await store.write('work', 1, 'original');
  await store.snapshot(artifact);
  await replaceBytes(artifact.path, 'tampered');
  await assert.rejects(store.read(artifact), /hash\/content mismatch/);
  await assert.rejects(store.snapshot(artifact), /hash\/content mismatch/);
  await assert.rejects(store.write('work', 2, 'original'), /hash\/content mismatch/);
  assert.equal(await readFile(artifact.path, 'utf8'), 'tampered');
  await replaceBytes(artifact.path, 'x'.repeat(11));
  await assert.rejects(store.read(artifact), /byte limit/);
  await assert.rejects(store.snapshot(artifact), /byte limit/);
  await replaceBytes(artifact.path, '');
  await assert.rejects(store.read(artifact), /empty/);
});

test('hash-correct invalid UTF-8 is rejected, including when supplied as a forged descriptor', async t => {
  const { store } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  const invalid = Buffer.from([0xc0, 0xaf]);
  const hash = sha256(invalid);
  const path = join(dirname(artifact.path), `${hash}.txt`);
  await writeFile(path, invalid, { mode: 0o400 });
  await assert.rejects(store.read({ ...artifact, sha256: hash, path }), /valid UTF-8/);
});

test('work markers bind work identity and root ownership, even if directory contents are copied', async t => {
  const { store, root } = await fixture(t);
  const first = await store.write('first', 1, 'result');
  await mkdir(join(root, 'second'));
  await copyFile(join(root, 'first', WORK_MARKER), join(root, 'second', WORK_MARKER));
  await assert.rejects(store.write('second', 1, 'result'), /identity mismatch/);
  assert.deepEqual(await readdir(join(root, 'second')), [WORK_MARKER]);
  const secondRoot = join(dirname(root), 'another-store');
  const secondStore = new TextArtifactStore(secondRoot);
  await secondStore.write('first', 1, 'result');
  await replaceBytes(join(secondRoot, 'first', WORK_MARKER), await readFile(join(root, 'first', WORK_MARKER)));
  await assert.rejects(secondStore.read({ ...first, path: join(secondRoot, 'first', basename(first.path)) }), /identity mismatch/);
});

test('replaced root and work directories are rejected, including by a newly opened store', async t => {
  const { store, root, home } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  const movedWork = join(home, 'moved-work');
  await rename(join(root, 'work'), movedWork);
  await mkdir(join(root, 'work'));
  await copyFile(join(movedWork, WORK_MARKER), join(root, 'work', WORK_MARKER));
  await copyFile(artifact.path.replace(join(root, 'work'), movedWork), artifact.path);
  await assert.rejects(store.read(artifact), /replaced/);
  await assert.rejects(store.write('work', 2, 'new result'), /replaced/);
  await assert.rejects(new TextArtifactStore(root).read(artifact), /identity mismatch/);
  assert.equal(await readFile(artifact.path, 'utf8'), 'result');

  const movedRoot = join(home, 'moved-root');
  await rename(root, movedRoot);
  await mkdir(root);
  await copyFile(join(movedRoot, ROOT_MARKER), join(root, ROOT_MARKER));
  await assert.rejects(store.write('new-work', 1, 'result'), /replaced/);
  await assert.rejects(new TextArtifactStore(root).write('new-work', 1, 'result'), /identity mismatch/);
  assert.deepEqual(await readdir(root), [ROOT_MARKER]);
});

test('a previously owned directory with a removed marker is never silently reinitialized', async t => {
  const { store, root } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  await rm(join(root, 'work', WORK_MARKER));
  await assert.rejects(store.read(artifact), /marker is missing/);
  await assert.rejects(store.write('work', 2, 'other result'), /marker is missing/);
  await rm(join(root, ROOT_MARKER));
  await assert.rejects(store.write('new-work', 1, 'result'), /marker is missing/);
});

test('mutating a caller-owned descriptor cannot change a queued read or snapshot', async t => {
  const { store } = await fixture(t);
  const artifact = await store.write('work', 1, 'result');
  const expected = { sha256: artifact.sha256, path: artifact.path };
  const read = store.read(artifact);
  const snapshot = store.snapshot(artifact);
  artifact.sha256 = '0'.repeat(64);
  artifact.path = '/outside.txt';
  assert.equal(await read, 'result');
  assert.deepEqual(await snapshot, expected);
});
