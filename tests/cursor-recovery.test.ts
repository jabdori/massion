import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInContext} from 'node:vm';
import type {Mission} from '../src/domain.ts';
import {SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {harness,reply,selectionField} from './support/workbench-client.ts';

async function eventually(check:()=>boolean){const until=Date.now()+3000;while(!check()){if(Date.now()>until)assert.fail('Timed out waiting for recovery');await new Promise(resolve=>setTimeout(resolve,5));}}
for(const ahead of [false,true])for(const uncertain of [false,true])test(`actual isolated database replacement ${ahead?'lower head':'same cursor different state'} ${uncertain?'with unknown command':'without pending command'} preserves reads and drafts`,{skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-cursor-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='mission:cursor-recovery',workId='work:retained';
 async function seed(label:string){
  const database='cursor_'+crypto.randomUUID().replaceAll('-','');
  const transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});
  await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);
  const store=new SurrealStore<Mission>(transport),product=new ProductService(store);
  await product.create({id,purpose:label,scope:'cursor-only',constraints:[],criteria:{version:1,description:'Never run models',oracle:'manual-review/v1'}},'create:'+label);
  await product.admit(id,{commandId:'admit:'+label,expectedRevision:1,workId,title:label,budget:12});
  return store;
 }
 const original=await seed('Original'),replacement=await seed('Replacement');
 if(ahead)await new ProductService(original).intervene(id,{commandId:'old:extra',expectedRevision:2,command:{type:'steer',workId,instruction:'Old database only'}});
 // Keep the actual HTTP host/socket alive; only the isolated database binding changes.
 let current=original;
 const routed:Store<Mission>={load:id=>current.load(id),readEvents:(after,limit)=>current.readEvents(after,limit),readState:id=>current.readState(id),readCatchup:(after,feed,limit)=>current.readCatchup(after,feed,limit),commit:input=>current.commit(input),reconcile:input=>current.reconcile(input),lookupOperation:identity=>current.lookupOperation(identity)};
 const server=createWorkbench(routed,root);let port=0,base='';
 async function listen(){server.listen(port,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;base='http://127.0.0.1:'+port;}
 async function close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await listen();t.after(close);
 const pending={commandId:'missing:receipt',missionId:id,reconcileCursor:ahead?3:2};const saved=JSON.stringify(pending);
 const initial:Record<string,string>={'massion.workbench.fixture-pending':'pending'};if(uncertain)initial['massion.workbench.pending']=saved;
 const app=harness(async(path,options)=>{const response=await fetch(base+path,options);return reply(await response.json(),response.status);},initial,undefined,{network:true,fragment:'#mission='+id,identity:crypto.randomUUID()});
 const idle=()=>eventually(()=>runInContext('!polling && !loading',app.context));
 await eventually(()=>app.node('sync-notice').hidden&&app.node('snapshot-json').textContent.includes('Original'));await app.tick();await idle();
 const beforeCursor=Number(app.storage.get('massion.workbench.cursor'));assert.equal(beforeCursor,ahead?3:2);
 const input=selectionField(app,'steer-'+workId);input.value='My private draft';await input.fire('input');app.node('work-title').value='Private admission draft';
 const journal=await replacement.readEvents(0,1000);
 current=replacement;
 await app.tick();await idle();await app.tick();await idle();
 assert.match(app.node('snapshot-json').textContent,/Replacement/);
 assert.equal(selectionField(app,'steer-'+workId).value,'My private draft');assert.equal(app.node('work-title').value,'Private admission draft');
 assert.equal(app.storage.get('massion.workbench.pending'),uncertain?saved:undefined);assert.equal(app.node('work-fields').disabled,uncertain);assert.equal(app.node('sync-notice').hidden,true);
 assert.equal(app.storage.get('massion.workbench.fixture-pending'),'pending');assert.equal(app.node('run-fixture').disabled,true);
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);assert.deepEqual(await replacement.readEvents(0,1000),journal);
 const second=harness(async(path,options)=>{const response=await fetch(base+path,options);return reply(await response.json(),response.status);},{},undefined,{network:true,fragment:'#mission='+id,identity:crypto.randomUUID()});
 await eventually(()=>second.node('sync-notice').hidden&&second.node('snapshot-json').textContent.includes('Replacement'));
 assert.notEqual(second.storage,app.storage);assert.equal(second.calls.filter(call=>call.options.method==='POST').length,0);
 if(uncertain){
  await new ProductService(replacement).intervene(id,{commandId:pending.commandId,expectedRevision:2,command:{type:'steer',workId,instruction:'Exact receipt recorded by a separate owner'}});
  await app.tick();await idle();assert.equal(app.storage.has('massion.workbench.pending'),false);assert.equal(app.node('work-fields').disabled,false);
  assert.equal(selectionField(app,'steer-'+workId).value,'My private draft');assert.equal(app.storage.get('massion.workbench.fixture-pending'),'pending');
  assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);
 }
});

test('actual snapshot boundary remains consistent during writes and fresh journal restore changes feed identity',{skip:!process.env.MASSION_TEST_SURREAL_RPC},async()=>{
 async function fresh(){const database='boundary_'+crypto.randomUUID().replaceAll('-','');const transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);return new SurrealStore<{n:number}>(transport);}
 const store=await fresh(),id='boundary';
 for(let n=1;n<=12;n++){
  const [state]=await Promise.all([store.readState(id),store.commit({id,commandId:'write:'+n,fingerprint:'write:'+n,expectedRevision:n-1,value:{n},events:[],outbox:[]})]);
  assert.equal(state.snapshot?.revision??0,state.cursor);assert.equal(state.snapshot?.value.n??0,state.cursor);
  const page=await store.readCatchup(state.cursor,state.feedId);assert.equal(page.cursor,n);assert.equal(page.events.length,n-state.cursor);
 }
 const state=await store.readState(id);
 const restored=await fresh();await restored.restoreJournal(await store.exportJournal());const restoredState=await restored.readState(id);
 assert.deepEqual(restoredState.snapshot,state.snapshot);assert.equal(restoredState.cursor,state.cursor);assert.notEqual(restoredState.feedId,state.feedId);
 await assert.rejects(restored.readCatchup(state.cursor,state.feedId),{name:'EventCursorError'});
 const empty=await restored.readState();assert.equal(empty.snapshot,null);assert.equal(empty.cursor,12);
});
