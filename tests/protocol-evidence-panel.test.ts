import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {harness,reply,selectionField} from './support/workbench-client.ts';
import {rejectedFixture} from './support/rejected-text-fixture.ts';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';
import {createWorkbench} from '../src/server.ts';

for(const rejected of [false,true])test(`independent ${rejected?'rejected':'accepted'} Work reads both verify when replies arrive out of order`,async t=>{
 const f=rejected?await rejectedFixture(t):await lifetimeFixture(t);
 if(!rejected)await f.product.run('mission','fresh','first-evidence',(await f.current()).revision);
 await f.product.admit('mission',{commandId:'second-work',expectedRevision:(await f.current()).revision,workId:'second',title:'Independent evidence',budget:20});
 await f.product.run('mission','second','second-evidence',(await f.current()).revision);
 const server=createWorkbench(f.store,f.root,{artifacts:f.artifacts,scheduleIntervalMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const pending=new Map<string,()=>void>(),endpoint=rejected?'/rejected-artifact?':'/record-artifact?',prefix=rejected?'work-rejected-text-':'work-record-text-';
 const app=harness(async(path,options)=>{const response=await fetch('http://127.0.0.1:'+address.port+path,options),body=await response.json();if(path.includes(endpoint)){const id=new URL(path,'http://fixture').searchParams.get('work')!;await new Promise<void>(resolve=>pending.set(id,resolve));}return reply(body,response.status);},{},undefined,{network:true,fragment:'#mission=mission'});
 await f.until(()=>app.node('sync-notice').hidden&&!!selectionField(app,prefix+'read-second'));
 const read=(id:string)=>selectionField(app,prefix+'read-'+id).fire('click');
 const first=read('fresh');await f.until(()=>pending.has('fresh'));const second=read('second');await f.until(()=>pending.has('second'));
 pending.get('second')!();await second;pending.get('fresh')!();await first;
 for(const id of ['fresh','second']){assert.ok(selectionField(app,prefix+'content-'+id).textContent.length>0);assert.doesNotMatch(selectionField(app,prefix+'status-'+id).textContent,/not verified|Stale protocol/);}
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
