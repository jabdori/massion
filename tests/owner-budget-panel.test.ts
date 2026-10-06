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

async function setup(t:TestContext,durable=false){
 let transport;if(durable){await verifyDisposableDatabase();const database='budget_panel_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:budget-panel',other='mission:budget-other';
 for(const missionId of [id,other]){await product.create({id:missionId,purpose:'Inspect exact Work budget',scope:'owned',constraints:[],criteria:{version:1,description:'Preserve Work input',oracle:'manual-review/v1'}},'create-'+missionId);for(const [i,workId] of ['a','b'].entries())await product.admit(missionId,{commandId:missionId+'-'+workId,expectedRevision:i+1,workId,title:'Responsibility '+workId,budget:1});}
 const root=await mkdtemp(join(tmpdir(),'massion-budget-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 let mode='',holdBefore=false,blocked=false,release!:()=>void,held=false;
 const handler=async(path:string,options:any)=>{
  if(path.startsWith('/events')&&blocked)throw new Error('Controlled event outage');
  if(path.endsWith('/work-budget')&&options.method==='POST'){
   if(mode==='reject')return reply({error:'Controlled definite rejection',outcome:'rejected'},400);
   if(mode==='unknown')return reply({error:'Controlled unresolved outcome',outcome:'unknown'},503);
   if(mode==='hold'&&holdBefore){held=true;await new Promise<void>(r=>release=r);}
  }
  const response=await fetch(base+path,options),body=await response.json();
  if(path.endsWith('/work-budget')&&options.method==='POST'){
   if(mode==='late'){blocked=true;throw new Error('Controlled lost acknowledgement after real commit');}
   if(mode==='hold'&&!holdBefore){held=true;await new Promise<void>(r=>release=r);}
  }
  return reply(body,response.status);
 };
 async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'budget panel deadline');await new Promise(r=>setTimeout(r,10));}}
 async function client(){const app=harness(handler,{},undefined,{network:true,fragment:'#mission='+encodeURIComponent(id),identity:'budget-client'});await until(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes(id));const fields=app.node('budget-fields');app.node('budget-form').append(fields);for(const name of ['budget-target','budget-limit','budget-reason','save-budget','review-budget','cancel-budget']){const node=app.node(name);fields.append(node);node.onFocus=()=>{if(!fields.disabled)(app.context as any).document.activeElement=node;};}return app;}
 async function choose(app:Awaited<ReturnType<typeof client>>,workId='a',limit='20',reason='Reserve output for both roles <img src=x>'){app.node('budget-target').value=workId;await app.node('budget-target').fire('change');app.node('budget-limit').value=limit;await app.node('budget-limit').fire('input');app.node('budget-reason').value=reason;await app.node('budget-reason').fire('input');}
 return {store,product,id,other,client,choose,until,journal:()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect()),setMode(value:string,before=false){mode=value;holdBefore=before;},held:()=>held,release(){release();},resume(){mode='';blocked=false;}};
}
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} budget panel selects exact Work and preserves original inputs/other Work with literal observed reasons`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable),before=(await f.store.load(f.id))!,app=await f.client();await f.choose(app);app.node('save-budget').focus();await app.submit('budget-form');assert.match(app.node('budget-status').textContent,/^Confirmed/);assert.match(app.node('budget-current').textContent,/Current limit 20.*unit not pinned yet/);assert.equal(app.node('budget-reason').value,'');assert.equal((app.context as any).document.activeElement.id,'save-budget');const current=(await f.store.load(f.id))!;assert.deepEqual(current.value.works[0],{...before.value.works[0],budget:{...before.value.works[0]!.budget,limit:20}});assert.deepEqual(current.value.works[1],before.value.works[1]);assert.ok(!current.value.works[0]!.runtimeRun&&!current.value.works[0]!.effects.length);await app.tick();await f.until(()=>app.node('budget-history').textContent.includes('Recorded reason'));assert.match(app.node('budget-history').textContent,/<img src=x>/);assert.equal(app.all().some(n=>n.tagName==='IMG'),false);assert.equal(app.calls.filter(c=>c.path.endsWith('/work-budget')).length,1);
});
for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} late actual budget receipt settles without replay or later draft loss`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await setup(t,durable),app=await f.client();await f.choose(app);f.setMode('late');await app.submit('budget-form');assert.match(app.node('budget-status').textContent,/not confirmed/);assert.equal(app.node('budget-fields').disabled,true);assert.ok(app.storage.has('massion.workbench.pending'));const journal=await f.journal();await app.submit('budget-form');await app.node('review-budget').fire('click');assert.equal(app.calls.filter(c=>c.path.endsWith('/work-budget')).length,1);f.resume();await app.tick();await f.until(()=>!app.storage.has('massion.workbench.pending'));assert.match(app.node('budget-status').textContent,/^Confirmed/);assert.equal(app.node('budget-reason').value,'');assert.deepEqual(await f.journal(),journal);
});
test('budget conflict keeps exact Work, limit, reason and base until explicit current-state review',async t=>{
 const f=await setup(t),app=await f.client();await f.choose(app);f.setMode('hold',true);const pending=app.submit('budget-form');await f.until(f.held);await f.product.reviseBudget(f.id,{commandId:'other-owner',expectedRevision:3,workId:'a',limit:30,reason:'Another client'});f.release();await pending;assert.match(app.node('status').textContent,/Revision conflict/);assert.equal(app.node('budget-target').value,'a');assert.equal(app.node('budget-limit').value,'20');assert.match(app.node('budget-reason').value,/Reserve output/);assert.match(app.node('budget-base').textContent,/Draft based on revision 3.*State changed/);const journal=await f.journal();await app.node('review-budget').fire('click');assert.match(app.node('budget-base').textContent,/Draft based on revision 4/);assert.deepEqual(await f.journal(),journal);f.resume();await app.submit('budget-form');assert.equal((await f.store.load(f.id))!.value.works[0]!.budget.limit,20);
});
test('budget validation/rejection/unknown retain drafts and pending response preserves deliberately moved focus',async t=>{
 const f=await setup(t),app=await f.client(),before=await f.journal();for(const [limit,reason] of [['','reason'],['1','reason'],['-1','reason'],['Infinity','reason'],['20',''],['20','한'.repeat(16000)]]){await f.choose(app,'a',limit!,reason!);await app.submit('budget-form');assert.match(app.node('budget-status').textContent,/No command was sent/);}assert.equal(app.calls.filter(c=>c.path.endsWith('/work-budget')).length,0);assert.deepEqual(await f.journal(),before);
 await f.choose(app);f.setMode('reject');await app.submit('budget-form');assert.match(app.node('budget-status').textContent,/not confirmed/);assert.equal(app.storage.has('massion.workbench.pending'),false);assert.match(app.node('budget-reason').value,/Reserve output/);assert.deepEqual(await f.journal(),before);
 f.setMode('hold');const pending=app.submit('budget-form');await f.until(f.held);assert.equal(app.node('budget-fields').disabled,true);await app.submit('budget-form');await app.node('cancel-budget').fire('click');assert.match(app.node('budget-reason').value,/Reserve output/);app.node('snapshot-json').focus();f.release();await pending;assert.equal((app.context as any).document.activeElement.id,'snapshot-json');assert.equal(app.calls.filter(c=>c.path.endsWith('/work-budget')).length,2);
});
test('budget drafts are Mission/Work scoped; cancel is private and later disabled-field fixture edits survive receipt',async t=>{
 const f=await setup(t),app=await f.client();await f.choose(app,'a','20','Draft A');await f.choose(app,'b','30','Draft B');app.node('budget-target').value='a';await app.node('budget-target').fire('change');assert.equal(app.node('budget-reason').value,'Draft A');await app.navigateFragment('#mission='+encodeURIComponent(f.other));await f.until(()=>app.node('loaded-id').textContent===f.other&&!app.node('budget-fields').disabled);assert.equal(app.node('budget-target').value,'');await app.navigateFragment('#mission='+encodeURIComponent(f.id));await f.until(()=>app.node('loaded-id').textContent===f.id&&!app.node('budget-fields').disabled);assert.equal(app.node('budget-reason').value,'Draft A');const journal=await f.journal();await app.node('cancel-budget').fire('click');assert.equal(app.node('budget-reason').value,'');assert.deepEqual(await f.journal(),journal);
 await f.choose(app,'a','20','Submitted A');f.setMode('late');await app.submit('budget-form');app.node('budget-reason').value='Later private edit';await app.node('budget-reason').fire('input');f.resume();await app.tick();await f.until(()=>!app.storage.has('massion.workbench.pending'));assert.equal(app.node('budget-reason').value,'Later private edit');assert.match(app.node('budget-status').textContent,/^Confirmed/);
});

test('unresolved budget outcome blocks duplicates; cancelled target never substitutes another Work',async t=>{
 const f=await setup(t),app=await f.client();await f.choose(app);const before=await f.journal();f.setMode('unknown');await app.submit('budget-form');assert.ok(app.storage.has('massion.workbench.pending'));assert.equal(app.node('budget-fields').disabled,true);await app.submit('budget-form');await app.node('review-budget').fire('click');await app.node('cancel-budget').fire('click');assert.equal(app.node('budget-target').value,'a');assert.match(app.node('budget-reason').value,/Reserve output/);assert.equal(app.calls.filter(c=>c.path.endsWith('/work-budget')).length,1);assert.deepEqual(await f.journal(),before);
 const g=await setup(t),client=await g.client();await g.choose(client);await g.product.intervene(g.id,{commandId:'cancel-a',expectedRevision:3,command:{type:'cancel',workId:'a'}});await client.submit('load-form');assert.equal(client.node('budget-target').value,'a');assert.match(client.node('budget-base').textContent,/no replacement/);assert.equal(client.node('save-budget').disabled,true);const cancelled=await g.journal();await client.submit('budget-form');assert.equal(client.calls.filter(c=>c.path.endsWith('/work-budget')).length,0);assert.deepEqual(await g.journal(),cancelled);
});
