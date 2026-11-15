import {environmentStepResult} from '../src/environment-work-state.ts';
import {PAGE_MATERIAL_START,PAGE_MATERIAL_END} from '../src/browser-runtime.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,canonical,createMission,hash,workInputHash,DomainError} from '../src/domain.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import {AssistantConversation,ownerMessageId,assistantTurnId,assistantWorkId,assistantRunId} from '../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../src/members.ts';
import {hash as hashOf} from '../src/domain.ts';

const owner={id:'local-owner',roles:['owner'] as const},rep={id:'runtime-representative',roles:['representative'] as const},host={id:'environment-work-host',roles:['representative'] as const},worker={id:'worker',roles:['executor'] as const};
const definition={memberId:'member',origin:'https://fixture.example',elements:[{id:'field',selector:'#field',role:'textbox',label:'입력',operations:['type'],gates:[]}],facts:[{id:'filled',selector:'#field',state:'value-present',label:'입력 확인',kind:'state'}],waits:[],secrets:[{id:'value',label:'입력 정보',purpose:'필드 입력',fields:[{slot:'value',label:'입력값',kind:'id',element:'field'}]}]};
const plan={format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',secret:{owner:'local-owner',slot:'value'}}},{kind:'observe',facts:['filled']}]};
function fixture(definitionOverride=definition){
 let mission=createMission({id:'m',purpose:'Fixture',scope:'local',constraints:[],criteria:{version:1,description:'Observe the result',oracle:'bounded-text-review/v1'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'w',title:'Native form',budget:50},owner).value;mission.works[0]!.team=memberProcedures(null,'member');
 const inputHash=workInputHash(mission.works[0]!);
 mission=apply(mission,{type:'activate-runtime',workId:'w',run:{id:'run',authorizationId:'grant',criteriaHash:hash(mission.criteria),inputHash,mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:1000,deadlineAt:5000},environment:{id:'env',feedId:'feed',definition:definitionOverride}}} as any,owner).value;
 mission=apply(mission,{type:'delegate',workId:'w',taskId:'w:executor',parentId:'w:root'},rep).value;
 mission=apply(mission,{type:'delegate',workId:'w',taskId:'w:step:0',parentId:'w:executor',step:{title:'Fill',role:'입력',dependsOn:[]}},rep).value;
 mission=apply(mission,{type:'assign',workId:'w',assignment:{id:'worker-assignment',actorId:worker.id,role:'executor',taskId:'w:step:0',model:{provider:'fixture',model:'fixture',configVersion:'v1',reason:'Fixture',evidenceClass:'fixture'},extensionVersion:'v1'}},rep).value;
 const command=(update:object,index=0)=>({type:'record-environment-work',workId:'w',taskId:'w:step:0',environment:'env',dispatchId:'dispatch',inputHash,index,update});
 const time={observedAt:1001,telemetryVersion:2 as const};return {mission,command,time,inputHash};
}

test('a stored Work definition with a removed gate kind validates, exports and restores',async()=>{
 // The runtime binding is built and journalled in the shape origin/main before #164 wrote: an assistant-proposed Work whose stored definition still carries a removed gate kind.
 const legacy=structuredClone(definition) as any;legacy.elements[0].gates=[{kind:'irreversible-submit'}];legacy.memberId='member:legacy';
 const store=new InMemoryStore<any>(),representative={id:'assistant-representative',roles:['assistant'] as const},app=new Application(store,[owner,host,representative],()=>1001);
 const members=new MembersService(store,()=>'m'),memberCommand='fixture-admit-legacy-member',memberId=admittedMemberId(memberCommand),proposalId=PROPOSAL_PREFIX+hashOf('legacy-member');
 const proposal={type:'propose-member' as const,decisionId:proposalDecisionId(proposalId),topic:'퀼',works:[{title:'옛 관문 작업'}],count:2};
 const proposed=applyMembers(null,proposal,representative,{observedAt:Date.now()});
 await store.commit({id:MEMBERS_ID,expectedRevision:0,commandId:proposalId,fingerprint:hash({actorId:representative.id,command:proposal}),...proposed,outbox:[]});
 assert.equal((await members.decide({commandId:memberCommand,decisionId:proposalDecisionId(proposalId),answer:'act',member:{name:'퀼',shape:'square'}})).status,'committed');
 legacy.memberId=memberId;
 await app.create({id:'m',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'옛 관문 정의',oracle:'bounded-text-review/v1'}},owner.id,'fixture-legacy-create');
 const chat=new AssistantConversation(store,[owner,representative]),messageId=ownerMessageId('fixture-legacy-message'),turnId=assistantTurnId(messageId),startedAt=Date.now();
 const opened=await chat.dispatch({segment:1,commandId:'fixture-legacy-message',expectedRevision:0,actorId:owner.id,command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:'옛 정의로 저장된 작업을 이어가 줘.',recordMessageTime:true,turn:{id:turnId,status:'pending',route:{profileId:'fixture-profile',configHash:hash('fixture'),provider:'fixture',model:'producer',mode:'mock-http',outputTokenCap:64},ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-legacy',startedAt,deadlineAt:startedAt+120000},requestHash:hash('fixture-legacy-message'),contextMessageIds:[]}}});
 const settled=await chat.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:opened.revision,actorId:representative.id,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Synthetic member Work proposal',reply:'맡길게요.',proposal:{title:'옛 관문 작업',member:'퀼'},recordMessageTime:true}});
 const message=(settled as any).value.messages.find((m:any)=>m.id===messageId)!;
 const workId=assistantWorkId(turnId);
 await app.dispatch({missionId:'m',commandId:'assistant-work:'+turnId,expectedRevision:1,actorId:representative.id,command:{type:'admit-work',workId,title:'옛 관문 작업',budget:10000,team:memberProcedures(null,memberId),assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'producer'},memberId}}});
 await chat.dispatch({segment:1,commandId:'assistant-outcome:'+turnId,expectedRevision:(settled as any).revision,actorId:representative.id,command:{type:'record-assistant-outcome',turnId,missionId:'m',work:{status:'admitted',diagnostics:[]},run:{status:'requested',diagnostics:[]}}});
 const activated=await app.dispatch({missionId:'m',commandId:'assistant-run:'+turnId,expectedRevision:2,actorId:representative.id,command:{type:'activate-runtime',workId,run:{id:assistantRunId(turnId),authorizationId:'grant',criteriaHash:hash((await store.load('m'))!.value.criteria),inputHash:workInputHash((await store.load('m'))!.value.works[0]!),mode:'mock-http',outputTokenCap:64,ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-legacy',startedAt,deadlineAt:startedAt+120000},environment:{id:'environment:legacy',feedId:'feed-legacy',definition:legacy}} as any}});
 assert.equal(activated.status,'committed');
 validateMissionJournalLineage(store.inspect());
 const artifacts=new TextArtifactStore('/private/tmp/ru5-followups');
 const operations=store.inspect();
 const serialized=await exportPortableBackup({exportJournal:async()=>({schemaVersion:2,head:operations.length,operations:[...operations]})},artifacts);
 const backup=parsePortableBackup(serialized);
 assert.equal(backup.journal.operations.length,operations.length);
 assert.equal((backup.journal.operations.at(-1)!.value as any).works[0].runtimeRun.environment.definition.elements[0].gates[0].kind,'irreversible-submit');
});

import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';

test('the host checkpoints a bound step, waits, and atomically claims one effect after approval',()=>{
 const f=fixture();let m:any;assert.doesNotThrow(()=>{m=apply(f.mission,f.command({kind:'begin',plan}) as any,host,f.time).value;});
 const reference={id:'entry',hash:hash('action'),at:1000,deadline:4000};m=apply(m,f.command({kind:'link',reference,waiting:true}) as any,host,f.time).value;assert.equal(m.works[0].execution,'waiting');
 assert.throws(()=>apply(m,f.command({kind:'claim'}) as any,host,f.time));
 m=apply(m,f.command({kind:'resume',approvedAt:1001}) as any,host,f.time).value;m=apply(m,f.command({kind:'claim'}) as any,host,f.time).value;assert.equal(m.works[0].effects.length,1);assert.equal(m.works[0].effects[0].status,'pending');assert.throws(()=>apply(m,f.command({kind:'claim'}) as any,host,f.time));
 const pending=m.works[0].tasks.find((t:any)=>t.id==='w:step:0').environment.pending;assert.equal(pending.phase,'claimed');assert.equal(pending.effectId,m.works[0].effects[0].id);
});

test('owner input, expired ownership and changed input bindings cannot create host claims',()=>{
 const f=fixture(),command=f.command({kind:'begin',plan});assert.throws(()=>apply(f.mission,command as any,owner,f.time),e=>e instanceof DomainError&&e.code==='denied');
 for(const changed of [{...command,inputHash:hash('other')},{...command,dispatchId:'other'}])assert.throws(()=>apply(f.mission,changed as any,host,f.time));
 assert.throws(()=>apply(f.mission,command as any,host,{...f.time,observedAt:5000}));assert.throws(()=>apply(f.mission,{type:'cancel',workId:'w'},host));
});

test('overlapping identical step checkpoints replay the stored receipt rather than creating another plan',async()=>{
 const f=fixture(),store=new InMemoryStore<any>();await store.commit({id:'m',commandId:'seed',expectedRevision:0,fingerprint:hash(f.mission),value:f.mission,events:[],outbox:[]});const app=new Application(store,[host],()=>1001),request={missionId:'m',commandId:'begin',expectedRevision:1,actorId:host.id,command:f.command({kind:'begin',plan}) as any};
 const results=await Promise.all([app.dispatch(request),app.dispatch(request)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);assert.equal((await store.load('m'))!.value.works[0].tasks.find((t:any)=>t.id==='w:step:0').environment.cursor,0);
 await app.dispatch({...request,commandId:'link',expectedRevision:2,command:f.command({kind:'link',reference:{id:'entry',hash:hash('action'),at:1000,deadline:4000},waiting:true}) as any});const replay=await app.dispatch({...request,expectedRevision:3});assert.equal(replay.status,'replayed');assert.equal(replay.value.works[0]!.execution,'active');assert.equal((await store.load('m'))!.value.works[0].execution,'waiting');
});


test('a claimed action advances only after its exact delivery receipt, never an unknown result',()=>{
 const f=fixture(),reference={id:'entry',hash:hash('action'),at:1000,deadline:4000};let m=apply(f.mission,f.command({kind:'begin',plan}) as any,host,f.time).value;
 for(const update of [{kind:'link',reference,waiting:true},{kind:'resume',approvedAt:1001},{kind:'claim'}])m=apply(m,f.command(update) as any,host,f.time).value;
 assert.throws(()=>apply(m,f.command({kind:'complete',result:'delivered'}) as any,host,f.time));const effectId=m.works[0]!.effects[0]!.id;
 const uncertain=apply(m,{type:'receipt',workId:'w',effectId,outcome:'unknown',receipt:'Not confirmed',usage:null},worker,f.time).value;assert.throws(()=>apply(uncertain,f.command({kind:'complete',result:'delivered'}) as any,host,f.time));
 m=apply(m,{type:'receipt',workId:'w',effectId,outcome:'succeeded',receipt:JSON.stringify({kind:'environment-delivery/v1',environment:'env',entryId:reference.id,requestHash:reference.hash}),usage:0},worker,f.time).value;
 m=apply(m,f.command({kind:'complete',result:'delivered'}) as any,host,f.time).value;const step=(m.works[0]!.tasks.find(t=>t.id==='w:step:0') as any).environment;assert.equal(step.cursor,1);assert.equal(step.pending,undefined);assert.equal(step.records[0].kind,'delivered');
});

test('host observation records bind a retained page and declared booleans without accepting page text as proof',()=>{
 const f=fixture(),readPlan={format:'massion-environment/v1',operations:[{kind:'observe',facts:['filled']}]};let m=apply(f.mission,f.command({kind:'begin',plan:readPlan}) as any,host,f.time).value;
 assert.throws(()=>apply(m,{type:'settle-task',workId:'w',taskId:'w:step:0',result:'Unobserved'},worker,f.time));
 const observation={observationId:'assistant-environment:read',binding:{environment:'env',surface:'surface',origin:definition.origin,generation:1,revision:1},facts:{filled:true},pageReadId:'page'};
 assert.throws(()=>apply(m,f.command({kind:'observe',observation}) as any,host,f.time));
 m=apply(m,{type:'record-browser-page',workId:'w',sessionId:'browser',navigationId:'navigation',page:{readId:'page',expectedRevision:1,inputHash:f.inputHash,at:1001,address:definition.origin,title:'Fixture',blocks:[],fields:[]}}, {id:'browser-read-host',roles:['representative']}).value;
 for(const facts of [{filled:'confirmed'},{filled:true,extra:true}])assert.throws(()=>apply(m,f.command({kind:'observe',observation:{...observation,facts}}) as any,host,f.time));
 const c=f.command({kind:'observe',observation});assert.deepEqual(apply(m,c as any,host,f.time),apply(JSON.parse(canonical(m)),JSON.parse(canonical(c)),host,f.time));
 m=apply(m,f.command({kind:'observe',observation}) as any,host,f.time).value;const step=(m.works[0]!.tasks.find(t=>t.id==='w:step:0') as any).environment;assert.equal(step.cursor,1);assert.deepEqual(step.records[0].observation.facts,{filled:true});assert.equal(m.works[0]!.effects[0]!.status,'succeeded');assert.match(m.works[0]!.effects[0]!.receipt!,/environment-observation\/v1/);assert.equal(step.records[0].at,1001);assert.equal(m.works[0]!.effects[0]!.deliveredAt,undefined);
});

test('a long page material keeps the marked block closed at the step-result bound',()=>{
 const f=fixture(),blocks=Array.from({length:20},(_,index)=>'page line '+index+' '+'x'.repeat(620));
 const readPlan={format:'massion-environment/v1',operations:[{kind:'observe',facts:['filled']}]};
 let m=apply(f.mission,f.command({kind:'begin',plan:readPlan}) as any,host,f.time).value;
 m=apply(m,{type:'record-browser-page',workId:'w',sessionId:'browser',navigationId:'navigation',page:{readId:'page',expectedRevision:1,inputHash:f.inputHash,at:1001,address:definition.origin,title:'Fixture',blocks,fields:[]}}, {id:'browser-read-host',roles:['representative']}).value;
 const observation={observationId:'assistant-environment:read',binding:{environment:'env',surface:'surface',origin:definition.origin,generation:1,revision:1},facts:{filled:true},pageReadId:'page'};
 m=apply(m,f.command({kind:'observe',observation}) as any,host,f.time).value;
 const work=m.works[0]!,result=environmentStepResult(work,work.tasks.find(t=>t.id==='w:step:0')!);
 assert.ok(result.length<=12000+PAGE_MATERIAL_END.length+1);
 assert.ok(result.includes(PAGE_MATERIAL_START));
 assert.equal(result.trimEnd().endsWith(PAGE_MATERIAL_END),true);
});
