/** Explicit local-owner CLI. Does not discover credentials or execute Work. */
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHttpRpcTransport, initializeSurrealSchema, SurrealStore, journalRestoreRpcRequestBytes } from '../src/storage.ts';
import type { Mission } from '../src/domain.ts';
import { TextArtifactStore } from '../src/text-artifacts.ts';
import { BACKUP_LIMITS, exportPortableBackup, restorePortableBackup } from '../src/portable-backup.ts';

const [mode, endpoint, namespace, database, artifactRoot, bundlePath, ...extra] = process.argv.slice(2);
if (!['export','restore','restore-check'].includes(mode ?? '') || !endpoint || !namespace || !database || !artifactRoot || !bundlePath) {
  throw new Error('Usage: node scripts/backup.ts export|restore|restore-check http://127.0.0.1:PORT/rpc NAMESPACE DATABASE /absolute/artifact-root /absolute/bundle.json [--rpc-body-budget BYTES]');
}
// A client budget, not discovery or modification of the destination's capacity.
const DEFAULT_RPC_BODY_BUDGET=4*1024*1024,MAX_RPC_BODY_BUDGET=64*1024*1024;
let rpcBodyBudget=DEFAULT_RPC_BODY_BUDGET;
if(extra.length){
  if(mode==='export'||extra.length!==2||extra[0]!=='--rpc-body-budget'||!/^[1-9][0-9]*$/.test(extra[1]!))throw new Error('Only restore/restore-check accept --rpc-body-budget positive integer bytes');
  rpcBodyBudget=Number(extra[1]);
  if(!Number.isSafeInteger(rpcBodyBudget)||rpcBodyBudget>MAX_RPC_BODY_BUDGET)throw new Error('RPC client body budget must be 1..67108864 bytes; server capacity is not discovered');
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
  const backup=parsePortableBackup(serialized);
  const rpcRequestBytes=journalRestoreRpcRequestBytes(backup.journal),withinBudget=rpcRequestBytes<=rpcBodyBudget;
  const preflight={status:withinBudget?'within-client-budget':'blocked',bundleBytes:Buffer.byteLength(serialized),rpcRequestBytes,clientRpcBodyBudget:rpcBodyBudget,serverCapacity:'not-discovered',referenceDefault:{surrealVersion:'3.3.0',rpcBodyBytes:DEFAULT_RPC_BODY_BUDGET},changes:'none',guidance:'Budget is a local guard, not a server-capacity or success guarantee. Verify the destination limit before a new explicit restore. Never re-import an unknown restore; inspect its identity and retained destination first.'};
  if(mode==='restore-check'){
    process.stdout.write(JSON.stringify(preflight)+'\n');if(!withinBudget)process.exitCode=1;
  }else{
    if(!withinBudget)throw new Error(`Restore preflight blocked before any database request or artifact mutation: RPC request ${rpcRequestBytes} bytes exceeds client budget ${rpcBodyBudget} bytes (bundle ${preflight.bundleBytes} bytes). Actual server capacity is not discovered. Use restore-check; verify the destination capacity before choosing an explicit bounded --rpc-body-budget for a new restore. Do not replay an unknown restore identity.`);
    await initializeSurrealSchema(transport);
    const result = await restorePortableBackup(serialized,store,artifactRoot);
    process.stdout.write(JSON.stringify({status:'restored',checksum:result.checksum,head:result.head,outbox:'restored-held',effectsReplayed:0,rpcRequestBytes,clientRpcBodyBudget:rpcBodyBudget,serverCapacity:'not-discovered'})+'\n');
  }
}
