import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {runCalculationScenario,runDocumentScenario,FixtureWorkflow} from '../src/scenario.ts';
test('actual wrong/fixed file effects flow through product commands and Records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-scenario-'));try{
 const store=new InMemoryStore<Mission>();const result=await runCalculationScenario(store,root);
 const work=result.snapshot!.value.works[0]!;assert.equal(work.acceptance,'accepted');assert.equal(work.attempts.length,2);assert.equal(work.effects.length,2);assert.equal(work.record?.evidenceClass,'fixture');assert.equal(work.tasks.length,2);assert.equal(result.firstVerdict,'failed');
 const reconnected=new FixtureWorkflow(store,root,result.missionId);assert.deepEqual(await reconnected.work(result.workId),work);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('non-coding Work uses same independent acceptance contract',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-document-'));try{const result=await runDocumentScenario(new InMemoryStore<Mission>(),root);assert.equal(result.snapshot?.value.works[0]?.record?.artifact.kind,'document');}finally{await rm(root,{recursive:true,force:true});}
});
test('Records checksum remains valid after storage canonicalization',async()=>{
 const {hash}=await import('../src/domain.ts');const root=await mkdtemp(join(tmpdir(),'massion-checksum-'));try{
 const result=await runCalculationScenario(new InMemoryStore<Mission>(),root);const {checksum,...bundle}=result.snapshot!.value.works[0]!.record!;assert.equal(hash(bundle),checksum);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('direct file tamper after pass is rejected at application acceptance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-tamper-'));try{
 const flow=new FixtureWorkflow(new InMemoryStore<Mission>(),root,'tamper');await flow.create();await flow.admit('tamper-work','Test tamper');const output=await flow.execute('tamper-work','correct');await flow.verify('tamper-work',output.workspace);
 await appendFile(output.artifact.path,'// changed');await assert.rejects(flow.accept('tamper-work',output.workspace),/does not pass/);assert.equal((await flow.work('tamper-work')).acceptance,'stale');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('held-out Growth affects second actual Work and revert preserves its historical binding',async()=>{
 const {runGrowthScenario}=await import('../src/scenario.ts');const root=await mkdtemp(join(tmpdir(),'massion-growth-'));try{
 const result=await runGrowthScenario(new InMemoryStore<Mission>(),root);const state=result.snapshot!.value;
 assert.ok(result.evaluation.candidate>result.evaluation.baseline);
 assert.equal(state.works.find(w=>w.id===result.workA)?.attempts.length,2);
 assert.equal(state.works.find(w=>w.id===result.workB)?.attempts.length,1);
 assert.deepEqual(state.works.find(w=>w.id===result.workB)?.appliedMemoryVersions,['rounding@2']);
 assert.deepEqual(state.works.find(w=>w.id===result.afterRevert)?.appliedMemoryVersions,['rounding@1']);
 assert.equal(state.growth[0]?.status,'reverted');assert.equal(state.growth[0]?.observation?.metric,8);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('actual SurrealDB persists the complete fixture A→Growth→B route for a fresh client', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async()=>{
 const {SurrealStore,createHttpRpcTransport,initializeSurrealSchema}=await import('../src/storage.ts');const {runGrowthScenario}=await import('../src/scenario.ts');const {hash}=await import('../src/domain.ts');
 const root=await mkdtemp(join(tmpdir(),'massion-durable-'));try{
 const options={endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE??'massion_storage_tests',database:process.env.MASSION_TEST_SURREAL_DATABASE??'massion_storage_tests'};
 const transport=createHttpRpcTransport(options);await initializeSurrealSchema(transport);const store=new SurrealStore<Mission>(transport);
 const result=await runGrowthScenario(store,root);
 const clientB=new SurrealStore<Mission>(createHttpRpcTransport(options));const reloaded=await clientB.load(result.missionId);assert.deepEqual(reloaded,result.snapshot);
 for(const work of reloaded!.value.works.filter(w=>w.record)){const {checksum,...bundle}=work.record!;assert.equal(hash(bundle),checksum);}
 const document=await runDocumentScenario(store,root);assert.equal((await clientB.load(document.missionId))?.value.works[0]?.acceptance,'accepted');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('crash after real write before receipt cannot cause a new effect on reconnect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-crash-'));try{
 const store=new InMemoryStore<Mission>();const flow=new FixtureWorkflow(store,root,'crash');await flow.create();await flow.admit('crash-work','Receipt crash');
 const send=flow.send.bind(flow);flow.send=async(command,actor)=>{if(command.type==='receipt')throw new Error('Injected crash before receipt');return send(command,actor);};
 await assert.rejects(flow.execute('crash-work','correct'),/Injected crash/);
 const restarted=new FixtureWorkflow(store,root,'crash');await assert.rejects(restarted.execute('crash-work','correct'),/Unresolved effect/);
 let work=await restarted.work('crash-work');assert.equal(work.effects.length,1);assert.equal(work.effects[0]?.status,'pending');
 await restarted.markInterruptedEffectsUnknown('crash-work');work=await restarted.work('crash-work');assert.equal(work.effects[0]?.status,'unknown');
 await assert.rejects(restarted.execute('crash-work','correct'),/Unresolved effect/);assert.equal((await restarted.work('crash-work')).effects.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
