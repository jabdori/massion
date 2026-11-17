import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer as netServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {control} from '../daemon.ts';

async function freePort(){
 const probe=netServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;probe.close();return port;
}

// Parallel test files race for free ports; a lost race kills the fake core at
// listen and the supervisor with it, so try the next port instead of failing.
async function startSupervisor(t:any,socket:string,state:string,core:string){
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 for(let attempt=0;attempt<3;attempt++){
  const origin='http://127.0.0.1:'+await freePort();
  const child=spawn(process.execPath,[runner,socket,core,origin],{env:{...process.env,MASSION_FEED_STATE:state},stdio:['ignore','ignore','inherit']});
  let alive=false;
  for(let n=0;n<50;n++){
   try{await control(socket,'status');alive=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
  }
  if(alive){
   t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
   try{
    // The core's own start record is the only proof THIS core - not whichever
    // process won the documented free-port race and answered the probe - owns
    // the port; a core that lost its port never records a start, so the helper
    // falls through to the next port like any other dead supervisor.
    await t.waitFor(()=>readFile(state,'utf8').then(text=>text.includes('"start"'),()=>false),{timeout:15000});
    // An HTTP-level probe (any response, even 401 from the auth guard) then
    // proves the serving loop itself answers before the test's first request.
    await t.waitFor(()=>fetch(origin+'/').then(()=>true,()=>false),{timeout:15000});
    return;
   }catch{}
   if(child.exitCode===null)child.kill('SIGKILL');
   await once(child,'exit').catch(()=>{});
   await unlink(socket).catch(()=>{});
   continue;
  }
  if(child.exitCode===null)child.kill('SIGKILL');
  await once(child,'exit').catch(()=>{});
 }
 throw new Error('the supervisor never answered on three free ports');
}

test('one subscription id travels the whole path and close really unsubscribes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-fixture-')),socket=join(root,'daemon.sock'),state=join(root,'state.log');
 const fixture=new URL('fixtures/feed-core.mjs',import.meta.url).pathname;
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 await startSupervisor(t,socket,state,fixture);

 const client=connect(socket);
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 client.write('client\n');
 await new Promise(resolve=>setTimeout(resolve,150));
 const subscribe=(id:string)=>client.write(JSON.stringify({id,method:'GET',path:'/protocol/events?version=1&requestId=r&generation=1&after=0'})+'\n');
 // The full suite runs the files concurrently beside the real-database tests; the
 // fake core's socket teardown can lag seconds under that load, so the budgets here
 // are generous rather than tight.
 const find=async(match:(value:any)=>boolean,timeoutMs=15000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   for(const line of lines){const value=JSON.parse(line);if(match(value))return value;}
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw new Error('missing line; got:\n'+lines.join('\n'));
 };

 subscribe('s-1');
 assert.equal((await find(value=>value.id==='s-1')).status,200);
 const message=await find(value=>value.event==='message'&&value.subscription==='s-1');
 assert.equal(typeof message.lastEventId,'string');
 assert.equal(message.data,'{"connected":true}');
 client.write(JSON.stringify({event:'close',subscription:'s-1'})+'\n');
 await t.waitFor(()=>readFile(state,'utf8').then(text=>{assert.match(text,/"closed"/);return text;}),{timeout:15000});

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
 const fixture=new URL('fixtures/feed-core.mjs',import.meta.url).pathname;
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 await startSupervisor(t,socket,state,fixture);
 // The merged supervisor's boot imports delay the first core start; a restart sent
 // before the first core listens would kill it mid-boot and undercount the starts.
 await t.waitFor(()=>readFile(state,'utf8').then(text=>{assert.match(text,/"start"/);return text;}),{timeout:15000});
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
