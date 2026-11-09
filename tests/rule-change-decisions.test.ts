import test from 'node:test';
import assert from 'node:assert/strict';
import {RuleChangesService} from '../src/rule-changes.ts';
import {proposalFixture} from './support/growth-proposal-fixture.ts';
import {ProductService} from '../src/product.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';

test('evaluated exact rounding evidence produces an owner decision; later/ask never adopt and act is replayed',async t=>{
 const f=await proposalFixture(t);await f.product.proposeGrowth('mission',f.proposal);const revision=(await f.store.load('mission'))!.revision;
 await f.product.evaluateGrowth('mission',{...f.evaluation(),expectedRevision:revision});
 const service=new RuleChangesService(f.store,()=> 'mission'),cards=await service.decisions();assert.equal(cards.length,1);const card=cards[0]!;
 assert.equal(card.state,'open');assert.equal(card.ruleChange.growthId,'new-growth');assert.equal(card.ruleChange.cases.orders.length,2);
 const before=(await f.store.load('mission'))!;assert.equal(before.value.memories.find(m=>m.version===2)!.effective,false);
 const later={commandId:'rule-later',decisionId:card.id,answer:'later'};assert.equal((await service.decide(later)).status,'committed');assert.equal((await service.decisions())[0]!.state,'later');assert.doesNotMatch((await service.decisions())[0]!.line,/바꿈/);
 await service.decide({commandId:'rule-ask',decisionId:card.id,answer:'ask'});const act={commandId:'rule-act',decisionId:card.id,answer:'act'};
 const answers=await Promise.all([service.decide(act),service.decide(act)]);assert.ok(answers.every(r=>['committed','replayed'].includes(r.status)));
 const after=(await f.store.load('mission'))!;assert.equal(after.revision,before.revision+3);assert.equal(after.value.memories.find(m=>m.version===2)!.effective,true);assert.deepEqual(after.value.works,before.value.works);
 assert.equal((await service.decisions())[0]!.state,'done');assert.equal((await service.decide(act)).status,'replayed');validateMissionJournalLineage(await f.journal());
});

test('rule owner decisions retain drain fencing and refuse stale baseline/card identity',async t=>{
 const f=await proposalFixture(t);await f.product.proposeGrowth('mission',f.proposal);await f.product.evaluateGrowth('mission',{...f.evaluation(),expectedRevision:(await f.store.load('mission'))!.revision});
 const service=new RuleChangesService(f.store,()=> 'mission'),card=(await service.decisions())[0]!,before=(await f.store.load('mission'))!;
 let draining=false;const owner=new Proxy(f.store,{get(target,key){if(key==='commit')return (input:any)=>{if(draining)throw new HostDrainError();return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const guarded=new RuleChangesService(owner,()=> 'mission');draining=true;await assert.rejects(guarded.decide({commandId:'drained',decisionId:card.id,answer:'act'}),HostDrainError);assert.deepEqual(await f.store.load('mission'),before);
 await new ProductService(f.store).saveMemory('mission',{commandId:'newer-rule',expectedRevision:before.revision,memory:{id:'rounding',version:3,content:'Round each line',source:'Owner replacement'}});
 await assert.rejects(service.decide({commandId:'stale',decisionId:card.id,answer:'act'}),/baseline|binding|current/i);
 await assert.rejects(service.decide({commandId:'wrong',decisionId:card.id+'x',answer:'later'}),/Unknown|identity/i);
});

test('owner proposal producers retain names and exact source Work metadata without guessing from source text',async t=>{
 const f=await proposalFixture(t),current=(await f.store.load('mission'))!,work=current.value.works[0]!;
 const {memoryWorkSource}=await import('../src/memory-candidates.ts'),sourceWork=memoryWorkSource(current.value,work);
 await f.product.saveMemory('mission',{commandId:'named-memory',expectedRevision:current.revision,memory:{id:'named',version:1,name:'Named instruction',content:'Owner instruction',source:'Literal owner provenance',sourceWork}});
 const after=(await f.store.load('mission'))!;assert.deepEqual(after.value.memories.at(-1)!.sourceWork,sourceWork);assert.equal(after.value.memories.at(-1)!.name,'Named instruction');
 await f.product.proposeGrowth('mission',{...f.proposal,expectedRevision:after.revision,candidate:{...f.proposal.candidate,name:'Rounding policy',sourceWork}});const m=(await f.store.load('mission'))!.value.memories.at(-1)!;assert.deepEqual(m.sourceWork,sourceWork);assert.equal(m.name,'Rounding policy');validateMissionJournalLineage(await f.journal());
});
