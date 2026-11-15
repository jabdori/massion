import {createServer} from 'node:net';
import {chmod,writeFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [socket,entryArgument,originArgument]=process.argv.slice(2);
if(!socket)throw new Error('Daemon socket required');
const here=dirname(fileURLToPath(import.meta.url));
// The Tauri host starts the supervisor with the socket only; Electron still passes entry and origin.
const entry=entryArgument??fileURLToPath(new URL('../src/server.ts',import.meta.url));
let origin=originArgument;
if(!origin){
 const {daemonOrigin}=await import('./transport.ts');
 origin=daemonOrigin(process.env.MASSION_DAEMON_ORIGIN??'http://127.0.0.1:8765');
}
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,draining;
let ended;
let restarting=false;

function coreEnded(c){return new Promise(resolve=>{c.once('error',()=>resolve([1,null]));c.once('exit',(code,signal)=>resolve([code,signal]));});}
function spawnCore(){
 const started=spawn(process.execPath,[entry],{env:{...process.env,MASSION_PORT:new URL(origin).port,MASSION_DESKTOP_AUTH_FD:'3'},stdio:['ignore','inherit','inherit','pipe']});
 started.stdio[3].on('error',()=>{});started.stdio[3].end(secret);
 return started;
}
async function stopCore(){
 restarting=true;child.kill('SIGTERM');let timer;
 const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),11000);})]);clearTimeout(timer);
 if(!result){restarting=false;throw new Error('Core did not stop');}
 return result;
}
function startCore(){
 restarting=false;child=spawnCore();ended=coreEnded(child);
 void ended.then(async result=>{if(!draining&&!restarting){await cleanup();process.exit(result[0]??1);}});
}

let servicePromise;
async function clientService(){
 return servicePromise??=(async()=>{
  const {createClientService}=await import('./client-relay.ts');
  const service=createClientService({
   origin,secret,
   htmlCandidates:[process.env.MASSION_DESKTOP_HTML,join(here,'dist','index.html'),join(here,'index.html')].filter(Boolean),
   settingsFile:join(dirname(socket),'notifications.json'),version:await desktopVersion(),stopCore,startCore,
  });
  service.startObserver();
  return service;
 })();
}
async function desktopVersion(){
 for(const candidate of [join(here,'..','package.json'),join(here,'core','package.json')]){
  try{return JSON.parse(await readFile(candidate,'utf8')).version;}catch{}
 }
 throw new Error('Desktop version file missing');
}

const server=createServer({allowHalfOpen:true},client=>{
 let message='',clientMode=false,clientBacklog=Buffer.alloc(0),clientReady=false;client.setTimeout(1000,()=>client.destroy());
 client.on('error',()=>{});
 client.on('data',chunk=>{
  if(clientMode){
   if(clientReady)return;
   clientBacklog=Buffer.concat([clientBacklog,chunk]);
   // The per-line bound (newline included) applies to the incomplete tail; the
   // load window itself stays bounded by one mebibyte of buffered lines.
   const newline=clientBacklog.lastIndexOf(10);
   if((newline>=0?clientBacklog.length-newline-1:clientBacklog.length)>=65536||clientBacklog.length>1048576)client.destroy();
   return;
  }
  message+=chunk;
  const newline=message.indexOf('\n');
  if(newline===-1){if(message.length>32)client.destroy();return;}
  if(message.slice(0,newline)==='client'){
   clientMode=true;client.setTimeout(0);
   const rest=message.slice(newline+1);message='';
   void Promise.resolve(clientService()).then(service=>{service.handle(client,Buffer.concat([Buffer.from(rest),clientBacklog]));clientBacklog=Buffer.alloc(0);clientReady=true;}).catch(()=>{client.write(JSON.stringify({id:'',error:{code:'unavailable',message:'The desktop relay is unavailable'}})+'\n');client.end();});
   return;
  }
  if(message.length>32)client.destroy();
 });
 client.on('end',()=>{
  if(clientMode)return;
  if(message==='status\n'){client.end(JSON.stringify({status:'running',pid:process.pid,origin}));return;}
  if(message==='credentials\n'){client.end(JSON.stringify({status:'running',origin,secret}));return;}
  if(message!=='drain\n'){client.destroy();return;}
  client.setTimeout(0);void drain().then(status=>client.end(JSON.stringify({status})));
 });
});
try{server.listen(socket);await once(server,'listening');}catch(error){if(error.code==='EADDRINUSE')process.exit(0);throw error;}
await chmod(socket,0o600);
await writeFile(socket+'.pid',JSON.stringify({pid:process.pid,startedAt:Date.now()}),{mode:0o600});
const cleanup=async()=>{server.close();await Promise.all([unlink(socket).catch(()=>{}),unlink(socket+'.pid').catch(()=>{})]);};
startCore();
async function drain(){
 if(!draining)draining=(async()=>{
  child.kill('SIGTERM');let timer;
  const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),11000);})]);clearTimeout(timer);
  if(!result){void ended.then(async()=>{await cleanup();process.exit(1);});return 'unsettled';}
  await cleanup();setTimeout(()=>process.exit(result[0]===0?0:1),50);return result[0]===0?'drained':'unsettled';
 })();return draining;
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void drain());
