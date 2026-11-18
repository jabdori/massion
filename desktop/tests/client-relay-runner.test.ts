import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer as netServer} from 'node:net';
import {once} from 'node:events';
import {access,mkdtemp,rm,readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork,spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {tempRoot} from '../../tests/support/temp-root.ts';
import {control} from '../daemon.ts';

const runnerPath=()=>new URL('../daemon-runner.mjs',import.meta.url).pathname;
async function freePort(){
 const probe=netServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as {port:number}).port;probe.close();return port;
}
// An HTTP-level probe (any response proves the Node.js event loop is serving),
// not just a TCP SYN to the kernel's listen backlog.
const coreListening=async(origin:string)=>{await fetch(origin+'/');};

function startHeldSupervisor(t:TestContext,socket:string,core:string,env:NodeJS.ProcessEnv){
 const preload=new URL('fixtures/hold-supervisor-startup.mjs',import.meta.url);
 const child=fork(runnerPath(),[socket,core,'http://127.0.0.1:1'],{
  execArgv:['--import',preload.href],env:{...process.env,...env},stdio:['ignore','ignore','inherit','ipc'],
 });
 const exited=once(child,'exit');
 t.after(async()=>{child.kill('SIGKILL');await exited;});
 return {child,exited};
}

test('the supervisor serves the document while each startup file operation is held',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'relay-init-')),socket=join(root,'daemon.sock'),document=join(root,'app.html');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const html='<html><body>startup fixture</body></html>';
 await writeFile(document,html);
 // Keep the PID write held until exit so the core cannot start.
 const {child}=startHeldSupervisor(t,socket,'unused-core.mjs',{MASSION_DESKTOP_HTML:document});
 let held=once(child,'message',{signal:t.signal});
 const replies=[];
 for(const operation of ['chmod','writeFile']){
  const [pending]=await held;
  assert.equal(pending,operation);
  const client=connect(socket);
  const closed=once(client,'close');
  t.after(()=>client.destroy());
  const lines=createInterface({input:client});
  client.write('client\n'+JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
  try{
   for await(const line of lines){
    const reply=JSON.parse(line);
    if(reply.id===''&&reply.error?.code==='unavailable'){
     await closed;
     t.diagnostic(`${operation} held: ${line}; socket: closed`);
    }
    replies.push(reply);
    break;
   }
  }finally{client.destroy();}
  if(operation==='chmod'){
   held=once(child,'message',{signal:t.signal});
   child.send('release');
  }
 }
 assert.deepEqual(replies.map(reply=>({id:reply.id,status:reply.status,body:reply.body})),[
  {id:'doc',status:200,body:html},{id:'doc',status:200,body:html},
 ]);
});

for(const operation of ['chmod','writeFile']){
 test(`drain during held ${operation} leaves no core or PID file`,{timeout:10000},async t=>{
  const root=await mkdtemp(join(tempRoot(),'relay-drain-')),socket=join(root,'daemon.sock'),core=join(root,'core.mjs');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(core,'setTimeout(()=>{},5000);process.on("SIGTERM",()=>process.exit(0));');
  const {child,exited}=startHeldSupervisor(t,socket,core,{MASSION_TEST_DRAIN_HOLD:operation});
  const [held]=await once(child,'message',{signal:t.signal});
  assert.equal(held,operation);
  const received=once(child,'message',{signal:t.signal}).then(([event])=>event);
  const reply=control(socket,'drain').then(value=>value.status,(error:Error)=>error.message);
  assert.equal(await Promise.race([received,reply]),'drain received');
  child.send('release',()=>{});

  assert.equal(await reply,'drained');
  await assert.rejects(access(socket+'.pid'),{code:'ENOENT'});
  const processes=spawnSync('ps',['-ax','-o','command='],{encoding:'utf8'});
  assert.equal(processes.status,0);
  assert.ok(!processes.stdout.split('\n').some(command=>command.endsWith(' '+core)),'no fixture core may survive drain');
  assert.deepEqual(await exited,[0,null]);
  await assert.rejects(access(socket+'.pid'),{code:'ENOENT'});
 });
}

test('the real supervisor serves the client connection kind beside the one-shot commands',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-runner-')),socket=join(root,'daemon.sock'),document=join(root,'app.html'),core=join(root,'core.mjs');
 const html='<html><body>fixture</body></html>';
 await writeFile(document,html);
 await writeFile(core,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const child=spawn(process.execPath,[runnerPath(),socket,core,'http://127.0.0.1:8799'],{env:{...process.env,MASSION_DESKTOP_HTML:document},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<50;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const status=await control(socket,'status');
 assert.equal(status.status,'running');assert.ok(status.pid);

 const client=connect(socket);
 const connectedAt=Date.now();
 const socketEvents:string[]=[];
 client.on('close',()=>socketEvents.push('close at +'+(Date.now()-connectedAt)+'ms'));
 client.on('error',error=>socketEvents.push('error '+(error as NodeJS.ErrnoException).code+' at +'+(Date.now()-connectedAt)+'ms'));
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 client.write('client\n');
 client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 client.write(JSON.stringify({id:'no',method:'GET',path:'/health'})+'\n');
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&lines.length<2)await new Promise(resolve=>setTimeout(resolve,20));
 const replies=lines.map(line=>JSON.parse(line));
 const served=replies.find(value=>value.id==='doc'),refused=replies.find(value=>value.id==='no');
 // Ids and statuses only: never bodies, headers or paths, so the failure
 // message cannot leak a secret or an absolute home path.
 const seen='no reply within '+(Date.now()-connectedAt)+'ms; lines: '
  +JSON.stringify(replies.map(value=>({id:value.id,status:value.status,error:value.error?.code})))
  +(socketEvents.length?'; socket: '+socketEvents.join(', '):'; socket: open');
 assert.ok(served,'the document reply never arrived; '+seen);
 assert.ok(refused,'the health reply never arrived; '+seen);
 assert.equal(served.status,200);assert.equal(served.body,html);
 assert.match(served.headers['Content-Security-Policy'],/connect-src 'self' ipc: http:\/\/ipc\.localhost/);
 assert.equal(refused.error.code,'path');
 assert.equal((await control(socket,'status')).pid,status.pid,'the one-shot commands still answer while a client is attached');
 client.destroy();
});

test('data buffered while the relay initialises is bounded in bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-backlog-')),socket=join(root,'daemon.sock'),document=join(root,'app.html'),core=join(root,'core.mjs');
 await writeFile(document,'<html>ok</html>');
 await writeFile(core,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[runner,socket,core,'http://127.0.0.1:8798'],{env:{...process.env,MASSION_DESKTOP_HTML:document},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<50;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const client=connect(socket);
 client.on('error',()=>{});
 const closed=new Promise(resolve=>client.once('close',resolve));
 const payload='가'.repeat(23470); // 23,470 UTF-16 units but 70,410 UTF-8 bytes, no newline
 client.write('client\n'+payload);
 await closed;
});

test('the default development core entry resolves inside the repository',async()=>{
 const source=await readFile(new URL('../daemon-runner.mjs',import.meta.url),'utf8');
 const match=source.match(/const entry=entryArgument\?\?fileURLToPath\(new URL\('([^']+)',import\.meta\.url\)\)/);
 assert.ok(match,'the runner must derive a default core entry');
 await access(new URL(match[1]!,new URL('../daemon-runner.mjs',import.meta.url)));
});

test('a request split inside a Korean character across the first and second chunk arrives intact',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-split-')),socket=join(root,'daemon.sock'),state=join(root,'state.log');
 const fixture=new URL('fixtures/feed-core.mjs',import.meta.url).pathname;
 const origin='http://127.0.0.1:'+await freePort();
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const child=spawn(process.execPath,[runnerPath(),socket,fixture,origin],{env:{...process.env,MASSION_FEED_STATE:state},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<50;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 // The core's own start record proves this core - not a free-port race winner
 // that would answer the probe with a 401 - owns the port before any request.
 await t.waitFor(async()=>{assert.match(await readFile(state,'utf8'),/"start"/);},{timeout:15000});
 // The supervisor answers status before the core binds its port; wait until the
 // origin port actually accepts a TCP connection so the request cannot race it.
 await t.waitFor(()=>coreListening(origin),{timeout:15000});
 // The relay service loads on this connection and its observer starts querying the
 // core at once; give the freshly-started core the same settling moment the fixture
 // e2e gives it before racing a request through the same young listener.
 await new Promise(resolve=>setTimeout(resolve,300));

 const client=connect(socket);
 client.on('error',()=>{});
 const lines:string[]=[];let buffer=Buffer.alloc(0);
 client.on('data',(chunk:Buffer)=>{
  buffer=Buffer.concat([buffer,chunk]);let index;
  while((index=buffer.indexOf(10))>=0){const line=buffer.subarray(0,index).toString('utf8');buffer=buffer.subarray(index+1);if(line)lines.push(line);}
 });
 const request=Buffer.from(JSON.stringify({id:'split',method:'POST',path:'/protocol/request',body:JSON.stringify({kind:'query',path:'/assistant/works',tag:'가'})}));
 const tagAt=request.indexOf(Buffer.from('가'));
 const boundary=tagAt+1; // inside the three-byte character
 client.write(Buffer.concat([Buffer.from('client\n'),request.subarray(0,boundary)]));
 await new Promise(resolve=>setImmediate(resolve));
 client.write(Buffer.concat([request.subarray(boundary),Buffer.from('\n')]));
 const deadline=Date.now()+8000;
 while(Date.now()<deadline&&!lines.some(line=>line.includes('"id":"split"')))await new Promise(resolve=>setTimeout(resolve,20));
 const reply=lines.map(line=>JSON.parse(line)).find(value=>value.id==='split');
 assert.ok(reply,'the split request produced a reply');
 assert.match(reply.body,/"tag":"가"/,'the Korean character survives the supervisor boundary');
 assert.doesNotMatch(reply.body,/\uFFFD/,'no replacement characters may appear');
 client.destroy();
});

test('a start without an explicit core argument spawns the repository core',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-default-')),socket=join(root,'daemon.sock');
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MASSION_')));
 // Give the core a database URL so it loads the whole module graph instead of exiting
 // instantly on the missing-variable check; port 1 never answers, so the core stays
 // alive through the module load and the command line is observable on slow runners.
 environment.MASSION_SURREAL_RPC='ws://127.0.0.1:1';
 const child=spawn(process.execPath,[runnerPath(),socket],{cwd:root,env:environment,stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 // The default core loads the whole src/server.ts module graph before exiting over the
 // missing database setting, so the pid record appears well before the core dies.
 let core:number|undefined;
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){
  try{
   const record=JSON.parse(await readFile(socket+'.pid','utf8'));
   if(typeof record.core==='number')core=record.core;
  }catch{}
  if(core!==undefined){
   const command=String(spawnSync('ps',['-p',String(core),'-o','command=']).stdout||'').trim();
   if(command.includes('server.ts')){
    assert.match(command,/src\/server\.ts$/,'the default entry is the repository core');
    return;
   }
  }
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.fail('the default core was never observed running src/server.ts');
});
