import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Application} from '../src/application.ts';
import {apply,createMission,hash,workInputHash,canonical} from '../src/domain.ts';
import type {Actor,Command,Mission} from '../src/domain.ts';
import {InMemoryStore,SurrealStore} from '../src/storage.ts';
import type {Operation,PortableJournal,Store} from '../src/storage.ts';
import {AssistantConversation,applyAssistant,segmentId,ownerMessageId,assistantTurnId,assistantWorkId,assistantRunId,hasRoom,headSegment,ASSISTANT_ACTOR_ID,PENDING_GRACE_MS,SEGMENT_MESSAGES,SEGMENT_BYTES,MESSAGE_BYTES} from '../src/assistant-conversation.ts';
import type {AssistantCommand,AssistantSegment,AssistantSource} from '../src/assistant-conversation.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {MISSION_CATALOG_QUERY,SurrealMissionCatalog} from '../src/mission-catalog.ts';
import {WORK_INBOX_QUERY,SurrealWorkInbox} from '../src/work-inbox.ts';
import {createWorkbench} from '../src/server.ts';

const OWNER='local-owner',owner:Actor={id:OWNER,roles:['owner']},assistant:Actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']},representative:Actor={id:'representative',roles:['representative']};
const actors=[owner,assistant,representative];
const route={profileId:'representative-profile',configHash:'c'.repeat(64),provider:'fixture',model:'fixture-representative',mode:'mock-http' as const,outputTokenCap:256};
const START=1_000_000;
const pending=(messageId:string,startedAt:number,dispatchId='dispatch-'+messageId.slice(2,10))=>({status:'pending' as const,id:assistantTurnId(messageId),route,ownership:{hostSessionId:'host:test',dispatchId,startedAt,deadlineAt:startedAt+120_000},requestHash:hash({request:messageId}),contextMessageIds:[]});
const notStarted=(messageId:string)=>({status:'not_started' as const,id:assistantTurnId(messageId),diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]});
const usage={inputTokens:10,outputTokens:20};
const receipt='{"status":"succeeded"}';

function harness(store:Store<any>=new InMemoryStore<any>()) {
 const clock={now:START};const conversation=new AssistantConversation(store,actors,()=>clock.now);
 const head=async(n:number)=>(await store.load(segmentId(n)))! as {revision:number;value:AssistantSegment};
 /** Owner message on segment n (opens n when absent). */
 const say=async(n:number,commandId:string,text='Hello',turn:'pending'|'not_started'='pending',expectedRevision?:number)=>{
  const messageId=ownerMessageId(commandId),current=await store.load(segmentId(n)) as {revision:number;value:AssistantSegment}|null,t=turn==='pending'?pending(messageId,clock.now):notStarted(messageId);
  const previousSegment=n>1?(await head(n-1)).value:null;
  const command:AssistantCommand=current||expectedRevision!==undefined&&expectedRevision>0?{type:'append-assistant-message',messageId,text,turn:t}:{type:'open-assistant-segment',segment:n,previous:previousSegment?{id:previousSegment.id,lastMessageId:previousSegment.messages.at(-1)!.id}:null,messageId,text,turn:t};
  return conversation.dispatch({segment:n,commandId,expectedRevision:expectedRevision??current?.revision??0,actorId:OWNER,command});
 };
 const settle=async(n:number,turnId:string,status:'answered'|'failed'|'unknown'='answered',proposal:{title:string}|null=null,reply='Answer')=>conversation.dispatch({segment:n,commandId:'assistant-settle:'+turnId,expectedRevision:(await head(n)).revision,actorId:ASSISTANT_ACTOR_ID,command:status==='answered'?{type:'settle-assistant-turn',turnId,status,usage,receipt,reply,proposal}:{type:'settle-assistant-turn',turnId,status,usage:{inputTokens:null,outputTokens:null},receipt}});
 const close=async(n:number)=>conversation.dispatch({segment:n,commandId:'assistant-close:'+n,expectedRevision:(await head(n)).revision,actorId:OWNER,command:{type:'close-assistant-segment',segment:n}});
 /** Exchange: owner message plus an answered reply. */
 const exchange=async(n:number,commandId:string,text='Hello',proposal:{title:string}|null=null)=>{const r=await say(n,commandId,text);assert.equal(r.status,'committed');return settle(n,assistantTurnId(ownerMessageId(commandId)),'answered',proposal);};
 return {store,clock,conversation,head,say,settle,close,exchange};
}
function journal(store:InMemoryStore<any>):PortableJournal<Mission>{const operations=structuredClone(store.inspect());return {schemaVersion:2,head:operations.length,operations:[...operations]};}
const expectError=(code:string,pattern?:RegExp)=>(error:any)=>error?.code===code&&(!pattern||pattern.test(error.message));
const reactor=(operation:Operation<any>,actorId:string)=>{const event=operation.events[0] as any;event.actor=actorId;operation.fingerprint=hash({actorId,command:event.command,expectedRevision:operation.expectedRevision});};

async function intake(store:Store<any>) {
 const app=new Application(store,[owner,assistant,representative]);
 await app.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},OWNER,'create-intake');
 const send=async(command:Command,actorId:string,commandId:string)=>app.dispatch({missionId:'intake',commandId,expectedRevision:(await store.load('intake'))!.revision,actorId,command});
 return {app,send};
}
async function sourceFor(h:ReturnType<typeof harness>,n:number,commandId:string):Promise<AssistantSource>{
 const segment=(await h.head(n)).value,messageId=ownerMessageId(commandId),message=segment.messages.find(m=>m.id===messageId)!;
 return {segmentId:segment.id,turnId:assistantTurnId(messageId),messageId,messageHash:hash(message),message:structuredClone(message),representative:{provider:route.provider,model:route.model}};
}

test('roles: owner writes messages, only the assistant actor settles, and the assistant role is narrow',async()=>{
 const h=harness();assert.equal((await h.say(1,'c1')).status,'committed');const turnId=assistantTurnId(ownerMessageId('c1'));
 await assert.rejects(h.conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:OWNER,command:{type:'settle-assistant-turn',turnId,status:'unknown',usage:{inputTokens:null,outputTokens:null},receipt}}),expectError('denied'));
 await assert.rejects(h.conversation.dispatch({segment:1,commandId:'c2',expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'append-assistant-message',messageId:ownerMessageId('c2'),text:'x',turn:notStarted(ownerMessageId('c2'))}}),expectError('denied'));
 await assert.rejects(h.conversation.dispatch({segment:1,commandId:'assistant-close:1',expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'close-assistant-segment',segment:1}}),expectError('denied'));
 assert.equal((await h.settle(1,turnId,'answered',{title:'Write a summary'})).status,'committed');
 await assert.rejects(h.conversation.dispatch({segment:1,commandId:'assistant-outcome:'+turnId,expectedRevision:2,actorId:OWNER,command:{type:'record-assistant-outcome',turnId,work:{status:'not_created',diagnostics:[]},run:{status:'off',diagnostics:[]}}}),expectError('denied'));
 const mission=createMission({id:'intake',purpose:'p',scope:'local',constraints:[],criteria:{version:1,description:'d',oracle:'bounded-text-review/v1'}},owner);
 for(const command of [{type:'admit-work',workId:'w',title:'t',budget:1},{type:'cancel',workId:'w'},{type:'save-memory',memory:{id:'m',version:1,scope:'local',authority:'learned',content:'c',source:'s',effective:false}},{type:'block-work',workId:'w',blocker:{code:'provider_failed',detail:'d'}},{type:'delegate',workId:'w',taskId:'t',parentId:'w:root'},{type:'accept',workId:'w',recordId:'r'}] as Command[]){
  const state=command.type==='admit-work'||command.type==='save-memory'?mission:apply(mission,{type:'admit-work',workId:'w',title:'t',budget:1},owner).value;
  assert.throws(()=>apply(state,command,assistant),expectError('denied'),command.type);
 }
 assert.throws(()=>apply(mission,{type:'propose-growth',proposal:{id:'g',proposer:ASSISTANT_ACTOR_ID,target:'memory',baseline:'a@1',candidate:'b@1',counterevidence:'c',status:'proposed'}},assistant),expectError('denied'));
});

test('appending checks host time, turn identity and settles an expired pending turn unknown',async()=>{
 const h=harness();assert.equal((await h.say(1,'c1')).status,'committed');
 const messageId=ownerMessageId('c2'),base=pending(messageId,START);
 for(const turn of [{...base,ownership:{...base.ownership,startedAt:START+1,deadlineAt:START+100}},{...base,ownership:{...base.ownership,startedAt:START-200,deadlineAt:START}},{...base,id:assistantTurnId(ownerMessageId('other'))}])
  await assert.rejects(h.conversation.dispatch({segment:1,commandId:'c2',expectedRevision:1,actorId:OWNER,command:{type:'append-assistant-message',messageId,text:'Second',turn}}),expectError('invalid'));
 h.clock.now=START+1000;await assert.rejects(h.say(1,'c2','Second'),expectError('conflict',/answer_in_progress/));
 h.clock.now=START+120_000+PENDING_GRACE_MS;assert.equal((await h.say(1,'c2','Second')).status,'committed');
 const segment=(await h.head(1)).value;assert.deepEqual(segment.turns.map(t=>t.status),['unknown','pending']);assert.equal(segment.timeWatermark,h.clock.now);assert.equal(segment.messages.length,2);
});

test('settle: late answer refused, unknown accepted, no second settle, nothing lands in a closed segment',async()=>{
 const h=harness();await h.say(1,'c1');const turnId=assistantTurnId(ownerMessageId('c1'));
 h.clock.now=START+120_000;await assert.rejects(h.settle(1,turnId,'answered'),expectError('invalid'));await assert.rejects(h.settle(1,turnId,'failed'),expectError('invalid'));
 assert.equal((await h.settle(1,turnId,'unknown')).status,'committed');
 await assert.rejects(h.conversation.dispatch({segment:1,commandId:'assistant-settle-again',expectedRevision:2,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',turnId,status:'unknown',usage:{inputTokens:null,outputTokens:null},receipt}}),expectError('invalid'));
 const value=(await h.head(1)).value,closedState={...structuredClone(value),closed:true,turns:[...value.turns,{...pending(ownerMessageId('c9'),START+120_000),messageId:ownerMessageId('c9')}]};
 assert.throws(()=>applyAssistant(closedState,{type:'settle-assistant-turn',turnId:assistantTurnId(ownerMessageId('c9')),status:'unknown',usage:{inputTokens:null,outputTokens:null},receipt},assistant,{observedAt:START+120_001}),/closed/);
});

test('every segment command refuses a host time below the watermark',async()=>{
 const h=harness();await h.say(1,'c1');const turnId=assistantTurnId(ownerMessageId('c1'));const segment=(await h.head(1)).value,late={observedAt:START-1};
 const full={...structuredClone(segment),turns:[{...segment.turns[0]!,status:'unknown' as const}]};while(full.messages.length<SEGMENT_MESSAGES)full.messages.push({...segment.messages[0]!,id:'m:'+full.messages.length,ordinal:full.messages.length+1});
 for(const [state,command,actor] of [[segment,{type:'append-assistant-message',messageId:ownerMessageId('c2'),text:'x',turn:notStarted(ownerMessageId('c2'))},owner],[segment,{type:'settle-assistant-turn',turnId,status:'unknown',usage:{inputTokens:null,outputTokens:null},receipt},assistant],[full,{type:'close-assistant-segment',segment:1},owner]] as [AssistantSegment,AssistantCommand,Actor][])
  assert.throws(()=>applyAssistant(state,command,actor,late),/watermark/);
 const answered=applyAssistant(segment,{type:'settle-assistant-turn',turnId,status:'answered',usage,receipt,reply:'r',proposal:{title:'t'}},assistant,{observedAt:START+1}).value;
 assert.throws(()=>applyAssistant(answered,{type:'record-assistant-outcome',turnId,work:{status:'not_created',diagnostics:[]},run:{status:'off',diagnostics:[]}},assistant,{observedAt:START}),/watermark/);
 assert.throws(()=>applyAssistant(null,{type:'open-assistant-segment',segment:1,previous:null,messageId:ownerMessageId('c1'),text:'x',turn:pending(ownerMessageId('c1'),START)},owner,undefined),/clock|time/);
});

test('admit-work with assistantSource: assistant role only, self-consistent pin, deterministic Work and run identities',async()=>{
 const h=harness();await h.exchange(1,'c1','Please summarize the notes',{title:'Summarize the notes'});const {send}=await intake(h.store);const source=await sourceFor(h,1,'c1'),workId=assistantWorkId(source.turnId);
 const admit=(extra:Partial<{workId:string;assistantSource:AssistantSource;conversationSource:any}>={}):Command=>({type:'admit-work',workId,title:'Summarize the notes',budget:512,assistantSource:source,...extra} as Command);
 for(const actorId of [OWNER,'representative'])await assert.rejects(send(admit(),actorId,'assistant-work:x'),expectError('denied'));
 for(const command of [admit({assistantSource:{...source,messageHash:'0'.repeat(64)}}),admit({workId:'assistant-other'}),admit({assistantSource:{...source,message:{...source.message,role:'representative'} as any}}),admit({assistantSource:{...source,turnId:'assistant-turn:m:other'}}),admit({conversationSource:{messageIds:['x']}})])
  await assert.rejects(send(command,ASSISTANT_ACTOR_ID,'assistant-work:'+source.turnId),expectError('invalid'));
 assert.equal((await send(admit(),ASSISTANT_ACTOR_ID,'assistant-work:'+source.turnId)).status,'committed');
 const work=(await h.store.load('intake'))!.value.works[0]!;assert.deepEqual(work.assistantSource,source);
 {const plain=structuredClone(work);delete plain.assistantSource;assert.notEqual(workInputHash(work),workInputHash(plain));}
 const run=(id:string)=>({id,authorizationId:'auth',criteriaHash:hash(work.criteria),inputHash:workInputHash(work),mode:'mock-http' as const,outputTokenCap:256});
 await assert.rejects(send({type:'activate-runtime',workId,run:run('other-run')},ASSISTANT_ACTOR_ID,'assistant-activate-other'),expectError('denied'));
 assert.equal((await send({type:'activate-runtime',workId,run:run(assistantRunId(source.turnId))},ASSISTANT_ACTOR_ID,'assistant-activate')).status,'committed');
});

test('segment bounds: 15 or 16 messages make it full and a reply never passes 16 messages or 64 KiB',async()=>{
 const h=harness();const big='가'.repeat(Math.floor(MESSAGE_BYTES/3));let i=0;
 while(!(await h.head(1))||hasRoom((await h.head(1)).value)){i++;await h.exchange(1,'c'+i,i%2?big:'short');h.clock.now+=1;assert.ok(i<=8,'segment never filled');}
 const full=(await h.head(1)).value;assert.equal(hasRoom(full),false);assert.ok(full.messages.length<=SEGMENT_MESSAGES&&Buffer.byteLength(JSON.stringify(full),'utf8')<=SEGMENT_BYTES);
 await assert.rejects(h.say(1,'overflow'),expectError('conflict',/segment_full/));
 const few=structuredClone(full);few.messages=few.messages.slice(0,14).map(m=>({...m,text:'s'}));few.turns=few.turns.slice(0,7);assert.equal(hasRoom(few),true);
 for(const count of [15,16]){const s=structuredClone(few);while(s.messages.length<count)s.messages.push({...s.messages[0]!,id:'m:x'+s.messages.length,ordinal:s.messages.length+1});assert.equal(hasRoom(s),false,String(count));}
 const reply='😀'.repeat(MESSAGE_BYTES/4),h2=harness();let k=0;
 while(!(await h2.head(1))||hasRoom((await h2.head(1)).value)){k++;assert.equal((await h2.say(1,'k'+k,big)).status,'committed');assert.equal((await h2.settle(1,assistantTurnId(ownerMessageId('k'+k)),'answered',{title:'T'},reply)).status,'committed');h2.clock.now+=1;assert.ok(k<=8);}
 const last=(await h2.head(1)).value;assert.ok(last.messages.length<=SEGMENT_MESSAGES&&Buffer.byteLength(JSON.stringify(last),'utf8')<=SEGMENT_BYTES);
 await assert.rejects(h2.settle(1,'assistant-turn:m:none','answered',null,reply),expectError('invalid'));
});

test('same commandId replays, including the commit that filled a segment; a full refusal commits nothing',async()=>{
 const h=harness();const first=await h.say(1,'c1','Question');assert.equal(first.status,'committed');
 const replay=await h.conversation.dispatch({segment:1,commandId:'c1',expectedRevision:0,actorId:OWNER,command:{type:'open-assistant-segment',segment:1,previous:null,messageId:ownerMessageId('c1'),text:'Question',turn:pending(ownerMessageId('c1'),START)}});assert.equal(replay.status,'replayed');
 await h.settle(1,assistantTurnId(ownerMessageId('c1')));let i=1;
 let filling:any;while(hasRoom((await h.head(1)).value)){i++;filling={id:'c'+i,revision:(await h.head(1)).revision};assert.equal((await h.say(1,'c'+i,'x'.repeat(3000),'not_started')).status,'committed');}
 const byFilling=await h.conversation.dispatch({segment:1,commandId:filling.id,expectedRevision:filling.revision,actorId:OWNER,command:{type:'append-assistant-message',messageId:ownerMessageId(filling.id),text:'x'.repeat(3000),turn:notStarted(ownerMessageId(filling.id))}});assert.equal(byFilling.status,'replayed');
 const before=(h.store as InMemoryStore<any>).inspect().length;await assert.rejects(h.say(1,'next','After full','not_started'),expectError('conflict',/segment_full/));assert.equal((h.store as InMemoryStore<any>).inspect().length,before);
 assert.equal((await h.close(1)).status,'committed');assert.equal((await h.say(2,'next','After full','not_started')).status,'committed');
 assert.equal((await h.say(2,'c1','Question','not_started',1)).status,'conflict');
});

// 26
test('rollover: close then open with previous, racing opens give one commit, late settle refused, head search finds the newest',async()=>{
 const h=harness();assert.equal(await headSegment(h.store),0);await h.say(1,'c0','first');await h.settle(1,assistantTurnId(ownerMessageId('c0')));let i=0;
 while(hasRoom((await h.head(1)).value)){h.clock.now+=120_000+PENDING_GRACE_MS;await h.say(1,'f'+ ++i,'x'.repeat(2000));}
 const lastTurn=assistantTurnId(ownerMessageId('f'+i));await assert.rejects(h.say(2,'early','too soon','not_started'),/closed/);await assert.rejects(h.close(1),expectError('conflict',/answer_in_progress/));
 h.clock.now+=120_000+PENDING_GRACE_MS;assert.equal((await h.close(1)).status,'committed');const closed=(await h.head(1)).value;assert.equal(closed.closed,true);assert.equal(closed.turns.at(-1)!.status,'unknown');
 await assert.rejects(h.settle(1,lastTurn,'unknown'),expectError('invalid',/closed/));
 const previous={id:segmentId(1),lastMessageId:(await h.head(1)).value.messages.at(-1)!.id};
 const open=(commandId:string)=>h.conversation.dispatch({segment:2,commandId,expectedRevision:0,actorId:OWNER,command:{type:'open-assistant-segment',segment:2,previous,messageId:ownerMessageId(commandId),text:'race '+commandId,turn:notStarted(ownerMessageId(commandId))}});
 await assert.rejects(h.conversation.dispatch({segment:2,commandId:'wrong-prev',expectedRevision:0,actorId:OWNER,command:{type:'open-assistant-segment',segment:2,previous:{...previous,lastMessageId:'m:wrong'},messageId:ownerMessageId('wrong-prev'),text:'x',turn:notStarted(ownerMessageId('wrong-prev'))}}),/previous/);
 const results=await Promise.all([open('a'),open('b')]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','conflict']);
 await assert.rejects(h.conversation.dispatch({segment:3,commandId:'skip',expectedRevision:0,actorId:OWNER,command:{type:'open-assistant-segment',segment:3,previous:{id:segmentId(2),lastMessageId:'m:x'},messageId:ownerMessageId('skip'),text:'skip',turn:notStarted(ownerMessageId('skip'))}}),/closed/);
 assert.equal(await headSegment(h.store),2);
 const s2=(await h.head(2)).value;assert.deepEqual(s2.previous,previous);assert.equal(s2.segment,2);
 for(let n=3;n<=9;n++){const seg={...structuredClone(s2),id:segmentId(n),segment:n};await h.store.commit({id:segmentId(n),expectedRevision:0,commandId:'raw-'+n,fingerprint:'raw',value:seg,events:[],outbox:[]});}
 assert.equal(await headSegment(h.store),9);
});

// 27
test('Mission readers exclude segments: catalog and inbox queries, createMission prefix, and every Mission route',async t=>{
 assert.match(MISSION_CATALOG_QUERY,/FROM massion_state WHERE aggregateId > \$after AND value\.kind = NONE/);assert.match(WORK_INBOX_QUERY,/FROM massion_state WHERE aggregateId >= \$afterMission AND value\.kind = NONE/);
 let seen='';await new SurrealMissionCatalog({async query(q){seen+=q;return [{feedId:'feed',cursor:1,rows:[]}];}}).readCatalog({});await new SurrealWorkInbox({async query(q){seen+=q;return [{feedId:'feed',cursor:1,rows:[]}];}}).readInbox({});assert.equal(seen.match(/value\.kind = NONE/g)?.length,2);
 assert.throws(()=>createMission({id:'assistant-conversation:1',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'o'}},owner),/reserved/);
 const h=harness();await h.say(1,'c1','hello','not_started');
 const server=createWorkbench(h.store,'.',{neighborhood:{async readNeighborhood(){throw new Error('reader must not run');}} as any});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base='http://127.0.0.1:'+(server.address() as any).port,feed=(await h.store.readState()).feedId,id=encodeURIComponent(segmentId(1));
 for(const path of ['/missions/'+id,'/missions/'+segmentId(1),'/missions/'+id+'/neighborhood?entity=x&version=1','/missions/'+id+'/mission-conversation','/missions/'+id+'/work-conversation?work=w','/missions/'+id+'/run-ownership?work=w','/missions/'+id+'/impact','/missions/'+id+'/memory-usage?id=m&version=1&hash=h'])
  assert.equal((await fetch(base+path)).status,400,path);
 for(const path of ['/missions/'+id+'/work','/missions/'+id+'/run','/missions/'+id+'/preflight','/missions/'+id+'/memory'])
  assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-massion-feed':feed},body:JSON.stringify({commandId:'x',expectedRevision:1})})).status,400,path);
 assert.equal((await fetch(base+'/missions',{method:'POST',headers:{'Content-Type':'application/json','x-massion-feed':feed},body:JSON.stringify({commandId:'create',id:segmentId(5),purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'o'}})})).status,400);
 assert.equal(await h.store.load(segmentId(5)),null);
});

async function lineageFixture(store:Store<any>=new InMemoryStore<any>()) {
 const h=harness(store);await h.exchange(1,'c1','Draft a short release note',{title:'Draft release note'});
 const {send}=await intake(h.store);const source=await sourceFor(h,1,'c1'),workId=assistantWorkId(source.turnId);
 assert.equal((await send({type:'admit-work',workId,title:'Draft release note',budget:512,assistantSource:source},ASSISTANT_ACTOR_ID,'assistant-work:'+source.turnId)).status,'committed');
 assert.equal((await h.conversation.dispatch({segment:1,commandId:'assistant-outcome:'+source.turnId,expectedRevision:(await h.head(1)).revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'record-assistant-outcome',turnId:source.turnId,work:{status:'admitted',diagnostics:[]},run:{status:'requested',diagnostics:[]}}})).status,'committed');
 const work=(await h.store.load('intake'))!.value.works[0]!;
 assert.equal((await send({type:'activate-runtime',workId,run:{id:assistantRunId(source.turnId),authorizationId:'auth',criteriaHash:hash(work.criteria),inputHash:workInputHash(work),mode:'mock-http',outputTokenCap:256}},ASSISTANT_ACTOR_ID,'assistant-activate:'+source.turnId)).status,'committed');
 h.clock.now+=1;await h.say(1,'c2','A question left pending');
 return {h,send,source,workId};
}

// 28
test('portable backup keeps segments and pins; lineage replays recorded time and rejects tampering',async t=>{
 const {h,send,source}=await lineageFixture();const store=h.store as InMemoryStore<any>;
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'massion-assistant-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const serialized=await exportPortableBackup({exportJournal:async()=>journal(store)},new TextArtifactStore(join(root,'a')));const backup=parsePortableBackup(serialized);
 const segmentOps=backup.journal.operations.filter(o=>o.aggregateId===segmentId(1));assert.ok(segmentOps.length>=4);assert.ok(segmentOps.every(o=>typeof (o.events[0] as any).time.observedAt==='number'));
 assert.ok(Date.now()>START+120_000+PENDING_GRACE_MS);assert.equal((segmentOps.at(-1)!.value as any).turns.at(-1).status,'pending');
 assert.deepEqual((backup.journal.operations.findLast(o=>o.aggregateId==='intake')!.value as Mission).works[0]!.assistantSource,source);
 validateMissionJournalLineage(journal(store).operations);
 const reject=(mutate:(ops:Operation<any>[])=>void,pattern:RegExp)=>{const ops=journal(store).operations as Operation<any>[];mutate(ops);assert.throws(()=>validateMissionJournalLineage(ops),pattern);};
 const segOp=(ops:Operation<any>[],type:string)=>ops.find(o=>o.aggregateId===segmentId(1)&&(o.events[0] as any).type===type)!;
 const missionOp=(ops:Operation<any>[],type:string)=>ops.find(o=>o.aggregateId==='intake'&&(o.events[0] as any).type===type)!;
 reject(ops=>{segOp(ops,'open-assistant-segment').value.messages[0].text='Tampered';},/transition|mismatch/);
 reject(ops=>{const op=segOp(ops,'settle-assistant-turn');(op.events[0] as any).time.observedAt=START-5;},/watermark|time/);
 reject(ops=>reactor(missionOp(ops,'admit-work'),OWNER),/assistant/);
 reject(ops=>reactor(missionOp(ops,'activate-runtime'),OWNER),/assistant/);
 reject(ops=>{const op=missionOp(ops,'admit-work');op.commandId='other-command';},/assistant-work/);
 reject(ops=>{const settleAt=ops.findIndex(o=>o.aggregateId===segmentId(1)&&(o.events[0] as any).type==='settle-assistant-turn');const [settle]=ops.splice(settleAt,1);ops.splice(ops.findIndex(o=>o.aggregateId==='intake'&&(o.events[0] as any).type==='admit-work')+1,0,settle!);},/answered|turn/);
 // A pin to a missing message, an unsettled turn and a differing title pass the domain's self-consistency check but fail cross-aggregate lineage.
 const fake={...source.message,id:ownerMessageId('ghost'),text:'Never said'},ghost:AssistantSource={...source,messageId:fake.id,turnId:assistantTurnId(fake.id),message:fake,messageHash:hash(fake)};
 assert.equal((await send({type:'admit-work',workId:assistantWorkId(ghost.turnId),title:'Ghost',budget:512,assistantSource:ghost},ASSISTANT_ACTOR_ID,'assistant-work:'+ghost.turnId)).status,'committed');
 assert.throws(()=>validateMissionJournalLineage(journal(store).operations),/turn|message/);
 const h2=harness();await h2.say(1,'p1','Pending request');const {send:send2}=await intake(h2.store);const unsettled=await sourceFor(h2,1,'p1');
 assert.equal((await send2({type:'admit-work',workId:assistantWorkId(unsettled.turnId),title:'Pending',budget:512,assistantSource:unsettled},ASSISTANT_ACTOR_ID,'assistant-work:'+unsettled.turnId)).status,'committed');
 assert.throws(()=>validateMissionJournalLineage(journal(h2.store as InMemoryStore<any>).operations),/answered/);
 const h3=harness();await h3.exchange(1,'t1','Title check',{title:'Proposed title'});const {send:send3}=await intake(h3.store);const titled=await sourceFor(h3,1,'t1');
 assert.equal((await send3({type:'admit-work',workId:assistantWorkId(titled.turnId),title:'Different title',budget:512,assistantSource:titled},ASSISTANT_ACTOR_ID,'assistant-work:'+titled.turnId)).status,'committed');
 assert.throws(()=>validateMissionJournalLineage(journal(h3.store as InMemoryStore<any>).operations),/title/);
 // Open of n + 1 before n closed, written below the host check.
 const h4=harness();await h4.say(1,'o1','one','not_started');const first=(await h4.head(1)).value,messageId=ownerMessageId('o2');
 const command:AssistantCommand={type:'open-assistant-segment',segment:2,previous:{id:segmentId(1),lastMessageId:first.messages.at(-1)!.id},messageId,text:'two',turn:notStarted(messageId)};
 const {value,events}=applyAssistant(null,command,owner,{observedAt:START});
 await h4.store.commit({id:segmentId(2),expectedRevision:0,commandId:'o2',fingerprint:hash({actorId:OWNER,command,expectedRevision:0}),value,events,outbox:[]});
 assert.throws(()=>validateMissionJournalLineage(journal(h4.store as InMemoryStore<any>).operations),/closed/);
 // Deterministic host step identities.
 reject(ops=>{const op=segOp(ops,'settle-assistant-turn');op.commandId='settle-other';},/assistant-settle/);
});

test('actual SurrealDB stores segments beside Missions, keeps them out of catalog and inbox, and restores them',{skip:process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const {growthStore}=await import('./support/growth-fixture.ts'),{restorePortableBackup}=await import('../src/portable-backup.ts');
 const {store,transport}=await growthStore(true);assert.ok(store instanceof SurrealStore);
 const {h}=await lineageFixture(store);const messageId=ownerMessageId('c1');assert.equal((await h.conversation.dispatch({segment:1,commandId:'c1',expectedRevision:0,actorId:OWNER,command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:'Draft a short release note',turn:pending(messageId,START)}})).status,'replayed');
 const catalog=await new SurrealMissionCatalog(transport!).readCatalog({});assert.deepEqual(catalog.items.map(i=>i.missionId),['intake']);
 const inbox=await new SurrealWorkInbox(transport!).readInbox({});assert.ok(inbox.items.every(i=>i.missionId==='intake'));
 assert.equal(await headSegment(store),1);
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'massion-assistant-db-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const serialized=await exportPortableBackup(store,new TextArtifactStore(join(root,'a')));const target=await growthStore(true);assert.ok(target.store instanceof SurrealStore);
 await restorePortableBackup(serialized,target.store,join(root,'restored'));assert.deepEqual(await target.store.load(segmentId(1)),await store.load(segmentId(1)));
 assert.equal(canonical((await target.store.exportJournal()).operations.map(o=>o.value)),canonical((await store.exportJournal()).operations.map(o=>o.value)));
});

async function plainRun() {
 const h=harness();await h.say(1,'c1','hello','not_started');const {send}=await intake(h.store);
 assert.equal((await send({type:'admit-work',workId:'w1',title:'Plain',budget:512} as Command,OWNER,'admit-w1')).status,'committed');
 const work=(await h.store.load('intake'))!.value.works[0]!;
 assert.equal((await send({type:'activate-runtime',workId:'w1',run:{id:'assistant-retry-1',authorizationId:'auth',criteriaHash:hash(work.criteria),inputHash:workInputHash(work),mode:'mock-http',outputTokenCap:256}},OWNER,'assistant-retry-1')).status,'committed');
 return {h,send};
}
test('review: an owner run whose ID starts with assistant- still replays in lineage',async()=>{
 const {h}=await plainRun();validateMissionJournalLineage(journal(h.store as InMemoryStore<any>).operations);
});
test('review: callers cannot occupy host command IDs or read a segment through /read-state',async t=>{
 const h=harness();await h.say(1,'c1','hello','not_started');await intake(h.store);
 const server=createWorkbench(h.store,'.');server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base='http://127.0.0.1:'+(server.address() as any).port,feed=(await h.store.readState()).feedId,before=(await h.store.readState()).cursor;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-massion-feed':feed},body:JSON.stringify(body)});
 assert.equal((await post('/missions',{commandId:'assistant-close:1',id:'m2',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'o'}})).status,400);
 for(const path of ['commands','run','work'])assert.equal((await post('/missions/intake/'+path,{commandId:'assistant-settle:'+assistantTurnId(ownerMessageId('c1')),expectedRevision:1,workId:'w1',title:'t',budget:512})).status,400,path);
 assert.equal((await h.store.readState()).cursor,before);
 assert.equal((await fetch(base+'/read-state?mission='+segmentId(1))).status,400);
});
test('review: lineage refuses a Mission created by the assistant actor',async()=>{
 const store=new InMemoryStore<any>();await intake(store);validateMissionJournalLineage(journal(store).operations);const ops=journal(store).operations as Operation<any>[],created=ops.find(o=>o.aggregateId==='intake')!,{id,purpose,scope,constraints,criteria}=created.value;
 (created.events[0] as any).actor=ASSISTANT_ACTOR_ID;created.fingerprint=hash({actorId:ASSISTANT_ACTOR_ID,input:{id,purpose,scope,constraints,criteria},kind:'create'});
 assert.throws(()=>validateMissionJournalLineage(ops),/assistant/);
});
