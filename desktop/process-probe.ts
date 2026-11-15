import {execFile} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {decidePreviousInstance} from './start-decision.ts';
import type {PreviousInstanceDecision,PreviousPidFileState,PreviousProcessState,PreviousScanState} from './start-decision.ts';

export const PS_TIMEOUT_MS=2000;
export type ProcessClassification='match'|'gone'|'unknown';
export type PsRunner=(
 file:string,
 args:readonly string[],
 options:{env:Record<string,string>;signal:AbortSignal}
)=>Promise<{stdout:string}>;

export interface ProcessProbe{
 classify(
  pid:number,
  startedAt:number,
  matchesArgs:(args:string)=>boolean,
  maxWaitMs?:number
 ):Promise<ProcessClassification>;
 scanProcesses(
  matchesArgs:(args:string)=>boolean,
  excludePids?:ReadonlySet<number>,
  maxWaitMs?:number
 ):Promise<PreviousScanState>;
}

export interface RecordedProcess{
 pid:number;
 startedAt:number;
 matchesArgs:(args:string)=>boolean;
}

const defaultRun:PsRunner=(file,args,options)=>new Promise((resolve,reject)=>{
 const child=execFile(file,[...args],{env:options.env,encoding:'utf8',maxBuffer:4*1024*1024},(error,stdout)=>{
  if(error)reject(error);
  else resolve({stdout});
 });
 const onAbort=()=>{try{child.kill('SIGKILL');}catch{}};
 if(options.signal.aborted)onAbort();
 else options.signal.addEventListener('abort',onAbort,{once:true});
});

function isPidAlive(pid:number):boolean{
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{
  process.kill(pid,0);
  return true;
 }catch(error){
  return (error as NodeJS.ErrnoException).code==='EPERM';
 }
}

// Parse one ps line formatted with `-ww -o stat= -o lstart= -o args=`.
// lstart under LC_ALL=C always has 5 whitespace-separated tokens (e.g. "Mon Nov 16 04:32:29 2026").
const psLinePattern=/^\s*(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/;
// Parse one ps line formatted with `-ax -ww -o pid= -o stat= -o lstart= -o args=`.
const psScanLinePattern=/^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/;

/** Internal factory: production calls createProcessProbe() with no arguments (fixed /bin/ps, no env overrides). */
export function createProcessProbe(options:{run?:PsRunner;timeoutMs?:number}={}):ProcessProbe{
 const run=options.run??defaultRun;
 const timeoutMs=options.timeoutMs??PS_TIMEOUT_MS;

 async function runBounded(args:readonly string[],waitMs:number):Promise<string|null>{
  if(waitMs<=0)return null;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const psPromise=Promise.resolve().then(()=>run(
   '/bin/ps',
   args,
   {env:{LC_ALL:'C',PATH:'/usr/bin:/bin'},signal:controller.signal}
  )).then(result=>result.stdout,()=>null);
  // Resolve to null immediately on timeout even if ps never closes its stdio.
  const timeoutPromise=new Promise<null>(resolve=>{
   timer=setTimeout(()=>{
    controller.abort();
    resolve(null);
   },waitMs);
  });
  try{
   return await Promise.race([psPromise,timeoutPromise]);
  }finally{
   if(timer!==undefined)clearTimeout(timer);
  }
 }

 return {
  async classify(pid,startedAt,matchesArgs,maxWaitMs){
   if(!isPidAlive(pid))return 'gone';
   const effectiveWait=maxWaitMs===undefined?timeoutMs:Math.min(timeoutMs,maxWaitMs);
   const output=await runBounded(['-ww','-o','stat=','-o','lstart=','-o','args=','-p',String(pid)],effectiveWait);
   if(output===null)return isPidAlive(pid)?'unknown':'gone';
   const lines=output.split(/\r?\n/).filter(line=>line.trim().length>0);
   if(lines.length!==1)return isPidAlive(pid)?'unknown':'gone';
   const match=psLinePattern.exec(lines[0]!);
   if(!match)return isPidAlive(pid)?'unknown':'gone';
   const [,statText,lstartText,argsText]=match;
   if(statText!.startsWith('Z'))return 'gone';
   const born=Date.parse(lstartText!);
   if(Number.isNaN(born))return isPidAlive(pid)?'unknown':'gone';
   // Keep the 2 s tolerance because ps lstart has 1-second resolution.
   if(Math.abs(born-startedAt)>2000)return 'gone';
   return matchesArgs(argsText!)?'match':'gone';
  },

  async scanProcesses(matchesArgs,excludePids,maxWaitMs){
   const effectiveWait=maxWaitMs===undefined?timeoutMs:Math.min(timeoutMs,maxWaitMs);
   const output=await runBounded(['-ax','-ww','-o','pid=','-o','stat=','-o','lstart=','-o','args='],effectiveWait);
   if(output===null)return 'unknown';
   const lines=output.split(/\r?\n/).filter(line=>line.trim().length>0);
   if(lines.length===0)return 'unknown';
   for(const line of lines){
    const match=psScanLinePattern.exec(line);
    if(!match)return 'unknown';
    const pid=Number(match[1]);
    const statText=match[2]!;
    const lstartText=match[3]!;
    const argsText=match[4]??'';
    if(!Number.isSafeInteger(pid)||pid<=0)return 'unknown';
    if(Number.isNaN(Date.parse(lstartText)))return 'unknown';
    if(statText.startsWith('Z'))continue;
    if(pid===process.pid||excludePids?.has(pid))continue;
    if(matchesArgs(argsText))return 'match';
   }
   return 'clear';
  }
 };
}

function tryRealpath(target:string):string|undefined{
 try{return realpathSync(target);}catch{return undefined;}
}

export function keeperArgsMatcher(keeperScript:string,dataDirectory:string):(args:string)=>boolean{
 const prefix=process.execPath+' '+keeperScript+' ';
 const canonicalFolder=tryRealpath(dataDirectory)??dataDirectory;
 return args=>{
  if(!args.startsWith(prefix))return false;
  const rest=args.slice(prefix.length);
  const hasFolder=(folder:string)=>rest.indexOf(' '+folder+' ')>0;
  return hasFolder(canonicalFolder)||(dataDirectory!==canonicalFolder&&hasFolder(dataDirectory));
 };
}

export function databaseArgsMatcher(dataDirectory:string):(args:string)=>boolean{
 const canonicalFolder=tryRealpath(dataDirectory)??dataDirectory;
 const marker=' start surrealkv://';
 // Match any database process holding this data folder regardless of binary path or interpreter token.
 // Limit: a path that itself contains " --" is not recognised.
 return args=>{
  const index=args.indexOf(marker);
  if(index<=0)return false;
  const rest=args.slice(index+marker.length);
  const flagIndex=rest.indexOf(' --');
  const folder=flagIndex>=0?rest.slice(0,flagIndex):rest;
  if(folder===canonicalFolder)return true;
  const resolved=tryRealpath(folder);
  return resolved!==undefined&&resolved===canonicalFolder;
 };
}

interface PreviousRecord{
 format:2;
 keeper:{pid:number;startedAt:number};
 database:{pid:number;startedAt:number;binary:string}|null;
}

function isPreviousRecord(value:unknown):value is PreviousRecord{
 if(!value||typeof value!=='object'||(value as {format?:unknown}).format!==2)return false;
 const k=(value as {keeper?:unknown}).keeper;
 if(!k||typeof k!=='object'||typeof (k as {pid?:unknown}).pid!=='number'||typeof (k as {startedAt?:unknown}).startedAt!=='number')return false;
 const d=(value as {database?:unknown}).database;
 if(d===null)return true;
 return Boolean(d&&typeof d==='object'&&typeof (d as {pid?:unknown}).pid==='number'&&typeof (d as {startedAt?:unknown}).startedAt==='number'&&typeof (d as {binary?:unknown}).binary==='string');
}

// The pid file is a hint anyone can write; the live process scan is the primary fact. Only when
// both the file (if present and readable) and the process-list scan prove no matching keeper or
// database process holding this data folder is running can start proceed. Never signal anything from this path.
export async function checkPreviousInstance(options:{
 probe:ProcessProbe;
 pidFile:string;
 keeperPath:string;
 dataDirectory:string;
 excludePids?:ReadonlySet<number>;
 deadlineMs?:number;
}):Promise<PreviousInstanceDecision>{
 const deadline=Date.now()+(options.deadlineMs??30_000);
 const remaining=()=>deadline-Date.now();
 const matchKeeper=keeperArgsMatcher(options.keeperPath,options.dataDirectory);
 const matchDatabase=databaseArgsMatcher(options.dataDirectory);

 let file:PreviousPidFileState='absent';
 let record:PreviousRecord|undefined;
 try{
  const raw=await readFile(options.pidFile,'utf8');
  try{
   const parsed:unknown=JSON.parse(raw);
   if(isPreviousRecord(parsed)){file='present';record=parsed;}
   else file='malformed';
  }catch{file='malformed';}
 }catch(error){
  file=(error as NodeJS.ErrnoException).code==='ENOENT'?'absent':'unreadable';
 }

 if(file==='unreadable')return decidePreviousInstance({file,keeper:'none',database:'none',scan:'clear'});
 const scan=await options.probe.scanProcesses(args=>matchKeeper(args)||matchDatabase(args),options.excludePids,remaining());
 if(scan!=='clear'||file!=='present'||!record){
  return decidePreviousInstance({file,keeper:'none',database:'none',scan});
 }

 const keeperState:PreviousProcessState=await options.probe.classify(record.keeper.pid,record.keeper.startedAt,matchKeeper,remaining());
 const databaseState:PreviousProcessState=record.database===null
  ?'none'
  :await options.probe.classify(record.database.pid,record.database.startedAt,matchDatabase,remaining());
 return decidePreviousInstance({file,keeper:keeperState,database:databaseState,scan});
}

export async function stopRecordedProcess(
 probe:ProcessProbe,
 record:RecordedProcess,
 bounds:{termMs?:number;killMs?:number}={}
):Promise<boolean>{
 const termMs=bounds.termMs??10_000;
 const killMs=bounds.killMs??5_000;
 const phases:[NodeJS.Signals,number][]=[['SIGTERM',termMs],['SIGKILL',killMs]];
 for(const [signal,bound] of phases){
  const deadline=Date.now()+bound;
  let signaled=false;
  let classification=await probe.classify(record.pid,record.startedAt,record.matchesArgs,deadline-Date.now());
  if(classification==='gone')return true;
  if(classification==='match'){
   try{process.kill(record.pid,signal);}catch{}
   signaled=true;
  }
  while(Date.now()<deadline){
   const remaining=deadline-Date.now();
   if(remaining<=0)break;
   await delay(Math.min(100,remaining));
   const afterWait=deadline-Date.now();
   if(afterWait<=0)break;
   classification=await probe.classify(record.pid,record.startedAt,record.matchesArgs,afterWait);
   if(classification==='gone')return true;
   // Signal only when the last classification proved identity; never signal on unknown.
   if(!signaled&&classification==='match'){
    try{process.kill(record.pid,signal);}catch{}
    signaled=true;
   }
  }
 }
 return false;
}
