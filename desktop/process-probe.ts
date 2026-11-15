import {execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

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
}

export interface RecordedProcess{
 pid:number;
 startedAt:number;
 matchesArgs:(args:string)=>boolean;
}

const defaultRun:PsRunner=(file,args,options)=>new Promise((resolve,reject)=>{
 const child=execFile(file,[...args],{env:options.env,encoding:'utf8',maxBuffer:1024*1024},(error,stdout)=>{
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

/** Internal factory: production calls createProcessProbe() with no arguments (fixed /bin/ps, no env overrides). */
export function createProcessProbe(options:{run?:PsRunner;timeoutMs?:number}={}):ProcessProbe{
 const run=options.run??defaultRun;
 const timeoutMs=options.timeoutMs??PS_TIMEOUT_MS;

 async function runBounded(pid:number,waitMs:number):Promise<string|null>{
  if(waitMs<=0)return null;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const psPromise=Promise.resolve().then(()=>run(
   '/bin/ps',
   ['-ww','-o','stat=','-o','lstart=','-o','args=','-p',String(pid)],
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
   const output=await runBounded(pid,effectiveWait);
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
  }
 };
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
