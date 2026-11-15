import {createServer,connect} from 'node:net';
import {chmod,writeFile,unlink,mkdir,readdir,readFile,rename,stat,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const [socket,entry,origin,runtimeDirectory]=process.argv.slice(2);
if(!socket||!entry||!origin)throw new Error('Daemon socket, core entry and origin required');
// The managed database runs only from the bundled runtime; MASSION_SURREAL_RPC keeps today's developer path.
const managedDatabase=Boolean(runtimeDirectory)&&!process.env.MASSION_SURREAL_RPC;
const readinessDeadlineMs=30_000,bootstrapDeadlineMs=10_000;
const runtimeStartCauses=['runtime-damaged','database-start','data-credential','data-version','core-start'];
const keeperPath=fileURLToPath(new URL('./daemon-keeper.mjs',import.meta.url));
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,keeper,draining,databaseOutput='',currentPassword,databasePid,state=managedDatabase?'starting':'running',failure;
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
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
// The keeper owns the database; ending its stdin stops the database with the same bounded escalation.
async function stopKeeper(){
 if(!keeper)return true;
 if(keeper.exitCode!==null||keeper.signalCode)return true;
 keeper.stdin.end();
 const exited=new Promise(resolveKeeper=>keeper.once('exit',()=>resolveKeeper(true)));
 if(await Promise.race([exited,delay(20_000).then(()=>null)]))return true;
 keeper.kill('SIGKILL');
 return Boolean(await Promise.race([exited,delay(3000).then(()=>false)]));
}
async function drain(){
 if(!draining)draining=(async()=>{
  let unsettled=false;
  if(child){
   child.kill('SIGTERM');let timer;
   const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),11000);})]);clearTimeout(timer);
   if(!result){void ended.then(async()=>{await stopKeeper();await cleanup();process.exit(1);});return 'unsettled';}
   if(result[0]!==0&&!failure)unsettled=true;
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
// Initialization is recorded with a salted digest of the password; a well-formed but wrong
// password is detected before anything is started or written.
async function prepareData(bundledVersion){
 const dataDirectory=resolve('database');
 const versionPath=join(dataDirectory,'version'),passwordPath=join(dataDirectory,'password'),initializedPath=join(dataDirectory,'initialized');
 await requirePrivateDirectory(process.cwd(),'the user data directory',false);
 await requirePrivateDirectory(dataDirectory,'the database folder',true);
 await requirePrivateDirectory(resolve('db-tmp'),'the database temporary folder',true);
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
  const marker=await readFile(initializedPath,'utf8').then(JSON.parse).catch(()=>null);
  if(marker){
   if(!marker||typeof marker.salt!=='string'||!/^[a-f0-9]{32}$/.test(marker.salt)||typeof marker.digest!=='string'||!/^[a-f0-9]{64}$/.test(marker.digest))
    throw startFailure('data-credential','the initialization record is invalid');
   const digest=createHash('sha256').update(Buffer.from(marker.salt,'hex')).update(password).digest('hex');
   if(!timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(marker.digest,'hex')))
    throw startFailure('data-credential','the stored password does not match the initialization record');
   return {password,bootstrap:false};
  }
  return {password,bootstrap:true};
 }
 let entries=[];try{entries=await readdir(dataDirectory);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(entries.length)throw startFailure('data-version','existing data has no version record: '+scrub(dataDirectory));
 const password=randomBytes(32).toString('hex');
 await mkdir(dataDirectory,{recursive:true,mode:0o700});
 await requirePrivateDirectory(dataDirectory,'the database folder',false);
 await writeAtomic(passwordPath,password);
 await writeAtomic(versionPath,JSON.stringify({surreal:bundledVersion,format:1})+'\n');
 return {password,bootstrap:true};
}
const freePort=()=>new Promise((resolvePromise,reject)=>{
 const probe=createServer();probe.once('error',reject);
 probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolvePromise(port));});
});
const basicAuthorization=password=>'Basic '+Buffer.from('root:'+password).toString('base64');
// No credential is sent anywhere until the child itself has proven, from its own start line,
// that it bound the port. A squatter between probe and bind makes the child exit instead.
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
    if(message.spawn!==undefined){databasePid=message.spawn;void recordChildren();}
    if(message.bound!==undefined&&!settled){settled=true;resolveBound(message.bound);}
    if(message.exit!==undefined&&!settled){settled=true;rejectBound(startFailure('database-start','the database process exited before listening: '+databaseTail()));}
    if(message.exit!==undefined&&settled&&state==='running'&&!draining&&!failure)
     void failRuntime(startFailure('database-start','the database exited while running: '+databaseTail()));
   }
  });
  keeper.stderr.setEncoding('utf8');
  keeper.stderr.on('data',chunk=>{databaseOutput=(databaseOutput+chunk).slice(-2000);});
  const deadline=setTimeout(()=>{if(!settled){settled=true;rejectBound(startFailure('database-start','the database did not report its listening address within '+(readinessDeadlineMs/1000)+'s: '+databaseTail()));}},readinessDeadlineMs);
  keeper.once('exit',()=>{
   clearTimeout(deadline);
   if(!settled){settled=true;rejectBound(startFailure('database-start','the database keeper exited unexpectedly'));}
   else if(state==='running'&&!draining&&!failure)void failRuntime(startFailure('database-start','the database keeper exited unexpectedly: '+databaseTail()));
  });
 });
}
async function waitForHealth(port){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(keeper.exitCode!==null||keeper.signalCode)throw startFailure('database-start','the database exited: '+databaseTail());
  try{const response=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}
  if(Date.now()>deadline)throw startFailure('database-start','the database was not ready within '+(readinessDeadlineMs/1000)+'s: '+databaseTail());
  await delay(250);
 }
}
async function verifyBootstrap(port,password){
 const deadline=Date.now()+bootstrapDeadlineMs;
 for(;;){
  if(keeper.exitCode!==null||keeper.signalCode)throw startFailure('data-credential','the database exited before completing initialization');
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
 await requirePrivateDirectory(resolve('db-tmp'),'the database temporary folder',false);
 const pidFile=resolve('database.pid');
 const previous=await readFile(pidFile,'utf8').then(JSON.parse).catch(()=>null);
 if(previous&&typeof previous.pid==='number'&&alive(previous.pid))
  throw startFailure('database-start','a previous database for this data folder is still running (pid '+previous.pid+')');
 await unlink(pidFile).catch(()=>{});
 const port=await freePort();
 keeper=spawn(process.execPath,[keeperPath,surrealPath,resolve('database'),resolve('db-tmp'),String(port),pidFile,bootstrap?'1':'0'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});
 keeper.once('error',()=>{});
 await once(keeper,'spawn').catch(error=>{throw startFailure('database-start','the database keeper could not start: '+scrub(error.message?.message??String(error)));});
 keeper.stdin.on('error',()=>{});
 keeper.stdin.write(password+'\n');
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

