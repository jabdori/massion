/** First implemented protocol. This is not a native Anthropic, Codex or ACP adapter. */
import {OpenAICompatibleChatAdapter} from './http-provider.ts';
import type {HttpProviderTransport} from './http-provider.ts';
import type {ModelAdapterFactory,ModelConnectionProfile,ConnectionDiagnostic} from './provider-profiles.ts';
export interface CredentialRequest {secretRef:string;profileId:string;endpoint:string;signal:AbortSignal}
/** Caller-owned, per-request resolver. Never reads process environment or credential files. */
export type CredentialResolver=(request:CredentialRequest)=>Promise<string>;
export function chatProfileFactory(options:{mode:'https'|'local-http-mock';transport:HttpProviderTransport;resolveCredential?:CredentialResolver}):ModelAdapterFactory{
 const config=(p:Readonly<ModelConnectionProfile>,transport:HttpProviderTransport)=>({provider:p.providerKind,model:p.model,configVersion:p.revision,endpoint:p.endpoint,enabled:p.enabled,transportMode:options.mode,bounds:p.limits,authorization:{provider:p.providerKind,model:p.model,configVersion:p.revision,endpoint:p.endpoint,maxInputBytes:p.limits.maxInputBytes,maxOutputTokens:p.limits.maxOutputTokens},transport});
 return {
  protocol:'openai-chat-completions/v1',authMethods:options.mode==='local-http-mock'?['none']:['bearer'],capabilities:['text-output'],evidenceClass:options.mode==='local-http-mock'?'fixture':'real-provider',
  validate(p){const errors:ConnectionDiagnostic[]=[];
   if(options.mode==='https'&&(!p.auth.secretRef||!options.resolveCredential))errors.push({code:'credential_resolver_missing',message:'Bearer authentication needs an opaque secret reference and a caller-owned resolver.'});
   if(options.mode==='local-http-mock'&&p.auth.secretRef)errors.push({code:'auth_invalid',message:'Local mock transport must not resolve or transmit credentials.'});
   if(p.usage.inputTokens!=='reported'||p.usage.outputTokens!=='reported')errors.push({code:'usage_unsupported',message:'This parser requires reported input and output tokens; unknown usage cannot satisfy bounded completion.'});
   try{new OpenAICompatibleChatAdapter(config(p,options.transport));}catch{errors.push({code:'endpoint_or_bounds_invalid',message:'Endpoint or bounds do not satisfy the explicit Chat Completions transport contract.'});}
   return errors;
  },
  create(p){return new OpenAICompatibleChatAdapter(config(p,async(url,init)=>{
   if(options.mode==='local-http-mock')return options.transport(url,init);
   if(url!==p.endpoint||!(init.signal instanceof AbortSignal)||init.signal.aborted)throw new Error('Credential destination or signal rejected');
   const secret=await options.resolveCredential!({secretRef:p.auth.secretRef!,profileId:p.id,endpoint:p.endpoint,signal:init.signal});
   init.signal.throwIfAborted();
   if(typeof secret!=='string'||!secret||secret.length>8192||/[^\x21-\x7e]/.test(secret))throw new Error('Invalid resolved credential');
   const headers=new Headers(init.headers);headers.set('authorization',`Bearer ${secret}`);
   return options.transport(url,{...init,headers});
  }));}
 };
}
