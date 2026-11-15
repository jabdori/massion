#!/usr/bin/env node
// Owns the database child. The daemon speaks to it over stdin: the first line is the bootstrap
// password (never an environment variable here); the end of that pipe — daemon exit, however it
// died — means stop the database (SIGTERM, bounded wait, SIGKILL) and exit.
import {spawn} from 'node:child_process';
import {writeFile,rename,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const [binary,dataDirectory,temporaryDirectory,port,pidFile,bootstrap]=process.argv.slice(2);
if(!binary||!dataDirectory||!temporaryDirectory||!port||!pidFile)throw new Error('Keeper requires the database binary, folders, port and pid file');
// When the daemon dies the report pipe breaks first; never crash before the database is stopped and cleaned up.
process.stdout.on('error',()=>{});
process.stderr.on('error',()=>{});
const emit=value=>new Promise(resolve=>{
 if(process.stdout.destroyed||!process.stdout.writable){resolve();return;}
 process.stdout.write(JSON.stringify(value)+'\n',()=>resolve());
});
const keeperStartedAt=Math.round(performance.timeOrigin);
async function writePidFile(record){
 const temporary=pidFile+'.tmp-'+process.pid;
 await writeFile(temporary,JSON.stringify(record),{mode:0o600});
 await rename(temporary,pidFile);
}
let stdinEnded=false;
const password=await new Promise(resolve=>{
 let buffer='',settled=false;
 // null means end-of-file before the line was complete; a partial line is never a password.
 const finish=()=>{if(settled)return;const end=buffer.indexOf('\n');if(end>=0||stdinEnded){settled=true;process.stdin.pause();resolve(end>=0?buffer.slice(0,end):null);}};
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{buffer+=chunk;finish();});
 process.stdin.on('end',()=>{stdinEnded=true;finish();});
});
// Keep stdin flowing so the daemon's death is observed as end-of-file.
process.stdin.on('data',()=>{});
// The first line must be complete and of the generated password's exact shape; anything else starts nothing.
const expectedPassword=bootstrap==='1'?/^[a-f0-9]{64}$/:/^$/;
if(password===null||!expectedPassword.test(password))process.exit(9);
process.stdin.resume();
let stoppingBeforeSpawn=false;
const preSpawnStop=()=>{stoppingBeforeSpawn=true;};
process.stdin.once('end',preSpawnStop);
process.stdin.once('close',preSpawnStop);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,preSpawnStop);
if(stdinEnded||stoppingBeforeSpawn)process.exit(0);
await writePidFile({format:2,keeper:{pid:process.pid,startedAt:keeperStartedAt},database:null});
if(stdinEnded||stoppingBeforeSpawn){await unlink(pidFile).catch(()=>{});process.exit(0);}
// Await the write callback so a missing spawning line proves no child was ever started.
await emit({spawning:true});
if(stdinEnded||stoppingBeforeSpawn){
 await emit({spawnFailed:true});
 await unlink(pidFile).catch(()=>{});
 process.exit(0);
}
process.stdin.off('end',preSpawnStop);
process.stdin.off('close',preSpawnStop);
for(const signal of ['SIGTERM','SIGINT'])process.off(signal,preSpawnStop);

const database=spawn(binary,['start','surrealkv://'+dataDirectory,'--bind','127.0.0.1:'+port,'--no-banner','--log','info','--temporary-directory',temporaryDirectory,'--default-namespace','massion','--default-database','massion','--deny-net','--deny-scripting'],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(bootstrap==='1'&&password?{SURREAL_USER:'root',SURREAL_PASS:password}:{})},stdio:['ignore','pipe','pipe']});
const databaseStartedAt=Date.now();
if(database.pid!==undefined)void emit({spawn:database.pid,startedAt:databaseStartedAt});
let pidWritePromise=Promise.resolve();
database.once('spawn',()=>{
 if(database.pid===undefined)return;
 pidWritePromise=writePidFile({
  format:2,
  keeper:{pid:process.pid,startedAt:keeperStartedAt},
  database:{pid:database.pid,startedAt:databaseStartedAt,binary}
 }).catch(()=>{});
});
let exitObserved=false,spawnFailed=false,exitEmitted=Promise.resolve();
const databaseExit=new Promise(resolve=>{
 database.once('exit',(code,signal)=>{
  exitObserved=true;
  exitEmitted=emit({exited:{code,signal}});
  resolve(true);
 });
 database.once('error',()=>{
  if(database.pid===undefined){
   spawnFailed=true;
   exitEmitted=emit({spawnFailed:true});
   resolve(false);
  }
 });
});
for(const stream of [database.stdout,database.stderr]){
 if(!stream)continue;
 let pending='';
 stream.setEncoding('utf8');
 stream.on('data',chunk=>{
  pending+=chunk;
  for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){
   const line=pending.slice(0,end);pending=pending.slice(end+1);
   void emit({log:line});
   const started=line.match(/Started web server on (\S+)/);
   if(started)void emit({bound:started[1]});
  }
 });
}
let shuttingDown=false;
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;
 if(!exitObserved&&!spawnFailed&&database.exitCode===null&&database.signalCode===null){
  database.kill('SIGTERM');
  if(!await Promise.race([databaseExit,delay(10_000).then(()=>false)])){
   database.kill('SIGKILL');
   await Promise.race([databaseExit,delay(5000).then(()=>false)]);
  }
 }
 await pidWritePromise;
 if(exitObserved||spawnFailed){
  await exitEmitted;
  await unlink(pidFile).catch(()=>{});
  process.exit(0);
 }
 // Exit never observed: keep the pid file so the next start knows the child may still hold the data folder.
 await emit({unconfirmed:database.pid??null});
 process.exit(7);
}
process.stdin.once('end',()=>void shutdown());
process.stdin.once('close',()=>void shutdown());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void shutdown());
void databaseExit.then(()=>void shutdown());
if(stdinEnded||stoppingBeforeSpawn)void shutdown();
