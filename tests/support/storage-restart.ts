import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {access,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../../src/storage.ts';
import {verifyDisposableDatabase} from './owned-process.ts';
/** Destructive storage checks own a nested wrapper, port, PID and SurrealKV directory. */
export async function runIsolatedStorageRestart(){
 await verifyDisposableDatabase();
 const outerRoot=process.env.SURREAL_TEST_RUNTIME!,outerPid=Number(process.env.SURREAL_TEST_PID),outerMetadata=await readFile(join(outerRoot,'server.json'),'utf8');
 const transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database:'massion_storage_tests'});await initializeSurrealSchema(transport);const store=new SurrealStore<{title:string}>(transport),id='lifetime-'+randomUUID(),input={id,commandId:id,fingerprint:id,expectedRevision:0,value:{title:'Shared DB original survives isolated crash'},events:[{type:'lifetime.created'}],outbox:[]};assert.equal((await store.commit(input)).status,'committed');const original=await store.load(id);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(r=>probe.close(()=>r()));
 const wrapper=fileURLToPath(new URL('../../scripts/with-surreal.py',import.meta.url)),child=fileURLToPath(new URL('./storage-restart-child.ts',import.meta.url));
 const {stdout}=await promisify(execFile)('python3',[wrapper,'--port',String(port),'--timeout','60','--',process.execPath,child],{env:{...process.env,MASSION_SURREAL_BINARY:process.env.MASSION_TEST_SURREAL_BINARY!},maxBuffer:1024*1024});
 const first=stdout.split('\n').find(line=>line.startsWith('Disposable SurrealDB ready: '));assert.ok(first,'Nested wrapper ownership evidence required');const nested=JSON.parse(first.slice('Disposable SurrealDB ready: '.length));assert.notEqual(nested.pid_in_this_exec_namespace,outerPid);assert.notEqual(nested.runtime,outerRoot);assert.notEqual(nested.url+'/rpc',process.env.MASSION_TEST_SURREAL_RPC);assert.match(stdout,/Owned isolated crash\/restart\/export\/import assertions passed/);
 await assert.rejects(access(nested.runtime),{code:'ENOENT'});await verifyDisposableDatabase();assert.equal(await readFile(join(outerRoot,'server.json'),'utf8'),outerMetadata);assert.deepEqual(await store.load(id),original);assert.equal((await store.lookupOperation(input)).status,'replayed');
 return {sharedPid:outerPid,isolatedPid:nested.pid_in_this_exec_namespace,distinctPort:true,distinctRoot:true,isolatedRootReleased:true,sharedIdentityAndSnapshotUnchanged:true};
}
