import {createHmac,randomBytes,randomUUID} from 'node:crypto';
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
export interface BrowserPage {imageHash?:string;readId:string;expectedRevision:number;inputHash:string;at:number;address:string;title:string;blocks:string[];fields:{label:string;value:string;masked:boolean}[]}
export interface BrowserSession {id:string;pages:BrowserPage[]}
export function browserSummary(w:Work){const pages=w.browserSession?.pages;return pages?.length?{startedAt:pages[0]!.at,pagesRead:pages.length}:undefined;}
export interface BrowserAdapter {read(input:{address:string;sessionId:string;signal:AbortSignal}):Promise<RawBrowserPage>}
export type BrowserCommand={type:'record-browser-page';workId:string;sessionId:string;navigationId:string;page:BrowserPage};
type Capture={missionId:string;workId:string;readId:string;address:string};
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const text=(v:unknown,max=2000):v is string=>typeof v==='string'&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
function exact(v:unknown,keys:string[]):asserts v is Record<string,any>{ensure(!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Invalid browser fields');}
export function browserAddress(value:string){let u:URL;try{u=new URL(value);}catch{throw new DomainError('Invalid browser address');}ensure(['https:','http:'].includes(u.protocol),'Invalid browser address');u.username='';u.password='';u.search='';u.hash='';ensure(u.href.length<=2000,'Browser address bound exceeded');return u.href;}
export function browserUrlSecrets(value:string){
 const u=new URL(value),parts=[u.username,u.password,u.pathname,u.search.slice(1),u.hash.slice(1),...u.searchParams.keys(),...u.searchParams.values()],secrets=new Set<string>();
 for(let part of parts)for(let depth=0;;depth++){
  for(const value of [part,part.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,'')])for(const piece of [value,...value.split(/[/?#:\[\]@!$&'()*+,;=]/)])if(piece)secrets.add(piece);
  if(!/%[a-f0-9]{2}/i.test(part))break;if(depth===8)throw Error('Browser URL encoding bound exceeded');
  try{part=decodeURIComponent(part);}catch{throw Error('Invalid browser URL encoding');}
 }
 return [...secrets];
}
export function browserPrivateSeeds(values:string[]){
 const seeds=new Set(values.filter(Boolean)),queue=[...seeds].map(value=>({value,depth:0}));if(seeds.size>1024)throw Error('Browser private normalization bound exceeded');
 for(const {value,depth} of queue){
  if(value.length>4000)throw Error('Browser private normalization bound exceeded');
  const encoded=value.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu,''),next:string[]=[];
  if(/%[a-f0-9]{2}/i.test(encoded))try{next.push(decodeURIComponent(encoded));}catch{}
  if(/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded))try{const binary=atob(encoded.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''));next.push(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));}catch{}
  if(/^(?:[a-f0-9]{2})+$/i.test(encoded))try{next.push(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Uint8Array.from(encoded.match(/../g)!,pair=>parseInt(pair,16))));}catch{}
  for(const decoded of next)for(const part of [decoded,...decoded.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,'').split(/[/?#:\[\]@!$&'()*+,;=]/)]){if(!part||seeds.has(part))continue;if(depth>=8||seeds.size>=1024)throw Error('Browser private normalization bound exceeded');seeds.add(part);queue.push({value:part,depth:depth+1});}
 }
 return [...seeds];
}
export function sensitiveBrowserField(f:{label:string;name?:string;autocomplete?:string}){return /password|passwd|secret|token|one-time-code|auth|credential|api.?key|cc-|card|cvv|csc|cvc|payment|security|secure|code|otp|\bpin\b|보안|코드|카드|비밀|비번|인증|결제/i.test([f.label,f.name??'',f.autocomplete??''].join(' ').normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,''));}
export function maskBrowserField(f:{label:string;type:string;autocomplete:string;name?:string}){
 if(f.type==='hidden'||f.type==='password'||sensitiveBrowserField(f))return true;
 const benign=/^(이름|성명|주소|배송지|도서|책|제목|수량|날짜|시간|방|인원|name|full.?name|given-name|family-name|street-address|address-line[123]|address|title|quantity|qty|count|guests|room|date|time|isbn)$/i;
 const meanings=[f.label,f.name??'',f.autocomplete].map(v=>v.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,'').trim());
 return !['text','number','date','time','select-one','select-multiple'].includes(f.type)||!meanings[0]||!meanings.filter(Boolean).every(v=>benign.test(v));
}
export function browserPrivateRanges(value:string,secrets:string[]=[],encodingDepth=0,decode=true):Array<[number,number]>{
 if(decode&&encodingDepth===0)secrets=browserPrivateSeeds(secrets);
 const digits=(s:string)=>s.replace(/\p{Decimal_Number}/gu,d=>{if(d>='0'&&d<='9')return d;const code=d.codePointAt(0)!;let zero=code;while(zero>0&&/\p{Decimal_Number}/u.test(String.fromCodePoint(zero-1))){if(code-zero>=100)throw Error('Browser digit normalization bound exceeded');zero--;}return String((code-zero)%10);});
 const canonical=(s:string)=>digits(s.normalize('NFKC').toLowerCase().toUpperCase().normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,''));
 if(value.length>262144)throw Error('Browser text bound exceeded');
 const combine=(items:Array<[number,number]>)=>{const merged:Array<[number,number]>=[];for(const range of items.sort((a,b)=>a[0]-b[0]||b[1]-a[1])){const last=merged.at(-1);if(last&&range[0]<last[1])last[1]=Math.max(last[1],range[1]);else merged.push(range);}return merged;};
 const mapBack=(normalize:(text:string)=>string,nextDecode:boolean)=>{const starts:number[]=[],ends:number[]=[];let visible='';for(const {segment,index} of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(value)){const part=normalize(segment);visible+=part;for(let i=0;i<part.length;i++){starts.push(index);ends.push(index+segment.length);}}if(visible===value)throw Error('Browser text normalization failed');return browserPrivateRanges(visible,secrets,encodingDepth,nextDecode).map(([start,end]):[number,number]=>[starts[start]!,ends[end-1]!]);};
 const display=(text:string)=>digits(text.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,''));
 const exact:Array<[number,number]>=[];for(const secret of secrets){if(!secret)continue;let start=0;while((start=value.indexOf(secret,start))!==-1){exact.push([start,start+secret.length]);start+=secret.length;}}
 if(decode&&display(value)!==value)return combine([...exact,...mapBack(display,true)]);
 const encodedRanges=(decoded:string)=>{if(!decoded)return [];if(encodingDepth>=8)throw Error('Browser encoding bound exceeded');if(/%[a-f0-9]{2}/i.test(display(decoded).replace(/\s/g,'')))throw Error('Encoded browser text cannot be retained');return browserPrivateRanges(decoded,secrets,encodingDepth+1);};
 const ranges=decode?browserPrivateRanges(value,secrets,encodingDepth,false):exact;
 if(decode)for(const match of value.matchAll(/[A-Fa-f0-9](?:[A-Fa-f0-9\s\p{P}\p{S}]*[A-Fa-f0-9])?/gu)){
  if(ranges.some(([start,end])=>start<=match.index&&end>=match.index+match[0].length))continue;
  const digits=[...match[0].matchAll(/[A-Fa-f0-9]/g)],token=digits.map(d=>d[0]).join('');for(let offset=0;offset<2&&offset<token.length-1;offset++){
   const pairs=token.slice(offset).match(/../g)!,bytes=Uint8Array.from(pairs,pair=>parseInt(pair,16)),decoder=new TextDecoder('utf-8',{ignoreBOM:true}),starts:number[]=[],ends:number[]=[];let decoded='',pending=0;
   const append=(part:string,end:number)=>{decoded+=part;for(let i=0;i<part.length;i++){starts.push(pending);ends.push(end);}if(part)pending=end;};
   for(let i=0;i<bytes.length;i++)append(decoder.decode(bytes.subarray(i,i+1),{stream:true}),i+1);append(decoder.decode(),bytes.length);
   const found=encodedRanges(decoded);if(found.length){for(const [start,end] of found)ranges.push([match.index+digits[offset+starts[start]!*2]!.index,match.index+digits[offset+ends[end-1]!*2-1]!.index+1]);}
  }
 }
 if(decode)for(const match of value.matchAll(/[A-Za-z0-9+/_-](?:[A-Za-z0-9\s\p{P}\p{S}]*[A-Za-z0-9+/_-])?={0,2}/gu)){
  if(ranges.some(([start,end])=>start<=match.index&&end>=match.index+match[0].length))continue;
  const base=match[0].replace(/[^A-Za-z0-9+/_-]/g,''),symbols:number[]=[];for(const symbol of base.matchAll(/[+/_-]/g)){symbols.push(symbol.index);if(symbols.length>6)break;}
  if(symbols.length>6){ranges.push([match.index,match.index+match[0].length]);continue;}
  candidates: for(let bits=0;bits<2**symbols.length;bits++){
  let token='',start=0;for(let i=0;i<symbols.length;i++)if(bits&(1<<i)){token+=base.slice(start,symbols[i]);start=symbols[i]!+1;}token=(token+base.slice(start)).replace(/-/g,'+').replace(/_/g,'/');
  // 앞뒤의 일반 단어가 붙어도 네 가지 Base64 정렬에서 민감값을 확인합니다.
  for(let offset=0;offset<4&&offset<token.length-1;offset++){
   let candidate=token.slice(offset);if(candidate.length%4===1)candidate=candidate.slice(0,-1);
   let decoded:string;try{const binary=atob(candidate);decoded=new TextDecoder('utf-8',{ignoreBOM:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)));}catch{continue;}
   if(encodedRanges(decoded).length){ranges.push([match.index,match.index+match[0].length]);break candidates;}
  }
  }
 }
 if(decode)return combine(ranges);
 // Base64 원문은 대소문자를 바꾸기 전에만 디코딩합니다.
 const normalized=canonical(value);
 if(normalized!==value)return combine([...ranges,...mapBack(canonical,false)]);
 if(secrets.length){const positions:number[]=[],characters:string[]=[];for(let i=0;i<value.length;i++)if(!/\s/.test(value[i]!)){positions.push(i);characters.push(value[i]!);}const compact=characters.join('');
  const grouping=/(?<=[\p{L}0-9])[\p{P}\p{S}]{1,3}(?=[\p{L}0-9])/gu,gaps=[...compact.matchAll(grouping)],groupedPositions:number[]=[];let grouped='',gap=0;
  for(let i=0;i<compact.length;i++){if(gaps[gap]?.index===i){i+=gaps[gap++]![0].length-1;continue;}grouped+=compact[i];groupedPositions.push(positions[i]!);}
  const privateForms=(secret:string)=>{const literal=canonical(secret).replace(/\s/g,''),code=/^[+−(\p{Dash_Punctuation}]{0,2}[\p{L}0-9]+(?:[\p{P}\p{S}]{1,3}[\p{L}0-9]+)*\)?$/u.test(literal);return [literal,code?literal.replace(/[^\p{L}0-9]/gu,''):literal.replace(grouping,'')] as const;};
  const seeds=new Set(secrets.flatMap(secret=>[secret,...['NFC','NFD','NFKC','NFKD'].map(form=>secret.normalize(form)),...privateForms(secret)]).flatMap(secret=>[secret,secret.toLowerCase(),secret.toUpperCase()])),forms=new Set(seeds);
  for(const secret of seeds){let encoded=secret;for(let depth=0;encoded&&depth<8&&encoded.length<=value.length;depth++){encoded=btoa(String.fromCharCode(...new TextEncoder().encode(encoded)));const unpadded=encoded.replace(/=+$/,'');if(unpadded.length>value.length)break;for(const form of [encoded,unpadded]){forms.add(form);forms.add(form.replace(/\+/g,'-').replace(/\//g,'_'));}}}
  for(const secret of forms){const [literal,folded]=privateForms(secret);
   for(const [haystack,needle,offsets] of [[compact,literal,positions],[grouped,folded,groupedPositions]] as const){if(!needle)continue;let start=0;while((start=haystack.indexOf(needle,start))!==-1){ranges.push([offsets[start]!,offsets[start+needle.length-1]!+1]);start+=needle.length;}}
  }
 }
 for(const pattern of [/\b(?:\d[\s,.:\p{Dash_Punctuation}·٫٬'’()−_]{0,3}){13,19}\b/gu,/\b(?:Bearer\s+|(?:password|secret|token|api[\s_-]?key)\s*[:=]\s*)[^\s,;]+/gi])for(const match of value.matchAll(pattern))ranges.push([match.index,match.index+match[0].length]);
 return combine(ranges);
}
export function browserText(value:string,secrets:string[]=[]){let result='',offset=0;for(const [start,end] of browserPrivateRanges(value,secrets)){result+=value.slice(offset,start)+'••••';offset=end;}return result+value.slice(offset);}
export function validateBrowserScreenshot(image:unknown):asserts image is BrowserScreenshot{
 exact(image,['mimeType','data','width','height']);ensure(image.mimeType==='image/png'&&typeof image.data==='string'&&image.data.length<=262144&&/^[A-Za-z0-9+/]*={0,2}$/.test(image.data),'Invalid browser screenshot');
 const bytes=Buffer.from(image.data,'base64');ensure(bytes.length>=57&&bytes.toString('base64')===image.data&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex')),'Invalid browser screenshot PNG');
 ensure(Number.isSafeInteger(image.width)&&Number.isSafeInteger(image.height)&&image.width>0&&image.height>0&&image.width<=2048&&image.height<=2048&&bytes.readUInt32BE(16)===image.width&&bytes.readUInt32BE(20)===image.height,'Invalid browser screenshot dimensions');
}
function rejectEncodedBrowserText(page:Pick<BrowserPage,'title'|'blocks'|'fields'>){
 const text=[page.title,...page.blocks,...page.fields.flatMap(f=>[f.label,f.value])].join('').normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu,'');
 ensure(!/%[a-f0-9]{2}/i.test(text),'Encoded browser text cannot be retained');
}
export function sanitizePage(raw:RawBrowserPage,imageKey?:Uint8Array):Pick<BrowserPage,'address'|'title'|'blocks'|'fields'|'imageHash'>{
 exact(raw,['address','title','blocks','fields',...(Object.hasOwn(raw,'screenshot')?['screenshot']:[])]);if(Object.hasOwn(raw,'screenshot'))validateBrowserScreenshot(raw.screenshot);ensure(text(raw.address)&&text(raw.title)&&Array.isArray(raw.blocks)&&raw.blocks.length<=64&&raw.blocks.every(s=>text(s,4000))&&Array.isArray(raw.fields)&&raw.fields.length<=64,'Invalid browser page bound');
 for(const f of raw.fields){exact(f,['label','type','value','autocomplete',...(Object.hasOwn(f,'name')?['name']:[])]);ensure([f.label,f.type,f.value,f.autocomplete,...(Object.hasOwn(f,'name')?[f.name]:[])].every(s=>text(s,4000)),'Invalid browser form bound');}
 browserAddress(raw.address);const url=new URL(raw.address),urlSecrets=browserUrlSecrets(raw.address);
 const masked=raw.fields.map(f=>maskBrowserField(f)||browserText(f.label||f.name||f.autocomplete,urlSecrets)!==(f.label||f.name||f.autocomplete));
 const secrets=[...new Set([...urlSecrets,...raw.fields.filter((_,i)=>masked[i]).map(f=>f.value)].filter(Boolean))].sort((a,b)=>b.length-a.length);
 const clean=(s:string)=>browserText(s,secrets);
 const result={address:url.origin,title:clean(raw.title),blocks:raw.blocks.map(clean),fields:raw.fields.filter(f=>f.type!=='hidden').map(f=>({label:clean(f.label||f.name||f.autocomplete),value:masked[raw.fields.indexOf(f)]?'••••':clean(f.value),masked:masked[raw.fields.indexOf(f)]!}))};
 rejectEncodedBrowserText(result);ensure(JSON.stringify(result).length<=24000,'Browser page bound exceeded');if(raw.screenshot)ensure(imageKey?.byteLength===32,'Browser image key required');return {...result,...(raw.screenshot?{imageHash:'hmac-sha256:'+createHmac('sha256',imageKey!).update(Buffer.from(raw.screenshot.data,'base64')).digest('hex')}:{})};
}
export function validateBrowserSession(value:unknown):asserts value is BrowserSession{
 exact(value,['id','pages']);ensure(id(value.id)&&Array.isArray(value.pages)&&value.pages.length>0&&value.pages.length<=32,'Invalid browser session');let at=-1;const ids=new Set<string>();
 for(const p of value.pages){exact(p,['readId','expectedRevision','inputHash','at','address','title','blocks','fields',...(Object.hasOwn(p,'imageHash')?['imageHash']:[])]);if(Object.hasOwn(p,'imageHash'))ensure(typeof p.imageHash==='string'&&/^hmac-sha256:[a-f0-9]{64}$/.test(p.imageHash),'Invalid browser image hash');ensure(id(p.readId)&&!ids.has(p.readId)&&Number.isSafeInteger(p.expectedRevision)&&p.expectedRevision>0&&/^[a-f0-9]{64}$/.test(p.inputHash)&&Number.isSafeInteger(p.at)&&p.at>=at&&p.address===new URL(browserAddress(p.address)).origin&&text(p.title)&&Array.isArray(p.blocks)&&p.blocks.length<=64&&p.blocks.every((s:unknown)=>text(s,4000))&&Array.isArray(p.fields)&&p.fields.length<=64,'Invalid browser page');
  for(const f of p.fields){exact(f,['label','value','masked']);ensure(text(f.label,4000)&&text(f.value,4000)&&typeof f.masked==='boolean'&&(!f.masked||f.value==='••••')&&(f.masked||!maskBrowserField({label:f.label,type:'text',autocomplete:''}))&&browserText(f.label)===f.label&&browserText(f.value)===f.value,'Invalid browser form');}ensure(browserText(p.title)===p.title&&p.blocks.every((s:string)=>browserText(s)===s),'Invalid browser redaction');rejectEncodedBrowserText({title:p.title,blocks:p.blocks,fields:p.fields});ensure(JSON.stringify(p).length<=25000,'Browser page bound exceeded');at=p.at;ids.add(p.readId);
 }
}
function current(w:Work,at:number){ensure(w.acceptance==='pending'&&!['cancelled','settled'].includes(w.execution)&&!w.runtimeInterruption&&!w.runtimeRecovery,'Work no longer admits browser observations');ensure(!w.runtimeRun?.ownership||at<w.runtimeRun.ownership.deadlineAt,'Browser runtime deadline expired');}
export function applyBrowserPage(w:Work,c:BrowserCommand,actor:Actor){
 ensure(actor.id===BROWSER_HOST&&actor.roles.includes('representative'),'Only browser host authority records observations');exact(c,['type','workId','sessionId','navigationId','page']);ensure(id(c.navigationId),'Invalid browser navigation identity');validateBrowserSession({id:c.sessionId,pages:[c.page]});current(w,c.page.at);ensure(c.page.inputHash===workInputHash(w),'Work input changed');
 if(w.browserSession){ensure(w.browserSession.id===c.sessionId,'Browser session changed');ensure(w.browserSession.pages.length<32&&!w.browserSession.pages.some(p=>p.readId===c.page.readId),'Browser read identity conflict or bound');ensure(c.page.at>=w.browserSession.pages.at(-1)!.at,'Browser clock moved backwards');}
 else w.browserSession={id:c.sessionId,pages:[]};w.browserSession.pages.push(structuredClone(c.page));validateBrowserSession(w.browserSession);
}
function live(w:Work|undefined,at:number){return !!w&&w.execution==='active'&&w.acceptance==='pending'&&!w.runtimeInterruption&&!w.runtimeRecovery&&(!w.runtimeRun?.ownership||at<w.runtimeRun.ownership.deadlineAt);}
export class BrowserSessions {
 readonly #imageKey=randomBytes(32);readonly #bindings=new Map<string,{identity:string;navigationId:string}>();
 readonly #pendingImages=new Set<{missionId:string;workId:string;inputHash:string;valid:boolean}>();
 readonly #images=new Map<string,{missionId:string;workId:string;feedId:string;inputHash:string;imageHash:string;image:BrowserScreenshot;timer?:ReturnType<typeof setTimeout>}>();readonly #unsubscribe?:()=>void;#writes=0;
 #drop(key:string){const image=this.#images.get(key);if(image)clearTimeout(image.timer);this.#images.delete(key);}
 #prune(missionId?:string,mission?:Mission){for(const pending of this.#pendingImages){if(missionId!==undefined&&missionId!==pending.missionId)continue;const w=mission?.works?.find(w=>w.id===pending.workId);if(!live(w,this.#clock())||workInputHash(w!)!==pending.inputHash)pending.valid=false;}for(const [key,image] of this.#images){if(missionId!==undefined&&missionId!==image.missionId)continue;const w=mission?.works?.find(w=>w.id===image.workId);if(!live(w,this.#clock())||workInputHash(w!)!==image.inputHash)this.#drop(key);}}

 readonly #store:Store<Mission>;readonly #owner:Store<Mission>;readonly #adapter?:BrowserAdapter;readonly #clock:()=>number;readonly #active=new Map<string,{identity:string;promise:Promise<CommitResult<Mission>>}>();readonly #generation=new Map<string,number>();readonly #controllers=new Set<AbortController>();readonly #reads=new Set<Promise<RawBrowserPage>>();#draining=false;unsettled=false;
 constructor(store:Store<Mission>,ownerStore:Store<Mission>,options:{adapter?:BrowserAdapter;clock?:()=>number}={}){this.#store=store;this.#owner=ownerStore;this.#adapter=options.adapter;this.#clock=options.clock??Date.now;this.#unsubscribe=store.onWrite?.((id,value)=>{++this.#writes;this.#prune(id,value);});}
 capture(input:Capture):Promise<CommitResult<Mission>>{
  input=structuredClone(input);exact(input,['missionId','workId','readId','address']);ensure([input.missionId,input.workId,input.readId].every(id)&&input.address===browserAddress(input.address),'Invalid browser read request');
  const key=JSON.stringify([input.missionId,input.workId,input.readId]),identity=hash(input),active=this.#active.get(key);if(active){ensure(active.identity===identity,'Browser read identity conflict');return active.promise;}
  const workKey=JSON.stringify([input.missionId,input.workId]),generation=(this.#generation.get(workKey)??0)+1;this.#generation.set(workKey,generation);
  const promise=this.#capture(input,()=>this.#generation.get(workKey)===generation).finally(()=>this.#active.delete(key));this.#active.set(key,{identity,promise});return promise;
 }
 async #capture(input:Capture,isCurrent:()=>boolean):Promise<CommitResult<Mission>>{
  if(this.#draining)throw new HostDrainError();const state=await this.#store.readState(input.missionId),snapshot=state.snapshot,w=snapshot?.value.works.find(w=>w.id===input.workId);if(this.#draining)throw new HostDrainError();ensure(snapshot&&w,'Unknown browser Work');
  const sessionId=w.browserSession?.id??'browser:'+hash([state.feedId,input.missionId,input.workId]).slice(0,32),existing=w.browserSession?.pages.find(p=>p.readId===input.readId);
  const bindingKey=JSON.stringify([state.feedId,input.missionId,input.workId,input.readId]),identity=hash(input);let binding=this.#bindings.get(bindingKey);
  if(binding)ensure(binding.identity===identity,'Browser read identity conflict');else {ensure(!existing,'Browser read identity binding unavailable; use retained observation');binding={identity,navigationId:randomUUID()};this.#bindings.set(bindingKey,binding);while(this.#bindings.size>256)this.#bindings.delete(this.#bindings.keys().next().value!);}
  const navigationId=binding.navigationId;
  const admitted=new Proxy(this.#owner,{get:(target,key)=>{if(key==='commit')return (input:Parameters<typeof target.commit>[0])=>{ensure(isCurrent(),'Browser read superseded');current(w,this.#clock());return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),app=new Application(admitted,[{id:BROWSER_HOST,roles:['representative']}]);
  const dispatch=(page:BrowserPage)=>withAdmissionFeed(state.feedId,()=>app.dispatch({missionId:input.missionId,commandId:'assistant-browser:'+hash([input.missionId,input.workId,input.readId]).slice(0,48),expectedRevision:page.expectedRevision,actorId:BROWSER_HOST,command:{type:'record-browser-page',workId:input.workId,sessionId,navigationId,page}}));
  if(existing){ensure(existing.address===new URL(input.address).origin,'Browser read identity conflict');const result=await dispatch(existing);ensure(result.status!=='conflict','Browser read identity conflict');return result;}
  current(w,this.#clock());ensure((w.browserSession?.pages.length??0)<32,'Browser session page bound exceeded');ensure(this.#adapter,'Browser adapter unavailable');const controller=new AbortController();this.#controllers.add(controller);const pending={missionId:input.missionId,workId:input.workId,inputHash:workInputHash(w),valid:true};this.#pendingImages.add(pending);
  try{
   if(this.#draining)throw new HostDrainError();const raw=await callTool(signal=>{const read=Promise.resolve().then(()=>this.#adapter!.read({address:input.address,sessionId,signal}));this.#reads.add(read);void read.then(()=>this.#reads.delete(read),()=>this.#reads.delete(read));return read;},{readOnly:true,signal:controller.signal,timeoutMs:TOOL_TIMEOUT_MS});
   ensure(isCurrent(),'Browser read superseded');if(this.#draining)throw new HostDrainError();const fresh=await this.#store.readState(input.missionId);if(fresh.feedId!==state.feedId)throw new FeedAdmissionError();if(this.#draining)throw new HostDrainError();ensure(fresh.snapshot?.revision===snapshot.revision,'Work revision changed during browser read');
   ensure(browserAddress(raw.address)===input.address,'Browser address changed during read');
   const page:BrowserPage={readId:input.readId,expectedRevision:snapshot.revision,inputHash:workInputHash(w),at:this.#clock(),...sanitizePage(raw,this.#imageKey)},screenshot=raw.screenshot&&structuredClone(raw.screenshot);ensure(page.address===new URL(input.address).origin,'Browser origin changed during read');current(w,page.at);const result=await dispatch(page);
   if(result.status==='committed'&&screenshot&&this.#unsubscribe&&!this.#draining){const writes=this.#writes,latest=await this.#store.readState(input.missionId),active=latest.snapshot?.value.works.find(w=>w.id===input.workId);if(pending.valid&&isCurrent()&&!this.#draining&&writes===this.#writes&&latest.feedId===state.feedId&&live(active,this.#clock())&&workInputHash(active!)===page.inputHash&&active!.browserSession?.pages.some(p=>p.readId===page.readId&&p.imageHash===page.imageHash)){
    const key=JSON.stringify([input.missionId,input.workId,page.readId]);this.#drop(key);const image={missionId:input.missionId,workId:input.workId,feedId:state.feedId,inputHash:page.inputHash,imageHash:page.imageHash!,image:screenshot,timer:undefined as ReturnType<typeof setTimeout>|undefined};
    const deadline=active!.runtimeRun?.ownership?.deadlineAt;if(deadline!==undefined){image.timer=setTimeout(()=>this.#drop(key),Math.max(0,Math.min(2147483647,deadline-this.#clock())));image.timer.unref();}this.#images.set(key,image);
    while([...this.#images.values()].reduce((sum,i)=>sum+i.image.data.length,0)>1048576)this.#drop(this.#images.keys().next().value!);
   }}return result;
  }catch(error){if(error instanceof Error&&error.name==='CommitOutcomeUnknownError')this.unsettled=true;throw error;}finally{this.#pendingImages.delete(pending);this.#controllers.delete(controller);}
 }
 async read(missionId:string,workId:string){const state=await this.#store.readState(missionId),w=state.snapshot?.value.works.find(w=>w.id===workId);this.#prune(missionId,state.snapshot?.value);for(const [key,image] of this.#images)if(image.feedId!==state.feedId)this.#drop(key);ensure(w,'Unknown browser Work');const s=w.browserSession;if(s)validateBrowserSession(s);
  const pages=s?.pages.map(page=>{const image=this.#images.get(JSON.stringify([missionId,workId,page.readId]));return {...structuredClone(page),...(!this.#draining&&live(w,this.#clock())&&image&&image.imageHash===page.imageHash?{screenshot:structuredClone(image.image)}:{})};});
  return {feedId:state.feedId,revision:state.snapshot!.revision,session:s&&pages?{id:s.id,active:live(w,this.#clock())&&!this.#draining,startedAt:s.pages[0]!.at,pagesRead:s.pages.length,page:pages.at(-1)!,pages}:null};}
 beginDrain(){this.#draining=true;this.#bindings.clear();this.#imageKey.fill(0);this.#unsubscribe?.();for(const key of this.#images.keys())this.#drop(key);for(const c of this.#controllers)c.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active.values()].map(v=>v.promise));await Promise.allSettled([...this.#reads]);if(this.unsettled)throw Error('Browser bookkeeping is unsettled');}
}
