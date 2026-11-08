import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';

test('versioned protocol negotiates, correlates and keeps replay and identity conflicts on the existing write path',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-protocol-')),store=new InMemoryStore<Mission>(),server=createWorkbench(store,root,{scheduleIntervalMs:0});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 const send=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
 const hello=await send('/protocol/connect',{version:1,requestId:'connect-1',generation:0,supported:{min:1,max:1}});
 assert.equal(hello.status,200);assert.equal(hello.body.payload.state,'ready');assert.deepEqual(hello.body.payload.supported,{min:1,max:1});assert.equal(hello.body.requestId,'connect-1');
 const payload={id:'protocol-mission',commandId:'protocol-create',purpose:'Protocol evidence',scope:'fixture',constraints:[],criteria:{version:1,description:'Original receipt',oracle:'manual-review/v1'}};
 const message={version:1,requestId:'create-1',generation:3,kind:'command',path:'/missions',payload,feedId:(await store.readState()).feedId};
 const rejected=await send('/protocol/request',{...message,version:99});assert.equal(rejected.status,426);assert.equal(rejected.body.payload.outcome,'rejected');assert.equal((await store.readEvents(0)).cursor,0);
 const results=await Promise.all([send('/protocol/request',message),send('/protocol/request',{...message,requestId:'create-2'})]);
 assert.deepEqual(results.map(r=>r.body.payload.status).sort(),['committed','replayed']);assert.equal(results[0]!.body.requestId,'create-1');assert.equal(results[0]!.body.generation,3);
 const conflict=await send('/protocol/request',{...message,requestId:'create-3',payload:{...payload,purpose:'Changed'}});assert.equal(conflict.status,409);assert.equal(conflict.body.payload.reason,'idempotency');assert.equal((await store.readEvents(0)).cursor,1);
 const query=await send('/protocol/request',{version:1,requestId:'read-1',generation:4,kind:'query',path:'/read-state?mission=protocol-mission'});
 assert.equal(query.status,200);assert.equal(query.body.payload.snapshot.value.purpose,payload.purpose);
});

test('SSE resumes durable cursors, signals a replacement and closes on drain',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-push-'));let current=new InMemoryStore<Mission>();
 const routed=new Proxy(current,{get(_target,key){const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;}});
 const server=createWorkbench(routed,root,{scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port,abort=new AbortController();
 t.after(async()=>{abort.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 const position=await current.readState(),query=new URLSearchParams({version:'1',requestId:'feed-1',generation:'1',after:'0',feedId:position.feedId});
 const response=await fetch(base+'/protocol/events?'+query,{signal:abort.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);
 const reader=response.body!.getReader();let buffered='';async function next(){while(true){const at=buffered.indexOf('\n\n');if(at>=0){const frame=buffered.slice(0,at);buffered=buffered.slice(at+2);const data=frame.split('\n').find(line=>line.startsWith('data: '));if(data)return JSON.parse(data.slice(6));continue;}const {value,done}=await reader.read();assert.equal(done,false);buffered+=new TextDecoder().decode(value);}}
 assert.equal((await next()).reason,'connected');
 const {ProductService}=await import('../src/product.ts');
 const create=(id:string)=>({id,purpose:'Push '+id,scope:'fixture',constraints:[],criteria:{version:1,description:'No replay',oracle:'manual-review/v1'}});
 await new ProductService(current).create(create('one'),'create-one');let hint=await next();assert.equal(hint.kind,'feed');assert.equal(hint.cursor,1);assert.equal(hint.revision,1);assert.equal(hint.aggregateId,'one');assert.equal(hint.version,1);
 abort.abort();
 await new ProductService(current).create(create('two'),'create-two');
 const resumeAbort=new AbortController();t.after(()=>resumeAbort.abort());
 const resume=await fetch(base+'/protocol/events?'+query,{headers:{'Last-Event-ID':JSON.stringify([position.feedId,1])},signal:resumeAbort.signal});
 const resumedReader=resume.body!.getReader();let text='';while(!text.includes('"reason":"revision"'))text+=new TextDecoder().decode((await resumedReader.read()).value);
 const frames=text.split('\n\n').flatMap(frame=>frame.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))));
 assert.equal(frames[0]!.cursor,1);assert.equal(frames.find(f=>f.reason==='revision')!.cursor,2);
 current=new InMemoryStore<Mission>();await new ProductService(current).create(create('replacement'),'replace');
 text='';while(!text.includes('"reason":"reset"'))text+=new TextDecoder().decode((await resumedReader.read()).value);
 assert.ok(!text.includes(position.feedId));assert.match(text,/"cursor":1/);
 assert.deepEqual(await server.drain(),{status:'drained',timedOut:false});
});

test('protocol owner command held in lookup cannot commit after drain begins',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-protocol-drain-')),store=new InMemoryStore<Mission>();let reached!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>reached=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const held=new Proxy(store,{get(target,key){if(key==='lookupOperation')return async(input:any)=>{reached();await gate;return target.lookupOperation(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const server=createWorkbench(held,root,{scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{release();server.closeAllConnections();await rm(root,{recursive:true,force:true});});
 const response=fetch('http://127.0.0.1:'+address.port+'/protocol/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,requestId:'drain',generation:1,kind:'command',path:'/missions',payload:{id:'drain',commandId:'drain',purpose:'Refused',scope:'fixture',constraints:[],criteria:{version:1,description:'Drain',oracle:'manual-review/v1'}}})});
 await entered;const drain=server.drain();release();const result=await response;assert.equal(result.status,503);assert.equal((await result.json()).payload.outcome,'rejected');assert.deepEqual(await drain,{status:'drained',timedOut:false});assert.equal((await store.readEvents(0)).cursor,0);
});

test('protocol envelopes preserve the existing logical JSON body limit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-protocol-limit-')),store=new InMemoryStore<Mission>(),server=createWorkbench(store,root,{scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 const {MAX_REQUEST_BODY_BYTES}=await import('../src/request-limits.ts');
 const payload={padding:'x'.repeat(MAX_REQUEST_BODY_BYTES-14)};assert.equal(Buffer.byteLength(JSON.stringify(payload)),MAX_REQUEST_BODY_BYTES);
 const send=async(path:string,body:unknown)=>fetch('http://127.0.0.1:'+address.port+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const message={version:1,requestId:'limit',generation:1,kind:'command',path:'/fixture-run',payload};
 assert.equal((await send('/fixture-run',payload)).status,400);
 assert.equal((await send('/protocol/request',message)).status,400);
 assert.equal((await send('/protocol/request',{...message,payload:{padding:payload.padding+'x'}})).status,413);assert.equal((await store.readEvents(0)).cursor,0);
});

test('a slow SSE consumer is disconnected and no observer remains for it',async()=>{
 const {createProtocolFeed}=await import('../src/protocol-feed.ts');let reads=0,destroyed=0;
 const feed=createProtocolFeed({readState:async()=>{reads++;return {feedId:'slow-feed',cursor:0,snapshot:null};},readCatchup:async()=>assert.fail('No read for a disconnected subscriber')});
 const response={writeHead(){},write(){return false;},on(){},destroy(){destroyed++;},end(){}};
 await feed.subscribe(response as any,{version:1,requestId:'slow',generation:1,after:0});await feed.wake();assert.equal(destroyed,1);assert.equal(reads,1);feed.close();
});

test('host reports restart-needed and rejects a disabled feature before application',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-protocol-features-')),store=new InMemoryStore<Mission>(),server=createWorkbench(store,root,{scheduleIntervalMs:0,protocol:{installed:{min:1,max:2},features:{commands:false,queries:true,feedPush:true}}});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 const send=async(path:string,body:unknown)=>fetch('http://127.0.0.1:'+address.port+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const hello=await send('/protocol/connect',{version:2,requestId:'new-ui',generation:1,supported:{min:2,max:2}});assert.equal(hello.status,426);assert.equal((await hello.json()).payload.state,'restart-needed');
 const rejected=await send('/protocol/request',{version:1,requestId:'blocked',generation:2,kind:'command',path:'/fixture-run',payload:{}});assert.equal(rejected.status,426);assert.equal((await rejected.json()).payload.outcome,'rejected');assert.equal((await store.readEvents(0)).cursor,0);
});
