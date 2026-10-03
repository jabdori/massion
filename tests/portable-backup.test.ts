import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.ts';
import { hash, canonical } from '../src/domain.ts';
import type { Mission, Command } from '../src/domain.ts';
import { InMemoryStore, SurrealStore, createHttpRpcTransport, initializeSurrealSchema } from '../src/storage.ts';
import type { Store, PortableJournal } from '../src/storage.ts';
import { TextArtifactStore } from '../src/text-artifacts.ts';
import { exportPortableBackup, parsePortableBackup, restorePortableBackup, openRestoredArtifacts } from '../src/portable-backup.ts';

async function fixture(t: TestContext, store: Store<Mission> = new InMemoryStore<Mission>()) {
  const root = await mkdtemp(join(tmpdir(), 'massion-portable-')); t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new TextArtifactStore(join(root, 'original'));
  const app = new Application(store, [{id:'owner',roles:['owner']},{id:'executor',roles:['executor']},{id:'verifier',roles:['verifier']}]);
  let revision = 1;
  await app.create({id:'mission',purpose:'Fixture restore evidence',scope:'local',constraints:[],criteria:{version:1,description:'Retain exact fixture bytes',oracle:'fixture-restore/v1'}},'owner','create');
  const send = async(command:Command, actorId='owner') => { await app.dispatch({missionId:'mission',commandId:`command-${revision}`,expectedRevision:revision++,actorId,command}); };
  await send({type:'admit-work',workId:'work',title:'Portable accepted fixture',budget:2});
  const model = {provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only backup fixture, no model invocation',evidenceClass:'fixture' as const};
  for(const role of ['executor','verifier'] as const) await send({type:'assign',workId:'work',assignment:{id:role,actorId:role,role,taskId:'work:root',model,extensionVersion:'v1'}});
  await send({type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'work:root',status:'pending',target:'fixture text',authority:'local fixture'},reserve:1},'executor');
  await send({type:'receipt',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Fixture bytes prepared without a provider',usage:1},'executor');
  const artifact = await artifacts.write('work',1,'Exact portable fixture bytes.\n');
  await send({type:'publish-artifact',workId:'work',artifact},'executor');
  await send({type:'verify',workId:'work',verdict:{id:'verdict',verifierAssignmentId:'verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Deterministic data-only test',source:'test'}]}},'verifier');
  await send({type:'settle-task',workId:'work',taskId:'work:root',result:'Fixture settled'},'executor');
  await send({type:'accept',workId:'work',recordId:'record',artifactSnapshot:await artifacts.snapshot(artifact)});
  return {store,root,artifacts,artifact};
}
function memoryJournal(store: InMemoryStore<Mission>): PortableJournal<Mission> {
  const operations = structuredClone(store.inspect());
  return {schemaVersion:2,head:operations.length,operations:[...operations]};
}
async function bundle(t: TestContext) { const s = await fixture(t); return {...s,serialized:await exportPortableBackup({exportJournal:async()=>memoryJournal(s.store as InMemoryStore<Mission>)},s.artifacts)}; }
function rewrite(serialized:string, mutate:(value:any)=>void):string { const value=JSON.parse(serialized);mutate(value);const {checksum,...body}=value;return canonical({...body,checksum:hash(body)}); }

test('portable bundle preserves original Record, journal and exact artifact inventory',async t=>{
 const s=await bundle(t);const backup=parsePortableBackup(s.serialized);assert.equal(backup.artifacts.length,1);assert.equal(backup.blobs.length,1);assert.equal(backup.journal.operations.at(-1)!.value.works[0]!.record!.evidenceClass,'fixture');
 assert.equal(Buffer.from(backup.blobs[0]!.base64,'base64').toString(),'Exact portable fixture bytes.\n');
});
test('portable parser rejects modified, missing, extra and noncanonical blobs and unsupported version',async t=>{
 const s=await bundle(t);
 for(const mutate of [(b:any)=>{b.format='future';},(b:any)=>{b.blobs=[];},(b:any)=>{b.blobs.push(b.blobs[0]);},(b:any)=>{b.blobs[0].base64=Buffer.from('tampered').toString('base64');},(b:any)=>{b.blobs[0].base64+='!';},(b:any)=>{b.artifacts[0].path='/tmp/../escape';}])assert.throws(()=>parsePortableBackup(rewrite(s.serialized,mutate)));
 assert.throws(()=>parsePortableBackup(s.serialized.replace('Fixture restore evidence','Altered evidence')));
});
test('export rechecks physical artifact tampering and source journal advancement',async t=>{
 const s=await bundle(t);const journal=memoryJournal(s.store as InMemoryStore<Mission>);let reads=0;
 await assert.rejects(exportPortableBackup({exportJournal:async()=>{if(++reads>1)return {...journal,head:journal.head+1};return journal;}},s.artifacts));
 await chmod(s.artifact.path,0o600);await writeFile(s.artifact.path,'tampered');await assert.rejects(exportPortableBackup({exportJournal:async()=>journal},s.artifacts));
});
test('restore validates before writes and rejects existing root, symlink ancestors and occupied database',async t=>{
 const s=await bundle(t);let calls=0;const store={exportJournal:async()=>({schemaVersion:2 as const,head:0,operations:[]}),restoreJournal:async()=>{calls++;return {status:'restored' as const,head:0,checksum:''};}};
 await assert.rejects(restorePortableBackup(rewrite(s.serialized,b=>{b.blobs=[];}),store,join(s.root,'invalid')));assert.equal(calls,0);
 await assert.rejects(restorePortableBackup(s.serialized,store,s.root));assert.equal(calls,0);
 await symlink(s.root,join(s.root,'link'));await assert.rejects(restorePortableBackup(s.serialized,store,join(s.root,'link','new')));assert.equal(calls,0);
 await assert.rejects(restorePortableBackup(s.serialized,{...store,exportJournal:async()=>memoryJournal(s.store as InMemoryStore<Mission>)},join(s.root,'occupied')));assert.equal(calls,0);
});
test('relocated resolver survives fresh process and refuses unlisted original descriptors',async t=>{
 const s=await bundle(t);const store={exportJournal:async()=>({schemaVersion:2 as const,head:0,operations:[]}),restoreJournal:async()=>({status:'restored' as const,head:0,checksum:''})};
 const root=join(s.root,'restored');const result=await restorePortableBackup(s.serialized,store,root);assert.equal(await result.artifacts.read(s.artifact),'Exact portable fixture bytes.\n');
 await rm(join(s.root,'original'),{recursive:true,force:true});
 const manifest=join(s.root,'backup.json');await writeFile(manifest,s.serialized);
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {readFile} from 'node:fs/promises';import {openRestoredArtifacts,parsePortableBackup} from './src/portable-backup.ts';const text=await readFile(process.argv[1],'utf8');const b=parsePortableBackup(text);process.stdout.write(await openRestoredArtifacts(text,process.argv[2]).read(b.artifacts[0]));`,manifest,root],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'Exact portable fixture bytes.\n');
 await assert.rejects(openRestoredArtifacts(s.serialized,root).read({...s.artifact,path:'/unlisted/work/'+s.artifact.sha256+'.txt'}));
});

test('actual Surreal fresh database restores accepted fixture, command lineage and held outbox with no replay',{skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const namespace='portable_'+randomUUID().replaceAll('-','');
 const transport=(database:string)=>createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace,database});
 const admin=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:'massion_storage_tests',database:'massion_storage_tests'});
 await admin.query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE source; DEFINE DATABASE destination;`,{});
 const sourceTransport=transport('source');const destTransport=transport('destination');await initializeSurrealSchema(sourceTransport);await initializeSurrealSchema(destTransport);
 const source=new SurrealStore<Mission>(sourceTransport);const dest=new SurrealStore<Mission>(destTransport);const s=await fixture(t,source);const before=await source.load('mission');
 const serialized=await exportPortableBackup(source,s.artifacts);const result=await restorePortableBackup(serialized,dest,join(s.root,'restored'));
 assert.deepEqual(await dest.load('mission'),before);assert.deepEqual(await dest.exportJournal(),await source.exportJournal());
 await rm(join(s.root,'original'),{recursive:true,force:true});assert.equal(await result.artifacts.read(before!.value.works[0]!.record!.artifact),'Exact portable fixture bytes.\n');
 const outbox=await destTransport.query('SELECT status FROM massion_outbox;',{});assert.deepEqual(outbox,[[{status:'restored-held'}]]);
 const journal=await dest.exportJournal();const op=journal.operations.at(-1)!;assert.equal((await dest.lookupOperation({id:op.aggregateId,commandId:op.commandId,fingerprint:op.fingerprint})).status,'replayed');
 await assert.rejects(restorePortableBackup(serialized,dest,join(s.root,'another')));
});


test('CLI restores bundle into a separate clean SurrealKV server and resolves Records in a fresh client', {skip:!process.env.MASSION_TEST_SURREAL_BINARY}, async t=>{
 const s=await bundle(t);const manifest=join(s.root,'backup.json');await writeFile(manifest,s.serialized,{mode:0o600});
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const endpoint=`http://127.0.0.1:${port}/rpc`;
 const server=spawn(process.env.MASSION_TEST_SURREAL_BINARY!,['start',`surrealkv://${s.root}/fresh-data`,'--bind',`127.0.0.1:${port}`,'--unauthenticated','--no-banner','--log','error','--default-namespace','restored','--default-database','restored','--deny-net','--deny-scripting'],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
 let log='';server.stdout.on('data',chunk=>{log+=chunk;});server.stderr.on('data',chunk=>{log+=chunk;});
 t.after(async()=>{if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}});
 const deadline=Date.now()+10000;while(true){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}if(Date.now()>deadline||server.exitCode!==null)throw new Error('Fresh server did not start: '+log);await new Promise(resolve=>setTimeout(resolve,25));}
 const restoredRoot=join(s.root,'clean-artifacts');await rm(join(s.root,'original'),{recursive:true,force:true});
 const restore=spawnSync(process.execPath,['scripts/backup.ts','restore',endpoint,'restored','restored',restoredRoot,manifest],{cwd:process.cwd(),encoding:'utf8',timeout:30000});assert.equal(restore.status,0,restore.stderr);assert.equal(JSON.parse(restore.stdout).effectsReplayed,0);
 const client=spawnSync(process.execPath,['--input-type=module','-e',`import {readFile} from 'node:fs/promises';import {SurrealStore,createHttpRpcTransport} from './src/storage.ts';import {openRestoredArtifacts} from './src/portable-backup.ts';import {hash} from './src/domain.ts';const store=new SurrealStore(createHttpRpcTransport({endpoint:process.argv[1],namespace:'restored',database:'restored'}));const state=await store.load('mission');const record=state.value.works[0].record;const {checksum,...body}=record;if(hash(body)!==checksum)throw Error('Record checksum');const bundle=await readFile(process.argv[2],'utf8');process.stdout.write(await openRestoredArtifacts(bundle,process.argv[3]).read(record.artifact));`,endpoint,manifest,restoredRoot],{cwd:process.cwd(),encoding:'utf8',timeout:30000});
 assert.equal(client.status,0,client.stderr);assert.equal(client.stdout,'Exact portable fixture bytes.\n');
});

test('portable inventory order is stable across English and Turkish process locales',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-locale-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>();const app=new Application(store,[{id:'owner',roles:['owner']},{id:'executor',roles:['executor']}]);const artifacts=new TextArtifactStore(join(root,'source'));
 await app.create({id:'locale',purpose:'Locale portability',scope:'local',constraints:[],criteria:{version:1,description:'Stable inventory',oracle:'fixture/v1'}},'owner','create');let revision=1;
 for(const workId of ['I','i']){
  const commands:Command[]=[{type:'admit-work',workId,title:'Case-sensitive identity',budget:1},{type:'assign',workId,assignment:{id:workId,actorId:'executor',role:'executor',taskId:workId+':root',model:{provider:'fixture',model:'fixture',configVersion:'v1',reason:'Test only',evidenceClass:'fixture'},extensionVersion:'v1'}},{type:'publish-artifact',workId,artifact:await artifacts.write(workId,1,workId)}];
  for(const command of commands)await app.dispatch({missionId:'locale',commandId:'command-'+revision,expectedRevision:revision++,actorId:command.type==='publish-artifact'?'executor':'owner',command});
 }
 const serialized=await exportPortableBackup({exportJournal:async()=>memoryJournal(store)},artifacts);const path=join(root,'bundle.json');await writeFile(path,serialized);
 for(const locale of ['en_US.UTF-8','tr_TR.UTF-8']){
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {readFile} from 'node:fs/promises';import {parsePortableBackup} from './src/portable-backup.ts';process.stdout.write(JSON.stringify(parsePortableBackup(await readFile(process.argv[1],'utf8')).artifacts.map(a=>a.id)));`,path],{cwd:process.cwd(),env:{...process.env,LC_ALL:locale},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'["I:text","i:text"]');
 }
});

test('empty backup restore creates a marked empty artifact store',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-empty-'));t.after(()=>rm(root,{recursive:true,force:true}));const journal={schemaVersion:2 as const,head:0,operations:[]};
 const store={exportJournal:async()=>journal,restoreJournal:async()=>({status:'restored' as const,head:0,checksum:''})};
 const serialized=await exportPortableBackup(store,new TextArtifactStore(join(root,'unused')));const target=join(root,'restored');await restorePortableBackup(serialized,store,target);
 const {readFile}=await import('node:fs/promises');assert.equal(JSON.parse(await readFile(join(target,'.massion-text-store.json'),'utf8')).kind,'root');
});

test('CLI rejects invalid UTF-8 and symlinked bundle ancestors before database access',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'invalid.json');await writeFile(file,Buffer.from([0xff]));
 const run=(path:string)=>spawnSync(process.execPath,['scripts/backup.ts','restore','http://127.0.0.1:1/rpc','unused','unused',join(root,'artifacts'),path],{cwd:process.cwd(),encoding:'utf8'});
 const invalid=run(file);assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/valid UTF-8/);
 await symlink(root,join(root,'link'));const linked=run(join(root,'link','invalid.json'));assert.notEqual(linked.status,0);assert.match(linked.stderr,/symbolic links/);
});

test('restored pending and unknown effects remain unchanged without any runtime dispatch',async t=>{
 const s=await bundle(t);const app=new Application(s.store,[{id:'owner',roles:['owner']},{id:'executor',roles:['executor']}]);let revision=(await s.store.load('mission'))!.revision;
 for(const workId of ['pending','unknown']){
  const commands:Command[]=[{type:'admit-work',workId,title:'Unresolved effect fixture',budget:1},{type:'assign',workId,assignment:{id:workId,actorId:'executor',role:'executor',taskId:workId+':root',model:{provider:'fixture',model:'fixture',configVersion:'v1',reason:'Test only',evidenceClass:'fixture'},extensionVersion:'v1'}},{type:'admit-effect',workId,effect:{id:workId,taskId:workId+':root',status:'pending',target:'inert fixture',authority:'fixture'},reserve:1}];
  if(workId==='unknown')commands.push({type:'receipt',workId,effectId:workId,outcome:'unknown',receipt:'Outcome unresolved; never replay',usage:null});
  for(const command of commands)await app.dispatch({missionId:'mission',commandId:'later-'+revision,expectedRevision:revision++,actorId:['admit-effect','receipt'].includes(command.type)?'executor':'owner',command});
 }
 const original=memoryJournal(s.store as InMemoryStore<Mission>);const serialized=await exportPortableBackup({exportJournal:async()=>original},s.artifacts);let imported:PortableJournal<Mission>|undefined;
 await restorePortableBackup(serialized,{exportJournal:async()=>({schemaVersion:2,head:0,operations:[]}),restoreJournal:async journal=>{imported=journal;return {status:'restored',head:journal.head,checksum:''};}},join(s.root,'unresolved-restored'));
 assert.deepEqual(imported,original);assert.deepEqual(imported!.operations.at(-1)!.value.works.slice(1).map(work=>work.effects[0]!.status),['pending','unknown']);
});

test('restored journal can be re-exported through its explicit relocation resolver',async t=>{
 const s=await bundle(t);const journal=parsePortableBackup(s.serialized).journal;const root=join(s.root,'again');
 await restorePortableBackup(s.serialized,{exportJournal:async()=>({schemaVersion:2,head:0,operations:[]}),restoreJournal:async()=>({status:'restored',head:journal.head,checksum:''})},root);
 await rm(join(s.root,'original'),{recursive:true,force:true});
 assert.equal(await exportPortableBackup({exportJournal:async()=>journal},openRestoredArtifacts(s.serialized,root)),s.serialized);
});

test('artifact failure after DB import explicitly reports committed journal and retains staged files',async t=>{
 const s=await bundle(t);const root=join(s.root,'post-commit');
 await assert.rejects(restorePortableBackup(s.serialized,{exportJournal:async()=>({schemaVersion:2,head:0,operations:[]}),restoreJournal:async()=>{const path=join(root,'work',s.artifact.sha256+'.txt');await chmod(path,0o600);await writeFile(path,'changed');return {status:'restored',head:10,checksum:''};}},root),/journal restored.*artifact verification failed/);
 const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'work',s.artifact.sha256+'.txt'),'utf8'),'changed');
});
