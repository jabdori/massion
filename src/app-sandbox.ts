/** The app worker host side (docs/architecture/apps.md, ADR 0003 §4): one child process per handler call, declared permissions checked on every call, views validated before they leave. */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DomainError} from './domain.ts';
import type {AppPackage,AppNetwork,AppView} from './apps.ts';

const RUNNER=fileURLToPath(new URL('./app-runner.mjs',import.meta.url)),TIMEOUT_MS=5000,MAX_CALLS=16,MAX_LINE=256*1024,MAX_BODY=192*1024,MAX_WORKERS=4,SANDBOX_EXEC='/usr/bin/sandbox-exec';
const NODE_ARGS=['--permission','--allow-fs-read='+RUNNER,'--max-old-space-size=64',RUNNER];
/** How the worker starts with no network: Node 25+ denies it under --permission; on Node 24 only an OS sandbox does (macOS sandbox-exec). Otherwise there is no worker. */
export const workerCommand=():[string,string[]]|null=>Number(process.versions.node.split('.')[0])>=25?[process.execPath,NODE_ARGS]
 :process.platform==='darwin'&&existsSync(SANDBOX_EXEC)?[SANDBOX_EXEC,['-p','(version 1)(allow default)(deny network*)',process.execPath,...NODE_ARGS]]:null;
let running=0;
const fail=(message:string):never=>{throw new DomainError(message,'invalid');};
const text=(v:unknown,max=512)=>typeof v==='string'&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const exactKeys=(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
/** Apps send data, never markup: the host draws this shape with its own components. */
export function checkView(v:unknown):AppView {
 const row=(r:unknown)=>exactKeys(r,['id','title'],['meta','state'])&&text(r.id,128)&&text(r.title)&&(r.meta===undefined||text(r.meta))&&(r.state===undefined||text(r.state,32));
 const ok=exactKeys(v,['title','groups'],['meta','fields'])&&text(v.title)&&(v.meta===undefined||text(v.meta))&&Array.isArray(v.groups)&&v.groups.length<=8&&v.groups.every(g=>exactKeys(g,['title','rows'])&&text(g.title,128)&&Array.isArray(g.rows)&&g.rows.length<=200&&g.rows.every(row))
  &&(v.fields===undefined||Array.isArray(v.fields)&&v.fields.length<=16&&v.fields.every(f=>Array.isArray(f)&&f.length===2&&text(f[0],64)&&text(f[1])));
 if(!ok)fail('App returned no valid view');return structuredClone(v) as AppView;
}
/** What the host allows one call: a declared host, GET unless the app declared writes, and a declared secret slot. The value of a slot never enters the worker. */
function allowed(pkg:AppPackage,call:{url:unknown;method:unknown;secret:unknown}){
 let url:URL;try{url=new URL(String(call.url));}catch{return 'Invalid URL';}
 const p=pkg.manifest.permissions;
 if(url.protocol!=='https:'||url.username||url.password||url.port||!p.network.includes(url.hostname))return 'Not declared: '+url.hostname;
 if(call.method!=='GET'&&(!p.write.length||!['POST','PATCH','PUT','DELETE'].includes(String(call.method))))return 'Not declared: write';
 if(call.secret!==null&&!p.secrets.some(s=>s.slot===call.secret))return 'Not declared: secret slot';
 return null;
}
export interface RunResult {view:AppView;calls:number;refused:number;probe?:unknown}
/** Runs one handler. `probe` asks the worker to report its own confinement (tests). */
export function runHandler(options:{appId:string;pkg:AppPackage;handler:string;input:unknown;network:AppNetwork|undefined;probe?:boolean;timeoutMs?:number}):Promise<RunResult> {
 const {pkg,network}=options,command=workerCommand();
 if(!command)return Promise.reject(new DomainError('Sandbox unavailable','conflict'));
 // ponytail: one process-wide bound; per-app queues when apps run on schedules.
 if(running>=MAX_WORKERS)return Promise.reject(new DomainError('Busy','conflict'));running++;
 return new Promise<RunResult>((resolve,reject)=>{
  const child=spawn(command[0],command[1],{env:{},stdio:['pipe','pipe','ignore']});
  let buffer='',calls=0,refused=0,probe:unknown,settled=false;
  const end=(error:Error|null,view?:unknown)=>{if(settled)return;settled=true;running--;clearTimeout(timer);child.kill('SIGKILL');if(error)reject(error);else{try{resolve({view:checkView(view),calls,refused,...(options.probe?{probe}:{})});}catch(e){reject(e);}}};
  const timer=setTimeout(()=>end(new DomainError('Timed out','conflict')),options.timeoutMs??TIMEOUT_MS);
  const answer=(m:object)=>{if(!settled)child.stdin.write(JSON.stringify(m)+'\n');};
  const onCall=async(m:{id:number;url:unknown;method:unknown;secret:unknown})=>{
   if(++calls>MAX_CALLS){end(new DomainError('Too many calls','conflict'));return;}
   const reason=allowed(pkg,m);if(reason){refused++;answer({id:m.id,ok:false,error:reason});return;}
   if(!network){answer({id:m.id,ok:false,error:'No network on this host'});return;}
   try{const r=await network({appId:options.appId,url:String(m.url),method:String(m.method),secret:m.secret===null?null:String(m.secret)});
    if(!Number.isSafeInteger(r.status)||typeof r.body!=='string'||r.body.length>MAX_BODY)throw new Error('Response too large');answer({id:m.id,ok:true,status:r.status,body:r.body});}
   catch(e){answer({id:m.id,ok:false,error:String((e as Error).message||e).slice(0,200)});}
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{buffer+=chunk;if(buffer.length>MAX_LINE&&!buffer.includes('\n')){end(new DomainError('Worker line too long','conflict'));return;}
   let at;while((at=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,at);buffer=buffer.slice(at+1);let m:any;try{m=JSON.parse(raw);}catch{end(new DomainError('Worker protocol error','conflict'));return;}
    if(m?.t==='call'&&Number.isSafeInteger(m.id))void onCall(m);else if(m?.t==='probe')probe=m.probe;else if(m?.t==='done')end(null,m.view);else if(m?.t==='error')end(new DomainError(text(m.message,500)?m.message:'App failed','conflict'));else end(new DomainError('Worker protocol error','conflict'));}});
  child.on('error',e=>end(e));child.on('exit',()=>end(new DomainError('Worker stopped','conflict')));
  child.stdin.on('error',()=>{});
  child.stdin.write(JSON.stringify({source:pkg.source,handler:options.handler,input:options.input??{},probe:options.probe===true})+'\n');
 });
}
