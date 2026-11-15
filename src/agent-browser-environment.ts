// Browser execution layer: agent-browser (Apache-2.0), pinned to the exact installed CLI 0.41.2.
// Massion owns the gates, secrets and records; snapshotting, refs, ref recovery and input stay in agent-browser.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DomainError,hash} from './domain.ts';
import {browserPageOriginRule} from './browser-network.ts';
import {environmentId as id,validateBinding,validateObservation,validateAction} from './environment.ts';
import type {EnvironmentAdapter,EnvironmentAction,EnvironmentBinding,EnvironmentElement,EnvironmentObservation,ActionInput,EnvironmentWebsiteAccess,EnvironmentRememberedApproval} from './environment.ts';

export const AGENT_BROWSER_VERSION='0.41.2';
export type AgentBrowserErrorCode='unknown-ref'|'stale-ref'|'covered'|'tab-gone'|'page-wedged'|'origin-blocked'|'version'|'command';
export interface AgentBrowserSnapshotRef {ref:string;role:string;name:string}
export interface AgentBrowserSnapshot {binding:EnvironmentBinding;refs:AgentBrowserSnapshotRef[];url:string;truncated:boolean;sensitive:boolean}
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
 websiteAccess?:EnvironmentWebsiteAccess;rememberedApprovals?:readonly EnvironmentRememberedApproval[];
}
const roles:{[role:string]:ActionInput['kind'][]}={link:['click','scroll'],button:['click','scroll'],checkbox:['click','scroll'],radio:['click','scroll'],textbox:['type','key','scroll'],combobox:['select','scroll']};
const privateFieldNames=/password|passwd|비밀번호|암호|card|카드|cvv|cvc|expir/i;
// Raise-only classification words (RU5 design table, 2026-11-15); screen copy never comes from here.
// Korean matches substrings, English matches whole words; a word alone never makes a payment, so the payment list also raises to send.
const sendWordPatterns=[/결제|구매|주문|지출|이체|송금|보내기|전송|게시|답장|공유|초대|제출|가입|계정 만들기/,/\b(?:pay|buy|purchase|order|checkout|transfer|send|post|publish|reply|share|invite|submit|sign\s+up|create\s+account|register)\b/i];
const deleteWordPatterns=[/삭제|제거|지우기|영구/,/\b(?:delete|remove|erase|permanently)\b/i];
function controlGateKind(name:string):'send'|'delete'|undefined{
 if(sendWordPatterns.some(pattern=>pattern.test(name)))return 'send';
 if(deleteWordPatterns.some(pattern=>pattern.test(name)))return 'delete';
 return undefined;
}
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
  let out='',err='',settled=false;const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});
  // A CLI that exits before reading its stdin emits EPIPE on the stream; settle through the typed path instead of crashing the host.
  const settle=(message:string|null)=>{if(settled)return;settled=true;clearTimeout(timer);message===null?resolve(out||err):reject(new AgentBrowserError('command',message));};
  child.stdin.on('error',()=>settle('agent-browser command failed'));
  child.on('error',()=>settle('agent-browser is unavailable'));
  child.on('close',code=>{settle(code!==0&&!out?'agent-browser command failed':null);});
  try{if(input?.stdin!==undefined)child.stdin.end(input.stdin);else child.stdin.end();}
  catch{settle('agent-browser command failed');}
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
 #readGeneration=0;
 readonly #dialogs:AgentBrowserHandledDialog[]=[];readonly #deviations:string[]=[];readonly #flags:string[]=[];
 readonly #secrets=new Set<string>();
 constructor(options:AgentBrowserAdapterOptions){
  if(!id(options.environment)||!/^[A-Za-z0-9_-]{1,128}$/.test(options.session))throw new DomainError('Invalid agent-browser environment');
  if(!options.origins.length)throw new DomainError('Invalid agent-browser origins');
  for(const origin of options.origins)this.#allowed.add(browserPageOriginRule(origin));
  this.#options={...options,origins:[...options.origins]};
  // A fresh surface per incarnation: a recreated adapter must never reproduce an earlier binding.
  this.#surface='agent-browser:'+options.session+':'+randomUUID();
 }
 get allowedOrigins():ReadonlySet<string>{return this.#allowed;}
 async #runner(args:string[],input?:{stdin?:string},signal?:AbortSignal){signal?.throwIfAborted();ensure(!this.#closed,'Agent browser environment closed');return this.#options.runner(args,input);}
 async #currentUrl(signal?:AbortSignal){
  const data=await this.#runner(['get','url'],undefined,signal),url=String(data?.url??'');
  ensure(/^https?:/.test(url),'agent-browser left the web origin scope');
  return url;
 }
 async #snapshot(signal?:AbortSignal):Promise<AgentBrowserSnapshot>{
  const data=await this.#runner(['snapshot','-i','-u'],undefined,signal);
  const refs=Object.entries(data?.refs??{}) as [string,{name:unknown;role:unknown}][];
  ensure(Array.isArray(refs)&&refs.length<=5000,'Invalid agent-browser snapshot');
  const url=await this.#currentUrl(signal),origin=this.#originOf(url),rawOrigin=new URL(url).origin;
  // An origin the rule rejects is an off-list destination, not an exception: leave first, then refuse.
  if(origin===undefined||!this.#allowed.has(origin)){this.#noteOffList(rawOrigin);await this.#leaveOffList(signal);throw new AgentBrowserError('origin-blocked','Owner did not approve '+rawOrigin);}
  const entries=refs.map(([ref,node])=>({ref,role:String(node?.role??''),name:name(node?.name)||String(node?.role??'')}))
   .filter(node=>Object.hasOwn(roles,node.role))
   .sort((a,b)=>Number(a.ref.slice(1))-Number(b.ref.slice(1)));
  // Sensitivity is decided from the complete snapshot so truncation cannot drop a private field.
  const sensitive=entries.some(node=>node.role==='textbox'&&privateFieldNames.test(node.name));
  const truncated=entries.length>64||data?.removedRefs?.length>0,listed=entries.slice(0,64);
  // Sensitivity joins the digest so a page that gains a private field invalidates every pending binding.
  // Resolved href/formaction targets join it so a changed destination also invalidates every pending binding.
  const {targets,unknown}=await this.#targets(data,listed,signal);
  // A button whose destination could not be resolved is refused (unlisted) rather than bound to an unknown target.
  const shown=listed.filter(node=>!unknown.has(node.ref));
  const digest=hash([url,shown.map(node=>({...node,target:targets.get(node.ref)??null})),sensitive]);
  if(origin!==this.#origin){this.#generation++;this.#origin=origin;}
  if(digest!==this.#digest){this.#revision++;this.#digest=digest;}
  this.#url=url;
  const binding:EnvironmentBinding={environment:this.#options.environment,surface:this.#surface,origin,generation:this.#generation,revision:this.#revision};
  validateBinding(binding);
  return {binding,refs:shown.map(node=>({...node,name:this.#scrub(node.name)})),url:this.#scrub(url),truncated,sensitive};
 }
 /** Link hrefs come from the snapshot YAML (-u); button formaction overrides from one batch attribute read. */
 async #targets(data:any,listed:AgentBrowserSnapshotRef[],signal?:AbortSignal){
  const targets=new Map<string,string>(),unknown=new Set<string>();
  for(const bracket of String(data?.snapshot??'').matchAll(/\[([^\]]*)\]/g)){
   const parts=bracket[1]!.split(',').map(part=>part.trim());
   const ref=parts.find(part=>part.startsWith('ref='))?.slice(4),address=parts.find(part=>part.startsWith('url='))?.slice(4);
   if(ref&&address)targets.set(ref,address);
  }
  const buttons=listed.filter(node=>node.role==='button');
  if(buttons.length){
   const rows=buttons.map(node=>['get','attr','@'+node.ref,'formaction']);
   // A failed attribute read must not continue with a digest that lacks the destination: the target becomes unknown and the button is refused.
   let batch:any;try{batch=await this.#runner(['batch','--json','--omit-command'],{stdin:JSON.stringify(rows)},signal);}catch{for(const button of buttons)unknown.add(button.ref);batch=undefined;}
   if(Array.isArray(batch))for(const [index,row] of batch.entries()){const button=buttons[index];if(!button)continue;
    if(row?.success!==true){unknown.add(button.ref);continue;}
    const value=row?.result?.value;if(typeof value==='string'&&value.trim())targets.set(button.ref,value.trim());}
  }
  return {targets,unknown};
 }
 #element(node:AgentBrowserSnapshotRef,sensitive:boolean):EnvironmentElement {
  const operations=[...roles[node.role]!];
  // Host observation raises and never lowers: a control name word on any clickable role, then the page-wide card field for submit-capable controls.
  const raised=roles[node.role]?.includes('click')?controlGateKind(node.name):undefined;
  const gates:EnvironmentElement['gates']=sensitive&&(node.role==='button'||node.role==='textbox')?[{kind:'payment'}]:raised?[{kind:raised}]:[];
  return {id:node.ref,role:node.role,label:node.name,operations,gates};
 }
 async observe(signal:AbortSignal):Promise<EnvironmentObservation>{
  const generation=++this.#readGeneration;
  const snapshot=await this.#snapshot(signal);
  ensure(generation===this.#readGeneration,'Agent browser observation superseded');
  // Enter in a textbox can submit a payment form; the raised payment gate reaches only submit-capable inputs.
  const structure=snapshot.refs.map(node=>this.#element(node,snapshot.sensitive));
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
  this.#dialogs.push({type,message:this.#scrub(name(status.message)).slice(0,500)});if(this.#dialogs.length>20)this.#dialogs.shift();
 }
 #noteOffList(origin:string){this.#deviations.push('left-origin:'+origin);if(this.#deviations.length>20)this.#deviations.shift();}
 #scrub(value:string){if(!this.#private)return value;for(const secret of this.#secrets)if(secret.length>0)value=value.split(secret).join('\u2022\u2022\u2022\u2022');return value;}
 async #leaveOffList(signal?:AbortSignal){
  // An off-list page is left, not used: go back, then fall back to the last approved address.
  await this.#runner(['back'],undefined,signal).catch(()=>{});
  let after=await this.#currentUrl(signal).catch(()=>'');
  if(!this.#approvedOrigin(after)){
   const fallback=[...this.#allowed][0]!;
   await this.#runner(['open',fallback],undefined,signal).catch(()=>{});
   after=await this.#currentUrl(signal).catch(()=>'');
  }
  ensure(this.#approvedOrigin(after),'agent-browser refused to leave an off-list origin');
 }
 #approvedOrigin(url:string){if(!/^https?:/.test(url))return false;try{return this.#allowed.has(browserPageOriginRule(new URL(url).origin));}catch{return false;}}
 #originOf(url:string){try{return browserPageOriginRule(new URL(url).origin);}catch{return undefined;}}
 /** The pinned routes are positive globs only, so the resolved link/form target is refused before dispatch. */
 async #checkTarget(role:string,ref:string,signal?:AbortSignal){
  const attribute=role==='link'?'href':role==='button'?'formaction':undefined;
  if(!attribute)return;
  const data=await this.#runner(['get','attr',ref,attribute],undefined,signal);
  const value=typeof data?.value==='string'?data.value.trim():'';
  if(!value)return;
  let destination:URL;
  try{destination=new URL(value,this.#url);}catch{this.#refuseTarget(value.slice(0,200));}
  const origin=this.#originOf(destination.origin);
  if(!['https:','http:'].includes(destination.protocol)||origin===undefined||!this.#allowed.has(origin))this.#refuseTarget(destination.origin);
 }
 #refuseTarget(origin:string):never{this.#deviations.push('refused-target:'+origin);if(this.#deviations.length>20)this.#deviations.shift();throw new AgentBrowserError('origin-blocked','Owner did not approve '+origin);}
 async #originGuard(signal?:AbortSignal){
  const url=await this.#currentUrl(signal),origin=this.#originOf(url);
  if(origin!==undefined&&this.#allowed.has(origin))return;
  this.#noteOffList(new URL(url).origin);await this.#leaveOffList(signal);
 }
 async act(action:EnvironmentAction,context:Parameters<EnvironmentAdapter['act']>[1]):Promise<void>{
  validateAction(action);action=structuredClone(action);
  ensure(!action.gates.some(g=>g.kind==='payment'),'Payment intents are non-executable');
  ++this.#readGeneration;
  const fresh=async()=>this.#snapshot(context.signal);
  try{
   const current=await this.#snapshot(context.signal);
   ensure(hash(current.binding)===hash(action.binding),'Agent browser binding changed');
   const target=current.refs.find(node=>node.ref===action.element);
   if(!target)throw new AgentBrowserError('unknown-ref','Unknown ref: '+action.element,current);
   this.#lastBinding=structuredClone(current.binding);
   const ref='@'+action.element,input=action.input;let result:any,secret:string|undefined;
   if(input.kind==='click'||input.kind==='submit')await this.#checkTarget(target.role,ref,context.signal);
   if(input.kind==='type'){
    ensure(context.secret,'Secret resolver unavailable');
    const bytes=await context.secret();
    try{ensure(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=16000,'Invalid private input');secret=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    finally{if(bytes instanceof Uint8Array)bytes.fill(0);}
    // Taint and remember the value before any dispatch so every later surface is scrubbed.
    // Taint and remember the value before any dispatch so every later surface is scrubbed; a known value is never evicted while the environment is open.
    this.#private=true;ensure(this.#secrets.has(secret)||this.#secrets.size<256,'Secret fill bound reached');this.#secrets.add(secret);
    const recheck=await this.#snapshot(context.signal);
    ensure(hash(recheck.binding)===hash(action.binding),'Agent browser binding changed');
    if(!recheck.refs.some(node=>node.ref===action.element))throw new AgentBrowserError('unknown-ref','Unknown ref: '+action.element,recheck);
    this.#lastBinding=structuredClone(recheck.binding);
    try{result=await this.#runner(['batch','--json','--omit-command'],{stdin:JSON.stringify([['fill',ref,secret]])},context.signal);}
    finally{secret=undefined;}
    const row=Array.isArray(result)?result[0]:undefined,message=String(row?.error??'agent-browser fill failed');
    if(row?.success!==true)throw new AgentBrowserError(errorCode(message),message);
   }
   else if(input.kind==='click'||input.kind==='submit')result=await this.#runner(['click',ref],undefined,context.signal);
   else if(input.kind==='key'){await this.#runner(['focus',ref],undefined,context.signal);result=await this.#runner(['press',input.key],undefined,context.signal);}
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
   await this.#originGuard(context.signal).catch(()=>{});
   if(error instanceof AgentBrowserError&&(error.code==='unknown-ref'||error.code==='stale-ref'))throw new AgentBrowserError(error.code,this.#scrub(error.message),await fresh());
   if(error instanceof AgentBrowserError)throw new AgentBrowserError(error.code,this.#scrub(error.message),error.snapshot);
   if(error instanceof DomainError)throw error;
   const snapshot=await fresh().catch(()=>undefined),message=this.#scrub(String((error as Error)?.message??'agent-browser action failed'));
   throw new AgentBrowserError(errorCode(message),message,snapshot);
  }
 }
 async navigate(input:{url?:string;back?:boolean;reload?:boolean},signal:AbortSignal){
  ++this.#readGeneration;
  if(input.back){await this.#runner(['back'],undefined,signal);}
  else if(input.reload){await this.#runner(['reload'],undefined,signal);}
  else{
   let url:URL;try{url=new URL(String(input.url??''));}catch{throw new AgentBrowserError('command','Invalid agent browser address');}
   ensure(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=2000,'Invalid agent browser address');
   const origin=this.#originOf(url.origin);
   // A target the rule rejects can never be approved; refuse it as off-list without asking.
   if(origin===undefined)throw new AgentBrowserError('origin-blocked','Owner did not approve '+url.origin);
   if(!this.#allowed.has(origin)){
    // First visit to an origin the request did not name: the separate website setting governs it; a remembered site approval covers it.
    const remembered=this.#options.rememberedApprovals?.some(approval=>approval.covers==='first-visit'&&approval.origin===origin)??false;
    if(this.#options.websiteAccess!=='always-allow'&&!remembered){
     ensure(this.#options.requestOrigin,'Agent browser origin is not approved');
     const approved=await this.#options.requestOrigin(origin,signal);
     if(!approved)throw new AgentBrowserError('origin-blocked','Owner did not approve '+origin);
    }
    this.#allowed.add(origin);
   }
   await this.#runner(['open',url.href],undefined,signal);
  }
  await this.#runner(['wait','--load','load','--timeout','10000'],undefined,signal).catch(()=>{});
  await this.#originGuard(signal);
  this.#digest='';this.#lastBinding=undefined;
 }
 async wait(match:{text?:string;url?:string},timeoutMs:number,signal:AbortSignal){
  ++this.#readGeneration;
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
 observedUrl(){return this.#scrub(this.#url)}
 async close(){this.#closed=true;this.#secrets.clear();}
}
function ensure(value:unknown,message:string):asserts value{if(!value)throw new DomainError(message,'conflict');}
