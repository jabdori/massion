import {checkSlot} from './secret-slots.ts';
import type {SecretSlot,SecretSlots} from './secret-slots.ts';
import {SecretSourceError,sourceHash,validateSecretSource,validateSecretValue} from './secret-sources.ts';
import type {SecretSource,ExternalVault,SecretSourceCode} from './secret-sources.ts';
import type {PermissionsService,SecretConsumer} from './permissions.ts';
import {callTool,ToolCallError} from './tool-call.ts';

export interface SecretBinding {secret:SecretSlot;source:SecretSource}
/** Each instance belongs to a host-selected consumer/purpose; values never enter its state. */
export class SourceSecretSlots implements SecretSlots {
 readonly #own:SecretSlots;readonly #bindings:SecretBinding[];readonly #permissions:PermissionsService;readonly #consumer:SecretConsumer;readonly #purpose:string;readonly #vaults:Partial<Record<'onepassword',ExternalVault>>;
 readonly #states=new Map<string,SecretSourceCode|'unverified'|'ready'>();
 readonly #generations=new Map<string,number>();readonly #stop=new AbortController();
 constructor(own:SecretSlots,bindings:SecretBinding[],permissions:PermissionsService,consumer:SecretConsumer,purpose:string,vaults:Partial<Record<'onepassword',ExternalVault>>={}){
  this.#own=own;this.#bindings=bindings.map(b=>{checkSlot(b.secret);return {secret:structuredClone(b.secret),source:validateSecretSource(b.source)};});this.#permissions=permissions;this.#consumer=structuredClone(consumer);this.#purpose=purpose;this.#vaults={...vaults};
  if(bindings.length>64||new Set(bindings.map(b=>JSON.stringify([b.secret.owner,b.secret.slot]))).size!==bindings.length)throw new SecretSourceError('unavailable');
 }
 #binding(secret:SecretSlot){checkSlot(secret);const b=this.#bindings.find(b=>b.secret.owner===secret.owner&&b.secret.slot===secret.slot);if(!b)throw new SecretSourceError('grant-required');return b;}
 describe(secret:SecretSlot){const b=this.#binding(secret);return {kind:b.source.kind,state:this.#states.get(JSON.stringify([secret.owner,secret.slot]))??'unverified',secret:structuredClone(secret),sourceHash:sourceHash(b.source),consumer:structuredClone(this.#consumer),purpose:this.#purpose};}
 async #authorize(b:SecretBinding,expected?:{feedId:string;grantId:string}){const result=await this.#permissions.authorizeSecret(b.secret,sourceHash(b.source),this.#consumer,this.#purpose,expected);if(this.#stop.signal.aborted)throw new SecretSourceError('cancelled');return result;}
 async read(secret:SecretSlot,signal?:AbortSignal):Promise<string|undefined>{
  this.#binding(secret);const key=JSON.stringify([secret.owner,secret.slot]),generation=(this.#generations.get(key)??0)+1;this.#generations.set(key,generation);
  try{const value=await callTool(bounded=>this.#read(secret,bounded),{readOnly:true,signal:AbortSignal.any([this.#stop.signal,...(signal?[signal]:[])]),timeoutMs:5000});if(this.#generations.get(key)===generation)this.#states.set(key,'ready');return value;}
  catch(error){const safe=error instanceof SecretSourceError?error:error instanceof ToolCallError?new SecretSourceError(error.timedOut?'timeout':'cancelled'):new SecretSourceError('unavailable');if(this.#generations.get(key)===generation)this.#states.set(key,safe.code);throw safe;}
 }
 async #read(secret:SecretSlot,signal:AbortSignal):Promise<string|undefined>{
  const b=this.#binding(secret);
  try{if(signal?.aborted)throw new SecretSourceError('cancelled');const grant=await this.#authorize(b),digest=sourceHash(b.source);let value:string|undefined;
   if(b.source.kind==='own')value=await this.#own.read(secret,signal);
   else if(b.source.kind==='external-ref')value=await this.#external(b.source,signal);
   else {
    let imported=await this.#permissions.imported(secret,digest);
    if(!imported){const claim=await this.#permissions.claimImport(secret,digest,grant);if(claim.status==='committed'){
     try{const resolved=await this.#external(b.source,signal);await this.#authorize(b,grant);if(signal?.aborted)throw new SecretSourceError('cancelled');await this.#own.set(secret,resolved);await this.#authorize(b,grant);if(signal?.aborted)throw new SecretSourceError('cancelled');const done=await this.#permissions.settleImport(secret,digest,grant.feedId,'completed');if(done.status==='conflict')throw new SecretSourceError('import-unavailable');}
     catch(error){try{await this.#permissions.settleImport(secret,digest,grant.feedId,'unavailable');}catch{}throw error instanceof SecretSourceError?error:new SecretSourceError('import-unavailable');}
    }imported=await this.#permissions.imported(secret,digest);}
    if(imported?.status!=='completed')throw new SecretSourceError('import-unavailable');value=await this.#own.read(secret,signal);
   }
   await this.#authorize(b,grant);if(signal?.aborted)throw new SecretSourceError('cancelled');if(value===undefined)throw new SecretSourceError('reference-not-found');validateSecretValue(value);return value;
  }catch(error){throw error instanceof SecretSourceError?error:new SecretSourceError('unavailable');}
 }
 async #external(source:Exclude<SecretSource,{kind:'own'}>,signal?:AbortSignal){const adapter=this.#vaults[source.vendor];if(!adapter)throw new SecretSourceError('cli-missing');const value=await adapter.read(source.reference,signal);validateSecretValue(value);return value;}
 async has(secret:SecretSlot,signal?:AbortSignal){const b=this.#binding(secret),grant=await this.#authorize(b);if(b.source.kind==='external-ref')throw new SecretSourceError('unavailable');if(b.source.kind==='import'&&(await this.#permissions.imported(secret,sourceHash(b.source)))?.status!=='completed')return false;const result=await this.#own.has?.(secret,signal);await this.#authorize(b,grant);if(signal?.aborted)throw new SecretSourceError('cancelled');if(typeof result!=='boolean')throw new SecretSourceError('unavailable');return result;}
 async set(secret:SecretSlot,value:string){const b=this.#binding(secret);if(b.source.kind!=='own')throw new SecretSourceError('permission-denied');validateSecretValue(value);await this.#authorize(b);await this.#own.set(secret,value);}
 async delete(_secret:SecretSlot):Promise<void>{throw new SecretSourceError('permission-denied');}
 beginDrain(){this.#stop.abort();}
}
