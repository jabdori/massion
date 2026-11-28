import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {createInterface} from 'node:readline';
import {duplexPair} from 'node:stream';
import type {Socket} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {CommitOutcomeUnknownError,InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {DomainError,hash} from '../src/domain.ts';
import type {Actor,Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createWorkbench} from '../src/server.ts';
import {SCHEDULES_ID,SchedulesService,applySchedules,replaySchedules,nextSlot,scheduleWorkProducer} from '../src/schedules.ts';
import type {SchedulesCommand,SchedulesState} from '../src/schedules.ts';
import {copy} from '../src/ui-copy.ts';
import {createClientService} from '../desktop/client-relay.ts';
import {authenticatedFetch} from '../desktop/auth.ts';
import {ConfiguredTextRuntime} from '../src/configured-runtime.ts';
import type {WorkRuntime} from '../src/configured-runtime.ts';
import {SelectableTextRuntime} from '../src/selectable-runtime.ts';
import {ConnectionCatalog} from '../src/provider-profiles.ts';
import type {ModelConnectionProfile} from '../src/provider-profiles.ts';
import {chatProfileFactory} from '../src/chat-profile-factory.ts';
import {fixtureOptions} from './support/steering-resume-fixture.ts';
import type {BrowserAdapter} from '../src/browser-runtime.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../src/members.ts';
import {ASSISTANT_ACTOR_ID,assistantTurnId,assistantWorkId,ownerMessageId,segmentId} from '../src/assistant-conversation.ts';

// docs/architecture/results-and-schedules.md: one morning briefing schedule, run by the host scheduler under a cumulative budget; unknown is never resent. Fixture-class only, no model call for the briefing.
const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]});
const turn=(reply:string,title?:string)=>JSON.stringify({reply,work:title===undefined?null:{title}});
const owner={id:'local-owner',roles:['owner' as const]},host={id:'assistant-representative',roles:['assistant' as const]};
const DAY=86400000,T0=Date.UTC(2026,10,5,23,0);// 08:00 on Nov 6 in UTC+9 is 23:00 UTC on Nov 5.

async function setup(t:test.TestContext,answer?:string,beforeExecutor?:()=>Promise<void|'length'>,beforeAnswer?:()=>Promise<void>){
 const root=await mkdtemp(join(tempRoot(),'massion-schedules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore(join(root,'artifacts')),script:string[]=[];let calls=0;const start=Date.now();let now=start;const clock=()=>now;
 const completion=(model:string,content:string,finishReason='stop')=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:finishReason,message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{calls++;
  const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);
  if(Object.hasOwn(prompt,'currentMessage')){if(beforeAnswer)await beforeAnswer();return completion(body.model,script.shift()??turn('Hello.'));}
  if(prompt.artifact)return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:answer?answer.split('\n')[0]!:'Answer bounded',reason:'Controlled fixture'}]}));
  const finishReason=body.model==='executor'?await beforeExecutor?.():undefined;
  return completion(body.model,answer??'- Answer bounded fixture text\n- Second point',finishReason??'stop');
 };
 const settings=new InMemoryHostSettings();
 const m=createHostConnections(store,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings});
 const profile=(model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 const product=new ProductService(store,undefined,m,artifacts);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},'create-intake');
 await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));
 const assistant=new AssistantService(store,product,m,{clock});
 await assistant.setSettings({profileId:profile('representative'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:m.list().configHash});
 let failRead=false;const schedules=new SchedulesService(store,async()=>{if(failRead)throw new Error('read failed');return assistant.read();},clock);
 const say=async(text:string,title?:string)=>{script.push(turn('On it.',title));const view=await assistant.read();const target=!view.segment?{segment:1,expectedRevision:0}:{segment:view.head,expectedRevision:view.segment.revision};const r=await assistant.send({commandId:randomUUID(),...target,text});await assistant.idle();return r;};
 return {root,store,artifacts,m,settings,transport,product,assistant,schedules,say,queueWork:(title:string)=>script.push(turn('On it.',title)),start,now:()=>now,setNow:(v:number)=>{now=v;},failRead:(v:boolean)=>{failRead=v;},calls:()=>calls};
}
const apply=(state:SchedulesState|null,command:SchedulesCommand,actor:Actor=owner,at=T0)=>applySchedules(state,command,actor,{observedAt:at}).value;
const create=(over:Record<string,unknown>={}):SchedulesCommand=>({type:'create-schedule',scheduleId:'schedule-a',kind:'briefing',minute:480,offset:540,budget:{runs:2},...over} as SchedulesCommand);

async function workHost(t:test.TestContext,f:Awaited<ReturnType<typeof setup>>,options:{store?:Store<Mission>;browserAdapter?:BrowserAdapter;authenticated?:boolean;runtime?:WorkRuntime}={}){
 const secret='a'.repeat(64),server=createWorkbench(options.store??f.store,f.root,{...(options.runtime?{runtime:options.runtime}:{connections:f.m}),artifacts:f.artifacts,scheduleIntervalMs:0,browserAdapter:options.browserAdapter,daemonSecret:options.authenticated===false?undefined:secret});
 const listening=once(server,'listening',{signal:t.signal});server.listen(0,'127.0.0.1');await listening;
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(()=>{server.close();server.closeAllConnections();});
 const relay=createClientService({origin:base,secret,htmlCandidates:[],settingsFile:join(f.root,'notifications.json'),version:'fixture',stopCore:async()=>{},startCore(){},requestTimeoutMs:4000});
 t.after(()=>relay.close());
 const relayRequest=async(message:Record<string,unknown>)=>{
  const [client,socket]=duplexPair(),reader=createInterface({input:client});relay.handle(socket as unknown as Socket);
  try{
   const reply=once(reader,'line',{signal:AbortSignal.any([t.signal,AbortSignal.timeout(4500)])});
   client.write(JSON.stringify({id:randomUUID(),...message})+'\n');
   return JSON.parse((await reply)[0]);
  }finally{reader.close();client.end();}
 };
 const request=async(path:string,payload?:unknown)=>{
  const reply=await relayRequest({method:'POST',path:'/protocol/request',body:JSON.stringify({version:1,requestId:randomUUID(),generation:0,kind:payload===undefined?'query':'command',path,payload})});
  const envelope=JSON.parse(reply.body);return {status:envelope.status,body:envelope.payload};
 };
 const count=async()=>{const reply=await relayRequest({method:'GET',path:'/host/work-count',origin:'host'});assert.equal(reply.status,200,JSON.stringify(reply.error??reply.body));const body=JSON.parse(reply.body);assert.deepEqual(Object.keys(body),['count']);assert.ok(Number.isSafeInteger(body.count)&&body.count>=0);return body.count;};
 const direct=(path:string,init:RequestInit={})=>authenticatedFetch(new URL(path,base),{...init,signal:AbortSignal.any([t.signal,AbortSignal.timeout(4000),...(init.signal?[init.signal]:[])])},secret);
 return {server,base,request,relayRequest,count,direct};
}

function holdStage(t:test.TestContext){
 const gate=new EventEmitter();let opened=false;
 const entered=once(gate,'entered',{signal:t.signal});void entered.catch(()=>{});
 return {entered,open(){opened=true;gate.emit('open');},async wait(){if(opened)return;const proceed=once(gate,'open',{signal:t.signal});gate.emit('entered');await proceed;}};
}

test('host count stays at one through the answer-to-Work handover',{timeout:10000},async t=>{
 const answer=holdStage(t),handover=holdStage(t),settingsRead=holdStage(t),starting=holdStage(t),finalRead=holdStage(t),execution=holdStage(t),f=await setup(t,undefined,execution.wait,answer.wait);
 let outcomeWritten=false;
 const store=new Proxy(f.store,{get(target,key){
  if(key==='commit')return async(input:Parameters<typeof target.commit>[0])=>{if(!input.commandId.startsWith('assistant-outcome:'))return target.commit(input);await handover.wait();const result=await target.commit(input);outcomeWritten=true;return result;};
  if(key==='load')return async(id:string)=>{if(outcomeWritten&&id===segmentId(1))await finalRead.wait();return target.load(id);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const commit=f.store.commit.bind(f.store);
 const loadSettings=f.settings.load.bind(f.settings);
 t.mock.method(f.settings,'load',async(scope:string)=>{if(outcomeWritten)await settingsRead.wait();return loadSettings(scope);});
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.commandId.startsWith('monthly-reserve:'))await starting.wait();
  return commit(input);
 });
 const host=await workHost(t,f,{store});
 assert.equal(await host.count(),0,'idle');
 f.queueWork('Held Work');
 const send=host.request('/assistant/messages',{commandId:'count-turn',segment:1,expectedRevision:0,text:'Sort my receipts'});
 void send.catch(()=>{});
 try{
  await Promise.race([answer.entered,send.then(()=>assert.fail('Send completed before the answer'))]);
  assert.equal(await host.count(),1,'answering turn');answer.open();
  await Promise.race([handover.entered,send.then(()=>assert.fail('Send completed before the handover'))]);
  assert.equal(await host.count(),1,'settled answer before Work dispatch');handover.open();
  await Promise.race([Promise.all([finalRead.entered,settingsRead.entered]),send.then(()=>assert.fail('Send completed before the settings read was held'))]);
  finalRead.open();
  assert.equal((await send).body.turn.outcome.run.status,'requested');
  assert.equal(await host.count(),1,'the answer returned while the Work is still waiting on settings');
  settingsRead.open();await starting.entered;
  assert.equal(await host.count(),1,'overlapping turn and occupied slot count once');
  starting.open();
  await execution.entered;
  assert.equal(await host.count(),1,'running Work after the handover');
 }finally{answer.open();handover.open();settingsRead.open();finalRead.open();starting.open();execution.open();}
 assert.deepEqual(await host.server.drain(),{status:'drained',timedOut:false});
});

test('host count includes independent browser reads and clears the slot on successful Work',{timeout:10000},async t=>{
 const reservation=holdStage(t),execution=holdStage(t),initialRead=holdStage(t),browser=holdStage(t),overlap=holdStage(t),replay=holdStage(t),cleanup=holdStage(t),answer=holdStage(t),f=await setup(t,undefined,execution.wait,answer.wait),address='https://example.com/';
 let browserGate=browser;
 const commandId='same-prospective-work-id',workId=assistantWorkId(assistantTurnId(ownerMessageId(commandId)));
 const host=await workHost(t,f,{browserAdapter:{async read(){await browserGate.wait();return {address,title:'Fixture',blocks:[],fields:[]};}}});
 const add=(workId:string,expectedRevision:number)=>f.product.admit('intake',{commandId:'admit-'+workId,expectedRevision,workId,title:workId,budget:8});
 const read=await add('browser-work',1),work=await add(workId,read.revision);
 const readState=f.store.readState.bind(f.store);let firstRead=true;
 t.mock.method(f.store,'readState',async(id?:string)=>{if(firstRead&&id==='intake'){firstRead=false;await initialRead.wait();}return readState(id);});
 const input={missionId:'intake',workId:'browser-work',readId:'independent',address};
 const capture=host.server.browserSessions.capture(input);
 void capture.catch(()=>{});
 try{
  await Promise.race([initialRead.entered,capture.then(()=>assert.fail('Read completed before its initial lookup was held'))]);
  assert.equal(await host.count(),1,'independent browser read during its initial lookup');initialRead.open();
  await Promise.race([browser.entered,capture.then(()=>assert.fail('Read completed before its adapter was held'))]);
  assert.equal(await host.count(),1,'independent browser read');
 }finally{initialRead.open();browser.open();}
 const captured=await capture;assert.equal(captured.status,'committed');assert.ok(captured.revision>work.revision);
 assert.equal(await host.count(),0,'completed browser read');
 const lookup=f.store.lookupOperation.bind(f.store);
 t.mock.method(f.store,'lookupOperation',async(operation:Parameters<typeof lookup>[0])=>{
  if(operation.commandId.startsWith('assistant-browser:'))await replay.wait();
  return lookup(operation);
 });
 const replayed=host.server.browserSessions.capture(input);void replayed.catch(()=>{});
 try{
  await Promise.race([replay.entered,replayed.then(()=>assert.fail('Stored read replay was not held'))]);
  assert.equal(await host.count(),0,'stored read replay');
 }finally{replay.open();}
 assert.equal((await replayed).status,'replayed');
 const commit=f.store.commit.bind(f.store);
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.commandId.startsWith('monthly-reserve:'))await reservation.wait();
  return commit(input);
 });
 const run=host.request('/missions/intake/run',{commandId:'count-work',expectedRevision:captured.revision,workId});
 void run.catch(()=>{});
 try{
  await Promise.race([reservation.entered,run.then(()=>assert.fail('Run completed before budget reservation'))]);
  assert.equal(await host.count(),1,'standalone Work before its budget reservation commits');reservation.open();
  await Promise.race([execution.entered,run.then(()=>assert.fail('Run completed before its executor was held'))]);
  assert.equal(await host.count(),1,'standalone running Work');
  browserGate=overlap;
  const concurrentRead=host.server.browserSessions.capture({...input,readId:'concurrent'});void concurrentRead.catch(()=>{});
  await Promise.race([overlap.entered,concurrentRead.then(()=>assert.fail('Concurrent read completed before its adapter was held'))]);
  assert.equal(await host.count(),2,'independent browser read adds to an occupied slot');
  overlap.open();assert.equal((await concurrentRead).status,'committed');
  const send=host.request('/assistant/messages',{commandId,segment:1,expectedRevision:0,text:'Hello'});
  void send.catch(()=>{});
  await Promise.race([answer.entered,send.then(()=>assert.fail('Send completed before its answer was held'))]);
  assert.equal(await host.count(),2,'unrelated Work and turn with matching prospective IDs');
  answer.open();assert.equal((await send).body.turn.status,'answered');
 }finally{reservation.open();overlap.open();answer.open();execution.open();}
 assert.equal((await run).body.status,'settled');assert.equal(await host.count(),0,'completed Work');
 browserGate=cleanup;
 const interrupted=host.server.browserSessions.capture({missionId:'intake',workId:'browser-work',readId:'interrupted',address});
 void interrupted.catch(()=>{});
 try{
  await cleanup.entered;host.server.browserSessions.beginDrain();await assert.rejects(interrupted);
  assert.equal(await host.count(),1,'browser adapter cleanup still in progress');
 }finally{cleanup.open();}
 await host.server.browserSessions.drain();assert.equal(await host.count(),0,'browser adapter cleanup finished');
});

test('only the host origin can ask the relay for the work count',{timeout:10000},async t=>{
 const f=await setup(t),host=await workHost(t,f),unauthenticated=await workHost(t,f,{authenticated:false});
 const countCalls:string[]=[];
 host.server.prependListener('request',(req)=>{if(req.url==='/host/work-count')countCalls.push(req.url);});
 const request={method:'GET',path:'/host/work-count'};
 for(const origin of [undefined,'page','massion://app']){
  const rejected=await host.relayRequest({...request,origin});
  assert.equal(rejected.error?.code,'path','page request refused by the relay');
 }
 assert.equal((await host.relayRequest({...request,origin:'host',method:'POST'})).error?.code,'method');
 assert.equal((await host.relayRequest({...request,origin:'host',body:'{}'})).error?.code,'method');
 assert.equal((await host.relayRequest({...request,origin:'host',path:request.path+'?x=1'})).error?.code,'path');
 const nested=await host.relayRequest({method:'POST',path:'/protocol/request',origin:'host',body:JSON.stringify({version:1,requestId:'page',generation:0,kind:'query',path:request.path,origin:'host'})});
 assert.equal(nested.status,403,'page protocol envelope refused by the core');
 assert.deepEqual(JSON.parse(nested.body).payload,{});
 assert.deepEqual(countCalls,[],'page requests never reach the direct core route');
 assert.equal((await unauthenticated.relayRequest({...request,origin:'host'})).error?.code,'upstream');
 const direct=await fetch(unauthenticated.base+request.path,{headers:{'X-Massion-Request-Origin':'host'},signal:AbortSignal.any([t.signal,AbortSignal.timeout(4000)])});
 assert.equal(direct.status,403,'the core refuses the host marker without configured authentication');
 assert.deepEqual(await direct.json(),{});
 const withoutOrigin=await host.direct(request.path);
 assert.equal(withoutOrigin.status,403,'the authenticated core requires the host origin marker');
 assert.deepEqual(await withoutOrigin.json(),{});
 assert.equal(await host.count(),0);
 assert.equal(countCalls.length,2);
});

for(const kind of ['connection workbench','injected configured runtime','injected selectable runtime'])test(`the built-in fixture and regular Work share the ${kind} slot`,{timeout:10000},async t=>{
 let fixtureDone=false;
 const fixture=holdStage(t),execution=holdStage(t),f=await setup(t,undefined,async()=>{if(fixtureDone)await execution.wait();}),commit=f.store.commit.bind(f.store);
 const workId='fixture-contention',work=await f.product.admit('intake',{commandId:'admit-'+workId,expectedRevision:1,workId,title:'Regular Work',budget:8});
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.id.startsWith('growth-'))await fixture.wait();
  return commit(input);
 });
 let runtime:WorkRuntime|undefined,selection;
 if(kind==='injected configured runtime'){
  const config=fixtureOptions(f.artifacts,[],async(_request,prompt)=>{if(!prompt.artifact&&fixtureDone)await execution.wait();});
  runtime=new ConfiguredTextRuntime(f.store,{...config,outputTokenCap:4,authorization:{...config.authorization!,scope:'local'}});
 }else if(kind==='injected selectable runtime'){
  const {connections,authorizations}=f.m.configuration();
  const profiles=connections.map(({configHash,diagnostics,...profile})=>profile as ModelConnectionProfile);
  const catalog=new ConnectionCatalog(profiles,[chatProfileFactory({mode:'local-http-mock',transport:f.transport})]);
  runtime=new SelectableTextRuntime(f.store,catalog,authorizations,f.artifacts);
  const choice=f.m.resolveDefault((await f.store.load('intake'))!.value);assert.equal(choice.status,'resolved');selection=choice.choice;
 }
 const host=await workHost(t,f,{runtime}),run=host.request('/fixture-run',{});
 const regularWork={expectedRevision:work.revision,workId,selection};
 void run.catch(()=>{});
 try{
  await Promise.race([fixture.entered,run.then(()=>assert.fail('Fixture completed before its first write'))]);
  assert.equal(await host.count(),1,'running fixture');
  const duplicate=await host.request('/fixture-run',{});
  assert.equal(duplicate.status,409);
  assert.equal(duplicate.body.error,'A fixture is already running; observe its state before starting another');
  const refused=await host.request('/missions/intake/run',{commandId:'during-fixture',...regularWork});
  assert.ok(refused.body.diagnostics?.some((d:{code:string})=>d.code==='host_busy'),'regular Work sees the fixture in the slot');
 }finally{fixture.open();await Promise.allSettled([run]);}
 const response=await run;assert.equal(response.status,201);assert.equal(response.body.evidenceClass,'fixture');
 assert.equal(await host.count(),0,'completed fixture');
 fixtureDone=true;
 const regular=host.request('/missions/intake/run',{commandId:'after-fixture',...regularWork});void regular.catch(()=>{});
 try{
  await Promise.race([execution.entered,regular.then(()=>assert.fail('Regular Work completed before its executor was held'))]);
  assert.equal((await host.request('/fixture-run',{})).status,409,'the fixture sees regular Work in the slot');
 }finally{execution.open();await Promise.allSettled([regular]);}
 assert.equal((await regular).body.status,'settled');
});

test('connection drain waits for a fixture after its requesting socket closes',{timeout:10000},async t=>{
 const fixture=holdStage(t),f=await setup(t),commit=f.store.commit.bind(f.store),host=await workHost(t,f);
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.id.startsWith('growth-'))await fixture.wait();
  return commit(input);
 });
 const controller=new AbortController();let disconnected:Promise<unknown>|undefined;
 host.server.prependListener('request',req=>{if(req.url==='/fixture-run'){disconnected=once(req.socket,'close',{signal:t.signal});void disconnected.catch(()=>{});}});
 const request=host.direct('/fixture-run',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:controller.signal});void request.catch(()=>{});
 try{
  await Promise.race([fixture.entered,request.then(()=>assert.fail('Fixture finished before the socket closed'))]);
  controller.abort();await assert.rejects(request);assert.ok(disconnected);await disconnected;
  let settled=false;const drain=f.m.drain().finally(()=>{settled=true;});void drain.catch(()=>{});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'connection drain still waits for the fixture write');
  fixture.open();await drain;
  assert.equal(await host.count(),0,'fixture completed during drain');
 }finally{controller.abort();fixture.open();}
});

for(const activation of ['unknown','refused','readback-lost'] as const)test(`the run slot stays held through ${activation} activation readback`,{timeout:10000},async t=>{
 const readback=holdStage(t),f=await setup(t),commit=f.store.commit.bind(f.store),load=f.store.load.bind(f.store);
 const commandId='count-activation-'+activation,workId='activation-work';
 const work=await f.product.admit('intake',{commandId:'admit-'+workId,expectedRevision:1,workId,title:'Check activation ownership',budget:8});
 let lostOrRefused=false,readUnavailable=activation==='readback-lost',differentFeed=false;
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.commandId!==commandId)return commit(input);
  const result=await commit(activation==='refused'?{...input,expectedRevision:input.expectedRevision-1}:input);
  assert.equal(result.status,activation==='refused'?'conflict':'committed');
  lostOrRefused=true;
  if(activation!=='refused')throw new CommitOutcomeUnknownError(input);
  return result;
 });
 t.mock.method(f.store,'load',async(id:string)=>{
  if(lostOrRefused&&id==='intake'){
   await readback.wait();
   if(readUnavailable)throw new Error('Injected ownership read outage');
  }
  return load(id);
 });
 const readState=f.store.readState.bind(f.store);
 t.mock.method(f.store,'readState',async(id?:string)=>{
  if(lostOrRefused&&id==='intake'&&activation!=='refused'){
   await readback.wait();
   if(readUnavailable)throw new Error('Injected ownership read outage');
   if(differentFeed)return {...await readState(id),feedId:'different-feed'};
  }
  return readState(id);
 });
 const host=await workHost(t,f);
 const run=host.request('/missions/intake/run',{commandId,expectedRevision:work.revision,workId});void run.catch(()=>{});
 try{
  await Promise.race([readback.entered,run.then(()=>assert.fail('Run completed before activation readback'))]);
  assert.equal(await host.count(),1,'slot held during '+activation+' activation readback');
  assert.equal(f.calls(),0,'no provider invocation before ownership readback');
 }finally{readback.open();}
 const outcome=await run;
 if(activation==='unknown'){
  assert.equal(outcome.status,503);
  assert.equal(outcome.body.outcome,'admitted-unsettled');
  assert.equal(outcome.body.snapshot.value.works[0].runtimeRun.id,commandId);
 }else if(activation==='readback-lost'){
  assert.equal(outcome.status,503);
  assert.equal(outcome.body.outcome,'unknown');
  assert.equal(await host.count(),1,'failed readback leaves the slot occupied after cleanup');
  assert.equal((await host.request('/fixture-run',{})).status,409,'unconfirmed ownership still occupies the slot');
  readUnavailable=false;differentFeed=true;
  assert.equal(await host.count(),1,'a different feed cannot confirm the original activation');
  differentFeed=false;
 }else assert.equal(outcome.body.status,'conflict');
 assert.equal(await host.count(),0,'slot cleared after '+activation+' activation');
 assert.equal(f.calls(),0,'readback never dispatches the provider');
});

test('a competing message does not count before its write or during conflict replay',{timeout:10000},async t=>{
 const pendingWrite=holdStage(t),replayRead=holdStage(t),answer=holdStage(t),f=await setup(t,undefined,undefined,answer.wait),host=await workHost(t,f);
 const commit=f.store.commit.bind(f.store),load=f.store.load.bind(f.store);let replaying=false;
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  if(input.commandId!=='losing-turn')return commit(input);
  await pendingWrite.wait();const result=await commit(input);assert.equal(result.status,'conflict');replaying=true;return result;
 });
 t.mock.method(f.store,'load',async(id:string)=>{if(replaying&&id===segmentId(1))await replayRead.wait();return load(id);});
 const send=(commandId:string)=>host.request('/assistant/messages',{commandId,segment:1,expectedRevision:0,text:commandId});
 const loser=send('losing-turn');void loser.catch(()=>{});let winner:ReturnType<typeof send>|undefined;
 try{
  await Promise.race([pendingWrite.entered,loser.then(()=>assert.fail('Competing message did not reach its held write'))]);
  assert.equal(await host.count(),0,'a write awaiting acceptance does not count');
  winner=send('winning-turn');void winner.catch(()=>{});
  await Promise.race([answer.entered,winner.then(()=>assert.fail('Winning message did not reach its held answer'))]);
  pendingWrite.open();
  await Promise.race([replayRead.entered,loser.then(()=>assert.fail('Conflict replay was not held'))]);
  assert.equal(await host.count(),1,'the definite conflict is excluded during replay lookup');
  replayRead.open();assert.equal((await loser).status,409);
  answer.open();assert.equal((await winner).body.turn.status,'answered');
  assert.equal(f.calls(),1);
 }finally{pendingWrite.open();replayRead.open();answer.open();await Promise.allSettled([loser,winner]);}
});

for(const end of ['failure','cancellation','exception'] as const)test(`the run slot clears after ${end}`,{timeout:10000},async t=>{
 const held=holdStage(t),f=await setup(t,undefined,async()=>{await held.wait();if(end==='failure')return 'length';});
 const workId='terminal-work',work=await f.product.admit('intake',{commandId:'admit-'+workId,expectedRevision:1,workId,title:'Check terminal run',budget:8});
 if(end==='exception'){
  const commit=f.store.commit.bind(f.store);
  t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
   if(input.commandId.startsWith('monthly-reserve:')){await held.wait();throw new Error('Injected reservation exception');}
   return commit(input);
  });
 }
 const host=await workHost(t,f),run=host.request('/missions/intake/run',{commandId:'count-'+end,expectedRevision:work.revision,workId});void run.catch(()=>{});
 try{
  await Promise.race([held.entered,run.then(()=>assert.fail('Run completed before its terminal condition'))]);
  assert.equal(await host.count(),1,'slot held before '+end);
  if(end==='cancellation'){
   const current=(await f.store.load('intake'))!;
   const cancelled=await host.request('/missions/intake/commands',{commandId:'cancel-count-work',expectedRevision:current.revision,command:{type:'cancel',workId}});
   assert.equal(cancelled.body.status,'committed');
  }
 }finally{held.open();}
 const outcome=await run;
 if(end==='exception')assert.equal(outcome.status,500);
 if(end==='failure'){
  assert.equal(outcome.body.status,'blocked');
  assert.equal(outcome.body.snapshot.value.works[0].effects[0].status,'failed');
 }
 if(end==='cancellation')assert.equal(outcome.body.status,'cancelled');
 assert.equal(await host.count(),0,'slot cleared after '+end);
});

test('a member turn counts only once the answer is pending',{timeout:10000},async t=>{
 const used=holdStage(t),answer=holdStage(t),f=await setup(t,undefined,undefined,answer.wait),host=await workHost(t,f),members=new MembersService(f.store,()=>'intake');
 const proposalId=PROPOSAL_PREFIX+'count',decisionId=proposalDecisionId(proposalId),proposer:Actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']};
 const command={type:'propose-member' as const,decisionId,topic:'Analysis',works:[{title:'First'},{title:'Second'}],count:2};
 const proposed=applyMembers(null,command,proposer,{observedAt:Date.now()});
 await f.store.commit({id:MEMBERS_ID,expectedRevision:0,commandId:proposalId,fingerprint:hash({actorId:proposer.id,command}),...proposed,outbox:[]});
 await members.decide({commandId:'count-member',decisionId,answer:'act',member:{name:'River',shape:'drop'}});
 const member=admittedMemberId('count-member'),commit=f.store.commit.bind(f.store);
 assert.equal((await members.member(member))!.admissionOpen,true);
 t.mock.method(f.store,'commit',async(input:Parameters<typeof commit>[0])=>{
  const result=await commit(input);
  if(input.commandId==='assistant-member-use:'+member)await used.wait();
  return result;
 });
 const send=host.request('/assistant/messages',{member,commandId:'count-member-use',segment:1,expectedRevision:0,text:'Hello'});void send.catch(()=>{});
 try{
  await Promise.race([used.entered,send.then(()=>assert.fail('Member use was not held'))]);
  assert.equal(await host.count(),0,'member-use bookkeeping before an answer is pending');used.open();
  await Promise.race([answer.entered,send.then(()=>assert.fail('Member answer was not held'))]);
  assert.equal(await host.count(),1,'answering member turn');
 }finally{used.open();answer.open();}
 const answered=await send;assert.equal(answered.status,200);assert.equal(answered.body.turn.status,'answered');
 assert.equal(f.calls(),1);assert.equal(await host.count(),0);
});

test('slots: the next owner-local minute strictly after now, in the owner offset',()=>{
 assert.equal(nextSlot(480,540,T0-1),T0);assert.equal(nextSlot(480,540,T0),T0+DAY);assert.equal(nextSlot(0,0,Date.UTC(2026,0,1,12)),Date.UTC(2026,0,2));
});

test('schedules reducer: the owner creates one briefing with a cumulative budget; host steps start, finish and skip; owners pause, resume and close',()=>{
 for(const bad of [{budget:{runs:0}},{budget:{runs:367}},{budget:undefined},{minute:1440},{offset:900},{kind:'weekly'}])assert.throws(()=>apply(null,create(bad)),DomainError,JSON.stringify(bad));
 assert.throws(()=>apply(null,create(),host),/role/i,'no autonomy: only the owner creates a schedule');
 let s=apply(null,create(),owner,T0-3600000);assert.equal(s.id,SCHEDULES_ID);assert.deepEqual([s.schedules[0]!.active,s.schedules[0]!.nextAt,s.schedules[0]!.used],[true,T0,0]);
 assert.throws(()=>apply(s,create({scheduleId:'schedule-b'})),/one/,'only one schedule');
 const start=(runId:string,slot:number,manual=false):SchedulesCommand=>manual?{type:'start-run',scheduleId:'schedule-a',runId,manual}:{type:'start-run',scheduleId:'schedule-a',runId,slot,manual};
 assert.throws(()=>apply(s,start('run-1',T0),owner,T0),/role/i);assert.throws(()=>apply(s,start('run-1',T0),host,T0-1),/due/,'not before the slot');
 s=apply(s,start('run-1',T0),host,T0+5);assert.deepEqual([s.schedules[0]!.nextAt,s.schedules[0]!.used,s.schedules[0]!.runs[0]!.state],[T0+DAY,1,'started']);
 assert.throws(()=>apply(s,start('run-2',T0+10,true),host,T0+10),/started/,'one run at a time');
 assert.throws(()=>apply(s,{type:'close-run',scheduleId:'schedule-a',runId:'run-1'}),/close/,'a run still in time is not closed');
 s=apply(s,{type:'finish-run',scheduleId:'schedule-a',runId:'run-1',turnIds:['assistant-turn:m:1'],segment:1},host,T0+6);assert.deepEqual([s.schedules[0]!.runs[0]!.state,s.schedules[0]!.runs[0]!.endedAt],['done',T0+6]);
 s=apply(s,start('run-2',T0+100,true),host,T0+100);assert.equal(s.schedules[0]!.nextAt,T0+DAY,'Run now keeps the next slot');
 s=apply(s,{type:'fail-run',scheduleId:'schedule-a',runId:'run-2',reason:'Briefing unavailable'},host,T0+101);
 assert.throws(()=>apply(s,start('run-3',T0+DAY),host,T0+DAY),/budget/i,'the cumulative budget is spent');
 s=apply(s,{type:'skip-run',scheduleId:'schedule-a',runId:'run-3',slot:T0+DAY},host,T0+DAY);const a=s.schedules[0]!;
 assert.deepEqual([a.active,a.runs.at(-1)!.state,a.runs.at(-1)!.reason,a.used],[false,'failed','Budget reached',2]);
 assert.throws(()=>apply(s,{type:'resume-schedule',scheduleId:'schedule-a'}),/budget/i);
 s=apply(s,{type:'close-run',scheduleId:'schedule-a',runId:'run-2'});assert.equal(s.schedules[0]!.runs[1]!.state,'closed');
});

test('scheduler: a due tick leaves one briefing of the last day\'s Work turns, never calls a model, and runs once per slot',async t=>{
 const f=await setup(t);await f.say('Please total discounts','Discount totals');await f.say('What is the capital of France?');
 const old=f.now();f.setNow(old+DAY+5000);await f.say('Please sort receipts','Receipt sort');
 const base=f.now();await f.schedules.act({commandId:'c-1',action:'create',minute:new Date(base+60000).getUTCHours()*60+new Date(base+60000).getUTCMinutes(),offset:0,budget:{runs:30}});
 let view=(await f.schedules.read()).schedules[0]!;assert.equal(view.title,'Morning briefing');assert.equal(view.assignee,'하나');assert.ok(view.nextAt>base&&view.nextAt<=base+120000);
 assert.equal((await f.schedules.tick()).length,0,'nothing is due yet');
 const calls=f.calls();f.setNow(view.nextAt+1000);const ran=await f.schedules.tick();assert.equal(ran.length,1);assert.equal(f.calls(),calls,'the briefing is written by the host, no model call');
 assert.equal((await f.schedules.tick()).length,0,'one run per slot');
 view=(await f.schedules.read()).schedules[0]!;assert.deepEqual([view.runs.length,view.runs[0]!.state,view.budget],[1,'done',{runs:30,used:1}]);assert.ok(view.nextAt>f.now());
 const head=await f.assistant.read(),conv=await f.schedules.conversation(head.segment!.number),turns=head.turns,receipt=turns.find(x=>x.work?.title==='Receipt sort')!;
 assert.deepEqual(conv.briefings,[{id:view.runs[0]!.id,at:f.now(),title:'Morning briefing',turnIds:[receipt.id]}],'only Work turns from the 24 hours before the run');assert.deepEqual(conv.exceptions,[]);
 assert.equal(view.runs[0]!.fact,'1 Work item');
 assert.equal((view.runs[0] as any).segment,head.segment!.number,'a past run retains the exact conversation segment that produced it');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('scheduler: a started run that never finished reads as result unknown, is never run again, and the next slot still runs',async t=>{
 const f=await setup(t);await f.schedules.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}});
 let s=(await f.store.load(SCHEDULES_ID))!;const slot=s.value.schedules[0].nextAt;
 // A host that dies between the start and the finish: the start is committed, the finish never is.
 const started=applySchedules(s.value,{type:'start-run',scheduleId:s.value.schedules[0].id,runId:'run-lost',slot,manual:false},host,{observedAt:slot+1});
 await f.store.commit({id:SCHEDULES_ID,expectedRevision:s.revision,commandId:'assistant-schedule-run:run-lost',fingerprint:'x',value:started.value,events:started.events,outbox:[]});
 f.setNow(slot+30000);assert.deepEqual((await f.schedules.read()).schedules[0]!.runs.map(r=>[r.state,(r as any).deadlineAt]),[['running',slot+1+60000]],'the Schedules page is told when to read again too');assert.deepEqual(await f.schedules.conversation(),{briefings:[],exceptions:[],runDeadlineAt:slot+1+60000},'still in time: the page is told when to read again');assert.equal((await f.schedules.tick()).length,0);
 f.setNow(slot+61000);const conv=await f.schedules.conversation();
 assert.deepEqual(conv.exceptions.map(e=>[e.title,e.state,e.fact,e.actions]),[['Morning briefing','unknown','Not resent',['check','close']]]);assert.equal((conv as any).runDeadlineAt,undefined);assert.deepEqual((await f.schedules.read()).schedules[0]!.runs.map(r=>[r.state,(r as any).deadlineAt]),[['unknown',undefined]]);
 assert.equal((await f.schedules.tick()).length,0,'the unknown slot is not run again');
 await assert.rejects(f.schedules.act({commandId:'c-2',action:'retry',scheduleId:s.value.schedules[0].id}),/action/i);
 f.setNow(slot+DAY+1000);assert.equal((await f.schedules.tick()).length,1,'the next slot runs');
 const id=s.value.schedules[0].id;await f.schedules.act({commandId:'c-3',action:'close',scheduleId:id,runId:'run-lost'});
 assert.deepEqual((await f.schedules.conversation()).exceptions,[]);assert.equal((await f.schedules.read()).schedules[0]!.runs.find(r=>r.id==='run-lost')!.state,'closed');
});

test('scheduler: a failed read is a failed run with Retry and Close; Run now retries; a spent budget pauses with Close only',async t=>{
 const f=await setup(t);await f.schedules.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:2}});const id=(await f.schedules.read()).schedules[0]!.id;
 f.failRead(true);f.setNow((await f.schedules.read()).schedules[0]!.nextAt);await f.schedules.tick();
 let ex=(await f.schedules.conversation()).exceptions;assert.deepEqual(ex.map(e=>[e.state,e.fact,e.actions]),[['failed','Briefing unavailable',['retry','close']]]);
 f.failRead(false);const retry={commandId:'c-2',action:'run',scheduleId:id,retryOf:ex[0]!.runId},run=await f.schedules.act(retry);assert.equal(run.status,'committed');
 assert.equal((await f.schedules.act(retry)).status,'replayed','a lost Retry replays, running once');
 let view=(await f.schedules.read()).schedules[0]!;assert.deepEqual(view.runs.map(r=>r.state),['done','closed'],'Retry closes the failed run it retries');assert.deepEqual(view.budget,{runs:2,used:2});
 assert.deepEqual((await f.schedules.conversation()).exceptions,[],'one failure, one action: no card is left after a Retry');
 f.setNow(view.nextAt);await f.schedules.tick();view=(await f.schedules.read()).schedules[0]!;
 assert.deepEqual([view.active,view.runs[0]!.state,view.runs[0]!.fact],[false,'failed','Budget reached']);
 ex=(await f.schedules.conversation()).exceptions;assert.deepEqual(ex.map(e=>[e.fact,e.actions]),[['Budget reached',['close']]]);
 await assert.rejects(f.schedules.act({commandId:'c-4',action:'resume',scheduleId:id}),/budget/i);await assert.rejects(f.schedules.act({commandId:'c-5',action:'run',scheduleId:id}),/budget/i);
 await f.schedules.act({commandId:'c-6',action:'pause',scheduleId:id}).catch(()=>{});
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('scheduler: Run now commits on a clock that moves between reads, and a lost Run now replays once',async t=>{
 const f=await setup(t);let tick=0;const moving=new SchedulesService(f.store,()=>f.assistant.read(),()=>f.now()+(tick++));
 await moving.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}});const id=(await moving.read()).schedules[0]!.id;
 assert.equal((await moving.act({commandId:'c-2',action:'run',scheduleId:id})).status,'committed');assert.equal((await moving.act({commandId:'c-2',action:'run',scheduleId:id})).status,'replayed');
 assert.deepEqual((await moving.read()).schedules[0]!.runs.map(r=>r.state),['done']);
 for(const action of ['constructor','toString','__proto__'])await assert.rejects(moving.act({commandId:'c-3',action,scheduleId:id}),DomainError,action);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('drain: an in-flight scheduler tick settles before the host reports drained',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-schedules-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inner=new InMemoryStore<any>();let gate:Promise<void>|undefined,release!:()=>void,entered!:()=>void;const inside=new Promise<void>(r=>entered=r),order:string[]=[];
 gate=new Promise<void>(r=>release=r);
 const store=new Proxy(inner,{get(target,key){if(key==='load')return async(id:string)=>{if(id===SCHEDULES_ID&&gate){const g=gate;gate=undefined;entered();await g;order.push('tick');}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:2000,scheduleIntervalMs:5});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 await inside;const drained=server.drain().then(r=>{order.push('drained');return r;});await new Promise(r=>setTimeout(r,30));release();
 assert.equal((await drained).status,'drained');assert.deepEqual(order,['tick','drained']);
});

test('lineage: host steps carry host command IDs; an owner command never does',async t=>{
 const f=await setup(t);await f.schedules.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}});const id=(await f.schedules.read()).schedules[0]!.id;
 await f.schedules.act({commandId:'c-2',action:'run',scheduleId:id});
 const ops=f.store.inspect().filter(o=>o.aggregateId===SCHEDULES_ID) as any[];assert.deepEqual(ops.map(o=>o.commandId.replace(/:.*/,'')),['c-1','assistant-schedule-run','assistant-schedule-finish']);
 replaySchedules(ops[0],undefined);replaySchedules(ops[1],ops[0]);replaySchedules(ops[2],ops[1]);
 assert.throws(()=>replaySchedules({...ops[1],commandId:'c-9'},ops[0]),/identity/);
 assert.throws(()=>replaySchedules({...ops[0],commandId:'assistant-schedule-run:x'},undefined),/identity/);
 await assert.rejects(f.schedules.act({commandId:'assistant-schedule-run:x',action:'pause',scheduleId:id}),/reserved|identity/);
});

test('HTTP: schedules and results routes take exact fields; the conversation read carries briefings and exceptions',async t=>{
 const f=await setup(t);await f.say('Please total discounts','Discount totals');
 const server=createWorkbench(f.store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:50,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port,url=(p:string)=>`http://127.0.0.1:${port}${p}`;
 const post=(path:string,body:unknown)=>fetch(url(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.deepEqual((await fetch(url('/assistant/schedules')).then(r=>r.json()) as any).schedules,[]);
 assert.equal((await post('/assistant/schedules',{commandId:'c-1',action:'create',minute:480,offset:540})).status,400,'a cumulative budget is required');
 assert.equal((await post('/assistant/schedules',{commandId:'assistant-x',action:'create',minute:480,offset:540,budget:{runs:30}})).status,400);
 assert.equal((await post('/assistant/schedules',{commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30},kind:'unknown'})).status,400);
 assert.equal((await post('/assistant/schedules',{commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}})).status,201);
 const list=await fetch(url('/assistant/schedules')).then(r=>r.json()) as any,id=list.schedules[0].id;assert.equal(list.schedules[0].destination,'Conversation with 하나');
 assert.equal((await post('/assistant/schedules',{commandId:'c-2',action:'run',scheduleId:id})).status,200);
 const view=await fetch(url('/assistant/conversation')).then(r=>r.json()) as any;assert.equal(view.briefings.length,1);assert.deepEqual(view.briefings[0].turnIds,[view.turns.find((x:any)=>x.work).id]);assert.deepEqual(view.exceptions,[]);
 assert.equal((await post('/assistant/schedules',{commandId:'c-3',action:'pause',scheduleId:id})).status,200);assert.equal((await fetch(url('/assistant/schedules')).then(r=>r.json()) as any).schedules[0].active,false);
 const results=await fetch(url('/assistant/results')).then(r=>r.json()) as any,row=results.results[0];
 assert.deepEqual([results.results.length,row.title,row.kind,row.missionId,row.segment,row.turnId],[1,'Discount totals','text','intake',1,view.turns.find((x:any)=>x.work).id]);
 assert.equal(row.memberId,null,'the accepted result carries its assignee; null means the Representative');
 const read=await fetch(url(`/missions/${row.missionId}/record-artifact?work=${encodeURIComponent(row.workId)}&record=${encodeURIComponent(row.recordId)}&version=${row.version}&sha256=${row.sha256}`)).then(r=>r.json()) as any;
 assert.match(read.content,/Answer bounded fixture text/,'the preview reads the exact accepted text');
 assert.equal((await fetch(url('/assistant/results?x=1'))).status,400);
});

test('a briefing keeps its Work after the conversation rolls over: one read from an earlier segment carries that segment\'s turns',async t=>{
 const store=new InMemoryStore<any>(),work={id:'assistant-turn:m:1',at:T0,work:{title:'Receipt sort'}},reads:(number|undefined)[]=[];let head=1;
 const s=new SchedulesService(store,async n=>{reads.push(n);const number=n??head;return number===1?{segment:{number:1},turns:[work,{id:'assistant-turn:m:2',at:T0}]}:{segment:{number},turns:[]};},()=>T0+1000);
 await s.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}});const id=(await s.read()).schedules[0]!.id;await s.act({commandId:'c-2',action:'run',scheduleId:id});
 let [b]=(await s.conversation(1)).briefings;assert.deepEqual(b,{id:b!.id,at:T0+1000,title:'Morning briefing',turnIds:[work.id]},'the head segment shows it from its own turns');
 head=2;reads.length=0;[b]=(await s.conversation(2)).briefings;assert.deepEqual([b!.turnIds,(b as any).turns],[[work.id],[work]],'after rollover the briefing still names its Work');assert.deepEqual(reads,[1]);
});

test('an identical schedule command committed between the receipt lookup and the state load replays, never 409s on its own applied state',async t=>{
 const inner=new InMemoryStore<any>(),direct=new SchedulesService(inner,async()=>({turns:[]}),()=>T0);let race:(()=>Promise<unknown>)|undefined;
 const store=new Proxy(inner,{get(target,key){if(key==='load')return async(id:string)=>{const run=race;race=undefined;if(run)await run();return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const s=new SchedulesService(store as Store<any>,async()=>({turns:[]}),()=>T0);
 await s.act({commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}});const id=(await s.read()).schedules[0]!.id,pause={commandId:'c-2',action:'pause',scheduleId:id};
 race=()=>direct.act(pause);assert.equal((await s.act(pause)).status,'replayed');
 assert.equal((await s.read()).schedules[0]!.active,false);
});

test('drain: a scheduler write with an unknown commit outcome makes the host drain unsettled',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-schedules-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inner=new InMemoryStore<any>(),now=Date.now(),created=applySchedules(null,create({budget:{runs:30},offset:0,minute:new Date(now-60000).getUTCHours()*60+new Date(now-60000).getUTCMinutes()}),owner,{observedAt:now-DAY});
 await inner.commit({id:SCHEDULES_ID,expectedRevision:0,commandId:'c-1',fingerprint:'x',value:created.value,events:created.events,outbox:[]});
 let tried!:()=>void;const attempted=new Promise<void>(r=>tried=r);
 const store=new Proxy(inner,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.id===SCHEDULES_ID&&input.commandId.startsWith('assistant-schedule-run:')){await target.commit(input);tried();throw new CommitOutcomeUnknownError(input,new Error('ack lost'));}return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:2000,scheduleIntervalMs:5});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 await attempted;assert.deepEqual(await server.drain(),{status:'unsettled',timedOut:false});
});

test('drain: a Run now whose finish commit turns unknown during drain makes the host drain unsettled',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-schedules-manual-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inner=new InMemoryStore<any>(),created=applySchedules(null,create({budget:{runs:30},offset:540,minute:480}),owner,{observedAt:Date.now()});
 await inner.commit({id:SCHEDULES_ID,expectedRevision:0,commandId:'c-1',fingerprint:'x',value:created.value,events:created.events,outbox:[]});
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
 const store=new Proxy(inner,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.id===SCHEDULES_ID&&input.commandId.startsWith('assistant-schedule-finish:')){entered();await gate;await target.commit(input);throw new CommitOutcomeUnknownError(input,new Error('ack lost'));}return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:2000,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 const port=(server.address() as {port:number}).port,id=(created.value as SchedulesState).schedules[0]!.id;
 const run=fetch(`http://127.0.0.1:${port}/assistant/schedules`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'c-2',action:'run',scheduleId:id})});
 await inside;const drained=server.drain();release();assert.equal((await run).status,200);
 assert.deepEqual(await drained,{status:'unsettled',timedOut:false});
});

test('HTTP: an owner schedule action resuming after drain starts is refused and stores nothing',async t=>{
 const f=await setup(t);let hold=false,held=()=>{},release=()=>{};const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===SCHEDULES_ID){hold=false;held();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:3000,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 hold=true;const response=fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/assistant/schedules`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'c-drain',action:'create',minute:480,offset:540,budget:{runs:30}})});
 await reached;const drain=server.drain();release();
 assert.equal((await response).status,503);assert.equal((await drain).status,'drained');assert.deepEqual((await f.schedules.read()).schedules,[]);
});


test('a confirmed clarification without a Work proposal fails the schedule and permits owner retry',async t=>{
 const f=await setup(t),s=new SchedulesService(f.store,()=>f.assistant.read(),()=>f.now(),f.store,scheduleWorkProducer(f.assistant));
 await s.act({commandId:'create-price',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:2}});
 const id=(await s.read()).schedules[0]!.id;await s.act({commandId:'clarify-price',action:'run',scheduleId:id});
 const view=await s.read(),run=view.schedules[0]!.runs[0]!;
 assert.equal(run.state,'failed');assert.equal(s.unsettled,false);
 assert.ok((await s.conversation()).exceptions.find(e=>e.runId===run.id)?.actions.includes('retry'));
 const turn=(await f.assistant.read()).turns[0]!;assert.equal(turn.status,'answered');assert.equal(turn.proposal,undefined);assert.equal(turn.outcome,undefined);
 assert.equal((await f.store.load('intake'))!.value.works.length,0);
});

test('a due schedule records the refusal when another Work holds the run slot',{timeout:10000},async t=>{
 const gate=new EventEmitter(),f=await setup(t,undefined,async()=>{
  const resume=once(gate,'resume',{signal:t.signal});gate.emit('entered');await resume;
 });
 const s=new SchedulesService(f.store,n=>f.assistant.read(n),f.now,f.store,scheduleWorkProducer(f.assistant));
 await s.act({commandId:'create-price',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:2}});
 f.setNow((await s.read()).schedules[0]!.nextAt);
 const entered=once(gate,'entered',{signal:t.signal}),first=f.say('Please sort the supplied receipts','Receipt sort');
 try{
  await Promise.race([entered,first.then(()=>assert.fail('The first Work finished before its executor was held'))]);
  f.queueWork('Price check');
  await s.tick();
  const run=((await f.store.load(SCHEDULES_ID))!.value as SchedulesState).schedules[0]!.runs[0]!;
  assert.equal(run.state,'failed');
  assert.equal(run.reason,'host_busy');
  const [shown]=(await s.read()).schedules[0]!.runs;
  assert.deepEqual([shown!.state,shown!.fact],['failed',copy('ui.not-started')]);
  const [exception]=(await s.conversation()).exceptions;
  assert.equal(exception?.fact,copy('ui.not-started'));
  assert.deepEqual(exception?.actions,['close']);
 }finally{gate.emit('resume');await first;}
 assert.deepEqual(await s.tick(),[]);
 const work=(await f.assistant.read()).turns.find(t=>t.work?.title==='Price check')?.work;
 assert.equal(work?.started,false,'the admitted Work is still available to start from its card');
});

test('a due schedule records done when the run slot is free',{timeout:10000},async t=>{
 const f=await setup(t),s=new SchedulesService(f.store,n=>f.assistant.read(n),f.now,f.store,scheduleWorkProducer(f.assistant));
 await s.act({commandId:'create-price',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:2}});
 f.setNow((await s.read()).schedules[0]!.nextAt);
 f.queueWork('Price check');
 try{
  await s.tick();
  const run=((await f.store.load(SCHEDULES_ID))!.value as SchedulesState).schedules[0]!.runs[0]!;
  assert.equal(run.state,'done');
 }finally{await f.assistant.idle();}
});

test('a due schedule still runs after 31 refused runs',{timeout:10000},async t=>{
 let hold=false;
 const gate=new EventEmitter(),f=await setup(t,undefined,async()=>{
  if(!hold)return;
  const resume=once(gate,'resume',{signal:t.signal});gate.emit('entered');await resume;
 });
 const s=new SchedulesService(f.store,n=>f.assistant.read(n),f.now,f.store,scheduleWorkProducer(f.assistant));
 await s.act({commandId:'create-price',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:34}});
 const {id:scheduleId,nextAt:firstSlot}=(await s.read()).schedules[0]!;
 f.queueWork('Price check before the slot is held');
 try{await s.act({commandId:'run-price',action:'run',scheduleId});}
 finally{await f.assistant.idle();}
 assert.equal((await s.read()).schedules[0]!.runs[0]?.state,'done');
 hold=true;f.setNow(firstSlot);
 const entered=once(gate,'entered',{signal:t.signal}),first=f.say('Please sort the supplied receipts','Receipt sort');
 try{
  await Promise.race([entered,first.then(()=>assert.fail('The first Work finished before its executor was held'))]);
  for(let i=0;i<31;i++){
   f.setNow(firstSlot+i*DAY);f.queueWork('Price check '+i);
   assert.equal((await s.tick()).length,1,'scheduled start '+(i+1));
  }
  const {runs}=(await f.store.load(SCHEDULES_ID))!.value.schedules[0] as SchedulesState['schedules'][number];
  assert.deepEqual(runs.map(run=>[run.state,run.reason]),Array.from({length:31},()=>['failed','host_busy']));
 }finally{hold=false;gate.emit('resume');await first;}
 f.setNow(firstSlot+31*DAY);f.queueWork('Price check with a free slot');
 try{
  assert.equal((await s.tick()).length,1,'the first start after 31 refusals');
  const [run]=(await s.read()).schedules[0]!.runs;
  assert.equal(run?.state,'done');
 }finally{await f.assistant.idle();}
});

test('30 ordinary failed and unknown runs still block the next start',()=>{
 let state=apply(null,create({budget:{runs:32}}),owner,T0-1);
 for(let i=0;i<30;i++){
  const slot=T0+i*DAY,runId='run-'+i;
  state=apply(state,{type:'start-run',scheduleId:'schedule-a',runId,manual:false,slot},host,slot);
  if(i%2===0)state=apply(state,{type:'fail-run',scheduleId:'schedule-a',runId,reason:'Briefing unavailable'},host,slot);
 }
 const slot=T0+30*DAY;
 assert.throws(()=>apply(state,{type:'start-run',scheduleId:'schedule-a',runId:'next-run',manual:false,slot},host,slot),{code:'conflict',message:'Close earlier runs first'});
});

test('a schedule producer uses normal Work admission with fixture providers and retains its exact conversation source',async t=>{
 const answer='- Groceries: KRW 1,200 (receipt R1)\n- Transport: KRW 2,300 (receipt R2)',f=await setup(t,answer),s=new SchedulesService(f.store,()=>f.assistant.read(),()=>f.now(),f.store,scheduleWorkProducer(f.assistant));
 f.queueWork('Weekly receipt categories');
 await s.act({commandId:'scheduled-expenses',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:2},request:'Group these supplied receipts by category: R1 groceries KRW 1200; R2 transport KRW 2300.'});
 const id=(await s.read()).schedules[0]!.id;await s.act({commandId:'produce-expenses',action:'run',scheduleId:id});
 const view=(await s.read()).schedules[0]!,head=await f.assistant.read(),source=head.turns.find(t=>t.work?.title==='Weekly receipt categories')!;
 assert.ok(source?.work);assert.deepEqual(view.runs[0]!.turnIds,[source.id]);assert.equal(view.runs[0]!.segment,head.segment!.number);assert.equal(view.runs[0]!.state,'done');
 await f.assistant.idle();const work=(await f.store.load('intake'))!.value.works.find((w:any)=>w.id===source.work!.workId);assert.equal(work.acceptance,'accepted');assert.ok(work.record);assert.equal(await f.artifacts.read(work.record.artifact),answer);assert.notEqual(work.assignments.find((a:any)=>a.role==='executor').actorId,work.assignments.find((a:any)=>a.role==='verifier').actorId);
 const calls=f.calls();await s.act({commandId:'produce-expenses',action:'run',scheduleId:id});assert.equal(f.calls(),calls);validateMissionJournalLineage(f.store.inspect() as any);
});
