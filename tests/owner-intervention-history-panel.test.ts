import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../src/server.ts';
import {ProductService} from '../src/product.ts';
import type {Mission} from '../src/domain.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';
import {harness,reply} from './support/workbench-client.ts';

async function setup(t:TestContext,durable=false,sparse=false){
 let transport;if(durable){await verifyDisposableDatabase();const database='intervention_history_panel_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:history-panel',other='mission:other-history';
 for(const missionId of [id,other]){await product.create({id:missionId,purpose:'Read exact durable budget reasons',scope:'owned',constraints:[],criteria:{version:1,description:'No draft or journal writes',oracle:'manual-review/v1'}},'create-'+missionId);for(const [i,workId] of (missionId===id?['a','b']:['c','d']).entries())await product.admit(missionId,{commandId:missionId+'-'+workId,expectedRevision:i+1,workId,title:workId,budget:1});}
 let command=0;async function change(missionId:string,workId:string,limit:number,reason:string){return product.intervene(missionId,{commandId:'intervention-'+(++command),expectedRevision:(await store.load(missionId))!.revision,command:{type:'steer',workId,instruction:reason}});}
 if(sparse)for(let i=0;i<21;i++)await change(other,'c',i+2,'Unrelated private reason');
 await change(id,'a',20,'Literal owner <img src=x>');await change(id,'a',30,'Second reason\nExact original text');await product.intervene(id,{commandId:'cancel-historical-b',expectedRevision:5,command:{type:'cancel',workId:'b'}});
 const root=await mkdtemp(join(tmpdir(),'massion-history-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let mode='',blocked=false,release!:()=>void,held=false;
 const handler=async(path:string,options:any)=>{
  if(blocked&&path.startsWith('/events'))throw new Error('Supporting event outage');
  const response=await fetch(base+path,options);let body=await response.json();
  if(path.includes('/work-intervention-history?')){
   if(mode==='fail')return reply({error:'Controlled page failure'},503);
   if(mode==='malformed')body={...body,workId:'wrong-work'};
   if(mode==='wrong-feed')body={...body,feedId:'different-feed'};
   if(mode==='hold'){held=true;await new Promise<void>(r=>release=r);}
  }
  return reply(body,response.status);
 };
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'history panel deadline');await new Promise(r=>setTimeout(r,5));}}
 const app=harness(handler,{},undefined,{network:true,fragment:'#mission='+encodeURIComponent(id),identity:'history-panel'});await until(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes(id));
 // Supporting DOM parent/focus wiring, not native keyboard or accessibility proof.
 const fields=app.node('budget-fields');app.node('budget-form').append(fields);for(const n of ['budget-target','budget-limit','budget-reason','save-budget','review-budget','cancel-budget'])fields.append(app.node(n));app.node('stored-intervention-panel').append(app.node('stored-intervention-target'),app.node('stored-intervention-read'),app.node('stored-intervention-more'),app.node('stored-intervention-cancel'),app.node('stored-intervention-results'));
 async function choose(workId='a'){app.node('stored-intervention-target').value=workId;await app.node('stored-intervention-target').fire('change');}
 async function draft(){app.node('budget-target').value='a';await app.node('budget-target').fire('change');app.node('budget-limit').value='40';await app.node('budget-limit').fire('input');app.node('budget-reason').value='Private budget draft';await app.node('budget-reason').fire('input');return app.node('budget-base').textContent;}
 const historyCalls=()=>app.calls.filter(c=>c.path.includes('/work-intervention-history?'));
 return {app,store,product,id,other,choose,draft,change,until,historyCalls,journal:()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect()),mode(value:string){mode=value;if(value==='hold')held=false;},held:()=>held,release(){release();},blockEvents(){blocked=true;}};
}

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} stored intervention panel pages through sparse batches, excludes later writes and keeps private budget drafts`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable,true),app=f.app;const draftBase=await f.draft(),before=await f.journal();await f.choose();app.node('stored-intervention-read').focus();await app.node('stored-intervention-read').fire('click');assert.match(app.node('stored-intervention-results').textContent,/No matching.*More pages/);assert.equal(app.node('stored-intervention-more').disabled,false);assert.equal((app.context as any).document.activeElement.id,'stored-intervention-read');assert.deepEqual(await f.journal(),before);
 await f.change(f.id,'a',50,'Later outside frozen boundary');const after=await f.journal();app.node('snapshot-json').focus();await app.node('stored-intervention-more').fire('click');const shown=app.node('stored-intervention-results').textContent;assert.match(shown,/<img src=x>/);assert.match(shown,/Second reason\nExact original text/);assert.ok(!shown.includes('Unrelated private')&&!shown.includes('Later outside'));assert.match(app.node('stored-intervention-status').textContent,/boundary reached/);assert.equal(app.node('stored-intervention-more').disabled,true);assert.equal((app.context as any).document.activeElement.id,'snapshot-json');assert.equal(app.all().some(n=>n.tagName==='IMG'),false);
 const [first,next]=f.historyCalls();const a=new URL(first!.path,'http://fixture'),b=new URL(next!.path,'http://fixture');assert.equal(b.searchParams.get('after'),'20');assert.ok(b.searchParams.has('through'));assert.equal(first!.options.headers['X-Massion-Feed'],next!.options.headers['X-Massion-Feed']);assert.equal(app.node('budget-limit').value,'40');assert.equal(app.node('budget-reason').value,'Private budget draft');assert.equal(app.node('budget-base').textContent,draftBase);assert.equal(app.storage.has('massion.workbench.pending'),false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);assert.deepEqual(await f.journal(),after);
 await app.node('stored-intervention-read').fire('click');while(!app.node('stored-intervention-more').disabled)await app.node('stored-intervention-more').fire('click');assert.match(app.node('stored-intervention-results').textContent,/Later outside/);
 await f.choose('b');assert.ok(app.node('stored-intervention-target').children.some(n=>n.value==='b'));await app.node('stored-intervention-read').fire('click');while(!app.node('stored-intervention-more').disabled)await app.node('stored-intervention-more').fire('click');assert.match(app.node('stored-intervention-status').textContent,/boundary reached/);assert.match(app.node('stored-intervention-results').textContent,/action cancel/);assert.match(app.node('stored-intervention-results').textContent,/command cancel-historical-b/);assert.equal(app.node('budget-reason').value,'Private budget draft');assert.deepEqual(await f.journal(),after);
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} history failed or malformed page retains successes and explicitly retries the same cursor without duplicates`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable,true),app=f.app;await f.draft();await f.choose();const before=await f.journal();await app.node('stored-intervention-read').fire('click');const first=app.node('stored-intervention-results').textContent;
 for(const mode of ['fail','malformed','wrong-feed']){f.mode(mode);await app.node('stored-intervention-more').fire('click');assert.match(app.node('stored-intervention-status').textContent,/Retry deliberately/);assert.equal(app.node('stored-intervention-results').textContent,first);assert.equal(app.node('stored-intervention-more').disabled,false);}
 const failed=f.historyCalls().at(-1)!.path;f.mode('');await app.node('stored-intervention-more').fire('click');assert.equal(f.historyCalls().at(-1)!.path,failed);assert.equal(app.node('stored-intervention-results').textContent.split('Literal owner').length,2);assert.equal(app.node('budget-reason').value,'Private budget draft');assert.deepEqual(await f.journal(),before);assert.equal(app.storage.has('massion.workbench.pending'),false);
});
test('cancel and Work switch ignore actual held read replies even when the supporting transport ignores abort',async t=>{
 const f=await setup(t),app=f.app;await f.draft();await f.choose();const before=await f.journal();f.mode('hold');app.node('stored-intervention-read').focus();const pending=app.node('stored-intervention-read').fire('click');await f.until(f.held);assert.equal(app.node('stored-intervention-read').disabled,true);assert.equal(app.node('stored-intervention-more').disabled,true);assert.equal(app.node('stored-intervention-cancel').disabled,false);await app.node('stored-intervention-read').fire('click');assert.equal(f.historyCalls().length,1);app.node('stored-intervention-cancel').focus();await app.node('stored-intervention-cancel').fire('click');assert.equal((app.context as any).document.activeElement.id,'stored-intervention-read');assert.equal(f.historyCalls()[0]!.options.signal.aborted,true);f.mode('');f.release();await pending;assert.match(app.node('stored-intervention-status').textContent,/canceled/);assert.equal(app.node('stored-intervention-results').textContent,'');
 f.mode('hold');const stale=app.node('stored-intervention-read').fire('click');await f.until(f.held);await f.choose('b');assert.equal(app.node('stored-intervention-results').textContent,'');f.mode('');await app.node('stored-intervention-read').fire('click');const shown=app.node('stored-intervention-results').textContent;f.release();await stale;assert.equal(app.node('stored-intervention-target').value,'b');assert.equal(app.node('stored-intervention-results').textContent,shown);assert.ok(!shown.includes('Literal owner'));assert.deepEqual(await f.journal(),before);assert.equal(app.node('budget-reason').value,'Private budget draft');
});
test('Mission navigation and connection loss discard held history but preserve private budget drafts',async t=>{
 const f=await setup(t),app=f.app;await f.draft();await f.choose();f.mode('hold');const pending=app.node('stored-intervention-read').fire('click');await f.until(f.held);await app.navigateFragment('#mission='+encodeURIComponent(f.other));await f.until(()=>app.node('loaded-id').textContent===f.other&&!app.node('mission-id').disabled);f.mode('');f.release();await pending;assert.ok(!app.node('stored-intervention-results').textContent.includes('Literal owner'));assert.equal(app.node('stored-intervention-target').value,'');await app.navigateFragment('#mission='+encodeURIComponent(f.id));await f.until(()=>app.node('loaded-id').textContent===f.id&&!app.node('budget-fields').disabled);assert.equal(app.node('budget-reason').value,'Private budget draft');assert.equal(app.node('stored-intervention-target').value,'a');
 f.mode('hold');const disconnected=app.node('stored-intervention-read').fire('click');await f.until(f.held);f.blockEvents();await app.tick();f.mode('');f.release();await disconnected;assert.ok(!app.node('stored-intervention-results').textContent.includes('Literal owner'));assert.equal(app.node('budget-reason').value,'Private budget draft');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
test('bounded history view refuses an overflow page without advancing or claiming completion',async t=>{
 const f=await setup(t),app=f.app;for(let i=0;i<199;i++)await f.change(f.id,'a',100+i,'Additional recorded change '+i);await f.choose();await app.node('stored-intervention-read').fire('click');let pages=1;while(!app.node('stored-intervention-more').disabled){await app.node('stored-intervention-more').fire('click');assert.ok(++pages<30);}
 assert.match(app.node('stored-intervention-status').textContent,/limited to 200/);assert.ok(app.node('stored-intervention-results').children.filter(n=>n.tagName==='PRE').length<=200);assert.ok(!app.node('stored-intervention-status').textContent.includes('boundary reached'));assert.equal(app.node('stored-intervention-read').disabled,false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
