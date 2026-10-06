import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {readWorkBudgetHistory} from '../src/work-budget-history.ts';
import type {BudgetHistoryPage} from '../src/work-budget-history.ts';
import type {Mission} from '../src/domain.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema,EventCursorError} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} exact Work budget history scans sparse frozen pages without writes and survives fresh HTTP host`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 let transport;if(durable){await verifyDisposableDatabase();const database='budget_history_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),root=await mkdtemp(join(tmpdir(),'massion-budget-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const journal=async()=>store instanceof SurrealStore?(await store.exportJournal()).operations:store.inspect();
 for(const id of ['mission:history','mission:other']){
  await product.create({id,purpose:'Inspect recorded budget changes',scope:'owned',constraints:[],criteria:{version:1,description:'No mutation on reads',oracle:'manual-review/v1'}},'create-'+id);
  for(const [i,workId] of ['a','b'].entries())await product.admit(id,{commandId:'admit-'+id+'-'+workId,expectedRevision:i+1,workId,title:workId,budget:1});
 }
 const id='mission:history';const change=async(missionId:string,workId:string,limit:number,reason:string,commandId:string)=>{const revision=(await store.load(missionId))!.revision;return product.reviseBudget(missionId,{commandId,expectedRevision:revision,workId,limit,reason});};
 await change(id,'a',20,'First owner reason <img src=x>','raise-a');await change('mission:other','a',80,'PRIVATE OTHER MISSION','other');await change(id,'b',70,'PRIVATE OTHER WORK','raise-b');await change(id,'a',10,'Second owner reason','lower-a');
 let server=createWorkbench(store,root),base='';const start=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port;};const stop=async()=>{if(!server.listening)return;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};await start();t.after(stop);
 const route='/missions/'+id+'/work-budget-history?work=a';const get=async(query='',feedId?:string)=>{const response=await fetch(base+route+query,{headers:feedId?{'X-Massion-Feed':feedId}:{}});return {status:response.status,body:await response.json()};};
 const original=(await store.load(id))!,before=await journal(),first=await get('&limit=1');assert.equal(first.status,200);const initial=first.body as BudgetHistoryPage;assert.deepEqual(initial.changes,[]);assert.equal(initial.scannedBatches,1);assert.equal(initial.complete,false);assert.equal(initial.cursor,1);
 // New writes after the first read must not enlarge that reader's original boundary.
 await change(id,'a',25,'Later new boundary only','later-a');const all=await journal();
 let page=initial;const changes=[...page.changes];let pages=1;
 while(!page.complete){const next=await get('&limit=1&after='+page.cursor+'&through='+page.through,page.feedId);assert.equal(next.status,200);page=next.body;assert.equal(page.feedId,initial.feedId);assert.equal(page.through,initial.through);assert.ok(page.scannedBatches<=1);changes.push(...page.changes);assert.ok(++pages<30);}
 assert.deepEqual(changes.map(c=>({limit:c.limit,reason:c.reason,commandId:c.commandId,revision:c.revision,actor:c.actor})),[{limit:20,reason:'First owner reason <img src=x>',commandId:'raise-a',revision:4,actor:'local-owner'},{limit:10,reason:'Second owner reason',commandId:'lower-a',revision:6,actor:'local-owner'}]);assert.ok(!JSON.stringify(changes).includes('PRIVATE'));assert.equal(page.cursor,initial.through);
 const snapshot=(await store.load(id))!,final=await get();assert.equal(final.body.changes.length,3);assert.equal(final.body.changes.at(-1).limit,25);assert.equal(final.body.complete,true);assert.deepEqual(await journal(),all);assert.deepEqual(await store.load(id),snapshot);assert.equal(snapshot.value.works[0]!.effects.length,0);assert.equal(snapshot.value.works[0]!.runtimeRun,undefined);
 const replay=await product.reviseBudget(id,{commandId:'lower-a',expectedRevision:5,workId:'a',limit:10,reason:'Second owner reason'});assert.equal(replay.status,'replayed');const rejected=await product.reviseBudget(id,{commandId:'rejected',expectedRevision:3,workId:'a',limit:50,reason:'Rejected reason'});assert.equal(rejected.status,'conflict');assert.deepEqual(await journal(),all);assert.deepEqual((await get()).body,final.body);
 for(const query of ['&after=-1','&after=1.5','&after=','&limit=0','&limit=101','&limit=1&limit=2','&after=9007199254740992','&unexpected=1','&through=1','&after=1','&after=2&through=1'])assert.equal((await get(query)).status,400,query);
 assert.equal((await get('','wrong-feed')).status,409);assert.equal((await get('&after=0&through=999999',initial.feedId)).status,409);assert.equal((await get('&after=999999&through=999999',initial.feedId)).status,409);
 for(const path of ['/missions/'+id+'/work-budget-history?work=missing','/missions/missing/work-budget-history?work=a'])assert.equal((await fetch(base+path)).status,404);
 assert.deepEqual(await journal(),all);assert.deepEqual(await store.load(id),snapshot);assert.notDeepEqual(original,snapshot);assert.ok(before.length<all.length);
 await stop();const fresh=transport?new SurrealStore<Mission>(transport):store;server=createWorkbench(fresh,root);await start();assert.deepEqual((await get()).body,final.body);assert.deepEqual(await journal(),all);
});

test('history rejects a replacement between snapshot and catch-up, including final pages',async()=>{
 const store=new InMemoryStore<Mission>(),product=new ProductService(store);await product.create({id:'m',purpose:'Feed guard',scope:'s',constraints:[],criteria:{version:1,description:'Bound read',oracle:'manual-review/v1'}},'create');await product.admit('m',{commandId:'admit',expectedRevision:1,workId:'w',title:'w',budget:1});
 const state=await store.readState('m');const original=store.readCatchup.bind(store);store.readCatchup=async(after,feed,limit)=>({...await original(after,feed,limit),feedId:'replacement'});
 await assert.rejects(readWorkBudgetHistory(store,'m','w',{after:state.cursor,through:state.cursor,feedId:state.feedId,limit:1}),EventCursorError);
});
