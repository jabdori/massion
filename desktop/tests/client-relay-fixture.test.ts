import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer as netServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {control} from '../daemon.ts';

async function freePort(){
 const probe=netServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;probe.close();return port;
}

test('one subscription id travels the whole path and close really unsubscribes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-fixture-')),socket=join(root,'daemon.sock'),state=join(root,'state.log');
 const fixture=new URL('fixtures/feed-core.mjs',import.meta.url).pathname,origin='http://127.0.0.1:'+await freePort();
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[runner,socket,fixture,origin],{env:{...process.env,MASSION_FEED_STATE:state},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<80;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}

 const client=connect(socket);
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 client.write('client\n');
 await new Promise(resolve=>setTimeout(resolve,150));
 const subscribe=(id:string)=>client.write(JSON.stringify({id,method:'GET',path:'/protocol/events?version=1&requestId=r&generation=1&after=0'})+'\n');
 const find=async(match:(value:any)=>boolean,timeoutMs=5000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   for(const line of lines){const value=JSON.parse(line);if(match(value))return value;}
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw new Error('missing line; got:\n'+lines.join('\n'));
 };

 subscribe('s-1');
 assert.equal((await find((value:any)=>value.id==='s-1')).status,200);
 const message=await find((value:any)=>value.event==='message'&&value.subscription==='s-1');
 assert.equal(typeof message.lastEventId,'string');
 assert.equal(message.data,'{"connected":true}');
 client.write(JSON.stringify({event:'close',subscription:'s-1'})+'\n');
 await t.waitFor(()=>readFile(state,'utf8').then(text=>{assert.match(text,/"closed"/);return text;}),{timeout:5000});

 for(const id of ['s-a','s-b','s-c','s-d','s-e']){
  subscribe(id);
  const reply=await find((value:any)=>value.id===id);
  assert.notEqual(reply.error?.code,'busy','five subscribe/close cycles must not hit the four-subscription limit');
  client.write(JSON.stringify({event:'close',subscription:id})+'\n');
 }
 client.destroy();
});

test('a settings restart stops and restarts the core while the same supervisor keeps serving',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-restart-')),socket=join(root,'daemon.sock'),state=join(root,'state.log');
 const fixture=new URL('fixtures/feed-core.mjs',import.meta.url).pathname,origin='http://127.0.0.1:'+await freePort();
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[runner,socket,fixture,origin],{env:{...process.env,MASSION_FEED_STATE:state},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<80;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const before=await control(socket,'status');

 const client=connect(socket);
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 client.write('client\n'+JSON.stringify({id:'r1',method:'POST',path:'/desktop/restart'})+'\n');
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  const reply=lines.map(line=>JSON.parse(line)).find(value=>value.id==='r1');
  if(reply){
   assert.equal(reply.error,undefined);
   assert.equal(JSON.parse(reply.body).restartStatus,'idle');
   break;
  }
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 await t.waitFor(async()=>{
  const text=await readFile(state,'utf8');
  assert.equal((text.match(/"start"/g)??[]).length>=2,true,'the core restarted');
  const after=await control(socket,'status');
  assert.equal(after.pid,before.pid,'the same supervisor serves again');
 },{timeout:10000});
 client.destroy();
});
