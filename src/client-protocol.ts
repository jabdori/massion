import {protocolSupport,validHeader,validRange} from './protocol.ts';
import type {ProtocolConnection,ProtocolRange,ProtocolTransport,ProtocolRequest,ProtocolReply,ProtocolHeader,FeedHint,FeedSubscription} from './protocol.ts';

interface ClientOptions { headers?:Record<string,string>;signal?:AbortSignal }
export interface ClientQueryOptions extends ClientOptions { scope:string;method?:'GET' }
export interface ClientCommandOptions extends ClientOptions { method?:'POST';body?:string;scope?:never }
export type ClientRequestOptions=ClientQueryOptions|(ClientCommandOptions&{method:'POST'});
export function createProtocolClient(transport:ProtocolTransport,supported:ProtocolRange=protocolSupport){
 let serial=0,epoch=0,connectionPromise:Promise<ProtocolConnection>|undefined,state:ProtocolConnection|undefined;
 const generations=new Map<string,number>();
 const header=():ProtocolHeader=>({version:state?.version??supported.max,requestId:crypto.randomUUID(),generation:++serial});
 const stale=()=>Object.assign(new Error('Stale protocol reply'),{name:'StaleProtocolReplyError'});
 function check(reply:ProtocolReply,message:ProtocolHeader,negotiating=false){
  if(!validHeader(reply)||reply.kind!=='reply'||reply.requestId!==message.requestId||reply.generation!==message.generation||!Number.isSafeInteger(reply.status)||reply.status<100||reply.status>599)throw new Error('Invalid protocol correlation');
  if(!negotiating&&(reply.version<supported.min||reply.version>supported.max||reply.version!==message.version)){
   if(state)state={...state,state:'update-needed'};
   throw new Error('Unsupported protocol reply version');
  }
 }
 async function connection(){
  if(!connectionPromise)connectionPromise=(async()=>{
   const message={...header(),supported},controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
   try{const reply=await transport.connect(message,controller.signal);check(reply,message,true);const info=reply.payload as ProtocolConnection;
    if(!info||!['ready','update-needed','restart-needed'].includes(info.state)||!validRange(info.supported)||!info.features||['commands','queries','feedPush'].some(k=>typeof info.features[k as keyof typeof info.features]!=='boolean')||info.state==='ready'&&(reply.version!==info.version||!Number.isSafeInteger(info.version)||info.version!<supported.min||info.version!>supported.max||info.version!<info.supported.min||info.version!>info.supported.max))throw new Error('Invalid protocol negotiation');
    state=info;return info;
   }finally{clearTimeout(timer);}
  })().catch(error=>{connectionPromise=undefined;throw error;});
  await connectionPromise;return state!;
 }
 function invalidate(scope?:string){if(scope)generations.set(scope,++serial);else epoch++;}
 async function send(path:string,options:ClientQueryOptions|ClientCommandOptions,timeout:number,kind:'query'|'command'){
  if(kind==='query'&&(typeof options?.scope!=='string'||!options.scope.trim()))throw new TypeError('Query generation scope is required');
  const scope=options.scope!,generation=++serial,started=epoch;
  if(kind==='query')generations.set(scope,generation);
  const current=()=>kind==='command'||started===epoch&&generations.get(scope)===generation;
  const controller=new AbortController(),abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const timer=setTimeout(abort,timeout);let attempted=false;
  try{
   const info=await connection();if(!current())throw stale();
   if(info.state!=='ready'||!info.features[kind==='command'?'commands':'queries'])throw new Error('Protocol feature requires update or restart');
   if(controller.signal.aborted)throw Object.assign(new Error('Request aborted'),{name:'AbortError'});
   const feedId=options.headers?.['X-Massion-Feed']??options.headers?.['x-massion-feed'];
   const message:ProtocolRequest={...header(),generation,kind,path,...(kind==='command'?{payload:JSON.parse((options as ClientCommandOptions).body??'{}')}:{}),...(feedId?{feedId}:{})};
   attempted=true;const reply=await transport.request(message,controller.signal);
   if(!current())throw stale();if(controller.signal.aborted)throw Object.assign(new Error('Request aborted'),{name:'AbortError'});check(reply,message);
   if(reply.status===426&&state)state={...state,state:(reply.payload as {state?:string})?.state==='restart-needed'?'restart-needed':'update-needed'};
   return {response:{ok:reply.status>=200&&reply.status<300,status:reply.status},body:reply.payload as any};
  }catch(error){if(!current())throw stale();if(kind==='command'&&!attempted)throw Object.assign(new Error(error instanceof Error?error.message:'Command was not sent',{cause:error}),{name:(error as Error)?.name??'Error',commandNotSent:true});throw error;}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(kind==='query'&&generations.get(scope)===generation)generations.delete(scope);}
 }
 const query=(path:string,options:ClientQueryOptions,timeout=15000)=>send(path,options,timeout,'query');
 const dispatch=(path:string,options:ClientCommandOptions={},timeout=15000)=>send(path,options,timeout,'command');
 const request=(path:string,options:ClientRequestOptions,timeout=15000)=>{
  if(options.method&&options.method!=='GET'&&options.method!=='POST')return Promise.reject(new Error('Unsupported protocol method'));
  return options.method==='POST'?dispatch(path,options,timeout):query(path,options,timeout);
 };
 async function subscribe(position:{after:number;feedId?:string},onEvent:(event:FeedHint)=>void,onDisconnect:()=>void){
  const info=await connection();if(info.state!=='ready'||!info.features.feedPush)throw new Error('Protocol feed requires update or restart');
  const message={...header(),...position};let active=true;
  const stop=transport.subscribe(message,event=>{
   if(!active)return;
   if(!validHeader(event)||event.version!==message.version||event.requestId!==message.requestId||event.generation!==message.generation||event.kind!=='feed'||!['connected','revision','reset'].includes(event.reason)||typeof event.feedId!=='string'||!event.feedId||!Number.isSafeInteger(event.cursor)||event.cursor<0){onDisconnect();return;}
   onEvent(event);
  },()=>{if(active)onDisconnect();});
  return()=>{active=false;stop();};
 }
 function reconnect(){invalidate();connectionPromise=undefined;state=undefined;}
 return {request,query,dispatch,connection,invalidate,subscribe,reconnect};
}

export function createHttpTransport(fetcher:typeof fetch=fetch):ProtocolTransport{
 async function post(path:string,message:unknown,signal:AbortSignal){
  const response=await fetcher(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),signal,cache:'no-store',redirect:'error'});
  const reply=await response.json() as ProtocolReply;
  if(reply?.status!==response.status)throw new Error('Invalid protocol HTTP status');return reply;
 }
 return {connect:(message,signal)=>post('/protocol/connect',message,signal),request:(message,signal)=>post('/protocol/request',message,signal),subscribe(){throw new Error('HTTP-only transport has no push subscription');}};
}
export function createSseTransport(http:ProtocolTransport,source:(url:string)=>EventSource=url=>new EventSource(url)):ProtocolTransport{
 return {...http,subscribe(message:FeedSubscription,onEvent:(event:FeedHint)=>void,onDisconnect:()=>void){
  const params=new URLSearchParams({version:String(message.version),requestId:message.requestId,generation:String(message.generation),after:String(message.after),...(message.feedId?{feedId:message.feedId}:{})});
  const stream=source('/protocol/events?'+params);
  stream.onmessage=event=>{try{onEvent(JSON.parse(event.data));}catch{onDisconnect();}};
  stream.onerror=onDisconnect;
  return()=>stream.close();
 }};
}

// Native type stripping leaves executable function source; the workbench needs no bundler.
export const protocolClientScript=[`const protocolSupport=${JSON.stringify(protocolSupport)};`,validRange,validHeader,createProtocolClient,createHttpTransport,createSseTransport].join('\n');
