import {MEMBERS_ID,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX,memberThread} from '../src/members.ts';
import {once} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AssistantService,parseAssistantTurn} from '../src/assistant-service.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,assistantTurnId,ownerMessageId,segmentId} from '../src/assistant-conversation.ts';
import {apply,createMission,hash,workInputHash} from '../src/domain.ts';
import type {Memory,Mission} from '../src/domain.ts';
import {ProductService} from '../src/product.ts';
import {CommitOutcomeUnknownError,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const owner={id:'local-owner',roles:['owner'] as const},member={id:admittedMemberId('memory-member'),name:'Quill',modelGroup:'default'},route={profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http' as const,outputTokenCap:256};
const body={name:'Preferred summary',content:'Use a short summary.',sourceWorkId:null};
const output=(memory:unknown=body,steer:string|null=null)=>JSON.stringify({reply:'Suggested.',work:null,steer,memory});
async function setup(options:{ownerStore?:(store:InMemoryStore<any>)=>Store<any>;invoke?:()=>void}={}){
 const store=new InMemoryStore<any>(),product=new ProductService(store);await product.create({id:'intake',purpose:'Remember owner instructions',scope:'local',constraints:[],criteria:{version:1,description:'Answer',oracle:'bounded-text-review/v1'}},'create');
 const start=Date.now();let now=start,calls=0,text=output();
 const proposalId=PROPOSAL_PREFIX+'memory',decisionId=proposalDecisionId(proposalId),propose={type:'propose-member' as const,decisionId,topic:'Memory fixture',works:[{title:'Fixture source'}],count:2},admit={type:'admit-member' as const,decisionId,memberId:member.id,name:member.name,shape:'square'};
 let revision=0;for(const [commandId,command,actor] of [[proposalId,propose,{id:ASSISTANT_ACTOR_ID,roles:['assistant']}],['memory-member',admit,owner]] as const){const prior=await store.load(MEMBERS_ID),derived=applyMembers(prior?.value??null,command,actor,{observedAt:start});await store.commit({id:MEMBERS_ID,commandId,fingerprint:hash({actorId:actor.id,command}),expectedRevision:revision++,...derived,outbox:[]});}
 const connections={list:()=>({representative:{intakeMissionId:'intake'}}),resolveMember:async()=>({status:'resolved',route,intakeMissionId:'intake',maxInputBytes:32768,release(){},adapter:{descriptor:{provider:'fixture',model:'fixture',configVersion:'v1',enabled:true,capabilities:[],evidenceClass:'fixture'},async invoke(){calls++;options.invoke?.();return {status:'completed',output:text,usage:{inputTokens:1,outputTokens:1},reason:'fixture'};}}})} as unknown as ConnectionWorkbench;
 const ownerStore=options.ownerStore?.(store)??store,service=()=>new AssistantService(store,product,connections,{member,ownerStore,clock:()=>now,turnTimeoutMs:10000}),chat=service();
 const send=()=>chat.send({commandId:'remark',segment:1,expectedRevision:0,text:'Please remember this preference.'});
 const choice=async(action='save')=>{const v:any=await chat.read(),t=v.turns[0],c=t.memoryCandidate;assert.ok(c,'an answered member turn must expose its typed memory candidate');return {feedId:v.feedId,segment:v.segment.number,expectedRevision:v.segment.revision,turnId:t.id,candidateId:c.id,version:c.version,hash:c.hash,missionRevision:c.missionRevision,action};};
 return {start,store,product,chat,service,send,choice,setText:(v:string)=>text=v,setNow:(v:number)=>now=v,calls:()=>calls,mission:async()=>(await store.load('intake'))!.value as Mission};
}

test('memory parser accepts exact member-only candidates and rejects competing or malformed proposals',()=>{
 const parsed:any=parseAssistantTurn(output(),{steer:true});assert.deepEqual(parsed?.memory,body);
 assert.equal(parseAssistantTurn(output()),null);
 for(const memory of [{...body,extra:true},{...body,name:''},{...body,name:'a\nb'},{...body,content:'\ud800'},{...body,sourceWorkId:7}])assert.equal(parseAssistantTurn(output(memory),{steer:true}),null);
 assert.equal(parseAssistantTurn(output(body,'some-work'),{steer:true}),null);
 assert.equal(parseAssistantTurn(JSON.stringify({reply:'x',work:{title:'T'},memory:body}),{steer:true}),null);
 assert.deepEqual(parseAssistantTurn(output(null),{steer:true}),{reply:'Suggested.',proposal:null});
});

test('memory metadata validates display names and exact same-Mission source Work pins',()=>{
 let mission=createMission({id:'intake',purpose:'P',scope:'local',constraints:[],criteria:{version:1,description:'D',oracle:'manual-review/v1'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'source',title:'Exact title',budget:0},owner).value;const w=mission.works[0]!;
 const sourceWork={missionId:'intake',workId:w.id,title:w.title,inputHash:workInputHash(w),criteriaHash:hash(w.criteria)},memory={id:'named',version:1,scope:'local',authority:'explicit',content:'Instruction',source:'Owner',effective:true,name:'Display name',sourceWork} as Memory;
 assert.deepEqual(apply(mission,{type:'save-memory',memory},owner).value.memories[0],memory);
 for(const patch of [{name:''},{name:'a\nb'},{name:'\ud800'},{sourceWork:{...sourceWork,missionId:'other'}},{sourceWork:{...sourceWork,workId:'missing'}},{sourceWork:{...sourceWork,title:'Wrong'}},{sourceWork:{...sourceWork,inputHash:'0'.repeat(64)}},{sourceWork:{...sourceWork,extra:1}}])assert.throws(()=>apply(mission,{type:'save-memory',memory:{...memory,...patch} as Memory},owner),/memory|Memory|source|Source|name/);
});

test('member proposal is inert; explicit exact save creates one named owner memory and replays safely',async()=>{
 const f=await setup();await f.send();assert.equal((await f.mission()).memories.length,0);const input=await f.choice();
 const [a,b]=await Promise.all([f.chat.decideMemory(input),f.chat.decideMemory(input)]);assert.equal(a.status,'saved');assert.equal(b.status,'saved');assert.equal((await f.mission()).memories.length,1);assert.equal(f.calls(),1);
 const m:any=(await f.mission()).memories[0];assert.equal(m.name,body.name);assert.equal(m.content,body.content);assert.equal(m.authority,'explicit');assert.equal(m.effective,true);assert.equal(m.sourceWork,undefined);
 assert.equal((await f.chat.decideMemory({...input,action:'discard'})).status,'conflict');assert.equal((await f.mission()).memories.length,1);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('discard, mismatched candidate version/hash, stale revision/feed and another member never save',async()=>{
 for(const patch of [{version:2},{hash:'0'.repeat(64)},{candidateId:'other'},{expectedRevision:999},{feedId:'other'},{missionRevision:999}]){const f=await setup();await f.send();const input=await f.choice();await assert.rejects(f.chat.decideMemory({...input,...patch}));assert.equal((await f.mission()).memories.length,0);}
 const f=await setup();await f.send();const input=await f.choice('discard');assert.equal((await f.chat.decideMemory(input)).status,'discarded');assert.equal((await f.mission()).memories.length,0);assert.equal((await f.chat.decideMemory(input)).status,'discarded');
 const other=new AssistantService(f.store,f.product,undefined,{member:{...member,id:'other'}});await assert.rejects(other.decideMemory(await f.choice()));
});

test('owner intent and memory save use drain-aware ownerStore even if drain begins after reads',async()=>{
 let writes=0;const f=await setup({ownerStore:store=>new Proxy(store,{get(target,key){if(key==='commit')return async()=>{writes++;throw new HostDrainError();};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})});await f.send();await assert.rejects(f.chat.decideMemory(await f.choice()),HostDrainError);assert.equal(writes,1);assert.equal((await f.mission()).memories.length,0);
});

test('lost memory-save response reconciles by identity on restart and never resends',async()=>{
 let writes=0;const f=await setup({ownerStore:store=>new Proxy(store,{get(target,key){if(key==='commit')return async(input:any)=>{const r=await target.commit(input);if(input.events[0]?.command.type==='save-memory'){writes++;throw new CommitOutcomeUnknownError(input);}return r;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})});await f.send();const input=await f.choice();assert.equal((await f.chat.decideMemory(input)).status,'saved');assert.equal((await f.service().decideMemory(input)).status,'saved');assert.equal(writes,1);assert.equal((await f.mission()).memories.length,1);
});

test('unknown save intent never dispatches a memory write, including after restart',async()=>{
 let memoryWrites=0;const f=await setup({ownerStore:store=>new Proxy(store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0]?.command.type==='save-memory')memoryWrites++;const r=await target.commit(input);if(input.events[0]?.command.type==='decide-assistant-memory')throw new CommitOutcomeUnknownError(input);return r;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})});await f.send();const input=await f.choice();assert.equal((await f.chat.decideMemory(input)).status,'unknown');assert.equal((await f.service().decideMemory(input)).status,'unknown');assert.equal(memoryWrites,0);assert.equal((await f.mission()).memories.length,0);
});

test('a response reaching the turn deadline has no candidate or automatic memory write',async()=>{
 let clock=()=>{};const f=await setup({invoke:()=>clock()});clock=()=>f.setNow(f.start+10000);await f.send();const v:any=await f.chat.read();assert.equal(v.turns[0].displayStatus,'unknown');assert.equal(v.turns[0].memoryCandidate,undefined);assert.equal((await f.mission()).memories.length,0);
});

async function sourceCandidate(f:Awaited<ReturnType<typeof setup>>){
 const {Application}=await import('../src/application.ts'),{memoryCandidateId,memoryWorkSource}=await import('../src/memory-candidates.ts');
 const app=new Application(f.store,[owner]);await app.dispatch({missionId:'intake',commandId:'source-work',expectedRevision:1,actorId:owner.id,command:{type:'admit-work',workId:'source',title:'Original source Work',budget:0}});
 const mission=await f.mission(),sourceWork=memoryWorkSource(mission,mission.works[0]!),messageId=ownerMessageId('remark'),turnId=assistantTurnId(messageId),thread=memberThread(member.id),conversation=new AssistantConversation(f.store,[owner,{id:ASSISTANT_ACTOR_ID,roles:['assistant']}],()=>f.start,thread);
 await conversation.dispatch({segment:1,commandId:'remark',expectedRevision:0,actorId:owner.id,command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:'Remember the instruction from this Work.',turn:{status:'pending',id:turnId,route,ownership:{hostSessionId:'host:fixture',dispatchId:'dispatch:fixture',startedAt:f.start,deadlineAt:f.start+10000},requestHash:'b'.repeat(64),contextMessageIds:[]}}});
 const segment=(await f.store.load(segmentId(1,thread)))!.value,candidate={id:memoryCandidateId(segment.id,turnId),version:1 as const,name:'Named source instruction',content:'Keep the instruction.',missionId:'intake',scope:'local',memberId:member.id,segmentId:segment.id,turnId,messageHash:hash(segment.messages[0]),sourceWork,state:'proposed' as const};
 await conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Fixture response',reply:'Suggested.',proposal:null,memoryCandidate:candidate}});return {sourceWork,candidate,app};
}

test('source Work bytes are pinned before owner action; changed inputs cannot be substituted',async()=>{
 const f=await setup(),{sourceWork,app}=await sourceCandidate(f),input=await f.choice();await app.dispatch({missionId:'intake',commandId:'change-source',expectedRevision:2,actorId:owner.id,command:{type:'steer',workId:'source',instruction:'Changed after the proposal'}});
 await assert.rejects(f.chat.decideMemory({...input,missionRevision:3}),/review changed/);assert.equal((await f.mission()).memories.length,0);
 const good=await setup();const source=await sourceCandidate(good);assert.equal((await good.chat.decideMemory(await good.choice())).status,'saved');assert.deepEqual((await good.mission()).memories[0]!.sourceWork,source.sourceWork);assert.equal(sourceWork.title,'Original source Work');
});

test('portable backup roundtrip preserves candidate decisions, names and exact source metadata with lineage',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{TextArtifactStore}=await import('../src/text-artifacts.ts'),{exportPortableBackup,parsePortableBackup,restorePortableBackup}=await import('../src/portable-backup.ts');
 const root=await mkdtemp(join(tmpdir(),'massion-memory-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const f=await setup();await sourceCandidate(f);await f.chat.decideMemory(await f.choice());const operations=[...structuredClone(f.store.inspect())],journal={schemaVersion:2 as const,head:operations.length,operations},artifacts=new TextArtifactStore(join(root,'source')),serialized=await exportPortableBackup({exportJournal:async()=>journal},artifacts),parsed=parsePortableBackup(serialized);
 const restored=new InMemoryStore<any>();let imported=false;
 await restorePortableBackup(serialized,{exportJournal:async()=>({schemaVersion:2,head:0,operations:[]}),restoreJournal:async j=>{validateMissionJournalLineage(j.operations);for(const op of j.operations)await restored.commit({id:op.aggregateId,expectedRevision:op.expectedRevision,commandId:op.commandId,fingerprint:op.fingerprint,value:op.value,events:op.events,outbox:op.outbox});imported=true;return {status:'restored',head:j.head,checksum:''};}},join(root,'restored'));
 assert.equal(imported,true);assert.deepEqual(parsed.journal.operations,journal.operations);assert.deepEqual(await restored.load('intake'),await f.store.load('intake'));assert.deepEqual(await restored.load(segmentId(1,memberThread(member.id))),await f.store.load(segmentId(1,memberThread(member.id))));validateMissionJournalLineage(restored.inspect());
 const restoredChat=new AssistantService(restored,new ProductService(restored),undefined,{member,clock:()=>f.start});const view:any=await restoredChat.read();assert.equal(view.turns[0].memoryCandidate.status,'saved');assert.deepEqual(view.turns[0].memoryCandidate.sourceWork,(await f.mission()).memories[0]!.sourceWork);
});

test('HTTP rejects stale memory review before intent and lets the owner review again',async t=>{
 const {createWorkbench}=await import('../src/server.ts');
 const f=await setup();await f.send();const choice=await f.choice();
 await f.product.admit('intake',{commandId:'concurrent-owner',expectedRevision:choice.missionRevision,workId:'concurrent',title:'Owner update',budget:0});
 const server=createWorkbench(f.store,process.cwd(),{scheduleIntervalMs:0});t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const post=(decision:any)=>fetch('http://127.0.0.1:'+address.port+'/assistant/memory-candidates',{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':choice.feedId},body:JSON.stringify({member:member.id,...decision})});
 const rejected=await post(choice),body=await rejected.json();assert.equal(rejected.status,409);assert.equal(body.outcome,'rejected');assert.equal(body.phase,'admission');assert.equal(body.feedId,choice.feedId);assert.equal((await f.mission()).memories.length,0);assert.equal((await f.chat.read() as any).turns[0].memoryCandidate.status,'proposed');
 const saved=await post(await f.choice());assert.equal(saved.status,200);assert.equal((await saved.json()).status,'saved');assert.equal((await f.mission()).memories.length,1);
});

test('a definite save conflict after intent stays not_saved on read and restart without resend',async()=>{
 let memoryWrites=0;const f=await setup({ownerStore:store=>new Proxy(store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0]?.command.type==='save-memory')memoryWrites++;const result=await target.commit(input);if(input.events[0]?.command.type==='decide-assistant-memory'){const current=(await target.load('intake'))!;await new ProductService(target).admit('intake',{commandId:'between-intent-and-save',expectedRevision:current.revision,workId:'concurrent',title:'Concurrent owner update',budget:0});}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})});await f.send();const input=await f.choice();assert.equal((await f.chat.decideMemory(input)).status,'not_saved');assert.equal((await f.chat.read() as any).turns[0].memoryCandidate.status,'not_saved');assert.equal((await f.service().read() as any).turns[0].memoryCandidate.status,'not_saved');assert.equal((await f.service().decideMemory(input)).status,'not_saved');assert.equal(memoryWrites,0);assert.equal((await f.mission()).memories.length,0);validateMissionJournalLineage(f.store.inspect());
});
