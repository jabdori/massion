import {createServer} from 'node:net';
import {chmod,writeFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';

const [socket,entry,origin]=process.argv.slice(2);
if(!socket||!entry||!origin)throw new Error('Daemon socket, core entry and origin required');
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,draining;
const server=createServer({allowHalfOpen:true},client=>{
 let message='';client.setTimeout(1000,()=>client.destroy());
 client.on('error',()=>{});client.on('data',chunk=>{message+=chunk;if(message.length>32)client.destroy();});
 client.on('end',()=>{
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
child=spawn(process.execPath,[entry],{env:{...process.env,MASSION_PORT:new URL(origin).port,MASSION_DESKTOP_AUTH_FD:'3'},stdio:['ignore','inherit','inherit','pipe']});
child.stdio[3].on('error',()=>{});child.stdio[3].end(secret);
const ended=new Promise(resolve=>{child.once('error',()=>resolve([1,null]));child.once('exit',(code,signal)=>resolve([code,signal]));});
async function drain(){
 if(!draining)draining=(async()=>{
  child.kill('SIGTERM');let timer;
  const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),11000);})]);clearTimeout(timer);
  if(!result){void ended.then(async()=>{await cleanup();process.exit(1);});return 'unsettled';}
  await cleanup();setTimeout(()=>process.exit(result[0]===0?0:1),50);return result[0]===0?'drained':'unsettled';
 })();return draining;
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void drain());
void ended.then(async result=>{if(!draining){await cleanup();process.exit(result[0]??1);}});
