import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../src/application.ts';
import {ConfiguredTextRuntime} from '../src/configured-runtime.ts';
import {ASSISTANT_ACTOR_ID,assistantWorkId,assistantTurnId} from '../src/assistant-conversation.ts';
import {canResume} from '../src/runtime-continuation.ts';
import {DomainError,hash,workInputHash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {MonthlyBudgetService} from '../src/monthly-budget.ts';
import {InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {fixtureOptions} from './support/steering-resume-fixture.ts';
import {ENVIRONMENT_WORK_HOST,environmentWorkEffectId} from '../src/environment-work-state.ts';
import type {RuntimeEnvironmentBinding,EnvironmentWorkUpdate} from '../src/environment-work-state.ts';
import type {EnvironmentWorkService} from '../src/environment-work-service.ts';
import type {EnvironmentWorkDefinition,EnvironmentWorkPlan} from '../src/environment-work.ts';

const messageId='m:'+'a'.repeat(32),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId);
const message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner' as const,turnId:null,text:'Answer'};
const definition:EnvironmentWorkDefinition={memberId:'member',origin:'https://fixture.example',elements:[{id:'field',selector:'#field',role:'textbox',label:'Field',operations:['type'],gates:[]}],facts:[{id:'filled',selector:'#field',state:'value-present',label:'Filled',kind:'state'}],waits:[],secrets:[{id:'entry',label:'Entry',purpose:'Fill declared field',fields:[{slot:'value',label:'Value',kind:'id',element:'field'}]}]};
const plan:EnvironmentWorkPlan={format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',secret:{owner:'local-owner',slot:'value'}}},{kind:'observe',facts:['filled']}]};
const safeCatalog={elements:[{id:'field',operations:['type']}],facts:['filled'],waits:[],secrets:[{slot:'value',element:'field'}]};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const completed=(output:string)=>({status:'completed' as const,output,usage:{inputTokens:1,outputTokens:1},reason:'Fixture'});
type Context=Parameters<EnvironmentWorkService['execute']>[0];

async function fixture(t:test.TestContext,settings:{decline?:boolean;output?:string;wait?:boolean;crash?:boolean;unknown?:boolean;environment?:boolean;bind?:'none'|'throw';timeout?:number}={}){
 const root=await mkdtemp(join(tmpdir(),'massion-environment-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{id:'browser-read-host',roles:['representative']}]);
 const read=async()=>(await store.load('mission'))!,work=async()=>(await read()).value.works[0]!;
 const calls:{id:string;prompt:any}[]=[],artifacts=new TextArtifactStore(join(root,'artifacts')),options=fixtureOptions(artifacts,calls);
 const invoke=options.executor.adapter.invoke.bind(options.executor.adapter);
 options.executor.adapter={...options.executor.adapter,async invoke(request){
  const outcome=await invoke(request),p=JSON.parse(request.instruction);
  if(p.teamPlanning)return completed(JSON.stringify({steps:p.teamPlanning.steps.map((title:string)=>({role:'Read',title,dependsOn:[]}))}));
  if(p.step&&request.invocationId.includes(':step:0'))return completed(settings.output??JSON.stringify({format:'massion-step/v1',result:JSON.stringify(plan),progressNote:{summary:'Observed declared field.',caption:'Observed'}}));
  return outcome;
 }};
 const bound:RuntimeEnvironmentBinding={id:'environment-fixture',feedId:(await store.readState()).feedId,definition};
 const waiting=deferred(),release=deferred(),closed:string[]=[],recordStatuses:string[]=[],contexts:Context[]=[];
 let binds=0;
 const service={
  async bind(missionId:string,w:Awaited<ReturnType<typeof work>>,runId:string){binds++;assert.equal(missionId,'mission');assert.equal(w.runtimeRun,undefined);assert.equal(runId,'run');if(settings.bind==='throw')throw Error('Synthetic bind failure');return settings.bind==='none'?undefined:structuredClone(bound);},
  configHash(){return hash('environment-config');},
  catalog(w:Awaited<ReturnType<typeof work>>){assert.deepEqual(w.runtimeRun?.environment,bound);return {...safeCatalog,observations:w.tasks.flatMap(t=>(t.environment?.records??[]).flatMap(r=>r.kind==='observed'?[r.observation.facts]:[]))};},
  async execute(context:Context,parsed:EnvironmentWorkPlan){
   contexts.push(context);assert.deepEqual(parsed,plan);assert.equal(context.inputHash,workInputHash(await work()));assert.equal(context.dispatchId,(await work()).runtimeRun!.ownership!.dispatchId);
   const record=async(update:EnvironmentWorkUpdate,index:number,key:string)=>context.record({type:'record-environment-work',workId:context.workId,taskId:context.taskId,environment:bound.id,dispatchId:context.dispatchId,inputHash:context.inputHash,index,update},key);
   const begin={kind:'begin' as const,plan:parsed};recordStatuses.push((await record(begin,0,'env-begin')).status);recordStatuses.push((await record(begin,0,'env-begin')).status);
   const at=Date.now(),reference={id:'entry',hash:hash('action'),at,deadline:(await work()).runtimeRun!.ownership!.deadlineAt};
   await record({kind:'link',reference,waiting:!!settings.wait},0,'env-link');
   if(settings.wait){waiting.resolve();await new Promise<void>((resolve,reject)=>{release.promise.then(resolve);context.signal.addEventListener('abort',()=>reject(context.signal.reason),{once:true});});if(settings.decline){await record({kind:'stop'},0,'env-stop');throw new DomainError('Owner declined');}await record({kind:'resume',approvedAt:Date.now()},0,'env-resume');}
   await record({kind:'claim'},0,'env-claim');
   const effectId=environmentWorkEffectId(bound.id,context.taskId,0);
   await context.receipt(effectId,settings.unknown?'unknown':'succeeded',JSON.stringify({kind:'environment-delivery/v1',environment:bound.id,entryId:reference.id,requestHash:reference.hash}));
   if(settings.unknown)throw Error('Synthetic unknown delivery');
   await record({kind:'complete',result:'delivered'},0,'env-complete');
   await app.dispatch({missionId:'mission',commandId:'page',expectedRevision:(await read()).revision,actorId:'browser-read-host',command:{type:'record-browser-page',workId,sessionId:'browser',navigationId:'navigation',page:{readId:'page',expectedRevision:1,inputHash:context.inputHash,at:Date.now(),address:definition.origin,title:'Fixture',blocks:[],fields:[]}}});
   await record({kind:'observe',observation:{observationId:'observation',binding:{environment:bound.id,surface:'surface',origin:definition.origin,generation:1,revision:1},facts:{filled:true},pageReadId:'page'}},1,'env-observe');
   if(settings.crash)throw Error('Synthetic context loss');
   return 'Observed field: true';
  },
  async close(missionId:string,workId:string){closed.push(missionId+'/'+workId);},
 };
 if(settings.environment!==false)options.environment=service as unknown as EnvironmentWorkService;
 if(settings.timeout)options.runTimeoutMs=settings.timeout;
 await app.create({id:'mission',purpose:'Produce a checked answer',scope:'test',constraints:[],criteria:{version:1,description:'Answer the request',oracle:'bounded-text-review/v1'}},'local-owner','create');
 await app.dispatch({missionId:'mission',commandId:'admit',expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId,title:'Answer',budget:300,team:memberProcedures(null,'member'),assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'producer'},memberId:'member'}}});
 const runtime=new ConfiguredTextRuntime(store,options);
 const run=()=>runtime.run('mission',workId,'run',2);
 t.after(()=>{release.resolve();});
 return {store,app,options,runtime,run,read,work,calls,bound,waiting,release,closed,recordStatuses,contexts,binds:()=>binds};
}

test('configured runtime pins the environment before execution and records host commands and worker delivery before independent acceptance',async t=>{
 const f=await fixture(t),result=await f.run();assert.equal(result.status,'settled');const w=await f.work();
 assert.deepEqual(w.runtimeRun!.environment,f.bound);assert.equal(f.binds(),1);assert.deepEqual(f.recordStatuses,['committed','replayed']);
 const step=w.tasks.find(t=>t.id===workId+':step:0')!;assert.equal(step.result,'Observed field: true');assert.equal(step.environment!.cursor,2);assert.equal(step.progress!.wording!.caption,'Observed');
 assert.equal(w.effects.find(e=>e.id===environmentWorkEffectId(f.bound.id,step.id,0))!.status,'succeeded');assert.equal(w.budget.measured,7);assert.equal(w.acceptance,'accepted');
 assert.deepEqual(f.closed,['mission/'+workId]);assert.equal(f.contexts.length,1);
 const events=await f.store.readEvents(0,1000),hostCommands=events.events.flatMap(b=>b.events).filter((e:any)=>e.command?.type==='record-environment-work') as any[];
 assert.ok(hostCommands.length>0);assert.ok(hostCommands.every(e=>e.actor===ENVIRONMENT_WORK_HOST));
 const worker=f.calls.find(c=>c.id==='run:step:0')!.prompt;assert.deepEqual(worker.environment,{...safeCatalog,observations:[]});assert.deepEqual(f.calls.find(c=>c.id==='run:executor')!.prompt.environment.observations,[{filled:true}]);assert.deepEqual(f.calls.find(c=>c.id==='run:verifier')!.prompt.environment.observations,[{filled:true}]);assert.match(worker.instruction,/massion-environment\/v1/);assert.ok(!JSON.stringify(worker).includes('#field'));
 assert.deepEqual(f.calls.find(c=>c.id==='run:step:1')!.prompt.environment.observations,[{filled:true}]);
});

test('bound independent workers wait for the original environment session without renewing ownership or monthly reservation',async t=>{
 const f=await fixture(t,{wait:true}),running=f.run();await Promise.race([f.waiting.promise,running.then(()=>assert.fail('Environment wait was never reached'))]);
 const before=await f.work(),monthly=new MonthlyBudgetService(f.store),reservation=(await monthly.snapshot()).budget!.value.reservations[0]!;
 assert.equal(before.execution,'waiting');assert.equal(f.calls.length,2);assert.equal(reservation.state,'reserved');assert.equal(f.runtime.owns('mission',workId,'run'),true);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.calls.length,2);f.release.resolve();assert.equal((await running).status,'settled');
 const after=await f.work();assert.deepEqual(after.runtimeRun!.ownership,before.runtimeRun!.ownership);assert.equal(after.runtimeRun!.resumptions,undefined);assert.equal(after.budget.reserved,70);
 const retained=(await monthly.snapshot()).budget!.value.reservations[0]!;const {state,usage,...retainedBinding}=retained;assert.deepEqual({...retainedBinding,state:reservation.state},reservation);
});

for(const wrapped of [false,true])test('invalid '+(wrapped?'wrapped':'direct')+' environment payload is discarded before any durable output',async t=>{
 const secret='SYNTHETIC-DO-NOT-PERSIST',bad=JSON.stringify({format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',value:secret}},{kind:'observe',facts:['filled']}]}),output=wrapped?JSON.stringify({format:'massion-step/v1',result:bad,progressNote:{summary:'Reading'}}):bad;
 const f=await fixture(t,{output}),result=await f.run();assert.equal(result.status,'blocked');assert.equal(f.contexts.length,0);assert.equal((await f.work()).artifact,undefined);
 assert.ok(!JSON.stringify(await f.read()).includes(secret));assert.ok(!JSON.stringify(await f.store.readEvents(0,1000)).includes(secret));assert.equal((await f.work()).effects.find(e=>e.id==='run:step:0')!.status,'failed');assert.deepEqual(f.closed,['mission/'+workId]);
});

test('unknown environment delivery retains uncertainty and prevents another model call or restart',async t=>{
 const f=await fixture(t,{unknown:true});await assert.rejects(f.run(),/Run admission committed/);const before=await f.work();
 assert.equal(before.effects.find(e=>e.id===environmentWorkEffectId(f.bound.id,workId+':step:0',0))!.status,'unknown');assert.equal(before.budget.measured,2);assert.equal(f.calls.length,2);assert.deepEqual(f.closed,['mission/'+workId]);
 assert.equal((await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)).status,'blocked');assert.equal(f.calls.length,2);
});

test('a begun environment step refuses restart even after every effect succeeded',async t=>{
 const f=await fixture(t,{crash:true});await assert.rejects(f.run(),/Run admission committed/);const w=await f.work();assert.ok(w.effects.every(e=>e.status==='succeeded'));assert.ok(w.tasks.some(t=>t.environment));
 assert.equal(canResume(w,Date.now()),false);assert.equal((await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)).status,'blocked');assert.equal(f.calls.length,2);assert.deepEqual(f.closed,['mission/'+workId]);
});

for(const boundary of ['cancel','drain','deadline'] as const)test('environment wait observes '+boundary+' and closes without later worker calls',async t=>{
 const f=await fixture(t,{wait:true,...(boundary==='deadline'?{timeout:150}:{})}),running=f.run();await Promise.race([f.waiting.promise,running.then(()=>assert.fail('Environment wait was never reached'))]);
 if(boundary==='cancel'){await f.app.dispatch({missionId:'mission',commandId:'cancel',expectedRevision:(await f.read()).revision,actorId:'local-owner',command:{type:'cancel',workId}});f.runtime.interrupt('mission',workId);}
 if(boundary==='drain')f.runtime.beginDrain();
 const result=await running;assert.equal(result.status,boundary==='cancel'?'cancelled':'blocked');assert.equal(f.contexts[0]!.signal.aborted,true);assert.equal(f.calls.length,2);assert.deepEqual(f.closed,['mission/'+workId]);
 if(boundary!=='cancel')assert.equal((await f.work()).runtimeInterruption!.reason,boundary==='drain'?'host-shutdown':'deadline');
});

test('environment host identity is reserved for both configured model roles',async t=>{
 const f=await fixture(t);for(const role of ['executor','verifier'] as const)assert.throws(()=>new ConfiguredTextRuntime(f.store,{...f.options,[role]:{...f.options[role],identity:ENVIRONMENT_WORK_HOST}}),/reserved/);
});

test('optional environment configuration preserves the legacy continuation fingerprint exactly',async t=>{
 const f=await fixture(t,{environment:false,output:'Worker evidence'});assert.equal((await f.run()).status,'settled');const o=f.options;
 assert.equal((await f.work()).runtimeRun!.continuationConfig,hash({authorization:o.authorization,executor:{identity:o.executor.identity,model:o.executor.adapter.descriptor},verifier:{identity:o.verifier.identity,model:o.verifier.adapter.descriptor},outputTokenCap:o.outputTokenCap,connectionBindings:null}));assert.equal(f.binds(),0);assert.deepEqual(f.closed,[]);
});


test('an unbound Work remains a text procedure and still closes optional environment resources',async t=>{
 const f=await fixture(t,{bind:'none',output:'Worker evidence'});assert.equal((await f.run()).status,'settled');assert.equal((await f.work()).runtimeRun!.environment,undefined);assert.equal(f.contexts.length,0);assert.deepEqual(f.closed,['mission/'+workId]);
 assert.ok(f.calls.every(c=>c.prompt.environment===undefined));
});

test('binding failure closes optional resources before activation and sends no model request',async t=>{
 const f=await fixture(t,{bind:'throw'});await assert.rejects(f.run(),/Synthetic bind failure/);assert.equal((await f.work()).runtimeRun,undefined);assert.equal(f.calls.length,0);assert.deepEqual(f.closed,['mission/'+workId]);
});

for(const bound of [false,true])test('recognized plans cannot be stored as final artifacts '+(bound?'outside a worker':'without a binding'),async t=>{
 const secret='SYNTHETIC-FINAL-DO-NOT-PERSIST',bad=JSON.stringify({format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',value:secret}},{kind:'observe',facts:['filled']}]}),f=await fixture(t,{environment:bound,output:'Worker evidence'});
 const invoke=f.options.executor.adapter.invoke.bind(f.options.executor.adapter),adapter={...f.options.executor.adapter,async invoke(request:Parameters<typeof invoke>[0]){if(request.invocationId==='run:executor'){f.calls.push({id:request.invocationId,prompt:JSON.parse(request.instruction)});return completed(bad);}return invoke(request);}};
 const runtime=new ConfiguredTextRuntime(f.store,{...f.options,executor:{...f.options.executor,adapter}});assert.equal((await runtime.run('mission',workId,'run',2)).status,'blocked');assert.equal((await f.work()).artifact,undefined);assert.ok(!JSON.stringify(await f.store.readEvents(0,1000)).includes(secret));
});
test('the normal empty environment service preserves legacy text continuation bindings',async t=>{
 const f=await fixture(t,{environment:false,output:'Worker evidence'}),{EnvironmentWorkService}=await import('../src/environment-work-service.ts'),{SecretRequestsService}=await import('../src/secret-requests-service.ts'),{InMemorySecretSlots}=await import('../src/secret-slots.ts');
 const environment=new EnvironmentWorkService(f.store,f.store,{definitions:[],secrets:new SecretRequestsService(f.store,new InMemorySecretSlots()),intake:()=> 'mission'}),runtime=new ConfiguredTextRuntime(f.store,{...f.options,environment});assert.equal((await runtime.run('mission',workId,'run',2)).status,'settled');const o=f.options;
 assert.equal((await f.work()).runtimeRun!.continuationConfig,hash({authorization:o.authorization,executor:{identity:o.executor.identity,model:o.executor.adapter.descriptor},verifier:{identity:o.verifier.identity,model:o.verifier.adapter.descriptor},outputTokenCap:o.outputTokenCap,connectionBindings:null}));
});

test('a recorded owner refusal returns a blocked result without unresolved runtime bookkeeping',async t=>{
 const f=await fixture(t,{wait:true,decline:true}),running=f.run();await f.waiting.promise;f.release.resolve();assert.equal((await running).status,'blocked');assert.equal(f.calls.length,2);assert.equal((await f.work()).effects.some(e=>e.status==='pending'||e.status==='unknown'),false);assert.deepEqual(f.closed,['mission/'+workId]);
});
