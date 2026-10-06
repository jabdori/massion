import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {readWorkInterventionHistory} from '../src/work-budget-history.ts';
import type {InterventionHistoryPage} from '../src/work-budget-history.ts';
import type {Mission,Command} from '../src/domain.ts';
import {hash} from '../src/domain.ts';
import {Application} from '../src/application.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema,EventCursorError} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} exact Work intervention history scans sparse frozen pages without writes and survives fresh HTTP host`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 let transport;if(durable){await verifyDisposableDatabase();const database='intervention_history_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),root=await mkdtemp(join(tmpdir(),'massion-budget-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const journal=async()=>store instanceof SurrealStore?(await store.exportJournal()).operations:store.inspect();
 for(const id of ['mission:history','mission:other']){
  await product.create({id,purpose:'Inspect recorded budget changes',scope:'owned',constraints:[],criteria:{version:1,description:'No mutation on reads',oracle:'manual-review/v1'}},'create-'+id);
  for(const [i,workId] of ['a','b'].entries())await product.admit(id,{commandId:'admit-'+id+'-'+workId,expectedRevision:i+1,workId,title:workId,budget:1});
 }
 const id='mission:history';const change=async(missionId:string,workId:string,limit:number,reason:string,commandId:string)=>{const revision=(await store.load(missionId))!.revision;return product.intervene(missionId,{commandId,expectedRevision:revision,command:{type:'steer',workId,instruction:reason}});};
 await change(id,'a',20,'First owner reason <img src=x>','raise-a');await change('mission:other','a',80,'PRIVATE OTHER MISSION','other');await change(id,'b',70,'PRIVATE OTHER WORK','raise-b');await change(id,'a',10,'First owner reason <img src=x>','lower-a');
 let server=createWorkbench(store,root),base='';const start=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');base='http://127.0.0.1:'+a.port;};const stop=async()=>{if(!server.listening)return;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};await start();t.after(stop);
 const route='/missions/'+id+'/work-intervention-history?work=a';const get=async(query='',feedId?:string)=>{const response=await fetch(base+route+query,{headers:feedId?{'X-Massion-Feed':feedId}:{}});return {status:response.status,body:await response.json()};};
 const original=(await store.load(id))!,before=await journal(),first=await get('&limit=1');assert.equal(first.status,200);const initial=first.body as InterventionHistoryPage;assert.deepEqual(initial.changes,[]);assert.equal(initial.scannedBatches,1);assert.equal(initial.complete,false);assert.equal(initial.cursor,1);
 // New writes after the first read must not enlarge that reader's original boundary.
 await change(id,'a',25,'Later new boundary only','later-a');const all=await journal();
 let page=initial;const changes=[...page.changes];let pages=1;
 while(!page.complete){const next=await get('&limit=1&after='+page.cursor+'&through='+page.through,page.feedId);assert.equal(next.status,200);page=next.body;assert.equal(page.feedId,initial.feedId);assert.equal(page.through,initial.through);assert.ok(page.scannedBatches<=1);changes.push(...page.changes);assert.ok(++pages<30);}
 assert.deepEqual(changes.map(c=>({instruction:c.instruction,commandId:c.commandId,revision:c.revision,actor:c.actor})),[{instruction:'First owner reason <img src=x>',commandId:'raise-a',revision:4,actor:'local-owner'},{instruction:'First owner reason <img src=x>',commandId:'lower-a',revision:6,actor:'local-owner'}]);assert.ok(!JSON.stringify(changes).includes('PRIVATE'));assert.equal(page.cursor,initial.through);
 const snapshot=(await store.load(id))!,final=await get();assert.equal(final.body.changes.length,3);assert.equal(final.body.changes.at(-1).instruction,'Later new boundary only');assert.equal(final.body.complete,true);assert.deepEqual(await journal(),all);assert.deepEqual(await store.load(id),snapshot);assert.equal(snapshot.value.works[0]!.effects.length,0);assert.equal(snapshot.value.works[0]!.runtimeRun,undefined);
 const replay=await product.intervene(id,{commandId:'lower-a',expectedRevision:5,command:{type:'steer',workId:'a',instruction:'First owner reason <img src=x>'}});assert.equal(replay.status,'replayed');const rejected=await product.intervene(id,{commandId:'rejected',expectedRevision:3,command:{type:'steer',workId:'a',instruction:'Rejected reason'}});assert.equal(rejected.status,'conflict');assert.deepEqual(await journal(),all);assert.deepEqual((await get()).body,final.body);
 for(const query of ['&after=-1','&after=1.5','&after=','&limit=0','&limit=101','&limit=1&limit=2','&after=9007199254740992','&unexpected=1','&through=1','&after=1','&after=2&through=1'])assert.equal((await get(query)).status,400,query);
 assert.equal((await get('','wrong-feed')).status,409);assert.equal((await get('&after=0&through=999999',initial.feedId)).status,409);assert.equal((await get('&after=999999&through=999999',initial.feedId)).status,409);
 for(const path of ['/missions/'+id+'/work-intervention-history?work=missing','/missions/missing/work-intervention-history?work=a'])assert.equal((await fetch(base+path)).status,404);
 assert.deepEqual(await journal(),all);assert.deepEqual(await store.load(id),snapshot);assert.notDeepEqual(original,snapshot);assert.ok(before.length<all.length);
 await stop();const fresh=transport?new SurrealStore<Mission>(transport):store;server=createWorkbench(fresh,root);await start();assert.deepEqual((await get()).body,final.body);assert.deepEqual(await journal(),all);
});

test('history rejects a replacement between snapshot and catch-up, including final pages',async()=>{
 const store=new InMemoryStore<Mission>(),product=new ProductService(store);await product.create({id:'m',purpose:'Feed guard',scope:'s',constraints:[],criteria:{version:1,description:'Bound read',oracle:'manual-review/v1'}},'create');await product.admit('m',{commandId:'admit',expectedRevision:1,workId:'w',title:'w',budget:1});
 const state=await store.readState('m');const original=store.readCatchup.bind(store);store.readCatchup=async(after,feed,limit)=>({...await original(after,feed,limit),feedId:'replacement'});
 await assert.rejects(readWorkInterventionHistory(store,'m','w',{after:state.cursor,through:state.cursor,feedId:state.feedId,limit:1}),EventCursorError);
});

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} committed quarantine projects exact run and literal owner reason without inferring external receipts`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async()=>{
 let transport;if(durable){await verifyDisposableDatabase();const database='intervention_quarantine_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),fixture=new Application(store,[{id:'local-owner',roles:['owner']},{id:'fixture-executor',roles:['executor']}]);
 await product.create({id:'q',purpose:'Owned unresolved effect fixture, no provider calls',scope:'s',constraints:[],criteria:{version:1,description:'Truthful quarantine provenance',oracle:'manual-review/v1'}},'create');await product.admit('q',{commandId:'admit',expectedRevision:1,workId:'w',title:'w',budget:10});
 let n=0;const send=async(command:Command,actorId='local-owner')=>{const result=await fixture.dispatch({missionId:'q',commandId:'fixture-'+(++n),expectedRevision:(await store.load('q'))!.revision,actorId,command});assert.equal(result.status,'committed');};const w=(await store.load('q'))!.value.works[0]!;
 await send({type:'activate-runtime',workId:'w',run:{id:'exact-run',authorizationId:'fixture-only',mode:'mock-http',outputTokenCap:1,criteriaHash:hash(w.criteria),inputHash:hash({mission:w.missionSnapshot,title:w.title,instructions:[],memoryVersions:[]})}});
 await send({type:'assign',workId:'w',assignment:{id:'assignment',actorId:'fixture-executor',role:'executor',taskId:'w:root',model:{provider:'fixture',model:'none',configVersion:'fixture',reason:'Owned pending effect fixture only',evidenceClass:'fixture'},extensionVersion:'fixture'}});
 await send({type:'admit-effect',workId:'w',effect:{id:'effect',taskId:'w:root',status:'pending',target:'fixture-only',authority:'owned fixture'},reserve:1},'fixture-executor');
 const revision=(await store.load('q'))!.revision,reason='Owner <img src=x> inspected\nExternal outcome unknown';await product.intervene('q',{commandId:'owner-quarantine',expectedRevision:revision,command:{type:'quarantine-runtime',workId:'w',runId:'exact-run',reason,acknowledgeUncertainOutcome:true}});
 const snapshot=(await store.load('q'))!,before=await store.readState('q'),page=await readWorkInterventionHistory(store,'q','w',{after:0,limit:100});assert.deepEqual(page!.changes,[{cursor:before.cursor,revision:revision+1,commandId:'owner-quarantine',actor:'local-owner',action:'quarantine-runtime',runId:'exact-run',reason}]);assert.deepEqual(await store.readState('q'),before);assert.deepEqual(await store.load('q'),snapshot);assert.equal(snapshot.value.works[0]!.effects[0]!.receipt,undefined);
});
test('matching malformed intervention fails closed instead of inventing command provenance',async()=>{
 const store=new InMemoryStore<Mission>(),p=new ProductService(store);await p.create({id:'m',purpose:'Malformed projection fixture',scope:'s',constraints:[],criteria:{version:1,description:'Fail closed',oracle:'manual-review/v1'}},'create');await p.admit('m',{commandId:'admit',expectedRevision:1,workId:'w',title:'w',budget:1});await p.intervene('m',{commandId:'steer',expectedRevision:2,command:{type:'steer',workId:'w',instruction:'Exact instruction'}});
 const read=store.readCatchup.bind(store);for(const mutation of [{instruction:''},{type:'cancel'},{instruction:3}]){store.readCatchup=async(...args)=>{const page=await read(...args);for(const batch of page.events)for(const event of batch.events){const e=event as any;if(e.type==='steer')Object.assign(e.command,mutation);}return page;};await assert.rejects(readWorkInterventionHistory(store,'m','w',{after:0,limit:100}),/Invalid recorded/);}
});
