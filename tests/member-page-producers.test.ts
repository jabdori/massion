import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,assistantTurnId,ownerMessageId,segmentId} from '../src/assistant-conversation.ts';
import {candidateMemory,memoryCandidateId} from '../src/memory-candidates.ts';
import type {MemoryCandidate} from '../src/memory-candidates.ts';
import {hash} from '../src/domain.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryStore} from '../src/storage.ts';
import {MEMBERS_ID,MembersService,applyMembers,proposalDecisionId,PROPOSAL_PREFIX,admittedMemberId,memberThread} from '../src/members.ts';
import {SkillsService,SKILLS_ID,replaySkills,applySkills} from '../src/skills.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const owner={id:'local-owner',roles:['owner' as const]},host={id:ASSISTANT_ACTOR_ID,roles:['assistant' as const]},at=Date.UTC(2026,10,10);
async function setup(){
 const store=new InMemoryStore<any>(),members=new MembersService(store,()=>'intake',()=>at),product=new ProductService(store);
 await product.create({id:'intake',purpose:'Member instructions',scope:'local',constraints:[],criteria:{version:1,description:'Answer',oracle:'bounded-text-review/v1'}},'create');
 for(const name of ['River','Sky']){
  const commandId=PROPOSAL_PREFIX+name,decisionId=proposalDecisionId(commandId),snapshot=await store.load(MEMBERS_ID),command={type:'propose-member' as const,decisionId,topic:name,works:[{title:'First'},{title:'Second'}],count:2};
  const result=applyMembers(snapshot?.value??null,command,host,{observedAt:at});await store.commit({id:MEMBERS_ID,commandId,expectedRevision:snapshot?.revision??0,fingerprint:hash({actorId:host.id,command}),...result,outbox:[]});
  await members.decide({commandId:'admit-'+name,decisionId,answer:'act',member:{name,shape:'round'}});
 }
 return {store,members,river:admittedMemberId('admit-River'),sky:admittedMemberId('admit-Sky')};
}

test('builtin assignment stores exact catalog provenance, replays once, and survives service restart and journal validation',async()=>{
 const f=await setup(),skills=new SkillsService(f.store,{clock:()=>at}),input={commandId:'builtin-river',action:'builtin',memberId:f.river,builtinId:'read-sources'};
 assert.equal((await skills.act(input)).status,'committed');
 assert.equal((await new SkillsService(f.store).act(input)).status,'replayed');
 const view=await f.members.read(),own=view.members.find(m=>m.id===f.river)! as any;
 assert.equal(own.builtinSkills.length,1);assert.equal(own.builtinSkills[0].builtin.id,'read-sources');assert.equal(own.builtinSkills[0].builtin.version,1);assert.match(own.builtinSkills[0].hash,/^[a-f0-9]{64}$/);
 assert.deepEqual((view.members.find(m=>m.id===f.sky)! as any).builtinSkills,[]);
 const state=(await f.store.load(SKILLS_ID))!.value,version=state.skills[0].versions[0];assert.equal(version.hash,hash(version.body));
 assert.throws(()=>applySkills(null,{type:'write-skill',memberId:f.river,kind:'skill',name:state.skills[0].name,body:{...version.body,steps:['Fake']},builtin:version.builtin} as any,owner,{observedAt:at}),/builtin/i);
 validateMissionJournalLineage(f.store.inspect());
 const ops=f.store.inspect().filter(o=>o.aggregateId===SKILLS_ID);ops.forEach((op,i)=>replaySkills(op,ops[i-1]));
 await assert.rejects(skills.act({...input,commandId:'invalid-catalog',builtinId:'not-a-skill'}),/builtin/i);
 await assert.rejects(skills.act({...input,commandId:'unknown-member',memberId:'missing'}),/member/i);
});

async function savedCandidate(f:Awaited<ReturnType<typeof setup>>,save=true){
 const thread=memberThread(f.river),conversation=new AssistantConversation(f.store,[owner,host],()=>at,thread),messageId=ownerMessageId('remember'),turnId=assistantTurnId(messageId),route={profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http' as const,outputTokenCap:256};
 await conversation.dispatch({segment:1,commandId:'remember',expectedRevision:0,actorId:owner.id,command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:'Keep this preference',turn:{id:turnId,status:'pending',route,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:at,deadlineAt:at+10000},requestHash:'a'.repeat(64),contextMessageIds:[]}}});
 const segment=(await f.store.load(segmentId(1,thread)))!.value,c:MemoryCandidate={id:memoryCandidateId(segment.id,turnId),version:1,name:'Preferred summary',content:'Keep it short.',missionId:'intake',scope:'local',memberId:f.river,segmentId:segment.id,turnId,messageHash:hash(segment.messages[0]),state:'proposed'};
 await conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:host.id,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'fixture',reply:'Suggested',proposal:null,memoryCandidate:c}});
 if(!save)return c;
 const {memoryCandidateHash}=await import('../src/memory-candidates.ts');
 await conversation.dispatch({segment:1,commandId:'assistant-memory-decision:'+turnId,expectedRevision:2,actorId:owner.id,command:{type:'decide-assistant-memory',turnId,candidateId:c.id,version:1,hash:memoryCandidateHash(c),action:'save',missionRevision:1}});
 await new Application(f.store,[owner]).dispatch({missionId:'intake',commandId:'assistant-memory-save:'+turnId,expectedRevision:1,actorId:owner.id,command:{type:'save-memory',memory:candidateMemory(c)}});
 return c;
}

test('member memory uses an exact saved candidate receipt, retains its source thread, and retirement hides it without deleting history',async()=>{
 const f=await setup(),candidate=await savedCandidate(f),mission=(await f.store.load('intake'))!;
 const app=new Application(f.store,[owner]);await app.dispatch({missionId:'intake',commandId:'unrelated',expectedRevision:mission.revision,actorId:owner.id,command:{type:'save-memory',memory:{...candidateMemory(candidate),id:'unrelated',source:candidate.segmentId+'/'+candidate.turnId}}});
 const before=f.store.inspect().length,view=await new MembersService(f.store,()=>'intake').read(),river=view.members.find(m=>m.id===f.river)! as any;
 assert.equal(river.memories.length,1);assert.equal(river.memories[0].id,candidate.id);assert.equal(river.memories[0].missionId,'intake');assert.equal(river.memories[0].sourceSegment,1);assert.equal(river.memories[0].sourceTurnId,candidate.turnId);assert.equal(river.memories[0].missionRevision,3);
 assert.deepEqual((view.members.find(m=>m.id===f.sky)! as any).memories,[]);assert.equal(f.store.inspect().length,before);
 await app.dispatch({missionId:'intake',commandId:'retire',expectedRevision:3,actorId:owner.id,command:{type:'retire-memory',memoryId:candidate.id,version:1,reason:'Removed from member page'}});
 assert.deepEqual(((await f.members.read()).members.find(m=>m.id===f.river)! as any).memories,[]);assert.equal((await f.store.load('intake'))!.value.memories.length,2);
 validateMissionJournalLineage(f.store.inspect());
});

test('a proposed or unresolved member candidate cannot be presented as saved memory',async()=>{
 const f=await setup();await savedCandidate(f,false);assert.deepEqual(((await f.members.read()).members[0]! as any).memories,[]);
});

test('builtin assignment replays overlapping identities and owner drain fences the actual write',async()=>{
 const f=await setup(),input={commandId:'builtin-overlap',action:'builtin',memberId:f.river,builtinId:'read-code'},normal=new SkillsService(f.store);let race=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(value:any)=>{if(race){race=false;await normal.act(input);}return target.commit(value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await new SkillsService(store).act(input)).status,'replayed');assert.equal(f.store.inspect().filter(o=>o.aggregateId===SKILLS_ID).length,1);
 let draining=false,entered=()=>{},release=()=>{};const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const ownerStore=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(id===SKILLS_ID){entered();await gate;}return target.load(id);};if(key==='commit')return (value:any)=>{assert.equal(draining,false,'Host is draining');return target.commit(value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const before=f.store.inspect().length,pending=new SkillsService(ownerStore).act({...input,commandId:'builtin-drain',builtinId:'run-tests'});await reached;draining=true;release();await assert.rejects(pending,/draining/);assert.equal(f.store.inspect().length,before);
});

test('database replacement during a saved-memory receipt read discards the old member projection',async()=>{
 const f=await setup();await savedCandidate(f);const empty=new InMemoryStore<any>();let current=f.store;
 const store=new Proxy(f.store,{get(_target,key){if(key==='lookupOperation')return async(input:any)=>{const result=await current.lookupOperation(input);if(input.commandId.startsWith('assistant-memory-save:'))current=empty;return result;};const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;}});
 const view=await new MembersService(store,()=>undefined).read();assert.deepEqual(view.members,[]);assert.equal(view.feedId,(await empty.readState()).feedId);
});

test('portable backup roundtrip retains builtin provenance, saved member memory and schedules on a fresh store',async()=>{
 const {exportPortableBackup,parsePortableBackup}=await import('../src/portable-backup.ts'),{TextArtifactStore}=await import('../src/text-artifacts.ts'),{SchedulesService}=await import('../src/schedules.ts');
 const f=await setup();await savedCandidate(f);await new SkillsService(f.store).act({commandId:'builtin-backup',action:'builtin',memberId:f.river,builtinId:'read-sources'});
 await new SchedulesService(f.store,async()=>({turns:[]}),()=>at,f.store,undefined,{member:id=>f.members.member(id),readMember:async()=>({turns:[]}),produceMember:async()=>null}).act({commandId:'schedule-backup',action:'create',kind:'weekly-review',memberId:f.river,minute:540,offset:0,budget:{runs:3}});
 const operations=f.store.inspect(),serialized=await exportPortableBackup({exportJournal:async()=>({schemaVersion:2,head:operations.length,operations:[...operations]})},new TextArtifactStore('/private/tmp/massion-member-no-artifacts'));
 const bundle=parsePortableBackup(serialized),restored=new InMemoryStore<any>();
 for(const op of bundle.journal.operations)assert.equal((await restored.commit({id:op.aggregateId,commandId:op.commandId,expectedRevision:op.expectedRevision,fingerprint:op.fingerprint,value:op.value,events:op.events,outbox:op.outbox})).status,'committed');
 const before=await f.members.read(),after=await new MembersService(restored,()=>undefined).read();assert.notEqual(after.feedId,before.feedId);assert.deepEqual(after.members,before.members);
 assert.equal(after.members[0]!.memories.length,1);assert.equal(after.members[0]!.builtinSkills.length,1);assert.equal(after.members[0]!.scheduleCount,1);
});

test('conversation HTTP discards member metadata if the database changes during the final app read',async t=>{
 const {createWorkbench}=await import('../src/server.ts'),{APPS_ID}=await import('../src/apps.ts');
 const f=await setup(),replacement=new InMemoryStore<any>();let current=f.store,changed=false;
 const store=new Proxy(f.store,{get(_target,key){if(key==='load')return async(id:string)=>{if(id===APPS_ID&&!changed){changed=true;current=replacement;}return current.load(id);};const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;}});
 const server=createWorkbench(store,'/private/tmp',{scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.drain());const address=server.address();assert.ok(address&&typeof address!=='string');
 const response=await fetch('http://127.0.0.1:'+address.port+'/assistant/conversation?member='+f.river);assert.equal(changed,true);assert.equal(response.status,503,await response.text());
});
