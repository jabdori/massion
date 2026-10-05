import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Application} from '../src/application.ts';
import {affectedBy} from '../src/domain.ts';
import type {Mission,Relation} from '../src/domain.ts';
import {createWorkbench} from '../src/server.ts';
import {createHttpRpcTransport,initializeSurrealSchema,InMemoryStore,SurrealStore,StorageProtocolError} from '../src/storage.ts';
import {SurrealRelationImpact,RELATION_IMPACT_QUERY,RelationImpactLimitError,IMPACT_RELATION_LIMIT} from '../src/relation-impact.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

test('impact input rejects invalid identities and versions before a query',async()=>{
 let calls=0;const reader=new SurrealRelationImpact({query:async()=>{calls++;return [];}});
 for(const [mission,entity,version] of [['','file',1],['mission',' ',1],['mission','file',0],['mission','file',1.5],['mission','file',Infinity],['mission','file',Number.MAX_SAFE_INTEGER+1]] as const){
  await assert.rejects(reader.readImpact(mission,entity,version),TypeError);
 }
 assert.equal(calls,0);
});
test('impact readback rejects malformed or unconfirmed database results',async()=>{
 const valid={missionId:'mission',revision:1,feedId:'feed',cursor:1,changed:{id:'file',version:1},affected:['record@1'],relations:[{from:'record',to:'file',type:'evidenced-by',fromVersion:1,toVersion:1,provenance:'fixture origin',inferred:false}]};
 for(const output of [[],[null,null,null],[valid,valid],[{...valid,missionId:'other'}],[{...valid,changed:{id:'file',version:2}}],[{...valid,affected:['wrong@1']}],[{...valid,relations:[{...valid.relations[0],provenance:''}]}],[{...valid,relations:[{...valid.relations[0],inferred:'false'}]}],[{missing:true,missionId:'mission'}]]){
  await assert.rejects(new SurrealRelationImpact({query:async()=>output}).readImpact('mission','file',1),StorageProtocolError);
 }
});
test('HTTP impact rejects invalid input and never substitutes an unconfigured reader',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-impact-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createWorkbench(new InMemoryStore<Mission>(),root);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');
 const base='http://127.0.0.1:'+address.port;
 for(const path of ['/missions/mission/impact','/missions/mission/impact?entity=file&version=0','/missions/mission/impact?entity=file&version=1.5'])assert.equal((await fetch(base+path)).status,400);
 assert.equal((await fetch(base+'/missions/mission/impact?entity=file&version=1')).status,503);
});
const skip=process.platform!=='linux'?'Linux disposable ownership verification required':!process.env.SURREAL_TEST_RUNTIME?'scripts/with-surreal.py disposable ownership proof required':false;
test('actual SurrealDB impact matches versioned multi-hop domain relations and preserves provenance through readback and restore',{skip},async t=>{
 await verifyDisposableDatabase();
 const endpoint=process.env.MASSION_TEST_SURREAL_RPC!,namespace=process.env.MASSION_TEST_SURREAL_NAMESPACE!;
 async function database(){const database='impact_'+crypto.randomUUID().replaceAll('-','');const transport=createHttpRpcTransport({endpoint,namespace,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);return transport;}
 const transport=await database(),store=new SurrealStore<Mission>(transport),app=new Application(store,[{id:'owner',roles:['owner']},{id:'rep',roles:['representative']}]);
 const id='mission:impact',rootEntity='function:α/"source"';
 await app.create({id,purpose:'Inspect exact relation evidence',scope:'fixture-only',constraints:[],criteria:{version:1,description:'Keep relation versions and source',oracle:'manual-review/v1'}},'owner','create-impact');
 const edge=(from:string,to:string,fromVersion=1,toVersion=1,type:Relation['type']='evidenced-by',provenance='oracle:α/"run"',inferred=false):Relation=>({from,to,fromVersion,toVersion,type,provenance,inferred});
 // Reverse insertion order defeats a single forward scan. Mixed types/inferred edges
 // remain traversable, exactly as affectedBy; neither is silently promoted to truth.
 const edges=[edge('record','verdict'),edge('verdict','file'),edge('file',rootEntity),edge('file',rootEntity,1,1,'depends-on','independent source',true),edge('container','file',3,1,'contains'),edge('wrong-file',rootEntity,2,2),edge('wrong-record','file',1,2),edge(rootEntity,'record'),edge('record','verdict')];
 for(const [i,relation] of edges.entries()){const snapshot=(await store.load(id))!;assert.equal((await app.dispatch({missionId:id,commandId:'relate-'+i,expectedRevision:snapshot.revision,actorId:'rep',command:{type:'relate',relation}})).status,'committed');}
 await app.create({id:'mission:other',purpose:'Isolated graph',scope:'fixture-only',constraints:[],criteria:{version:1,description:'Separate Mission',oracle:'manual-review/v1'}},'owner','create-other');
 await app.dispatch({missionId:'mission:other',commandId:'other-edge',expectedRevision:1,actorId:'rep',command:{type:'relate',relation:edge('other-only',rootEntity)}});
 const before=(await store.load(id))!,journal=await store.exportJournal(),boundary=await store.readState(id);let nativeCalls=0;
 const reader=new SurrealRelationImpact({query:async(query,variables)=>{assert.equal(query,RELATION_IMPACT_QUERY);nativeCalls++;return transport.query(query,variables);}});
 const impact=(await reader.readImpact(id,rootEntity,1))!;assert.equal(nativeCalls,1,'One native read transaction, no JS graph traversal');assert.deepEqual(impact.affected,affectedBy(before.value,rootEntity,1));assert.equal(impact.revision,before.revision);assert.equal(impact.feedId,boundary.feedId);assert.equal(impact.cursor,boundary.cursor);assert.deepEqual(impact.relations,edges.filter(r=>!r.from.startsWith('wrong-')));assert.equal(impact.relations.filter(r=>r.from==='record').length,2,'Original duplicate provenance entries are retained');assert.equal(impact.relations.some(r=>r.inferred&&r.provenance==='independent source'),true);assert.equal(impact.affected.includes('other-only@1'),false);
 const wrong=(await reader.readImpact(id,rootEntity,2))!;assert.deepEqual(wrong.affected,affectedBy(before.value,rootEntity,2));assert.deepEqual(wrong.relations,[edges[5]]);assert.deepEqual((await reader.readImpact(id,'absent',1))!.affected,[]);assert.equal(await reader.readImpact('mission:absent',rootEntity,1),null);
 assert.deepEqual(await new SurrealRelationImpact(transport).readImpact(id,rootEntity,1),impact);
 const root=await mkdtemp(join(tmpdir(),'massion-impact-http-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root,{knowledge:reader});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const response=await fetch('http://127.0.0.1:'+address.port+'/missions/'+id+'/impact?entity='+encodeURIComponent(rootEntity)+'&version=1');assert.equal(response.status,200);assert.deepEqual(await response.json(),impact);
 assert.deepEqual(await store.load(id),before);assert.deepEqual(await store.exportJournal(),journal,'Read-only impact route never creates operations/events/outbox');
 const missingResponse=await fetch('http://127.0.0.1:'+address.port+'/missions/mission:absent/impact?entity=file&version=1');assert.equal(missingResponse.status,404);
 const restoredTransport=await database(),restoredStore=new SurrealStore<Mission>(restoredTransport);await restoredStore.restoreJournal(journal);const restored=(await new SurrealRelationImpact(restoredTransport).readImpact(id,rootEntity,1))!;assert.deepEqual(restored.affected,impact.affected);assert.deepEqual(restored.relations,impact.relations);assert.equal(restored.revision,impact.revision);assert.notEqual(restored.feedId,impact.feedId);assert.deepEqual(await restoredStore.exportJournal(),journal);
 t.diagnostic(JSON.stringify({nativeQuery:1,affected:impact.affected,relations:impact.relations.length,revision:impact.revision,missionIsolation:true,exactVersions:true,provenancePreserved:true,readOnlyJournal:true,restoredReadback:true,providerCalls:0}));
 // The query work bound does not limit stored relations or truncate a larger graph.
 await store.commit({id,commandId:'oversized-fixture',expectedRevision:before.revision,fingerprint:'oversized-fixture',value:{...before.value,relations:Array.from({length:IMPACT_RELATION_LIMIT+1},()=>edges[0]!)},events:[],outbox:[]});
 const oversizedJournal=await store.exportJournal();await assert.rejects(reader.readImpact(id,rootEntity,1),RelationImpactLimitError);
 const tooLarge=await fetch('http://127.0.0.1:'+address.port+'/missions/'+id+'/impact?entity=file&version=1');assert.equal(tooLarge.status,422);assert.match((await tooLarge.json()).error,/no result was truncated/);assert.deepEqual(await store.exportJournal(),oversizedJournal);
});
