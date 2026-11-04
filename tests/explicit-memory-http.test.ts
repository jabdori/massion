import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} owner memory HTTP keeps authority/scope bound and old/future Work pins across a fresh host`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 let transport;
 if(durable){await verifyDisposableDatabase();const database='explicit_memory_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),root=await mkdtemp(join(tmpdir(),'massion-memory-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let server=createWorkbench(store,root),base='';async function start(){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;}
 async function stop(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await start();t.after(stop);
 const feedId=(await (await fetch(base+'/read-state')).json()).feedId;
 async function post(path:string,body:unknown,feed=feedId){const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':feed},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
 const id='mission:http-memory';assert.equal((await post('/missions',{id,commandId:'create',purpose:'Retain owner instructions',scope:'owned-project',constraints:[],criteria:{version:1,description:'Preserve historical input',oracle:'manual-review/v1'}})).status,201);
 const route='/missions/'+id+'/memory',memory={id:'instruction',version:1,content:'Owner data <img src=x> stays text',source:'Owner supplied source'};
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());const before=await journal();
 for(const forged of [{...memory,authority:'learned'},{...memory,effective:false},{...memory,scope:'another-project'},{...memory,content:''},{...memory,version:0}])assert.equal((await post(route,{commandId:'forge-'+Object.keys(forged).join('-')+String(forged.version),expectedRevision:1,memory:forged})).status,400);
 assert.deepEqual(await journal(),before);
 const first=await post(route,{commandId:'v1',expectedRevision:1,memory});assert.equal(first.status,201);assert.equal(first.body.value.memories[0].scope,'owned-project');assert.equal(first.body.value.memories[0].authority,'explicit');assert.equal(first.body.value.memories[0].effective,true);
 assert.equal((await post('/missions/'+id+'/work',{commandId:'old-work',expectedRevision:2,workId:'old',title:'Original Work',budget:0})).status,201);
 assert.equal((await post(route,{commandId:'v2',expectedRevision:3,memory:{...memory,version:2,content:'Owner revised data'}})).status,201);
 assert.equal((await post('/missions/'+id+'/work',{commandId:'new-work',expectedRevision:4,workId:'new',title:'Future Work',budget:0})).status,201);
 const current=await (await fetch(base+'/missions/'+id)).json();const operations=await journal();
 assert.deepEqual(current.value.works.map((w:any)=>w.appliedMemoryVersions),[['instruction@1'],['instruction@2']]);assert.deepEqual(current.value.memories.map((m:any)=>m.effective),[false,true]);assert.ok(current.value.works.every((w:any)=>!w.effects.length&&!w.runtimeRun));
 assert.equal((await post(route,{commandId:'stale',expectedRevision:2,memory:{...memory,version:3}})).status,409);
 assert.equal((await post(route,{commandId:'v2',expectedRevision:3,memory:{...memory,version:2,content:'Owner revised data'}})).body.status,'replayed');assert.deepEqual(await journal(),operations);
 await stop();server=createWorkbench(store,root);await start();assert.deepEqual(await (await fetch(base+'/missions/'+id)).json(),current);assert.deepEqual(await journal(),operations);
 t.diagnostic(JSON.stringify({store:durable?'actual SurrealDB 3.3.0':'in-memory fixture',immutableMemoryVersions:2,pinnedOldAndFutureWork:true,forgedAuthorityAndScopeRejected:true,freshHostSameSnapshot:true,providerCalls:0}));
});
