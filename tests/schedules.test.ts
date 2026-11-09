import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {CommitOutcomeUnknownError,InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {DomainError} from '../src/domain.ts';
import type {Actor,Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createWorkbench} from '../src/server.ts';
import {SCHEDULES_ID,SchedulesService,applySchedules,replaySchedules,nextSlot} from '../src/schedules.ts';
import type {SchedulesCommand,SchedulesState} from '../src/schedules.ts';

// docs/architecture/results-and-schedules.md: one morning briefing schedule, run by the host scheduler under a cumulative budget; unknown is never resent. Fixture-class only, no model call for the briefing.
const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]});
const turn=(reply:string,title?:string)=>JSON.stringify({reply,work:title===undefined?null:{title}});
const owner={id:'local-owner',roles:['owner' as const]},host={id:'assistant-representative',roles:['assistant' as const]};
const DAY=86400000,T0=Date.UTC(2026,10,5,23,0);// 08:00 on Nov 6 in UTC+9 is 23:00 UTC on Nov 5.

async function setup(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'massion-schedules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore(join(root,'artifacts')),script:string[]=[];let calls=0;const start=Date.now();let now=start;const clock=()=>now;
 const completion=(model:string,content:string)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{calls++;
  const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);
  if(Object.hasOwn(prompt,'currentMessage'))return completion(body.model,script.shift()??turn('Hello.'));
  if(prompt.artifact)return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Answer bounded',reason:'Controlled fixture'}]}));
  return completion(body.model,'- Answer bounded fixture text\n- Second point');
 };
 const m=createHostConnections(store,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings:new InMemoryHostSettings()});
 const profile=(model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 const product=new ProductService(store,undefined,m,artifacts);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},'create-intake');
 await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));
 const assistant=new AssistantService(store,product,m,{clock});
 await assistant.setSettings({profileId:profile('representative'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:m.list().configHash});
 let failRead=false;const schedules=new SchedulesService(store,async()=>{if(failRead)throw new Error('read failed');return assistant.read();},clock);
 const say=async(text:string,title?:string)=>{script.push(turn('On it.',title));const view=await assistant.read();const target=!view.segment?{segment:1,expectedRevision:0}:{segment:view.head,expectedRevision:view.segment.revision};const r=await assistant.send({commandId:randomUUID(),...target,text});await assistant.idle();return r;};
 return {root,store,artifacts,m,product,assistant,schedules,say,start,now:()=>now,setNow:(v:number)=>{now=v;},failRead:(v:boolean)=>{failRead=v;},calls:()=>calls};
}
const apply=(state:SchedulesState|null,command:SchedulesCommand,actor:Actor=owner,at=T0)=>applySchedules(state,command,actor,{observedAt:at}).value;
const create=(over:Record<string,unknown>={}):SchedulesCommand=>({type:'create-schedule',scheduleId:'schedule-a',kind:'briefing',minute:480,offset:540,budget:{runs:2},...over} as SchedulesCommand);

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
 const root=await mkdtemp(join(tmpdir(),'massion-schedules-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
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
 assert.equal((await post('/assistant/schedules',{commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30},kind:'briefing'})).status,400);
 assert.equal((await post('/assistant/schedules',{commandId:'c-1',action:'create',minute:480,offset:540,budget:{runs:30}})).status,201);
 const list=await fetch(url('/assistant/schedules')).then(r=>r.json()) as any,id=list.schedules[0].id;assert.equal(list.schedules[0].destination,'Conversation with 하나');
 assert.equal((await post('/assistant/schedules',{commandId:'c-2',action:'run',scheduleId:id})).status,200);
 const view=await fetch(url('/assistant/conversation')).then(r=>r.json()) as any;assert.equal(view.briefings.length,1);assert.deepEqual(view.briefings[0].turnIds,[view.turns.find((x:any)=>x.work).id]);assert.deepEqual(view.exceptions,[]);
 assert.equal((await post('/assistant/schedules',{commandId:'c-3',action:'pause',scheduleId:id})).status,200);assert.equal((await fetch(url('/assistant/schedules')).then(r=>r.json()) as any).schedules[0].active,false);
 const results=await fetch(url('/assistant/results')).then(r=>r.json()) as any,row=results.results[0];
 assert.deepEqual([results.results.length,row.title,row.kind,row.missionId,row.segment,row.turnId],[1,'Discount totals','text','intake',1,view.turns.find((x:any)=>x.work).id]);
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
 const root=await mkdtemp(join(tmpdir(),'massion-schedules-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inner=new InMemoryStore<any>(),now=Date.now(),created=applySchedules(null,create({budget:{runs:30},offset:0,minute:new Date(now-60000).getUTCHours()*60+new Date(now-60000).getUTCMinutes()}),owner,{observedAt:now-DAY});
 await inner.commit({id:SCHEDULES_ID,expectedRevision:0,commandId:'c-1',fingerprint:'x',value:created.value,events:created.events,outbox:[]});
 let tried!:()=>void;const attempted=new Promise<void>(r=>tried=r);
 const store=new Proxy(inner,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.id===SCHEDULES_ID&&input.commandId.startsWith('assistant-schedule-run:')){await target.commit(input);tried();throw new CommitOutcomeUnknownError(input,new Error('ack lost'));}return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:2000,scheduleIntervalMs:5});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 await attempted;assert.deepEqual(await server.drain(),{status:'unsettled',timedOut:false});
});

test('drain: a Run now whose finish commit turns unknown during drain makes the host drain unsettled',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-schedules-manual-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
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
