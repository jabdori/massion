import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import type {Mission} from '../src/domain.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} owner Mission revision preserves old Work and admits future Work against new purpose/criteria`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 let transport;
 if(durable){await verifyDisposableDatabase();const database='mission_revision_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),root=await mkdtemp(join(tmpdir(),'massion-mission-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let server=createWorkbench(store,root),base='';async function start(){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;}
 async function stop(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await start();t.after(stop);
 const feedId=(await (await fetch(base+'/read-state')).json()).feedId;
 async function post(path:string,body:unknown,feed=feedId){const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':feed},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
 const id='mission:revision',criteria={version:1,description:'Original acceptance',oracle:'manual-review/v1'};
 assert.equal((await post('/missions',{id,commandId:'create',purpose:'Original purpose',scope:'owned-project',constraints:['Retain original inputs'],criteria})).status,201);
 assert.equal((await post('/missions/'+id+'/work',{commandId:'old-work',expectedRevision:1,workId:'old',title:'Old responsibility',budget:0})).status,201);
 const original=(await store.load(id))!.value.works[0]!;
 const route='/missions/'+id+'/revision',revision={commandId:'revise-v2',expectedRevision:2,purpose:'Revised purpose',criteria:{version:2,description:'Revised acceptance',oracle:'bounded-text-review/v1'}};
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());const before=await journal();
 for(const forged of [{...revision,actorId:'executor'},{...revision,scope:'other'},{...revision,constraints:[]},{...revision,criteria:{...revision.criteria,authority:'owner'}},{...revision,criteria:null},{...revision,purpose:''},{...revision,criteria:{...criteria}}])assert.equal((await post(route,forged)).status,400);
 assert.deepEqual(await journal(),before);
 assert.equal((await post(route,revision,'wrong-feed')).status,409);assert.deepEqual(await journal(),before);
 const changed=await post(route,revision);assert.equal(changed.status,200);assert.equal(changed.body.value.version,2);assert.equal(changed.body.value.purpose,'Revised purpose');assert.deepEqual(changed.body.value.works[0],original);assert.equal(changed.body.value.scope,'owned-project');assert.deepEqual(changed.body.value.constraints,['Retain original inputs']);
 assert.equal((await post('/missions/'+id+'/work',{commandId:'new-work',expectedRevision:3,workId:'new',title:'Future responsibility',budget:0})).status,201);
 const current=(await store.load(id))!;assert.deepEqual(current.value.works[0],original);const future=current.value.works[1]!;assert.equal(future.missionVersion,2);assert.equal(future.missionSnapshot?.purpose,'Revised purpose');assert.deepEqual(future.criteria,revision.criteria);assert.deepEqual(future.attempts[0]?.criteria,revision.criteria);assert.ok(current.value.works.every(w=>!w.effects.length&&!w.runtimeRun&&!w.record));
 const committed=await journal();assert.equal((await post(route,{...revision,commandId:'stale',expectedRevision:2,criteria:{...revision.criteria,version:3}})).status,409);const replay=await post(route,revision);assert.equal(replay.body.status,'replayed');assert.deepEqual(replay.body.value,changed.body.value);assert.deepEqual(await journal(),committed);
 await stop();server=createWorkbench(store,root);await start();assert.deepEqual(await (await fetch(base+'/missions/'+id)).json(),current);assert.deepEqual(await journal(),committed);
 t.diagnostic(JSON.stringify({store:durable?'actual SurrealDB 3.3.0':'in-memory fixture',missionVersion:2,oldWorkUnchanged:true,futureWorkRevised:true,feedCasAndReplay:true,freshHostSameState:true,providerCalls:0}));
});

test('revision command captures caller criteria before asynchronous dispatch and preserves exact replay',async()=>{
 const store=new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:criteria-binding';
 await product.create({id,purpose:'Original',scope:'project',constraints:[],criteria:{version:1,description:'Original criteria',oracle:'manual-review/v1'}},'create-binding');
 const original={version:2,description:'Submitted criteria',oracle:'manual-review/v1'},criteria={...original},input={commandId:'revise-binding',expectedRevision:1,purpose:'Submitted purpose',criteria};
 const pending=product.reviseMission(id,input);criteria.version=42;criteria.description='Caller changed criteria';criteria.oracle='bounded-text-review/v1';await pending;
 assert.deepEqual((await store.load(id))?.value.criteria,original);const journal=store.inspect();
 const replay=await product.reviseMission(id,{...input,criteria:{...original}});assert.equal(replay.status,'replayed');assert.deepEqual((await store.load(id))?.value.criteria,original);assert.deepEqual(store.inspect(),journal);
});
