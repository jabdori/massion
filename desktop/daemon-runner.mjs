import {createServer,connect} from 'node:net';
import {chmod,writeFile,unlink,mkdir,opendir,readFile,rename,stat,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn,execFile as execFileCallback} from 'node:child_process';
import {once} from 'node:events';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {decideDatabaseStart} from './start-decision.ts';

const [socket,entry,origin,runtimeDirectory]=process.argv.slice(2);
if(!socket||!entry||!origin)throw new Error('Daemon socket, core entry and origin required');
// The managed database runs only from the bundled runtime; MASSION_SURREAL_RPC keeps today's developer path.
const managedDatabase=Boolean(runtimeDirectory)&&!process.env.MASSION_SURREAL_RPC;
const readinessDeadlineMs=30_000,bootstrapDeadlineMs=10_000;
// Shutdown budget: core SIGTERM 11 s + core SIGKILL 5 s + keeper 16 s + direct database stop 15 s
// = 48 s total; the drain control timeout in daemon.ts exceeds it.
const CORE_TERM_MS=11_000,CORE_KILL_MS=5_000,KEEPER_STOP_MS=16_000,DATABASE_TERM_MS=10_000,DATABASE_KILL_MS=5_000;
const runtimeStartCauses=['runtime-damaged','database-start','data-credential','data-version','core-start'];
const keeperPath=fileURLToPath(new URL('./daemon-keeper.mjs',import.meta.url));
const run=promisify(execFileCallback);
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,keeper,draining,databaseOutput='',currentPassword,databasePid,databaseStartedAt,databaseExited,exitReported,state=managedDatabase?'starting':'running',failure;
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
const startedAt=Date.now();
await writeFile(socket+'.pid',JSON.stringify({pid:process.pid,startedAt}),{mode:0o600});
// The supervisor's own child bookkeeping; tests read this instead of process listings.
const recordChildren=()=>writeFile(socket+'.pid',JSON.stringify({pid:process.pid,startedAt,core:child?.pid,keeper:keeper?.pid,database:databasePid}),{mode:0o600}).catch(()=>{});
const cleanup=async()=>{server.close();await Promise.all([unlink(socket).catch(()=>{}),unlink(socket+'.pid').catch(()=>{})]);};
let coreSettled;const ended=new Promise(resolve=>{coreSettled=resolve;});
function spawnCore(options){
 const environment={...process.env,MASSION_PORT:new URL(origin).port,MASSION_DESKTOP_AUTH_FD:'3'};
 delete environment.SURREAL_PASS;delete environment.SURREAL_USER;
 if(options?.databaseEndpoint){environment.MASSION_SURREAL_RPC=options.databaseEndpoint+'/rpc';environment.MASSION_SURREAL_AUTH_FD='4';}
 child=spawn(process.execPath,[entry],{env:environment,stdio:['ignore','inherit','inherit','pipe',...options?.databaseEndpoint?['pipe']:[]]});
 child.stdio[3].on('error',()=>{});child.stdio[3].end(secret);
 if(options?.databaseEndpoint){child.stdio[4].on('error',()=>{});child.stdio[4].end(options.password);}
 child.once('error',()=>coreSettled([1,null]));child.once('exit',code=>coreSettled([code,null]));
}
const processStartTime=async pid=>{
 try{const {stdout}=await run('ps',['-o','lstart=','-p',String(pid)]);const parsed=Date.parse(stdout.trim());return Number.isNaN(parsed)?null:parsed;}
 catch{return null;}
};
const processCommand=async pid=>{
 try{const {stdout}=await run('ps',['-o','comm=','-p',String(pid)]);return stdout.trim();}
 catch{return '';}
};
// Is this pid, at this start time, this binary? Answers identity for a recorded process.
async function recordedProcessIs(pid,startedAt,expectedBinary){
 let live;try{process.kill(pid,0);live=true;}catch(error){live=error.code==='EPERM';}
 if(!live)return false;
 const born=await processStartTime(pid);
 if(born===null||Math.abs(born-startedAt)>2000)return false;
 if(expectedBinary!==undefined){
  const command=await processCommand(pid);
  if(command!==expectedBinary&&command!=='surreal'&&!command.endsWith('/surreal'))return false;
 }
 return true;
}
// The pid file is a hint anyone can write: only a pid, start time and binary that all match make it
// a reason to refuse. A mismatch is stale; the file is removed and the named process is never signalled.
async function previousDatabaseRunning(pidFile,expectedBinary){
 const record=await readFile(pidFile,'utf8').then(JSON.parse).catch(()=>null);
 if(!record||typeof record.pid!=='number'||typeof record.startedAt!=='number')return false;
 if(!await recordedProcessIs(record.pid,record.startedAt,expectedBinary))return false;
 return true;
}
// The database recorded at spawn (pid and start time from the keeper's report, not from a file).
async function recordedDatabaseAlive(){
 if(databasePid===undefined)return false;
 return recordedProcessIs(databasePid,databaseStartedAt??0);
}
async function endRecordedDatabase(){
 for(const [signal,bound] of [['SIGTERM',DATABASE_TERM_MS],['SIGKILL',DATABASE_KILL_MS]]){
  if(!await recordedDatabaseAlive())return true;
  try{process.kill(databasePid,signal);}catch{}
  const deadline=Date.now()+bound;
  while(Date.now()<deadline){await delay(100);if(!await recordedDatabaseAlive())return true;}
 }
 return !await recordedDatabaseAlive();
}
const waitProcessExit=(process,bound)=>new Promise(resolve=>{
 if(process.exitCode!==null||process.signalCode)return resolve(true);
 const timer=setTimeout(()=>{process.removeListener('exit',settled);resolve(false);},bound);
 const settled=()=>{clearTimeout(timer);resolve(true);};
 process.once('exit',settled);
});
// The keeper owns the database; ending its stdin stops it. Success is only reported when the
// keeper reported the child's exit itself, or the supervisor ended the recorded child and
// confirmed it gone by pid and spawn time.
async function stopKeeper(){
 if(!keeper)return true;
 if(keeper.exitCode===null&&keeper.signalCode===null){
  keeper.stdin.end();
  if(!await waitProcessExit(keeper,KEEPER_STOP_MS)){
   keeper.kill('SIGKILL');
   await waitProcessExit(keeper,5000);
  }
 }
 if(exitReported)return true;
 if(databasePid===undefined)return true;
 return endRecordedDatabase();
}
async function drain(){
 if(!draining)draining=(async()=>{
  let unsettled=false;
  if(child){
   child.kill('SIGTERM');let timer;
   const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),CORE_TERM_MS);})]);clearTimeout(timer);
   if(!result){
    // A core that ignores SIGTERM holds no data; it is killed so the database stop still fits
    // the total shutdown bound and the data folder is never left held open silently.
    unsettled=true;
    child.kill('SIGKILL');
    await Promise.race([ended,delay(CORE_KILL_MS)]);
   }else if(result[0]!==0&&!failure)unsettled=true;
  }
  if(!await stopKeeper())unsettled=true;
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
// Other operating-system users must not be able to plant or redirect these folders: a usable
// folder is a real directory, owned by this user, with no group or other permission bits.
async function requirePrivateDirectory(directory,label,allowAbsent){
 let information;
 try{information=await lstat(directory);}
 catch(error){
  if(allowAbsent&&error.code==='ENOENT')return false;
  throw error;
 }
 if(!information.isDirectory()||information.uid!==process.getuid?.()||(information.mode&0o077)!==0)
  throw startFailure('data-credential',label+' must be a directory owned by this user with mode 0700: '+scrub(directory));
 return true;
}
// Gather every input, decide through one pure function, then apply. Nothing is written or
// started before the decision has returned a non-refusal.
async function prepareData(bundledVersion){
 const dataDirectory=resolve('database');
 const versionPath=join(dataDirectory,'version'),passwordPath=join(dataDirectory,'password'),initializedPath=join(dataDirectory,'initialized');
 await requirePrivateDirectory(process.cwd(),'the user data directory',false);
 await requirePrivateDirectory(dataDirectory,'the database folder',true);
 await requirePrivateDirectory(resolve('db-tmp'),'the database temporary folder',true);
 let versionRecorded='absent';
 try{
  const recorded=JSON.parse(await readFile(versionPath,'utf8'));
  versionRecorded=recorded&&typeof recorded==='object'&&recorded.format===1&&recorded.surreal===bundledVersion?'matching':'other';
 }catch(error){if(error.code!=='ENOENT')versionRecorded='other';}
 // List through one opened handle so the listing itself cannot be redirected after the check.
 const own=new Set(['password','version','initialized']);
 let names=[];
 try{const handle=await opendir(dataDirectory);for await(const entry of handle)names.push(entry.name);}
 catch(error){if(error.code!=='ENOENT')throw error;}
 let password='',passwordUsable=false;
 try{
  const fileStat=await stat(passwordPath);
  if(fileStat.isFile()&&(fileStat.mode&0o777)===0o600){
   password=await readFile(passwordPath,'utf8');
   passwordUsable=/^[a-f0-9]{64}$/.test(password);
  }
 }catch{}
 let markerValid=false,digestMatches=false;
 try{
  const marker=JSON.parse(await readFile(initializedPath,'utf8'));
  if(marker&&typeof marker==='object'&&/^[a-f0-9]{32}$/.test(marker.salt??'')&&/^[a-f0-9]{64}$/.test(marker.digest??'')){
   markerValid=true;
   if(passwordUsable){
    const digest=createHash('sha256').update(Buffer.from(marker.salt,'hex')).update(password).digest('hex');
    digestMatches=timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(marker.digest,'hex'));
   }
  }
 }catch{}
 const decision=decideDatabaseStart({versionRecorded,folderEmpty:names.length===0,databaseFilesPresent:names.some(name=>!own.has(name)),passwordUsable,markerValid,digestMatches});
 if(decision.action==='refuse')throw startFailure(decision.cause,decision.detail);
 if(decision.action==='initialise'){
  const generated=randomBytes(32).toString('hex');
  await mkdir(dataDirectory,{recursive:true,mode:0o700});
  await requirePrivateDirectory(dataDirectory,'the database folder',false);
  await writeAtomic(passwordPath,generated);
  await writeAtomic(versionPath,JSON.stringify({surreal:bundledVersion,format:1})+'\n');
  return {password:generated,bootstrap:true};
 }
 return {password,bootstrap:decision.action==='resume'};
}
const freePort=()=>new Promise((resolvePromise,reject)=>{
 const probe=createServer();probe.once('error',reject);
 probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolvePromise(port));});
});
const basicAuthorization=password=>'Basic '+Buffer.from('root:'+password).toString('base64');
// No credential is sent anywhere until the child itself has proven, from its own start line,
// that it bound the port — and each later credentialed step re-checks that the child is still alive.
function watchKeeper(port){
 return new Promise((resolveBound,rejectBound)=>{
  let settled=false,pending='';
  keeper.stdout.setEncoding('utf8');
  keeper.stdout.on('data',chunk=>{
   pending+=chunk;
   for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){
    const line=pending.slice(0,end);pending=pending.slice(end+1);
    let message;try{message=JSON.parse(line);}catch{continue;}
    if(message.log!==undefined)databaseOutput=(databaseOutput+message.log+'\n').slice(-2000);
    if(message.spawn!==undefined){databasePid=message.spawn;databaseStartedAt=message.startedAt;void recordChildren();}
    if(message.bound!==undefined&&!settled){settled=true;resolveBound(message.bound);}
    if(message.exit!==undefined){
     databaseExited=true;exitReported=true;
     if(!settled){settled=true;rejectBound(startFailure('database-start','the database process exited before listening: '+databaseTail()));}
     else if(state==='running'&&!draining&&!failure)
      void failRuntime(startFailure('database-start','the database exited while running: '+databaseTail()));
    }
   }
  });
  keeper.stderr.setEncoding('utf8');
  keeper.stderr.on('data',chunk=>{databaseOutput=(databaseOutput+chunk).slice(-2000);});
  const deadline=setTimeout(()=>{if(!settled){settled=true;rejectBound(startFailure('database-start','the database did not report its listening address within '+(readinessDeadlineMs/1000)+'s: '+databaseTail()));}},readinessDeadlineMs);
  keeper.once('exit',()=>{
   clearTimeout(deadline);
   databaseExited=true;
   if(!settled){settled=true;rejectBound(startFailure('database-start','the database keeper exited unexpectedly'));}
   else if(state==='running'&&!draining&&!failure)void failRuntime(startFailure('database-start','the database keeper exited unexpectedly: '+databaseTail()));
  });
 });
}
async function waitForHealth(port){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(databaseExited||keeper.exitCode!==null||keeper.signalCode)throw startFailure('database-start','the database exited: '+databaseTail());
  try{const response=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}
  if(Date.now()>deadline)throw startFailure('database-start','the database was not ready within '+(readinessDeadlineMs/1000)+'s: '+databaseTail());
  await delay(250);
 }
}
async function verifyBootstrap(port,password){
 const deadline=Date.now()+bootstrapDeadlineMs;
 for(;;){
  // Checked immediately before every credentialed request: a child that died cannot vouch for the port.
  if(databaseExited||keeper.exitCode!==null||keeper.signalCode)throw startFailure('database-start','the database exited during initialisation');
  try{
   const response=await fetch('http://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:basicAuthorization(password)},body:JSON.stringify({id:'massion-bootstrap',method:'query',params:['RETURN 1',{}]}),signal:AbortSignal.timeout(1000)});
   const envelope=await response.json().catch(()=>null);
   if(response.ok&&envelope&&Array.isArray(envelope.result))return;
  }catch{}
  if(Date.now()>deadline)throw startFailure('data-credential','the database did not accept the stored credentials during initialization');
  await delay(250);
 }
}
const coreProof=(role,challenge,nonce)=>createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify(['massion-desktop-v1',role,origin,challenge,nonce])).digest('hex');
// Startup counts only when this daemon's own key is proven by the core; a squatter on the port cannot answer.
async function waitForCore(){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(child.exitCode!==null||child.signalCode)throw startFailure('core-start','the core process exited during startup');
  try{
   const challenge=randomBytes(32).toString('hex');
   const response=await fetch(origin+'/desktop-auth',{headers:{'X-Massion-Challenge':challenge},signal:AbortSignal.timeout(1000)});
   const nonce=response.headers.get('x-massion-nonce'),proof=response.headers.get('x-massion-proof');
   if(response.status===204&&nonce&&proof&&/^[a-f0-9]{64}$/.test(nonce)&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(coreProof('server',challenge,nonce),'hex')))return;
  }catch{}
  if(Date.now()>deadline)throw startFailure('core-start','the core did not authenticate within '+(readinessDeadlineMs/1000)+'s');
  await delay(250);
 }
}
async function failRuntime(error){
 const stopped=[];
 if(child)stopped.push(new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)resolve();else child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},10_000);}));
 stopped.push(stopKeeper());
 await Promise.all(stopped);
 failure={cause:runtimeStartCauses.includes(error.causeCode)?error.causeCode:'core-start',detail:scrub(error.message)};
 setTimeout(()=>{void drain().catch(()=>process.exit(1));},5000);
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
 const {password,bootstrap}=await prepareData(pin.version);
 currentPassword=password;
 // SurrealDB refuses to start when its temporary directory is missing; create it after every check has passed.
 await mkdir(resolve('db-tmp'),{recursive:true,mode:0o700});
 // Cheap narrowing of the same-user race: re-check both folders immediately before the spawn.
 await requirePrivateDirectory(resolve('database'),'the database folder',false);
 await requirePrivateDirectory(resolve('db-tmp'),'the database temporary folder',false);
 const pidFile=resolve('database.pid');
 if(await previousDatabaseRunning(pidFile,surrealPath))
  throw startFailure('database-start','a previous database for this data folder is still running');
 await unlink(pidFile).catch(()=>{});
 const port=await freePort();
 keeper=spawn(process.execPath,[keeperPath,surrealPath,resolve('database'),resolve('db-tmp'),String(port),pidFile,bootstrap?'1':'0'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});
 keeper.once('error',()=>{});
 await once(keeper,'spawn').catch(error=>{throw startFailure('database-start','the database keeper could not start: '+scrub(error.message?.message??String(error)));});
 keeper.stdin.on('error',()=>{});
 keeper.stdin.write(bootstrap?password+'\n':'\n');
 void recordChildren();
 const bound=await watchKeeper(port);
 if(bound!=='127.0.0.1:'+port)throw startFailure('database-start','the database reported an unexpected address '+scrub(bound));
 if(bootstrap){
  await verifyBootstrap(port,password);
  const salt=randomBytes(16).toString('hex');
  await writeAtomic(join(resolve('database'),'initialized'),JSON.stringify({surreal:pin.version,format:1,salt,digest:createHash('sha256').update(Buffer.from(salt,'hex')).update(password).digest('hex')})+'\n');
 }else await waitForHealth(port);
 if(draining)throw startFailure('core-start','drain requested during startup');
 spawnCore({databaseEndpoint:'http://127.0.0.1:'+port,password});
 void recordChildren();
 await waitForCore();
 state='running';
}
if(managedDatabase){
 void startManagedRuntime().then(()=>{
  void ended.then(async result=>{if(!draining){await stopKeeper();await cleanup();process.exit(result[0]??1);}});
 },error=>{
  if(!draining)void failRuntime(error);
 });
}else{
 spawnCore();
 void recordChildren();
 void ended.then(async result=>{if(!draining){await cleanup();process.exit(result[0]??1);}});
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void drain());

