import fs from 'node:fs/promises';
import {once} from 'node:events';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {Socket} from 'node:net';
import childProcess,{ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const socket=process.argv[2],drainHold=process.env.MASSION_TEST_DRAIN_HOLD;
const keeperMode=drainHold?.startsWith('keeper PID ');
const lateKeeperReport=drainHold?.startsWith('keeper PID late report');
const keeperTimeout=drainHold?.startsWith('keeper timeout');
const unrecordedDatabase=drainHold==='unrecorded database';
const mismatchedDatabaseStart=drainHold==='mismatched database start time';
const waits=['checkPreviousInstance','watchKeeper','waitForHealth','verifyBootstrap','waitForCore'];
const selected=['keeper rejects','unlink database PID','TLS modes'].includes(drainHold)?'watchKeeper':drainHold;
const observeDrain=keeperMode||keeperTimeout||unrecordedDatabase||mismatchedDatabaseStart||waits.includes(selected)||['child record','self exit'].includes(drainHold);
let held=false;
async function pause(name){
 const release=once(process,'message',{signal:AbortSignal.timeout(10_000)});
 held=true;
 process.send(name);
 await release;
 held=false;
}
function hold(operation,target,matches=()=>true){
 const original=fs[operation];
 fs[operation]=async(file,...args)=>{
  if(file===target&&matches(...args)){
   fs[operation]=original;
   syncBuiltinESMExports();
   await pause(operation);
   const result=await original(file,...args);
   if(drainHold==='child record')process.send('child record written');
   return result;
  }
  return original(file,...args);
 };
}
if(!drainHold||drainHold==='chmod'||drainHold==='first PID')hold('chmod',socket);
if(!drainHold||drainHold==='writeFile'||drainHold==='first PID')hold('writeFile',socket+'.pid');
if(drainHold==='child record'){
 hold('writeFile',socket+'.pid',contents=>Boolean(JSON.parse(contents).core));
 const unlink=fs.unlink;
 fs.unlink=async file=>{
  if(file===socket+'.pid')process.send('unlink PID');
  return unlink(file);
 };
 const kill=ChildProcess.prototype.kill;
 ChildProcess.prototype.kill=function(signal){
  const sent=kill.call(this,signal);
  if(sent&&signal==='SIGTERM'&&this.spawnargs?.[1]===process.argv[3]){
   process.send('core SIGTERM sent');
   this.once('exit',()=>setImmediate(()=>process.send('core exit turn ended')));
  }
  return sent;
 };
}
if(drainHold==='self exit'){
 const unlink=fs.unlink;
 let heldSocket=false,heldPid=false;
 fs.unlink=async file=>{
  if(file===socket){
   process.send('unlink socket');
   if(!heldSocket){heldSocket=true;await pause('hold socket unlink');}
  }else if(file===socket+'.pid'){
   process.send('unlink PID');
   if(!heldPid){heldPid=true;await pause('hold PID unlink');}
  }
  return unlink(file);
 };
}
if(drainHold==='TLS modes'){
 const writeFile=fs.writeFile,targets=new Set([resolve('database-tls.crt'),resolve('database-tls.key')]);
 fs.writeFile=async(file,...args)=>{
  if(!targets.has(file))return writeFile(file,...args);
  // The supervisor's default umask would hide a missing explicit mode on these writes.
  const previousMask=process.umask(0o022);
  try{return await writeFile(file,...args);}finally{process.umask(previousMask);}
 };
}
if(drainHold==='TLS certificate write')hold('writeFile',resolve('database-tls.crt'));
if(drainHold==='TLS key write')hold('writeFile',resolve('database-tls.key'));
if(drainHold==='TLS stale files'){
 hold('chmod',socket);
 hold('writeFile',resolve('database-tls.crt'));
}
// The keeper is its own process and does not inherit this preload: these runs inject a second
// fixture into it, so the keeper's OWN removal of the pid file is what the supervisor answers for.
if(keeperMode||keeperTimeout||unrecordedDatabase||mismatchedDatabaseStart){
 const preload=new URL('./keeper-pid-removal.mjs',import.meta.url).href,keeperPath=fileURLToPath(new URL('../../daemon-keeper.mjs',import.meta.url)),spawn=childProcess.spawn;
 childProcess.spawn=(file,args,options)=>{
  if(args[0]!==keeperPath)return spawn(file,args,options);
  if(keeperMode)return spawn(file,['--import',preload,...args],{...options,env:{...options.env,MASSION_TEST_DRAIN_HOLD:drainHold}});
  const keeper=spawn(file,args,options);
  // Keep the database running until the test or the supervisor kills the keeper.
  keeper.stdin.end=()=>keeper.stdin;
  const kill=keeper.kill.bind(keeper);
  keeper.kill=signal=>{
   const sent=kill(signal);
   if(sent&&signal==='SIGKILL')process.send('keeper SIGKILL sent');
   return sent;
  };
  return keeper;
 };
 syncBuiltinESMExports();
}
if(lateKeeperReport){
 let closeDeadline,deliverReport;
 globalThis.holdKeeperClose=keeper=>{
  const emit=keeper.emit;
  keeper.emit=function(event,...args){
   if(event==='close'){this.emit=emit;emit.call(this,'test keeper close');return false;}
   return emit.call(this,event,...args);
  };
  closeDeadline=once(keeper,'test keeper close',{signal:AbortSignal.timeout(10_000)});
  void closeDeadline.catch(()=>{});
 };
 // Expire both waits once the actual keeper is gone, with its report still queued for delivery.
 globalThis.expireKeeperWait=async()=>{
  if(closeDeadline){const closed=closeDeadline;closeDeadline=undefined;await closed;await pause('keeper close deadline');}
  return false;
 };
 globalThis.holdKeeperReport=deliver=>{deliverReport=deliver;process.send('keeper report held');};
 globalThis.deliverAfterKeeperProof=async proof=>{
  const result=await proof;
  deliverReport();
  return result;
 };
 const unlink=fs.unlink;
 fs.unlink=async file=>{
  if(drainHold==='keeper PID late report'&&file===socket+'.pid'){
   await pause('final PID unlink');
   deliverReport();
  }
  if(drainHold==='keeper PID late report during unlink'&&file===resolve('database.pid')){
   const result=await unlink(file);
   deliverReport();
   return result;
  }
  return unlink(file);
 };
}
if(drainHold?.startsWith('unlink ')||drainHold==='keeper timeout EROFS'){
 const target={'unlink socket':socket,'unlink PID':socket+'.pid','unlink database PID':resolve('database.pid'),'keeper timeout EROFS':resolve('database.pid')}[drainHold];
 const unlink=fs.unlink;
 fs.unlink=async file=>{
  if(file===target){process.send('EROFS');throw Object.assign(new Error('read-only file system'),{code:'EROFS'});}
  return unlink(file);
 };
}
syncBuiltinESMExports();

if(drainHold){
 const setTimeout=Socket.prototype.setTimeout;
 Socket.prototype.setTimeout=function(ms,...args){
  // Only the drain command clears the accepted socket's timeout in these runs.
  if(ms===0&&this.server?.address()===socket){
   process.send('drain received');
   // A drain without a pending gate reaches its next synchronous checkpoint before this callback.
   if(observeDrain)setImmediate(()=>process.send('drain turn ended'));
  }
  return setTimeout.call(this,ms,...args);
 };
}

if(observeDrain){
 const runner=pathToFileURL(process.argv[1]).href;
 // Pause delivery of a real wait's result, including a real rejection. The wait still runs.
 globalThis.holdStartupResult=(name,run)=>name===selected?run().finally(()=>pause(name)):run();
 globalThis.drainReachedCleanup=()=>{if(held)process.send('drain crossed held wait');};
 globalThis.reportStartupStep=step=>process.send(step);
 registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);
  if(url!==runner)return loaded;
  let source=String(loaded.source)
   .replace(/await (checkPreviousInstance)(\(\{[\s\S]*?\n \}\))/,'await globalThis.holdStartupResult("$1",()=>$1$2)')
   .replace(/await (watchKeeper|waitForHealth|verifyBootstrap|waitForCore)(\([^\n]*\))/g,'await globalThis.holdStartupResult("$1",()=>$1$2)')
   .replace('let unsettled=false;','globalThis.drainReachedCleanup();\n  let unsettled=false;')
   .replace("const server=createServer({allowHalfOpen:true},client=>{","const server=createServer({allowHalfOpen:true},client=>{process.send('control connected');")
   .replace('void ended.then(async ([code])=>{','void ended.then(async ([code])=>{\n  globalThis.reportStartupStep(\'core ended\');')
   .replace('const {password,bootstrap,recovery}=await prepareData','globalThis.reportStartupStep("prepare data");\n const {password,bootstrap,recovery}=await prepareData')
   .replace("keeper.once('close',()=>{","keeper.once('close',()=>{\n  globalThis.reportStartupStep('keeper closed');")
   .replace('async function waitForHealth(port,request){','async function waitForHealth(port,request){\n globalThis.reportStartupStep("check database");')
   .replace(' const deadline=Date.now()+bootstrapDeadlineMs;',' globalThis.reportStartupStep("check database");\n const deadline=Date.now()+bootstrapDeadlineMs;')
   .replace('function spawnCore(options){','function spawnCore(options){\n globalThis.reportStartupStep("core spawned");')
   .replace("  state='running';",'  globalThis.reportStartupStep("mark running");\n  state=\'running\';');
  if(unrecordedDatabase)source=source.replace(/    if\(message.spawn!==undefined\).*\n/,'');
  if(mismatchedDatabaseStart)source=source.replace('databaseStartedAt=message.startedAt;','databaseStartedAt=0;');
  if(lateKeeperReport)source=source
   .replace(/await waitKeeperClose\(KEEPER_(?:STOP|KILL)_MS\)/g,'await globalThis.expireKeeperWait()')
   .replace('function watchKeeper(){','function watchKeeper(){globalThis.holdKeeperClose(keeper);')
   .replace("if(message.pidFileRemoval==='failed')pidFileRemovalFailed=true;","if(message.pidFileRemoval==='failed')globalThis.holdKeeperReport(()=>{pidFileRemovalFailed=true;});");
  if(drainHold==='keeper PID late report before unlink')source=source
   .replace('await probe.classify(keeper.pid,keeperStartedAt??0,matchesKeeper)','await globalThis.deliverAfterKeeperProof(probe.classify(keeper.pid,keeperStartedAt??0,matchesKeeper))');
  return {...loaded,source};
 }});
}

if(drainHold==='core exit'){
 const kill=ChildProcess.prototype.kill;
 const spawn=ChildProcess.prototype.spawn;
 ChildProcess.prototype.spawn=function(options){
  const result=spawn.call(this,options);
  if(this.spawnargs?.[1]===process.argv[3])process.send({core:this.pid});
  return result;
 };
 let held=false,released=false;
 ChildProcess.prototype.kill=function(signal){
  if(signal==='SIGTERM'&&!released&&this.spawnargs?.[1]===process.argv[3]){
   if(held){process.send('second SIGTERM');return true;}
   held=true;
   void pause('held SIGTERM').then(()=>{released=true;kill.call(this,signal);});
   return true;
  }
  return kill.call(this,signal);
 };
}
