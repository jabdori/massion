/**
 * The client connection kind on the supervisor's user-only socket.
 *
 * First line "client", then one JSON object per line in both directions
 * (plans/2026-11-16-tauri-move-design.md section 2):
 * - client request: {"id","method","path","headers"?,"body"?,"origin"?}
 * - reply: {"id","status","headers","body"?} | {"id","error":{"code","message"}}
 * - daemon event: {"event":"message","subscription","lastEventId"?,"data"}
 *   {"event":"error","subscription"} {"event":"notification","key","title"}
 *   {"event":"focus","target"}
 * - client event: {"event":"ready"} {"event":"notification-clicked","key"}
 *   {"event":"close","subscription"}
 *
 * The relay rules are the ones desktop/main.ts applies today: the three
 * protocol paths, the app document, published massion-app documents, the
 * 48 KiB body limit, the CSP from desktop/security.ts and the notification
 * decision from desktop/notifications.ts. The core credential never leaves
 * this process: the supervisor performs the authenticated core calls itself.
 */
import {readFile} from 'node:fs/promises';
import type {Socket} from 'node:net';
import {AppDocuments,appDocumentHeaders} from '../src/app-documents.ts';
import {createProtocolClient} from '../src/client-protocol.ts';
import {contentPolicy,tauriConnectSources} from './security.ts';
import {daemonOrigin,daemonTransport,proxyProtocol} from './transport.ts';
import {authenticatedFetch} from './auth.ts';
import {DesktopLifecycle} from './lifecycle.ts';
import {ExceptionTracker} from './notifications.ts';
import type {OwnerException} from './notifications.ts';

export const clientLimits={requestLineBytes:65536,responseLineBytes:4194304,pending:64,subscriptions:4,requestTimeoutMs:30000,bodyBytes:49152,sseBufferBytes:1048576} as const;

const INVALID='The desktop relay refused the request',UPSTREAM='The desktop relay could not complete the request';
type Reply={id:string;status:number;headers:Record<string,string>;body?:string}|{id:string;error:{code:string;message:string}};
type Subscription={abort:AbortController};
interface Connection{socket:Socket;ready:boolean;buffer:Buffer;closed:boolean;pending:number;subscriptions:Map<string,Subscription>}
const decoder=new TextDecoder();

export interface ClientServiceOptions{origin:string;secret:string;htmlCandidates:string[];settingsFile:string;version:string;stopCore:()=>Promise<void>;startCore:()=>void;observeIntervalMs?:number;requestTimeoutMs?:number;onSubscribeError?:(fact:SubscribeErrorFact)=>void}

export interface SubscribeErrorFact{name:string;code:string|undefined;causeCode:string|undefined;message:string;way:'fetch'|'refused'|'bound'|'ended';elapsedMs:number;beforeHeaders:boolean;reused:boolean|undefined}

export function createClientService(options:ClientServiceOptions){
 const origin=daemonOrigin(options.origin),credential=async()=>options.secret;
 const documents=new AppDocuments(),tracker=new ExceptionTracker(),client=createProtocolClient(daemonTransport(origin,credential));
 const connections=new Set<Connection>(),pendingTargets=new Map<string,OwnerException>();
 let html:{content:string;policy:string}|undefined,closing=false,observing=false,timer:ReturnType<typeof setTimeout>|undefined,lifecycleReady:Promise<DesktopLifecycle>|undefined;

 async function loadHtml(){
  if(html)return html;
  for(const candidate of options.htmlCandidates){
   try{const content=await readFile(candidate,'utf8');html={content,policy:contentPolicy(content,[...tauriConnectSources])};return html;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  throw new Error('Desktop app document missing');
 }
 function lifecycle(){
  return lifecycleReady??=DesktopLifecycle.open(options.settingsFile,options.version,async()=>{await options.stopCore();return {status:'drained'};},options.startCore);
 }

 function write(connection:Connection,value:Record<string,unknown>){
  if(connection.closed||connection.socket.destroyed)return;
  let line=JSON.stringify(value);
  // The serialized byte size plus the newline, not the UTF-16 length: multibyte
  // payloads must not slip past the bound and the limit includes the newline.
  if(Buffer.byteLength(line)+1>clientLimits.responseLineBytes||line.includes(options.secret)||line.includes(origin))line=JSON.stringify({id:'',error:{code:'upstream',message:UPSTREAM}});
  connection.socket.write(line+'\n');
 }
 function writeError(connection:Connection,id:string,code:string){write(connection,{id,error:{code,message:INVALID}});}
 function headersOf(response:Response){const headers:Record<string,string>={};response.headers.forEach((value,name)=>{headers[name]=value;});return headers;}
 function jsonHeaders(){return {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};}
function timeout(ms:number){return new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout')),ms);(timer as unknown as {unref:()=>void}).unref();});}

 function deliverNotification(item:OwnerException){
  for(const connection of connections)if(connection.ready)write(connection,{event:'notification',key:item.key,title:item.title});
 }
 async function observe(){
  if(observing||closing)return;observing=true;
  try{
   const info=await client.connection();if(info.state!=='ready'){client.reconnect();return;}
   const works=await client.query('/assistant/works',{scope:'notifications-works'}),view=await client.query('/assistant/conversation',{scope:'notifications-decisions'});
   if(!works.response.ok||!view.response.ok||!Array.isArray(works.body.works)||!Array.isArray(view.body.decisions))return;
   if(works.body.feedId!==view.body.feedId){tracker.clear();return;}
   const decisions=[...view.body.decisions];
   for(const member of view.body.members??[]){
    if(typeof member.id!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(member.id))continue;
    const read=await client.query('/assistant/conversation?member='+encodeURIComponent(member.id),{scope:'notifications-member'});
    if(!read.response.ok||read.body.feedId!==view.body.feedId){tracker.clear();return;}
    for(const decision of read.body.decisions??[])decisions.push({...decision,memberId:member.id});
   }
   const fresh=tracker.update(view.body.feedId,works.body.works,decisions);
   if(!(await lifecycle()).notifications)return;
   for(const item of fresh){pendingTargets.set(item.key,item);deliverNotification(item);}
  }catch{client.reconnect();}finally{observing=false;if(!closing)timer=setTimeout(()=>void observe(),options.observeIntervalMs??10000);}
 }

 function closeConnection(connection:Connection){
  if(connection.closed)return;connection.closed=true;connections.delete(connection);
  for(const subscription of connection.subscriptions.values())subscription.abort.abort();
  connection.subscriptions.clear();connection.socket.destroy();
 }

 async function subscribe(connection:Connection,id:string,path:string,lastEventId:string|undefined){
  if(connection.subscriptions.size>=clientLimits.subscriptions){writeError(connection,id,'busy');return;}
  const subscription={abort:new AbortController()};connection.subscriptions.set(id,subscription);
  const startedAt=Date.now();
  try{
   const response=await proxyProtocol(new Request('massion://app'+path,{method:'GET',headers:{...(lastEventId?{'Last-Event-ID':lastEventId}:{})},signal:subscription.abort.signal}),origin,credential);
   write(connection,{id,status:response.status,headers:headersOf(response)});
   if(!response.ok||!response.body)throw new Error('Feed refused');
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   try{
    for(;;){
     const part=await reader.read();if(part.done)break;
     buffer+=decoder.decode(part.value,{stream:true});
     if(buffer.length>clientLimits.sseBufferBytes)throw new Error('Feed frame exceeds bound');
     let index;
     while((index=buffer.indexOf('\n\n'))>=0){
      const event=parseFeedBlock(buffer.slice(0,index));buffer=buffer.slice(index+2);
      if(!event)continue;
      write(connection,{event:'message',subscription:id,...(event.id?{lastEventId:event.id}:{}),data:event.data});
     }
    }
    throw new Error('Feed ended');
   }finally{try{await reader.cancel();}catch{}}
  }catch(error){
  if(options.onSubscribeError){
   const way=error instanceof Error&&error.message==='Feed refused'?'refused':error instanceof Error&&error.message==='Feed frame exceeds bound'?'bound':error instanceof Error&&error.message==='Feed ended'?'ended':'fetch';
   const cause=(error as {cause?:{code?:string}})?.cause;
   const connection=(error as {connectionFact?:{beforeHeaders:boolean;reused:boolean}})?.connectionFact;
   try{options.onSubscribeError({name:(error as Error)?.name??String(error),code:(error as NodeJS.ErrnoException)?.code,causeCode:cause?.code,message:(error as Error)?.message??'',way,elapsedMs:Date.now()-startedAt,beforeHeaders:connection?connection.beforeHeaders:way==='fetch',reused:connection?.reused});}catch{}
  }
   if(connection.subscriptions.get(id)===subscription)write(connection,{event:'error',subscription:id});
  }
  finally{if(connection.subscriptions.get(id)===subscription)connection.subscriptions.delete(id);}
 }

 async function route(connection:Connection,message:Record<string,unknown>):Promise<Reply|undefined>{
  const id=String(message.id),method=typeof message.method==='string'?message.method.toUpperCase():'',path=typeof message.path==='string'?message.path:'';
  if(!path.startsWith('/')||path.length>8192)return {id,error:{code:'path',message:INVALID}};
  let lastEventId:string|undefined;
  if(message.headers!==undefined){
   const headers=message.headers;
   if(!headers||typeof headers!=='object'||Array.isArray(headers))return {id,error:{code:'header',message:INVALID}};
   for(const [name,value] of Object.entries(headers)){
    if(name!=='Last-Event-ID'||typeof value!=='string'||value.length>4096)return {id,error:{code:'header',message:INVALID}};
    lastEventId=value;
   }
  }
  let body:string|undefined;
  if(message.body!==undefined&&message.body!==null){
   if(typeof message.body!=='string'||Buffer.byteLength(message.body)>clientLimits.bodyBytes)return {id,error:{code:'size',message:INVALID}};
   body=message.body;
  }
  if(path==='/'){
   if(method!=='GET'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   const document=await loadHtml();
   return {id,status:200,headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':document.policy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:document.content};
  }
  // The native caller sets the socket origin. Page paths, headers and
  // protocol bodies cannot populate this field.
  if(path==='/host/work-count'&&message.origin==='host'){
   if(method!=='GET'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   const response=await authenticatedFetch(new URL(path,origin),{headers:{'X-Massion-Request-Origin':'host'},signal:AbortSignal.timeout(options.requestTimeoutMs??clientLimits.requestTimeoutMs)},await credential());
   return {id,status:response.status,headers:headersOf(response),body:await response.text()};
  }
  if(path==='/protocol/connect'||path==='/protocol/request'){
   if(method!=='POST'||body===undefined)return {id,error:{code:'method',message:INVALID}};
   const response=await proxyProtocol(new Request('massion://app'+path,{method:'POST',headers:{'Content-Type':'application/json'},body}),origin,credential,html=>'massion-app://document'+documents.publish(html));
   const payload=await response.text();
   return {id,status:response.status,headers:headersOf(response),body:payload||undefined};
  }
  if(path.startsWith('/protocol/events')&&(path.length===16||path.charCodeAt(16)===63)){
   if(method!=='GET'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   await subscribe(connection,id,path,lastEventId);
   return undefined;
  }
  if(/^\/(?:document\/)?[a-f0-9]{64}$/.test(path)){
   if(method!=='GET'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   const document=documents.read('/'+path.split('/').pop());
   return {id,status:document===undefined?404:200,headers:appDocumentHeaders,body:document};
  }
  if(path==='/desktop/settings'){
   if(method!=='GET'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   return {id,status:200,headers:jsonHeaders(),body:JSON.stringify((await lifecycle()).read())};
  }
  if(path==='/desktop/notifications'){
   if(method!=='POST'||body!==undefined&&body!=='true'&&body!=='false')return {id,error:{code:'method',message:INVALID}};
   return {id,status:200,headers:jsonHeaders(),body:JSON.stringify(await (await lifecycle()).saveNotifications(body==='true'))};
  }
  if(path==='/desktop/restart'){
   if(method!=='POST'||body!==undefined)return {id,error:{code:'method',message:INVALID}};
   // Electron keeps 'restarting' (it quits right after) and never reuses the
   // object. This daemon-side restart completes while the supervisor keeps
   // serving, so a successful restart reports idle and the next request
   // reopens the lifecycle: the next save, the next restart and the running
   // notification setting are read fresh from disk.
   const host=await lifecycle(),settings=await host.restart();
   if(settings.restartStatus==='restarting')lifecycleReady=undefined;
   return {id,status:200,headers:jsonHeaders(),body:JSON.stringify(settings.restartStatus==='restarting'?{...settings,restartStatus:'idle'}:settings)};
  }
  return {id,error:{code:'path',message:INVALID}};
 }

 function handleEvent(connection:Connection,message:Record<string,unknown>){
  if(message.event==='ready'){connection.ready=true;return;}
  if(message.event==='notification-clicked'){
   const key=typeof message.key==='string'?message.key:'',target=pendingTargets.get(key);
   if(!target||!tracker.current(target))return;
   write(connection,{event:'focus',target});
   return;
  }
  if(message.event==='close'){
   const id=typeof message.subscription==='string'?message.subscription:'',subscription=connection.subscriptions.get(id);
   if(subscription){connection.subscriptions.delete(id);subscription.abort.abort();}
  }
 }
 async function dispatch(connection:Connection,line:string){
  let message:unknown;
  try{message=JSON.parse(line);}catch{write(connection,{id:'',error:{code:'invalid',message:INVALID}});return;}
  if(!message||typeof message!=='object'||Array.isArray(message))return;
  const record=message as Record<string,unknown>;
  if(typeof record.event==='string'){handleEvent(connection,record);return;}
  if(typeof record.id!=='string'||record.id.length>128){write(connection,{id:'',error:{code:'invalid',message:INVALID}});return;}
  if(connection.pending>=clientLimits.pending){writeError(connection,record.id,'busy');return;}
  connection.pending++;
  try{
   const reply=await Promise.race([route(connection,record),timeout(options.requestTimeoutMs??clientLimits.requestTimeoutMs)]);
   if(reply)write(connection,reply as Record<string,unknown>);
  }catch{write(connection,{id:record.id,error:{code:'upstream',message:UPSTREAM}});}
  finally{connection.pending--;}
 }

 return {
  handle(socket:Socket,initial:Buffer|string=''){
   const connection:Connection={socket,ready:false,buffer:Buffer.isBuffer(initial)?initial:Buffer.from(initial),closed:false,pending:0,subscriptions:new Map()};
   connections.add(connection);
   // Bytes in, bytes split: a multibyte character split across chunks is
   // decoded only as part of a complete line, and the bound applies per line
   // (newline included), so several valid lines in one chunk never drop the
   // connection.
   const pump=()=>{
    if(connection.closed)return;
    let index;
    while((index=connection.buffer.indexOf(0x0a))>=0){
     const total=index+1;
     if(total>clientLimits.requestLineBytes){closeConnection(connection);return;}
     const line=decoder.decode(connection.buffer.subarray(0,index));
     connection.buffer=connection.buffer.subarray(total);
     if(line.trim())void dispatch(connection,line);
    };
    if(connection.buffer.length>=clientLimits.requestLineBytes)closeConnection(connection);
   };
   socket.on('data',(chunk:Buffer)=>{if(connection.closed)return;connection.buffer=Buffer.concat([connection.buffer,chunk]);pump();});
   pump();
   socket.on('end',()=>closeConnection(connection));
   socket.on('error',()=>closeConnection(connection));
  },
  connections(){return connections.size;},
  startObserver(){void observe();},
  close(){closing=true;clearTimeout(timer);documents.clear();tracker.clear();pendingTargets.clear();for(const connection of [...connections])closeConnection(connection);},
 };
}

function parseFeedBlock(block:string){
 let id:string|undefined;const data:string[]=[];
 for(const raw of block.split('\n')){
  const line=raw.endsWith('\r')?raw.slice(0,-1):raw;
  if(line.startsWith('id:'))id=line.slice(3).replace(/^ /,'');
  else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
 }
 return data.length?{id,data:data.join('\n')}:undefined;
}
