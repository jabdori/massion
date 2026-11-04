import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../src/server.ts';
import {apply} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {workAdmissionPreflight} from '../src/configured-runtime.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} owner fresh Work budget preserves inputs and execution gates across HTTP/restart`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 let transport;if(durable){await verifyDisposableDatabase();const database='work_budget_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),root=await mkdtemp(join(tmpdir(),'massion-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));let server=createWorkbench(store,root),base='';
 async function start(){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;}
 async function stop(){if(!server.listening)return;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await start();t.after(stop);
 const feed=(await store.readState()).feedId,id='mission:budget';async function post(path:string,body:unknown,identity=feed){const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','X-Massion-Feed':identity},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
 await post('/missions',{id,commandId:'create',purpose:'Control fresh Work budget',scope:'owned',constraints:[],criteria:{version:1,description:'Bound output',oracle:'bounded-text-review/v1'}});
 for(const [i,workId] of ['a','b'].entries())assert.equal((await post('/missions/'+id+'/work',{commandId:'admit-'+workId,expectedRevision:i+1,workId,title:workId,budget:1})).status,201);
 const before=(await store.load(id))!,route='/missions/'+id+'/work-budget',request={commandId:'raise-a',expectedRevision:3,workId:'a',limit:20,reason:'Reserve both bounded role outputs'};
 const journal=async()=>store instanceof SurrealStore?(await store.exportJournal()).operations:store.inspect();const oldJournal=await journal();
 assert.ok(workAdmissionPreflight(before,'a',3,10).diagnostics.some(d=>d.code==='budget_exceeded'));
 for(const forged of [{...request,limit:-1},{...request,limit:1},{...request,limit:'20'},{...request,reason:''},{...request,actorId:'owner'},{...request,unit:'dollars'},{...request,reserved:0},{...request,measured:0},{...request,workId:'missing'}])assert.equal((await post(route,forged)).status,400);
 assert.equal((await post(route,request,'wrong-feed')).status,409);assert.deepEqual(await journal(),oldJournal);
 const changed=await post(route,request);assert.equal(changed.status,200);const current=(await store.load(id))!;assert.equal(current.revision,4);assert.deepEqual(current.value.works[0],{...before.value.works[0],budget:{...before.value.works[0]!.budget,limit:20}});assert.deepEqual(current.value.works[1],before.value.works[1]);assert.ok(!workAdmissionPreflight(current,'a',4,10).diagnostics.some(d=>d.code==='budget_exceeded'));
 assert.ok(!current.value.works[0]!.runtimeRun&&!current.value.works[0]!.effects.length);assert.equal(current.value.works[0]!.blocker?.code,'provider_unavailable');
 const operations=await journal();assert.ok(JSON.stringify(operations.at(-1)!.events).includes(request.reason));validateMissionJournalLineage(operations);
 assert.equal((await post(route,request)).body.status,'replayed');assert.equal((await post(route,{...request,limit:30})).status,409);assert.equal((await post(route,{...request,commandId:'stale'})).status,409);assert.deepEqual(await journal(),operations);
 const lowered=await post(route,{...request,commandId:'lower-a',expectedRevision:4,limit:0,reason:'Do not authorize output reservation'});assert.equal(lowered.status,200);let final=(await store.load(id))!;assert.ok(workAdmissionPreflight(final,'a',5,10).diagnostics.some(d=>d.code==='budget_exceeded'));const concurrent=await Promise.all([post(route,{...request,commandId:'concurrent-20',expectedRevision:5,limit:20}),post(route,{...request,commandId:'concurrent-30',expectedRevision:5,limit:30})]);
 assert.equal(concurrent.filter(r=>r.body.status==='committed').length,1);for(const r of concurrent.filter(r=>r.body.status!=='committed'))assert.ok(r.status===409||r.status===503&&r.body.outcome==='rejected');
 final=(await store.load(id))!;assert.equal(final.revision,6);assert.ok([20,30].includes(final.value.works[0]!.budget.limit));assert.deepEqual(final.value.works[1],before.value.works[1]);const finalJournal=await journal();validateMissionJournalLineage(finalJournal);
 await stop();server=createWorkbench(store,root);await start();assert.deepEqual(await (await fetch(base+'/missions/'+id)).json(),final);assert.deepEqual(await journal(),finalJournal);
 const command={type:'revise-budget' as const,workId:'a',limit:50,reason:'Owner reason'};assert.throws(()=>apply(final.value,command,{id:'rep',roles:['representative']}),/role/);
 for(const patch of [{execution:'cancelled'},{acceptance:'accepted'},{effects:[{id:'unknown',status:'unknown'}]},{assignments:[{}]},{runtimeRun:{}},{artifact:{}},{runtimeRecovery:{}},{attempts:[{},{}]},{tasks:[{status:'settled'}]}]){const state=structuredClone(final.value);Object.assign(state.works[0]!,patch);assert.throws(()=>apply(state,command,{id:'owner',roles:['owner']}));}
 const reserved=structuredClone(final.value);reserved.works[0]!.budget.reserved=10;reserved.works[0]!.budget.measured=null;assert.throws(()=>apply(reserved,{...command,limit:9},{id:'owner',roles:['owner']}),/Invalid budget/);const retained=apply(reserved,command,{id:'owner',roles:['owner']}).value.works[0]!.budget;assert.equal(retained.reserved,10);assert.equal(retained.measured,null);
});
