/** Apps on Massion (docs/architecture/apps.md, ADR 0003 §4, §5): manifests, versions pinned by content hash, install and widening decisions, self-made apps. Nothing is deleted. */
import {DomainError,hash} from './domain.ts';
import type {Actor,Mission} from './domain.ts';
import {ASSISTANT_ACTOR_ID,ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import {MEMBERS_ID} from './members.ts';
import type {MembersState} from './members.ts';
import {CATALOG} from './app-catalog.ts';
import {runHandler} from './app-sandbox.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const APPS_ID=ASSISTANT_CONVERSATION_PREFIX+'apps',APP_FORMAT='massion.app.v1',DECISION_PREFIX='app-decision:',HOST_PREFIX='assistant-app',MAX_APPS=32,MAX_VERSIONS=16,MAX_OPEN=64,MAX_REJECTED=128,MAX_SOURCE=65536;
export interface AppPermissions {read:string[];write:string[];network:string[];files:string[];secrets:{slot:string;label:string}[];events:string[]}
export interface AppManifest {format:'massion.app.v1';id:string;name:string;version:string;description:string;permissions:AppPermissions;contributes:{page?:{title:string};roomTab?:{prefix:string};templates:string[];skills:string[];procedures:string[];tools:string[]};handlers:string[]}
export interface AppPackage {manifest:AppManifest;source:string}
/** The host's network adapter: it attaches the secret stored for this app's slot itself, keyed by (appId, slot), so one app never names another's secret; the app never receives the value. */
export type AppNetwork=(request:{appId:string;url:string;method:string;secret:string|null})=>Promise<{status:number;body:string}>;
export interface AppView {title:string;meta?:string;groups:{title:string;rows:{id:string;title:string;meta?:string;state?:string}[]}[];fields?:[string,string][]}
export interface AppCheck {tests:{passed:number;total:number};declaredOnly:boolean;evidence:string}
export interface AppVersion {hash:string;package:AppPackage;at:number;approvedAt?:number;check?:AppCheck}
export interface App {id:string;name:string;origin:'catalog'|'self-made';memberId?:string;source?:{missionId:string;workId:string;title:string};versions:AppVersion[];current:number|null;enabled:boolean;installedAt?:number;removedAt?:number}
export interface AppDecision {id:string;at:number;appId:string;version:number;base:number|null;kind:'install'|'widen';state:'open'|'later'|'done'|'stale';answeredAt?:number}
export interface AppsState {kind:'apps';id:string;apps:App[];decisions:AppDecision[];rejected:{at:number;memberId:string;name:string;version:string;hash:string;reason:string}[]}
type Offer={decisionId:string;origin:'catalog'|'self-made';memberId?:string;source?:App['source'];pkg:AppPackage;check?:AppCheck};
export type AppsCommand =
 | {type:'offer-app'}&Offer
 | {type:'reject-app';memberId:string;pkg:AppPackage;reason:string}
 | {type:'decide-app';decisionId:string;answer:'act'|'later'|'ask'}
 | {type:'rollback-app';appId:string;version:number;decisionId:string}
 | {type:'disable-app'|'enable-app'|'remove-app';appId:string};
export const isAppsState=(value:unknown):value is AppsState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='apps';
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[],optional:string[]=[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown,chars:number):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=chars&&v.isWellFormed()&&!/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/.test(v);
const list=(v:unknown,item:(x:unknown)=>boolean)=>Array.isArray(v)&&v.length<=16&&v.every(item)&&new Set(v.map(x=>hash(x))).size===v.length;
const words=(v:unknown)=>list(v,x=>line(x,64));
// A bare lowercase host name: no scheme, port, path or wildcard.
const host=(v:unknown)=>typeof v==='string'&&/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v);
const slot=(v:unknown)=>exact(v,['slot','label'])&&typeof v.slot==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(v.slot)&&line(v.label,64);
const HANDLERS=['page','item','run'];
/** Host scan rules for app source, like skill scan rules never a candidate (ADR 0003 §5). Network URLs are allowed: the worker enforces declared hosts. */
const SCAN:[RegExp,string][]=[
 [/\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,'Hard-coded secret'],
 [/\beval\s*\(|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|\bWebAssembly\b/,'Dynamic code'],
 [/[​-‏‪-‮⁠-⁤﻿]/,'Hidden characters']];
/** The deterministic package check: exact manifest, then the source scan. Returns the reason, or null. */
export function validatePackage(pkg:unknown):string|null {
 if(!exact(pkg,['manifest','source']))return 'Manifest: exact package fields required';const m=pkg.manifest,p=(m as AppManifest|undefined)?.permissions,c=(m as AppManifest|undefined)?.contributes;
 const ok=exact(m,['format','id','name','version','description','permissions','contributes','handlers'])&&m.format===APP_FORMAT&&typeof m.id==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(m.id)&&line(m.name,48)&&typeof m.version==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version)&&line(m.description,120)
  &&exact(p,['read','write','network','files','secrets','events'])&&words(p.read)&&words(p.write)&&list(p.network,host)&&words(p.files)&&list(p.secrets,slot)&&words(p.events)
  &&exact(c,['templates','skills','procedures','tools'],['page','roomTab'])&&(c.page===undefined||exact(c.page,['title'])&&line(c.page.title,48))&&(c.roomTab===undefined||exact(c.roomTab,['prefix'])&&line(c.roomTab.prefix,16))&&words(c.templates)&&words(c.skills)&&words(c.procedures)&&words(c.tools)
  &&list(m.handlers,x=>HANDLERS.includes(x as string))&&(m.handlers as string[]).length>0&&(c.page===undefined||(m.handlers as string[]).includes('page'))&&(c.roomTab===undefined||(m.handlers as string[]).includes('item'));
 if(!ok)return 'Manifest: exact massion.app.v1 fields, bare network hosts and known handlers required';
 if(typeof pkg.source!=='string'||!pkg.source.isWellFormed()||Buffer.byteLength(pkg.source,'utf8')>MAX_SOURCE)return 'Source: one script of at most 64 KiB';
 return SCAN.find(([rule])=>rule.test(pkg.source as string))?.[1]??null;
}
export const packageHash=(pkg:AppPackage)=>hash({manifest:pkg.manifest,source:pkg.source});
const PERMISSION_KEYS=['read','write','network','files','secrets','events'] as const;
/** True when `next` allows anything `now` did not. Narrowing or equal is not widening. */
export const widens=(now:AppPermissions,next:AppPermissions)=>PERMISSION_KEYS.some(k=>(next[k] as unknown[]).some(x=>!(now[k] as unknown[]).some(y=>hash(y)===hash(x))));
export const appIdOf=(origin:string,memberId:string|undefined,manifestId:string)=>origin==='catalog'?'app-'+manifestId:'app-'+hash({memberId,id:manifestId}).slice(0,16);
export const appDecisionId=(commandId:string)=>DECISION_PREFIX+hash(commandId).slice(0,24);
// The member's own tests gate the offer but are not shown as a check: the producer does not judge (ADR 0003 §5). Only what the host verified is shown.
const checkLine=(c?:AppCheck)=>c?.declaredOnly?'Declared permissions only':null;

export function applyApps(current:AppsState|null,command:AppsCommand,actor:Actor,time:TimeObservation):{value:AppsState;events:unknown[]} {
 ensure(actor&&id(actor.id),'Invalid actor');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');const at=time.observedAt;
 const state:AppsState=current?structuredClone(current):{kind:'apps',id:APPS_ID,apps:[],decisions:[],rejected:[]};
 const role=(needed:'owner'|'assistant')=>ensure(actor.roles.includes(needed),'Actor lacks required role','denied');
 const app=(v:unknown)=>{const found=state.apps.find(a=>a.id===v);ensure(found,'Unknown app');return found;};
 const installed=(v:unknown)=>{const a=app(v);ensure(a.current!==null,'App is not installed','conflict');return a;};
 const stale=(a:App)=>{for(const d of state.decisions)if(d.appId===a.id&&(d.state==='open'||d.state==='later')){d.state='stale';d.answeredAt=at;}};
 // Only an install (first, or after removal) turns an app on; an update or rollback keeps the owner's off.
 const use=(a:App,index:number)=>{if(a.current===null)a.enabled=true;a.current=index;a.versions[index-1]!.approvedAt??=at;a.installedAt??=at;delete a.removedAt;};
 // Not installed or wider than what runs now: the owner decides. Otherwise it applies at once (ADR 0003 §4).
 const ask=(a:App,index:number,decisionId:string)=>{
  const now=a.current===null?null:a.versions[a.current-1]!.package.manifest.permissions;
  if(now&&!widens(now,a.versions[index-1]!.package.manifest.permissions)){if(a.current!==index){stale(a);use(a,index);}return;}
  ensure(id(decisionId)&&decisionId.startsWith(DECISION_PREFIX)&&!state.decisions.some(d=>d.id===decisionId),'Invalid decision');ensure(!state.decisions.some(d=>d.appId===a.id&&d.version===index&&(d.state==='open'||d.state==='later')),'Already asked','conflict');
  ensure(state.decisions.filter(d=>d.state==='open'||d.state==='later').length<MAX_OPEN,'Decision bound reached','conflict');
  stale(a);state.decisions.push({id:decisionId,at,appId:a.id,version:index,base:a.current,kind:now?'widen':'install',state:'open'});
 };
 switch(command?.type){
  case 'offer-app': {
   ensure(exact(command,['type','decisionId','origin','pkg'],['memberId','source','check']),'Exact app offer fields required');const reason=validatePackage(command.pkg);ensure(reason===null,reason!);const h=packageHash(command.pkg);
   if(command.origin==='catalog'){
    // AppsService.act takes the owner's package from the bundled catalog at request time; replay does not compare with today's catalog, so a backup survives a catalog update.
    ensure(!command.memberId&&!command.source&&!command.check,'A catalog app has no member, source or check');if(!actor.roles.includes('assistant'))role('owner');
   } else {
    role('assistant');ensure(command.origin==='self-made'&&id(command.memberId)&&exact(command.source,['missionId','workId','title'])&&id(command.source.missionId)&&id(command.source.workId)&&line(command.source.title,512),'A self-made app names its member and source Work');
    const k=command.check;ensure(exact(k,['tests','declaredOnly','evidence'])&&exact(k.tests,['passed','total'])&&Number.isSafeInteger(k.tests.total)&&k.tests.total>0&&k.tests.passed===k.tests.total&&k.declaredOnly===true&&line(k.evidence,2000),'A self-made app is offered only after its tests pass inside its declared permissions');
   }
   const appId=appIdOf(command.origin,command.memberId,command.pkg.manifest.id);let a=state.apps.find(x=>x.id===appId);
   if(!a){ensure(state.apps.length<MAX_APPS,'App bound reached','conflict');a={id:appId,name:command.pkg.manifest.name,origin:command.origin,...(command.memberId?{memberId:command.memberId}:{}),versions:[],current:null,enabled:false};state.apps.push(a);}
   let index=a.versions.findIndex(v=>v.hash===h)+1;
   if(!index){ensure(a.versions.length<MAX_VERSIONS,'Version bound reached','conflict');a.versions.push({hash:h,package:structuredClone(command.pkg),at,...(command.check?{check:structuredClone(command.check)}:{})});index=a.versions.length;}
   if(command.source)a.source=structuredClone(command.source);a.name=command.pkg.manifest.name;
   ask(a,index,command.decisionId);break;
  }
  case 'reject-app': {
   role('assistant');ensure(exact(command,['type','memberId','pkg','reason'])&&id(command.memberId)&&line(command.reason,120),'Exact rejection fields required');ensure(state.rejected.length<MAX_REJECTED,'Rejection bound reached','conflict');
   const m=(command.pkg as Partial<AppPackage>)?.manifest;ensure(Buffer.byteLength(JSON.stringify(command.pkg??null),'utf8')<=MAX_SOURCE+16384,'Package too large');
   state.rejected.push({at,memberId:command.memberId,name:line(m?.name,48)?m!.name:'Unnamed',version:typeof m?.version==='string'?m.version.slice(0,16):'',hash:hash(command.pkg??null),reason:command.reason});break;
  }
  case 'decide-app': {
   role('owner');ensure(exact(command,['type','decisionId','answer']),'Exact decision fields required');const d=state.decisions.find(x=>x.id===command.decisionId);ensure(d,'Unknown decision');
   if(command.answer==='later'){ensure(d.state==='open','Only an open decision is deferred','conflict');d.state='later';d.answeredAt=at;break;}
   if(command.answer==='ask'){ensure(d.state==='later','Only a deferred decision is asked again','conflict');d.state='open';delete d.answeredAt;break;}
   ensure(command.answer==='act','Unknown answer');ensure(d.state==='open','Only an open decision is answered','conflict');const a=app(d.appId);
   if(a.current!==d.base){d.state='stale';d.answeredAt=at;break;}
   use(a,d.version);d.state='done';d.answeredAt=at;break;
  }
  case 'rollback-app': {
   role('owner');ensure(exact(command,['type','appId','version','decisionId']),'Exact rollback fields required');const a=installed(command.appId);
   ensure(Number.isSafeInteger(command.version)&&a.versions[command.version-1]?.approvedAt!==undefined&&command.version!==a.current,'Only another version the owner approved is rolled back to','conflict');ask(a,command.version,command.decisionId);break;
  }
  case 'disable-app': {role('owner');ensure(exact(command,['type','appId']),'Exact app fields required');const a=installed(command.appId);ensure(a.enabled,'App is already off','conflict');a.enabled=false;break;}
  case 'enable-app': {role('owner');ensure(exact(command,['type','appId']),'Exact app fields required');const a=installed(command.appId);ensure(!a.enabled,'App is already on','conflict');a.enabled=true;break;}
  case 'remove-app': {role('owner');ensure(exact(command,['type','appId']),'Exact app fields required');const a=installed(command.appId);a.current=null;a.enabled=false;a.removedAt=at;stale(a);break;}
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const OWNER='local-owner';
const fingerprint=(actorId:string,command:AppsCommand)=>hash({actorId,command});
/** Backup lineage: host steps carry the host's command IDs, owner commands never do, and a decision ID follows from its command ID. */
export function replayApps(operation:Operation<AppsState>,prior:Operation<AppsState>|undefined):void {
 ensure(operation.aggregateId===APPS_ID&&operation.value.id===APPS_ID,'apps aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:AppsCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'apps operation requires one typed event');
 const host=event.actor===ASSISTANT_ACTOR_ID;ensure(host||event.actor===OWNER,'apps step actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 const c=event.command as {decisionId?:unknown};ensure(operation.commandId.startsWith(HOST_PREFIX)===host&&(host||!operation.commandId.startsWith('assistant-'))&&(!('decisionId' in c)||event.command.type==='decide-app'||c.decisionId===appDecisionId(operation.commandId)),'apps command identity mismatch');
 const derived=applyApps(prior?prior.value:null,event.command,{id:event.actor,roles:[host?'assistant':'owner']},event.time);
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'apps command/state transition');
}

const joined=(v:string[])=>v.length?v.join(' · '):'None';
const adds=(m:AppManifest)=>joined([...(m.contributes.page?[m.contributes.page.title+' page']:[]),...(m.contributes.roomTab?[m.contributes.roomTab.prefix.replace(/\s*#$/,'')+' tab']:[])]);
export class AppsService {
 readonly #store:Store<any>;readonly #network?:AppNetwork;readonly #clock:()=>number;
 constructor(store:Store<any>,options:{network?:AppNetwork;clock?:()=>number}={}){this.#store=store;this.#network=options.network;this.#clock=options.clock??Date.now;}
 async #state(){return await this.#store.load(APPS_ID) as Snapshot<AppsState>|null;}
 /** Settings > Apps: installed apps with permissions, contributions and approved versions; the catalog with what is installed. */
 async read(){
  const s=await this.#state(),v=s?.value??{apps:[],decisions:[],rejected:[]} as unknown as AppsState;
  const apps=v.apps.filter(a=>a.current!==null).map(a=>{const cur=a.versions[a.current!-1]!,m=cur.package.manifest;
   return {id:a.id,name:a.name,origin:a.origin,memberId:a.memberId??null,version:m.version,enabled:a.enabled,installedAt:a.installedAt??cur.at,check:checkLine(cur.check),source:a.source?structuredClone(a.source):null,permissions:structuredClone(m.permissions),contributes:structuredClone(m.contributes),
    versions:a.versions.map((x,i)=>({index:i+1,version:x.package.manifest.version,at:x.approvedAt,current:i+1===a.current})).filter(x=>x.at!==undefined).reverse()};});
  const catalog=CATALOG.map(c=>({id:c.manifest.id,name:c.manifest.name,description:c.manifest.description,installed:v.apps.some(a=>a.id===appIdOf('catalog',undefined,c.manifest.id)&&a.current!==null)}));
  return {revision:s?.revision??0,apps,catalog};
 }
 /** Enabled apps for the rail and Work room tabs. */
 async rail(){const v=(await this.#state())?.value;return (v?.apps??[]).filter(a=>a.current!==null&&a.enabled).map(a=>{const m=a.versions[a.current!-1]!.package.manifest;return {id:a.id,name:a.name,page:!!m.contributes.page,item:m.handlers.includes('item'),roomTab:m.contributes.roomTab?.prefix??null};});}
 /** Decision cards: catalog apps in the Representative's conversation (null), self-made apps in their member's (conversation-cards.md shape plus `detail` and `remove`). */
 async decisions(memberId:string|null){
  const v=(await this.#state())?.value;if(!v)return [];const members=((await this.#store.load(MEMBERS_ID))?.value as MembersState|undefined)?.members??[];
  // The newest done card of an installed app carries Remove, so an update or rollback never leaves the owner without it.
  const latest=new Map<string,AppDecision>();for(const d of v.decisions)if(d.state==='done'&&(latest.get(d.appId)?.answeredAt??-1)<=d.answeredAt!)latest.set(d.appId,d);
  return v.decisions.filter(d=>d.state!=='stale').flatMap(d=>{const a=v.apps.find(x=>x.id===d.appId)!;if((a.memberId??null)!==memberId)return [];
   const offer=a.versions[d.version-1]!,m=offer.package.manifest,p=m.permissions,label=a.origin==='catalog'?a.name+' app':a.name,base=d.base===null?null:a.versions[d.base-1]!.package.manifest.version;
   const detail=a.origin==='self-made'?'Self-made app · Made by '+(members.find(x=>x.id===a.memberId)?.name??a.memberId)+' · '+m.version:a.name+' · '+(d.kind==='widen'&&base?base+' → ':'')+m.version;
   const rows:[string,string][]=a.origin==='self-made'?[['Does',m.description],['Read',joined(p.read)],['Write',joined(p.write)],['Network',joined(p.network)],['Files',joined(p.files)],['Token',joined(p.secrets.map(s=>s.label))],['Events',joined(p.events)],['Check',checkLine(offer.check)??'None'],['Source',a.source?.title??'None']]
    :[['Read',joined(p.read)],['Write',joined(p.write)],['Network',joined(p.network)],['Token',joined(p.secrets.map(s=>s.label))],['Events',joined(p.events)],['Adds',adds(m)]];
   const install=d.kind==='install',done=d.state==='done';
   return [{id:d.id,at:d.at,title:a.name,question:(install?'Install ':'Update ')+label+'?',detail,rows,action:install?'Install':'Update',state:d.state as 'open'|'later'|'done',
    ...(done?{line:install?label+' installed':label+' updated: '+m.version,...(a.current!==null&&d===latest.get(a.id)?{remove:a.id}:{})}:{})}];});
 }
 /** Runs an installed, enabled app's page or item handler in the worker, after the pinned hash is checked again. */
 async view(input:{app:unknown;handler:unknown;ref?:unknown}){
  const v=(await this.#state())?.value,a=v?.apps.find(x=>x.id===input.app);ensure(a&&a.current!==null,'Unknown app or not installed');ensure(a.enabled,'App is off','conflict');
  const cur=a.versions[a.current-1]!;ensure(packageHash(cur.package)===cur.hash,'Package changed after its check','conflict');
  ensure((input.handler==='page'||input.handler==='item')&&cur.package.manifest.handlers.includes(input.handler),'Unknown handler');
  if(input.handler==='item')ensure(typeof input.ref==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(input.ref)&&!/^\.+$/.test(input.ref),'Invalid ref');else ensure(input.ref===undefined,'A page takes no ref');
  return (await runHandler({appId:a.id,pkg:cur.package,handler:input.handler,input:input.handler==='item'?{ref:input.ref}:{},network:this.#network})).view;
 }
 /** Host step: a new catalog version (update). */
 async offer(input:{commandId:string;pkg:AppPackage;origin:'catalog'}){ensure(input.commandId.startsWith(HOST_PREFIX),'Host command identity required');return this.#dispatch(input.commandId,ASSISTANT_ACTOR_ID,{type:'offer-app',decisionId:appDecisionId(input.commandId),origin:'catalog',pkg:input.pkg});}
 /** Host step: a member packages a tool from a finished Work. The host scans it and runs its tests in the worker with only the test responses as network; the producer does not judge. */
 async offerSelfMade(input:{commandId:string;memberId:string;missionId:string;workId:string;pkg:AppPackage;tests:{handler:string;input:unknown;responses:Record<string,{status:number;body:string}>;expect:unknown}[]}){
  ensure(input.commandId.startsWith(HOST_PREFIX),'Host command identity required');
  const members=(await this.#store.load(MEMBERS_ID))?.value as MembersState|undefined;ensure(members?.members.some(m=>m.id===input.memberId),'Unknown member');
  const mission=(await this.#store.load(input.missionId))?.value as Mission|undefined,w=mission?.works?.find(x=>x.id===input.workId);ensure(w&&w.acceptance==='accepted'&&w.record,'Only an accepted Work with a Record is a source');
  const reject=(reason:string)=>this.#dispatch(input.commandId,ASSISTANT_ACTOR_ID,{type:'reject-app',memberId:input.memberId,pkg:input.pkg,reason});
  const reason=validatePackage(input.pkg);if(reason)return reject(reason);
  ensure(Array.isArray(input.tests)&&input.tests.length>=1&&input.tests.length<=8,'One to eight tests required');
  let passed=0,refused=0;
  for(const t of input.tests){
   const responses=t.responses&&typeof t.responses==='object'?t.responses:{},network:AppNetwork=async r=>Object.hasOwn(responses,r.url)?structuredClone(responses[r.url]!):{status:404,body:'{}'};
   try{const result=await runHandler({appId:appIdOf('self-made',input.memberId,input.pkg.manifest.id),pkg:input.pkg,handler:String(t.handler),input:t.input,network});refused+=result.refused;if(hash(result.view)===hash(t.expect))passed++;}
   catch(e){if(/^Not declared/.test((e as Error).message))refused++;}
  }
  if(refused)return reject('Uses undeclared permissions');if(passed<input.tests.length)return reject('Tests '+passed+'/'+input.tests.length+' passed');
  const check:AppCheck={tests:{passed,total:input.tests.length},declaredOnly:true,evidence:'Host ran '+passed+' tests in the app worker with test responses only'};
  return this.#dispatch(input.commandId,ASSISTANT_ACTOR_ID,{type:'offer-app',decisionId:appDecisionId(input.commandId),origin:'self-made',memberId:input.memberId,source:{missionId:input.missionId,workId:w.id,title:w.title},pkg:structuredClone(input.pkg),check});
 }
 /** Owner actions from Settings > Apps and the conversation. */
 async act(input:unknown):Promise<CommitResult<AppsState>>{
  const action=(input as {action?:unknown})?.action,fields:Record<string,string[]>={install:['catalogId'],disable:['appId'],enable:['appId'],remove:['appId'],rollback:['appId','version']};
  ensure(typeof action==='string'&&Object.hasOwn(fields,action)&&exact(input,['commandId','action',...fields[action]!])&&id(input.commandId),'Exact app action fields required');const commandId=this.#caller(input.commandId);
  if(action==='install'){const pkg=CATALOG.find(c=>c.manifest.id===input.catalogId);ensure(pkg,'Unknown catalog app');return this.#dispatch(commandId,OWNER,{type:'offer-app',decisionId:appDecisionId(commandId),origin:'catalog',pkg:structuredClone(pkg)});}
  if(action==='rollback')return this.#dispatch(commandId,OWNER,{type:'rollback-app',appId:input.appId as string,version:input.version as number,decisionId:appDecisionId(commandId)});
  return this.#dispatch(commandId,OWNER,{type:(action+'-app') as 'disable-app'|'enable-app'|'remove-app',appId:input.appId as string});
 }
 async decide(input:unknown):Promise<CommitResult<AppsState>>{
  ensure(exact(input,['commandId','decisionId','answer'])&&id(input.commandId)&&typeof input.decisionId==='string'&&input.decisionId.startsWith(DECISION_PREFIX)&&['act','later','ask'].includes(input.answer as string),'Exact decision answer fields required');
  return this.#dispatch(this.#caller(input.commandId),OWNER,{type:'decide-app',decisionId:input.decisionId as string,answer:input.answer as 'act'|'later'|'ask'});
 }
 #caller(commandId:unknown){ensure(id(commandId)&&!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');return commandId;}
 /** Lookup before and after the load, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,actorId:string,command:AppsCommand):Promise<CommitResult<AppsState>>{
  const identity={id:APPS_ID,commandId,fingerprint:fingerprint(actorId,command)},actor:Actor={id:actorId,roles:[actorId===ASSISTANT_ACTOR_ID?'assistant':'owner']};
  for(let attempt=0;attempt<3;attempt++){
   const prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const snapshot=await this.#state(),{value,events}=applyApps(snapshot?.value??null,command,actor,{observedAt:this.#clock()});
   const result=await this.#store.commit({id:APPS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
