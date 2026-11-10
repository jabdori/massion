import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DomainError,hash,apply,createMission,workInputHash} from '../src/domain.ts';
import type {Actor,Mission,Work} from '../src/domain.ts';
import {InMemoryStore,CommitOutcomeUnknownError} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX,replayMembers,memberThread} from '../src/members.ts';
import type {MembersState,MembersCommand} from '../src/members.ts';
import {ASSISTANT_ACTOR_ID,segmentId,ownerMessageId,assistantTurnId,assistantWorkId} from '../src/assistant-conversation.ts';
import type {AssistantSegment} from '../src/assistant-conversation.ts';
import {SCHEDULES_ID,applySchedules} from '../src/schedules.ts';

const owner={id:'local-owner',roles:['owner' as const]},host={id:ASSISTANT_ACTOR_ID,roles:['assistant' as const]},T0=Date.UTC(2026,10,10);
async function setup(store:Store<any>=new InMemoryStore<any>(),undoable=false){
 let now=T0;const service=new MembersService(store,()=>'intake',()=>now),proposalId=PROPOSAL_PREFIX+'lifecycle',decisionId=proposalDecisionId(proposalId),memberId=admittedMemberId('admit-lifecycle');
 let prior:MembersState|null=null,revision=0;
 const steps:[string,MembersCommand,Actor][]=[
  [proposalId,{type:'propose-member',decisionId,topic:'Analysis',works:[{title:'First'},{title:'Second'}],count:2},host],
  ['admit-lifecycle',{type:'admit-member',decisionId,memberId,name:'River',shape:'drop',...(undoable?{undoable:true as const}:{})},owner],
 ];
 for(const [commandId,command,actor] of steps){const {value,events}=applyMembers(prior,command,actor,{observedAt:now});await store.commit({id:MEMBERS_ID,expectedRevision:revision++,commandId,fingerprint:hash({actorId:actor.id,command}),value,events,outbox:[]});prior=value;}
 return {store,service,memberId,setNow:(at:number)=>{now=at;}};
}

test('member lifecycle receipt query matches the exact command without writing or exposing its snapshot',async()=>{
 const f=await setup(),input={commandId:'archive-receipt',memberId:f.memberId,action:'archive'};
 assert.deepEqual(await f.service.outcome(input),{commandId:input.commandId,status:'unknown'});
 await f.service.act(input);const before=(f.store as InMemoryStore<any>).inspect();
 assert.deepEqual(await f.service.outcome(input),{commandId:input.commandId,status:'replayed'});
 assert.deepEqual(await f.service.outcome({...input,action:'unarchive'}),{commandId:input.commandId,status:'conflict'});
 await assert.rejects(f.service.outcome({...input,extra:true}),/Exact member/);
 assert.deepEqual((f.store as InMemoryStore<any>).inspect(),before);
});
const action=(memberId:string,which:'archive'|'unarchive'='archive',commandId:string=which)=>({commandId,action:which,memberId});

test('archive is owner-only, exact, reversible and retains identity and admission lineage',async()=>{
 const f=await setup(),original=(await f.store.load(MEMBERS_ID))!.value as MembersState;
 const command={type:'archive-member',memberId:f.memberId} as MembersCommand;
 assert.throws(()=>applyMembers(original,command,host,{observedAt:T0+1}),/role/i);
 await assert.rejects(f.service.act({...action(f.memberId),extra:'not-allowed'}),DomainError);
 await assert.rejects(f.service.act(action('missing')),/Unknown member/);
 await assert.rejects(f.service.act(action(f.memberId,'archive','assistant-reserved')),DomainError);
 f.setNow(T0+1);assert.equal((await f.service.act(action(f.memberId))).status,'committed');
 assert.equal((await f.service.member(f.memberId))!.archivedAt,T0+1);
 assert.deepEqual(await f.service.roster(),[]);
 const archived=await f.service.read();assert.deepEqual(archived.members,[]);assert.equal(archived.archived[0]!.archivedAt,T0+1);
 assert.deepEqual(archived.decisions.map(d=>[d.state,d.memberId]),[['done',f.memberId]]);
 await assert.rejects(f.service.act(action(f.memberId,'archive','second-archive')),/archived/i);
 assert.equal((await f.service.act(action(f.memberId))).status,'replayed');
 assert.equal((await f.service.act(action(f.memberId,'unarchive','archive'))).status,'conflict');
 f.setNow(T0+2);assert.equal((await f.service.act(action(f.memberId,'unarchive'))).status,'committed');
 assert.equal((await f.service.read()).members[0]!.archivedAt,null);
 assert.equal((await f.service.roster())[0]!.id,f.memberId);
 assert.deepEqual((await f.store.load(MEMBERS_ID))!.value,original);
 const operations=(f.store as InMemoryStore<any>).inspect().filter(o=>o.aggregateId===MEMBERS_ID);
 for(let i=0;i<operations.length;i++)replayMembers(operations[i]!,operations[i-1]);
});

test('an archive that commits while another request loads replays before the reducer',async()=>{
 const f=await setup();let armed=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(armed&&id===MEMBERS_ID){armed=false;await f.service.act(action(f.memberId));}return target.load(id);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await new MembersService(store,()=>'intake',()=>T0+100).act(action(f.memberId))).status,'replayed');
 assert.equal((f.store as InMemoryStore<any>).inspect().filter(o=>o.events.some((e:any)=>e.type==='archive-member')).length,1);
});

test('overlapping archive commits reconcile an idempotency conflict to the original result',async()=>{
 const f=await setup();let armed=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(armed){armed=false;await f.service.act(action(f.memberId));}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await new MembersService(store,()=>'intake',()=>T0+100).act(action(f.memberId))).status,'replayed');
});

test('an owner archive paused in load is refused if the injected owner store starts draining',async()=>{
 const base=new InMemoryStore<any>(),f=await setup(base);let draining=false,held=()=>{},release=()=>{},armed=true;
 const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const ownerStore=new Proxy(base,{get(target,key){if(key==='load')return async(id:string)=>{if(armed&&id===MEMBERS_ID){armed=false;held();await gate;}return target.load(id);};if(key==='commit')return (input:any)=>{if(draining)throw new Error('Host is draining');return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const before=base.inspect().length,pending=new MembersService(ownerStore,()=>'intake',()=>T0+100).act(action(f.memberId));await reached;draining=true;release();
 await assert.rejects(pending,/draining/);assert.equal(base.inspect().length,before);assert.equal((await f.service.read()).members[0]!.archivedAt,null);
});

test('an unknown archive commit is not retried; a later lookup replays its identity',async()=>{
 const f=await setup();let commits=0;
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{commits++;await target.commit(input);throw new CommitOutcomeUnknownError(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=new MembersService(store,()=>'intake',()=>T0+100);await assert.rejects(service.act(action(f.memberId)),CommitOutcomeUnknownError);
 assert.equal(commits,1);assert.equal((await service.act(action(f.memberId))).status,'replayed');assert.equal(commits,1);
});

test('member reads derive counts and activity from stored Work and all conversation segments',async()=>{
 const f=await setup(),mission=(id:string)=>createMission({id,purpose:'Fixture requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner',oracle:'bounded-text-review/v1'}},owner);
 const work=(title:string,memberId=f.memberId):Work=>{
  const messageId=ownerMessageId(title),turnId=assistantTurnId(messageId),message={id:messageId,ordinal:1,actorId:owner.id,role:'owner' as const,turnId:null,text:title};
  const w=apply(mission('intake'),{type:'admit-work',workId:assistantWorkId(turnId),title,budget:8,assistantSource:{segmentId:segmentId(1),turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'fixture'},memberId}},host).value.works[0]!;
  w.execution='active';w.runtimeRun={id:'run-'+title,authorizationId:'fixture-grant',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:4,ownership:{hostSessionId:'fixture-host',dispatchId:'dispatch-'+title,startedAt:T0+10,deadlineAt:T0+100}};return w;
 };
 const works:Work[]=[work('open'),{...work('done'),execution:'settled',acceptance:'failed',endedAt:T0+20},{...work('uncertain'),execution:'blocked',effects:[{id:'effect',taskId:'task',target:'fixture',authority:'fixture-grant',status:'unknown'}]},work('other','other')];
 const save=async(id:string,value:unknown)=>{await f.store.commit({id,expectedRevision:0,commandId:'fixture-'+id,fingerprint:hash(value),value,events:[],outbox:[]});};
 const intake:Mission={...mission('intake'),works,memories:[{id:'mission-only',version:1,scope:'local',authority:'explicit',effective:true,source:'owner',content:'Not member memory'}]};await save('intake',intake);
 // An older intake remains authoritative through its original conversation pin.
 await save('old-intake',{...mission('old-intake'),works:[{...work('old'),execution:'cancelled',endedAt:T0+40}]});
 const segment=(n:number,thread:string):AssistantSegment=>{
  const messageId=ownerMessageId(thread+n),turnId=assistantTurnId(messageId);
  return {kind:'assistant-conversation',id:segmentId(n,thread),segment:n,previous:n===1?null:{id:segmentId(n-1,thread),lastMessageId:'reply-'+ownerMessageId(thread+(n-1))},closed:n===1,timeWatermark:T0+n*10+1,
   messages:[{id:messageId,ordinal:1,actorId:owner.id,role:'owner',turnId:null,at:T0+n*10,text:'Private conversation'},{id:'reply-'+messageId,ordinal:2,actorId:host.id,role:'representative',turnId,at:T0+n*10+1,text:'Private answer'}],turns:[{id:turnId,messageId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'fixture'}]};
 };
 const representative=segment(1,'');representative.turns[0]!.proposal={title:'Old Work'};representative.turns[0]!.outcome={missionId:'old-intake',work:{status:'admitted',diagnostics:[]},run:{status:'not_started',diagnostics:[]}};await save(representative.id,representative);
 for(let n=1;n<=2;n++){const s=segment(n,memberThread(f.memberId));await save(s.id,s);}
 const scheduled=applySchedules(null,{type:'create-schedule',scheduleId:'briefing',kind:'briefing',minute:540,offset:0,budget:{runs:2}},owner,{observedAt:T0}).value;await save(SCHEDULES_ID,scheduled);
 const before=(f.store as InMemoryStore<any>).inspect().length,view=await f.service.read(),m=view.members[0]!;assert.equal(m.completedWorkCount,0);
 assert.deepEqual({workCount:m.workCount,openWorkCount:m.openWorkCount,unknownWorkCount:m.unknownWorkCount,messageCount:m.messageCount,scheduleCount:m.scheduleCount,lastActiveAt:m.lastActiveAt,archivedAt:m.archivedAt,admittedAt:m.admittedAt},
  {workCount:4,openWorkCount:2,unknownWorkCount:1,messageCount:4,scheduleCount:0,lastActiveAt:T0+40,archivedAt:null,admittedAt:T0});
 assert.doesNotMatch(JSON.stringify(view),/Private conversation|Private answer|Not member memory/);
 assert.equal((f.store as InMemoryStore<any>).inspect().length,before,'reads write nothing');
 await f.service.act(action(f.memberId));const retained=await f.service.read();assert.equal(retained.archived[0]!.workCount,4);assert.equal(retained.archived[0]!.messageCount,4);
 assert.deepEqual((await f.store.load('intake'))!.value.works,works);
});

test('legacy members without recorded activity expose null, not an invented last-active time',async()=>{
 const f=await setup(),m=(await f.service.read()).members[0]!;assert.equal(m.archivedAt,null);assert.equal(m.lastActiveAt,null);assert.equal(m.workCount,0);assert.equal(m.messageCount,0);
});

test('member metadata never mixes database feeds or keeps a cached member after replacement',async()=>{
 const f=await setup(),replacement=new InMemoryStore<any>();let current=f.store,reads=0;
 const store=new Proxy(f.store,{get(_target,key){if(key==='readState')return async(id?:string)=>{const read=await current.readState(id);if(++reads===2)current=replacement;return read;};const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;}});
 const service=new MembersService(store,()=>'intake',()=>T0+100),view=await service.read();assert.deepEqual(view.members,[]);assert.equal(view.feedId,(await replacement.readState()).feedId);
 assert.deepEqual(await service.roster(),[]);
});

test('archive input is frozen before an asynchronous load',async()=>{
 const f=await setup();let held=()=>{},release=()=>{},armed=true;const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(armed){armed=false;held();await gate;}return target.load(id);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const input=action(f.memberId),pending=new MembersService(store,()=>'intake',()=>T0+100).act(input);await reached;input.memberId='other';release();assert.equal((await pending).status,'committed');assert.ok((await f.service.member(f.memberId))!.archivedAt!==undefined);
});

test('member screen fixtures use production lifecycle reads and consistently remap the original member references',async()=>{
 const {memberLifecycleFixture}=await import('../scripts/ui-contracts/member-lifecycle-fixtures.ts');
 for(const screen of ['B13','B19','B19-juno']){
  const source=JSON.parse(await readFile(new URL('../scripts/ui-contracts/fixtures/'+screen+'.json',import.meta.url),'utf8')),original=structuredClone(source),fixture=await memberLifecycleFixture(source),view=fixture.routes['/assistant/members']!.body as Awaited<ReturnType<MembersService['read']>>;
  assert.deepEqual(source,original,'the source fixture remains unchanged');assert.deepEqual(view.members.map(m=>m.name),['퀼','주노']);assert.equal(view.archived.length,1);assert.equal(view.archived[0]!.archivedAt,source.now);
  const before=source.routes['/assistant/conversation'].body,after=fixture.routes['/assistant/conversation']!.body as typeof before;
  assert.equal(view.feedId,before.feedId);assert.deepEqual(after.members,view.members);assert.deepEqual(after.decisions,before.decisions);
  assert.equal(fixture.screen,source.screen);assert.equal(fixture.description,source.description);assert.equal(fixture.now,source.now);assert.deepEqual(fixture.gaps,source.gaps);
  assert.ok(!JSON.stringify(fixture).includes('member-quill'));assert.ok(!JSON.stringify(fixture).includes('member-juno'));
  const selected=view.members[screen==='B19-juno'?1:0]!;assert.ok(fixture.steps.some(s=>s.action!=='offline'&&s.readySelector==='#settings-member-'+selected.id));
  const skills=(fixture.routes['/assistant/skills']!.body as any).skills;assert.ok(skills.every((s:any)=>view.members.some(m=>m.id===s.memberId)));
  for(const m of [...view.members,...view.archived]){const coding=screen==='B13'&&m.modelGroup==='coding';assert.equal(m.scheduleCount,screen==='B19'&&m.id===selected.id?2:0);assert.equal(m.workCount,coding?1:0);assert.equal(m.lastActiveAt,coding?source.now-240000:screen==='B19'&&m.id===selected.id?source.now:null);assert.equal(m.messageCount,screen==='B19'&&m.id===selected.id?2:0);}
  if(screen==='B13')assert.deepEqual(fixture.routes['/assistant/schedules'],source.routes['/assistant/schedules']);else assert.equal(view.members.find(m=>m.id===selected.id)!.builtinSkills.length,2);assert.ok(fixture.reuse.some(s=>s.includes('member-lifecycle-fixtures.ts')));
 }
 const unrelated=JSON.parse(await readFile(new URL('../scripts/ui-contracts/fixtures/B12.json',import.meta.url),'utf8'));assert.deepEqual(await memberLifecycleFixture(unrelated),unrelated);
});

test('new admission can be undone once without deleting identity; used members cannot be undone',async()=>{
 const f=await setup();
 // The service enables undo only on new admissions; historical commands stay unchanged.
 await f.service.act(action(f.memberId));
 const proposalId=PROPOSAL_PREFIX+'undo',decisionId=proposalDecisionId(proposalId);
 const snapshot=(await f.store.load(MEMBERS_ID))!;
 const proposed=applyMembers(snapshot.value,{type:'propose-member',decisionId,topic:'Writing',works:[{title:'One'},{title:'Two'}],count:2},host,{observedAt:T0});
 await f.store.commit({id:MEMBERS_ID,expectedRevision:snapshot.revision,commandId:proposalId,fingerprint:hash({actorId:host.id,command:(proposed.events[0] as any).command}),...proposed,outbox:[]});
 await f.service.decide({commandId:'admit-undo',decisionId,answer:'act',member:{name:'Lake',shape:'round'}});
 const memberId=admittedMemberId('admit-undo'),input={commandId:'undo-admission',action:'undo',memberId};
 assert.equal((await f.service.read()).decisions.at(-1)!.undoable,true);
 assert.equal((await f.service.act(input)).status,'committed');
 assert.equal((await f.service.act(input)).status,'replayed');
 assert.equal((await f.service.member(memberId))!.archivedAt,T0);
 assert.equal((await f.service.outcome(input)).status,'replayed');
 await f.service.act(action(memberId,'unarchive','restore-undone'));
 await assert.rejects(f.service.act({...input,commandId:'undo-again'}),/undo/i);
 const ops=(f.store as InMemoryStore<any>).inspect().filter(o=>o.aggregateId===MEMBERS_ID);
 for(let i=0;i<ops.length;i++)replayMembers(ops[i]!,ops[i-1]);
});

test('undo and first member use contend on one durable revision; the loser cannot reopen admission',async()=>{
 const f=await setup(undefined,true);let armed=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(armed){armed=false;await f.service.use(f.memberId);}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const pending=new MembersService(store,()=>'intake',()=>T0).act({commandId:'racing-undo',action:'undo',memberId:f.memberId});
 await assert.rejects(pending,/undo window/);assert.equal((await f.service.member(f.memberId))!.archivedAt,undefined);
 const other=await setup(undefined,true);await other.service.act({commandId:'undo-first',action:'undo',memberId:other.memberId});await assert.rejects(other.service.use(other.memberId),/unavailable/);
});

test('overlapping undo replays after the load and ambiguous undo commits are reconciled without rewriting',async()=>{
 const f=await setup(undefined,true),input={commandId:'overlap-undo',action:'undo',memberId:f.memberId};let armed=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(armed&&id===MEMBERS_ID){armed=false;await f.service.act(input);}return target.load(id);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await new MembersService(store,()=>'intake',()=>T0).act(input)).status,'replayed');
 const other=await setup(undefined,true);let commits=0;
 const unknown=new Proxy(other.store,{get(target,key){if(key==='commit')return async(input:any)=>{commits++;await target.commit(input);throw new CommitOutcomeUnknownError(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=new MembersService(unknown,()=>'intake',()=>T0),undo={...input,memberId:other.memberId};await assert.rejects(service.act(undo),CommitOutcomeUnknownError);
 assert.equal((await service.outcome(undo)).status,'replayed');assert.equal(commits,1);
});

test('undo through a draining owner store commits nothing; archive and restore permanently close its window',async()=>{
 const f=await setup(undefined,true),ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return ()=>{throw new Error('Host is draining');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(new MembersService(ownerStore,()=>'intake',()=>T0).act({commandId:'drained-undo',action:'undo',memberId:f.memberId}),/draining/);
 assert.equal((await f.service.read()).decisions[0]!.undoable,true);
 await f.service.act(action(f.memberId));await f.service.act(action(f.memberId,'unarchive'));
 await assert.rejects(f.service.act({commandId:'after-restore',action:'undo',memberId:f.memberId}),/undo window/);
});

test('admission screen fixtures expose actual undo eligibility and member-authored messages',async()=>{
 const {loadFixture}=await import('../scripts/ui-contracts/fixture-host.ts');
 for(const screen of ['B11-quill','B21-done-hana']){
  const fixture=await loadFixture(screen),view=fixture.routes['/assistant/conversation']!.body as any;assert.deepEqual(fixture.gaps,[]);
  if(screen==='B11-quill'){assert.equal(view.segment.messages.at(-1).member.name,'퀼');assert.ok(view.members.some((m:any)=>m.id===view.segment.messages.at(-1).member.id));}
  else {assert.equal(view.decisions[0].undoable,true);assert.ok(view.members.some((m:any)=>m.id===view.decisions[0].memberId));}
 }
});

test('an admission accepted before undo existed still replays its original owner answer after upgrade',async()=>{
 const f=await setup();assert.equal((await f.service.decide({commandId:'admit-lifecycle',decisionId:proposalDecisionId(PROPOSAL_PREFIX+'lifecycle'),answer:'act',member:{name:'River',shape:'drop'}})).status,'replayed');
 assert.equal((await f.service.member(f.memberId))!.admissionOpen,undefined);
});
