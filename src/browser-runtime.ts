import {Application} from './application.ts';
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Actor,Mission,Work} from './domain.ts';
import type {Store,CommitResult} from './storage.ts';
import {FeedAdmissionError,withAdmissionFeed} from './storage.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import {callTool,TOOL_TIMEOUT_MS} from './tool-call.ts';

export const BROWSER_HOST='browser-read-host';
export interface BrowserScreenshot {mimeType:'image/png';data:string;width:number;height:number}
export interface RawBrowserPage {screenshot?:BrowserScreenshot;address:string;title:string;blocks:string[];fields:{label:string;type:string;value:string;autocomplete:string;name?:string}[]}
export interface BrowserPage {screenshot?:BrowserScreenshot;readId:string;expectedRevision:number;inputHash:string;at:number;address:string;title:string;blocks:string[];fields:{label:string;value:string;masked:boolean}[]}
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
export function sensitiveBrowserField(f:{label:string;name?:string;autocomplete?:string}){return /password|passwd|secret|token|one-time-code|auth|credential|api.?key|cc-|card|cvv|csc|cvc|payment|security|secure|code|otp|\bpin\b|보안|코드|카드|비밀|비번|인증|결제/i.test([f.label,f.name??'',f.autocomplete??''].join(' ').normalize('NFKC'));}
export function maskBrowserField(f:{label:string;type:string;autocomplete:string;name?:string}){
 if(f.type==='hidden'||f.type==='password'||sensitiveBrowserField(f))return true;
 const benign=/^(이름|성명|주소|배송지|도서|책|제목|수량|날짜|시간|방|인원|name|full.?name|given-name|family-name|street-address|address-line[123]|address|title|quantity|qty|count|guests|room|date|time|isbn)$/i;
 return !['text','number','date','time','select-one','select-multiple'].includes(f.type)||![f.label,f.name??'',f.autocomplete].some(v=>benign.test(v.trim()));
}
export function browserPrivateRanges(value:string,secrets:string[]=[]):Array<[number,number]>{
 const ranges:Array<[number,number]>=[];
 if(secrets.length){const positions:number[]=[],characters:string[]=[];for(let i=0;i<value.length;i++)if(!/\s/.test(value[i]!)){positions.push(i);characters.push(value[i]!);}const compact=characters.join('');
  for(const secret of secrets){const needle=secret.replace(/\s/g,'');if(!needle)continue;let start=0;while((start=compact.indexOf(needle,start))!==-1){ranges.push([positions[start]!,positions[start+needle.length-1]!+1]);start+=needle.length;}}
 }
 for(const pattern of [/\b(?:\d[ -]?){13,19}\b/g,/\b(?:Bearer\s+|(?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi])for(const match of value.matchAll(pattern))ranges.push([match.index,match.index+match[0].length]);
 const merged:Array<[number,number]>=[];for(const range of ranges.sort((a,b)=>a[0]-b[0]||b[1]-a[1])){const last=merged.at(-1);if(last&&range[0]<last[1])last[1]=Math.max(last[1],range[1]);else merged.push(range);}return merged;
}
export function browserText(value:string,secrets:string[]=[]){let result='',offset=0;for(const [start,end] of browserPrivateRanges(value,secrets)){result+=value.slice(offset,start)+'••••';offset=end;}return result+value.slice(offset);}
export function validateBrowserScreenshot(image:unknown):asserts image is BrowserScreenshot{
 exact(image,['mimeType','data','width','height']);ensure(image.mimeType==='image/png'&&typeof image.data==='string'&&image.data.length<=262144&&/^[A-Za-z0-9+/]*={0,2}$/.test(image.data),'Invalid browser screenshot');
 const bytes=Buffer.from(image.data,'base64');ensure(bytes.length>=57&&bytes.toString('base64')===image.data&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex')),'Invalid browser screenshot PNG');
 ensure(Number.isSafeInteger(image.width)&&Number.isSafeInteger(image.height)&&image.width>0&&image.height>0&&image.width<=2048&&image.height<=2048&&bytes.readUInt32BE(16)===image.width&&bytes.readUInt32BE(20)===image.height,'Invalid browser screenshot dimensions');
}
export function sanitizePage(raw:RawBrowserPage):Pick<BrowserPage,'address'|'title'|'blocks'|'fields'|'screenshot'>{
 exact(raw,['address','title','blocks','fields',...(Object.hasOwn(raw,'screenshot')?['screenshot']:[])]);if(Object.hasOwn(raw,'screenshot'))validateBrowserScreenshot(raw.screenshot);ensure(text(raw.address)&&text(raw.title)&&Array.isArray(raw.blocks)&&raw.blocks.length<=64&&raw.blocks.every(s=>text(s,4000))&&Array.isArray(raw.fields)&&raw.fields.length<=64,'Invalid browser page bound');
 for(const f of raw.fields){exact(f,['label','type','value','autocomplete',...(Object.hasOwn(f,'name')?['name']:[])]);ensure([f.label,f.type,f.value,f.autocomplete,...(Object.hasOwn(f,'name')?[f.name]:[])].every(s=>text(s,4000)),'Invalid browser form bound');}
 const masked=raw.fields.map(maskBrowserField);
 browserAddress(raw.address);const url=new URL(raw.address);
 const secrets=[url.username,url.password,url.hash.slice(1),...url.searchParams.values(),...raw.fields.filter((_,i)=>masked[i]).map(f=>f.value)].filter(Boolean).sort((a,b)=>b.length-a.length);
 const clean=(s:string)=>browserText(s,secrets);
 const result={address:clean(browserAddress(raw.address)),title:clean(raw.title),blocks:raw.blocks.map(clean),fields:raw.fields.filter(f=>f.type!=='hidden').map(f=>({label:clean(f.label),value:masked[raw.fields.indexOf(f)]?'••••':clean(f.value),masked:masked[raw.fields.indexOf(f)]!}))};
 ensure(JSON.stringify(result).length<=24000,'Browser page bound exceeded');return {...result,...(raw.screenshot?{screenshot:structuredClone(raw.screenshot)}:{})};
}
export function validateBrowserSession(value:unknown):asserts value is BrowserSession{
 exact(value,['id','pages']);ensure(id(value.id)&&Array.isArray(value.pages)&&value.pages.length>0&&value.pages.length<=32,'Invalid browser session');let at=-1;const ids=new Set<string>();
 for(const p of value.pages){exact(p,['readId','expectedRevision','inputHash','at','address','title','blocks','fields',...(Object.hasOwn(p,'screenshot')?['screenshot']:[])]);if(Object.hasOwn(p,'screenshot'))validateBrowserScreenshot(p.screenshot);ensure(id(p.readId)&&!ids.has(p.readId)&&Number.isSafeInteger(p.expectedRevision)&&p.expectedRevision>0&&/^[a-f0-9]{64}$/.test(p.inputHash)&&Number.isSafeInteger(p.at)&&p.at>=at&&p.address===browserAddress(p.address)&&text(p.title)&&Array.isArray(p.blocks)&&p.blocks.length<=64&&p.blocks.every((s:unknown)=>text(s,4000))&&Array.isArray(p.fields)&&p.fields.length<=64,'Invalid browser page');
  for(const f of p.fields){exact(f,['label','value','masked']);ensure(text(f.label,4000)&&text(f.value,4000)&&typeof f.masked==='boolean'&&(!f.masked||f.value==='••••')&&(!sensitiveBrowserField({label:f.label})||f.masked)&&browserText(f.label)===f.label&&browserText(f.value)===f.value,'Invalid browser form');}ensure(browserText(p.title)===p.title&&p.blocks.every((s:string)=>browserText(s)===s),'Invalid browser redaction');const {screenshot,...metadata}=p;ensure(JSON.stringify(metadata).length<=25000,'Browser page bound exceeded');at=p.at;ids.add(p.readId);
 }
 ensure(value.pages.reduce((sum:number,p:BrowserPage)=>sum+(p.screenshot?.data.length??0),0)<=1048576,'Browser screenshot session bound exceeded');
}
function current(w:Work,at:number){ensure(w.acceptance==='pending'&&!['cancelled','settled'].includes(w.execution)&&!w.runtimeInterruption&&!w.runtimeRecovery,'Work no longer admits browser observations');ensure(!w.runtimeRun?.ownership||at<w.runtimeRun.ownership.deadlineAt,'Browser runtime deadline expired');}
export function applyBrowserPage(w:Work,c:BrowserCommand,actor:Actor){
 ensure(actor.id===BROWSER_HOST&&actor.roles.includes('representative'),'Only browser host authority records observations');exact(c,['type','workId','sessionId','requestAddress','page']);ensure(c.requestAddress===c.page.address,'Browser address changed');validateBrowserSession({id:c.sessionId,pages:[c.page]});current(w,c.page.at);ensure(c.page.inputHash===workInputHash(w),'Work input changed');
 if(w.browserSession){ensure(w.browserSession.id===c.sessionId,'Browser session changed');ensure(w.browserSession.pages.length<32&&!w.browserSession.pages.some(p=>p.readId===c.page.readId),'Browser read identity conflict or bound');ensure(c.page.at>=w.browserSession.pages.at(-1)!.at,'Browser clock moved backwards');}
 else w.browserSession={id:c.sessionId,pages:[]};w.browserSession.pages.push(structuredClone(c.page));validateBrowserSession(w.browserSession);
}
export class BrowserSessions {
 readonly #store:Store<Mission>;readonly #owner:Store<Mission>;readonly #adapter?:BrowserAdapter;readonly #clock:()=>number;readonly #active=new Map<string,{identity:string;promise:Promise<CommitResult<Mission>>}>();readonly #generation=new Map<string,number>();readonly #controllers=new Set<AbortController>();readonly #reads=new Set<Promise<RawBrowserPage>>();#draining=false;unsettled=false;
 constructor(store:Store<Mission>,ownerStore:Store<Mission>,options:{adapter?:BrowserAdapter;clock?:()=>number}={}){this.#store=store;this.#owner=ownerStore;this.#adapter=options.adapter;this.#clock=options.clock??Date.now;}
 capture(input:Capture):Promise<CommitResult<Mission>>{
  input=structuredClone(input);exact(input,['missionId','workId','readId','address']);ensure([input.missionId,input.workId,input.readId].every(id)&&input.address===browserAddress(input.address),'Invalid browser read request');
  const key=JSON.stringify([input.missionId,input.workId,input.readId]),identity=hash(input),active=this.#active.get(key);if(active){ensure(active.identity===identity,'Browser read identity conflict');return active.promise;}
  const workKey=JSON.stringify([input.missionId,input.workId]),generation=(this.#generation.get(workKey)??0)+1;this.#generation.set(workKey,generation);
  const promise=this.#capture(input,()=>this.#generation.get(workKey)===generation).finally(()=>this.#active.delete(key));this.#active.set(key,{identity,promise});return promise;
 }
 async #capture(input:Capture,isCurrent:()=>boolean):Promise<CommitResult<Mission>>{
  if(this.#draining)throw new HostDrainError();const state=await this.#store.readState(input.missionId),snapshot=state.snapshot,w=snapshot?.value.works.find(w=>w.id===input.workId);ensure(snapshot&&w,'Unknown browser Work');
  const sessionId=w.browserSession?.id??'browser:'+hash([state.feedId,input.missionId,input.workId]).slice(0,32),existing=w.browserSession?.pages.find(p=>p.readId===input.readId);
  const admitted=new Proxy(this.#owner,{get:(target,key)=>{if(key==='commit')return (input:Parameters<typeof target.commit>[0])=>{ensure(isCurrent(),'Browser read superseded');current(w,this.#clock());return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),app=new Application(admitted,[{id:BROWSER_HOST,roles:['representative']}]);
  const dispatch=(page:BrowserPage)=>withAdmissionFeed(state.feedId,()=>app.dispatch({missionId:input.missionId,commandId:'assistant-browser:'+hash([input.missionId,input.workId,input.readId]).slice(0,48),expectedRevision:page.expectedRevision,actorId:BROWSER_HOST,command:{type:'record-browser-page',workId:input.workId,sessionId,requestAddress:input.address,page}}));
  if(existing){ensure(existing.address===input.address,'Browser read identity conflict');return dispatch(existing);}
  current(w,this.#clock());ensure((w.browserSession?.pages.length??0)<32,'Browser session page bound exceeded');ensure(this.#adapter,'Browser adapter unavailable');const controller=new AbortController();this.#controllers.add(controller);
  try{
   if(this.#draining)throw new HostDrainError();const raw=await callTool(signal=>{const read=Promise.resolve().then(()=>this.#adapter!.read({address:input.address,sessionId,signal}));this.#reads.add(read);void read.then(()=>this.#reads.delete(read),()=>this.#reads.delete(read));return read;},{readOnly:true,signal:controller.signal,timeoutMs:TOOL_TIMEOUT_MS});
   ensure(isCurrent(),'Browser read superseded');if(this.#draining)throw new HostDrainError();const fresh=await this.#store.readState(input.missionId);if(fresh.feedId!==state.feedId)throw new FeedAdmissionError();ensure(fresh.snapshot?.revision===snapshot.revision,'Work revision changed during browser read');
   const page:BrowserPage={readId:input.readId,expectedRevision:snapshot.revision,inputHash:workInputHash(w),at:this.#clock(),...sanitizePage(raw)};ensure(page.address===input.address,'Browser address changed during read');current(w,page.at);return await dispatch(page);
  }catch(error){if(error instanceof Error&&error.name==='CommitOutcomeUnknownError')this.unsettled=true;throw error;}finally{this.#controllers.delete(controller);}
 }
 async read(missionId:string,workId:string){const state=await this.#store.readState(missionId),w=state.snapshot?.value.works.find(w=>w.id===workId);ensure(w,'Unknown browser Work');const s=w.browserSession;return {feedId:state.feedId,revision:state.snapshot!.revision,session:s?{id:s.id,startedAt:s.pages[0]!.at,pagesRead:s.pages.length,page:structuredClone(s.pages.at(-1)!),pages:structuredClone(s.pages)}:null};}
 beginDrain(){this.#draining=true;for(const c of this.#controllers)c.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active.values()].map(v=>v.promise));await Promise.allSettled([...this.#reads]);if(this.unsettled)throw Error('Browser bookkeeping is unsettled');}
}
