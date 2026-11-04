import {once} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {lifetimeFixture as fixture} from './support/runtime-lifetime-fixture.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('owner cancellation settles admitted invocation promptly when controlled adapter ignores AbortSignal; late output cannot advance Work',async t=>{
 const f=await fixture(t,false,{hold:'executor'}),run=f.product.run('mission','fresh','owned-run',(await f.current()).revision);await f.until(()=>f.calls.length===1);await f.product.intervene('mission',{commandId:'owner-cancel',expectedRevision:(await f.current()).revision,command:{type:'cancel',workId:'fresh'}});let settled=false;run.finally(()=>settled=true).catch(()=>{});await pause(150);try{assert.equal(settled,true,'Cancelled run must not wait for an uncooperative adapter');const result=await run,w=result.snapshot.value.works.find(w=>w.id==='fresh')!;assert.equal(result.status,'cancelled');assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.budget.measured,null);assert.equal(w.record,undefined);const journal=await f.journal();f.release();await pause(30);assert.deepEqual(await f.journal(),journal);assert.deepEqual((await f.current()).value.works[0],f.original.value.works[0]);}finally{f.release();await run.catch(()=>{});}
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} declared owned deadline closes uncooperative dispatch as unknown and rejects late progression without replay`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await fixture(t,durable,{hold:'executor',runTimeoutMs:durable?1500:100}),result=await f.product.run('mission','fresh','deadline-run',(await f.current()).revision),w=result.snapshot.value.works.find(w=>w.id==='fresh')!;assert.equal(result.status,'blocked');assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.signal.aborted,true);assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.budget.reserved,4);assert.equal(w.budget.measured,null);assert.ok(w.runtimeInterruption);assert.ok(w.runtimeInterruption.observedAt>=w.runtimeRun!.ownership!.deadlineAt);assert.equal(w.artifact,undefined);assert.equal(w.record,undefined);assert.equal(f.runtime.owns('mission','fresh','deadline-run'),false);const journal=await f.journal();f.release();await pause(30);assert.deepEqual(await f.journal(),journal);assert.equal((await f.product.run('mission','fresh','another',(await f.current()).revision)).status,'already-started');assert.deepEqual((await f.current()).value.works[0],f.original.value.works[0]);const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');validateMissionJournalLineage(await f.journal());
});

for(const committed of [false,true])test(`deadline during final acceptance ${committed?'acknowledgment preserves committed Record':'admission refuses late Record'}`,async t=>{
 const f=await fixture(t,false,{runTimeoutMs:500});let held=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);t.after(()=>release());
 const base=f.store;
 const store=new Proxy(base,{get(target,key){
  if(!committed&&key==='lookupOperation')return async(identity:any)=>{
   const snapshot=await target.load('mission'),w=snapshot!.value.works.find(w=>w.id==='fresh')!;
   if(!held&&w.tasks.find(task=>task.id==='fresh:root')?.status==='settled'){held=true;await gate;}
   return target.lookupOperation(identity);
  };
  if(committed&&key==='commit')return async(input:any)=>{
   const result=await target.commit(input);
   if(!held&&input.value.works.find((w:any)=>w.id==='fresh')?.acceptance==='accepted'){held=true;await gate;}
   return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const {ConfiguredTextRuntime}=await import('../src/configured-runtime.ts'),runtime=new ConfiguredTextRuntime(store,f.config);
 const run=runtime.run('mission','fresh','accept-race',(await f.current()).revision);
 await f.until(()=>held);const deadline=(await f.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun!.ownership!.deadlineAt;await pause(Math.max(0,deadline-Date.now())+30);release();
 const result=await run,w=result.snapshot.value.works.find(w=>w.id==='fresh')!;
 assert.equal(result.status,committed?'settled':'blocked');assert.equal(w.acceptance,committed?'accepted':'pending');assert.equal(!!w.record,committed);assert.equal(!!w.runtimeInterruption,!committed);assert.equal(f.calls.length,2);
 assert.deepEqual((await f.current()).value.works[0],f.original.value.works[0]);
});

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} concurrent host contenders and same/different run retries retain one dispatch owner`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await fixture(t,durable,{hold:'executor'}),{ConfiguredTextRuntime}=await import('../src/configured-runtime.ts'),other=new ConfiguredTextRuntime(f.store,f.config),revision=(await f.current()).revision;
 const first=f.runtime.run('mission','fresh','owner-one',revision);await f.until(()=>f.calls.length===1);
 assert.equal(f.runtime.owns('mission','fresh','owner-one'),true);assert.equal(other.owns('mission','fresh','owner-one'),false);
 const results=await Promise.all([other.run('mission','fresh','owner-one',revision),other.run('mission','fresh','owner-two',revision)]);assert.ok(results.every(r=>r.status==='already-started'));assert.equal(f.calls.length,1);
 const {ProductService}=await import('../src/product.ts');await f.product.intervene('mission',{commandId:'contender-cancel',expectedRevision:(await f.current()).revision,command:{type:'cancel',workId:'fresh'}});await first;assert.equal(f.calls.length,1);assert.deepEqual((await f.current()).value.works[0],f.original.value.works[0]);
});
test('simultaneous fresh runtime CAS admits one owner and exactly two role calls',async t=>{
 const f=await fixture(t),{ConfiguredTextRuntime}=await import('../src/configured-runtime.ts'),other=new ConfiguredTextRuntime(f.store,f.config),revision=(await f.current()).revision;
 const results=await Promise.all([f.runtime.run('mission','fresh','cas-one',revision),other.run('mission','fresh','cas-two',revision)]);assert.equal(results.filter(r=>r.status==='settled').length,1);assert.equal(results.filter(r=>r.status==='conflict').length,1);assert.equal(f.calls.length,2);
});
test('cancellation after effect admission but before invocation makes zero adapter calls and known zero usage',async t=>{
 const f=await fixture(t),runtime=f.runtime as any,send=runtime.send.bind(runtime);runtime.send=async(missionId:string,command:any,...rest:any[])=>{const value=await send(missionId,command,...rest);if(command.type==='admit-effect')await f.product.intervene('mission',{commandId:'before-call-cancel',expectedRevision:(await f.current()).revision,command:{type:'cancel',workId:'fresh'}});return value;};
 const result=await f.product.run('mission','fresh','before-call',(await f.current()).revision),w=result.snapshot.value.works.find(w=>w.id==='fresh')!;assert.equal(result.status,'cancelled');assert.equal(f.calls.length,0);assert.equal(w.effects[0]!.status,'failed');assert.equal(w.budget.measured,0);assert.equal(w.record,undefined);
});
for(const stage of ['activation','deadline','receipt'])test(`lost ${stage} acknowledgment retains exact original operation without provider replay`,async t=>{
 const f=await fixture(t,false,{hold:stage==='deadline'?'executor':undefined,runTimeoutMs:stage==='deadline'?100:undefined});let lost=false;const base=f.store,store=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);const type=stage==='activation'?'activate-runtime':stage==='deadline'?'expire-runtime':'receipt';if(!lost&&input.events.some((e:any)=>e.type===type)){lost=true;throw Error('Owned fixture lost committed acknowledgment');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),{ConfiguredTextRuntime}=await import('../src/configured-runtime.ts'),runtime=new ConfiguredTextRuntime(store,f.config),run=runtime.run('mission','fresh','lost-'+stage,(await f.current()).revision);
 if(stage==='deadline')assert.equal((await run).status,'blocked');else await assert.rejects(run);assert.equal(lost,true);
 const current=await f.current(),w=current.value.works.find(w=>w.id==='fresh')!,journal=await f.journal();assert.equal(w.runtimeRun!.id,'lost-'+stage);assert.equal(f.calls.length,stage==='activation'?0:1);if(stage==='receipt')assert.equal(w.effects[0]!.status,'succeeded');if(stage==='deadline'){assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.budget.reserved,4);assert.equal(w.budget.measured,null);}
 assert.equal((await new ConfiguredTextRuntime(base,f.config).run('mission','fresh','never-replay',current.revision)).status,'already-started');assert.deepEqual(await f.journal(),journal);assert.deepEqual(current.value.works[0],f.original.value.works[0]);
});
test('successful owned Record and exact read-only ownership query preserve legacy original Record and sealed checksum',async t=>{
 const f=await fixture(t),result=await f.product.run('mission','fresh','owned-success',(await f.current()).revision),w=result.snapshot.value.works.find(w=>w.id==='fresh')!;assert.equal(result.status,'settled');assert.deepEqual(w.record!.runtimeOwnership,w.runtimeRun!.ownership);assert.equal(w.record!.evidenceClass,'fixture');assert.deepEqual(result.snapshot.value.works[0],f.original.value.works[0]);
 const {hash}=await import('../src/domain.ts'),{checksum,...record}=w.record!;assert.equal(hash(record),checksum);const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');validateMissionJournalLineage(await f.journal());
 const before=await f.journal(),state=await f.store.readState('mission'),query=await f.product.readRunOwnership('mission','fresh',state.feedId);assert.equal(query!.localDispatchActive,false);assert.equal(query!.replayPermitted,false);assert.deepEqual(query!.ownership,w.runtimeRun!.ownership);assert.equal(await f.product.readRunOwnership('mission','absent',state.feedId),null);await assert.rejects(f.product.readRunOwnership('mission','fresh','other-feed'));assert.deepEqual(await f.journal(),before);
});
test('normal owner HTTP ownership read requires one exact Work and feed; never mutates or invokes',async t=>{
 const f=await fixture(t),{createWorkbench}=await import('../src/server.ts'),server=createWorkbench(f.store,f.root,{runtime:f.runtime,providers:f.product.providers});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}/missions/mission/run-ownership`,before=await f.journal();
 const good=await fetch(base+'?work=fresh');assert.equal(good.status,200);const body=await good.json();assert.equal(body.ownership,null);assert.equal(body.localDispatchActive,false);assert.equal(body.replayPermitted,false);
 for(const query of ['', '?work=fresh&work=fresh','?work=fresh&extra=x','?work='])assert.equal((await fetch(base+query)).status,400);assert.equal((await fetch(base+'?work=absent')).status,404);assert.equal((await fetch(base+'?work=fresh',{headers:{'x-massion-feed':'other-feed'}})).status,409);assert.equal(f.calls.length,0);assert.deepEqual(await f.journal(),before);
});
