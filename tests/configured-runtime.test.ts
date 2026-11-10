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
import {BinaryArtifactStore} from '../src/binary-artifacts.ts';
import {OpenAICompatibleChatAdapter} from '../src/http-provider.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {ProviderRegistry} from '../src/providers.ts';
import {apply} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {createWorkbench} from '../src/server.ts';

const artifactText='The review has two open blockers: missing coverage and an unresolved dependency.';
interface MockOptions {reviewChecks?:unknown;outputTokens?:number;binaryOutput?:string;reviewQuote?:string;forgeHash?:boolean;failReview?:boolean;unknownExecutor?:boolean;holdExecutor?:boolean;tamperBeforeReview?:()=>Promise<void>}
async function setup(t:TestContext,options:MockOptions={},store:Store<Mission>=new InMemoryStore<Mission>()){
 const calls:{model:string;prompt:any;correlation:string}[]=[];let release!:(value?:unknown)=>void;const held=new Promise(resolve=>{release=resolve;});
 const modelServer=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);const prompt=JSON.parse(body.messages[0].content.split('\n\nInput references')[0]);calls.push({model:body.model,prompt,correlation:String(req.headers['x-client-request-id'])});
  if(body.model==='executor-v1'&&options.holdExecutor)await held;
  if(body.model==='executor-v1'&&options.unknownExecutor){req.socket.destroy();return;}
  let content=options.binaryOutput??artifactText;
  if(body.model==='verifier-v1'){
   if(options.tamperBeforeReview)await options.tamperBeforeReview();
   content=JSON.stringify({artifactSha256:options.forgeHash?'0'.repeat(64):prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:options.failReview?'failed':'passed',checks:options.reviewChecks??[{criterion:prompt.criteria.description,passed:!options.failReview,quote:options.reviewQuote??'two open blockers',reason:options.failReview?'Mock independent review found inadequate detail':'Mock review confirms the bounded acceptance claim'}]});
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'chatcmpl-mock',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content,refusal:null}}],usage:{prompt_tokens:20,completion_tokens:options.outputTokens??5,total_tokens:20+(options.outputTokens??5)}}));
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
test('Work telemetry retains host times and independently checked predicates through journal replay',async t=>{
 const s=await setup(t);await s.admit();const result=await s.product.run(s.missionId,s.workId,'telemetry',2),w=result.snapshot.value.works[0]!;
 assert.equal(result.status,'settled',result.reason??'Expected settled Work');assert.ok(Number.isSafeInteger(w.admittedAt));
 for(const task of w.tasks.filter(t=>t.parentId!==null)){assert.ok(Number.isSafeInteger(task.startedAt));assert.ok(task.endedAt!>=task.startedAt!,JSON.stringify(task));}
 assert.ok(w.verdict!.checkedAt!>=w.tasks.find(t=>t.id===s.workId+':verifier')!.startedAt!);
 assert.deepEqual(w.verdict!.predicates,[{checkedAt:w.verdict!.checkedAt,criterion:w.criteria.description,passed:true,quote:'two open blockers',reason:'Mock review confirms the bounded acceptance claim'}]);
 assert.deepEqual(w.record!.verdict,w.verdict);
 const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts'),operations=(s.store as InMemoryStore<Mission>).inspect();validateMissionJournalLineage(operations);
 const index=operations.findIndex(op=>(op.events[0] as any).type==='verify'),event=operations[index]!.events[0] as any;
 assert.throws(()=>apply(operations[index-1]!.value,{...event.command,verdict:{...event.command.verdict,checkedAt:0}},{id:event.actor,roles:['verifier']}),/host-owned/);
 assert.throws(()=>apply(operations[index-1]!.value,{...event.command,verdict:{...event.command.verdict,predicates:[{...event.command.verdict.predicates[0],passed:false}]}},{id:event.actor,roles:['verifier']}),/predicates/);
});
test('forged passed verdict cannot accept a different artifact binding',async t=>{
 const s=await setup(t,{forgeHash:true});await s.admit();const result=await s.product.run(s.missionId,s.workId,'run',2);const w=result.snapshot.value.works[0]!;assert.equal(w.acceptance,'failed');assert.equal(w.record,undefined);assert.equal(w.verdict?.predicates,undefined);assert.equal(s.calls.length,2);
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
 const s=await setup(t,{unknownExecutor:true});await s.admit();const {MonthlyBudgetService}=await import('../src/monthly-budget.ts'),budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'unknown-monthly-budget',expectedRevision:0,limit:256,timezone:'Asia/Seoul'});const result=await s.product.run(s.missionId,s.workId,'run',2);const w=result.snapshot.value.works[0]!;assert.equal(w.effects[0]?.status,'unknown');assert.equal(w.budget.measured,null);assert.equal(w.record,undefined);assert.equal(s.calls.length,1);const usage=await budget.read();assert.equal(usage.spent,null);assert.equal(usage.reserved,128);
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
 const s=await setup(t);await s.admit();const target=s.runtime as any;const original=target.active.bind(s.runtime);let steered=false;
 target.active=async(...args:any[])=>{const value=await original(...args);if(!steered&&value.effects.some((effect:any)=>effect.id==='run:executor'&&effect.status==='succeeded')&&!value.artifact){steered=true;const snapshot=await s.store.load(s.missionId);await s.product.intervene(s.missionId,{commandId:'steer-at-boundary',expectedRevision:snapshot!.revision,command:{type:'steer',workId:s.workId,instruction:'Stop here; do not write more artifacts'}});}return value;};
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

test('other host quarantine after effect intent and before provider claim prevents zero-start dispatch',async t=>{
 let admitted!:()=>void;const admission=new Promise<void>(resolve=>admitted=resolve);let resume!:()=>void;const pause=new Promise<void>(resolve=>resume=resolve);
 class PausedStore extends InMemoryStore<Mission>{override async commit(input:import('../src/storage.ts').CommitInput<Mission>){const result=await super.commit(input);if(input.events.some(event=>(event as {type:string}).type==='admit-effect')){admitted();await pause;}return result;}}
 const s=await setup(t,{},new PausedStore());await s.admit();const running=s.product.run(s.missionId,s.workId,'interrupted-run',2);await admission;
 const before=(await s.store.load(s.missionId))!;const otherHost=new ProductService(s.store);await otherHost.intervene(s.missionId,{commandId:'other-host-recovery',expectedRevision:before.revision,command:recoveryCommand(s.workId)});
 const quarantined=await s.store.load(s.missionId);resume();const result=await running;assert.equal(result.status,'cancelled');assert.equal(s.calls.length,0,'fresh durable provider claim is rejected before any adapter dispatch');assert.deepEqual(await s.store.load(s.missionId),quarantined);
 assert.equal(quarantined!.value.works[0]!.effects.length,1);assert.equal(quarantined!.value.works[0]!.record,undefined);
});

test('other host quarantine after final claim state read cannot certify a remote stop or retract already admitted call attempt',async t=>{
 const s=await setup(t);await s.admit();let reached!:()=>void,resume!:()=>void;const boundary=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>resume=r);t.after(()=>resume());const target=s.runtime as any,active=target.active.bind(target);let held=false;
 target.active=async(...args:any[])=>{const work=await active(...args);if(!held&&work.effects.some((e:any)=>e.providerDispatch&&e.status==='pending')){held=true;reached();await gate;}return work;};
 const running=s.product.run(s.missionId,s.workId,'interrupted-run',2);await boundary;const before=(await s.store.load(s.missionId))!;await new ProductService(s.store).intervene(s.missionId,{commandId:'stop-after-final-local-read',expectedRevision:before.revision,command:recoveryCommand(s.workId)});const quarantined=await s.store.load(s.missionId);resume();assert.equal((await running).status,'cancelled');assert.equal(s.calls.length,1,'local database observation and remote provider invocation are not one transaction');assert.deepEqual(await s.store.load(s.missionId),quarantined);assert.equal(quarantined!.value.works[0]!.effects[0]!.receipt,undefined);assert.equal(quarantined!.value.works[0]!.record,undefined);
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


test('requested PDF and PNG bytes pass independent review on decoded file content',async t=>{
 for(const output of [{format:'massion-result/v1',kind:'application/pdf',text:artifactText},{format:'massion-result/v1',kind:'image/png',width:1,height:1,pixels:[255,0,0]}]){
  const s=await setup(t,{binaryOutput:JSON.stringify(output),reviewQuote:output.kind==='image/png'?'#ff0000':'two open blockers'});await s.admit();
  const result=await s.product.run(s.missionId,s.workId,'binary-run',2),w=result.snapshot.value.works[0]!;
  assert.equal(w.acceptance,'accepted');assert.equal(w.artifact?.kind,output.kind);assert.ok(w.record?.artifactSnapshot);assert.ok(w.verdict!.predicates?.length);assert.deepEqual(w.record!.verdict.predicates,w.verdict!.predicates);
  const reviewed=s.calls.find(c=>c.model==='verifier-v1')!.prompt.artifact;
  assert.equal(reviewed.kind,output.kind);assert.equal(reviewed.sha256,w.artifact!.sha256);assert.match(reviewed.content,output.kind==='image/png'?/#ff0000/:/two open blockers/);
  const binary=new BinaryArtifactStore(join(s.config.artifacts.root,'binary-results')),server=createWorkbench(s.store,s.root,{scheduleIntervalMs:0,artifacts:{read:a=>s.config.artifacts.read(a),readBytes:a=>binary.readBytes(a)}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.close());
  const before=s.store instanceof InMemoryStore?s.store.inspect():null,url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/missions/'+s.missionId+'/record-binary-artifact?work='+s.workId+'&record='+w.record!.id+'&version=1&sha256='+w.artifact!.sha256;
  const response=await fetch(url),body=await response.json() as {encoding:string;content:string;artifact:{kind:string}};
  assert.equal(response.status,200);assert.equal(body.encoding,'base64');assert.equal(body.artifact.kind,output.kind);assert.deepEqual(Buffer.from(body.content,'base64'),await binary.readBytes(w.artifact!));if(s.store instanceof InMemoryStore)assert.deepEqual(s.store.inspect(),before);
 }
});

test('malformed binary output is blocked before file effects and never becomes accepted text',async t=>{
 for(const output of [{format:'massion-result/v1',kind:'text/html',text:'<script>1</script>'},{format:'massion-result/v1',kind:'image/png',width:1,height:1,pixels:[256,0,0]},{format:'massion-result/v1',kind:'application/pdf',text:'한글'}]){
  const s=await setup(t,{binaryOutput:JSON.stringify(output)});await s.admit();const result=await s.product.run(s.missionId,s.workId,'invalid-binary',2),w=result.snapshot.value.works[0]!;
  assert.equal(result.status,'blocked');assert.equal(w.record,undefined);assert.equal(w.artifact,undefined);assert.equal(s.calls.length,1);assert.equal(w.effects.some(e=>e.id==='invalid-binary:artifact'),false);
 }
});

test('a binary first result preserves the parent ownership boundary for later text output',async t=>{
 const s=await setup(t,{binaryOutput:JSON.stringify({format:'massion-result/v1',kind:'application/pdf',text:artifactText})});await s.admit();const result=await s.product.run(s.missionId,s.workId,'binary-first',2);assert.equal(result.snapshot.value.works[0]!.acceptance,'accepted');
 const text=await s.config.artifacts.write('later-text',1,'A later text result');assert.equal(await s.config.artifacts.read(text),'A later text result');
});

for(const checks of [[],[{criterion:'Wrong criterion',passed:true,quote:'two open blockers',reason:'Wrong binding'}],[{criterion:'Identify two open blockers',passed:true,quote:'not in the artifact',reason:'Invented quote'}]])test('invalid check predicates never become detailed pass evidence: '+JSON.stringify(checks),async t=>{
 const s=await setup(t,{reviewChecks:checks});await s.admit();const result=await s.product.run(s.missionId,s.workId,'invalid-checks',2),w=result.snapshot.value.works[0]!;
 assert.equal(w.acceptance,'failed');assert.equal(w.verdict!.predicates,undefined);assert.equal(w.record,undefined);
});
test('a mixed independent check preserves each pass and failure without accepting the result',async t=>{
 const checks=[{criterion:'Identify two open blockers',passed:true,quote:'missing coverage',reason:'First blocker identified'},{criterion:'Identify two open blockers',passed:false,quote:'unresolved dependency',reason:'Second blocker lacks detail'}];
 const s=await setup(t,{failReview:true,reviewChecks:checks});await s.admit();const result=await s.product.run(s.missionId,s.workId,'mixed-checks',2),w=result.snapshot.value.works[0]!;
 assert.deepEqual(w.verdict!.predicates,checks.map(check=>({...check,checkedAt:w.verdict!.checkedAt})));assert.equal(w.acceptance,'failed');assert.equal(w.record,undefined);
});

test('monthly admission pauses before any model call and a fresh owner increase resumes once through HTTP',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts');const s=await setup(t);await s.admit();const budget=new MonthlyBudgetService(s.store);
 await budget.configure({commandId:'monthly-configure',expectedRevision:0,limit:127,timezone:'Asia/Seoul'});
 const paused=await s.product.run(s.missionId,s.workId,'monthly-first',2);assert.equal(paused.snapshot.value.works[0]!.execution,'budget-waiting',JSON.stringify(paused));assert.equal(s.calls.length,0);
 const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const origin='http://127.0.0.1:'+address.port;const view=await (await fetch(origin+'/assistant/usage')).json() as any;assert.equal(view.limit,127);assert.equal(view.spent,0);
 const conversation=await (await fetch(origin+'/assistant/conversation')).json() as any;assert.equal(conversation.decisions[0].question,'이번 달 예산을 다 썼어요. 늘릴까요?');const d=conversation.decisions[0];
 const body={commandId:'monthly-raise',decisionId:d.id,answer:'act',expectedRevision:d.budget.revision,limit:d.budget.limit};const post=()=>fetch(origin+'/assistant/decisions',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
 const responses=await Promise.all([post(),post()]);assert.ok(responses.every(r=>r.status===200));const deadline=Date.now()+3000;while((await s.store.load(s.missionId))!.value.works[0]!.acceptance!=='accepted'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(s.calls.length,2,JSON.stringify((await s.store.load(s.missionId))!.value.works[0]));assert.equal((await s.store.load(s.missionId))!.value.works[0]!.acceptance,'accepted');
 assert.equal((await post()).status,200);assert.equal(s.calls.length,2);const usage=await budget.read();assert.equal(usage.spent,10);assert.equal(usage.inputTokens,40);assert.equal(usage.reserved,0);assert.equal(usage.cost,null);
 const resumed=(await s.store.load(s.missionId))!.value.works[0]!;assert.ok(Number.isSafeInteger(resumed.admittedAt));assert.equal(resumed.admittedAt,paused.snapshot.value.works[0]!.admittedAt);assert.ok(Number.isSafeInteger(resumed.verdict!.checkedAt));assert.equal(resumed.verdict!.predicates?.length,1);assert.deepEqual(resumed.record!.verdict,resumed.verdict);
 const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');validateMissionJournalLineage((s.store as InMemoryStore<Mission>).inspect());
});

test('a definite activation rejection releases only its unused monthly reservation for a later explicit run',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts');const s=await setup(t);await s.admit();const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'monthly-configure',expectedRevision:0,limit:128,timezone:'Asia/Seoul'});
 const commit=s.store.commit.bind(s.store);s.store.commit=async input=>input.commandId==='rejected-activation'?{status:'conflict',revision:input.expectedRevision,reason:'revision'}:commit(input);
 assert.equal((await s.runtime.run(s.missionId,s.workId,'rejected-activation',2)).status,'conflict');assert.equal((await budget.read()).reserved,0);assert.equal(s.calls.length,0);
 assert.equal((await s.runtime.run(s.missionId,s.workId,'stale-new-run',2)).status,'conflict');assert.equal(s.calls.length,0);assert.equal((await s.runtime.run(s.missionId,s.workId,'explicit-new-run',(await s.store.load(s.missionId))!.revision)).status,'settled');assert.equal(s.calls.length,2);
});


test('first monthly configuration accounts for a previously unmetered run before its activation commits',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts');const s=await setup(t,{outputTokens:64});await s.admit();const other=s.missionId+'-other';await s.product.create({id:other,purpose:'Second Work',scope:'local-contract',constraints:[],criteria:{version:1,description:'Identify two open blockers',oracle:TEXT_REVIEW_ORACLE}},'other-create');await s.product.admit(other,{commandId:'other-admit',expectedRevision:1,workId:s.workId,title:'Other bounded note',budget:128});
 const commit=s.store.commit.bind(s.store);let entered!:()=>void,release!:()=>void;const pending=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);t.after(()=>release());s.store.commit=async input=>{if(input.commandId==='before-first-limit'){entered();await gate;}return commit(input);};
 const first=s.runtime.run(s.missionId,s.workId,'before-first-limit',2);await pending;const budget=new MonthlyBudgetService(s.store),before=await budget.read();let second;try{await budget.configure({commandId:'first-limit',expectedRevision:before.revision,limit:128,timezone:before.timezone});second=await new ConfiguredTextRuntime(s.store,s.config).run(other,s.workId,'after-first-limit',2);}finally{release();}
 await first;assert.equal(before.reserved,128);assert.equal(second!.snapshot.value.works[0]!.execution,'budget-waiting');assert.equal(s.calls.length,2);assert.equal((await budget.read()).spent,128);const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');assert.ok(s.store instanceof InMemoryStore);validateMissionJournalLineage(s.store.inspect());
});

for(const trigger of ['startup','read'])test(`budget recovery on ${trigger} resumes remaining released Works without resending an unsettled original`,async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts'),{StorageContentionError}=await import('../src/storage.ts');const s=await setup(t);await s.admit();await s.product.admit(s.missionId,{commandId:'recovery-other-work',expectedRevision:2,workId:'other',title:'Other bounded note',budget:128});const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'recovery-budget',expectedRevision:0,limit:0,timezone:'Asia/Seoul'});
 for(const workId of [s.workId,'other'])await s.product.run(s.missionId,workId,'paused-'+workId,(await s.store.load(s.missionId))!.revision);const v=await budget.read(),d=v.decisions[0]!,accept=()=>budget.decide({commandId:'recovery-raise',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});
 const commit=s.store.commit.bind(s.store);s.store.commit=async input=>{if(input.events.some(e=>(e as any).type==='receipt'&&(e as any).command.workId===s.workId))throw new StorageContentionError('Original receipt is unsettled');return commit(input);};
 if(trigger==='startup')await accept();const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
 if(trigger==='read'){await accept();await fetch(origin+'/assistant/usage');}
 const deadline=Date.now()+3000;while((await s.store.load(s.missionId))!.value.works.find(w=>w.id==='other')!.acceptance!=='accepted'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 const snapshot=(await s.store.load(s.missionId))!,original=snapshot.value.works.find(w=>w.id===s.workId)!;assert.equal(snapshot.value.works.find(w=>w.id==='other')!.acceptance,'accepted');assert.equal(original.effects.length,1);assert.equal(original.effects[0]!.status,'pending');assert.equal(s.calls.length,3);
 await fetch(origin+'/assistant/conversation');await fetch(origin+'/assistant/usage');await server.drain();assert.equal(s.calls.length,3,'reads and drain cannot resend the original invocation');
});

test('a budget answer is acknowledged before its resumed provider call completes',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts');const s=await setup(t,{holdExecutor:true});await s.admit();const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'fast-budget',expectedRevision:0,limit:0,timezone:'Asia/Seoul'});await s.product.run(s.missionId,s.workId,'paused',(await s.store.load(s.missionId))!.revision);const v=await budget.read(),d=v.decisions[0]!;
 const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
 const sent=fetch(origin+'/assistant/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'fast-raise',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit})});let timer!:ReturnType<typeof setTimeout>;const reply=await Promise.race([sent,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),500);})]);clearTimeout(timer);s.release();await sent;assert.ok(reply,'the owner receipt must not wait for a held provider');assert.equal(reply.status,200);assert.equal((await reply.json() as any).status,'committed');
});

test('a budget command refused before commit reports rejection and leaves its revision unchanged',async t=>{
 const s=await setup(t);await s.admit();const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
 const response=await fetch(origin+'/assistant/usage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'rejected-monthly-edit',expectedRevision:0,limit:-1,timezone:'Asia/Seoul'})});assert.equal(response.status,400);assert.equal((await response.json() as any).outcome,'rejected');assert.equal((await (await fetch(origin+'/assistant/usage')).json() as any).revision,0);assert.equal(s.calls.length,0);
});

for(const stage of ['queued','reserved'])test(`accepted budget recovery survives interruption after ${stage} and starts its deterministic run once`,async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts'),{hash}=await import('../src/domain.ts'),{HostDrainError}=await import('../src/runtime-lifetime.ts');const s=await setup(t);await s.admit();const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'round2-budget',expectedRevision:0,limit:0,timezone:'Asia/Seoul'});await s.product.run(s.missionId,s.workId,'paused-round2',(await s.store.load(s.missionId))!.revision);const v=await budget.read(),d=v.decisions[0]!,runId='paused-round2';
 await budget.decide({commandId:'round2-raise',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});await assert.rejects(budget.reconcile(undefined,async r=>{if(stage==='reserved')assert.equal((await budget.admit({missionId:r.missionId,workId:r.workId,runId,amount:128,selection:r.selection})).status,'reserved');throw new HostDrainError();}),HostDrainError);
 const interrupted=(await s.store.load(s.missionId))!.value.works[0]!;assert.equal(interrupted.execution,'queued');assert.equal(interrupted.runtimeRun,undefined);assert.equal(interrupted.effects.length,0);assert.equal(s.calls.length,0);
 const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;await fetch(origin+'/assistant/usage');
 const deadline=Date.now()+3000;while((await s.store.load(s.missionId))!.value.works[0]!.acceptance!=='accepted'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));const done=(await s.store.load(s.missionId))!.value.works[0]!;assert.equal(done.acceptance,'accepted');assert.equal(done.runtimeRun!.id,runId);assert.equal(s.calls.length,2);
 await fetch(origin+'/assistant/conversation');await server.drain();assert.equal(s.calls.length,2);const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');assert.ok(s.store instanceof InMemoryStore);validateMissionJournalLineage(s.store.inspect());
});

test('accepted budget recovery waits for an occupied host and resumes after it becomes idle',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts');const s=await setup(t,{holdExecutor:true});await s.admit();const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'busy-budget',expectedRevision:0,limit:0,timezone:'Asia/Seoul'});await s.product.run(s.missionId,s.workId,'busy-paused',(await s.store.load(s.missionId))!.revision);let v=await budget.read();await budget.configure({commandId:'busy-settings',expectedRevision:v.revision,limit:256,timezone:v.timezone});await s.product.admit(s.missionId,{commandId:'busy-other',expectedRevision:(await s.store.load(s.missionId))!.revision,workId:'other',title:'Other bounded note',budget:128});
 const occupied=s.runtime.run(s.missionId,'other','busy-run',(await s.store.load(s.missionId))!.revision);const entered=Date.now()+3000;while(s.calls.length===0&&Date.now()<entered)await new Promise(r=>setTimeout(r,5));assert.equal(s.calls.length,1);
 const server=createWorkbench(s.store,s.root,{providers:s.product.providers,runtime:s.runtime,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;v=await budget.read();const d=v.decisions[0]!;
 const response=await fetch(origin+'/assistant/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'busy-raise',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit})});assert.equal(response.status,200);await fetch(origin+'/assistant/usage');await fetch(origin+'/assistant/usage');assert.ok(['queued','budget-waiting'].includes((await s.store.load(s.missionId))!.value.works[0]!.execution));
 s.release();assert.equal((await occupied).status,'settled');await fetch(origin+'/assistant/usage');const deadline=Date.now()+3000;while((await s.store.load(s.missionId))!.value.works[0]!.acceptance!=='accepted'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal((await s.store.load(s.missionId))!.value.works[0]!.acceptance,'accepted');await server.drain();assert.equal(s.calls.length,4);
});

test('a terminal receipt landing after accounting freezes its cursor cannot fund overlapping Work',async t=>{
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts'),s=await setup(t,{holdExecutor:true,outputTokens:40});await s.admit();await s.product.admit(s.missionId,{commandId:'cursor-other',expectedRevision:2,workId:'other',title:'Other note',budget:128});const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'cursor-budget',expectedRevision:0,limit:200,timezone:'UTC'});
 const running=s.product.run(s.missionId,s.workId,'cursor-run',3);void running.catch(()=>{});const deadline=Date.now()+2000;while(!s.calls.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,2));assert.equal(s.calls.length,1);
 const load=s.store.load.bind(s.store);let interleave=true;s.store.load=async id=>{if(id===s.missionId&&interleave){interleave=false;s.release();assert.equal((await running).status,'settled');}return load(id);};
 const view=await budget.read();assert.equal(interleave,false);assert.equal(view.knownOutputTokens,80);assert.equal(view.reserved,0);assert.equal(view.cursor,(await s.store.readState()).cursor);assert.equal((await budget.admit({missionId:s.missionId,workId:'other',runId:'cursor-second',amount:128})).status,'waiting');assert.equal(s.calls.length,2);
});

test('a run starting mid-reconciliation retains its reservation until activation commits',{timeout:10000},async t=>{
 const {MonthlyBudgetService,MONTHLY_BUDGET_ID}=await import('../src/monthly-budget.ts');const s=await setup(t);await s.admit();const stale=s.missionId+'-stale';await s.product.create({id:stale,purpose:'Abandoned claim',scope:'local-contract',constraints:[],criteria:{version:1,description:'Identify two open blockers',oracle:TEXT_REVIEW_ORACLE}},'stale-create');await s.product.admit(stale,{commandId:'stale-work',expectedRevision:1,workId:'stale',title:'Abandoned note',budget:128});const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'mid-pass-budget',expectedRevision:0,limit:256,timezone:'UTC'});await budget.admit({missionId:stale,workId:'stale',runId:'abandoned-run',amount:128});
 const commit=s.store.commit.bind(s.store);let release!:()=>void,entered!:()=>void,started=false,running:ReturnType<typeof s.product.run>|undefined;const gate=new Promise<void>(r=>release=r),activation=new Promise<void>(r=>entered=r);t.after(()=>release());
 s.store.commit=async input=>{if(input.commandId==='mid-pass-run'){entered();await gate;}const result=await commit(input);if(!started&&(input.events[0] as any)?.type==='reconcile-monthly-budget'){started=true;running=s.product.run(s.missionId,s.workId,'mid-pass-run',2);void running.catch(()=>{});await activation;}return result;};
 try{await budget.reconcile(undefined,undefined,undefined,()=>s.runtime.hasActiveAdmission());assert.equal(started,true);const state=(await s.store.load(MONTHLY_BUDGET_ID))!.value as any;assert.equal(state.reservations.find((r:any)=>r.workId===s.workId).state,'reserved','the live run claim must survive a refreshed reconciliation snapshot');assert.equal(s.calls.length,0);assert.equal((await budget.read()).reserved,128);}finally{release();}
 assert.equal((await running!).status,'settled');assert.equal((await s.store.load(s.missionId))!.value.works[0]!.acceptance,'accepted');assert.equal(s.calls.length,2);await budget.reconcile();assert.equal((await budget.read()).reserved,0);
});

for(const phase of ['completion','reservation-ack-loss'] as const)test('runtime '+phase+' cleanup cannot revoke another instance activation',{timeout:10000},async t=>{
 const {MonthlyBudgetService,MONTHLY_BUDGET_ID}=await import('../src/monthly-budget.ts'),s=await setup(t);await s.admit();const other=s.missionId+'-cleaning';await s.product.create({id:other,purpose:'Independent runtime',scope:'local-contract',constraints:[],criteria:{version:1,description:'Identify two open blockers',oracle:TEXT_REVIEW_ORACLE}},'cleaning-create');await s.product.admit(other,{commandId:'cleaning-work',expectedRevision:1,workId:'cleaning',title:'Independent note',budget:128});const budget=new MonthlyBudgetService(s.store);await budget.configure({commandId:'parallel-budget',expectedRevision:0,limit:256,timezone:'UTC'});
 const commit=s.store.commit.bind(s.store);let release!:()=>void,entered!:()=>void,lost=false;const gate=new Promise<void>(r=>release=r),activation=new Promise<void>(r=>entered=r);t.after(()=>release());s.store.commit=async input=>{if(input.commandId==='held-other-activation'){entered();await gate;}const result=await commit(input);const command=(input.events[0] as any)?.command;if(phase==='reservation-ack-loss'&&!lost&&command?.type==='reserve-monthly-budget'&&command.entry.missionId===other){lost=true;throw Error('Lost owned monthly reservation acknowledgment');}return result;};
 const held=s.product.run(s.missionId,s.workId,'held-other-activation',2);void held.catch(()=>{});await activation;const cleaning=new ConfiguredTextRuntime(s.store,s.config);
 try{const run=cleaning.run(other,'cleaning','cleaning-run',2);if(phase==='completion')assert.equal((await run).status,'settled');else await assert.rejects(run,/Lost owned monthly reservation acknowledgment/);const state=(await s.store.load(MONTHLY_BUDGET_ID))!.value as any;assert.equal(state.reservations.find((r:any)=>r.missionId===s.missionId).state,'reserved','cleanup can reconcile only its own admission');assert.equal((await s.store.load(s.missionId))!.revision,2);assert.equal(s.calls.length,phase==='completion'?2:0);}finally{release();}
 assert.equal((await held).status,'settled');assert.equal(s.calls.length,phase==='completion'?4:2);assert.equal((await s.store.load(s.missionId))!.value.works[0]!.acceptance,'accepted');assert.equal((await budget.read()).reserved,0);const current=(await s.store.load(s.missionId))!;assert.equal((await s.product.run(s.missionId,s.workId,'no-resend',current.revision)).status,'already-started');assert.equal(s.calls.length,phase==='completion'?4:2);
});

test('credential repair retries only the rejected verifier stage and keeps original evidence',async t=>{
 const s=await setup(t);await s.admit(128);let tries=0,paused!:(v:any)=>void;
 const waiting=new Promise<any>(r=>paused=r),original=s.config.verifier.adapter;
 const config={...s.config,verifier:{...s.config.verifier,adapter:{descriptor:original.descriptor,async invoke(request:any){if(++tries===1)return {status:'failed' as const,output:null,usage:{inputTokens:null,outputTokens:null},reason:'credential_rejected',credentialFailure:{kind:'invalid' as const,code:'invalid_api_key' as const},credentialBinding:{connectionId:'exact-connection',configHash:'a'.repeat(64),generation:1}};return original.invoke(request);}}},repairCredential:async (input:any)=>{paused(input);await input.signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});input.continue=async()=>{const {Application}=await import('../src/application.ts');const state=(await s.store.load(s.missionId))!;const result=await new Application(s.store,[{id:'local-owner',roles:['owner']}]).dispatch({missionId:s.missionId,actorId:'local-owner',commandId:'retry-once',expectedRevision:state.revision,command:{type:'retry-credential',workId:s.workId,effectId:input.blocker.effectId,connectionId:input.blocker.connectionId,configHash:input.blocker.configHash,replacementCommandId:'replacement-one'}});assert.equal(result.status,'committed');resolve();};});}};
 const runtime=new ConfiguredTextRuntime(s.store,config),running=runtime.run(s.missionId,s.workId,'credential-run',2),input=await Promise.race([waiting,running.then(result=>{throw Error('Run ended before pause: '+JSON.stringify(result));}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Credential pause was not produced')),500))]);
 t.after(()=>runtime.beginDrain());void running.catch(()=>{});const blocked=(await s.store.load(s.missionId))!.value.works[0]!;assert.equal(blocked.execution,'blocked');assert.equal(blocked.blocker?.credential?.effectId,'credential-run:verifier');assert.ok(blocked.artifact);assert.equal(s.calls.length,1);
 await input.continue();const result=await running,w=result.snapshot.value.works[0]!;
 assert.equal(w.acceptance,'accepted');assert.equal(s.calls.length,2);assert.equal(w.effects.filter(e=>e.taskId===s.workId+':executor').length,2);assert.equal(w.effects.find(e=>e.id==='credential-run:verifier')!.status,'failed');assert.equal(w.effects.find(e=>e.id==='credential-run:verifier:repair')!.status,'succeeded');
 const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');assert.doesNotThrow(()=>validateMissionJournalLineage((s.store as InMemoryStore<Mission>).inspect()));
});
