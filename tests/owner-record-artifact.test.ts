import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {stopOwnedChild} from './support/owned-process.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {SurrealStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {hash} from '../src/domain.ts';
import {readRecordArtifact} from '../src/record-artifact.ts';
import {runCalculationScenario} from '../src/scenario.ts';
import {exportPortableBackup,restorePortableBackup,openRestoredArtifacts} from '../src/portable-backup.ts';
import {textFixture} from './support/record-artifact-fixture.ts';
import {growthStore,growthJournal} from './support/growth-fixture.ts';
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} exact accepted text HTTP rejects caller paths and mismatched identities, retains immutable history across fresh host`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const {store,transport}=await growthStore(durable),f=await textFixture(t,store),before=await store.readState('mission'),journal=await growthJournal(store);let reads=0;
 const reader={read:async(a:Parameters<typeof f.artifacts.read>[0])=>{reads++;return f.artifacts.read(a);}};
 let server=createWorkbench(store,f.root,{artifacts:reader}),base='';
 async function start(){server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port;}
 async function stop(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 await start();t.after(stop);
 const query='?work=work&record=record&version=1&sha256='+f.artifact.sha256;
 const get=async(q=query,feed=before.feedId,mission='mission')=>{const response=await fetch(base+'/missions/'+mission+'/record-artifact'+q,{headers:{'X-Massion-Feed':feed}});return {status:response.status,body:await response.json()};};
 const first=await get();assert.equal(first.status,200);assert.equal(first.body.content,await f.artifacts.read(f.artifact));assert.equal(first.body.recordChecksum,before.snapshot!.value.works[0]!.record!.checksum);assert.equal(first.body.evidenceClass,'fixture');assert.equal(first.body.byteLength,Buffer.byteLength(first.body.content));assert.equal(first.body.feedId,before.feedId);assert.equal('path' in first.body.artifact,false);
 const count=reads;
 for(const [q,status] of [[query+'&path=/tmp/other',400],[query+'&record=record',400],[query.replace('version=1','version=2'),409],[query.replace('record=record','record=other'),409],[query.replace(f.artifact.sha256,'0'.repeat(64)),409],[query.replace('work=work','work=other'),404]] as const)assert.equal((await get(q)).status,status);
 assert.equal((await get(query,'other-feed')).status,409);assert.equal((await get(query,before.feedId,'other')).status,404);assert.equal(reads,count);
 assert.deepEqual(await store.readState('mission'),before);assert.deepEqual(await growthJournal(store),journal);
 await stop();server=createWorkbench(transport?new SurrealStore(transport):store,f.root,{artifacts:f.artifacts});await start();assert.deepEqual((await get()).body,first.body);assert.deepEqual(await growthJournal(store),journal);
});
test('recomputed checksum cannot certify wrong independent verifier, unresolved effects or substituted snapshot path',async t=>{
 const {store}=await growthStore(false),f=await textFixture(t,store),state=await store.readState('mission');
 for(const corrupt of ['verifier','effect','snapshot']){
  const copy=structuredClone(state),work=copy.snapshot!.value.works[0]!,record=work.record!;
  if(corrupt==='verifier'){record.assignments.find(a=>a.role==='verifier')!.actorId='executor';work.assignments=structuredClone(record.assignments);}
  if(corrupt==='effect'){record.receipts[0]!.status='unknown';work.effects=structuredClone(record.receipts);}
  if(corrupt==='snapshot')record.artifactSnapshot!.path+='.substitute';
  const {checksum,...bundle}=record;record.checksum=hash(bundle);let reads=0;
  await assert.rejects(readRecordArtifact({readState:async()=>copy} as Store<Mission>,{read:async()=>{reads++;return ''; }},'mission','work',{recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256}),/exact accepted/);assert.equal(reads,0);
 }
});
test('unaccepted Work and unsupported code Record are rejected before the artifact port is called',async t=>{
 const {store}=await growthStore(false),f=await textFixture(t,store),product=new ProductService(store);await product.admit('mission',{commandId:'unaccepted-work',expectedRevision:(await store.load('mission'))!.revision,workId:'unaccepted',title:'Not yet accepted',budget:0});let reads=0;const reader={read:async()=>{reads++;return 'unexpected';}},input={recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256};
 await assert.rejects(readRecordArtifact(store,reader,'mission','unaccepted',input),/exact accepted/);
 await runCalculationScenario(store,f.root,'code-mission');const work=(await store.load('code-mission'))!.value.works.find(w=>w.record)!;await assert.rejects(readRecordArtifact(store,reader,'code-mission',work.id,{recordId:work.record!.id,artifactVersion:work.record!.artifact.version,artifactSha256:work.record!.artifact.sha256}),/Only exact accepted UTF-8/);assert.equal(reads,0);
});
test('query pins caller input before the asynchronous read and rejects changed feed or damaged canonical Record',async t=>{
 const {store}=await growthStore(false),f=await textFixture(t,store),state=await store.readState('mission'),input={recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256,feedId:state.feedId};let resolve!:()=>void,started!:()=>void;const admitted=new Promise<void>(r=>started=r);const held=new Promise<void>(r=>resolve=r);const reader={read:async()=>{started();await held;return f.artifacts.read(f.artifact);}};
 const pending=readRecordArtifact(store,reader,'mission','work',input);await admitted;input.recordId='changed';input.artifactSha256='0'.repeat(64);resolve();assert.equal((await pending)!.recordId,'record');
 let reads=0;const unstable={readState:async()=>{const copy=structuredClone(state);if(++reads>1)copy.feedId='replaced-feed';return copy;}} as Store<Mission>;await assert.rejects(readRecordArtifact(unstable,f.artifacts,'mission','work',{recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256}),/cursor|feed/i);
 const corrupted=structuredClone(state);corrupted.snapshot!.value.works[0]!.record!.criteria.description='Changed canonical payload';let portCalls=0;await assert.rejects(readRecordArtifact({readState:async()=>corrupted} as Store<Mission>,{read:async()=>{portCalls++;return ''; }},'mission','work',{recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256}),/exact accepted/);assert.equal(portCalls,0);
});
test('actual SurrealDB normal credential-free CLI reads accepted text after host process restart with unchanged snapshot/feed/journal',{skip:!process.env.SURREAL_TEST_RUNTIME},async t=>{
 let child:ReturnType<typeof spawn>|undefined,log='',cwd='';const entry=fileURLToPath(new URL('../src/server.ts',import.meta.url)),argv=[process.execPath,entry];
 async function stop(){if(child)await stopOwnedChild(child,{cwd,argv});}t.after(stop);
 const {store,transport}=await growthStore(true),f=await textFixture(t,store,true);assert.ok(transport);const before=await store.readState('mission'),journal=await growthJournal(store);
 cwd=f.root;
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(r=>probe.close(()=>r()));
 // The fresh database name is taken from this owned transport's creation, never an existing service.
 const database=(await transport.query('RETURN $session.db;',{}))[0];assert.equal(typeof database,'string');
 async function start(){child=spawn(process.execPath,[entry],{cwd:f.root,env:{MASSION_SURREAL_RPC:process.env.MASSION_TEST_SURREAL_RPC!,MASSION_SURREAL_NAMESPACE:process.env.MASSION_TEST_SURREAL_NAMESPACE!,MASSION_SURREAL_DATABASE:database as string,MASSION_PORT:String(port)},stdio:['ignore','pipe','pipe']});child.stdout!.on('data',b=>log+=b);child.stderr!.on('data',b=>log+=b);const deadline=Date.now()+10000;while(true){try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok)return;}catch{}assert.ok(child.exitCode===null&&Date.now()<deadline,log);await new Promise(r=>setTimeout(r,10));}}
 const get=async()=>{const r=await fetch('http://127.0.0.1:'+port+'/missions/mission/record-artifact?work=work&record=record&version=1&sha256='+f.artifact.sha256,{headers:{'X-Massion-Feed':before.feedId}});assert.equal(r.status,200);return r.json();};
 await start();const pid=child!.pid,first=await get();assert.equal(first.content,await f.artifacts.read(f.artifact));await stop();await start();assert.notEqual(child!.pid,pid);assert.deepEqual(await get(),first);assert.deepEqual(await store.readState('mission'),before);assert.deepEqual(await growthJournal(store),journal);
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} accepted text query fails closed for absent port, bad bytes and sealed-file tamper without fallback`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const {store}=await growthStore(durable),f=await textFixture(t,store),before=await store.readState('mission'),journal=await growthJournal(store),input={recordId:'record',artifactVersion:1,artifactSha256:f.artifact.sha256,feedId:before.feedId};
 await assert.rejects(new ProductService(store).readAcceptedText('mission','work',input),/not enabled/);
 for(const content of ['wrong','',String.fromCharCode(0xd800),'x'.repeat(32769)])await assert.rejects(new ProductService(store,undefined,undefined,{read:async()=>content}).readAcceptedText('mission','work',input),/SHA-256/);
 const preserved=f.artifact.path+'.original';await rename(f.artifact.path,preserved);await writeFile(f.artifact.path,'wrong sealed bytes',{mode:0o400});
 await assert.rejects(new ProductService(store,undefined,undefined,f.artifacts).readAcceptedText('mission','work',input),/integrity/);
 await rename(f.artifact.path,f.artifact.path+'.tampered');await rename(preserved,f.artifact.path);
 assert.equal((await new ProductService(store,undefined,undefined,f.artifacts).readAcceptedText('mission','work',input))!.content,await f.artifacts.read(f.artifact));assert.deepEqual(await store.readState('mission'),before);assert.deepEqual(await growthJournal(store),journal);
});
test('actual SurrealDB relocated portable restore reads original accepted descriptor and history through normal HTTP without dispatch',{skip:!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const {store}=await growthStore(true),f=await textFixture(t,store);assert.ok(store instanceof SurrealStore);const before=await store.load('mission'),journal=await store.exportJournal(),serialized=await exportPortableBackup(store,f.artifacts);const {store:destination}=await growthStore(true);assert.ok(destination instanceof SurrealStore);const root=join(f.root,'relocated');await restorePortableBackup(serialized,destination,root);
 await rename(join(f.root,'original'),join(f.root,'original-preserved'));const server=createWorkbench(destination,f.root,{artifacts:openRestoredArtifacts(serialized,root)});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const a=server.address();assert.ok(a&&typeof a==='object');
 const response=await fetch('http://127.0.0.1:'+a.port+'/missions/mission/record-artifact?work=work&record=record&version=1&sha256='+f.artifact.sha256);assert.equal(response.status,200);assert.match((await response.json()).content,/한글 🌙/);assert.deepEqual(await destination.load('mission'),before);assert.deepEqual(await destination.exportJournal(),journal);
});
