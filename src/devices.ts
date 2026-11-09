import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import {callTool} from './tool-call.ts';
import {FeedAdmissionError,withAdmissionFeed} from './storage.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const DEVICES_ID=ASSISTANT_CONVERSATION_PREFIX+'devices';
type DeviceStatus='connected'|'offline'|'unknown';
export interface DeviceAdapter {
 id:string;
 inspect(input:{deviceId:string;signal:AbortSignal}):Promise<{status:'connected'|'offline'}>;
 connect(input:{deviceId:string;commandId:string;signal:AbortSignal}):Promise<{status:'connected'|'offline'}>;
 disconnect(input:{deviceId:string;commandId:string;signal:AbortSignal}):Promise<{status:'connected'|'offline'}>;
}
interface DeviceOperation {id:string;deviceId:string;adapterId:string;decisionId:string;action:'connect'|'disconnect';status:DeviceStatus}
export interface DevicesState {kind:'devices';id:string;operations:DeviceOperation[]}
type DevicesCommand={type:'claim-device';operation:DeviceOperation}|{type:'settle-device';operationId:string;status:DeviceStatus};
type Admission={id:string;effect?:{kind:string;answer?:string;request:{kind:string;adapterId:string;deviceId?:string;deviceName?:string;agentName?:string}}};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function ensure(v:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
export const isDevicesState=(v:unknown):v is DevicesState=>!!v&&typeof v==='object'&&(v as {kind?:unknown}).kind==='devices';
function applyDevices(current:DevicesState|null,command:DevicesCommand,actor:Actor){
 ensure(['claim-device','settle-device'].includes(command?.type),'Unknown device command');
 const state:DevicesState=current?structuredClone(current):{kind:'devices',id:DEVICES_ID,operations:[]};
 if(command.type==='claim-device'){
  ensure(actor.id==='local-owner'&&actor.roles.includes('owner'),'Device owner required','denied');
  const op=command.operation;ensure(exact(command,['type','operation'])&&exact(op,['id','deviceId','adapterId','decisionId','action','status'])&&[op.id,op.deviceId,op.adapterId,op.decisionId].every(id)&&!op.id.startsWith('assistant-')&&['connect','disconnect'].includes(op.action)&&op.status==='unknown','Exact device claim required');
  ensure(!state.operations.some(o=>o.id===op.id),'Device command identity already claimed','conflict');ensure(!state.operations.some(o=>o.deviceId===op.deviceId&&o.status==='unknown'),'Unresolved device outcome; never resend','conflict');
  ensure(state.operations.length<256,'Device operation bound reached','conflict');state.operations.push(structuredClone(op));
 }else{
  ensure(actor.id==='device-host'&&actor.roles.includes('assistant'),'Device host required','denied');ensure(exact(command,['type','operationId','status'])&&['connected','offline','unknown'].includes(command.status),'Exact device observation required');
  const op=state.operations.find(o=>o.id===command.operationId);ensure(op&&op.status==='unknown','Original device claim required','conflict');op.status=command.status;
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command)}]};
}
export function replayDevices(operation:Operation<DevicesState>,prior:Operation<DevicesState>|undefined){
 ensure(operation.aggregateId===DEVICES_ID&&operation.value.id===DEVICES_ID&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Device revision lineage mismatch');
 const e=operation.events[0] as {type:string;actor:string;command:DevicesCommand};ensure(operation.events.length===1&&exact(e,['type','actor','command'])&&e.type===e.command?.type,'Exact device event required');
 const owner=e.command.type==='claim-device';ensure(e.actor===(owner?'local-owner':'device-host')&&operation.commandId===(e.command.type==='claim-device'?e.command.operation.id:'assistant-device:'+hash(e.command.operationId).slice(0,32)),'Device command identity mismatch');
 ensure(operation.fingerprint===hash({actorId:e.actor,command:e.command}),'Device fingerprint mismatch');const derived=applyDevices(prior?.value??null,e.command,{id:e.actor,roles:[owner?'owner':'assistant']});
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Device transition mismatch');
}

/** Connectivity never grants a Work handoff: each external effect still uses its original decision. */
export class DevicesService {
 readonly #store:Store<any>;readonly #owner:Store<any>;readonly #admissions:()=>Promise<Admission[]>;readonly #adapters:DeviceAdapter[];readonly #active=new Set<Promise<unknown>>();readonly #stop=new AbortController();
 constructor(store:Store<any>,owner:Store<any>,admissions:()=>Promise<Admission[]>,adapters:DeviceAdapter[]=[]){ensure(new Set(adapters.map(a=>a.id)).size===adapters.length,'Duplicate device adapter');this.#store=store;this.#owner=owner;this.#admissions=admissions;this.#adapters=adapters;}
 async #known(){const choices=new Map<string,Admission>();for(const d of await this.#admissions())if(d.effect?.kind==='external-member'&&d.effect.request.kind==='external-member'&&d.effect.request.deviceId){const previous=choices.get(d.effect.request.deviceId);if(!previous||d.effect.answer==='act'||previous.effect?.answer!=='act')choices.set(d.effect.request.deviceId,d);}return [...choices.values()];}
 async read(){
  const state=await this.#store.load(DEVICES_ID) as Snapshot<DevicesState>|null;
  const devices=await Promise.all((await this.#known()).map(async d=>{const r=d.effect!.request,adapter=this.#adapters.find(a=>a.id===r.adapterId),pending=state?.value.operations.find(o=>o.deviceId===r.deviceId&&o.status==='unknown');let status:DeviceStatus|'unavailable'=adapter?'unknown':'unavailable';
   if(adapter&&!pending)try{const observed=await callTool(signal=>adapter.inspect({deviceId:r.deviceId!,signal}),{readOnly:true,signal:this.#stop.signal});if(['connected','offline'].includes(observed.status))status=observed.status;}catch{}
   return {id:r.deviceId!,name:r.deviceName!,agent:r.agentName!,status,available:!!adapter,admitted:d.effect!.answer==='act',decisionId:d.id};
  }));return {revision:state?.revision??0,devices};
 }
 async act(input:unknown,expectedFeed?:string):Promise<CommitResult<DevicesState>>{
  ensure(exact(input,['commandId','deviceId','action'])&&id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.deviceId)&&['connect','disconnect'].includes(input.action),'Exact device command required');
  const value=structuredClone(input),task=this.#act(value as {commandId:string;deviceId:string;action:'connect'|'disconnect'},expectedFeed);this.#active.add(task);try{return await task;}finally{this.#active.delete(task);}
 }
 async #feed(expected:string){if((await this.#store.readState()).feedId!==expected)throw new FeedAdmissionError();}
 async #act(input:{commandId:string;deviceId:string;action:'connect'|'disconnect'},expectedFeed?:string):Promise<CommitResult<DevicesState>>{
  const feedId=expectedFeed??(await this.#store.readState()).feedId;await this.#feed(feedId);
  const d=(await this.#known()).find(d=>d.effect!.request.deviceId===input.deviceId);ensure(d?.effect?.answer==='act','Existing external-member admission decision required','denied');
  await this.#feed(feedId);const adapter=this.#adapters.find(a=>a.id===d.effect!.request.adapterId);ensure(adapter,'Device adapter unavailable','denied');
  const operation:DeviceOperation={id:input.commandId,deviceId:input.deviceId,adapterId:adapter.id,decisionId:d.id,action:input.action,status:'unknown'};
  // The claim is durable before a single adapter invocation.
  const command:DevicesCommand={type:'claim-device',operation},claim=await this.#dispatch(feedId,input.commandId,command,true);
  if(claim.status!=='committed')return claim;await this.#feed(feedId);
  let status:DeviceStatus='unknown';try{const observed=await callTool(signal=>adapter[input.action]({deviceId:input.deviceId,commandId:input.commandId,signal}),{signal:this.#stop.signal});if(['connected','offline'].includes(observed.status))status=observed.status;}catch{}
  await this.#feed(feedId);return this.#dispatch(feedId,'assistant-device:'+hash(input.commandId).slice(0,32),{type:'settle-device',operationId:input.commandId,status},false);
 }
 async #dispatch(feedId:string,commandId:string,command:DevicesCommand,owner:boolean):Promise<CommitResult<DevicesState>>{
  return withAdmissionFeed(feedId,async()=>{
  const actor:Actor={id:owner?'local-owner':'device-host',roles:[owner?'owner':'assistant']},identity={id:DEVICES_ID,commandId,fingerprint:hash({actorId:actor.id,command})},store=owner?this.#owner:this.#store;
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await store.load(DEVICES_ID),prior=await store.lookupOperation(identity);await this.#feed(feedId);if(prior.status!=='unknown'){ensure(prior.status!=='conflict'||prior.reason!=='idempotency','Device command identity conflict','conflict');return prior;}
   if(owner&&this.#stop.signal.aborted)throw new HostDrainError();const result=await store.commit({...identity,expectedRevision:snapshot?.revision??0,...applyDevices(snapshot?.value??null,command,actor),outbox:[]});if(result.status!=='conflict')return result;
  }return {status:'conflict',revision:(await store.load(DEVICES_ID))?.revision??0,reason:'revision'};
  });
 }
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();const results=await Promise.allSettled([...this.#active]);for(const result of results)if(result.status==='rejected')throw result.reason;const state=await this.#store.load(DEVICES_ID) as Snapshot<DevicesState>|null;ensure(!state?.value.operations.some(o=>o.status==='unknown'),'Device outcome remains unknown during shutdown','conflict');}
}
