import fs from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {Socket} from 'node:net';
import {ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const socket=process.argv[2],drainHold=process.env.MASSION_TEST_DRAIN_HOLD;
const waits=['checkPreviousInstance','watchKeeper','waitForHealth','verifyBootstrap','waitForCore'];
const observeDrain=waits.includes(drainHold)||['keeper rejects','unlink database PID','child record','self exit'].includes(drainHold);
let held=false;
async function pause(name){
 const release=once(process,'message');
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
if(drainHold==='chmod fails'){
 const chmod=fs.chmod;
 fs.chmod=async(file,...args)=>{
  if(file===socket){
   fs.chmod=chmod;syncBuiltinESMExports();
   throw Object.assign(new Error('operation not permitted'),{code:'EPERM'});
  }
  return chmod(file,...args);
 };
}
if(drainHold==='core spawn fails'){
 const spawn=ChildProcess.prototype.spawn;
 ChildProcess.prototype.spawn=function(options){
  if(options.args?.[1]===process.argv[3]){
   // EMFILE on the pinned Node: spawn returns before this.stdio exists and the error
   // surfaces on a later tick, which the supervisor never reaches.
   process.nextTick(()=>this.emit('error',Object.assign(new Error('spawn failed'),{code:'EMFILE'})));
   return;
  }
  return spawn.call(this,options);
 };
}
if(drainHold==='partial first PID'){
 const writeFile=fs.writeFile,{open}=fs;
 fs.writeFile=async(file,data,...args)=>{
  if(file===socket+'.pid'){
   fs.writeFile=writeFile;syncBuiltinESMExports();
   const handle=await open(file,'w',0o600);
   await handle.write(Buffer.from(String(data)).subarray(0,3),0);
   await handle.close();
   process.send('partial PID written');
   throw Object.assign(new Error('no space left on device'),{code:'ENOSPC'});
  }
  return writeFile(file,data,...args);
 };
}
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
if(drainHold?.startsWith('unlink ')){
 const target={'unlink socket':socket,'unlink PID':socket+'.pid','unlink database PID':resolve('database.pid')}[drainHold];
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
 const selected=['keeper rejects','unlink database PID'].includes(drainHold)?'watchKeeper':drainHold;
 const runner=pathToFileURL(process.argv[1]).href;
 // Pause delivery of a real wait's result, including a real rejection. The wait still runs.
 globalThis.holdStartupResult=(name,run)=>name===selected?run().finally(()=>pause(name)):run();
 globalThis.drainReachedCleanup=()=>{if(held)process.send('drain crossed held wait');};
 globalThis.reportStartupStep=step=>process.send(step);
 registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);
  if(url!==runner)return loaded;
  return {...loaded,source:String(loaded.source)
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
   .replace("  state='running';",'  globalThis.reportStartupStep("mark running");\n  state=\'running\';')};
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
