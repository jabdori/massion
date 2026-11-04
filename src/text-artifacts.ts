/**
 * Bounded, inert UTF-8 artifacts for configured providers. Nothing in this
 * module evaluates text or invokes a model/process. Content-addressed files
 * are immutable through this API, not an OS sandbox or a guarantee against
 * an owner/privileged process changing the filesystem. Every use revalidates
 * the current directory identities, ownership markers, and exact bytes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Artifact } from './domain.ts';

const ROOT_MARKER = '.massion-text-store.json';
const WORK_MARKER = '.massion-text-work.json';
const SCHEMA = 'massion-text-artifacts/v1';
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MARKER_LIMIT = 2_048;
type Identity = { device: string; inode: string; birthtime: string };
type Marker = {
  schema: typeof SCHEMA;
  kind: 'root' | 'work';
  directory: Identity;
  storeId: string;
  workId?: string;
};

function fail(message: string): never { throw new Error(`Text artifact boundary: ${message}`); }
function errno(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function identity(stat: BigIntStats): Identity {
  return { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeNs) };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtime === right.birthtime;
}
function absolute(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('absolute path required');
  if (path.split(/[\\/]/).includes('..')) fail('path traversal is forbidden');
  return resolve(path);
}
function within(root: string, path: string): void {
  const part = relative(root, path);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) fail('path escapes store');
}
function validVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) fail('version must be a positive safe integer');
}

/** Check every ancestor, not just the final component. Never follow links. */
async function directory(path: string, create: boolean): Promise<Identity> {
  let current = resolve(sep);
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) {
      if (!create || !errno(error, 'ENOENT')) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (!errno(error, 'EEXIST')) throw error; }
      stat = await lstat(current, { bigint: true });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('directory must be real and not a symlink');
  }
  if (await realpath(path) !== path) fail('directory realpath mismatch');
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('directory must be real and not a symlink');
  return identity(stat);
}

function regular(stat: BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) fail('file must be regular, singly linked, and not a symlink');
}
function immutable(stat: BigIntStats): boolean { return (stat.mode & 0o7777n) === 0o400n; }

/**
 * A concurrent exclusive writer seals its file to 0400 only after syncing all
 * bytes. Waiting is only for that bounded publication window. A crash or an
 * existing writable file fails closed; it is never repaired or overwritten.
 */
async function readyFile(path: string, wait: boolean): Promise<BigIntStats> {
  for (let attempt = 0; ; attempt++) {
    const stat = await lstat(path, { bigint: true });
    regular(stat);
    if (immutable(stat)) return stat;
    if (!wait || attempt === 100 || (stat.mode & 0o7777n) !== 0o600n) fail('file must be read-only (0400)');
    await setTimeout(10);
  }
}

async function boundedRead(path: string, limit: number, wait = false): Promise<Buffer> {
  const before = await readyFile(path, wait);
  if (before.size < 1n || before.size > BigInt(limit)) fail('file is empty or exceeds byte limit');
  if (await realpath(path) !== path) fail('file realpath mismatch');
  // NONBLOCK avoids a replaced FIFO stalling the process before fstat rejects it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    regular(opened);
    if (!immutable(opened) || !sameIdentity(identity(before), identity(opened))) fail('file replaced or writable');
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.alloc(Math.min(65_536, limit - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size < 1 || size > limit) fail('file is empty or exceeds byte limit');
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    regular(after); regular(current);
    if (!immutable(after) || !immutable(current) || !sameIdentity(identity(opened), identity(current)) ||
        opened.size !== after.size || after.size !== BigInt(size) || current.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs ||
        current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs || await realpath(path) !== path) {
      fail('file changed while reading');
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

async function exclusiveWrite(path: string, bytes: Buffer): Promise<void> {
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (errno(error, 'EEXIST')) return; throw error; }
  try {
    // Descriptor operations cannot truncate or chmod an existing pathname.
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
}

// Sharing the queue across store instances also serializes first initialization.
// Filesystem exclusive creation protects against other processes; this is not
// a durable lock or a defense against hostile concurrent directory mutation.
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(path, next);
  try { return await next; }
  finally { if (queues.get(path) === next) queues.delete(path); }
}

/** Dedicated marked root, separate from the controlled fixture workspace. */
export class TextArtifactStore {
  readonly root: string;
  readonly maxBytes: number;
  private rootMarker?: Marker;
  private readonly relocated = new Map<string, Artifact>();
  private readonly workMarkers = new Map<string, Marker>();

  constructor(root: string, maxBytes = 32_768, originalArtifacts: readonly Artifact[] = []) {
    this.root = absolute(root);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= Number.MAX_SAFE_INTEGER) fail('maxBytes must be a positive safe byte bound');
    this.maxBytes = maxBytes;
    for (const artifact of originalArtifacts) {
      const pinned = { ...artifact };
      if (pinned.kind !== 'text' || !/^([A-Za-z0-9][A-Za-z0-9_-]{0,63}):text$/.test(pinned.id) ||
          !SHA256.test(pinned.sha256) || absolute(pinned.path) !== pinned.path) fail('invalid relocation descriptor');
      validVersion(pinned.version);
      const key = JSON.stringify([pinned.id, pinned.version, pinned.sha256, pinned.path, pinned.kind]);
      this.relocated.set(key, pinned);
    }
  }

  private async marker(path: string, kind: Marker['kind'], create: boolean, workId?: string): Promise<Marker> {
    const pinned = kind === 'root' ? this.rootMarker : this.workMarkers.get(workId!);
    const current = await directory(path, create && !pinned);
    if (pinned && !sameIdentity(pinned.directory, current)) fail('owned directory was replaced');
    const markerPath = join(path, kind === 'root' ? ROOT_MARKER : WORK_MARKER);
    let exists = true;
    try { await lstat(markerPath); }
    catch (error) { if (!errno(error, 'ENOENT')) throw error; exists = false; }
    if (!exists) {
      if (!create || pinned) fail('ownership marker is missing');
      if ((await readdir(path)).length !== 0) {
        // Another process may have finished initialization (and even started
        // a work) after our lstat. Validate that marker rather than adopting
        // a populated unmarked directory or writing any new marker over it.
        try { await lstat(markerPath); }
        catch (error) { if (errno(error, 'ENOENT')) fail('nonempty unmarked directory'); throw error; }
        return this.marker(path, kind, create, workId);
      }
      const marker: Marker = {
        schema: SCHEMA, kind, directory: current,
        storeId: kind === 'root' ? randomUUID() : this.rootMarker!.storeId,
        ...(kind === 'work' ? { workId } : {}),
      };
      if (!sameIdentity(current, await directory(path, false))) fail('owned directory was replaced');
      await exclusiveWrite(markerPath, Buffer.from(JSON.stringify(marker)));
    }
    const bytes = await boundedRead(markerPath, MARKER_LIMIT, create);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { fail('invalid ownership marker'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid ownership marker');
    const marker = parsed as Marker;
    const expectedKeys = kind === 'root' ? ['directory', 'kind', 'schema', 'storeId'] : ['directory', 'kind', 'schema', 'storeId', 'workId'];
    if (Object.keys(marker).sort().join(',') !== expectedKeys.join(',') || marker.schema !== SCHEMA || marker.kind !== kind ||
        !marker.directory || typeof marker.directory !== 'object' || !sameIdentity(marker.directory, current) ||
        typeof marker.storeId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(marker.storeId) ||
        (kind === 'work' && (marker.workId !== workId || marker.storeId !== this.rootMarker!.storeId)) ||
        (pinned && (pinned.storeId !== marker.storeId || !sameIdentity(pinned.directory, marker.directory)))) {
      fail('ownership marker identity mismatch');
    }
    if (!sameIdentity(current, await directory(path, false))) fail('owned directory was replaced');
    if (kind === 'root') this.rootMarker = marker;
    else this.workMarkers.set(workId!, marker);
    return marker;
  }

  private async workspace(workId: string, create: boolean): Promise<string> {
    await this.marker(this.root, 'root', create);
    const path = join(this.root, workId);
    within(this.root, path);
    await this.marker(path, 'work', create, workId);
    // Detect root replacement during work-directory validation, too.
    await this.marker(this.root, 'root', false);
    return path;
  }

  private descriptor(artifact: Artifact): { workId: string; path: string } {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.id !== 'string' || artifact.kind !== 'text') fail('invalid text artifact');
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63}):text$/.exec(artifact.id);
    if (!match || !SHA256.test(artifact.sha256)) fail('invalid artifact identity or hash');
    validVersion(artifact.version);
    const workId = match[1]!;
    const path = join(this.root, workId, `${artifact.sha256}.txt`);
    const key = JSON.stringify([artifact.id, artifact.version, artifact.sha256, artifact.path, artifact.kind]);
    if (absolute(artifact.path) !== artifact.path || (artifact.path !== path && !this.relocated.has(key))) fail('artifact path does not match its work and hash');
    within(this.root, path);
    return { workId, path };
  }

  private async verifiedBytes(artifact: Artifact, wait = false): Promise<Buffer> {
    const { workId, path } = this.descriptor(artifact);
    await this.workspace(workId, false);
    const bytes = await boundedRead(path, this.maxBytes, wait);
    if (!isUtf8(bytes)) fail('artifact must contain valid UTF-8 text');
    if (digest(bytes) !== artifact.sha256) fail('artifact hash/content mismatch');
    await this.workspace(workId, false);
    return bytes;
  }

  /** Validate an existing root without initialization or filesystem writes. */
  async verifyReadRoot(): Promise<void> {
    await serialized(this.root, async () => { await this.marker(this.root, 'root', false); });
  }

  /** Explicitly initialize an empty owned root without creating a Work artifact. */
  async initialize(): Promise<void> {
    await serialized(this.root, async () => { await this.marker(this.root, 'root', true); });
  }

  async write(workId: string, version: number, content: string): Promise<Artifact> {
    if (typeof workId !== 'string' || !WORK_ID.test(workId)) fail('invalid work ID');
    validVersion(version);
    if (typeof content !== 'string' || !content.isWellFormed() || content.length === 0) fail('content must be nonempty UTF-8 text');
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) fail('content exceeds byte limit');
    const bytes = Buffer.from(content, 'utf8');
    return serialized(this.root, async () => {
      const path = await this.workspace(workId, true);
      const sha256 = digest(bytes);
      const artifact: Artifact = { id: `${workId}:text`, version, sha256, path: join(path, `${sha256}.txt`), kind: 'text' };
      await exclusiveWrite(artifact.path, bytes);
      const stored = await this.verifiedBytes(artifact, true);
      if (!stored.equals(bytes)) fail('artifact hash/content mismatch');
      return artifact;
    });
  }

  async read(artifact: Artifact): Promise<string> {
    // Copy the descriptor before awaiting: caller mutation cannot change the
    // expected work/hash/path halfway through validation.
    const pinned = { ...artifact };
    return serialized(this.root, async () => (await this.verifiedBytes(pinned)).toString('utf8'));
  }

  async snapshot(artifact: Artifact): Promise<{ sha256: string; path: string }> {
    const pinned = { ...artifact };
    return serialized(this.root, async () => {
      await this.verifiedBytes(pinned);
      // The artifact already is the immutable, content-addressed snapshot.
      return { sha256: pinned.sha256, path: pinned.path };
    });
  }
}
