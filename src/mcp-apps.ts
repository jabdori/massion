import {randomUUID} from 'node:crypto';
import {DomainError,hash} from './domain.ts';
import {boundedModeration as boundedJson} from './discriminator.ts';
import type {AppManifest} from './apps.ts';
import type {SecretSlots} from './secret-slots.ts';
import {callTool,TOOL_TIMEOUT_MS} from './tool-call.ts';

export interface McpTool {name:string;description:string;inputSchema:Record<string,unknown>;readOnly?:boolean}
export type McpServer=({transport:'stdio';target:string}|{transport:'http';url:string})&{tools:McpTool[]};
export type AppSecrets=Pick<SecretSlots,'set'>;
/** Host adapters own negotiation, pagination, secret attachment and the approved launcher; no raw spawn fallback. */
export interface McpAdapter {
 list(request:{requestId:string;appId:string;server:McpServer;signal:AbortSignal}):Promise<unknown>;
 call(request:{requestId:string;appId:string;server:McpServer;name:string;arguments:Record<string,unknown>;signal:AbortSignal}):Promise<unknown>;
 view?(request:{requestId:string;appId:string;server:McpServer;signal:AbortSignal}):Promise<unknown>;
 close(request:{requestId:string;appId:string;server:McpServer;reason:'complete'|'cancel'}):Promise<void>;
}
export interface McpCall {id:string;appId:string;versionHash:string;name:string;inputHash:string;timeoutMs:number;status:'pending'|'succeeded'|'failed'|'unknown';result?:unknown;reconciliation?:{actorId:string;at:number;outcome:'done'|'not-done';evidence:string}}
export const MCP_TIMEOUT_MS=TOOL_TIMEOUT_MS;
const exact=(v:unknown,keys:string[],optional:string[]=[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k));
const validName=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,64}$/.test(v);
export function validTools(value:unknown):value is McpTool[] {
 try{boundedJson(value);}catch{return false;}
 return Array.isArray(value)&&value.length<=16&&new Set(value.map(t=>t?.name)).size===value.length&&value.every(t=>exact(t,['name','description','inputSchema'],['readOnly'])&&validName(t.name)&&typeof t.description==='string'&&t.description.length<=2000&&t.description.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(t.description)&&!!t.inputSchema&&typeof t.inputSchema==='object'&&!Array.isArray(t.inputSchema)&&(t.readOnly===undefined||typeof t.readOnly==='boolean'));
}
export const toolsHash=(tools:McpTool[])=>hash(tools.map(t=>({...t,readOnly:t.readOnly===true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0));
export function validMcp(m:AppManifest):boolean {
 const s=m.mcp;if(!s||!validTools(s.tools)||m.permissions.network.length!==1||m.handlers.some(h=>!['run','page'].includes(h))||m.contributes.roomTab)return false;
 if(s.transport==='stdio'){if(!exact(s,['transport','target','tools'])||!validName(s.target)||m.permissions.network[0]!=='localhost')return false;}
 else if(s.transport==='http'){
  if(!exact(s,['transport','url','tools'])||typeof s.url!=='string'||s.url.length>2048)return false;
  try{const u=new URL(s.url);if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||!u.port||u.username||u.password||u.hash||u.search||u.origin+u.pathname!==s.url||m.permissions.network[0]!==u.hostname)return false;}catch{return false;}
 }else return false;
 return m.contributes.tools.every(n=>s.tools.some(t=>t.name===n))&&s.tools.every(t=>m.contributes.tools.includes(t.name)&&(t.readOnly===true?m.permissions.read:m.permissions.write).includes(t.name));
}
export function mcpWidens(now:AppManifest,next:AppManifest):boolean {
 if(now.kind!==next.kind)return true;
 if(hash(now.connection??null)!==hash(next.connection??null))return true;
 if(next.kind!=='mcp')return false;
 if(next.contributes.page&&!now.contributes.page||next.handlers.some(h=>!now.handlers.includes(h)))return true;
 const a=now.mcp!,b=next.mcp!;
 const endpoint=(s:McpServer)=>s.transport==='stdio'?{transport:s.transport,target:s.target}:{transport:s.transport,url:s.url};
 return hash(endpoint(a))!==hash(endpoint(b))||b.tools.some(t=>!a.tools.some(old=>old.name===t.name&&toolsHash([old])===toolsHash([t])));
}
export function requireTool(m:AppManifest,name:string):McpTool {
 const tool=m.kind==='mcp'&&m.mcp?.tools.find(t=>t.name===name);
 if(!tool||!m.contributes.tools.includes(name)||!(tool.readOnly===true?m.permissions.read:m.permissions.write).includes(name))throw new DomainError('Tool is outside the declared scope','denied');return tool;
}
/** A deadline aborts the adapter; cancellation cannot settle a remote write. Cleanup is bounded independently. */
export async function mcpRequest<T>(adapter:McpAdapter,appId:string,server:McpServer,timeoutMs:number,run:(signal:AbortSignal,requestId:string)=>Promise<T>,signal?:AbortSignal,readOnly=false):Promise<T> {
 const requestId=randomUUID();let completed=false;
 try{const result=await callTool(s=>run(s,requestId),{signal,timeoutMs,readOnly});completed=true;return result;}
 finally{let cleanup:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.resolve().then(()=>adapter.close({requestId,appId,server,reason:completed?'complete':'cancel'})).catch(()=>{}),new Promise<void>(resolve=>{cleanup=setTimeout(resolve,1000);})]);}finally{clearTimeout(cleanup);}}
}
