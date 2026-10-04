/** Inert connection configuration. Protocol factories, never provider names, own transport behavior. */
import {hash} from './domain.ts';
import type {ProviderAdapter} from './providers.ts';
export interface ConnectionDiagnostic {code:string;message:string}
export interface ConnectionLimits {maxInputBytes:number;maxOutputTokens:number;maxResponseBytes:number;timeoutMs:number}
export interface ModelConnectionProfile {
 id:string;label:string;backend:'model-provider';providerKind:string;protocol:string;model:string;endpoint:string;revision:string;enabled:boolean;
 /** Opaque caller-managed reference only; credentials never belong in configuration or browser JSON. */
 auth:{method:string;secretRef?:string};capabilities:readonly string[];
 usage:{inputTokens:'reported'|'unknown';outputTokens:'reported'|'unknown';cost:'unknown'};
 limits:ConnectionLimits;
}
/** Deliberately separate: ACP sessions are not stateless bounded-model requests. No ACP launcher exists yet. */
export interface AgentConnectionProfile {id:string;label:string;backend:'acp-agent';protocolVersion:1;agentId:string;enabled:boolean}
export type ExecutionConnectionProfile=ModelConnectionProfile|AgentConnectionProfile;
export interface ModelAdapterFactory {
 protocol:string;authMethods:readonly string[];capabilities:readonly string[];evidenceClass:'fixture'|'real-provider';
 /** Pure validation. Must not resolve secrets, initialize sessions, or send requests. */
 validate(profile:Readonly<ModelConnectionProfile>):ConnectionDiagnostic[];
 /** No effects at construction. Each invoke must be bounded, single-send, exact-model and independently stateless. */
 create(profile:Readonly<ModelConnectionProfile>):ProviderAdapter;
}
export type ResolvedConnection={status:'selected';profile:ModelConnectionProfile;configHash:string;adapter:ProviderAdapter}|{status:'unavailable';diagnostics:ConnectionDiagnostic[]};
const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const diagnostic=(code:string,message:string):ConnectionDiagnostic=>({code,message});
function validate(profile:ExecutionConnectionProfile,factory?:ModelAdapterFactory):ConnectionDiagnostic[]{
 const errors:ConnectionDiagnostic[]=[];
 const allowed=profile.backend==='model-provider'?['id','label','backend','providerKind','protocol','model','endpoint','revision','enabled','auth','capabilities','usage','limits']:['id','label','backend','protocolVersion','agentId','enabled'];
 if(Object.keys(profile).some(k=>!allowed.includes(k)))errors.push(diagnostic('profile_invalid','Unsupported profile fields; raw credentials are not configuration.'));
 if(!id(profile.id)||!label(profile.label)||typeof profile.enabled!=='boolean')errors.push(diagnostic('profile_invalid','Connection identity, label or enabled state is invalid.'));
 if(profile.backend!=='model-provider'){errors.push(diagnostic('backend_unsupported','ACP requires a separately implemented negotiated agent-session runtime; it cannot run as a raw model provider.'));return errors;}
 if(!label(profile.providerKind)||!label(profile.protocol)||!label(profile.model)||!label(profile.revision)||!label(profile.endpoint))errors.push(diagnostic('profile_invalid','Provider, protocol, exact model, revision and endpoint are required.'));
 if(!profile.auth||!label(profile.auth.method)||Object.keys(profile.auth).some(k=>!['method','secretRef'].includes(k))||profile.auth.secretRef!==undefined&&!id(profile.auth.secretRef))errors.push(diagnostic('auth_invalid','Authentication accepts an implemented method and opaque secret reference only.'));
 if(!profile.limits||Object.keys(profile.limits).length!==4||Object.keys(profile.limits).some(k=>!['maxInputBytes','maxOutputTokens','maxResponseBytes','timeoutMs'].includes(k))||!Object.values(profile.limits).every(positive)||profile.limits.timeoutMs>2_147_483_647)errors.push(diagnostic('limits_invalid','All four connection limits must be positive safe integers.'));
 if(!profile.usage||Object.keys(profile.usage).some(k=>!['inputTokens','outputTokens','cost'].includes(k))||!['reported','unknown'].includes(profile.usage.inputTokens)||!['reported','unknown'].includes(profile.usage.outputTokens)||profile.usage.cost!=='unknown')errors.push(diagnostic('usage_invalid','Token reporting must be declared; monetary cost is not guaranteed.'));
 if(!Array.isArray(profile.capabilities)||profile.capabilities.some(c=>!label(c))||new Set(profile.capabilities).size!==profile.capabilities.length)errors.push(diagnostic('capability_invalid','Capabilities must be unique named declarations.'));
 if(!factory){errors.push(diagnostic('protocol_unsupported','No adapter implements this connection protocol.'));return errors;}
 if(!factory.authMethods.includes(profile.auth?.method))errors.push(diagnostic('auth_unsupported','This protocol adapter does not implement the selected authentication method.'));
 if(Array.isArray(profile.capabilities)&&profile.capabilities.some(c=>!factory.capabilities.includes(c)))errors.push(diagnostic('capability_unsupported','This profile declares a capability its adapter does not implement.'));
 if(errors.length===0)errors.push(...factory.validate(structuredClone(profile)));
 if(!profile.enabled)errors.push(diagnostic('connection_disabled','Connection is disabled.'));
 return errors;
}
export class ConnectionCatalog {
 readonly #profiles:Map<string,ExecutionConnectionProfile>;readonly #factories:Map<string,ModelAdapterFactory>;
 constructor(profiles:readonly ExecutionConnectionProfile[]=[],factories:readonly ModelAdapterFactory[]=[]){
  this.#profiles=new Map();this.#factories=new Map();
  for(const factory of factories){
   if(this.#factories.has(factory.protocol))throw new Error('Duplicate adapter protocol');
   // Snapshot declarations, but retain prototype methods and their original instance state.
   this.#factories.set(factory.protocol,{
    protocol:factory.protocol,authMethods:[...factory.authMethods],capabilities:[...factory.capabilities],evidenceClass:factory.evidenceClass,
    validate:factory.validate.bind(factory),create:factory.create.bind(factory),
   });
  }
  for(const profile of profiles){
   if(this.#profiles.has(profile.id))throw new Error('Duplicate connection profile');
   const snapshot=structuredClone(profile);
   // An absent optional reference has one JSON identity, including explicit undefined.
   if(snapshot.backend==='model-provider'&&snapshot.auth&&snapshot.auth.secretRef===undefined)delete snapshot.auth.secretRef;
   this.#profiles.set(profile.id,snapshot);
  }
 }
 list(){return [...this.#profiles.values()].map(profile=>({...structuredClone(profile),configHash:hash(profile),diagnostics:validate(profile,profile.backend==='model-provider'?this.#factories.get(profile.protocol):undefined)}));}
 resolve(profileId:string,requiredCapabilities:readonly string[]):ResolvedConnection{
  const found=this.#profiles.get(profileId);if(!found)return {status:'unavailable',diagnostics:[diagnostic('profile_missing','Choose an explicitly configured connection; no fallback is selected.')]};
  const profile=structuredClone(found);const factory=profile.backend==='model-provider'?this.#factories.get(profile.protocol):undefined;
  const errors=validate(profile,factory);
  if(profile.backend==='model-provider'&&Array.isArray(profile.capabilities)&&requiredCapabilities.some(c=>!profile.capabilities.includes(c)))errors.push(diagnostic('capability_missing','The selected connection does not supply all required capabilities.'));
  if(errors.length||profile.backend!=='model-provider'||!factory)return {status:'unavailable',diagnostics:errors};
  let adapter:ProviderAdapter;try{adapter=factory.create(structuredClone(profile));}catch{return {status:'unavailable',diagnostics:[diagnostic('adapter_configuration_invalid','Adapter could not validate the selected configuration.')]};}const d=adapter.descriptor;
  if(d.provider!==profile.providerKind||d.model!==profile.model||d.configVersion!==profile.revision||!d.enabled||d.evidenceClass!==factory.evidenceClass||requiredCapabilities.some(c=>!d.capabilities.includes(c)))return {status:'unavailable',diagnostics:[diagnostic('adapter_contract_mismatch','Adapter descriptor does not match the selected profile.')]};
  // Pin every consequential profile field, not just a caller-supplied revision label.
  const configHash=hash(profile);const descriptor=Object.freeze({...d,configVersion:configHash,capabilities:Object.freeze([...d.capabilities])});
  return {status:'selected',profile,configHash,adapter:{descriptor,invoke:request=>adapter.invoke(request)}};
 }
}
