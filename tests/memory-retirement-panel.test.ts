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
import {pinnedMemoryInput} from '../src/memory-input.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';
import {harness,reply} from './support/workbench-client.ts';
async function setup(t:TestContext,durable=false){
 let transport;if(durable){await verifyDisposableDatabase();const database='retirement_panel_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:retirement-panel',other='mission:retirement-other';
 for(const missionId of [id,other])await product.create({id:missionId,purpose:'Retain original memory',scope:'owned',constraints:[],criteria:{version:1,description:'Stop only future application',oracle:'manual-review/v1'}},'create-'+missionId);
 for(const [index,memoryId] of ['instruction','keep'].entries())await product.saveMemory(id,{commandId:'memory-'+memoryId,expectedRevision:index+1,memory:{id:memoryId,version:1,content:'Original '+memoryId+' <img src=x>',source:'Owner source'}});
 await product.app.dispatch({missionId:id,commandId:'learned',expectedRevision:3,actorId:'local-owner',command:{type:'save-memory',memory:{id:'learned',version:1,scope:'owned',authority:'learned',content:'Not owner-retirable',source:'Fixture candidate',effective:false}}});await product.admit(id,{commandId:'old',expectedRevision:4,workId:'old',title:'Original Work',budget:0});
 const root=await mkdtemp(join(tmpdir(),'massion-retirement-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let unknown=false,reject=false,lost=false,blockEvents=false,holdBefore=false,holdAfter=false,release:undefined|(()=>void);
 const handler=async(path:string,options:any)=>{
  const retirement=path.endsWith('/memory-retirement')&&options.method==='POST';
  if(blockEvents&&path.startsWith('/events'))throw new Error('Controlled receipt poll outage');
  if(retirement&&unknown)return reply({error:'Controlled unresolved request',outcome:'unknown'},503);
  if(retirement&&reject)return reply({error:'Controlled definite rejection'},400);
  if(retirement&&holdBefore){holdBefore=false;await new Promise<void>(r=>release=r);}
  const response=await fetch(base+path,options),body=await response.json();
  if(retirement&&holdAfter){holdAfter=false;await new Promise<void>(r=>release=r);}
  if(retirement&&lost){lost=false;throw new Error('Controlled ack loss after actual commit');}
  return reply(body,response.status);
 };
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'retirement client deadline');await new Promise(r=>setTimeout(r,10));}}
 async function client(identity='retirement-client'){
  const app=harness(handler,{},undefined,{network:true,identity,fragment:'#mission='+encodeURIComponent(id)});await until(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes(id));
  const fields=app.node('retirement-fields');app.node('retirement-form').append(fields);for(const name of ['retirement-target','retirement-reason','stop-memory','review-retirement','cancel-retirement']){const node=app.node(name);fields.append(node);node.onFocus=()=>{if(!fields.disabled)(app.context as any).document.activeElement=node;};}return app;
 }
 async function select(app:Awaited<ReturnType<typeof client>>,memoryId='instruction',version=1,reason='Stop future application') {app.node('retirement-target').value=JSON.stringify([memoryId,version]);await app.node('retirement-target').fire('change');app.node('retirement-reason').value=reason;await app.node('retirement-reason').fire('input');}
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());
 return {store,product,id,other,client,select,until,journal,late(){lost=true;blockEvents=true;},resume(){blockEvents=false;},lose(){lost=true;},unknown(){unknown=true;},reject(){reject=true;},hold(before=false){release=undefined;if(before)holdBefore=true;else holdAfter=true;},held(){return !!release;},release(){release!();}};
}
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} retirement panel selects exact explicit version, retains history/old Work and excludes only that future pin`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable),app=await f.client(),before=(await f.store.load(f.id))!,old=before.value.works[0]!,input=pinnedMemoryInput(before.value,old);assert.deepEqual(app.node('retirement-target').children.map(n=>n.value),['',JSON.stringify(['instruction',1]),JSON.stringify(['keep',1])]);
 await f.select(app);app.node('stop-memory').focus();await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/^Confirmed: instruction · version 1 stopped/);assert.equal(app.node('retirement-target').value,'');assert.equal(app.node('retirement-reason').value,'');assert.equal((app.context as any).document.activeElement.id,'stop-memory');assert.match(app.node('memory-history').textContent,/Original instruction <img src=x>/);assert.match(app.node('memory-history').textContent,/Historical or inactive/);assert.equal(app.all().some(n=>n.tagName==='IMG'),false);assert.deepEqual((await f.store.load(f.id))!.value.works[0],old);assert.deepEqual(pinnedMemoryInput((await f.store.load(f.id))!.value,old),input);
 app.node('work-title').value='Future Work';await app.submit('work-form');const current=(await f.store.load(f.id))!;assert.deepEqual(current.value.works[1]?.appliedMemoryVersions,['keep@1']);assert.deepEqual(current.value.works[0],old);assert.match(app.node('work-list').textContent,/Original instruction <img src=x>/);const journal=await f.journal(),fresh=await f.client('fresh-retirement');assert.match(fresh.node('memory-history').textContent,/Historical or inactive/);assert.equal(fresh.node('retirement-target').children.some(n=>n.value===JSON.stringify(['instruction',1])),false);assert.deepEqual(await f.journal(),journal);
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} exact delayed retirement receipt settles unchanged draft without replay`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable),app=await f.client();await f.select(app);f.late();await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/not confirmed/);assert.ok(app.storage.has('massion.workbench.pending'));assert.equal(app.node('retirement-fields').disabled,true);assert.equal(app.node('retirement-reason').value,'Stop future application');const committed=await f.journal();f.resume();await app.tick();await f.until(()=>!app.storage.has('massion.workbench.pending'));assert.match(app.node('retirement-status').textContent,/^Confirmed:/);assert.equal(app.node('retirement-reason').value,'');assert.equal(app.node('retirement-target').value,'');assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,1);assert.deepEqual(await f.journal(),committed);
});
test('late receipt retains subsequent private draft edits rather than clearing them',async t=>{
 const f=await setup(t),app=await f.client();await f.select(app);f.late();await app.submit('retirement-form');
 // Supporting DOM fixture: actual keyboard input remains disabled by the unknown barrier.
 app.node('retirement-reason').value='Later private draft';await app.node('retirement-reason').fire('input');f.resume();await app.tick();await f.until(()=>!app.storage.has('massion.workbench.pending'));assert.match(app.node('retirement-status').textContent,/^Confirmed:/);assert.equal(app.node('retirement-reason').value,'Later private draft');assert.equal(app.node('retirement-target').value,JSON.stringify(['instruction',1]));assert.equal(app.node('review-retirement').disabled,true);
});
test('pending response suppresses repeat submit/review and preserves deliberately moved focus',async t=>{
 const f=await setup(t),app=await f.client();await f.select(app);app.node('stop-memory').focus();f.hold();const pending=app.submit('retirement-form');await f.until(f.held);assert.equal(app.node('retirement-fields').disabled,true);await app.submit('retirement-form');await app.node('review-retirement').fire('click');await app.node('cancel-retirement').fire('click');assert.equal(app.node('retirement-reason').value,'Stop future application');assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,1);app.node('memory-history').focus();f.release();await pending;assert.equal((app.context as any).document.activeElement.id,'memory-history');assert.match(app.node('retirement-status').textContent,/^Confirmed:/);
});
test('concurrent advancing memory conflicts without retiring replacement; reason/exact old target retained until deliberate new choice',async t=>{
 const f=await setup(t),app=await f.client(),old=(await f.store.load(f.id))!.value.works[0];await f.select(app);f.hold(true);const pending=app.submit('retirement-form');await f.until(f.held);await f.product.saveMemory(f.id,{commandId:'concurrent-v2',expectedRevision:5,memory:{id:'instruction',version:2,content:'Current version2',source:'Other owner client'}});f.release();await pending;assert.match(app.node('status').textContent,/Revision conflict/);assert.equal(app.node('retirement-target').value,JSON.stringify(['instruction',1]));assert.equal(app.node('retirement-reason').value,'Stop future application');assert.match(app.node('retirement-base').textContent,/State changed.*no newer version is substituted/);assert.equal((await f.store.load(f.id))!.value.memories.find(m=>m.version===2)?.effective,true);const journal=await f.journal();await app.submit('retirement-form');await app.node('review-retirement').fire('click');assert.deepEqual(await f.journal(),journal);assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,1);
 await f.select(app,'instruction',2,'Deliberately stop exact v2');await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/^Confirmed: instruction · version 2/);assert.deepEqual((await f.store.load(f.id))!.value.works[0],old);
});
test('invalid/oversized/learned targets send no command; definite rejection and unresolved outcomes retain truthful drafts',async t=>{
 for(const mode of ['invalid','reject','unknown']){const f=await setup(t),app=await f.client(),before=await f.journal();await f.select(app);
  if(mode==='invalid'){for(const reason of ['', '한'.repeat(16000)]){await f.select(app,'instruction',1,reason);await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/No command was sent/);}await f.select(app,'learned',1);await app.submit('retirement-form');assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,0);}
  else{if(mode==='reject')f.reject();else f.unknown();await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/not confirmed/);assert.equal(app.node('retirement-reason').value,'Stop future application');assert.equal(app.storage.has('massion.workbench.pending'),mode==='unknown');assert.equal(app.node('retirement-fields').disabled,mode==='unknown');if(mode==='unknown'){await app.submit('retirement-form');await app.tick();}assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,1);}
  assert.deepEqual(await f.journal(),before);
 }
});
test('retirement target/reason stay Mission scoped and original revision is retained across refresh until explicit review',async t=>{
 const f=await setup(t),app=await f.client();await f.select(app);await app.navigateFragment('#mission='+encodeURIComponent(f.other));await f.until(()=>app.node('loaded-id').textContent===f.other&&!app.node('retirement-fields').disabled);assert.equal(app.node('retirement-target').value,'');assert.equal(app.node('retirement-reason').value,'');app.node('retirement-reason').value='Other private reason';await app.node('retirement-reason').fire('input');await app.navigateFragment('#mission='+encodeURIComponent(f.id));await f.until(()=>app.node('loaded-id').textContent===f.id&&!app.node('retirement-fields').disabled);assert.equal(app.node('retirement-reason').value,'Stop future application');assert.equal(app.node('retirement-target').value,JSON.stringify(['instruction',1]));await f.product.admit(f.id,{commandId:'concurrent-work',expectedRevision:5,workId:'concurrent',title:'Other new Work',budget:0});await app.submit('load-form');await f.until(()=>app.node('retirement-base').textContent.includes('State changed'));assert.match(app.node('retirement-base').textContent,/Draft based on revision 5/);const before=await f.journal();await app.node('review-retirement').fire('click');assert.match(app.node('retirement-base').textContent,/Draft based on revision 6/);assert.deepEqual(await f.journal(),before);await app.submit('retirement-form');assert.match(app.node('retirement-status').textContent,/^Confirmed:/);
});

test('canceling the stop draft changes no memory or unrelated private draft; deselection does not claim an exact target',async t=>{
 const f=await setup(t),app=await f.client(),before=await f.journal();app.node('memory-content').value='Private save draft';await f.select(app);app.node('retirement-target').value='';await app.node('retirement-target').fire('change');assert.match(app.node('retirement-status').textContent,/No active version selected/);assert.match(app.node('retirement-base').textContent,/No target selected/);await f.select(app);await app.node('cancel-retirement').fire('click');assert.equal(app.node('retirement-target').value,'');assert.equal(app.node('retirement-reason').value,'');assert.match(app.node('retirement-status').textContent,/draft canceled.*No command was sent/);assert.equal(app.node('memory-content').value,'Private save draft');assert.equal(app.calls.filter(c=>c.path.endsWith('/memory-retirement')).length,0);assert.deepEqual(await f.journal(),before);
});
