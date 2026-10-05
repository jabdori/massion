import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Handler,Reply} from './support/workbench-client.ts';
import type {Mission,Relation} from '../src/domain.ts';
import type {RelationImpact} from '../src/relation-impact.ts';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Application} from '../src/application.ts';
import {createWorkbench} from '../src/server.ts';
import {SurrealRelationImpact} from '../src/relation-impact.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

const mission=(id='mission:panel'):Mission=>({id,version:1,purpose:'Read exact relation evidence',scope:'fixture-only',constraints:[],criteria:{version:1,description:'Keep exact versions and provenance',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]});
function result(id:string,entity:string,version:number,revision=1,feedId='feed:panel'):RelationImpact {
 const relations:Relation[]=[{from:'dependent:'+entity,to:entity,type:'evidenced-by',fromVersion:3,toVersion:version,provenance:'Recorded <img src=x> source, not a verdict',inferred:true}];
 return {missionId:id,revision,feedId,cursor:revision,changed:{id:entity,version},affected:relations.map(r=>r.from+'@'+r.fromVersion),relations};
}
async function fixture(onImpact:(id:string,entity:string,version:number)=>Reply|Promise<Reply>=(id,entity,version)=>reply(result(id,entity,version)),pending=false){
 const missions=new Map([['mission:panel',mission()],['mission:other',mission('mission:other')]]);let revision=1,feedId='feed:panel';
 const handler:Handler=(path,options)=>{
  assert.notEqual(options.method,'POST','Impact panel must never mutate');
  const url=new URL(path,'http://localhost');
  if(path==='/health')return reply({status:'ready'});
  if(path==='/providers')return reply({providers:[],selection:{status:'unavailable'}});
  if(path==='/connections')return reply({error:'No runtime configured'},503);
  if(url.pathname==='/events'){
   if(options.headers?.['X-Massion-Feed']&&options.headers['X-Massion-Feed']!==feedId)return reply({error:'Feed changed'},409);
   const after=Number(url.searchParams.get('after'));return reply({feedId,cursor:revision,events:revision>after&&revision>1?[{cursor:revision,aggregateId:'mission:panel',revision,commandId:'revision-'+revision,events:[]}]:[]});
  }
  if(url.pathname==='/read-state'){const selected=missions.get(url.searchParams.get('mission')!);return reply({feedId,cursor:revision,snapshot:selected?{revision,value:selected}:null});}
  const impact=/^\/missions\/([^/]+)\/impact$/.exec(url.pathname);if(impact)return onImpact(decodeURIComponent(impact[1]!),url.searchParams.get('entity')!,Number(url.searchParams.get('version')));
  if(url.pathname.startsWith('/missions/')){const selected=missions.get(decodeURIComponent(url.pathname.slice(10)));return selected?reply({revision,value:selected}):reply({error:'Missing Mission'},404);}
  throw new Error('Unexpected route '+path);
 };
 const marker=JSON.stringify({missionId:'mission:panel',commandId:'unresolved',reconcileCursor:0});
 const app=harness(handler,pending?{'massion.workbench.pending':marker}:{},undefined,{network:true,fragment:'#mission=mission%3Apanel'});await settle();assert.equal(app.node('sync-notice').hidden,true);
 const choose=async(entity:string,version:string)=>{app.node('impact-entity').value=entity;app.node('impact-version').value=version;await app.node('impact-entity').fire('input');await app.node('impact-version').fire('input');};
 return {app,choose,marker,bump(){revision++;},changeFeed(){feedId='feed:replacement';},missions};
}
test('impact panel displays exact Mission/version/provenance and distinguishes an empty read without writes',async()=>{
 let empty=false;const f=await fixture((id,entity,version)=>reply(empty?{...result(id,entity,version),affected:[],relations:[]}:result(id,entity,version)));
 const {app,choose}=f;app.node('work-title').value='Keep my private Work draft';app.node('purpose').value='Keep my private Mission draft';
 await choose('file:α/"quote"','2');app.node('impact-read').focus();await app.submit('impact-form');
 assert.match(app.node('impact-scope').textContent,/mission:panel.*fixture-only.*revision: 1/);
 assert.match(app.node('impact-results').textContent,/file:α\/"quote" · exact version 2/);assert.match(app.node('impact-results').textContent,/dependent:file:α\/"quote"@3/);assert.match(app.node('impact-results').textContent,/Provenance: Recorded <img src=x> source, not a verdict · Inferred: yes/);
 assert.equal(app.all().some(node=>node.tagName==='IMG'),false);assert.equal(app.node('impact-results').hidden,false);assert.equal((app.context as any).document.activeElement.id,'impact-read');
 assert.equal(app.node('work-title').value,'Keep my private Work draft');assert.equal(app.node('purpose').value,'Keep my private Mission draft');
 empty=true;await choose('unlinked','1');assert.equal(app.node('impact-results').hidden,true);await app.submit('impact-form');assert.match(app.node('impact-status').textContent,/does not establish that the target exists/);assert.match(app.node('impact-results').textContent,/No stored relation/);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
for(const field of ['entity','version'])for(const outcome of ['success','error'])test(`changed ${field} discards a late ${outcome} after a newer impact result`,async()=>{
 let calls=0,release!:(r:Reply)=>void;const f=await fixture((id,entity,version)=>++calls===1?new Promise<Reply>(resolve=>release=resolve):reply(result(id,entity,version)));
 const {app,choose}=f;await choose('first','1');const old=app.submit('impact-form');await settle();assert.equal(app.node('impact-read').disabled,true);
 await choose(field==='entity'?'second':'first',field==='version'?'2':'1');assert.equal(app.node('impact-results').hidden,true);assert.equal(app.node('impact-read').disabled,false);
 await app.submit('impact-form');const current=app.node('impact-results').textContent,status=app.node('impact-status').textContent;
 release(outcome==='success'?reply(result('mission:panel','first',1)):reply({error:'Old query failed'},503));await old;
 assert.equal(app.node('impact-results').textContent,current);assert.equal(app.node('impact-status').textContent,status);assert.equal(app.node('impact-results').hidden,false);assert.equal(calls,2);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
test('Mission navigation clears old impact and fences a held reply even at the same revision',async()=>{
 let hold=false,release!:(r:Reply)=>void;const {app,choose}=await fixture((id,entity,version)=>hold?new Promise<Reply>(r=>release=r):reply(result(id,entity,version)));
 await choose('target','1');await app.submit('impact-form');assert.equal(app.node('impact-results').hidden,false);
 hold=true;const old=app.submit('impact-form');await settle();await app.navigateFragment('#mission=mission%3Aother');assert.equal(app.node('impact-results').hidden,true);assert.match(app.node('impact-scope').textContent,/mission:other/);
 hold=false;await app.submit('impact-form');const current=app.node('impact-results').textContent;release(reply(result('mission:panel','target',1)));await old;assert.equal(app.node('impact-results').textContent,current);assert.match(current,/Mission: mission:other/);
});
for(const change of ['revision','feed','disconnect'])test(`${change} change clears impact and fences its pending read without automatic requery`,async()=>{
 let hold=false,release!:(r:Reply)=>void;const f=await fixture((id,entity,version)=>hold?new Promise<Reply>(r=>release=r):reply(result(id,entity,version)));const {app,choose}=f;
 await choose('target','1');await app.submit('impact-form');hold=true;const old=app.submit('impact-form');await settle();
 if(change==='revision'){f.bump();await app.tick();}else if(change==='feed'){f.changeFeed();await app.tick();}else await app.windowEvent('offline');
 assert.equal(app.node('impact-results').hidden,true);release(reply(result('mission:panel','target',1)));await old;assert.equal(app.node('impact-results').hidden,true);
 assert.equal(app.calls.filter(c=>c.path.includes('/impact?')).length,2);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
test('invalid selection and HTTP errors never leave an earlier result visible or send a mutation',async()=>{
 let failure=0;const {app,choose}=await fixture((id,entity,version)=>failure?reply({error:'Fixture error <img src=x>; no partial result'},failure):reply(result(id,entity,version)));
 for(const [entity,version] of [[' ','1'],['target','0'],['target','1.5'],['target','9007199254740992']]){await choose(entity!,version!);await app.submit('impact-form');assert.match(app.node('impact-status').textContent,/No query was sent/);}
 assert.equal(app.calls.filter(c=>c.path.includes('/impact?')).length,0);
 for(const status of [404,422,503,500]){failure=0;await choose('target','1');await app.submit('impact-form');assert.equal(app.node('impact-results').hidden,false);failure=status;await app.submit('impact-form');assert.equal(app.node('impact-results').hidden,true);assert.match(app.node('impact-status').textContent,/Impact unavailable: Fixture error <img/);assert.equal(app.all().some(n=>n.tagName==='IMG'),false);}
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
test('mismatched reply identity/version/revision or malformed relation evidence is not rendered',async()=>{
 let body:any;const {app,choose}=await fixture(()=>reply(body));await choose('target','1');const valid=result('mission:panel','target',1);
 for(const malformed of [{...valid,missionId:'mission:other'},{...valid,revision:2},{...valid,changed:{id:'other',version:1}},{...valid,changed:{id:'target',version:2}},{...valid,relations:[{...valid.relations[0],inferred:'true'}]},{...valid,affected:['wrong@1']}]){
  body=malformed;await app.submit('impact-form');assert.equal(app.node('impact-results').hidden,true);assert.match(app.node('impact-status').textContent,/reply does not match/);
 }
});
test('impact reads preserve an unresolved command marker and its independent write barrier',async()=>{
 const {app,choose,marker}=await fixture(undefined,true);assert.equal(app.node('work-fields').disabled,true);await choose('target','1');assert.equal(app.node('impact-read').disabled,false);await app.submit('impact-form');assert.equal(app.node('impact-results').hidden,false);assert.equal(app.storage.get('massion.workbench.pending'),marker);assert.equal(app.node('work-fields').disabled,true);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory'} inline impact panel reads HTTP evidence and discards held selections without journal or provider effects`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 let transport;
 if(durable){await verifyDisposableDatabase();const database='impact_ui_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),appService=new Application(store,[{id:'owner',roles:['owner']},{id:'rep',roles:['representative']}]);
 const id='mission:panel-http',entity='artifact:α/"source"';await appService.create({...mission(id)},'owner','create-panel');
 const relation:Relation={from:'record',to:entity,type:'evidenced-by',fromVersion:2,toVersion:1,provenance:'Fixture sealed artifact:α/"origin"',inferred:false};await appService.dispatch({missionId:id,commandId:'panel-relation',expectedRevision:1,actorId:'rep',command:{type:'relate',relation}});
 const readJournal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());
 const journal=await readJournal(),snapshot=(await store.load(id))!;
 // In-memory HTTP is a supporting fixture; only the durable row uses native SQL.
 const knowledge=transport?new SurrealRelationImpact(transport):{readImpact:async(missionId:string,entityId:string,version:number)=>{const state=await store.readState(missionId);return state.snapshot?{missionId,revision:state.snapshot.revision,feedId:state.feedId,cursor:state.cursor,changed:{id:entityId,version},relations:state.snapshot.value.relations.filter(r=>r.to===entityId&&r.toVersion===version),affected:state.snapshot.value.relations.filter(r=>r.to===entityId&&r.toVersion===version).map(r=>r.from+'@'+r.fromVersion)}:null;}};
 const root=await mkdtemp(join(tmpdir(),'massion-impact-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root,{knowledge});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let hold=false,release!:()=>void;
 const client=harness(async(path,init)=>{if(hold&&path.includes('/impact?')){hold=false;await new Promise<void>(r=>release=r);}const response=await fetch(base+path,init);return reply(await response.json(),response.status);},{},undefined,{network:true,fragment:'#mission='+encodeURIComponent(id)});
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'HTTP panel deadline');await new Promise(r=>setTimeout(r,10));}}
 await until(()=>client.node('sync-notice').hidden&&client.node('snapshot-json').textContent.includes('panel-http'));
 client.node('impact-entity').value=entity;client.node('impact-version').value='1';await client.node('impact-entity').fire('input');await client.submit('impact-form');assert.equal(client.node('impact-results').hidden,false);assert.match(client.node('impact-results').textContent,/record@2/);assert.match(client.node('impact-results').textContent,/Fixture sealed artifact:α\/"origin"/);
 hold=true;const old=client.submit('impact-form');await until(()=>typeof release==='function');client.node('impact-version').value='2';await client.node('impact-version').fire('input');await client.submit('impact-form');assert.match(client.node('impact-results').textContent,/No stored relation/);const current=client.node('impact-results').textContent;release();await old;assert.equal(client.node('impact-results').textContent,current);
 assert.deepEqual(await store.load(id),snapshot);assert.deepEqual(await readJournal(),journal);assert.equal(client.calls.filter(c=>c.options.method==='POST').length,0);assert.equal(client.storage.has('massion.workbench.pending'),false);
 t.diagnostic(JSON.stringify({store:durable?'actual SurrealDB 3.3.0':'in-memory fixture',impactGETs:client.calls.filter(c=>c.path.includes('/impact?')).length,posts:0,unchangedSnapshotAndJournal:true,staleVersionReplyDiscarded:true,providerCalls:0}));
});
