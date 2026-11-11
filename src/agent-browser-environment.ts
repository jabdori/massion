// Browser execution layer: agent-browser (Apache-2.0), pinned to the exact installed CLI 0.41.2.
// Massion owns the gates, secrets and records; snapshotting, refs, ref recovery and input stay in agent-browser.
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DomainError,hash} from './domain.ts';
import {browserPageOriginRule} from './browser-network.ts';
import {environmentId as id,validateBinding,validateObservation,validateAction} from './environment.ts';
import type {EnvironmentAdapter,EnvironmentAction,EnvironmentBinding,EnvironmentElement,EnvironmentObservation,ActionInput} from './environment.ts';

export const AGENT_BROWSER_VERSION='0.41.2';
export type AgentBrowserErrorCode='unknown-ref'|'stale-ref'|'covered'|'tab-gone'|'page-wedged'|'origin-blocked'|'version'|'command';
export interface AgentBrowserSnapshotRef {ref:string;role:string;name:string}
export interface AgentBrowserSnapshot {binding:EnvironmentBinding;refs:AgentBrowserSnapshotRef[];url:string;truncated:boolean}
export interface AgentBrowserHandledDialog {type:'alert'|'confirm'|'prompt'|'beforeunload';message:string}
export interface AgentBrowserReport {dialogs:AgentBrowserHandledDialog[];deviations:string[];flags:string[]}
export class AgentBrowserError extends Error {
 readonly code:AgentBrowserErrorCode;readonly snapshot?:AgentBrowserSnapshot;
 constructor(code:AgentBrowserErrorCode,message:string,snapshot?:AgentBrowserSnapshot){super(message);this.name='AgentBrowserError';this.code=code;this.snapshot=snapshot;}
}
export type AgentBrowserRunner=(args:string[],input?:{stdin?:string})=>Promise<any>;
export interface AgentBrowserAdapterOptions {
 environment:string;session:string;runner:AgentBrowserRunner;
 origins:string[];requestOrigin?:(origin:string,signal:AbortSignal)=>Promise<boolean>;
}
const roles:{[role:string]:ActionInput['kind'][]}={link:['click','scroll'],button:['click','scroll'],checkbox:['click','scroll'],radio:['click','scroll'],textbox:['type','key','scroll'],combobox:['select','scroll']};
const privateFieldNames=/password|passwd|비밀번호|암호|card|카드|cvv|cvc|expir/i;
const name=(value:unknown)=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim().slice(0,256);
function errorCode(error:string){
 if(error.startsWith('Unknown ref:'))return 'unknown-ref';
 if(error.startsWith('Could not locate element with role=')||error.includes('cannot be recovered'))return 'stale-ref';
 if(error.includes('is covered by'))return 'covered';
 if(error.includes('tab_gone'))return 'tab-gone';
 if(error.includes('page_wedged'))return 'page-wedged';
 return 'command';
}
/** Runs the pinned CLI; any other version is refused rather than best-effort parsed. */
export async function createAgentBrowserRunner(options:{session:string;binary?:string;namespace?:string;version?:string}):Promise<{runner:AgentBrowserRunner;close:()=>Promise<void>}>{
 const binary=options.binary??'agent-browser',session=options.session??'';
  // Unix socket paths cap at 103 bytes; the namespace directory already spends most of it.
  if(!/^[A-Za-z0-9_-]{1,48}$/.test(session))throw new AgentBrowserError('command','Invalid agent-browser session');
 const namespace=options.namespace??join(homedir(),'.massion','agent-browser');
 await mkdir(namespace,{recursive:true});
 const invoke=(args:string[],input?:{stdin?:string})=>new Promise<string>((resolve,reject)=>{
  const child=spawn(binary,['--namespace',namespace,'--session',session,'--no-auto-dialog','--json',...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_BROWSER_NO_AUTO_DIALOG:'1'},stdio:['pipe','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('error',error=>{clearTimeout(timer);reject(new AgentBrowserError('command','agent-browser is unavailable'));});
  child.on('close',code=>{clearTimeout(timer);
   if(code!==0&&!out){reject(new AgentBrowserError('command','agent-browser command failed'));return;}
   resolve(out||err);
  });
  if(input?.stdin!==undefined)child.stdin.end(input.stdin);else child.stdin.end();
 });
 const probe=await invoke(['--version']);
 if(probe.trim()!=='agent-browser '+(options.version??AGENT_BROWSER_VERSION))throw new AgentBrowserError('version','agent-browser version is not pinned to '+(options.version??AGENT_BROWSER_VERSION));
 const runner:AgentBrowserRunner=async(args,input)=>{
  const output=await invoke(args,input);
  let envelope:any;try{envelope=JSON.parse(output);}catch{throw new AgentBrowserError('command','agent-browser output is not the pinned JSON format');}
  if(Array.isArray(envelope))return envelope;
  if(envelope?.success!==true){const message=String(envelope?.error??'agent-browser command failed');throw new AgentBrowserError(errorCode(message),message);}
  return envelope.data;
 };
 return {runner,close:async()=>{try{await invoke(['close']);}catch{/* daemon-owned sessions close on idle. */}}};
}
/** Adapter behind the environment-neutral port; refs and their expiry belong to agent-browser. */
export class AgentBrowserEnvironment implements EnvironmentAdapter {
 readonly #options:AgentBrowserAdapterOptions;readonly #allowed=new Set<string>();readonly #surface:string;
 #generation=1;#revision=1;#digest='';#origin='';#url='';#closed=false;#private=false;#lastBinding?:EnvironmentBinding;
 readonly #dialogs:AgentBrowserHandledDialog[]=[];readonly #deviations:string[]=[];readonly #flags:string[]=[];
 constructor(options:AgentBrowserAdapterOptions){
  if(!id(options.environment)||!/^[A-Za-z0-9_-]{1,128}$/.test(options.session))throw new DomainError('Invalid agent-browser environment');
  if(!options.origins.length)throw new DomainError('Invalid agent-browser origins');
  for(const origin of options.origins)this.#allowed.add(browserPageOriginRule(origin));
  this.#options={...options,origins:[...options.origins]};this.#surface='agent-browser:'+options.session;
 }
 get allowedOrigins():ReadonlySet<string>{return this.#allowed;}
 async #runner(args:string[],input?:{stdin?:string},signal?:AbortSignal){signal?.throwIfAborted();ensure(!this.#closed,'Agent browser environment closed');return this.#options.runner(args,input);}
 async #currentUrl(signal?:AbortSignal){
  const data=await this.#runner(['get','url'],undefined,signal),url=String(data?.url??'');
  ensure(/^https?:/.test(url),'agent-browser left the web origin scope');
  return url;
 }
 async #snapshot(signal?:AbortSignal):Promise<AgentBrowserSnapshot>{
  const data=await this.#runner(['snapshot','-i'],undefined,signal);
  const refs=Object.entries(data?.refs??{}) as [string,{name:unknown;role:unknown}][];
  ensure(Array.isArray(refs)&&refs.length<=5000,'Invalid agent-browser snapshot');
  const url=await this.#currentUrl(signal),origin=browserPageOriginRule(new URL(url).origin);
  const entries=refs.map(([ref,node])=>({ref,role:String(node?.role??''),name:name(node?.name)||String(node?.role??'')}))
   .filter(node=>Object.hasOwn(roles,node.role))
   .sort((a,b)=>Number(a.ref.slice(1))-Number(b.ref.slice(1)));
  const truncated=entries.length>64||data?.removedRefs?.length>0,listed=entries.slice(0,64);
  const digest=hash([url,listed]);
  if(origin!==this.#origin){this.#generation++;this.#origin=origin;}
  if(digest!==this.#digest){this.#revision++;this.#digest=digest;}
  this.#url=url;
  const binding:EnvironmentBinding={environment:this.#options.environment,surface:this.#surface,origin,generation:this.#generation,revision:this.#revision};
  validateBinding(binding);
  return {binding,refs:listed,url,truncated};
 }
 #element(node:AgentBrowserSnapshotRef):EnvironmentElement {
  const operations=[...roles[node.role]!];
  const gates:EnvironmentElement['gates']=node.role==='textbox'?[{'kind':'personal-data-submission'}]:[];
  return {id:node.ref,role:node.role,label:node.name,operations,gates};
 }
 async observe(signal:AbortSignal):Promise<EnvironmentObservation>{
  const snapshot=await this.#snapshot(signal);
  const sensitive=snapshot.refs.some(node=>node.role==='textbox'&&privateFieldNames.test(node.name));
  const submitGates:EnvironmentElement['gates']=[{kind:'personal-data-submission'},{kind:'irreversible-submit'}];
  const structure=snapshot.refs.map(node=>{
   const element=this.#element(node);
  return sensitive&&node.role==='button'?{...element,gates:structuredClone(submitGates)}:element;
  });
  const observation:EnvironmentObservation={binding:snapshot.binding,structure,facts:{},image:null};
  validateObservation(observation);
  this.#lastBinding=structuredClone(snapshot.binding);
  return structuredClone(observation);
 }
 async #dialogPolicy(signal?:AbortSignal){
  const status=await this.#runner(['dialog','status'],undefined,signal).catch(()=>undefined);
  if(!status?.hasDialog)return;
  const type=String(status.type??'') as AgentBrowserHandledDialog['type'];
  if(!['alert','confirm','prompt','beforeunload'].includes(type))return;
  // Pinned policy: alert accepted; confirm/prompt/beforeunload dismissed. agent-browser never answers on its own (--no-auto-dialog).
  await this.#runner(['dialog',type==='alert'?'accept':'dismiss'],undefined,signal).catch(()=>{});
  this.#dialogs.push({type,message:name(status.message).slice(0,500)});if(this.#dialogs.length>20)this.#dialogs.shift();
 }
 async #originGuard(signal?:AbortSignal){
  const url=await this.#currentUrl(signal),origin=browserPageOriginRule(new URL(url).origin);
  if(this.#allowed.has(origin))return;
  // An off-list page is left, not used: go back, then fall back to the last approved address.
  await this.#runner(['back'],undefined,signal).catch(()=>{});
  let after=await this.#currentUrl(signal).catch(()=>'');
  if(!this.#allowed.has(browserPageOriginRule(new URL(after).origin))){
   const fallback=[...this.#allowed][0]!;
   await this.#runner(['open',fallback],undefined,signal).catch(()=>{});
   after=await this.#currentUrl(signal).catch(()=>'');
  }
  this.#deviations.push('left-origin:'+origin);if(this.#deviations.length>20)this.#deviations.shift();
  ensure(this.#allowed.has(browserPageOriginRule(new URL(after).origin)),'agent-browser refused to leave an off-list origin');
 }
 async act(action:EnvironmentAction,context:Parameters<EnvironmentAdapter['act']>[1]):Promise<void>{
  validateAction(action);action=structuredClone(action);
  const fresh=async()=>this.#snapshot(context.signal);
  try{
   const current=await this.#snapshot(context.signal);
   ensure(hash(current.binding)===hash(action.binding),'Agent browser binding changed');
   if(!current.refs.some(node=>node.ref===action.element))throw new AgentBrowserError('unknown-ref','Unknown ref: '+action.element,current);
   this.#lastBinding=structuredClone(current.binding);
   const ref='@'+action.element,input=action.input;let result:any,secret:string|undefined;
   if(input.kind==='type'){
    ensure(context.secret,'Secret resolver unavailable');
    const bytes=await context.secret();
    ensure(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=16000,'Invalid private input');
    secret=new TextDecoder('utf-8',{fatal:true}).decode(bytes);bytes.fill(0);
    try{result=await this.#runner(['batch','--json','--omit-command'],{stdin:JSON.stringify([['fill',ref,secret]])},context.signal);}
    finally{secret=undefined;}
    this.#private=true;
    const row=Array.isArray(result)?result[0]:undefined,message=String(row?.error??'agent-browser fill failed');
    if(row?.success!==true)throw new AgentBrowserError(errorCode(message),message);
   }
   else if(input.kind==='click'||input.kind==='submit')result=await this.#runner(['click',ref],undefined,context.signal);
   else if(input.kind==='key')result=await this.#runner(['press',input.key],undefined,context.signal);
   else if(input.kind==='select')result=await this.#runner(['select',ref,input.option],undefined,context.signal);
   else if(input.kind==='scroll'){
    const moves:string[][]=[];
    if(input.y>0)moves.push(['scroll','down',String(Math.min(input.y,10000))]);if(input.y<0)moves.push(['scroll','up',String(Math.min(-input.y,10000))]);
    if(input.x>0)moves.push(['scroll','right',String(Math.min(input.x,10000))]);if(input.x<0)moves.push(['scroll','left',String(Math.min(-input.x,10000))]);
    ensure(moves.length,'Invalid agent browser scroll');
    for(const move of moves)result=await this.#runner(move,undefined,context.signal);
   }
   else throw new AgentBrowserError('command','Unsupported agent browser action');
   if(result?.revived===true||result?.dialogBlocked===true)this.#flags.push(String(input.kind)+(result.revived?':revived':':dialogBlocked'));
   await this.#dialogPolicy(context.signal);
   await this.#originGuard(context.signal);
  }catch(error){
   if(error instanceof AgentBrowserError&&(error.code==='unknown-ref'||error.code==='stale-ref'))throw new AgentBrowserError(error.code,error.message,await fresh());
   if(error instanceof AgentBrowserError||error instanceof DomainError)throw error;
   const snapshot=await fresh().catch(()=>undefined);
   throw new AgentBrowserError(errorCode(String((error as Error)?.message??'')),String((error as Error)?.message??'agent-browser action failed'),snapshot);
  }
 }
 async navigate(input:{url?:string;back?:boolean;reload?:boolean},signal:AbortSignal){
  if(input.back){await this.#runner(['back'],undefined,signal);}
  else if(input.reload){await this.#runner(['reload'],undefined,signal);}
  else{
   let url:URL;try{url=new URL(String(input.url??''));}catch{throw new AgentBrowserError('command','Invalid agent browser address');}
   ensure(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=2000,'Invalid agent browser address');
   const origin=browserPageOriginRule(url.origin);
   if(!this.#allowed.has(origin)){
    ensure(this.#options.requestOrigin,'Agent browser origin is not approved');
    const approved=await this.#options.requestOrigin(origin,signal);
    if(!approved)throw new AgentBrowserError('origin-blocked','Owner did not approve '+origin);
    this.#allowed.add(origin);
   }
   await this.#runner(['open',url.href],undefined,signal);
  }
  await this.#runner(['wait','--load','load','--timeout','10000'],undefined,signal).catch(()=>{});
  await this.#originGuard(signal);
  this.#digest='';this.#lastBinding=undefined;
 }
 async wait(match:{text?:string;url?:string},timeoutMs:number,signal:AbortSignal){
  const timeout=String(Math.min(Math.max(Math.trunc(timeoutMs)||5000,1000),30000));
  const args=match.text!==undefined?['wait','--text',match.text,'--timeout',timeout]:match.url!==undefined?['wait','--url',match.url,'--timeout',timeout]:undefined;
  ensure(args,'Invalid agent browser wait');
  await this.#runner(args!,undefined,signal);
  await this.#dialogPolicy(signal);
  await this.#originGuard(signal);
 }
 report():AgentBrowserReport{return {dialogs:this.#dialogs.splice(0),deviations:this.#deviations.splice(0),flags:this.#flags.splice(0)}}
 /** Private taint is sticky for the environment lifetime; text surfaces stay suppressed (R-U2 rule). */
 isPrivate(){return this.#private}
 observedUrl(){return this.#url}
 async close(){this.#closed=true;}
}
function ensure(value:unknown,message:string):asserts value{if(!value)throw new DomainError(message,'conflict');}
