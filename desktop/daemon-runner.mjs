import {createServer,connect} from 'node:net';
import {chmod,writeFile,unlink,mkdir,opendir,readFile,rename,stat,lstat,realpath} from 'node:fs/promises';
import {createReadStream,writeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {checkPreviousInstance,createProcessProbe,databaseArgsMatcher,keeperArgsMatcher,stopRecordedProcess} from './process-probe.ts';
import {decideDatabaseStart} from './start-decision.ts';

const [socket,entryArgument,originArgument,runtimeDirectory]=process.argv.slice(2);
if(!socket)throw new Error('Daemon socket required');
const here=dirname(fileURLToPath(import.meta.url));
// The Tauri host starts the supervisor with the socket only; Electron still passes the core
// entry and origin (and the managed runtime directory) explicitly.
const entry=entryArgument??fileURLToPath(new URL('../src/server.ts',import.meta.url));
let origin=originArgument;
if(!origin){
 const {daemonOrigin}=await import('./transport.ts');
 origin=daemonOrigin(process.env.MASSION_DAEMON_ORIGIN??'http://127.0.0.1:8765');
}
// The supervisor and the core import the same pinned-request module without a build step. The
// module lives in src/ and ships inside the packaged core/src tree, so the runner resolves it
// relative to its own location for the three layouts: repository, desktop/dist and Resources.
let databaseTls;
for(const candidate of ['../src/database-tls.ts','../../src/database-tls.ts','./core/src/database-tls.ts']){
 try{databaseTls=await import(new URL(candidate,import.meta.url).href);break;}catch{}
}
if(!databaseTls)throw new Error('The pinned database request module is missing beside the daemon runner');
const {createPinnedDatabaseFetch,generateStartCertificate}=databaseTls;
// The managed database runs only from the bundled runtime; MASSION_SURREAL_RPC keeps today's developer path.
const managedDatabase=Boolean(runtimeDirectory)&&!process.env.MASSION_SURREAL_RPC;
const readinessDeadlineMs=30_000,bootstrapDeadlineMs=10_000;
// Cleanup waits after startup settles: core SIGTERM 11 s + core SIGKILL 5 s + keeper 16 s + keeper SIGKILL 5 s
// + direct database stop 15 s (10 s TERM + 5 s KILL, ps <= 2 s inside each phase)
// + unclosed-keeper probe <= 2 s + missing database PID scan <= 2 s (in place of the direct stop)
// + PID file removal and check <= 2 s. The host's 60 s includes startup and other file operations too.
const CORE_TERM_MS=11_000,CORE_KILL_MS=5_000,CORE_LOSS_KILL_MS=500,KEEPER_STOP_MS=16_000,KEEPER_KILL_MS=5_000,DATABASE_TERM_MS=10_000,DATABASE_KILL_MS=5_000,PID_FILE_CHECK_MS=2000;
const runtimeStartCauses=['runtime-damaged','database-start','data-credential','data-version','core-start'];
const keeperPath=fileURLToPath(new URL('./daemon-keeper.mjs',import.meta.url));
const probe=createProcessProbe();
process.umask(0o077);
const secret=randomBytes(32).toString('hex');
let child,keeper,draining,restarting=false,runtimeFailure,keeperClosed=true,keeperStopping,coreLossTimer,databaseOutput='',currentPassword,canonicalSurreal,pidFilePath,keeperStartedAt,databasePid,databaseStartedAt,spawnAnnounced=false,spawnFailed=false,exitObserved=false,databaseGone=false,pidFileWriteFailed=false,pidFileRemovalFailed=false,state=managedDatabase?'starting':'running',failure;
const scrub=text=>{
 let value=String(text);
 if(currentPassword)value=value.split(currentPassword).join('[redacted]').split(Buffer.from('root:'+currentPassword).toString('base64')).join('[redacted]');
 return value.split(homedir()).join('~').slice(0,400);
};
const databaseTail=()=>scrub(databaseOutput||'the database produced no output');
const startFailure=(cause,detail)=>{const error=new Error(detail);error.causeCode=cause;return error;};
const databaseUsable=()=>!databaseGone&&Boolean(keeper)&&keeper.exitCode===null&&keeper.signalCode===null&&!draining&&!failure;
let servicePromise;
// Replaced by every spawnCore; never resolves before the first core exists.
let ended=new Promise(()=>{});
const {promise:startDone,resolve:finishStart}=Promise.withResolvers();
let startedAt,childRecords=Promise.resolve();
const waitKeeperClose=bound=>new Promise(resolve=>{
 if(!keeper||keeperClosed)return resolve(true);
 const timer=setTimeout(()=>{keeper.removeListener('close',settled);resolve(false);},bound);
 const settled=()=>{clearTimeout(timer);resolve(true);};
 keeper.once('close',settled);
});
const server=createServer({allowHalfOpen:true},client=>{
 let handshake=Buffer.alloc(0),clientMode=false,clientBacklog=Buffer.alloc(0),clientReady=false;client.setTimeout(1000,()=>client.destroy());
 client.on('error',()=>{});
 client.on('data',chunk=>{
  if(clientMode){
   if(clientReady)return;
   clientBacklog=Buffer.concat([clientBacklog,chunk]);
   // The per-line bound (newline included) applies to the incomplete tail; the load window
   // itself stays bounded by one mebibyte of buffered lines.
   const newline=clientBacklog.lastIndexOf(10);
   if((newline>=0?clientBacklog.length-newline-1:clientBacklog.length)>=65536||clientBacklog.length>1048576)client.destroy();
   return;
  }
  // The first line and everything after it stay BYTES until the relay decodes
  // complete lines: a request chunk ending inside a multi-byte character must
  // not be decoded here.
  handshake=Buffer.concat([handshake,chunk]);
  const newline=handshake.indexOf(10);
  if(newline===-1){if(handshake.length>32)client.destroy();return;}
  if(handshake.subarray(0,newline).toString('latin1')==='client'){
   clientMode=true;client.setTimeout(0);
   const rest=handshake.subarray(newline+1);handshake=Buffer.alloc(0);
   void Promise.resolve(clientService()).then(service=>{service.handle(client,Buffer.concat([rest,clientBacklog]));clientBacklog=Buffer.alloc(0);clientReady=true;}).catch(()=>{client.write(JSON.stringify({id:'',error:{code:'unavailable',message:'The desktop relay is unavailable'}})+'\n');client.end();});
   return;
  }
  if(handshake.length>32)client.destroy();
 });
 client.on('end',()=>{
  if(clientMode)return;
  const command=handshake.toString('utf8');
  if(command==='status\n'){
   const extra=draining?{draining:true}:{};
   if(failure){client.end(JSON.stringify({status:'failed',pid:process.pid,origin,...failure,...extra}));return;}
   client.end(JSON.stringify({status:state,pid:process.pid,origin,...extra}));return;
  }
  if(command==='credentials\n'){
   if(failure||state!=='running'){client.end(JSON.stringify({status:failure?'failed':state,origin}));return;}
   client.end(JSON.stringify({status:'running',origin,secret}));return;
  }
  if(command!=='drain\n'){client.destroy();return;}
  client.setTimeout(0);void drain().then(status=>client.end(JSON.stringify({status})));
 });
});
async function unlinkIfPresent(file){
 try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function cleanup(){
 server.close();
 const results=await Promise.allSettled([unlinkIfPresent(socket),unlinkIfPresent(socket+'.pid')]);
 for(const result of results)if(result.status==='rejected')throw result.reason;
}
// The final file cleanup is submitted once: the first caller submits it and every later caller
// awaits the same result. Child records stop being accepted the moment it is submitted, so a
// delayed record can never recreate the PID file after its removal.
let finalCleanup;
function submitFinalCleanup(){
 if(!finalCleanup){
  const records=childRecords;
  finalCleanup=(async()=>{await records;await cleanup();})();
 }
 return finalCleanup;
}
// The supervisor's own child bookkeeping; tests read this instead of process listings.
function recordChildren(){
 if(draining||finalCleanup)return;
 const record=JSON.stringify({pid:process.pid,startedAt,core:child?.pid,keeper:keeper?.pid,database:databasePid});
 childRecords=childRecords.then(()=>writeFile(socket+'.pid',record,{mode:0o600})).catch(()=>{});
}
function spawnCore(options){
 const environment={...process.env,MASSION_PORT:new URL(origin).port,MASSION_DESKTOP_AUTH_FD:'3'};
 delete environment.SURREAL_PASS;delete environment.SURREAL_USER;
 if(options?.databaseEndpoint){environment.MASSION_SURREAL_RPC=options.databaseEndpoint+'/rpc';environment.MASSION_SURREAL_AUTH_FD='4';environment.MASSION_SURREAL_CERT_FD='5';}
 child=spawn(process.execPath,[entry],{env:environment,stdio:['ignore','inherit','inherit','pipe',...options?.databaseEndpoint?['pipe','pipe']:[]]});
 child.stdio[3].on('error',()=>{});child.stdio[3].end(secret);
 if(options?.databaseEndpoint){child.stdio[4].on('error',()=>{});child.stdio[4].end(options.password);child.stdio[5].on('error',()=>{});child.stdio[5].end(options.certificate);}
 ended=new Promise(resolve=>{
  child.once('error',()=>{if(coreLossTimer){clearTimeout(coreLossTimer);coreLossTimer=undefined;}resolve([1,null]);});
  child.once('exit',code=>{if(coreLossTimer){clearTimeout(coreLossTimer);coreLossTimer=undefined;}resolve([code,null]);});
 });
}
// When the database dies, the core cannot drain without it and would only issue more credentialed
// requests. Its SIGTERM handler stops admitting new work on the next event-loop turn (beginDrain,
// scheduler clear, feed close), so 500 ms covers one busy turn before SIGKILL; the core holds no
// lasting data of its own.
function stopCoreNow(){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 try{child.kill('SIGTERM');}catch{}
 if(!coreLossTimer){
  coreLossTimer=setTimeout(()=>{
   coreLossTimer=undefined;
   if(child&&child.exitCode===null&&child.signalCode===null){
    try{child.kill('SIGKILL');}catch{}
   }
  },CORE_LOSS_KILL_MS);
 }
}
function databaseLost(detail){
 databaseGone=true;
 stopCoreNow();
 if(state==='running'&&!draining&&!failure)void failRuntime(startFailure('database-start',detail));
}
async function removeDatabasePidFile(){
 const absent=unlinkIfPresent(pidFilePath).then(()=>lstat(pidFilePath)).then(()=>{throw new Error('the database pid file is still present');},error=>{
  if(error.code!=='ENOENT')throw error;
 });
 const timer=new AbortController();
 try{
  await Promise.race([absent,delay(PID_FILE_CHECK_MS,undefined,{signal:timer.signal}).then(()=>{throw new Error('the database pid file removal was not proven');})]);
 }finally{timer.abort();}
}
// Ending stdin asks the keeper to stop. An in-time clean exit completes its removal protocol.
// When it cannot report, the supervisor must prove the database and PID file are both gone.
function stopKeeper(){
 if(!keeperStopping)keeperStopping=(async()=>{
  if(!keeper)return;
  let closedInTime=keeperClosed;
  if(!closedInTime){
   keeper.stdin.end();
   closedInTime=await waitKeeperClose(KEEPER_STOP_MS);
   if(!closedInTime){
    try{keeper.kill('SIGKILL');}catch{}
    await waitKeeperClose(KEEPER_KILL_MS);
   }
  }
  const removalFailed=()=>new Error('the database keeper could not remove its pid file');
  if(pidFileRemovalFailed)throw removalFailed();
  const keeperReportedStop=exitObserved||spawnFailed||!spawnAnnounced;
  if(closedInTime&&keeper.exitCode===0&&keeperReportedStop)return;
  const unproven=()=>new Error('the database stop was not proven');
  const dataDirectory=resolve('database'),matchesDatabase=databaseArgsMatcher(dataDirectory),recordedPid=databasePid;
  if(recordedPid!==undefined){
   const stopped=await stopRecordedProcess(probe,{pid:recordedPid,startedAt:databaseStartedAt??0,matchesArgs:matchesDatabase},{termMs:DATABASE_TERM_MS,killMs:DATABASE_KILL_MS});
   if(!stopped)throw unproven();
  }
  if(!keeperClosed&&(keeper.pid===undefined||await probe.classify(keeper.pid,keeperStartedAt??0,keeperArgsMatcher(keeperPath,dataDirectory))!=='gone'))throw unproven();
  if(recordedPid===undefined&&await probe.scanProcesses(matchesDatabase)!=='clear')throw unproven();
  if(pidFileRemovalFailed)throw removalFailed();
  await removeDatabasePidFile();
  if(pidFileRemovalFailed)throw removalFailed();
 })();
 return keeperStopping;
}
async function drain(){
 if(!draining)draining=(async()=>{
  await startDone;
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
  try{await stopKeeper();}catch{unsettled=true;}
  try{await submitFinalCleanup();}catch{unsettled=true;}
  if(pidFileRemovalFailed)unsettled=true;
  setTimeout(()=>process.exit(unsettled?1:0),50);
  return unsettled?'unsettled':'drained';
 })();return draining;
}

// The daemon-side settings restart (desktop/client-relay.ts) stops and starts the core while
// this supervisor keeps serving. Only the development (unmanaged) path supports it: a managed
// restart must re-run the whole database start, which belongs to the packaged flow.
// The three refusals are thrown before the core is signalled: nothing is half-stopped, so the
// lifecycle answers the request that met the refusal and does not keep it for later requests.
// Past the signal the core is stopping and the outcome of a lost answer must stay unknown.
const restartRefused=detail=>Object.assign(new Error(detail),{code:'restart-refused'});
async function stopCoreForRestart(){
 if(draining)throw restartRefused('The daemon is draining');
 if(managedDatabase)throw restartRefused('Restart requires the development daemon');
 if(!child)throw restartRefused('No core has started yet');
 child.kill('SIGTERM');restarting=true;let timer;
 const result=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),CORE_TERM_MS);})]);clearTimeout(timer);
 if(!result){restarting=false;throw new Error('Core did not stop');}
 return result;
}
function startCoreAfterRestart(){
 if(draining)throw new Error('The daemon is draining');
 restarting=false;spawnCore();
 exitWithCore();
}

function exitWithCore(){
 void ended.then(async ([code])=>{
  if(draining||restarting)return;
  try{if(managedDatabase)await stopKeeper();}catch{code=1;}
  if(draining||restarting)return;
  try{await submitFinalCleanup();}catch{code=1;}
  if(!draining&&!restarting)process.exit(code??1);
 });
}

async function clientService(){
 return servicePromise??=(async()=>{
  const {createClientService}=await import('./client-relay.ts');
  const service=createClientService({
   origin,secret,
   htmlCandidates:[process.env.MASSION_DESKTOP_HTML,join(here,'dist','index.html'),join(here,'index.html')].filter(Boolean),
   settingsFile:join(dirname(socket),'notifications.json'),version:await desktopVersion(),stopCore:stopCoreForRestart,startCore:startCoreAfterRestart,
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
 return {password,bootstrap:decision.action==='resume',recovery:decision.action==='verify-then-mark'};
}
const freePort=()=>new Promise((resolvePromise,reject)=>{
 const probeSocket=createServer();probeSocket.once('error',reject);
 probeSocket.listen(0,'127.0.0.1',()=>{const {port}=probeSocket.address();probeSocket.close(()=>resolvePromise(port));});
});
const basicAuthorization=password=>'Basic '+Buffer.from('root:'+password).toString('base64');
// No credential is sent anywhere until the child itself has proven, from its own start line,
// that it bound the port — and each later credentialed step re-checks that the child is still alive.
function watchKeeper(){
 return new Promise((resolveBound,rejectBound)=>{
  let settled=false,pending='';
  keeper.stdout.setEncoding('utf8');
  keeper.stdout.on('data',chunk=>{
   pending+=chunk;
   for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){
    const line=pending.slice(0,end);pending=pending.slice(end+1);
    let message;try{message=JSON.parse(line);}catch{continue;}
    if(message.log!==undefined)databaseOutput=(databaseOutput+message.log+'\n').slice(-2000);
    if(message.spawning)spawnAnnounced=true;
    if(message.pidFileWrite==='failed')pidFileWriteFailed=true;
    if(message.pidFileRemoval==='failed')pidFileRemovalFailed=true;
    if(message.spawn!==undefined){databasePid=message.spawn;databaseStartedAt=message.startedAt;recordChildren();}
    if(message.spawnFailed){
     spawnFailed=true;
     databaseLost('the database process could not start: '+databaseTail());
     if(!settled){settled=true;rejectBound(startFailure('database-start','the database process could not start: '+databaseTail()));}
    }
    if(message.bound!==undefined&&!settled){settled=true;resolveBound(message.bound);}
    if(message.exited!==undefined){
     exitObserved=true;
     databaseLost('the database exited while running: '+databaseTail());
     if(!settled){settled=true;rejectBound(startFailure('database-start','the database process exited before listening: '+databaseTail()));}
    }
    if(message.unconfirmed!==undefined){
     databaseLost('the database stop was not confirmed: '+databaseTail());
     if(!settled){settled=true;rejectBound(startFailure('database-start','the database stop was not confirmed: '+databaseTail()));}
    }
   }
  });
  keeper.stderr.setEncoding('utf8');
  keeper.stderr.on('data',chunk=>{databaseOutput=(databaseOutput+chunk).slice(-2000);});
  const deadline=setTimeout(()=>{if(!settled){settled=true;rejectBound(startFailure('database-start','the database did not report its listening address within '+(readinessDeadlineMs/1000)+'s: '+databaseTail()));}},readinessDeadlineMs);
  keeper.once('close',()=>{
   clearTimeout(deadline);
   keeperClosed=true;
   databaseLost('the database keeper exited unexpectedly: '+databaseTail());
   if(!settled){settled=true;rejectBound(startFailure('database-start','the database keeper exited unexpectedly'));}
  });
 });
}
async function waitForHealth(port,request){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(!databaseUsable())throw startFailure('database-start','the database exited: '+databaseTail());
  let healthy=false;
  try{const response=await request('https://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1000)});healthy=response.ok;}catch{}
  if(!databaseUsable())throw startFailure('database-start','the database exited: '+databaseTail());
  if(healthy)return;
  if(Date.now()>deadline)throw startFailure('database-start','the database was not ready within '+(readinessDeadlineMs/1000)+'s: '+databaseTail());
  await delay(250);
 }
}
async function verifyBootstrap(port,password,request,failureDetail='the database did not accept the stored credentials during initialization'){
 const deadline=Date.now()+bootstrapDeadlineMs;
 for(;;){
  // Checked immediately before every credentialed request: a child that died cannot vouch for the port.
  if(!databaseUsable())throw startFailure('database-start','the database exited during initialisation');
  let verified=false;
  try{
   const response=await request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:basicAuthorization(password)},body:JSON.stringify({id:'massion-bootstrap',method:'query',params:['RETURN 1',{}]}),signal:AbortSignal.timeout(1000)});
   const envelope=await response.json().catch(()=>null);
   verified=Boolean(response.ok&&envelope&&Array.isArray(envelope.result));
  }catch{}
  // Once a verification response is parsed as verified, return immediately without consulting
  // databaseUsable() so the caller still writes the initialized marker; check databaseUsable()
  // only when verification did not succeed.
  if(verified)return;
  if(!databaseUsable())throw startFailure('database-start','the database exited during initialisation');
  if(Date.now()>deadline)throw startFailure('data-credential',failureDetail);
  await delay(250);
 }
}
const coreProof=(role,challenge,nonce)=>createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify(['massion-desktop-v1',role,origin,challenge,nonce])).digest('hex');
// Startup counts only when this daemon's own key is proven by the core; a squatter on the port cannot answer.
async function waitForCore(){
 const deadline=Date.now()+readinessDeadlineMs;
 for(;;){
  if(!databaseUsable())throw startFailure('database-start','the database exited while waiting for the core');
  if(child.exitCode!==null||child.signalCode)throw startFailure('core-start','the core process exited during startup');
  let authenticated=false;
  try{
   const challenge=randomBytes(32).toString('hex');
   const response=await fetch(origin+'/desktop-auth',{headers:{'X-Massion-Challenge':challenge},signal:AbortSignal.timeout(1000)});
   const nonce=response.headers.get('x-massion-nonce'),proof=response.headers.get('x-massion-proof');
   authenticated=Boolean(response.status===204&&nonce&&proof&&/^[a-f0-9]{64}$/.test(nonce)&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(coreProof('server',challenge,nonce),'hex')));
  }catch{}
  if(!databaseUsable())throw startFailure('database-start','the database exited while waiting for the core');
  if(authenticated)return;
  if(Date.now()>deadline)throw startFailure('core-start','the core did not authenticate within '+(readinessDeadlineMs/1000)+'s');
  await delay(250);
 }
}
function failRuntime(error){
 return runtimeFailure??=(async()=>{
  stopCoreNow();
  const coreStopped=child?Promise.race([ended,delay(CORE_LOSS_KILL_MS+CORE_KILL_MS)]):undefined;
  const [keeperStop]=await Promise.allSettled([stopKeeper(),coreStopped]);
  const notes=[];
  if(pidFileWriteFailed)notes.push('the database pid file write failed');
  if(keeperStop.status==='rejected')notes.push('database cleanup was not completed');
  const detail=notes.length?error.message+' ('+notes.join('; ')+')':error.message;
  failure={cause:runtimeStartCauses.includes(error.causeCode)?error.causeCode:'core-start',detail:scrub(detail)};
  setTimeout(()=>{void drain().catch(()=>process.exit(1));},5000);
 })();
}
async function startManagedRuntime(){
 let manifest;
 try{manifest=JSON.parse(await readFile(join(runtimeDirectory,'manifest.json'),'utf8'));}
 catch{throw startFailure('runtime-damaged','runtime manifest is missing or unreadable: '+scrub(runtimeDirectory));}
 const pin=manifest?.surreal;
 if(!pin||typeof pin.sha256!=='string'||typeof pin.version!=='string')throw startFailure('runtime-damaged','runtime manifest has no valid SurrealDB entry');
 const surrealPath=join(runtimeDirectory,'surreal');
 try{canonicalSurreal=await realpath(surrealPath);}
 catch{throw startFailure('runtime-damaged','bundled SurrealDB is missing or unreadable: '+scrub(surrealPath));}
 let actual;
 try{actual=await sha256(canonicalSurreal);}catch{throw startFailure('runtime-damaged','bundled SurrealDB is missing or unreadable: '+scrub(canonicalSurreal));}
 if(actual!==pin.sha256)throw startFailure('runtime-damaged','bundled SurrealDB SHA-256 mismatch for '+scrub(canonicalSurreal)+': expected '+pin.sha256.slice(0,16)+', found '+actual.slice(0,16));
 const pidFile=resolve('database.pid');
 pidFilePath=pidFile;
 const excludePids=new Set([child?.pid,keeper?.pid,databasePid].filter(pid=>pid!==undefined));
 const previousDecision=await checkPreviousInstance({
  probe,
  pidFile,
  keeperPath,
  dataDirectory:resolve('database'),
  excludePids,
  deadlineMs:readinessDeadlineMs
 });
 if(draining)throw startFailure('database-start','drain requested during startup');
 if(previousDecision.action==='refuse')
  throw startFailure(previousDecision.cause,previousDecision.detail);
 // Between this decision and the unlink + keeper spawn there are awaits (including prepareData).
 // "gone" is monotone (a dead process cannot come back, and a reused pid is not ours), and only
 // a keeper of ours can write this file; such a keeper can only be spawned by a daemon holding
 // this folder's socket lock, which is us.
 const {password,bootstrap,recovery}=await prepareData(pin.version);
 currentPassword=password;
 // SurrealDB refuses to start when its temporary directory is missing; create it after every check has passed.
 await mkdir(resolve('db-tmp'),{recursive:true,mode:0o700});
 // Cheap narrowing of the same-user race: re-check both folders immediately before the spawn.
 await requirePrivateDirectory(resolve('database'),'the database folder',false);
 await requirePrivateDirectory(resolve('db-tmp'),'the database temporary folder',false);
 if(previousDecision.action==='remove-stale-and-proceed')await unlink(pidFile).catch(()=>{});
 // One key pair and self-signed certificate per database start. Both files live in the protected
 // user-data folder (0700, files 0600, created exclusively) only until the database's own start
 // line proves the server loaded them; the private key is never an argument, variable or log line.
 const startCertificate=generateStartCertificate();
 const tlsCertificatePath=resolve('database-tls.crt'),tlsKeyPath=resolve('database-tls.key');
 const removeTlsFiles=()=>Promise.allSettled([unlink(tlsCertificatePath),unlink(tlsKeyPath)]);
 await removeTlsFiles(); // a supervisor killed before cleanup leaves no stale pair to trip the next start
 try{
  await writeFile(tlsCertificatePath,startCertificate.certificate,{mode:0o600,flag:'wx'});
  await writeFile(tlsKeyPath,startCertificate.privateKey,{mode:0o600,flag:'wx'});
  const databaseRequest=createPinnedDatabaseFetch(startCertificate.certificate);
  const port=await freePort();
  keeperClosed=false;
  keeperStartedAt=Date.now();
  keeper=spawn(process.execPath,[keeperPath,canonicalSurreal,resolve('database'),resolve('db-tmp'),String(port),pidFile,bootstrap?'1':'0'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});
  keeper.once('error',()=>{});
  try{await once(keeper,'spawn');}
  catch(error){
   keeperClosed=true;
   keeper=undefined;
   throw startFailure('database-start','the database keeper could not start: '+scrub(error.message??String(error)));
  }
  keeper.stdin.on('error',()=>{});
  keeper.stdin.write(bootstrap?password+'\n':'\n');
  keeper.stdin.write(JSON.stringify({certificate:tlsCertificatePath,key:tlsKeyPath})+'\n');
  recordChildren();
  const bound=await watchKeeper();
  if(draining)throw startFailure('database-start','drain requested during startup');
  await removeTlsFiles(); // a started server serves from memory; the key file is never needed again
  if(bound!=='127.0.0.1:'+port)throw startFailure('database-start','the database reported an unexpected address '+scrub(bound));
  // The marker bytes are identical for a first bootstrap and a recovery: the same salted digest
  // of the same stored password over the same bundled version.
  const writeInitializationMarker=password=>{
   const salt=randomBytes(16).toString('hex');
   return writeAtomic(join(resolve('database'),'initialized'),JSON.stringify({surreal:pin.version,format:1,salt,digest:createHash('sha256').update(Buffer.from(salt,'hex')).update(password).digest('hex')})+'\n');
  };
  if(bootstrap||recovery){
   // The proof is one authenticated request with the stored password over this start's pinned
   // connection. In a recovery the database was started with no credential input, so it cannot
   // adopt the password (SurrealDB 4.0.1 applies SURREAL_PASS only when no root user exists);
   // only a completed bootstrap can answer. A proof that fails within the bootstrap bound keeps
   // the start refused exactly as before.
   await verifyBootstrap(port,password,databaseRequest,recovery?'existing database files have no valid initialization record':undefined);
   // Once the authenticated request succeeds, the database has accepted the stored password and
   // the data folder is initialised regardless of whether the process exits next. Write the marker
   // unconditionally (no database-alive gate) so a subsequent death does not leave store files
   // without a marker (issue #183); databaseUsable() is checked immediately before spawnCore.
   await writeInitializationMarker(password);
  }else await waitForHealth(port,databaseRequest);
  if(!databaseUsable())throw startFailure('database-start','the database exited before starting the core');
  spawnCore({databaseEndpoint:'https://127.0.0.1:'+port,password,certificate:startCertificate.certificate});
  recordChildren();
  await waitForCore();
  if(!databaseUsable())throw startFailure('database-start','the database exited before startup completed');
  state='running';
 }finally{
  await removeTlsFiles();
 }
}
try{
 // The loser of a socket race removes nothing (the socket and PID file belong to the winner); the
 // write is synchronous because standard error may be a POSIX pipe, where process.exit() can cut
 // an asynchronous write off before it reaches the private daemon log.
 try{server.listen(socket);await once(server,'listening');}catch(error){if(error.code!=='EADDRINUSE')throw error;
  // A failed write to standard error must not change the exit code: the loser still exits 0.
  try{writeSync(2,`another supervisor already listens on this socket; supervisor ${process.pid} exits\n`)}catch{}
  process.exit(0);}
 try{
  await chmod(socket,0o600);
  if(!draining){
   startedAt=Date.now();
   await writeFile(socket+'.pid',JSON.stringify({pid:process.pid,startedAt}),{mode:0o600});
  }
 }catch(error){if(!draining)throw error;}
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void drain());
 if(!draining){
  if(managedDatabase){
   try{await startManagedRuntime();}
   catch(error){if(!draining)failRuntime(error);}
   // The keeper can also report a loss during the last startup file operation.
   if(runtimeFailure)await runtimeFailure;
   else if(!draining)exitWithCore();
  }else{
   spawnCore();
   recordChildren();
   exitWithCore();
  }
 }
}finally{finishStart();}
