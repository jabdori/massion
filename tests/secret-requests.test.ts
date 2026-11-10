import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {SecretRequestsService} from '../src/secret-requests-service.ts';
import {secretRequestHash,requestSecretSlot} from '../src/secret-requests.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {Mission} from '../src/domain.ts';
import {createWorkbench} from '../src/server.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workAdmissionPreflight} from '../src/configured-runtime.ts';
import {canResume} from '../src/runtime-continuation.ts';

const declaration={memberId:'member-one',label:'Account access',purpose:'Read the declared report',fields:[{slot:'login',label:'Login',kind:'id' as const},{slot:'password',label:'Password',kind:'password' as const}]};
async function fixture(){
 const store=new InMemoryStore<Mission>(),own=new InMemorySecretSlots(),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'representative',roles:['representative']},{id:'member-one',roles:['executor']}]);
 await app.create({id:'mission',purpose:'Fixture',scope:'fixture',constraints:[],criteria:{version:1,description:'Checked',oracle:'manual-review/v1'}},'local-owner','create');
 await app.dispatch({missionId:'mission',commandId:'admit',expectedRevision:1,actorId:'local-owner',command:{type:'admit-work',workId:'work',title:'Use a private account',budget:32}});
 await app.dispatch({missionId:'mission',commandId:'assign',expectedRevision:2,actorId:'local-owner',command:{type:'assign',workId:'work',assignment:{id:'assignment',actorId:'member-one',role:'executor',taskId:'work:root',model:{provider:'fixture',model:'fixture-model',configVersion:'v1',reason:'Fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 const service=new SecretRequestsService(store,own),offer={commandId:'assistant-secret-request-one',missionId:'mission',workId:'work',expectedRevision:3,requestId:'request-one',declaration};
 await service.offer(offer);const view=await service.read('mission','work'),answer={commandId:'provide-one',missionId:'mission',workId:'work',expectedRevision:view.revision,requestId:'request-one',requestHash:secretRequestHash(declaration),answer:'provide' as const,selections:declaration.fields.map(f=>({slot:f.slot,source:{kind:'own' as const}})),values:{login:'fixture-id',password:'fixture-password'}};
 return {store,own,app,service,offer,answer};
}

test('a typed member request pauses Work; one owner provision grants only its Work/member/purpose and stores no values in the journal',async()=>{
 const f=await fixture();assert.equal((await f.store.load('mission'))!.value.works[0]!.execution,'blocked');
 const paused=(await f.store.load('mission'))!;assert.ok(workAdmissionPreflight(paused,'work',paused.revision).diagnostics.some(d=>d.code==='secret_request_pending'));
 assert.equal(canResume({...paused.value.works[0]!,runtimeRun:{continuationVersion:1,ownership:{startedAt:1,deadlineAt:100}} as any,team:{} as any},2),false);
 await assert.rejects(f.app.dispatch({missionId:'mission',commandId:'effect-before-input',expectedRevision:4,actorId:'member-one',command:{type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'work:root',status:'pending',target:'fixture',authority:'fixture'},reserve:1}}),/secret/i);
 const both=await Promise.all([f.service.answer(f.answer),f.service.answer(f.answer)]);assert.ok(both.some(r=>r.status==='provided'));assert.equal((await f.service.read('mission','work')).requests[0]!.state,'provided');
 const slot=requestSecretSlot('mission','work','request-one','password'),access=f.service.slots('mission','work','request-one','member-one',declaration.purpose);
 assert.equal(await access.read(slot),'fixture-password');
 await assert.rejects(f.service.slots('mission','work','request-one','other',declaration.purpose).read(slot));
 await assert.rejects(f.service.slots('mission','work','request-one','member-one','Other purpose').read(slot));
 assert.doesNotMatch(JSON.stringify([f.store.inspect(),both,await f.service.read('mission','work')]),/fixture-password|fixture-id/);
 validateMissionJournalLineage(f.store.inspect());
});

test('decline, unknown provision and malformed requests remain closed across restart without replay',async()=>{
 const f=await fixture(),{selections,values,...answer}=f.answer;
 assert.equal((await f.service.answer({...answer,answer:'decline'})).status,'declined');
 await assert.rejects(f.service.answer({...f.answer,commandId:'try-after-decline',expectedRevision:5}));
 assert.equal((await f.service.read('mission','work')).requests[0]!.state,'declined');validateMissionJournalLineage(f.store.inspect());
 const g=await fixture();let writes=0;g.own.set=async()=>{writes++;throw Error('private-write');};
 assert.equal((await g.service.answer(g.answer)).status,'unavailable');assert.equal(writes,1);
 const fresh=new SecretRequestsService(g.store,g.own);assert.equal((await fresh.answer(g.answer)).status,'unavailable');assert.equal(writes,1);
 await assert.rejects(fresh.slots('mission','work','request-one','member-one',declaration.purpose).read(requestSecretSlot('mission','work','request-one','password')));
 assert.doesNotMatch(JSON.stringify(g.store.inspect()),/private-write|fixture-password/);validateMissionJournalLineage(g.store.inspect());
 for(const bad of [{...declaration,value:'secret'},{...declaration,fields:[{slot:'password',label:'Password',kind:'script'}]}])assert.throws(()=>secretRequestHash(bad));
});

test('external request selections resolve at use; imports keep value-free provenance and use only the own store after provision',async()=>{
 for(const kind of ['external-ref','import'] as const){
  const f=await fixture();let reads=0;const service=new SecretRequestsService(f.store,f.own,{onepassword:{read:async()=>{reads++;return 'fixture-external';}}}),answer={...f.answer,selections:declaration.fields.map(field=>({slot:field.slot,source:{kind,vendor:'onepassword' as const,reference:'op://fixture/item/'+field.slot}})),values:{}};
  assert.equal((await service.answer(answer)).status,'provided');const before=reads;
  const access=service.slots('mission','work','request-one','member-one',declaration.purpose);assert.equal(await access.read(requestSecretSlot('mission','work','request-one','password')),'fixture-external');assert.equal(await access.read(requestSecretSlot('mission','work','request-one','password')),'fixture-external');
  assert.equal(reads,before+(kind==='external-ref'?2:0));assert.doesNotMatch(JSON.stringify(f.store.inspect()),/fixture-external/);validateMissionJournalLineage(f.store.inspect());
 }
});

test('HTTP owner provision fences the feed and drain; open requests survive a host restart',async t=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'massion-secret-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createWorkbench(f.store,root,{secretSlots:f.own,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.drain());const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const post=(body:unknown,feed?:string)=>fetch(base+'/assistant/secrets',{method:'POST',headers:{'content-type':'application/json',...(feed?{'x-massion-feed':feed}:{})},body:JSON.stringify(body)});
 const view=await fetch(base+'/assistant/secrets?missionId=mission&workId=work').then(r=>r.json());assert.equal(view.requests[0].state,'open');
 assert.equal((await post(f.answer,'wrong-feed')).status,409);assert.equal((await f.service.read('mission','work')).requests[0]!.state,'open');
 let reached!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{reached=r;}),held=new Promise<void>(r=>{release=r;}),load=f.store.load.bind(f.store);let hold=true;
 f.store.load=async id=>{if(hold&&id==='mission'){hold=false;reached();await held;}return load(id);};
 const response=post(f.answer,view.feedId);await waiting;const draining=server.drain();release();assert.equal((await response).status,503);await draining;
 assert.equal((await new SecretRequestsService(f.store,f.own).read('mission','work')).requests[0]!.state,'open');
 assert.doesNotMatch(JSON.stringify(f.store.inspect()),/fixture-password|fixture-id/);
});
