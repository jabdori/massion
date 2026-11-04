import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
test('server tags command acknowledgements and rejects old feed admission before command or fixture effects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-feed-http-')),store=new InMemoryStore<Mission>(),server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 try{
  const boundary=await store.readState();const body={id:'mission:feed',commandId:'create:feed',purpose:'Feed-bound command',scope:'feed',constraints:[],criteria:{version:1,description:'No stale admission',oracle:'manual-review/v1'}};
  const post=(path:string,feed:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':feed},body:JSON.stringify(path==='/fixture-run'?{}:body)});
  for(const path of ['/missions','/fixture-run']){const response=await post(path,'old:feed');assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'Database changed before admission',reason:'feed',outcome:'rejected',feedId:boundary.feedId});}
  assert.equal((await store.readEvents(0)).events.length,0);
  const response=await post('/missions',boundary.feedId);assert.equal(response.status,201);assert.equal((await response.json() as {feedId:string}).feedId,boundary.feedId);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
test('headless clients share authoritative fixture results; web commands cannot forge pass',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-http-'));const server=createWorkbench(new InMemoryStore<Mission>(),root);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 try{
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/controlled local fixture/);
  const blocked=await fetch(base+'/fixture-run',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  const forged=await fetch(base+'/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"passed":true}'});assert.equal(forged.status,400);
  const result=await fetch(base+'/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(result.status,201);const {missionId}=await result.json() as {missionId:string};
  const first=await (await fetch(base+'/missions/'+missionId)).json();const second=await (await fetch(base+'/missions/'+missionId)).json();assert.deepEqual(first,second);
 }finally{server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
test('user Mission API admits blocked Work, persists steering, conflicts and replays events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-product-http-'));const store=new InMemoryStore<Mission>();const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const providerResponse=await fetch(base+'/providers');const providers=await providerResponse.json() as {providers:unknown[];selection:{status:string}};assert.deepEqual(providers.providers,[]);assert.equal(providers.selection.status,'unavailable');
  const create={id:'user-mission',commandId:'create-mission',purpose:'Prepare readiness summary',scope:'delivery',constraints:['No sharing'],criteria:{version:1,description:'Identify source-backed open issues',oracle:'manual-review/v1'}};
  assert.equal((await post('/missions',create)).status,201);
  const replay=await post('/missions',create);assert.equal(replay.status,200);assert.equal((await replay.json() as {status:string}).status,'replayed');
  const work={commandId:'work-a',expectedRevision:1,workId:'work-a',title:'Review readiness',budget:0};
  const results=await Promise.all([post('/missions/user-mission/work',work),post('/missions/user-mission/work',{...work,commandId:'work-b',workId:'work-b'})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const stored=(await store.load('user-mission'))!;const workId=stored.value.works[0]!.id;assert.equal(stored.value.works[0]!.blocker?.code,'provider_unavailable');assert.equal(stored.value.works[0]!.effects.length,0);
  assert.equal((await post('/missions/user-mission/commands',{commandId:'steer',expectedRevision:2,command:{type:'steer',workId,instruction:'Focus on critical issues'}})).status,200);
  const events=await (await fetch(base+'/events?after=0')).json() as {cursor:number;events:{commandId:string}[]};assert.equal(events.events.length,3);assert.equal(events.events.at(-1)?.commandId,'steer');
  const catchup=await (await fetch(base+'/events?after='+events.cursor)).json() as {events:unknown[]};assert.equal(catchup.events.length,0);
  assert.equal((await post('/missions/user-mission/commands',{commandId:'forge',expectedRevision:3,command:{type:'verify',workId,verdict:{status:'passed'}}})).status,400);
  assert.equal((await post('/missions/user-mission/commands',{commandId:'cancel',expectedRevision:3,command:{type:'cancel',workId}})).status,200);
  assert.equal((await store.load('user-mission'))?.value.works[0]?.execution,'cancelled');
  assert.equal((await fetch(base+'/events?after=-1')).status,400);assert.equal((await fetch(base+'/events?after=999')).status,409);
 }finally{server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
test('actual SurrealDB HTTP restart preserves user Work and durable event cursor', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async()=>{
 const {randomUUID}=await import('node:crypto');const {SurrealStore,createHttpRpcTransport,initializeSurrealSchema}=await import('../src/storage.ts');
 const options={endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:'massion_storage_tests',database:'massion_storage_tests'};const transport=createHttpRpcTransport(options);await initializeSurrealSchema(transport);
 const root=await mkdtemp(join(tmpdir(),'massion-durable-http-'));let server=createWorkbench(new SurrealStore<Mission>(transport),root);
 const listen=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');return `http://127.0.0.1:${address.port}`;};
 let base=await listen();const id=`user-${randomUUID()}`;const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const before=(await new SurrealStore<Mission>(transport).readEvents(0,1000)).cursor;
  assert.equal((await post('/missions',{id,commandId:`${id}:create`,purpose:'Readiness review',scope:'delivery',constraints:['No sharing'],criteria:{version:1,description:'List source-backed blockers',oracle:'manual-review/v1'}})).status,201);
  assert.equal((await post(`/missions/${id}/work`,{commandId:`id:admit:${id}`,expectedRevision:1,workId:'readiness',title:'Review readiness',budget:0})).status,201);
  const prior=await (await fetch(base+'/missions/'+id)).json();const observed=await (await fetch(base+'/events?after='+before)).json() as {cursor:number;events:{aggregateId:string}[]};assert.equal(observed.events.length,2);
  server.close();await once(server,'close');server=createWorkbench(new SurrealStore<Mission>(createHttpRpcTransport(options)),root);base=await listen();
  assert.deepEqual(await (await fetch(base+'/missions/'+id)).json(),prior);
  assert.deepEqual((await (await fetch(base+'/events?after='+observed.cursor)).json() as {events:unknown[]}).events,[]);
  assert.equal((await post(`/missions/${id}/commands`,{commandId:`${id}:cancel`,expectedRevision:2,command:{type:'cancel',workId:'readiness'}})).status,200);
  const next=await (await fetch(base+'/events?after='+observed.cursor)).json() as {events:{commandId:string;cursor:number}[]};assert.equal(next.events.length,1);assert.equal(next.events[0]?.commandId,`${id}:cancel`);assert.equal(next.events[0]?.cursor,observed.cursor+1);
 }finally{server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
