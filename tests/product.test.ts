import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductService} from '../src/product.ts';
import {ProviderRegistry} from '../src/providers.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
const input={id:'user-mission',purpose:'Prepare my delivery review',scope:'delivery',constraints:['No external sharing'],criteria:{version:1,description:'Summarize source-backed open issues',oracle:'manual-review/v1'}};
test('user Work persists provider-unavailable instead of silently executing fixture',async()=>{
 const service=new ProductService(new InMemoryStore<Mission>());await service.create(input,'create');
 const result=await service.admit(input.id,{commandId:'admit',expectedRevision:1,workId:'work',title:'Review readiness',budget:5});assert.notEqual(result.status,'conflict');if(result.status==='conflict')return;
 const work=result.value.works[0]!;assert.equal(work.execution,'blocked');assert.equal(work.blocker?.code,'provider_unavailable');assert.equal(work.effects.length,0);assert.equal(work.assignments.length,0);assert.equal(work.record,undefined);
 const steered=await service.intervene(input.id,{commandId:'steer',expectedRevision:2,command:{type:'steer',workId:'work',instruction:'Focus on unresolved blockers'}});assert.notEqual(steered.status,'conflict');if(steered.status==='conflict')return;
 assert.equal(steered.value.works[0]?.execution,'blocked');assert.equal(steered.value.works[0]?.instructions?.[0]?.text,'Focus on unresolved blockers');
 const cancelled=await service.intervene(input.id,{commandId:'cancel',expectedRevision:3,command:{type:'cancel',workId:'work'}});assert.notEqual(cancelled.status,'conflict');if(cancelled.status==='conflict')return;assert.equal(cancelled.value.works[0]?.execution,'cancelled');
});
test('fixture provider and disabled real provider cannot satisfy product selection',()=>{
 const invoke=async()=>{throw new Error('Never invoked');};
 const descriptors=[{provider:'fixture',model:'test',configVersion:'1',enabled:true,capabilities:['text-output'],evidenceClass:'fixture' as const},{provider:'real',model:'test',configVersion:'1',enabled:false,capabilities:['text-output'],evidenceClass:'real-provider' as const}];
 assert.equal(new ProviderRegistry(descriptors.map(descriptor=>({descriptor,invoke}))).select(['text-output']).status,'unavailable');
});
test('configured provider is not executed before runtime and assurance authorization',async()=>{
 let called=false;const service=new ProductService(new InMemoryStore<Mission>(),new ProviderRegistry([{descriptor:{provider:'configured',model:'user-choice',configVersion:'1',enabled:true,capabilities:['text-output'],evidenceClass:'real-provider'},invoke:async()=>{called=true;throw new Error('must not run');}}]));
 await service.create(input,'create');const result=await service.admit(input.id,{commandId:'admit',expectedRevision:1,workId:'work',title:'Task',budget:1});assert.notEqual(result.status,'conflict');if(result.status==='conflict')return;assert.equal(result.value.works[0]?.blocker?.code,'runtime_unavailable');assert.equal(called,false);
 await assert.rejects(service.intervene(input.id,{commandId:'forge',expectedRevision:2,command:{type:'accept',workId:'work',recordId:'r'}}),/Only cancel, steer and quarantine-runtime/);
});
