import {createServer,connect} from 'node:net';
import {chmod,writeFile,unlink,mkdir,readdir,readFile,rename,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const [socket,entry,origin,runtimeDirectory]=process.argv.slice(2);
if(!socket||!entry||!origin)throw new Error('Daemon socket, core entry and origin required');
// The managed database runs only from the bundled runtime; MASSION_SURREAL_RPC keeps today's developer path.
const managedDatabase=Boolean(runtimeDirectory)&&!process.env.MASSION_SURREAL_RPC;
const readinessDeadlineMs=30_000,databaseStopMs=10_000;
const runtimeStartCauses=['runtime-damaged','database-start','data-credential','data-version','core-start'];
// If the supervisor dies, the watchdog reaps the database so it cannot keep holding the data folder.
const watchdogScript='while kill -0 "$1" 2>/dev/null; do kill -0 "$2" 2>/dev/null || exit 0; sleep 1; done; kill -9 "$2" 2>/dev/null';
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,database,watchdog,draining,databaseOutput='',currentPassword,state=managedDatabase?'starting':'running',failure;
const scrub=text=>{
 let value=String(text);
 if(currentPassword)value=value.split(currentPassword).join('[redacted]').split(Buffer.from('root:'+currentPassword).toString('base64')).join('[redacted]');
 return value.split(homedir()).join('~').slice(0,400);
};
const databaseTail=()=>scrub(databaseOutput||'the database produced no output');
const startFailure=(cause,detail)=>{const error=new Error(detail);error.causeCode=cause;return error;};
const server=createServer({allowHalfOpen:true},client=>{
 let message='';client.setTimeout(1000,()=>client.destroy());
 client.on('error',()=>{});client.on('data',chunk=>{message+=chunk;if(message.length>32)client.destroy();});
 client.on('end',()=>{
  if(message==='status\n'){
   if(failure){client.end(JSON.stringify({status:'failed',pid:process.pid,origin,...failure}));return;}
   client.end(JSON.stringify({status:state,pid:process.pid,origin}));return;
  }
  if(message==='credentials\n'){
   if(failure||state!=='running'){client.end(JSON.stringify({status:failure?'failed':state,origin}));return;}
   client.end(JSON.stringify({status:'running',origin,secret}));return;
  }
  if(message!=='drain\n'){client.destroy();return;}
  client.setTimeout(0);void drain().then(status=>client.end(JSON.stringify({status})));
 });
});
try{server.listen(socket);await once(server,'listening');}catch(error){if(error.code==='EADDRINUSE')process.exit(0);throw error;}
await chmod(socket,0o600);
await writeFile(socket+'.pid',JSON.stringify({pid:process.pid,startedAt:Date.now()}),{mode:0o600});
const cleanup=async()=>{server.close();await Promise.all([unlink(socket).catch(()=>{}),unlink(socket+'.pid').catch(()=>{})]);};
let coreSettled;const ended=new Promise(resolve=>{coreSettled=resolve;});
function spawnCore(options){
 const environment={...process.env,MASSION_PORT:new URL(origin).port,MASSION_DESKTOP_AUTH_FD:'3'};
 delete environment.SURREAL_PASS;delete environment.SURREAL_USER;
 if(options?.databaseEndpoint){environment.MASSION_SURREAL_RPC=options.databaseEndpoint+'/rpc';environment.MASSION_SURREAL_AUTH_FD='4';}
 child=spawn(process.execPath,[entry],{env:environment,stdio:['ignore','inherit','inherit','pipe',...options?.databaseEndpoint?['pipe']:[]]});
 child.stdio[3].on('error',()=>{});child.stdio[3].end(secret);
 if(options?.databaseEndpoint){child.stdio[4].on('error',()=>{});child.stdio[4].end(options.password);}
 child.once('error',()=>coreSettled([1,null]));child.once('exit',(code)=>coreSettled([code,null]));
}
async function stopDatabase(){
 if(!database)return true;
 watchdog?.kill('SIGKILL');
 if(database.exitCode!==null||database.signalCode)return true;
 const exited=new Promise(resolve=>database.once('exit',()=>resolve(true)));
 database.kill('SIGTERM');
 if(await Promise.race([exited,delay(databaseStopMs).then(()=>null)]))return true;
 database.kill('SIGKILL');
 return Boolean(await Promise.race([exited,delay(5000).then(()=>false)]));
}
async function drain(){
 if(!draining)draining=(async()=>{
  let unsettled=false;
  if(child){
   child.kill('SIGTERM');let timer;
   const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),11000);})]);clearTimeout(timer);
   if(!result){void ended.then(async()=>{await stopDatabase();await cleanup();process.exit(1);});return 'unsettled';}
   if(result[0]!==0&&!failure)unsettled=true;
  }
  if(!await stopDatabase())unsettled=true;
  await cleanup();setTimeout(()=>process.exit(unsettled?1:0),50);
  return unsettled?'unsettled':'drained';
 })();return draining;
}
async function sha256(file){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);
 return hash.digest('hex');
}
async function writeAtomic(file,content){
 const temporary=file+'.tmp-'+process.pid;
 await writeFile(temporary,content,{mode:0o600});
 await rename(temporary,file);
}
async function prepareData(bundledVersion){
 const dataDirectory=resolve('database'),temporaryDirectory=resolve('db-tmp');
 const versionPath=join(dataDirectory,'version'),passwordPath=join(dataDirectory,'password');
 let recorded;
 try{recorded=JSON.parse(await readFile(versionPath,'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw startFailure('data-version','the data version file is unreadable: '+scrub(versionPath));}
 if(recorded!==undefined){
  if(!recorded||typeof recorded!=='object'||recorded.format!==1||recorded.surreal!==bundledVersion)
   throw startFailure('data-version','data was created by SurrealDB '+JSON.stringify(recorded?.surreal??'an unknown version')+', the bundle has '+bundledVersion);
  let fileStat;try{fileStat=await stat(passwordPath);}catch{throw startFailure('data-credential','the database password file is missing');}
  if(!fileStat.isFile()||(fileStat.mode&0o777)!==0o600)throw startFailure('data-credential','the database password file mode is '+(fileStat.mode&0o777).toString(8));
  let password;try{password=await readFile(passwordPath,'utf8');}catch{throw startFailure('data-credential','the database password file is unreadable');}
  if(!/^[a-f0-9]{64}$/.test(password))throw startFailure('data-credential','the database password file is invalid');
  return {password,created:false};
 }
 let entries=[];try{entries=await readdir(dataDirectory);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(entries.length)throw startFailure('data-version','existing data has no version record: '+scrub(dataDirectory));
 const password=randomBytes(32).toString('hex');
 await mkdir(dataDirectory,{recursive:true,mode:0o700});
 await mkdir(temporaryDirectory,{recursive:true,mode:0o700});
 await writeAtomic(passwordPath,password);
 await writeAtomic(versionPath,JSON.stringify({surreal:bundledVersion,format:1})+'\n');
 return {password,created:true};
}
const freePort=()=>new Promise((resolvePromise,reject)=>{
 const probe=createServer();probe.once('error',reject);
 probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolvePromise(port));});
});
const canConnect=port=>new Promise(resolvePromise=>{
 const probe=connect(port,'127.0.0.1');
 probe.once('connect',()=>{probe.destroy();resolvePromise(true);});
 probe.once('error',()=>resolvePromise(false));
});
async function waitForDatabase(port,authorization){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(database.exitCode!==null||database.signalCode)throw startFailure('database-start','the database process exited: '+databaseTail());
  try{const response=await fetch('http://127.0.0.1:'+port+'/health',{headers:{authorization},signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}
  if(Date.now()>deadline)throw startFailure('database-start','the database was not ready within '+(readinessDeadlineMs/1000)+'s: '+databaseTail());
  await delay(250);
 }
}
async function waitForCore(){
 const port=Number(new URL(origin).port),deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(child.exitCode!==null||child.signalCode)throw startFailure('core-start','the core process exited during startup');
  if(await canConnect(port))return;
  if(Date.now()>deadline)throw startFailure('core-start','the core was not listening within '+(readinessDeadlineMs/1000)+'s');
  await delay(250);
 }
}
async function startManagedRuntime(){
 let manifest;
 try{manifest=JSON.parse(await readFile(join(runtimeDirectory,'manifest.json'),'utf8'));}
 catch{throw startFailure('runtime-damaged','runtime manifest is missing or unreadable: '+scrub(runtimeDirectory));}
 const pin=manifest?.surreal;
 if(!pin||typeof pin.sha256!=='string'||typeof pin.version!=='string')throw startFailure('runtime-damaged','runtime manifest has no valid SurrealDB entry');
 const surrealPath=join(runtimeDirectory,'surreal');
 let actual;
 try{actual=await sha256(surrealPath);}catch{throw startFailure('runtime-damaged','bundled SurrealDB is missing or unreadable: '+scrub(surrealPath));}
 if(actual!==pin.sha256)throw startFailure('runtime-damaged','bundled SurrealDB SHA-256 mismatch for '+scrub(surrealPath)+': expected '+pin.sha256.slice(0,16)+', found '+actual.slice(0,16));
 const {password,created}=await prepareData(pin.version);
 currentPassword=password;
 const port=await freePort();
 database=spawn(surrealPath,['start','surrealkv://'+resolve('database'),'--bind','127.0.0.1:'+port,'--no-banner','--log','info','--temporary-directory',resolve('db-tmp'),'--default-namespace','massion','--default-database','massion','--deny-net','--deny-scripting'],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(created?{SURREAL_USER:'root',SURREAL_PASS:password}:{})},stdio:['ignore','pipe','pipe']});
 database.once('error',()=>{});
 try{await once(database,'spawn');}catch(error){throw startFailure('database-start','the database process could not start: '+scrub(error.message));}
 for(const stream of [database.stdout,database.stderr])stream?.on('data',chunk=>{databaseOutput=(databaseOutput+chunk).slice(-2000);});
 watchdog=spawn('/bin/sh',['-c',watchdogScript,'massion-db-watchdog',String(process.pid),String(database.pid)],{stdio:'ignore'});
 await waitForDatabase(port,'Basic '+Buffer.from('root:'+password).toString('base64'));
 if(draining)throw startFailure('core-start','drain requested during startup');
 spawnCore({databaseEndpoint:'http://127.0.0.1:'+port,password});
 await waitForCore();
 state='running';
}
if(managedDatabase){
 void startManagedRuntime().then(()=>{
  void ended.then(async result=>{if(!draining){await stopDatabase();await cleanup();process.exit(result[0]??1);}});
 },async error=>{
  if(draining)return;
  const stopped=[];
  if(child)stopped.push(new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)resolve();else child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},databaseStopMs);}));
  stopped.push(stopDatabase());
  await Promise.all(stopped);
  failure={cause:runtimeStartCauses.includes(error.causeCode)?error.causeCode:'core-start',detail:scrub(error.message)};
  setTimeout(()=>{void drain().catch(()=>process.exit(1));},5000);
 });
}else{
 spawnCore();
 void ended.then(async result=>{if(!draining){await cleanup();process.exit(result[0]??1);}});
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void drain());

