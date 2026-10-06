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
import {harness,reply,settle} from './support/workbench-client.ts';

async function setup(t:TestContext,durable=false){
 let transport;if(durable){await verifyDisposableDatabase();const database='memory_panel_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:memory-panel';
 for(const missionId of [id,'mission:other-memory'])await product.create({id:missionId,purpose:'Keep owner instructions',scope:'project',constraints:[],criteria:{version:1,description:'Inspect precise memory input',oracle:'manual-review/v1'}},'create-'+missionId);
 const root=await mkdtemp(join(tmpdir(),'massion-memory-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let lost=false,unknown=false,hold=false,release!:()=>void;
 const handler=async(path:string,options:any)=>{
  if(path.endsWith('/memory')&&options.method==='POST'&&unknown)return reply({error:'Controlled unresolved dispatch',outcome:'unknown'},503);
  const response=await fetch(base+path,options),body=await response.json();
  if(path.endsWith('/memory')&&options.method==='POST'){
   if(hold){hold=false;await new Promise<void>(r=>release=r);}
   if(lost){lost=false;throw new Error('Controlled acknowledged response loss');}
  }
  return reply(body,response.status);
 };
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'memory panel HTTP deadline');await new Promise(r=>setTimeout(r,10));}}
 async function client(identity='memory-client'){
  const app=harness(handler,{},undefined,{network:true,fragment:'#mission='+encodeURIComponent(id),identity});await until(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes(id));
  // Browser-equivalent form ancestry/focus behavior for disabled descendants.
  const fields=app.node('memory-fields');app.node('memory-form').append(fields);for(const name of ['memory-id','memory-version','memory-content','memory-source','save-memory']){const node=app.node(name);fields.append(node);node.onFocus=()=>{if(!fields.disabled)(app.context as any).document.activeElement=node;};}
  return app;
 }
 async function draft(app:Awaited<ReturnType<typeof client>>,version='1',content='Owner instruction <img src=x>',source='Owner supplied rationale'){
  for(const [name,value] of [['memory-id','instruction'],['memory-version',version],['memory-content',content],['memory-source',source]]){app.node(name!).value=value!;await app.node(name!).fire('input');}
 }
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());
 return {store,product,id,client,draft,until,journal,lose(){lost=true;},unknown(){unknown=true;},hold(){hold=true;},heldReady(){return typeof release==='function';},release(){release();}};
}
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} memory UI/HTTP pins old and future Work, retains history and never treats owner content as HTML`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 const f=await setup(t,durable),app=await f.client();app.node('work-title').value='Keep this private Work draft';app.node('purpose').value='Keep Mission draft';await f.draft(app);app.node('save-memory').focus();await app.submit('memory-form');
 assert.match(app.node('memory-history').textContent,/instruction · version 1.*Authority: explicit.*Owner instruction <img src=x>/);assert.equal(app.all().some(n=>n.tagName==='IMG'),false);assert.equal((app.context as any).document.activeElement.id,'save-memory');assert.equal(app.node('work-title').value,'Keep this private Work draft');assert.equal(app.node('purpose').value,'Keep Mission draft');
 await app.submit('work-form');await f.draft(app,'2','Revised owner instruction');await app.submit('memory-form');app.node('work-title').value='Future Work';await app.submit('work-form');
 const snapshot=(await f.store.load(f.id))!;assert.deepEqual(snapshot.value.works.map(w=>w.appliedMemoryVersions),[['instruction@1'],['instruction@2']]);assert.match(app.node('memory-history').textContent,/Historical or inactive version/);assert.match(app.node('work-list').textContent,/Owner instruction <img src=x>/);assert.match(app.node('work-list').textContent,/Revised owner instruction/);
 const journal=await f.journal(),fresh=await f.client('fresh-memory-client');assert.equal(fresh.node('memory-history').textContent,app.node('memory-history').textContent);assert.deepEqual(await f.journal(),journal);assert.ok(snapshot.value.works.every(w=>!w.effects.length&&!w.record));
 t.diagnostic(JSON.stringify({store:durable?'actual SurrealDB 3.3.0':'in-memory fixture',immutableMemoryVersions:2,oldAndNewPinnedContentsVisible:true,freshClientSameHistory:true,providerCalls:0}));
});
test('Mission memory drafts are scoped and stale save refreshes truth without retry or discarding text',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app,'1','Keep this Mission draft');await app.navigateFragment('#mission=mission%3Aother-memory');await f.until(()=>app.node('snapshot-json').textContent.includes('other-memory'));
 assert.equal(app.node('memory-content').value,'');await f.draft(app,'1','Other Mission draft');await app.navigateFragment('#mission=mission%3Amemory-panel');await f.until(()=>app.node('snapshot-json').textContent.includes(f.id));assert.equal(app.node('memory-content').value,'Keep this Mission draft');
 await f.product.saveMemory(f.id,{commandId:'other-client-memory',expectedRevision:1,memory:{id:'instruction',version:1,content:'Current other-client truth',source:'Other owner client'}});const before=app.calls.filter(c=>c.options.method==='POST').length;await app.submit('memory-form');
 assert.match(app.node('status').textContent,/Revision conflict/);assert.match(app.node('memory-history').textContent,/Current other-client truth/);assert.equal(app.node('memory-content').value,'Keep this Mission draft');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,before+1);assert.equal((await f.store.load(f.id))?.value.memories.length,1);
});
test('lost acknowledged memory response is confirmed by durable readback without replay or false unconfirmed UI',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);f.lose();await app.submit('memory-form');
 assert.equal(app.storage.has('massion.workbench.pending'),false);assert.match(app.node('memory-status').textContent,/Explicit version confirmed/);assert.match(app.node('memory-history').textContent,/version 1/);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,1);assert.equal((await f.store.load(f.id))?.value.memories.length,1);
});
test('unresolved memory dispatch retains its draft and the independent write barrier without replay',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);f.unknown();await app.submit('memory-form');await app.tick();
 assert.ok(app.storage.has('massion.workbench.pending'));assert.equal(app.node('memory-fields').disabled,true);assert.equal(app.node('memory-content').value,'Owner instruction <img src=x>');assert.match(app.node('memory-status').textContent,/not confirmed/);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,1);assert.equal((await f.store.load(f.id))?.value.memories.length,0);
});
test('pending memory save keeps a deliberate focus move to the readable history region',async t=>{
 const f=await setup(t),app=await f.client();await f.draft(app);app.node('save-memory').focus();f.hold();const pending=app.submit('memory-form');await f.until(()=>f.heldReady());assert.equal(app.node('memory-fields').disabled,true);app.node('memory-history').focus();f.release();await pending;assert.equal((app.context as any).document.activeElement.id,'memory-history');assert.equal(app.node('memory-fields').disabled,false);
});
