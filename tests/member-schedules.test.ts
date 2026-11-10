import test from 'node:test';
import assert from 'node:assert/strict';
import {SchedulesService,SCHEDULES_ID,RUN_MS,applySchedules,replaySchedules,scheduleWorkProducer} from '../src/schedules.ts';
import type {ScheduleProducer,SchedulesCommand,SchedulesState} from '../src/schedules.ts';
import {CommitOutcomeUnknownError,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {DomainError} from '../src/domain.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import type {AssistantService} from '../src/assistant-service.ts';
import {AssistantService as Representative} from '../src/assistant-service.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryHostSettings} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MembersService} from '../src/members.ts';

const T=Date.UTC(2026,10,6),owner={id:'local-owner',roles:['owner' as const]};
const empty=async()=>({turns:[]});
const proxy=(store:InMemoryStore<any>,overrides:Record<string,unknown>)=>new Proxy(store,{get(target,key){if(Object.hasOwn(overrides,key))return overrides[key as string];const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Store<any>;
const create=(commandId:string,memberId?:string)=>({commandId,action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:3},...(memberId===undefined?{}:{memberId})});
function fixture(){
 const store=new InMemoryStore<any>(),members=new Map<string,{id:string;name:string;archivedAt?:number}>([['quill',{id:'quill',name:'Quill'}],['juno',{id:'juno',name:'Juno'}]]),calls:string[]=[],reads:string[]=[];let now=T;
 const member=async(id:string)=>members.get(id),produce:ScheduleProducer=async input=>{calls.push(input.memberId??'representative');return {turnIds:['turn:'+input.scheduleId],segment:1};};
 const options={member,readMember:async(id:string,segment?:number)=>{reads.push(id+':'+segment);return {segment:{number:segment??1},turns:[{id:'turn:quill',work:{}},{id:'turn:juno',work:{}}]};},produceMember:produce};
 const service=new SchedulesService(store,empty,()=>now,store,produce,options);
 return {store,members,calls,reads,member,produce,options,service,setNow:(n:number)=>{now=n;},clock:()=>now};
}
async function add(f:ReturnType<typeof fixture>,name:string,memberId?:string){const result=await f.service.act(create(name,memberId));assert.equal(result.status,'committed');return result.value.schedules.at(-1)!.id;}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

test('member schedules retain immutable bindings and legacy journal transitions replay unchanged',async()=>{
 const f=fixture(),a=await add(f,'old'),b=await add(f,'new','quill');
 const rows=(await f.service.read()).schedules;
 assert.equal(rows[0]!.memberId,undefined);assert.deepEqual([rows[1]!.memberId,rows[1]!.assignee,rows[1]!.destination],['quill','Quill','Conversation with Quill']);
 await f.service.act({commandId:'run-new',action:'run',scheduleId:b});
 await f.service.act({commandId:'pause-new',action:'pause',scheduleId:b});
 await assert.rejects(f.service.act({commandId:'rebind',action:'resume',scheduleId:b,memberId:'juno'}),DomainError);
 const ops=f.store.inspect();ops.forEach((op,i)=>replaySchedules(op,ops[i-1]));
 const command={type:'pause-schedule',scheduleId:a,memberId:'quill'} as unknown as SchedulesCommand;
 assert.throws(()=>applySchedules(ops.at(-1)!.value as SchedulesState,command,owner,{observedAt:T}),DomainError);
 assert.equal(Object.hasOwn(ops[0]!.value.schedules[0],'memberId'),false);
 const corrupted=structuredClone(ops.at(-1)!);corrupted.value.schedules[1].memberId='juno';assert.throws(()=>replaySchedules(corrupted,ops.at(-2)),/transition/);
});

test('creation validates an active exact member, rejects member briefings and malformed bindings without writing',async()=>{
 const f=fixture();f.members.get('quill')!.archivedAt=T;
 for(const memberId of ['quill','missing','',null,undefined,3])await assert.rejects(f.service.act({...create('bad','quill'),memberId}),DomainError);
 await assert.rejects(f.service.act({...create('briefing','juno'),kind:'briefing'}),DomainError);
 await assert.rejects(f.service.act({...create('legacy-briefing','juno'),kind:undefined}),DomainError);
 assert.equal(await f.store.load(SCHEDULES_ID),null);
 const noOptions=new SchedulesService(f.store,empty,()=>T);
 await assert.rejects(noOptions.act(create('no-options','juno')),DomainError);
 const wrong=new SchedulesService(f.store,empty,()=>T,f.store,f.produce,{...f.options,member:async()=>({id:'other',name:'Juno'})});
 await assert.rejects(wrong.act(create('wrong-member','juno')),DomainError);
});

test('creation and manual-run receipts replay before archive validation and cannot rebind identity',async()=>{
 const f=fixture(),id=await add(f,'same','quill'),run={commandId:'once',action:'run',scheduleId:id};
 await f.service.act(run);f.members.get('quill')!.archivedAt=T;
 assert.equal((await f.service.act(create('same','quill'))).status,'replayed');assert.equal((await f.service.act(run)).status,'replayed');
 assert.equal((await f.service.act(create('same','juno'))).status,'conflict');assert.deepEqual(f.calls,['quill']);
});

test('member Work uses only the member producer and notifications keep the exact Representative source across threads',async()=>{
 const f=fixture(),ids=[await add(f,'representative'),await add(f,'quill','quill'),await add(f,'juno','juno')];
 let representative=0,member=0;
 const reads:number[]=[],service=new SchedulesService(f.store,async n=>{reads.push(n!);return {turns:[{id:'turn:quill',work:{}},{id:'turn:representative',work:{}}]};},f.clock,f.store,async input=>{representative++;assert.equal(input.memberId,undefined);return {turnIds:['turn:representative'],segment:1};},{...f.options,produceMember:async input=>{member++;assert.equal(input.memberId,'quill');return {turnIds:['turn:quill'],segment:1,sourceThread:''};}});
 await service.act({commandId:'rep-run',action:'run',scheduleId:ids[0]});await service.act({commandId:'quill-run',action:'run',scheduleId:ids[1]});
 assert.deepEqual([representative,member],[1,1]);
 const rep=await service.conversation(2),quill=await service.conversation(1,'quill'),juno=await service.conversation(2,'juno');
 assert.deepEqual(rep.briefings.map(b=>b.turnIds),[['turn:representative']]);assert.deepEqual(quill.briefings.map(b=>b.turns?.map(t=>t.id)),[['turn:quill']]);assert.deepEqual(juno,{briefings:[],exceptions:[]});assert.deepEqual(f.reads,[]);assert.deepEqual(reads,[1,1]);assert.equal(quill.briefings[0]!.sourceThread,'');
 assert.equal((await service.read()).schedules[1]!.runs[0]!.sourceThread,'');
 const unknown=new SchedulesService(f.store,empty,f.clock,f.store,f.produce,{...f.options,produceMember:async()=>null});
 await unknown.act({commandId:'juno-run',action:'run',scheduleId:ids[2]});
 assert.equal((await unknown.conversation(1,'juno')).runDeadlineAt,T+RUN_MS);assert.equal((await unknown.conversation()).runDeadlineAt,undefined);assert.equal((await unknown.conversation(1,'quill')).runDeadlineAt,undefined);
 f.setNow(T+RUN_MS);assert.equal((await unknown.conversation(1,'juno')).exceptions.length,1);assert.equal((await unknown.conversation()).exceptions.length,0);assert.equal((await unknown.conversation(1,'quill')).exceptions.length,0);
});

test('archive skips future ticks including exhausted budgets and refuses fresh manual starts with no writes or dispatch',async()=>{
 const f=fixture(),id=await add(f,'quill','quill'),before=f.store.inspect();f.members.get('quill')!.archivedAt=T;
 f.setNow((await f.service.read()).schedules[0]!.nextAt);
 assert.deepEqual(await f.service.tick(),[]);await assert.rejects(f.service.act({commandId:'run',action:'run',scheduleId:id}),/archived|active/i);
 assert.deepEqual(f.store.inspect(),before);assert.deepEqual(f.calls,[]);
 delete f.members.get('quill')!.archivedAt;assert.equal((await f.service.tick()).length,1);assert.deepEqual(f.calls,['quill']);
 for(let n=0;n<2;n++)await f.service.act({commandId:'spend-'+n,action:'run',scheduleId:id});
 f.members.get('quill')!.archivedAt=f.clock();f.setNow((await f.service.read()).schedules[0]!.nextAt);const exhausted=f.store.inspect();
 assert.deepEqual(await f.service.tick(),[]);assert.deepEqual(f.store.inspect(),exhausted);
});

test('a member archived after fresh start retains the original outcome even after deadline and during drain',async()=>{
 const f=fixture(),id=await add(f,'quill','quill'),entered=deferred(),release=deferred();let draining=false;
 const ownerStore=proxy(f.store,{commit:async(input:any)=>{if(draining)throw new HostDrainError();return f.store.commit(input);}});
 const service=new SchedulesService(f.store,empty,f.clock,ownerStore,f.produce,{...f.options,produceMember:async()=>{entered.resolve();await release.promise;return {turnIds:['turn:original'],segment:2};}});
 const run=service.act({commandId:'run',action:'run',scheduleId:id});await entered.promise;
 f.members.get('quill')!.archivedAt=T;draining=true;f.setNow(T+RUN_MS+1);release.resolve();await run;
 assert.equal((await service.read()).schedules[0]!.runs[0]!.state,'done');
 delete f.members.get('quill')!.archivedAt;
 const before=f.store.inspect();await assert.rejects(service.act(create('blocked','quill')),HostDrainError);await assert.rejects(service.act({commandId:'blocked-run',action:'run',scheduleId:id}),HostDrainError);assert.deepEqual(f.store.inspect(),before);
});

test('overlapping member commands replay after load and idempotency conflicts, while manual/tick overlap admits once',async()=>{
 const f=fixture(),input=create('race','quill');let race=true;
 const store=proxy(f.store,{load:async(id:string)=>{if(race){race=false;await f.service.act(input);f.members.get('quill')!.archivedAt=T;}return f.store.load(id);}});
 const service=new SchedulesService(store,empty,f.clock,store,f.produce,f.options);
 assert.equal((await service.act(input)).status,'replayed');delete f.members.get('quill')!.archivedAt;
 let commitRace=true;const second=create('commit-race','juno'),conflicting=proxy(f.store,{commit:async(input:any)=>{if(commitRace){commitRace=false;await f.service.act(second);return {status:'conflict',reason:'idempotency',revision:2};}return f.store.commit(input);}});
 assert.equal((await new SchedulesService(conflicting,empty,f.clock,conflicting,f.produce,f.options).act(second)).status,'replayed');
 const id=(await service.read()).schedules[0]!.id,entered=deferred(),release=deferred();let calls=0;
 const slow=new SchedulesService(f.store,empty,f.clock,f.store,f.produce,{...f.options,produceMember:async()=>{calls++;entered.resolve();await release.promise;return {turnIds:['turn:one'],segment:1};}});
 f.setNow((await slow.read()).schedules[0]!.nextAt);const run={commandId:'overlap',action:'run',scheduleId:id},pending=slow.act(run);await entered.promise;
 try{assert.equal((await slow.act(run)).status,'replayed');await f.service.tick();assert.deepEqual(f.calls,['juno']);assert.equal(calls,1);}finally{release.resolve();await pending;}
});

test('unknown member dispatch and unknown start/finish commits never authorize resend after restart or archive',async()=>{
 for(const failure of ['producer','start','finish']){
  const f=fixture(),id=await add(f,'quill','quill');let calls=0;
  const store=proxy(f.store,{commit:async(input:any)=>{const result=await f.store.commit(input);if(input.commandId.startsWith('assistant-schedule-'+(failure==='start'?'run':failure)+':'))throw new CommitOutcomeUnknownError(input);return result;}});
  const service=new SchedulesService(store,empty,f.clock,store,f.produce,{...f.options,produceMember:async()=>{calls++;if(failure==='producer')throw new Error('ack lost');return {turnIds:['turn:one'],segment:1};}}),run={commandId:'run',action:'run',scheduleId:id};
  if(failure==='start')await assert.rejects(service.act(run),CommitOutcomeUnknownError);else await service.act(run);
  assert.equal(service.unsettled,true);f.setNow(T+RUN_MS+1);f.members.get('quill')!.archivedAt=T;
  const restarted=new SchedulesService(f.store,empty,f.clock,f.store,f.produce,f.options);assert.equal((await restarted.act(run)).status,'replayed');assert.equal(calls,failure==='start'?0:1);assert.deepEqual(f.calls,[]);
  assert.equal((await restarted.read()).schedules[0]!.runs[0]!.state,failure==='finish'?'done':'unknown');
 }
});

test('the Representative producer passes the immutable host target and leaves mismatched admitted Work unknown',async()=>{
 const sent:any[]=[],targets:(string|undefined)[]=[],request={commandId:'schedule-work:r',scheduleId:'s',runId:'r',kind:'price-watch' as const,request:'Check this supplied product',memberId:'quill'};let bound:string|null='quill';
 const turn={id:'turn:member',status:'answered',outcome:{work:{status:'admitted'}}};
 const assistant={read:async(n?:number)=>({segment:{number:n??1,revision:1},turns:n?[{...turn,work:{memberId:bound,unknown:false}}]:[]}),send:async(input:unknown,target?:string)=>{sent.push(input);targets.push(target);return {message:{status:'committed',value:{segment:1}},turn};}} as unknown as Pick<AssistantService,'send'|'read'>;
 const producer=scheduleWorkProducer(assistant);
 assert.deepEqual(await producer(request),{turnIds:['turn:member'],segment:1,sourceThread:''});assert.deepEqual(targets,['quill']);assert.match(sent[0].text,/Check this supplied product/);
 for(bound of ['juno',null])assert.equal(await producer({...request,commandId:'different-'+bound}),null);
});

test('an explicitly member-local source reads only that exact thread and cannot point at a different member',async()=>{
 const f=fixture(),id=await add(f,'local','quill');
 const service=new SchedulesService(f.store,async()=>{assert.fail('Member source must not read Representative turns');},f.clock,f.store,f.produce,{...f.options,produceMember:async()=>({turnIds:['turn:quill'],segment:1,sourceThread:'member:quill'})});
 await service.act({commandId:'local-run',action:'run',scheduleId:id});
 assert.deepEqual((await service.conversation(2,'quill')).briefings[0]!.turns?.map(t=>t.id),['turn:quill']);assert.deepEqual(f.reads,['quill:1']);
 const ops=f.store.inspect();ops.forEach((op,i)=>replaySchedules(op,ops[i-1]));
 const finish=(ops.at(-1)!.events[0] as any).command;
 assert.throws(()=>applySchedules(ops.at(-2)!.value,{...finish,sourceThread:'member:juno'}, {id:'assistant-representative',roles:['assistant']},{observedAt:T}),/source thread/);
});

test('member schedules admit real Representative Work with independent checking and replay without provider calls',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-member-schedules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const f=fixture(),artifacts=new TextArtifactStore(join(root,'artifacts')),prompts:any[]=[];let calls=0,assign=false;
 const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{
  calls++;const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content.split('\n\nInput references')[0]);let content:string;
  if(Object.hasOwn(prompt,'currentMessage')){prompts.push(prompt);content=JSON.stringify({reply:'I will check the supplied receipts.',work:{title:'Receipt categories '+prompts.length,...(assign?{member:'Wrong model choice'}:{})}});}
  else if(prompt.teamPlanning)content=JSON.stringify({steps:prompt.teamPlanning.steps.map((title:string,i:number)=>({role:i===0?'Research':'Writing',title,dependsOn:i?[i-1]:[]}))});
  else if(prompt.roomTurn)content=JSON.stringify({kind:prompt.roomTurn==='challenge'?'challenge':'concede',text:'The supplied answer has evidence',quote:prompt.roomTurn==='challenge'?'Answer bounded':''});
  else if(prompt.artifact)content=JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Answer bounded',reason:'Controlled fixture'}]});
  else content='Answer bounded fixture text';
  return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 };
 const connections=createHostConnections(f.store,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings:new InMemoryHostSettings()}),profile=(model:string)=>(connections.list().runtime.connections as any[]).find(p=>p.model===model).id as string,product=new ProductService(f.store,undefined,connections,artifacts);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},'create-intake');
 await connections.save(()=>connections.authorize({id:'grant',scope:'local',executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),maxOutputTokensPerCall:4,expectedConfigHash:connections.list().configHash}));
 await connections.save(()=>connections.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:connections.list().configHash}));
 const members=new MembersService(f.store,()=>'intake'),assistant=new Representative(f.store,product,connections,{members:async()=>(await members.read()).members});t.after(()=>assistant.idle());
 await assistant.setSettings({profileId:profile('representative'),outputTokenCap:128,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
 for(let i=0;i<2;i++){const head=await assistant.read();await assistant.send({commandId:'seed-'+i,segment:head.segment?.number??1,expectedRevision:head.segment?.revision??0,text:'Please check supplied receipts'});await assistant.idle();}
 await members.propose({topic:'Receipts',workIds:(await f.store.load('intake'))!.value.works.map((w:any)=>w.id)});await members.decide({commandId:'admit-quill',decisionId:(await members.read()).decisions.at(-1)!.id,answer:'act',member:{name:'Quill',shape:'drop'}});
 const quill=(await members.read()).members[0]!;assign=true;
 const service=new SchedulesService(f.store,n=>assistant.read(n),f.clock,f.store,scheduleWorkProducer(assistant),{...f.options,member:id=>members.member(id),produceMember:scheduleWorkProducer(assistant)});
 const created=await service.act({...create('receipts',quill.id),kind:'weekly-expenses',title:'My receipt check',request:'Group supplied receipts by category and check the result.'});assert.notEqual(created.status,'conflict');
 const id=(await service.read()).schedules[0]!.id,run={commandId:'run-receipts',action:'run',scheduleId:id};await service.act(run);await assistant.idle();
 const schedule=(await service.read()).schedules[0]!,work=(await f.store.load('intake'))!.value.works.at(-1);
 assert.equal(schedule.title,'My receipt check');assert.equal(schedule.runs[0]!.state,'done');assert.equal(work.assistantSource.memberId,quill.id);assert.equal(work.acceptance,'accepted',JSON.stringify({blocker:work.blocker,effects:work.effects.map((e:any)=>({target:e.target,status:e.status})),execution:work.execution}));assert.notEqual(work.assignments.find((a:any)=>a.role==='executor').actorId,work.assignments.find((a:any)=>a.role==='verifier').actorId);
 assert.deepEqual((await service.conversation()).briefings,[]);const notification=(await service.conversation(1,quill.id)).briefings[0]!;assert.equal(notification.sourceThread,'');assert.equal(notification.turns?.[0]?.id,work.assistantSource.turnId);assert.equal(notification.title,'My receipt check');
 const before=calls;assert.equal((await service.act(run)).status,'replayed');assert.equal(calls,before);
});
