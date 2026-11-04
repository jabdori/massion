/** Explicit local-owner CLI. Does not discover credentials or execute Work. */
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHttpRpcTransport, initializeSurrealSchema, SurrealStore } from '../src/storage.ts';
import type { Mission } from '../src/domain.ts';
import { TextArtifactStore } from '../src/text-artifacts.ts';
import { BACKUP_LIMITS, exportPortableBackup, restorePortableBackup } from '../src/portable-backup.ts';

const [mode, endpoint, namespace, database, artifactRoot, bundlePath, ...extra] = process.argv.slice(2);
if (!['export','restore'].includes(mode ?? '') || !endpoint || !namespace || !database || !artifactRoot || !bundlePath || extra.length) {
  throw new Error('Usage: node scripts/backup.ts export|restore http://127.0.0.1:PORT/rpc NAMESPACE DATABASE /absolute/artifact-root /absolute/bundle.json');
}
const url = new URL(endpoint);
if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Backup CLI supports only an explicit loopback development database');
if (resolve(artifactRoot) !== artifactRoot || resolve(bundlePath) !== bundlePath) throw new Error('Absolute canonical paths are required');
const parent = dirname(bundlePath);
if (await realpath(parent) !== parent || !(await lstat(parent)).isDirectory()) throw new Error('Bundle parent must not contain symbolic links');
const transport = createHttpRpcTransport({endpoint,namespace,database});
const store = new SurrealStore<Mission>(transport);
if (mode === 'export') {
  const serialized = await exportPortableBackup(store,new TextArtifactStore(artifactRoot));
  const file = await open(bundlePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  process.stdout.write('Private portable bundle exported. Original evidence and all referenced text bytes verified.\n');
} else {
  const file = await open(bundlePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let serialized: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > BACKUP_LIMITS.bundleBytes) throw new Error('Bundle must be a bounded regular singly-linked file');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes,offset,bytes.length-offset,offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset !== stat.size) throw new Error('Bundle changed during read');
    if (!isUtf8(bytes.subarray(0,offset))) throw new Error('Bundle must contain valid UTF-8');
    serialized = bytes.subarray(0,offset).toString('utf8');
  } finally { await file.close(); }
  // Parsing is also performed by restore, before artifacts or journal mutation.
  const { parsePortableBackup } = await import('../src/portable-backup.ts');
  parsePortableBackup(serialized);
  await initializeSurrealSchema(transport);
  const result = await restorePortableBackup(serialized,store,artifactRoot);
  process.stdout.write(JSON.stringify({status:'restored',checksum:result.checksum,head:result.head,outbox:'restored-held',effectsReplayed:0})+'\n');
}
