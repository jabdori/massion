import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {apply} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage,validateMissionLineage} from '../src/backup-lineage.ts';
import {seedGrowth} from './support/growth-fixture.ts';

const owner={id:'local-owner',roles:['owner'] as ['owner']};
const adopt={type:'adopt-growth',growthId:'g',baseline:'rounding@1',candidate:'rounding@2',recordChangeTime:true} as const;
const revert={...adopt,type:'revert-growth'} as const;

test('Growth records durable transition times once, including replay and lineage',async()=>{
 const store=new InMemoryStore<Mission>(),f=await seedGrowth(store);let at=Date.UTC(2026,10,3,9),reads=0;
 const app=new Application(store,[owner],()=>{reads++;return at;});
 const envelope={missionId:f.id,commandId:'dated-adopt',expectedRevision:(await store.load(f.id))!.revision,actorId:owner.id,command:adopt};
 assert.equal((await app.dispatch(envelope)).status,'committed');assert.equal((await store.load(f.id))!.value.growth[0]!.adoptedAt,at);
 at+=86400000;assert.equal((await app.dispatch(envelope)).status,'replayed');assert.equal(reads,1);
 await app.dispatch({...envelope,commandId:'dated-revert',expectedRevision:(await store.load(f.id))!.revision,command:revert});
 const growth=(await store.load(f.id))!.value.growth[0]!;assert.equal(growth.adoptedAt,at-86400000);assert.equal(growth.revertedAt,at);validateMissionJournalLineage(store.inspect());
});

test('Growth keeps legacy commands and journals undated',async()=>{
 const store=new InMemoryStore<Mission>(),f=await seedGrowth(store);await f.send({type:'adopt-growth',growthId:'g'});await f.send({type:'revert-growth',growthId:'g'});
 const growth=(await store.load(f.id))!.value.growth[0]!;assert.equal(Object.hasOwn(growth,'adoptedAt'),false);assert.equal(Object.hasOwn(growth,'revertedAt'),false);validateMissionJournalLineage(store.inspect());
});

test('Growth rejects missing, invalid and reversed transition clocks and fabricated proposal dates',async()=>{
 const store=new InMemoryStore<Mission>(),f=await seedGrowth(store),mission=(await store.load(f.id))!.value;
 assert.throws(()=>apply(mission,adopt,owner),/time|clock/i);
 for(const observedAt of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER])assert.throws(()=>apply(mission,adopt,owner,{observedAt}),/time|clock/i);
 assert.throws(()=>apply(mission,{...adopt,recordChangeTime:false} as unknown as Command,owner,{observedAt:1}),/time|clock|marker/i);
 const adopted=apply(mission,adopt,owner,{observedAt:100}).value;assert.throws(()=>apply(adopted,revert,owner,{observedAt:99}),/time|clock/i);
 const proposal={...mission.growth[0]!,id:'forged',status:'proposed' as const,adoptedAt:1};delete proposal.evaluator;delete proposal.scores;
 assert.throws(()=>apply(mission,{type:'propose-growth',proposal},{id:'representative',roles:['representative']}),/proposal/i);
 for(const time of [-1,1.5,Number.MAX_SAFE_INTEGER]){const bad=structuredClone(adopted);bad.growth[0]!.adoptedAt=time;assert.throws(()=>validateMissionLineage(bad),/time/i);}
});

test('B12 fixture has active explicit policy, a pending learned decision and real earlier transition dates',async()=>{
 const {readFile}=await import('node:fs/promises'),{memoryHistoryFixture}=await import('../scripts/ui-contracts/memory-history-fixture.ts');
 const template=JSON.parse(await readFile(new URL('../scripts/ui-contracts/fixtures/B12.json',import.meta.url),'utf8')),original=structuredClone(template),fixture=await memoryHistoryFixture(template);
 const mission=(fixture.routes['/missions/intake']!.body as {value:Mission}).value;assert.equal(mission.memories.find(m=>m.version===1)!.effective,true);assert.equal(mission.memories.find(m=>m.version===2)!.effective,false);
 const history=mission.growth.find(g=>g.status==='reverted')!,pending=mission.growth.find(g=>g.status==='evaluated')!;assert.ok(history.adoptedAt!<history.revertedAt!);assert.ok(history.revertedAt!<pending.ruleChange!.at);assert.equal(history.ruleChange!.at<history.adoptedAt!,true);
 const decisions=(fixture.routes['/assistant/conversation']!.body as any).decisions,decision=decisions.find((d:any)=>d.ruleChange?.growthId===pending.id);assert.equal(decision.state,'open');assert.equal(decision.at,pending.ruleChange!.at);
 assert.ok(mission.memories[0]!.sourceWork);assert.deepEqual((fixture.routes['/read-state?mission=intake']!.body as any).snapshot.value.growth,mission.growth);assert.deepEqual(template,original);
});

test('owner Product commands record host time and can date a revert of an undated legacy adoption',async()=>{
 for(const legacy of [false,true]){
  const store=new InMemoryStore<Mission>(),f=await seedGrowth(store),before=Date.now();
  if(legacy)await f.send({type:'adopt-growth',growthId:'g'});else await f.product.adoptGrowth(f.id,{...f.input(),commandId:'product-adopt',expectedRevision:(await store.load(f.id))!.revision});
  await f.product.revertGrowth(f.id,{...f.input(),commandId:'product-revert',expectedRevision:(await store.load(f.id))!.revision});
  const growth=(await store.load(f.id))!.value.growth[0]!;assert.ok(growth.revertedAt!>=before&&growth.revertedAt!<=Date.now());
  if(legacy)assert.equal(Object.hasOwn(growth,'adoptedAt'),false);else assert.ok(growth.adoptedAt!>=before&&growth.adoptedAt!<=growth.revertedAt!);validateMissionJournalLineage(store.inspect());
 }
});

test('Product retries of legacy adoption and reversion return their original receipts without adding dates',async()=>{
 const {ProductService}=await import('../src/product.ts'),{Application}=await import('../src/application.ts'),{InMemoryStore}=await import('../src/storage.ts');
 const store=new InMemoryStore<Mission>(),f=await seedGrowth(store),mission=(await store.load(f.id))!.value,app=new Application(store,[owner]),product=new ProductService(store);
 for(const action of ['adopt','revert'] as const){const input={commandId:'legacy-'+action,expectedRevision:(await store.load(mission.id))!.revision,growthId:'g',baseline:'rounding@1',candidate:'rounding@2'},command={type:(action==='adopt'?'adopt-growth':'revert-growth') as 'adopt-growth'|'revert-growth',growthId:'g',baseline:input.baseline,candidate:input.candidate};await app.dispatch({missionId:mission.id,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:owner.id,command});const before=await store.load(mission.id);assert.equal((await (action==='adopt'?product.adoptGrowth(mission.id,input):product.revertGrowth(mission.id,input))).status,'replayed');assert.deepEqual(await store.load(mission.id),before);}
});
