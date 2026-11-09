import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {apply,createMission,workInputHash} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const owner={id:'owner',roles:['owner'] as const},rep={id:'rep',roles:['representative'] as const},worker={id:'worker',roles:['executor'] as const};
const input={id:'mission',purpose:'Retain observations',scope:'fixture',criteria:{version:1,description:'Read the source',oracle:'fixture'},constraints:[]};
async function setup(){let now=100;const store=new InMemoryStore<Mission>(),app=new Application(store,[owner,rep,worker],()=>now++);await app.create(input,owner.id,'create');let id=0;const send=async(command:Command,actorId=owner.id)=>app.dispatch({missionId:input.id,commandId:'command-'+id++,expectedRevision:(await store.load(input.id))!.revision,actorId,command});await send({type:'admit-work',workId:'work',title:'Read',budget:10});return {store,app,send};}

test('overlapping identical owner messages retain one original timestamp and cannot forge it',async()=>{
 const {store,app}=await setup(),before=(await store.load(input.id))!,envelope={missionId:input.id,commandId:'message',expectedRevision:before.revision,actorId:owner.id,command:{type:'append-work-message' as const,workId:'work',messageId:'message',replyTo:null,text:'Read only'}};
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const after=(await store.load(input.id))!,message=after.value.conversations![0]!.messages[0]!;assert.ok(Number.isSafeInteger(message.at));assert.equal(after.value.conversations![0]!.messages.length,1);assert.equal(workInputHash(after.value.works[0]!),workInputHash(before.value.works[0]!));
 const replay=await app.dispatch(envelope);assert.ok(replay.status!=='conflict');assert.deepEqual(replay.value,after.value);
 await assert.rejects(app.dispatch({...envelope,commandId:'forged',expectedRevision:after.revision,command:{...envelope.command,messageId:'forged',at:0} as Command}),/Exact owner message/);
 validateMissionJournalLineage(store.inspect());
 const tampered=structuredClone(store.inspect());tampered.at(-1)!.value.conversations![0]!.messages[0]!.at=0;assert.throws(()=>validateMissionJournalLineage(tampered),/replay|derived|differs|match/i);
});

test('effect admission and settlement record separate task times; unknown effects never gain an end',async()=>{
 const {store,send}=await setup();await send({type:'delegate',workId:'work',taskId:'task',parentId:'work:root'},rep.id);
 await send({type:'assign',workId:'work',assignment:{id:'assignment',actorId:worker.id,role:'executor',taskId:'task',model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'task',status:'pending',target:'fixture',authority:'fixture'},reserve:1},worker.id);
 let w=(await store.load(input.id))!.value.works[0]!;assert.ok(w.tasks[1]!.startedAt!>w.admittedAt!);assert.equal(w.tasks[1]!.endedAt,undefined);
 await send({type:'receipt',workId:'work',effectId:'effect',outcome:'unknown',receipt:'Lost response',usage:null},worker.id);
 await assert.rejects(send({type:'settle-task',workId:'work',taskId:'task',result:'Done'},worker.id),/unsettled effects/);
 w=(await store.load(input.id))!.value.works[0]!;assert.equal(w.tasks[1]!.endedAt,undefined);
 await send({type:'reconcile-effect',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Independent readback'});
 await send({type:'settle-task',workId:'work',taskId:'task',result:'Read source'},worker.id);
 w=(await store.load(input.id))!.value.works[0]!;assert.ok(w.tasks[1]!.endedAt!>w.tasks[1]!.startedAt!);validateMissionJournalLineage(store.inspect());
});

test('legacy transitions remain untimed and telemetry does not become command authority',()=>{
 const m=createMission(input,owner),command={type:'admit-work' as const,workId:'work',title:'Read',budget:10};
 const legacy=apply(m,command,owner);assert.equal(legacy.value.works[0]!.admittedAt,undefined);
 assert.equal(Object.hasOwn(legacy.events[0] as object,'time'),false);assert.deepEqual(legacy.value.works[0]!.tasks,[{id:'work:root',parentId:null,status:'queued'}]);
 assert.throws(()=>apply(m,command,owner,{observedAt:-1,telemetryVersion:1}),/time/);
});
