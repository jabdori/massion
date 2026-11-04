/** Private bounded data backup. No environment, credentials, provider or effect APIs. */
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, hash } from './domain.ts';
import type { Artifact, Mission } from './domain.ts';
import { TextArtifactStore } from './text-artifacts.ts';
import { validateJournal, journalChecksum } from './storage.ts';
import type { PortableJournal, SurrealStore } from './storage.ts';
import { validateMissionLineage, validateMissionJournalLineage, collectMissionArtifacts } from './backup-lineage.ts';

export const BACKUP_FORMAT = 'massion-portable-text/v1';
export const BACKUP_LIMITS = Object.freeze({ bundleBytes: 64 * 1024 * 1024, artifactBytes: 32_768, artifacts: 4096, operations: 10000 });
interface BlobEntry { sha256: string; bytes: number; base64: string }
export interface PortableBackup {
  format: typeof BACKUP_FORMAT;
  journal: PortableJournal<Mission>;
  journalChecksum: string;
  artifacts: Artifact[];
  blobs: BlobEntry[];
  checksum: string;
}
function fail(message: string): never { throw new Error(`Portable backup: ${message}`); }
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail('invalid manifest fields');
}
function safePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.') || resolve(path) !== path) fail('unsafe artifact path');
}
function artifactKey(artifact: Artifact): string { return canonical(artifact); }
function inventory(journal: PortableJournal<Mission>): Artifact[] {
  validateMissionJournalLineage(journal.operations);
  const inventory = new Map<string, Artifact>();
  for (const operation of journal.operations) {
    validateMissionLineage(operation.value);
    if (operation.value.id !== operation.aggregateId) fail('Mission aggregate lineage mismatch');
    for (const artifact of collectMissionArtifacts(operation.value)) {
      safePath(artifact.path);
      const workId = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63}):text$/.exec(artifact.id)?.[1];
      if (!workId || !artifact.path.endsWith(`/${workId}/${artifact.sha256}.txt`)) fail('artifact path/identity mismatch');
      inventory.set(artifactKey(artifact), structuredClone(artifact));
    }
  }
  if (inventory.size > BACKUP_LIMITS.artifacts) fail('artifact count limit');
  return [...inventory.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

/** Checksums are corruption evidence, not a signature or proof of model quality. */
export function parsePortableBackup(serialized: string): PortableBackup {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > BACKUP_LIMITS.bundleBytes) fail('bundle byte limit');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { fail('invalid JSON'); }
  exact(parsed, ['format', 'journal', 'journalChecksum', 'artifacts', 'blobs', 'checksum']);
  if (parsed.format !== BACKUP_FORMAT) fail('unsupported format');
  const { checksum, ...body } = parsed;
  if (typeof checksum !== 'string' || hash(body) !== checksum) fail('manifest checksum mismatch');
  const journal = validateJournal<Mission>(parsed.journal);
  if (journal.operations.length > BACKUP_LIMITS.operations) fail('operation count limit');
  if (journalChecksum(journal) !== parsed.journalChecksum) fail('journal checksum mismatch');
  const artifacts = inventory(journal);
  if (canonical(artifacts) !== canonical(parsed.artifacts)) fail('artifact inventory mismatch');
  if (!Array.isArray(parsed.blobs) || parsed.blobs.length > BACKUP_LIMITS.artifacts) fail('invalid blobs');
  const expected = new Set(artifacts.map(a => a.sha256));
  const seen = new Set<string>();
  for (const blob of parsed.blobs) {
    exact(blob, ['sha256', 'bytes', 'base64']);
    if (typeof blob.sha256 !== 'string' || !expected.has(blob.sha256) || seen.has(blob.sha256) ||
        !Number.isSafeInteger(blob.bytes) || (blob.bytes as number) < 1 || (blob.bytes as number) > BACKUP_LIMITS.artifactBytes ||
        typeof blob.base64 !== 'string' || blob.base64.length > Math.ceil(BACKUP_LIMITS.artifactBytes / 3) * 4) fail('invalid blob descriptor');
    const bytes = Buffer.from(blob.base64, 'base64');
    if (bytes.toString('base64') !== blob.base64 || bytes.length !== blob.bytes || digest(bytes) !== blob.sha256 || !isUtf8(bytes)) fail('blob checksum/encoding mismatch');
    seen.add(blob.sha256);
  }
  if (seen.size !== expected.size) fail('missing blob');
  return structuredClone(parsed) as unknown as PortableBackup;
}

export async function exportPortableBackup(store: Pick<SurrealStore<Mission>, 'exportJournal'>, artifacts: TextArtifactStore): Promise<string> {
  const journal = await store.exportJournal();
  if (journal.operations.length > BACKUP_LIMITS.operations) fail('operation count limit');
  const descriptors = inventory(journal);
  const blobs = new Map<string, BlobEntry>();
  for (const artifact of descriptors) {
    const bytes = Buffer.from(await artifacts.read(artifact));
    if (bytes.length > BACKUP_LIMITS.artifactBytes) fail('artifact byte limit');
    blobs.set(artifact.sha256, { sha256: artifact.sha256, bytes: bytes.length, base64: bytes.toString('base64') });
  }
  const checksum = journalChecksum(journal);
  if (journalChecksum(await store.exportJournal()) !== checksum) fail('source changed during export; quiesce and export again');
  const body = { format: BACKUP_FORMAT, journal, journalChecksum: checksum, artifacts: descriptors, blobs: [...blobs.values()].sort((a,b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) };
  const serialized = canonical({ ...body, checksum: hash(body) });
  parsePortableBackup(serialized);
  return serialized;
}

/** Verify every ancestor before exclusively claiming a new disposable root. */
async function freshRoot(root: string): Promise<void> {
  safePath(root);
  let current: string = sep;
  const parts = root.slice(1).split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) fail('unsafe destination ancestor');
  }
  await mkdir(root, { mode: 0o700 }); // EEXIST is intentional: never adopt or overwrite.
}

/**
 * Reopen restored artifacts with original immutable descriptors. The supplied
 * manifest is revalidated, and TextArtifactStore validates current bytes on read.
 */
export function openRestoredArtifacts(serialized: string, root: string): TextArtifactStore {
  const backup = parsePortableBackup(serialized);
  return new TextArtifactStore(root, BACKUP_LIMITS.artifactBytes, backup.artifacts);
}

export async function restorePortableBackup(serialized: string, store: Pick<SurrealStore<Mission>, 'restoreJournal' | 'exportJournal'>, root: string): Promise<{ checksum: string; head: number; artifacts: TextArtifactStore }> {
  const backup = parsePortableBackup(serialized); // All input validation precedes filesystem/DB mutation.
  const existing = await store.exportJournal();
  if (existing.head !== 0 || existing.operations.length !== 0) fail('destination database must be empty');
  await freshRoot(root);
  const artifactStore = new TextArtifactStore(root, BACKUP_LIMITS.artifactBytes);
  await artifactStore.initialize();
  const blobs = new Map(backup.blobs.map(blob => [blob.sha256, blob]));
  for (const descriptor of backup.artifacts) {
    const workId = descriptor.id.slice(0, -':text'.length);
    const artifact = await artifactStore.write(workId, descriptor.version, Buffer.from(blobs.get(descriptor.sha256)!.base64, 'base64').toString('utf8'));
    if (artifact.sha256 !== descriptor.sha256) fail('restored artifact checksum mismatch');
  }
  // Never clean up on an ambiguous DB outcome: that could destroy committed evidence.
  await store.restoreJournal(backup.journal);
  const restored = openRestoredArtifacts(serialized, root);
  try { for (const descriptor of backup.artifacts) await restored.read(descriptor); }
  catch (cause) {
    throw new Error(`Portable backup: journal restored at head ${backup.journal.head} (bundle ${backup.checksum}), but artifact verification failed. Do not re-import; inspect the retained destination.`, { cause });
  }
  return { checksum: backup.checksum, head: backup.journal.head, artifacts: restored };
}
