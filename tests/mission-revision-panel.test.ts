import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../src/server.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';
import {harness,reply} from './support/workbench-client.ts';

async function setup(t:TestContext,durable=false){
 let transport;if(durable){await verifyDisposableDatabase();const database='revision_panel_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:revision-panel',other='mission:other-revision';
 for(const missionId of [id,other])await product.create({id:missionId,purpose:'Original purpose '+missionId,scope:missionId===id?'project':'other-project',constraints:['Original constraint'],criteria:{version:1,description:'Original acceptance',oracle:'manual-review/v1'}},'create-'+missionId);
 await product.admit(id,{commandId:'old',expectedRevision:1,workId:'old',title:'Old Work',budget:0});
 const root=await mkdtemp(join(tmpdir(),'massion-revision-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let lost=false,unknown=false,holdWrite=false,holdRead=false,releaseWrite:undefined|(()=>void),releaseRead:undefined|(()=>void),readReleased=false;
 const handler=async(path:string,options:any)=>{
  const revision=path.endsWith('/revision')&&options.method==='POST';
  if(revision&&unknown)return reply({error:'Controlled unresolved dispatch',outcome:'unknown'},503);
  const response=await fetch(base+path,options),body=await response.json();
  if(revision){if(holdWrite){holdWrite=false;await new Promise<void>(r=>releaseWrite=r);}if(lost){lost=false;throw new Error('Controlled acknowledgement loss');}}
  if(holdRead&&path.startsWith('/read-state?')){holdRead=false;await new Promise<void>(r=>releaseRead=r);readReleased=true;}
  return reply(body,response.status);
 };
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'revision panel HTTP deadline');await new Promise(r=>setTimeout(r,10));}}
 async function client(identity='revision-client'){
  const app=harness(handler,{},undefined,{network:true,fragment:'#mission='+encodeURIComponent(id),identity});await until(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes(id));
  const fields=app.node('revision-fields');app.node('revision-form').append(fields);for(const name of ['revision-purpose','revision-version','revision-criteria','revision-oracle','save-revision','rebase-revision','discard-revision']){const node=app.node(name);fields.append(node);node.onFocus=()=>{if(!fields.disabled)(app.context as any).document.activeElement=node;};}
  return app;
 }
 async function draft(app:Awaited<ReturnType<typeof client>>,purpose='New purpose <img src=x>',version='2',description='New exact acceptance',oracle='bounded-text-review/v1'){
  for(const [name,value] of [['revision-purpose',purpose],['revision-version',version],['revision-criteria',description],['revision-oracle',oracle]]){app.node(name!).value=value!;await app.node(name!).fire('input');}
 }
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());
 return {store,product,id,other,client,draft,until,journal,lose(){lost=true;},unknown(){unknown=true;},holdWrite(){holdWrite=true;releaseWrite=undefined;},holdRead(){holdRead=true;releaseRead=undefined;readReleased=false;},writeHeld(){return !!releaseWrite;},readHeld(){return !!releaseRead;},releaseWrite(){releaseWrite!();},releaseRead(){releaseRead!();},readReleased(){return readReleased;}};
}
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} revision UI/HTTP separates original Work purpose/criteria from revised future Work without model execution`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 const f=await setup(t,durable),app=await f.client(),original=(await f.store.load(f.id))!.value.works[0]!,other=await f.store.load(f.other);await f.draft(app);app.node('save-revision').focus();await app.submit('revision-form');
 assert.match(app.node('revision-status').textContent,/confirmed/);assert.equal((app.context as any).document.activeElement.id,'save-revision');assert.equal(app.node('revision-version').value,'3');assert.match(app.node('revision-current').textContent,/New purpose <img src=x>.*New exact acceptance/);assert.equal(app.all().some(n=>n.tagName==='IMG'),false);
 app.node('work-title').value='Future Work';await app.submit('work-form');const snapshot=(await f.store.load(f.id))!;assert.deepEqual(snapshot.value.works[0],original);assert.equal(snapshot.value.works[1]?.missionSnapshot?.purpose,'New purpose <img src=x>');assert.equal(snapshot.value.works[1]?.criteria.version,2);assert.match(app.node('work-list').textContent,/Original Mission input/);assert.match(app.node('work-list').textContent,/Original purpose.*v1 · Original acceptance/s);assert.match(app.node('work-list').textContent,/New purpose <img src=x>.*v2 · New exact acceptance/s);assert.deepEqual(await f.store.load(f.other),other);assert.ok(snapshot.value.works.every(w=>!w.effects.length&&!w.runtimeRun&&!w.record));
 const journal=await f.journal(),fresh=await f.client('fresh-revision');assert.equal(fresh.node('work-list').textContent,app.node('work-list').textContent);assert.deepEqual(await f.journal(),journal);
});
test('stale Mission revision draft survives refresh/conflict and needs deliberate rebase before saving',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app,'My retained draft','3');await f.product.reviseMission(f.id,{commandId:'other-owner',expectedRevision:2,purpose:'Other owner truth',criteria:{version:2,description:'Other current criteria',oracle:'manual-review/v1'}});
 await app.submit('load-form');await f.until(()=>app.node('revision-current').textContent.includes('Other owner truth'));assert.equal(app.node('revision-purpose').value,'My retained draft');assert.match(app.node('revision-base').textContent,/based on revision 2.*State changed/);
 const count=app.calls.filter(c=>c.path.endsWith('/revision')).length;await app.submit('revision-form');assert.match(app.node('status').textContent,/Revision conflict/);assert.equal(app.node('revision-purpose').value,'My retained draft');assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,count+1);assert.equal((await f.store.load(f.id))?.value.purpose,'Other owner truth');
 await app.node('rebase-revision').fire('click');assert.match(app.node('revision-base').textContent,/based on revision 3/);await app.submit('revision-form');assert.equal((await f.store.load(f.id))?.value.purpose,'My retained draft');
});
test('Mission-scoped drafts and held old read cannot replace selected Mission or its criteria',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app,'Main private draft','2');const before=await f.journal();f.holdRead();await app.submit('load-form');await f.until(f.readHeld);await app.navigateFragment('#mission='+encodeURIComponent(f.other));await f.until(()=>app.node('loaded-id').textContent===f.other&&!app.node('revision-fields').disabled);assert.equal(app.node('revision-purpose').value,'Original purpose '+f.other);await f.draft(app,'Other private draft','2');f.releaseRead();await f.until(f.readReleased);assert.equal(app.node('loaded-id').textContent,f.other);assert.equal(app.node('revision-purpose').value,'Other private draft');
 await app.navigateFragment('#mission='+encodeURIComponent(f.id));await f.until(()=>app.node('loaded-id').textContent===f.id&&!app.node('revision-fields').disabled);assert.equal(app.node('revision-purpose').value,'Main private draft');assert.match(app.node('revision-base').textContent,/based on revision 2/);assert.deepEqual(await f.journal(),before);
});
test('invalid revision fields and discarding edits send no command, preserving other drafts and Work',async t=>{
 const f=await setup(t),app=await f.client(),before=await f.journal();app.node('work-title').value='Private Work draft';
 for(const values of [['','2','Criteria','manual-review/v1'],['Purpose','1','Criteria','manual-review/v1'],['Purpose','2','','manual-review/v1'],['Purpose','2','Criteria','forged-oracle']]){await f.draft(app,...values as [string,string,string,string]);await app.submit('revision-form');assert.match(app.node('revision-status').textContent,/No command was sent/);}
 await app.node('discard-revision').fire('click');assert.equal(app.node('revision-purpose').value,'Original purpose '+f.id);assert.equal(app.node('revision-version').value,'2');assert.equal(app.node('work-title').value,'Private Work draft');assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,0);assert.deepEqual(await f.journal(),before);
});
test('pending revision permits no repeat submission, discard/rebase or Mission switch and preserves moved focus',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);app.node('save-revision').focus();f.holdWrite();const pending=app.submit('revision-form');await f.until(f.writeHeld);assert.equal(app.node('revision-fields').disabled,true);await app.submit('revision-form');await app.node('discard-revision').fire('click');await app.node('rebase-revision').fire('click');await app.navigateFragment('#mission='+encodeURIComponent(f.other));assert.equal(app.node('loaded-id').textContent,f.id);assert.equal(app.node('revision-purpose').value,'New purpose <img src=x>');app.node('revision-comparison').focus();f.releaseWrite();await pending;assert.equal((app.context as any).document.activeElement.id,'revision-comparison');assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,1);
});
test('lost acknowledged revision is confirmed by durable readback without replay',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);f.lose();await app.submit('revision-form');assert.equal(app.storage.has('massion.workbench.pending'),false);assert.match(app.node('revision-status').textContent,/confirmed/);assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,1);assert.equal((await f.store.load(f.id))?.value.version,2);
});
test('unresolved revision retains original draft and independent write barrier without replay',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);f.unknown();await app.submit('revision-form');await app.tick();assert.ok(app.storage.has('massion.workbench.pending'));assert.equal(app.node('revision-fields').disabled,true);assert.equal(app.node('revision-purpose').value,'New purpose <img src=x>');assert.match(app.node('revision-status').textContent,/not confirmed/);assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,1);assert.equal((await f.store.load(f.id))?.value.version,1);
});

test('same-Mission read restores enabled revision input focus and preserves a deliberate move',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app,'Focused private draft');const journal=await f.journal();
 for(const moved of [false,true]){
  app.node('revision-purpose').focus();f.holdRead();await app.submit('load-form');await f.until(f.readHeld);assert.equal(app.node('revision-fields').disabled,true);
  if(moved)app.node('mission-id').focus();else (app.context as any).document.createElement('body').focus();
  f.releaseRead();await f.until(()=>f.readReleased()&&!app.node('revision-fields').disabled);assert.equal((app.context as any).document.activeElement.id,moved?'mission-id':'revision-purpose');assert.equal(app.node('revision-purpose').value,'Focused private draft');
 }
 assert.deepEqual(await f.journal(),journal);
});
test('Work cancellation preserves original criteria while a future-only Mission draft is discarded',async t=>{
 const f=await setup(t),app=await f.client(),original=(await f.store.load(f.id))!.value.works[0]!;await f.draft(app,'Cancelled edit');await app.node('discard-revision').fire('click');const cancel=app.all().find(n=>n.id==='work-cancel-old')!;assert.ok(cancel);await cancel.fire('click');await f.until(()=>app.node('work-list').textContent.includes('Execution: cancelled'));
 const snapshot=(await f.store.load(f.id))!;assert.equal(snapshot.value.purpose,'Original purpose '+f.id);assert.deepEqual(snapshot.value.works[0]?.criteria,original.criteria);assert.deepEqual(snapshot.value.works[0]?.missionSnapshot,original.missionSnapshot);assert.equal(app.calls.filter(c=>c.path.endsWith('/revision')).length,0);
});
