import {DomainError,hash} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import {CommitOutcomeUnknownError} from './storage.ts';
import type {Store,CommitResult,Operation} from './storage.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import {callTool} from './tool-call.ts';
import {isCliProvider} from './connection-workbench.ts';
import type {ConnectionWorkbench} from './connection-workbench.ts';
import type {LoginConnections} from './connection-logins.ts';

export interface ConnectionFacts {
 status:'unverified'|'detected'|'absent'|'expired'|'invalid'|'unavailable'|'unknown';
 update:'unknown'|'available'|'current';restart:'unknown'|'required'|'not-required';
 source:'cli-status'|'model-discovery'|'provider-response'|'host';
}
export interface ConnectionObservation extends ConnectionFacts {observedAt:number}
export interface LifecycleCommand {commandId:string;connectionId:string;expectedConfigHash:string}
export type ConnectionTarget=ReturnType<ConnectionWorkbench['list']>['connections'][number];
type Kind='recheck'|'replace-key';
type Status='pending'|'completed'|'unknown'|'stale'|'rejected';
interface Attempt {commandId:string;connectionId:string;configHash:string;kind:Kind;status:Status;generation:number;observation:ConnectionObservation|null}
export interface ConnectionLifecycleState {kind:'connection-lifecycle';id:string;attempts:Attempt[]}
type State=ConnectionLifecycleState;
type Command=({kind:Kind}&LifecycleCommand)|{kind:'settle';commandId:string;status:'completed'|'unknown'|'rejected';observation:ConnectionObservation|null};
export interface LifecycleResult {status:'completed'|'unknown'|'stale';connectionId:string;observation:ConnectionObservation|null}
export class ConnectionLifecycleRefusedError extends DomainError {}
interface Options {
 logins?:LoginConnections;admit?:()=>Promise<void>;clock?:()=>number;
 observe?:(target:ConnectionTarget,signal:AbortSignal)=>Promise<ConnectionFacts>;
}
export const CONNECTION_LIFECYCLE_ID=ASSISTANT_CONVERSATION_PREFIX+'connection-lifecycle';
const resultCommandId=(commandId:string)=>'assistant-connection-lifecycle:'+hash(commandId).slice(0,32);
const actor=(command:Command)=>command.kind==='settle'?'connection-host':'local-owner';
const fingerprint=(command:Command)=>hash({actorId:actor(command),command});
const unknownFacts:ConnectionFacts={status:'unknown',update:'unknown',restart:'unknown',source:'host'};
function ensure(value:unknown,message:string,code:'invalid'|'conflict'='invalid'):asserts value {if(!value)throw new DomainError(message,code);}
function exact(value:unknown,keys:string[]):asserts value is Record<string,any>{boundedPlainJson(value);ensure(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'Exact lifecycle fields required');}
const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function facts(value:unknown):ConnectionFacts {
 exact(value,['status','update','restart','source']);ensure(['unverified','detected','absent','expired','invalid','unavailable','unknown'].includes(value.status)&&['unknown','available','current'].includes(value.update)&&['unknown','required','not-required'].includes(value.restart)&&['cli-status','model-discovery','provider-response','host'].includes(value.source),'Invalid host connection observation');
 return {status:value.status,update:value.update,restart:value.restart,source:value.source};
}
function state(value:unknown):State {
 if(value===undefined)return {kind:'connection-lifecycle',id:CONNECTION_LIFECYCLE_ID,attempts:[]};
 exact(value,['kind','id','attempts']);ensure(value.kind==='connection-lifecycle'&&value.id===CONNECTION_LIFECYCLE_ID&&Array.isArray(value.attempts)&&value.attempts.length<=128,'Invalid stored connection lifecycle');
 for(const a of value.attempts){exact(a,['commandId','connectionId','configHash','kind','status','generation','observation']);ensure(id(a.commandId)&&id(a.connectionId)&&digest(a.configHash)&&['recheck','replace-key'].includes(a.kind)&&['pending','completed','unknown','stale','rejected'].includes(a.status)&&Number.isSafeInteger(a.generation)&&a.generation>0,'Invalid stored lifecycle attempt');if(a.observation!==null){exact(a.observation,['status','update','restart','source','observedAt']);const {observedAt,...rest}=a.observation;facts(rest);ensure(Number.isSafeInteger(observedAt)&&observedAt>=0,'Invalid stored observation time');}}
 ensure(new Set(value.attempts.map((a:Attempt)=>a.commandId)).size===value.attempts.length&&value.attempts.every((a:Attempt,i:number)=>a.generation===i+1),'Invalid lifecycle generation');
 return structuredClone(value) as State;
}
export function isConnectionLifecycleState(value:unknown):value is ConnectionLifecycleState {try{if(value===undefined)return false;state(value);return true;}catch{return false;}}
function apply(current:State,command:Command){
 const value=state(current);
 if(command.kind==='settle'){
  exact(command,['kind','commandId','status','observation']);ensure(id(command.commandId)&&['completed','unknown','rejected'].includes(command.status),'Invalid lifecycle settlement');
  const a=value.attempts.find(a=>a.commandId===command.commandId);ensure(a&&a.status==='pending','Lifecycle claim changed','conflict');
  if(command.observation!==null){exact(command.observation,['status','update','restart','source','observedAt']);const {observedAt,...rest}=command.observation;facts(rest);ensure(Number.isSafeInteger(observedAt)&&observedAt>=0,'Invalid host observation time');}
  ensure(a.kind==='recheck'&&command.status==='completed'?command.observation!==null:command.observation===null,'Observation does not match lifecycle intent');
  const latest=value.attempts.findLast(b=>b.connectionId===a.connectionId&&b.configHash===a.configHash);
  a.status=a.kind==='recheck'&&latest!==a?'stale':command.status;a.observation=structuredClone(command.observation);
 }else {
  exact(command,['kind','commandId','connectionId','expectedConfigHash']);ensure(['recheck','replace-key'].includes(command.kind)&&id(command.commandId)&&!command.commandId.startsWith('assistant-')&&id(command.connectionId)&&digest(command.expectedConfigHash),'Invalid lifecycle intent');
  ensure(!value.attempts.some(a=>a.commandId===command.commandId),'Lifecycle command already claimed','conflict');ensure(value.attempts.length<128,'Connection lifecycle command limit reached');
  if(command.kind==='replace-key')ensure(!value.attempts.some(a=>a.connectionId===command.connectionId&&a.kind===command.kind&&(a.status==='pending'||a.status==='unknown')),'Earlier key replacement is unresolved; never resend','conflict');
  value.attempts.push({commandId:command.commandId,connectionId:command.connectionId,configHash:command.expectedConfigHash,kind:command.kind,status:'pending',generation:value.attempts.length+1,observation:null});
 }
 return {value,events:[{type:'connection-lifecycle',actor:actor(command),command:structuredClone(command)}]};
}
export function replayConnectionLifecycle(operation:Operation<ConnectionLifecycleState>,prior:Operation<ConnectionLifecycleState>|undefined):void {
 state(operation.value);ensure(operation.aggregateId===CONNECTION_LIFECYCLE_ID&&(!prior||prior.aggregateId===CONNECTION_LIFECYCLE_ID)&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Connection lifecycle revision lineage mismatch');
 ensure(operation.events.length===1,'One connection lifecycle event required');const e=operation.events[0];exact(e,['type','actor','command']);
 ensure(e.type==='connection-lifecycle'&&e.actor===actor(e.command)&&operation.commandId===(e.command.kind==='settle'?resultCommandId(e.command.commandId):e.command.commandId),'Connection lifecycle event identity mismatch');
 ensure(operation.fingerprint===fingerprint(e.command),'Connection lifecycle fingerprint mismatch');const derived=apply(state(prior?.value),e.command);
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Connection lifecycle transition mismatch');
}
/** Persist intent before effects. This service must receive the server's ownerStore. */
export class ConnectionLifecycle {
 readonly #store:Store<any>;readonly #connections:ConnectionWorkbench;readonly #options:Options;readonly #stop=new AbortController();readonly #active=new Set<Promise<unknown>>();
 constructor(ownerStore:Store<any>,connections:ConnectionWorkbench,options:Options={}){this.#store=ownerStore;this.#connections=connections;this.#options=options;}
 async #admit(){if(this.#stop.signal.aborted)throw new HostDrainError();await this.#options.admit?.();if(this.#stop.signal.aborted)throw new HostDrainError();}
 #target(command:LifecycleCommand){const target=this.#connections.list().connections.find(c=>c.id===command.connectionId);ensure(target&&target.configHash===command.expectedConfigHash,'Connection changed; refresh before lifecycle command','conflict');return target;}
 async #state(){const s=await this.#store.load(CONNECTION_LIFECYCLE_ID);return {revision:s?.revision??0,value:state(s?.value)};}
 async outcome(input:unknown){
  exact(input,['commandId','connectionId','expectedConfigHash','kind']);ensure(id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.connectionId)&&digest(input.expectedConfigHash)&&['replace-key','recheck'].includes(input.kind),'Invalid lifecycle receipt identity');
  const read=await this.#store.readState(CONNECTION_LIFECYCLE_ID),attempt=state(read.snapshot?.value).attempts.find(a=>a.commandId===input.commandId);
  return {feedId:read.feedId,commandId:input.commandId,status:!attempt?'unknown':attempt.connectionId!==input.connectionId||attempt.configHash!==input.expectedConfigHash||attempt.kind!==input.kind?'conflict':attempt.status==='pending'||attempt.kind==='replace-key'&&attempt.status==='unknown'?'unknown':'settled'};
 }
 async retry(input:unknown){
  try{exact(input,['commandId','missionId','workId','expectedRevision','connectionId','expectedConfigHash','effectId','replacementCommandId']);const request=structuredClone(input);
   await this.#admit();return await this.#connections.retryCredential(request,this.#store,async()=>{
    const current=await this.#state(),key=current.value.attempts.findLast(a=>a.connectionId===request.connectionId&&a.kind==='replace-key'&&a.status!=='rejected');
    ensure(key&&key.commandId===request.replacementCommandId&&key.configHash===request.expectedConfigHash&&key.status==='completed','Exact completed credential replacement required');await this.#admit();
   });
  }catch(error){if(error instanceof DomainError)throw new ConnectionLifecycleRefusedError(error.message,error.code);throw error;}
 }
 async read(){
  const feedId=(await this.#store.readState()).feedId,s=await this.#state();
  const connections=await Promise.all(this.#connections.list().connections.map(async c=>{
   const attempts=s.value.attempts.filter(a=>a.connectionId===c.id&&a.configHash===c.configHash),latest=attempts.at(-1),key=attempts.findLast(a=>a.kind==='replace-key'&&a.status!=='rejected');
   const fault=this.#connections.credentialFault(c.id,c.configHash);return {connectionId:c.id,configHash:c.configHash,secretSource:this.#connections.secretSource(c.id),canReplaceKey:this.#connections.canReplaceKey(c.id),credentialStorage:await this.#connections.credentialStored(c.id,c.configHash),credentialWriteStatus:key?(key.status==='completed'?'stored' as const:'unknown' as const):'idle' as const,observation:fault?{status:fault.kind==='expired'?'expired' as const:'invalid' as const,update:'unknown' as const,restart:'unknown' as const,source:'provider-response' as const,observedAt:fault.observedAt}:latest?.kind==='recheck'&&latest.status==='completed'?latest.observation:null,replacementCommandId:key?.status==='completed'?key.commandId:null};
  }));
  ensure((await this.#store.readState()).feedId===feedId,'Database feed changed during lifecycle read','conflict');return {feedId,revision:s.revision,connections};
 }
 recheck(input:unknown){return this.#start('recheck',input);}
 replaceKey(input:unknown){return this.#start('replace-key',input);}
 #start(kind:Kind,input:unknown){
  // Post-write failures return unknown inside #run; only definite refusals escape.
  const pending=this.#run(kind,input).catch(error=>{if(error instanceof DomainError)throw new ConnectionLifecycleRefusedError(error.message,error.code);throw error;});this.#active.add(pending);void pending.then(()=>this.#active.delete(pending),()=>this.#active.delete(pending));return pending;
 }
 async #dispatch(feedId:string,commandId:string,command:Command):Promise<CommitResult<State>> {
  const identity={id:CONNECTION_LIFECYCLE_ID,commandId,fingerprint:fingerprint(command)};
  for(let n=0;n<3;n++){
   const snapshot=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const {value,events}=apply(snapshot.value,command);await this.#admit();ensure((await this.#store.readState()).feedId===feedId,'Database feed changed during lifecycle command','conflict');await this.#admit();
   const result=await this.#store.commit({...identity,expectedRevision:snapshot.revision,value,events,outbox:[]});
   if(result.status==='conflict'&&result.reason==='idempotency'){const stored=await this.#store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  throw new DomainError('Connection lifecycle changed; refresh','conflict');
 }
 async #run(kind:Kind,input:unknown):Promise<LifecycleResult>{
  exact(input,['commandId','connectionId','expectedConfigHash',...(kind==='replace-key'?['apiKey']:[])]);
  ensure(id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.connectionId)&&digest(input.expectedConfigHash),'Invalid lifecycle identity');
  let apiKey=kind==='replace-key'?input.apiKey:'';ensure(kind!=='replace-key'||typeof apiKey==='string'&&apiKey.length>0&&apiKey.length<=1024&&!/[^\x21-\x7e]/.test(apiKey),'Invalid API key');
  const command:LifecycleCommand={commandId:input.commandId,connectionId:input.connectionId,expectedConfigHash:input.expectedConfigHash};
  const target=this.#target(command);if(kind==='replace-key')ensure(this.#connections.canReplaceKey(target.id),'Connection has no editable secret slot');
  await this.#admit();const feedId=(await this.#store.readState()).feedId;
  const check=async()=>{await this.#admit();ensure((await this.#store.readState()).feedId===feedId,'Database changed during connection lifecycle','conflict');await this.#admit();this.#target(command);};
  let claim:CommitResult<State>;try{claim=await this.#dispatch(feedId,command.commandId,{kind,...command});}catch(error){apiKey='';if(error instanceof CommitOutcomeUnknownError)return {status:'unknown',connectionId:target.id,observation:null};throw error;}
  ensure(claim.status!=='conflict','Lifecycle command identity conflict','conflict');
  if(claim.status!=='committed'){apiKey='';const stored=(await this.#state()).value.attempts.find(a=>a.commandId===command.commandId);if(stored?.status==='rejected')throw new DomainError('Key replacement was rejected before writing; use a new command after refreshing','conflict');return {status:!stored||stored.status==='pending'?'unknown':stored.status,connectionId:target.id,observation:stored?.observation??null};}
  let observation:ConnectionObservation|null=null,status:'completed'|'unknown'|'rejected'='completed',rejection:DomainError|undefined,keyStored=false;
  try{
   await check();
   if(kind==='replace-key'){await this.#connections.replaceKey(target.id,target.configHash,apiKey,feedId);keyStored=true;}
   else {const observed=await callTool(signal=>this.#observe(target,signal),{readOnly:true,signal:this.#stop.signal,timeoutMs:15000});const observedAt=(this.#options.clock??Date.now)();ensure(Number.isSafeInteger(observedAt)&&observedAt>=0,'Invalid host observation time');observation={...facts(observed),observedAt};}
   await check();
  }catch(error){rejection=kind==='replace-key'&&!keyStored&&error instanceof DomainError?error:undefined;status=rejection?'rejected':'unknown';observation=null;}finally{apiKey='';}
  let result:LifecycleResult={status:'unknown',connectionId:target.id,observation:null};
  try{
   await check();const finished=await this.#dispatch(feedId,resultCommandId(command.commandId),{kind:'settle',commandId:command.commandId,status,observation});
   if(finished.status!=='conflict'){const a=finished.value.attempts.find(a=>a.commandId===command.commandId)!;result={status:a.status==='completed'||a.status==='stale'?a.status:'unknown',connectionId:target.id,observation:a.observation};}
  }catch{}
  if(rejection)throw rejection;return result;
 }
 async #observe(target:ConnectionTarget,signal:AbortSignal):Promise<ConnectionFacts>{
  if(this.#options.observe)return this.#options.observe(target,signal);
  if(isCliProvider(target.providerType)){
   const login=await this.#options.logins?.recheck(target.providerType,signal);return {...unknownFacts,status:login?.status??'unknown',source:'cli-status'};
  }
  const result=await this.#connections.discover(target.id,target.configHash,signal);return {...unknownFacts,status:result.credentialFailure?.kind==='expired'?'expired':result.credentialFailure?'invalid':result.status==='listed'?'unverified':result.status==='stale'?'unknown':'unavailable',source:result.credentialFailure?'provider-response':'model-discovery'};
 }
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active]);}
}
