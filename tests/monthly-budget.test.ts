import test from 'node:test';
import assert from 'node:assert/strict';
import {MonthlyBudgetService,MONTHLY_BUDGET_ID,accountingPeriod} from '../src/monthly-budget.ts';
import {InMemoryStore} from '../src/storage.ts';
import {Application} from '../src/application.ts';
import type {Mission} from '../src/domain.ts';
const now=Date.parse('2026-11-01T00:30:00Z');
async function fixture(limit=100){
 const store=new InMemoryStore<Mission>(),service=new MonthlyBudgetService(store,()=>now),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'runtime-representative',roles:['representative']}],()=>now);
 await app.create({id:'mission',purpose:'Budget test',scope:'local',constraints:[],criteria:{version:1,description:'Text',oracle:'bounded-text-review/v1'}},'local-owner','create');
 for(const workId of ['one','two']){const s=(await store.load('mission'))!;await app.dispatch({missionId:'mission',commandId:'admit-'+workId,expectedRevision:s.revision,actorId:'local-owner',command:{type:'admit-work',workId,title:workId,budget:200}});}
 await service.configure({commandId:'configure',expectedRevision:0,limit,timezone:'America/Los_Angeles'});return {store,service,app};
}
test('calendar accounting uses the owner timezone on either side of a month boundary',()=>{
 assert.equal(accountingPeriod(now,'America/Los_Angeles'),'2026-10');assert.equal(accountingPeriod(now,'Asia/Seoul'),'2026-11');
 assert.equal(accountingPeriod(Date.parse('2026-03-08T10:30:00Z'),'America/Los_Angeles'),'2026-03');assert.throws(()=>accountingPeriod(now,'invalid/timezone'));
});
test('overlapping admission reserves once; excess Work waits behind one owner decision across restart',async()=>{
 const {store,service}=await fixture();
 const input={missionId:'mission',workId:'one',runId:'run-one',amount:80};
 const results=await Promise.all([service.admit(input),service.admit(input)]);assert.equal(results.filter(r=>r==='reserved').length,1);assert.equal(results.filter(r=>r==='replayed').length,1);
 assert.equal(await service.admit({missionId:'mission',workId:'two',runId:'run-two',amount:80}),'waiting');
 const s=(await store.load('mission'))!;assert.equal(s.value.works[1]!.execution,'budget-waiting');assert.equal(s.value.works[1]!.runtimeRun,undefined);
 const restarted=new MonthlyBudgetService(store,()=>now);assert.equal(await restarted.admit({missionId:'mission',workId:'two',runId:'another-id',amount:80}),'waiting');
 const view=await restarted.read();assert.equal(view.decisions.length,1);assert.equal(view.reserved,80);assert.equal(view.cost,null);assert.equal(view.unit,'output-tokens');
 const d=view.decisions[0]!;assert.deepEqual(d.rows,[['지금','100'],['늘린 뒤','160'],['멈춘 일','two']]);assert.equal(d.budget.limit,160);await restarted.decide({commandId:'later',decisionId:d.id,answer:'later',expectedRevision:view.revision});
 assert.equal((await restarted.read()).decisions[0]!.state,'later');assert.equal((await store.load('mission'))!.value.works[1]!.execution,'budget-waiting');
 const deferred=await restarted.read();await restarted.decide({commandId:'reopen',decisionId:d.id,answer:'ask',expectedRevision:deferred.revision});
 const opened=await restarted.read();assert.equal(opened.decisions[0]!.state,'open');
 const body={commandId:'raise',decisionId:d.id,answer:'act',expectedRevision:opened.revision,limit:opened.decisions[0]!.budget.limit};
 const accepted=await restarted.decide(body);assert.equal(accepted.status,'committed');assert.equal((await restarted.decide(body)).status,'replayed');
 assert.equal((await store.load('mission'))!.value.works[1]!.execution,'budget-waiting','the recorded decision alone never invokes or resumes');
 const saved=await store.load(MONTHLY_BUDGET_ID) as any;assert.equal(saved.value.actorId,'local-owner');assert.equal(saved.value.limit,160);
});
test('stale budget changes and non-increases cannot authorize waiting Work',async()=>{
 const {service}=await fixture(1);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});const v=await service.read(),d=v.decisions[0]!;
 assert.equal((await service.configure({commandId:'stale',expectedRevision:0,limit:1000,timezone:v.timezone})).status,'conflict');
 await assert.rejects(service.decide({commandId:'wrong',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:1}),/increase|limit/i);
 assert.equal((await service.read()).limit,1);
});

test('budget journal replay retains owner decisions and rejects tampered limits',async()=>{
 const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');const {store,service}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});
 const v=await service.read();await service.decide({commandId:'defer',decisionId:v.decisions[0]!.id,expectedRevision:v.revision,answer:'later'});validateMissionJournalLineage(store.inspect());
 const corrupt=store.inspect();(corrupt.at(-1)!.value as any).limit=999;assert.throws(()=>validateMissionJournalLineage(corrupt),/transition mismatch/);
});
test('month rollover and a settings increase leave a deferred Work paused',async()=>{
 const {store,service}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});const v=await service.read();await service.decide({commandId:'defer',decisionId:v.decisions[0]!.id,expectedRevision:v.revision,answer:'later'});
 const next=new MonthlyBudgetService(store,()=>Date.parse('2026-12-01T10:00:00Z')),rolled=await next.read();assert.equal(rolled.period,'2026-12');await next.configure({commandId:'settings-increase',expectedRevision:rolled.revision,limit:1000,timezone:rolled.timezone});
 assert.equal((await store.load('mission'))!.value.works[0]!.execution,'budget-waiting');assert.equal((await next.read()).decisions[0]!.state,'later');
});
test('a lost reservation acknowledgment cannot authorize dispatch on a fresh service',async()=>{
 const {store,service}=await fixture();const commit=store.commit.bind(store);let lost=true;store.commit=async input=>{const result=await commit(input);if(input.id===MONTHLY_BUDGET_ID&&lost){lost=false;throw new Error('Lost reservation acknowledgment');}return result;};
 await assert.rejects(service.admit({missionId:'mission',workId:'one',runId:'run',amount:80}),/Lost/);const restarted=new MonthlyBudgetService(store,()=>now);assert.equal(await restarted.admit({missionId:'mission',workId:'one',runId:'run',amount:80}),'replayed');assert.equal((await store.load('mission'))!.value.works[0]!.runtimeRun,undefined);
});

test('raising one decision releases each of its waiting Works through a new bounded reservation',async()=>{
 const {store,service}=await fixture(0);for(const workId of ['one','two'])await service.admit({missionId:'mission',workId,runId:'run-'+workId,amount:80});const v=await service.read(),d=v.decisions[0]!;
 await service.decide({commandId:'raise-both',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});const resumed:string[]=[];
 await service.resume(d.id,async r=>{assert.equal(await service.admit({missionId:r.missionId,workId:r.workId,runId:'resumed-'+r.workId,amount:80}),'reserved');resumed.push(r.workId);});
 assert.deepEqual(resumed,['one','two']);assert.equal((await service.read()).reserved,160);assert.equal((await store.load('mission'))!.value.works[1]!.execution,'queued');
});

test('an unrelated revision conflict cannot leave a budget-blocked Work looking queued',async()=>{
 const {store,service}=await fixture(0),commit=store.commit.bind(store);let conflict=true;store.commit=async input=>{if(input.id==='mission'&&(input.events[0] as any)?.type==='wait-monthly-budget'&&conflict){conflict=false;return {status:'conflict',revision:input.expectedRevision,reason:'revision'};}return commit(input);};
 assert.equal(await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80}),'waiting');assert.equal((await store.load('mission'))!.value.works[0]!.execution,'budget-waiting');
});
