import test from 'node:test';
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

for(const durable of [false,true])test(`${durable?'actual SurrealDB':'in-memory fixture'} memory request byte bounds reject oversized valid-character drafts before transmission and accept the exact HTTP boundary`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async t=>{
 let transport;if(durable){await verifyDisposableDatabase();const database='memory_bytes_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),product=new ProductService(store),id='mission:memory-bytes';await product.create({id,purpose:'Inspect request bytes',scope:'owned',constraints:[],criteria:{version:1,description:'Retain input within transport bounds',oracle:'manual-review/v1'}},'create');
 const root=await mkdtemp(join(tmpdir(),'massion-memory-bytes-'));t.after(()=>rm(root,{recursive:true,force:true}));const server=createWorkbench(store,root);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 const wire:{path:string;status:number;bytes:number}[]=[];const handler=async(path:string,options:any)=>{const response=await fetch(base+path,options),body=await response.json();if(options.method==='POST')wire.push({path,status:response.status,bytes:Buffer.byteLength(options.body)});return reply(body,response.status);};
 const app=harness(handler,{},undefined,{network:true,identity:'memory-bytes',fragment:'#mission='+encodeURIComponent(id)});const end=Date.now()+10000;while(app.node('sync-notice').hidden!==true||!app.node('snapshot-json').textContent.includes(id)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());const before=await journal();
 for(const [content,source] of [['한'.repeat(16000),'Owner source'],['😀'.repeat(8000),'s'.repeat(1000)],['\u0000'.repeat(6000),'Owner source']]){
  assert.ok(content!.length<=16000&&source!.length<=16000);app.node('memory-id').value='large';app.node('memory-version').value='1';app.node('memory-content').value=content!;app.node('memory-source').value=source!;await app.submit('memory-form');
  t.diagnostic(JSON.stringify({validCharacterLimits:true,contentLength:content!.length,sourceLength:source!.length,wire,clientStatus:app.node('memory-status').textContent}));
  assert.equal(wire.length,0,'an oversized draft must be rejected before sending a command');assert.match(app.node('memory-status').textContent,/32 KiB.*UTF-8/);assert.equal(app.node('memory-content').value,content);assert.equal(app.storage.has('massion.workbench.pending'),false);assert.equal(app.node('memory-fields').disabled,false);assert.deepEqual(await journal(),before);
 }
 app.node('memory-content').value='한'.repeat(9000);app.node('memory-source').value='Owner source';await app.submit('memory-form');assert.equal(wire.length,1);assert.equal(wire[0]?.status,201);assert.match(app.node('memory-status').textContent,/confirmed/);assert.equal((await store.load(id))!.value.memories[0]?.content,'한'.repeat(9000));
 const feedId=(await store.readState()).feedId,exact={commandId:'exact',expectedRevision:2,memory:{id:'boundary',version:1,content:'기억'.repeat(5000),source:''}};
 exact.memory.source='s'.repeat(32768-Buffer.byteLength(JSON.stringify(exact)));assert.ok(exact.memory.source.length<=16000);assert.equal(Buffer.byteLength(JSON.stringify(exact)),32768);
 const post=async(body:unknown)=>{const response=await fetch(base+'/missions/'+id+'/memory',{method:'POST',headers:{'content-type':'application/json','X-Massion-Feed':feedId},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};assert.equal((await post(exact)).status,201);const current=await store.load(id),committed=await journal();assert.equal(current?.value.memories[1]?.content,exact.memory.content);
 const tooLarge={...exact,memory:{...exact.memory,source:exact.memory.source+'s'}};assert.equal(Buffer.byteLength(JSON.stringify(tooLarge)),32769);assert.equal((await post(tooLarge)).status,413);assert.deepEqual(await store.load(id),current);assert.deepEqual(await journal(),committed);assert.ok(current!.value.works.every(w=>!w.effects.length&&!w.runtimeRun));
});
