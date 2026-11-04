import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMissionLineage,validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {Application} from '../src/application.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryStore} from '../src/storage.ts';
import {hash} from '../src/domain.ts';
import type {Mission,Command,Actor} from '../src/domain.ts';

const actors:Actor[]=[{id:'local-owner',roles:['owner']},{id:'exec',roles:['executor']},{id:'rep',roles:['representative']}];
const quarantine=()=>({type:'quarantine-runtime',workId:'w',runId:'run',reason:'Provider was dispatched but receipt commit failed; outcome remains unknown.',acknowledgeUncertainOutcome:true} as const);
async function pending(){
 const store=new InMemoryStore<Mission>();const app=new Application(store,actors);let n=0;
 const send=async(command:Command,actorId='local-owner')=>app.dispatch({missionId:'m',commandId:`c${++n}`,expectedRevision:(await store.load('m'))!.revision,actorId,command});
 await app.create({id:'m',purpose:'Write a readiness note',scope:'local',constraints:['Text only'],criteria:{version:1,description:'Two blockers',oracle:'bounded-text-review/v1'}},'local-owner','create');
 await send({type:'admit-work',workId:'w',title:'Note',budget:128});const w=(await store.load('m'))!.value.works[0]!;
 await send({type:'activate-runtime',workId:'w',run:{id:'run',authorizationId:'mock-only',criteriaHash:hash(w.criteria),inputHash:hash({mission:w.missionSnapshot,title:w.title,instructions:[],memoryVersions:[]}),mode:'mock-http',outputTokenCap:64}});
 await send({type:'assign',workId:'w',assignment:{id:'a',actorId:'exec',role:'executor',taskId:'w:root',model:{provider:'local',model:'fake',configVersion:'1',reason:'Fixture only',evidenceClass:'fixture'},extensionVersion:'builtin@1'}});
 await send({type:'admit-effect',workId:'w',effect:{id:'run:executor',taskId:'w:root',status:'pending',target:'local/fake',authority:'mock-only'},reserve:64},'exec');
 return {store,app,send,product:new ProductService(store)};
}
test('owner quarantine preserves uncertain effect without manufacturing receipt, usage, or acceptance',async()=>{
 const s=await pending();const before=(await s.store.load('m'))!;
 const result=await s.product.intervene('m',{commandId:'recovery',expectedRevision:before.revision,command:quarantine()});assert.equal(result.status,'committed');
 const w=(await s.store.load('m'))!.value.works[0]!;
 assert.equal(w.execution,'cancelled');assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.effects[0]!.receipt,undefined);assert.equal(w.budget.measured,null);assert.equal(w.budget.reserved,64);assert.equal(w.record,undefined);assert.equal(w.acceptance,'pending');
 assert.deepEqual(w.runtimeRun,before.value.works[0]!.runtimeRun);assert.deepEqual(w.assignments,before.value.works[0]!.assignments);
 const recovery=(w as unknown as {runtimeRecovery:{runId:string;actorId:string;pendingEffectIds:string[]}}).runtimeRecovery;
 assert.equal(recovery.runId,'run');assert.equal(recovery.actorId,'local-owner');assert.deepEqual(recovery.pendingEffectIds,['run:executor']);
 const operation=s.store.inspect().at(-1)!;assert.deepEqual(operation.outbox,[]);assert.equal((operation.events[0] as {actor:string}).actor,'local-owner');
});
test('quarantine is owner-only, exact-run-bound, explicitly acknowledged and requires unresolved effects',async()=>{
 const s=await pending();const baseline=await s.store.load('m');
 for(const [command,actor] of [[quarantine(),'rep'],[{...quarantine(),runId:'other'},'local-owner'],[{...quarantine(),acknowledgeUncertainOutcome:false},'local-owner'],[{...quarantine(),reason:' '},'local-owner'],[{...quarantine(),reason:'\ud800'},'local-owner'],[{...quarantine(),actorId:'forged'},'local-owner']] as const){await assert.rejects(s.send(command as Command,actor));assert.deepEqual(await s.store.load('m'),baseline);}
 await s.send({type:'receipt',workId:'w',effectId:'run:executor',outcome:'succeeded',receipt:'Real fixture outcome',usage:5},'exec');await assert.rejects(s.send(quarantine()),/unresolved/i);
});
test('quarantine command identity replays once, stale CAS and competing owner commands never overwrite',async()=>{
 const s=await pending();const revision=(await s.store.load('m'))!.revision;const input={commandId:'quarantine',expectedRevision:revision,command:quarantine()};
 assert.equal((await s.product.intervene('m',input)).status,'committed');const settled=await s.store.load('m');
 assert.equal((await s.product.intervene('m',input)).status,'replayed');assert.deepEqual(await s.store.load('m'),settled);
 assert.equal((await s.product.intervene('m',{...input,commandId:'other'})).status,'conflict');
 await assert.rejects(s.product.intervene('m',{...input,commandId:'new',expectedRevision:settled!.revision}),/quarantin/i);
});
test('late receipts, owner reconciliation and task/acceptance progression cannot reopen quarantined Work',async()=>{
 const s=await pending();await s.send(quarantine());const baseline=await s.store.load('m');
 for(const [command,actor] of [
  [{type:'receipt',workId:'w',effectId:'run:executor',outcome:'succeeded',receipt:'Late fixture response',usage:5},'exec'],
  [{type:'reconcile-effect',workId:'w',effectId:'run:executor',outcome:'failed',receipt:'Owner guesses'},'local-owner'],
  [{type:'settle-task',workId:'w',taskId:'w:root',result:'Done'},'exec'],
  [{type:'accept',workId:'w',recordId:'invented'},'local-owner'],
 ] as const){await assert.rejects(s.send(command as Command,actor));assert.deepEqual(await s.store.load('m'),baseline);}
});
test('an already unknown receipt and its null usage remain intact during quarantine',async()=>{
 const s=await pending();await s.send({type:'receipt',workId:'w',effectId:'run:executor',outcome:'unknown',receipt:'Transport timed out after dispatch',usage:null},'exec');
 const before=(await s.store.load('m'))!.value.works[0]!;await s.send(quarantine());const w=(await s.store.load('m'))!.value.works[0]!;
 assert.deepEqual(w.effects,before.effects);assert.deepEqual(w.budget,before.budget);
});

test('quarantine handles already-cancelled pending Work and preserves every settled effect',async()=>{
 const s=await pending();await s.send({type:'receipt',workId:'w',effectId:'run:executor',outcome:'succeeded',receipt:'Durable fixture receipt',usage:5},'exec');
 await s.send({type:'admit-effect',workId:'w',effect:{id:'run:artifact',taskId:'w:root',status:'pending',target:'artifact',authority:'mock-only'},reserve:0},'exec');
 await s.send({type:'cancel',workId:'w'});const before=(await s.store.load('m'))!.value.works[0]!;await s.send(quarantine());const w=(await s.store.load('m'))!.value.works[0]!;
 assert.deepEqual(w.effects[0],before.effects[0]);assert.deepEqual(w.tasks,before.tasks);assert.deepEqual(w.attempts,before.attempts);assert.equal(w.budget.reserved,64);assert.equal(w.budget.measured,null);
 assert.equal(w.effects[1]!.status,'unknown');assert.equal(w.effects[1]!.receipt,undefined);
});
test('receipt winning the revision race forces owner refresh instead of overwriting known outcome',async()=>{
 const s=await pending();const old=(await s.store.load('m'))!;await s.send({type:'receipt',workId:'w',effectId:'run:executor',outcome:'succeeded',receipt:'Observed fixture result',usage:5},'exec');
 assert.equal((await s.product.intervene('m',{commandId:'stale-recovery',expectedRevision:old.revision,command:quarantine()})).status,'conflict');const w=(await s.store.load('m'))!.value.works[0]!;
 assert.equal(w.runtimeRecovery,undefined);assert.equal(w.effects[0]!.status,'succeeded');assert.equal(w.budget.measured,5);
});
test('lost quarantine response is reconciled by original command identity without a second mutation',async()=>{
 const s=await pending();const revision=(await s.store.load('m'))!.revision;const original=s.store.commit.bind(s.store);let once=true;
 s.store.commit=async input=>{const result=await original(input);if(once&&input.events.some(event=>(event as {type:string}).type==='quarantine-runtime')){once=false;throw new Error('Injected response loss after commit');}return result;};
 const input={commandId:'response-lost',expectedRevision:revision,command:quarantine()};await assert.rejects(s.product.intervene('m',input),/response loss/);const snapshot=await s.store.load('m');const count=s.store.inspect().length;
 assert.equal((await s.product.intervene('m',input)).status,'replayed');assert.equal(s.store.inspect().length,count);assert.deepEqual(await s.store.load('m'),snapshot);
});
test('portable lineage accepts genuine quarantine journal and rejects unbound or fabricated recovery evidence',async()=>{
 const s=await pending();await s.send(quarantine());const value=(await s.store.load('m'))!.value;
 validateMissionLineage(value);validateMissionJournalLineage(s.store.inspect());
 for(const change of [
  (w:Mission['works'][number])=>{delete w.runtimeRecovery;},
  (w:Mission['works'][number])=>{w.effects[0]!.receipt='Invented by owner';},
  (w:Mission['works'][number])=>{w.runtimeRecovery!.runId='different';},
  (w:Mission['works'][number])=>{w.runtimeRecovery!.pendingEffectIds=['missing'];},
  (w:Mission['works'][number])=>{w.execution='active';},
  (w:Mission['works'][number])=>{w.budget.measured=0;},
 ]){const bad=structuredClone(value);change(bad.works[0]!);assert.throws(()=>validateMissionLineage(bad));}
});

test('portable lineage retains strict historical provider descriptor metadata without granting authority',async()=>{
 const s=await pending();const source=(await s.store.load('m'))!.value;
 const historical=structuredClone(source);Object.assign(historical.works[0]!.assignments[0]!.model,{enabled:true,capabilities:['text-output']});validateMissionLineage(historical);
 for(const extra of [{enabled:'true'},{capabilities:'text-output'},{capabilities:[7]},{capabilities:['']},{credential:'forbidden-extra'}]){
  const bad=structuredClone(historical);Object.assign(bad.works[0]!.assignments[0]!.model,extra);assert.throws(()=>validateMissionLineage(bad));
 }
});
