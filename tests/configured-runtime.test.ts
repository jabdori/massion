import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {ServerResponse} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredTextRuntime,TEXT_REVIEW_ORACLE} from '../src/configured-runtime.ts';
import type {ConfiguredRuntimeOptions} from '../src/configured-runtime.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {OpenAICompatibleChatAdapter} from '../src/http-provider.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {ProviderRegistry} from '../src/providers.ts';
import type {Mission} from '../src/domain.ts';
import {createWorkbench} from '../src/server.ts';

const artifactText='The review has two open blockers: missing coverage and an unresolved dependency.';
interface MockOptions {forgeHash?:boolean;failReview?:boolean;unknownExecutor?:boolean;holdExecutor?:boolean;tamperBeforeReview?:()=>Promise<void>}
async function setup(t:TestContext,options:MockOptions={},store:Store<Mission>=new InMemoryStore<Mission>()){
 const calls:{model:string;prompt:any;correlation:string}[]=[];let release!:(value?:unknown)=>void;const held=new Promise(resolve=>{release=resolve;});
 const modelServer=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);const prompt=JSON.parse(body.messages[0].content.split('\n\nInput references')[0]);calls.push({model:body.model,prompt,correlation:String(req.headers['x-client-request-id'])});
  if(body.model==='executor-v1'&&options.holdExecutor)await held;
  if(body.model==='executor-v1'&&options.unknownExecutor){req.socket.destroy();return;}
  let content=artifactText;
  if(body.model==='verifier-v1'){
   if(options.tamperBeforeReview)await options.tamperBeforeReview();
   content=JSON.stringify({artifactSha256:options.forgeHash?'0'.repeat(64):prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:options.failReview?'failed':'passed',checks:[{criterion:prompt.criteria.description,passed:!options.failReview,quote:'two open blockers',reason:options.failReview?'Mock independent review found inadequate detail':'Mock review confirms the bounded acceptance claim'}]});
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'chatcmpl-mock',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content,refusal:null}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}));
 });modelServer.listen(0,'127.0.0.1');await once(modelServer,'listening');const address=modelServer.address();assert.ok(address&&typeof address==='object');const endpoint=`http://127.0.0.1:${address.port}/v1/chat/completions`;
 const adapter=(model:string)=>new OpenAICompatibleChatAdapter({provider:'local-contract-server',model,configVersion:'v1',endpoint,enabled:true,transportMode:'local-http-mock',bounds:{maxInputBytes:32768,maxOutputTokens:64,maxResponseBytes:65536,timeoutMs:2000},authorization:{provider:'local-contract-server',model,configVersion:'v1',endpoint,maxInputBytes:32768,maxOutputTokens:64},transport:fetch});
 const executor=adapter('executor-v1'),verifier=adapter('verifier-v1');const root=await mkdtemp(join(tmpdir(),'massion-provider-runtime-'));const artifacts=new TextArtifactStore(join(root,'artifacts'));
 const config:ConfiguredRuntimeOptions={enabled:true,outputTokenCap:64,authorization:{id:'explicit-local-mock-grant',scope:'local-contract',mode:'mock-http',executor:executor.descriptor,verifier:verifier.descriptor,maxOutputTokensPerCall:64},executor:{identity:'configured-executor',adapter:executor},verifier:{identity:'configured-verifier',adapter:verifier},artifacts};
 const runtime=new ConfiguredTextRuntime(store,config);const product=new ProductService(store,new ProviderRegistry([executor,verifier]),runtime);
 t.after(async()=>{release();modelServer.closeAllConnections();await new Promise<void>(resolve=>modelServer.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 const missionId='mission-'+Math.random().toString(36).slice(2);const workId='document';
 async function admit(budget=128,oracle=TEXT_REVIEW_ORACLE){await product.create({id:missionId,purpose:'Prepare a bounded readiness note',scope:'local-contract',constraints:['Text only, no outside actions'],criteria:{version:1,description:'Identify two open blockers',oracle}},missionId+':create');return product.admit(missionId,{commandId:missionId+':admit',expectedRevision:1,workId,title:'Summarize readiness',budget});}
 return {calls,store,runtime,product,config,root,missionId,workId,admit,release};
}

test('configured application path executes HTTP mock, verifies exact artifact, and accepts fixture-class Records',async t=>{
 const s=await setup(t);await s.admit();const result=await s.product.run(s.missionId,s.workId,'run-one',2);assert.equal(result.status,'settled');
 const w=result.snapshot.value.works[0]!;assert.equal(w.acceptance,'accepted');assert.equal(w.artifact?.kind,'text');assert.equal(w.effects.length,3);assert.equal(w.record?.evidenceClass,'fixture');assert.equal(w.budget.reserved,128);assert.equal(w.budget.measured,10);assert.equal(w.budget.unit,'output-tokens');assert.equal(s.calls.length,2);
 assert.notEqual(s.calls[0]?.model,s.calls[1]?.model);assert.equal(s.calls[1]?.prompt.binding.artifactSha256,w.artifact?.sha256);assert.equal(s.calls[1]?.prompt.artifact.content,artifactText);
 assert.ok(w.record?.artifactSnapshot);assert.equal(JSON.parse(w.effects[0]!.receipt!).output,artifactText,'provider result remains durable before artifact write');
 assert.equal((await s.product.run(s.missionId,s.workId,'retry-different-id',result.snapshot.revision)).status,'already-started');assert.equal(s.calls.length,2);
});
test('forged passed verdict cannot accept a different artifact binding',async t=>{
 const s=await setup(t,{forgeHash:true});await s.admit();const result=await s.product.run(s.missionId,s.workId,'run',2);const w=result.snapshot.value.works[0]!;assert.equal(w.acceptance,'failed');assert.equal(w.record,undefined);assert.equal(s.calls.length,2);
});
test('independent failed judgment settles execution without accepting a Record',async t=>{
 const s=await setup(t,{failReview:true});await s.admit();const result=await s.product.run(s.missionId,s.workId,'run',2);assert.equal(result.snapshot.value.works[0]?.execution,'settled');assert.equal(result.snapshot.value.works[0]?.acceptance,'failed');
});
test('reserved output budget must cover executor and verifier before any HTTP dispatch',async t=>{
 const s=await setup(t);await s.admit(127);const result=await s.product.run(s.missionId,s.workId,'run',2);assert.equal(result.status,'blocked');assert.match(result.reason??'',/reserve/);assert.equal(s.calls.length,0);assert.equal(result.snapshot.value.works[0]?.effects.length,0);
});
test('authorization/criteria gates cannot be enabled by ordinary user admission',async t=>{
 const s=await setup(t);await s.admit(128,'manual-review/v1');const result=await s.product.run(s.missionId,s.workId,'run',2);assert.equal(result.status,'blocked');assert.equal(s.calls.length,0);
 const disabled=new ConfiguredTextRuntime(s.store,{...s.config,enabled:false});assert.equal((await disabled.run(s.missionId,s.workId,'other',2)).status,'blocked');assert.equal(s.calls.length,0);
 assert.throws(()=>new ConfiguredTextRuntime(s.store,{...s.config,verifier:{...s.config.verifier,identity:s.config.executor.identity}}),/distinct/);
});
test('lost HTTP outcome remains unknown and a fresh runtime never blindly invokes again',async t=>{
 const s=await setup(t,{unknownExecutor:true});await s.admit();const result=await s.product.run(s.missionId,s.workId,'run',2);const w=result.snapshot.value.works[0]!;assert.equal(w.effects[0]?.status,'unknown');assert.equal(w.budget.measured,null);assert.equal(w.record,undefined);assert.equal(s.calls.length,1);
 const restarted=new ConfiguredTextRuntime(s.store,s.config);assert.equal((await restarted.run(s.missionId,s.workId,'run-again',result.snapshot.revision)).status,'already-started');assert.equal(s.calls.length,1);
});
test('cancelled in-flight invocation records uncertainty and admits no verifier/artifact effect',async t=>{
 const s=await setup(t,{holdExecutor:true});await s.admit();const running=s.product.run(s.missionId,s.workId,'run',2);
 while(s.calls.length===0)await new Promise(resolve=>setTimeout(resolve,5));
 const current=await s.store.load(s.missionId);await s.product.intervene(s.missionId,{commandId:'cancel',expectedRevision:current!.revision,command:{type:'cancel',workId:s.workId}});
 const result=await running;const w=result.snapshot.value.works[0]!;assert.equal(w.execution,'cancelled');assert.equal(w.effects.length,1);assert.equal(w.effects[0]?.status,'unknown');assert.equal(w.record,undefined);assert.equal(s.calls.length,1);s.release();
});
test('artifact mutation during verifier call cannot be accepted',async t=>{
 let s:Awaited<ReturnType<typeof setup>>;s=await setup(t,{tamperBeforeReview:async()=>{const artifact=(await s.store.load(s.missionId))!.value.works[0]!.artifact!;await chmod(artifact.path,0o600);await writeFile(artifact.path,'Mutated after provider reviewed');}});await s.admit();await assert.rejects(s.product.run(s.missionId,s.workId,'run',2));assert.equal((await s.store.load(s.missionId))?.value.works[0]?.record,undefined);
});
test('run HTTP endpoint invokes only an explicitly injected configured application runtime',async t=>{
 const s=await setup(t);await s.admit();const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const response=await fetch(`http://127.0.0.1:${address.port}/missions/${s.missionId}/run`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:'http-run',expectedRevision:2,workId:s.workId})});assert.equal(response.status,200);assert.equal((await response.json() as {status:string}).status,'settled');assert.equal(s.calls.length,2);
});
test('actual Surreal persists mock-provider receipts, independent binding and original accepted state', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const options={endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:'massion_storage_tests',database:'massion_storage_tests'};const transport=createHttpRpcTransport(options);await initializeSurrealSchema(transport);
 const s=await setup(t,{},new SurrealStore<Mission>(transport));await s.admit();const result=await s.product.run(s.missionId,s.workId,'run',2);assert.equal(result.status,'settled');assert.deepEqual(await new SurrealStore<Mission>(createHttpRpcTransport(options)).load(s.missionId),result.snapshot);assert.equal(result.snapshot.value.works[0]?.record?.evidenceClass,'fixture');
});
test('owner steering between preflight and effect admission atomically prevents artifact execution',async t=>{
 const s=await setup(t);await s.admit();const target=s.runtime as any;const original=target.active.bind(s.runtime);let calls=0;
 target.active=async(...args:any[])=>{const value=await original(...args);if(++calls===2){const snapshot=await s.store.load(s.missionId);await s.product.intervene(s.missionId,{commandId:'steer-at-boundary',expectedRevision:snapshot!.revision,command:{type:'steer',workId:s.workId,instruction:'Stop here; do not write more artifacts'}});}return value;};
 const result=await s.product.run(s.missionId,s.workId,'run',2);const w=result.snapshot.value.works[0]!;assert.equal(w.execution,'waiting');assert.equal(w.effects.length,1);assert.equal(w.artifact,undefined);assert.equal(w.record,undefined);assert.equal(s.calls.length,1);
});
test('owner steering before final task settlement cannot be erased into accepted completion',async t=>{
 const s=await setup(t);await s.admit();const target=s.runtime as any;const original=target.send.bind(s.runtime);let interrupted=false;
 target.send=async(missionId:string,command:any,...rest:any[])=>{if(!interrupted&&command.type==='settle-task'&&command.taskId===`${s.workId}:root`){interrupted=true;const snapshot=await s.store.load(s.missionId);await s.product.intervene(s.missionId,{commandId:'steer-before-accept',expectedRevision:snapshot!.revision,command:{type:'steer',workId:s.workId,instruction:'Pause before accepting'}});}return original(missionId,command,...rest);};
 const result=await s.product.run(s.missionId,s.workId,'run',2);assert.equal(result.snapshot.value.works[0]?.execution,'waiting');assert.equal(result.snapshot.value.works[0]?.record,undefined);
});
test('prospective Mission revision cannot silently change already admitted execution inputs',async t=>{
 const s=await setup(t);await s.admit();await s.product.app.dispatch({missionId:s.missionId,actorId:'local-owner',commandId:'revise-mission',expectedRevision:2,command:{type:'revise-mission',purpose:'A different future purpose',criteria:{version:2,description:'A new criterion',oracle:TEXT_REVIEW_ORACLE}}});
 const result=await s.product.run(s.missionId,s.workId,'run',3);assert.equal(result.status,'settled');assert.equal(s.calls[0]?.prompt.mission.purpose,'Prepare a bounded readiness note');assert.equal(s.calls[0]?.prompt.criteria.version,1);assert.ok(result.snapshot.value.works[0]?.runtimeRun?.inputHash);
});
test('HTTP receipt-commit contention reports an admitted unsettled run, never a rejected retryable transaction',async t=>{
 const {StorageContentionError}=await import('../src/storage.ts');
 class ReceiptConflictStore extends InMemoryStore<Mission>{override async commit(input:import('../src/storage.ts').CommitInput<Mission>){if(input.events.some(event=>(event as {type:string}).type==='receipt'))throw new StorageContentionError('Injected definite rollback of only the receipt transaction');return super.commit(input);}}
 const s=await setup(t,{},new ReceiptConflictStore());await s.admit();const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const request=()=>fetch(`http://127.0.0.1:${address.port}/missions/${s.missionId}/run`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:'interrupted-run',expectedRevision:2,workId:s.workId})});
 const response=await request();assert.equal(response.status,503);const body=await response.json() as {outcome:string;retryable:boolean};assert.equal(body.outcome,'admitted-unsettled');assert.equal(body.retryable,false);assert.equal(s.calls.length,1);assert.equal((await s.store.load(s.missionId))?.value.works[0]?.effects[0]?.status,'pending');
 const retry=await request();assert.equal(retry.status,200);assert.equal((await retry.json() as {status:string}).status,'already-started');assert.equal(s.calls.length,1);
});

const recoveryCommand=(workId:string,runId='interrupted-run')=>({type:'quarantine-runtime' as const,workId,runId,reason:'Owner inspected durable state after interrupted dispatch; remote outcome is unresolved.',acknowledgeUncertainOutcome:true as const});

test('a second owner HTTP host quarantines pending receipt failure without a configured provider or replay',async t=>{
 class ReceiptConflictStore extends InMemoryStore<Mission>{override async commit(input:import('../src/storage.ts').CommitInput<Mission>){if(input.events.some(event=>(event as {type:string}).type==='receipt'))throw new Error('Injected lost receipt commit');return super.commit(input);}}
 const s=await setup(t,{},new ReceiptConflictStore());await s.admit();await assert.rejects(s.product.run(s.missionId,s.workId,'interrupted-run',2),{name:'RunUnsettledError'});
 const before=(await s.store.load(s.missionId))!;assert.equal(s.calls.length,1);assert.equal(before.value.works[0]!.effects[0]!.status,'pending');
 const server=createWorkbench(s.store,s.root);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const payload={commandId:'owner-recovery',expectedRevision:before.revision,command:recoveryCommand(s.workId)};
 const send=()=>fetch(`http://127.0.0.1:${address.port}/missions/${s.missionId}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert.equal((await send()).status,200);const after=(await s.store.load(s.missionId))!;const w=after.value.works[0]!;
 assert.equal(w.execution,'cancelled');assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.effects[0]!.receipt,undefined);assert.equal(w.record,undefined);assert.equal(w.budget.measured,null);assert.equal(w.budget.reserved,64);
 assert.equal((await (await send()).json() as {status:string}).status,'replayed');assert.deepEqual(await s.store.load(s.missionId),after);
 assert.equal((await s.product.run(s.missionId,s.workId,'do-not-replay',after.revision)).status,'already-started');assert.equal(s.calls.length,1);
});

test('quarantine during a held provider call fences late receipt, artifact, verifier, and acceptance',async t=>{
 const s=await setup(t,{holdExecutor:true});await s.admit();const running=s.product.run(s.missionId,s.workId,'interrupted-run',2);
 while(s.calls.length===0)await new Promise(resolve=>setTimeout(resolve,5));
 const before=(await s.store.load(s.missionId))!;await s.product.intervene(s.missionId,{commandId:'quarantine-held',expectedRevision:before.revision,command:recoveryCommand(s.workId)});
 const quarantined=(await s.store.load(s.missionId))!;s.release();const result=await running;assert.equal(result.status,'cancelled');assert.deepEqual(await s.store.load(s.missionId),quarantined);
 const w=quarantined.value.works[0]!;assert.equal(w.effects.length,1);assert.equal(w.effects[0]!.receipt,undefined);assert.equal(w.artifact,undefined);assert.equal(w.record,undefined);assert.equal(s.calls.length,1);
});

test('quarantine does not claim that an already admitted dispatch in another worker stopped',async t=>{
 let admitted!:()=>void;const admission=new Promise<void>(resolve=>admitted=resolve);let resume!:()=>void;const pause=new Promise<void>(resolve=>resume=resolve);
 class PausedStore extends InMemoryStore<Mission>{override async commit(input:import('../src/storage.ts').CommitInput<Mission>){const result=await super.commit(input);if(input.events.some(event=>(event as {type:string}).type==='admit-effect')){admitted();await pause;}return result;}}
 const s=await setup(t,{},new PausedStore());await s.admit();const running=s.product.run(s.missionId,s.workId,'interrupted-run',2);await admission;
 const before=(await s.store.load(s.missionId))!;const otherHost=new ProductService(s.store);await otherHost.intervene(s.missionId,{commandId:'other-host-recovery',expectedRevision:before.revision,command:recoveryCommand(s.workId)});
 const quarantined=await s.store.load(s.missionId);resume();const result=await running;assert.equal(result.status,'cancelled');assert.equal(s.calls.length,1,'previously admitted effect may still dispatch; no stop proof is inferred');assert.deepEqual(await s.store.load(s.missionId),quarantined);
 assert.equal(quarantined!.value.works[0]!.effects.length,1);assert.equal(quarantined!.value.works[0]!.record,undefined);
});

test('actual Surreal receipt failure recovers in fresh client and restores quarantined history without dispatch', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const {exportPortableBackup,restorePortableBackup,parsePortableBackup}=await import('../src/portable-backup.ts');
 const suffix=Math.random().toString(36).slice(2);const options={endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:'quarantine_'+suffix,database:'source'};const admin=createHttpRpcTransport({endpoint:options.endpoint,namespace:'massion_storage_tests',database:'massion_storage_tests'});await admin.query(`DEFINE NAMESPACE ${options.namespace}; USE NS ${options.namespace}; DEFINE DATABASE source; DEFINE DATABASE restored;`,{});const transport=createHttpRpcTransport(options);await initializeSurrealSchema(transport);
 class ReceiptConflictStore extends SurrealStore<Mission>{override async commit(input:import('../src/storage.ts').CommitInput<Mission>){if(input.events.some(event=>(event as {type:string}).type==='receipt'))throw new Error('Injected durable-store receipt transaction interruption');return super.commit(input);}}
 const s=await setup(t,{},new ReceiptConflictStore(transport));await s.admit();await assert.rejects(s.product.run(s.missionId,s.workId,'interrupted-run',2),{name:'RunUnsettledError'});
 const freshStore=new SurrealStore<Mission>(createHttpRpcTransport(options));const freshOwner=new ProductService(freshStore);const before=(await freshStore.load(s.missionId))!;
 const input={commandId:'quarantine-surreal',expectedRevision:before.revision,command:recoveryCommand(s.workId)};
 assert.equal((await freshOwner.intervene(s.missionId,input)).status,'committed');assert.equal((await freshOwner.intervene(s.missionId,input)).status,'replayed');
 const recovered=(await freshStore.load(s.missionId))!;assert.equal(recovered.value.works[0]!.effects[0]!.status,'unknown');assert.equal(recovered.value.works[0]!.effects[0]!.receipt,undefined);
 const serialized=await exportPortableBackup(freshStore,s.config.artifacts);const bundle=parsePortableBackup(serialized);const last=bundle.journal.operations.at(-1)!;assert.equal(last.commandId,'quarantine-surreal');assert.deepEqual(last.outbox,[]);
 const restoredOptions={...options,database:'restored'};const restoredTransport=createHttpRpcTransport(restoredOptions);await initializeSurrealSchema(restoredTransport);const restoredStore=new SurrealStore<Mission>(restoredTransport);
 await restorePortableBackup(serialized,restoredStore,join(s.root,'restored-artifacts'));const secondClient=new SurrealStore<Mission>(createHttpRpcTransport(restoredOptions));assert.deepEqual(await secondClient.load(s.missionId),recovered);assert.deepEqual((await secondClient.exportJournal()).operations,bundle.journal.operations);
 const runtime=new ConfiguredTextRuntime(secondClient,s.config);assert.equal((await runtime.run(s.missionId,s.workId,'retry-after-restore',recovered.revision)).status,'already-started');assert.equal(s.calls.length,1);assert.equal(recovered.value.works[0]!.record,undefined);
});

test('actual configured accepted Record restores original descriptor metadata and sealed artifact bytes', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const {exportPortableBackup,restorePortableBackup}=await import('../src/portable-backup.ts');const namespace='configured_backup_'+Math.random().toString(36).slice(2);
 const options={endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace,database:'source'};const admin=createHttpRpcTransport({endpoint:options.endpoint,namespace:'massion_storage_tests',database:'massion_storage_tests'});
 await admin.query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE source; DEFINE DATABASE restored;`,{});const source=createHttpRpcTransport(options);await initializeSurrealSchema(source);const store=new SurrealStore<Mission>(source);
 const s=await setup(t,{},store);await s.admit();const accepted=await s.product.run(s.missionId,s.workId,'completed-run',2);assert.equal(accepted.status,'settled');const record=accepted.snapshot.value.works[0]!.record!;
 assert.equal((record.assignments[0]!.model as unknown as {enabled:boolean}).enabled,true);
 const bundle=await exportPortableBackup(store,s.config.artifacts);const destination=createHttpRpcTransport({...options,database:'restored'});await initializeSurrealSchema(destination);const target=new SurrealStore<Mission>(destination);
 const restored=await restorePortableBackup(bundle,target,join(s.root,'accepted-restored'));assert.deepEqual(await target.load(s.missionId),accepted.snapshot);assert.equal(await restored.artifacts.read(record.artifact),artifactText);assert.equal(s.calls.length,2);
});

test('executor and independent verifier receive original pinned memory content after the owner advances it',async t=>{
 const s=await setup(t);await s.product.create({id:s.missionId,purpose:'Apply an owner instruction',scope:'local-contract',constraints:['No outside actions'],criteria:{version:1,description:'Identify two open blockers',oracle:TEXT_REVIEW_ORACLE}},'create-memory-runtime');
 await s.product.saveMemory(s.missionId,{commandId:'mem1',expectedRevision:1,memory:{id:'owner-note',version:1,content:'Retain original terminology',source:'Owner v1'}});
 await s.product.admit(s.missionId,{commandId:'old-admit',expectedRevision:2,workId:'old',title:'Old wording',budget:128});
 await s.product.saveMemory(s.missionId,{commandId:'mem2',expectedRevision:3,memory:{id:'owner-note',version:2,content:'Explain terminology in plain language',source:'Owner v2'}});
 await s.product.admit(s.missionId,{commandId:'new-admit',expectedRevision:4,workId:'new',title:'New wording',budget:128});
 const old=await s.product.run(s.missionId,'old','old-run',5);assert.equal(old.status,'settled');assert.deepEqual(old.snapshot.value.works[0]?.record?.memoryVersions,['owner-note@1']);
 const newer=await s.product.run(s.missionId,'new','new-run',old.snapshot.revision);assert.equal(newer.status,'settled');assert.equal(s.calls.length,4);
 for(const [offset,version,content,source] of [[0,1,'Retain original terminology','Owner v1'],[2,2,'Explain terminology in plain language','Owner v2']] as const){
  const expected=[{id:'owner-note',version,scope:'local-contract',authority:'explicit',content,source}];
  assert.deepEqual(s.calls[offset]?.prompt.work.memories,expected);assert.deepEqual(s.calls[offset+1]?.prompt.requirements.memories,expected);
 }
 assert.deepEqual(newer.snapshot.value.works[1]?.record?.memoryVersions,['owner-note@2']);assert.ok(newer.snapshot.value.works.every(w=>w.record?.evidenceClass==='fixture'));assert.ok(newer.snapshot.value.works.every(w=>w.assignments.every(a=>a.extensionVersion==='massion.builtin.bounded-text@2')));
 t.diagnostic('Four credential-free loopback mock role calls; original immutable memory task data retained for both roles, no live-provider proof.');
});
test('missing pinned memory blocks configured run before intent, budget or mock provider dispatch',async t=>{
 const s=await setup(t);await s.admit();const snapshot=(await s.store.load(s.missionId))!;
 const value=structuredClone(snapshot.value);value.works[0]!.appliedMemoryVersions=['missing@1'];
 await s.store.commit({id:s.missionId,expectedRevision:snapshot.revision,commandId:'corrupt-fixture-pin',fingerprint:'controlled-missing-pin-fixture',value,events:[],outbox:[]});
 const before=(await s.store.load(s.missionId))!;const result=await s.product.run(s.missionId,s.workId,'never-dispatched',before.revision);
 assert.equal(result.status,'blocked');assert.match(result.reason??'',/missing/);assert.equal(s.calls.length,0);assert.deepEqual(await s.store.load(s.missionId),before);
});
