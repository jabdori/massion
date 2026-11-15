#!/usr/bin/env node
// Owns the database child. The daemon speaks to it over stdin: the first line is the bootstrap
// password (never an environment variable here); the end of that pipe — daemon exit, however it
// died — means stop the database (SIGTERM, bounded wait, SIGKILL) and exit.
import {spawn} from 'node:child_process';
import {writeFile,unlink} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

const [binary,dataDirectory,temporaryDirectory,port,pidFile,bootstrap]=process.argv.slice(2);
if(!binary||!dataDirectory||!temporaryDirectory||!port||!pidFile)throw new Error('Keeper requires the database binary, folders, port and pid file');
// When the daemon dies the report pipe breaks first; never crash before the database is stopped and cleaned up.
process.stdout.on('error',()=>{});
process.stderr.on('error',()=>{});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let stdinEnded=false;
const password=await new Promise(resolve=>{
 let buffer='',settled=false;
 const finish=()=>{if(settled)return;const end=buffer.indexOf('\n');if(end>=0||stdinEnded){settled=true;resolve(end>=0?buffer.slice(0,end):buffer);}};
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{buffer+=chunk;finish();});
 process.stdin.on('end',()=>{stdinEnded=true;finish();});
});
// Keep stdin flowing so the daemon's death is observed as end-of-file.
process.stdin.on('data',()=>{});
if(password===''&&stdinEnded)process.exit(0);
await writeFile(pidFile,JSON.stringify({pid:process.pid,startedAt:Date.now()}),{mode:0o600});
const database=spawn(binary,['start','surrealkv://'+dataDirectory,'--bind','127.0.0.1:'+port,'--no-banner','--log','info','--temporary-directory',temporaryDirectory,'--default-namespace','massion','--default-database','massion','--deny-net','--deny-scripting'],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(bootstrap==='1'&&password?{SURREAL_USER:'root',SURREAL_PASS:password}:{})},stdio:['ignore','pipe','pipe']});
emit({spawn:database.pid});
const databaseExit=new Promise(resolve=>{database.once('exit',code=>resolve(code));database.once('error',()=>resolve(null));});
for(const stream of [database.stdout,database.stderr]){
 let pending='';
 stream.setEncoding('utf8');
 stream.on('data',chunk=>{
  pending+=chunk;
  for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){
   const line=pending.slice(0,end);pending=pending.slice(end+1);
   emit({log:line});
   const started=line.match(/Started web server on (\S+)/);
   if(started)emit({bound:started[1]});
  }
 });
}
let shuttingDown=false;
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;
 if(database.exitCode===null&&database.signalCode===null){
  database.kill('SIGTERM');
  const exited=new Promise(resolve=>database.once('exit',()=>resolve(true)));
  if(!await Promise.race([exited,delay(10_000).then(()=>false)])){
   database.kill('SIGKILL');
   await Promise.race([exited,delay(5000).then(()=>false)]);
  }
 }
 await unlink(pidFile).catch(()=>{});
 emit({exit:database.exitCode});
 process.exit(0);
}
process.stdin.once('end',()=>void shutdown());
process.stdin.once('close',()=>void shutdown());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void shutdown());
void databaseExit.then(()=>void shutdown());
if(stdinEnded)void shutdown();

