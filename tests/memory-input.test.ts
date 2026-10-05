import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductService} from '../src/product.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {pinnedMemoryInput,MAX_PINNED_MEMORY_BYTES} from '../src/memory-input.ts';
import {workAdmissionPreflight} from '../src/configured-runtime.ts';

async function history(){
 const store=new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:owner-memory';
 await product.create({id,purpose:'Remember my instructions',scope:'project',constraints:[],criteria:{version:1,description:'Inspect versioned inputs',oracle:'manual-review/v1'}},'create');
 await product.saveMemory(id,{commandId:'memory-v1',expectedRevision:1,memory:{id:'instruction',version:1,content:'Keep original amounts',source:'Owner instruction v1'}});
 await product.admit(id,{commandId:'old-work',expectedRevision:2,workId:'old',title:'Old Work',budget:0});
 await product.saveMemory(id,{commandId:'memory-v2',expectedRevision:3,memory:{id:'instruction',version:2,content:'Show original and rounded amounts',source:'Owner revision v2'}});
 await product.admit(id,{commandId:'new-work',expectedRevision:4,workId:'new',title:'Future Work',budget:0});
 const snapshot=(await store.load(id))!;return {store,product,id,snapshot};
}
test('normal owner service memory revisions preserve immutable historical input and pin future Work without execution',async()=>{
 const {store,product,id,snapshot}=await history(),[old,future]=snapshot.value.works;
 assert.deepEqual(old!.appliedMemoryVersions,['instruction@1']);assert.deepEqual(future!.appliedMemoryVersions,['instruction@2']);
 assert.deepEqual(pinnedMemoryInput(snapshot.value,old!).map(m=>[m.version,m.content,m.authority,m.source]),[[1,'Keep original amounts','explicit','Owner instruction v1']]);
 assert.deepEqual(pinnedMemoryInput(snapshot.value,future!).map(m=>m.content),['Show original and rounded amounts']);assert.deepEqual(snapshot.value.memories.map(m=>m.effective),[false,true]);
 const journal=store.inspect();await assert.rejects(product.saveMemory(id,{commandId:'overwrite',expectedRevision:5,memory:{id:'instruction',version:2,content:'Overwrite history',source:'new'}}),/immutable/);assert.deepEqual(store.inspect(),journal);
 const replay=await product.saveMemory(id,{commandId:'memory-v2',expectedRevision:3,memory:{id:'instruction',version:2,content:'Show original and rounded amounts',source:'Owner revision v2'}});assert.equal(replay.status,'replayed');assert.deepEqual(store.inspect(),journal);
 const conflict=await product.saveMemory(id,{commandId:'stale',expectedRevision:2,memory:{id:'instruction',version:3,content:'Stale update',source:'owner'}});assert.equal(conflict.status,'conflict');assert.deepEqual(store.inspect(),journal);
 assert.ok(snapshot.value.works.every(w=>!w.effects.length&&!w.runtimeRun&&!w.record));
});
for(const corruption of ['missing','duplicate','scope','authority','empty-content','oversized'])test(`unusable ${corruption} pinned memory blocks preflight instead of using current effective memory`,async()=>{
 const {snapshot}=await history(),value=structuredClone(snapshot.value),work=value.works[0]!;
 const m=value.memories[0]!;
 if(corruption==='missing')value.memories=value.memories.filter(x=>x.version!==1);
 if(corruption==='duplicate')value.memories.push(structuredClone(m));
 if(corruption==='scope')m.scope='other-project';
 if(corruption==='authority')(m as any).authority='system';
 if(corruption==='empty-content')m.content='';
 if(corruption==='oversized'){
  value.memories=[];work.appliedMemoryVersions=[];for(let i=0;i<8;i++){const memory={...m,id:'long-'+i,content:'é'.repeat(16000)};value.memories.push(memory);work.appliedMemoryVersions.push(memory.id+'@1');}
  assert.ok(Buffer.byteLength(JSON.stringify(value.memories))>MAX_PINNED_MEMORY_BYTES);
 }
 assert.throws(()=>pinnedMemoryInput(value,work));const check=workAdmissionPreflight({...snapshot,value},work.id,snapshot.revision);assert.equal(check.ready,false);assert.ok(check.diagnostics.some(d=>d.code==='memory_input_unavailable'));
});
test('original learned authority remains distinguishable and current effective state never changes pinned task data',async()=>{
 const {snapshot}=await history(),m=snapshot.value.memories[0]!,work=snapshot.value.works[0]!;m.authority='learned';const before=pinnedMemoryInput(snapshot.value,work);m.effective=true;assert.deepEqual(pinnedMemoryInput(snapshot.value,work),before);assert.equal(before[0]?.authority,'learned');assert.equal('effective' in before[0]!,false);
});
