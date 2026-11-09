import {Application} from './application.ts';
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Actor,Mission,Work} from './domain.ts';
import type {Store,CommitResult} from './storage.ts';
import {FeedAdmissionError,withAdmissionFeed} from './storage.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import {callTool,TOOL_TIMEOUT_MS} from './tool-call.ts';

export const BROWSER_HOST='browser-read-host';
export interface RawBrowserPage {address:string;title:string;blocks:string[];fields:{label:string;type:string;value:string;autocomplete:string}[]}
export interface BrowserPage {readId:string;expectedRevision:number;inputHash:string;at:number;address:string;title:string;blocks:string[];fields:{label:string;value:string;masked:boolean}[]}
export interface BrowserSession {id:string;pages:BrowserPage[]}
export function browserSummary(w:Work){const pages=w.browserSession?.pages;return pages?.length?{startedAt:pages[0]!.at,pagesRead:pages.length}:undefined;}
export interface BrowserAdapter {read(input:{address:string;sessionId:string;signal:AbortSignal}):Promise<RawBrowserPage>}
export type BrowserCommand={type:'record-browser-page';workId:string;sessionId:string;requestAddress:string;page:BrowserPage};
type Capture={missionId:string;workId:string;readId:string;address:string};
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const text=(v:unknown,max=2000):v is string=>typeof v==='string'&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
function exact(v:unknown,keys:string[]):asserts v is Record<string,any>{ensure(!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Invalid browser fields');}
export function browserAddress(value:string){let u:URL;try{u=new URL(value);}catch{throw new DomainError('Invalid browser address');}ensure(['https:','http:'].includes(u.protocol),'Invalid browser address');u.username='';u.password='';u.search='';u.hash='';ensure(u.href.length<=2000,'Browser address bound exceeded');return u.href;}
const sensitive=/password|passwd|secret|token|auth|credential|api.?key|cc-|card|cvv|cvc|payment|pin|otp|카드|비밀|비번|인증|결제/i;
const scrub=(s:string)=>s.replace(/\b(?:\d[ -]?){13,19}\b/g,'••••').replace(/\b(?:Bearer\s+|(?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'••••');
export function sanitizePage(raw:RawBrowserPage):Pick<BrowserPage,'address'|'title'|'blocks'|'fields'>{
 exact(raw,['address','title','blocks','fields']);ensure(text(raw.address)&&text(raw.title)&&Array.isArray(raw.blocks)&&raw.blocks.length<=64&&raw.blocks.every(s=>text(s,4000))&&Array.isArray(raw.fields)&&raw.fields.length<=64,'Invalid browser page bound');
 for(const f of raw.fields){exact(f,['label','type','value','autocomplete']);ensure([f.label,f.type,f.value,f.autocomplete].every(s=>text(s,4000)),'Invalid browser form bound');}
 const masked=raw.fields.map(f=>f.type==='hidden'||f.type==='password'||sensitive.test(f.label+' '+f.autocomplete)||!['number','checkbox','radio','select-one','select-multiple','date','time'].includes(f.type)&&!/이름|성명|주소|도서|책|제목|수량|name|address|title|quantity|isbn/i.test(f.label));
 browserAddress(raw.address);const url=new URL(raw.address);
 const secrets=[url.username,url.password,url.hash.slice(1),...url.searchParams.values(),...raw.fields.filter((_,i)=>masked[i]).map(f=>f.value)].filter(Boolean).sort((a,b)=>b.length-a.length);
 const clean=(s:string)=>scrub(secrets.reduce((value,secret)=>value.split(secret).join('••••'),s));
 const result={address:clean(browserAddress(raw.address)),title:clean(raw.title),blocks:raw.blocks.map(clean),fields:raw.fields.filter(f=>f.type!=='hidden').map(f=>({label:clean(f.label),value:masked[raw.fields.indexOf(f)]?'••••':clean(f.value),masked:masked[raw.fields.indexOf(f)]!}))};
 ensure(JSON.stringify(result).length<=24000,'Browser page bound exceeded');return result;
}
export function validateBrowserSession(value:unknown):asserts value is BrowserSession{
 exact(value,['id','pages']);ensure(id(value.id)&&Array.isArray(value.pages)&&value.pages.length>0&&value.pages.length<=32,'Invalid browser session');let at=-1;const ids=new Set<string>();
 for(const p of value.pages){exact(p,['readId','expectedRevision','inputHash','at','address','title','blocks','fields']);ensure(id(p.readId)&&!ids.has(p.readId)&&Number.isSafeInteger(p.expectedRevision)&&p.expectedRevision>0&&/^[a-f0-9]{64}$/.test(p.inputHash)&&Number.isSafeInteger(p.at)&&p.at>=at&&p.address===browserAddress(p.address)&&text(p.title)&&Array.isArray(p.blocks)&&p.blocks.length<=64&&p.blocks.every((s:unknown)=>text(s,4000))&&Array.isArray(p.fields)&&p.fields.length<=64,'Invalid browser page');
  for(const f of p.fields){exact(f,['label','value','masked']);ensure(text(f.label,4000)&&text(f.value,4000)&&typeof f.masked==='boolean'&&(!f.masked||f.value==='••••')&&(!sensitive.test(f.label)||f.masked)&&scrub(f.label)===f.label&&scrub(f.value)===f.value,'Invalid browser form');}ensure(scrub(p.title)===p.title&&p.blocks.every((s:string)=>scrub(s)===s),'Invalid browser redaction');ensure(JSON.stringify(p).length<=25000,'Browser page bound exceeded');at=p.at;ids.add(p.readId);
 }
}
function current(w:Work,at:number){ensure(w.acceptance==='pending'&&!['cancelled','settled'].includes(w.execution)&&!w.runtimeInterruption&&!w.runtimeRecovery,'Work no longer admits browser observations');ensure(!w.runtimeRun?.ownership||at<w.runtimeRun.ownership.deadlineAt,'Browser runtime deadline expired');}
export function applyBrowserPage(w:Work,c:BrowserCommand,actor:Actor){
 ensure(actor.id===BROWSER_HOST&&actor.roles.includes('representative'),'Only browser host authority records observations');exact(c,['type','workId','sessionId','requestAddress','page']);ensure(c.requestAddress===c.page.address,'Browser address changed');validateBrowserSession({id:c.sessionId,pages:[c.page]});current(w,c.page.at);ensure(c.page.inputHash===workInputHash(w),'Work input changed');
 if(w.browserSession){ensure(w.browserSession.id===c.sessionId,'Browser session changed');ensure(w.browserSession.pages.length<32&&!w.browserSession.pages.some(p=>p.readId===c.page.readId),'Browser read identity conflict or bound');ensure(c.page.at>=w.browserSession.pages.at(-1)!.at,'Browser clock moved backwards');}
 else w.browserSession={id:c.sessionId,pages:[]};w.browserSession.pages.push(structuredClone(c.page));
}
export class BrowserSessions {
 readonly #store:Store<Mission>;readonly #owner:Store<Mission>;readonly #adapter?:BrowserAdapter;readonly #clock:()=>number;readonly #active=new Map<string,{identity:string;promise:Promise<CommitResult<Mission>>}>();readonly #generation=new Map<string,number>();readonly #controllers=new Set<AbortController>();#draining=false;unsettled=false;
 constructor(store:Store<Mission>,ownerStore:Store<Mission>,options:{adapter?:BrowserAdapter;clock?:()=>number}={}){this.#store=store;this.#owner=ownerStore;this.#adapter=options.adapter;this.#clock=options.clock??Date.now;}
 capture(input:Capture):Promise<CommitResult<Mission>>{
  input=structuredClone(input);exact(input,['missionId','workId','readId','address']);ensure([input.missionId,input.workId,input.readId].every(id)&&input.address===browserAddress(input.address),'Invalid browser read request');
  const key=JSON.stringify([input.missionId,input.workId,input.readId]),identity=hash(input),active=this.#active.get(key);if(active){ensure(active.identity===identity,'Browser read identity conflict');return active.promise;}
  const workKey=JSON.stringify([input.missionId,input.workId]),generation=(this.#generation.get(workKey)??0)+1;this.#generation.set(workKey,generation);
  const promise=this.#capture(input,()=>this.#generation.get(workKey)===generation).finally(()=>this.#active.delete(key));this.#active.set(key,{identity,promise});return promise;
 }
 async #capture(input:Capture,isCurrent:()=>boolean):Promise<CommitResult<Mission>>{
  if(this.#draining)throw new HostDrainError();const state=await this.#store.readState(input.missionId),snapshot=state.snapshot,w=snapshot?.value.works.find(w=>w.id===input.workId);ensure(snapshot&&w,'Unknown browser Work');
  const sessionId=w.browserSession?.id??'browser:'+hash([state.feedId,input.missionId,input.workId]).slice(0,32),existing=w.browserSession?.pages.find(p=>p.readId===input.readId),app=new Application(this.#owner,[{id:BROWSER_HOST,roles:['representative']}]);
  const dispatch=(page:BrowserPage)=>withAdmissionFeed(state.feedId,()=>app.dispatch({missionId:input.missionId,commandId:'assistant-browser:'+hash([input.missionId,input.workId,input.readId]).slice(0,48),expectedRevision:page.expectedRevision,actorId:BROWSER_HOST,command:{type:'record-browser-page',workId:input.workId,sessionId,requestAddress:input.address,page}}));
  if(existing){ensure(existing.address===input.address,'Browser read identity conflict');return dispatch(existing);}
  current(w,this.#clock());ensure((w.browserSession?.pages.length??0)<32,'Browser session page bound exceeded');ensure(this.#adapter,'Browser adapter unavailable');const controller=new AbortController();this.#controllers.add(controller);
  try{
   if(this.#draining)throw new HostDrainError();const raw=await callTool(signal=>this.#adapter!.read({address:input.address,sessionId,signal}),{readOnly:true,signal:controller.signal,timeoutMs:TOOL_TIMEOUT_MS});
   ensure(isCurrent(),'Browser read superseded');if(this.#draining)throw new HostDrainError();const fresh=await this.#store.readState(input.missionId);if(fresh.feedId!==state.feedId)throw new FeedAdmissionError();ensure(fresh.snapshot?.revision===snapshot.revision,'Work revision changed during browser read');
   const page:BrowserPage={readId:input.readId,expectedRevision:snapshot.revision,inputHash:workInputHash(w),at:this.#clock(),...sanitizePage(raw)};ensure(page.address===input.address,'Browser address changed during read');current(w,page.at);return await dispatch(page);
  }catch(error){if(error instanceof Error&&error.name==='CommitOutcomeUnknownError')this.unsettled=true;throw error;}finally{this.#controllers.delete(controller);}
 }
 async read(missionId:string,workId:string){const state=await this.#store.readState(missionId),w=state.snapshot?.value.works.find(w=>w.id===workId);ensure(w,'Unknown browser Work');const s=w.browserSession;return {feedId:state.feedId,revision:state.snapshot!.revision,session:s?{id:s.id,startedAt:s.pages[0]!.at,pagesRead:s.pages.length,page:structuredClone(s.pages.at(-1)!)}:null};}
 beginDrain(){this.#draining=true;for(const c of this.#controllers)c.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active.values()].map(v=>v.promise));if(this.unsettled)throw Error('Browser bookkeeping is unsettled');}
}
