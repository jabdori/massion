/** Permission rules for Settings > Permissions (docs/architecture/settings.md, ADR 0002 §5, ADR 0003 invariant 4). Only the owner writes; the second kind of decision has no rule. */
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const PERMISSIONS_ID=ASSISTANT_CONVERSATION_PREFIX+'permissions',MAX_RULES=64;
/** The first kind of owner decision (ADR 0002 §5 A). Only these may be allowed without asking. */
export const ALLOW_KINDS={spend:'Spend money',send:'Send as me',delete:'Delete',delegate:'Hand to a new member'} as const;
/** Always asked: the first kind, and checking rules from the second kind, which no rule can allow. */
const ASK={...ALLOW_KINDS,'check-rules':'Change check rules'} as const;
export type AllowKind=keyof typeof ALLOW_KINDS;
export interface PermissionRule {id:string;what:string;kind:AllowKind;at:number}
export interface PermissionsState {kind:'permissions';id:string;rules:PermissionRule[]}
export type PermissionsCommand = {type:'allow-rule';ruleId:string;what:string;kind:AllowKind} | {type:'remove-rule';ruleId:string};
export const isPermissionsState=(value:unknown):value is PermissionsState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='permissions';
export const ruleId=(commandId:string)=>'rule-'+hash(commandId).slice(0,16);
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=120&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);

export function applyPermissions(current:PermissionsState|null,command:PermissionsCommand,actor:Actor,time:TimeObservation):{value:PermissionsState;events:unknown[]} {
 ensure(actor&&id(actor.id)&&actor.roles.includes('owner'),'Actor lacks required role','denied');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');
 const state:PermissionsState=current?structuredClone(current):{kind:'permissions',id:PERMISSIONS_ID,rules:[]};
 switch(command?.type){
  case 'allow-rule': {
   ensure(exact(command,['type','ruleId','what','kind'])&&id(command.ruleId)&&line(command.what),'Exact rule fields required');ensure(typeof command.kind==='string'&&Object.hasOwn(ALLOW_KINDS,command.kind),'Unknown rule kind: checking rules and widening permissions are always asked');
   ensure(!state.rules.some(r=>r.id===command.ruleId||r.kind===command.kind&&r.what.toLowerCase()===command.what.toLowerCase()),'Rule already exists','conflict');ensure(state.rules.length<MAX_RULES,'Rule bound reached','conflict');
   state.rules.push({id:command.ruleId,what:command.what,kind:command.kind,at:time.observedAt});break;
  }
  case 'remove-rule': {ensure(exact(command,['type','ruleId']),'Exact rule fields required');const at=state.rules.findIndex(r=>r.id===command.ruleId);ensure(at>=0,'Unknown rule','conflict');state.rules.splice(at,1);break;}
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const fingerprint=(actorId:string,command:PermissionsCommand)=>hash({actorId,command});
/** Backup lineage: every operation is an owner command with a caller ID, and an added rule's ID follows from it. */
export function replayPermissions(operation:Operation<PermissionsState>,prior:Operation<PermissionsState>|undefined):void {
 ensure(operation.aggregateId===PERMISSIONS_ID&&operation.value.id===PERMISSIONS_ID,'permissions aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:PermissionsCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'permissions operation requires one typed event');
 ensure(event.actor===OWNER,'permissions actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(!operation.commandId.startsWith('assistant-')&&(event.command.type!=='allow-rule'||event.command.ruleId===ruleId(operation.commandId)),'permissions command identity mismatch');
 const next=applyPermissions(prior?prior.value:null,event.command,{id:event.actor,roles:['owner']},event.time);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'permissions command/state transition');
}

const OWNER='local-owner',owner:Actor={id:OWNER,roles:['owner']};
export class PermissionsService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(PERMISSIONS_ID) as Snapshot<PermissionsState>|null;}
 async read(){const s=await this.#state();return {revision:s?.revision??0,ask:Object.entries(ASK).map(([kind,label])=>({kind,label})),allow:(s?.value.rules??[]).map(r=>({...r,label:ALLOW_KINDS[r.kind]}))};}
 /** The owner's Add and Remove. Add's rule ID derives from the command ID, so a resent Add commits once. */
 async act(input:unknown):Promise<CommitResult<PermissionsState>>{
  const allow=(input as {action?:unknown})?.action==='allow';ensure(exact(input,allow?['commandId','action','what','kind']:['commandId','action','ruleId'])&&id(input.commandId)&&(allow||input.action==='remove'&&id(input.ruleId)),'Exact permission fields required');
  const commandId=input.commandId as string;ensure(!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');
  return this.#dispatch(commandId,allow?{type:'allow-rule',ruleId:ruleId(commandId),what:input.what as string,kind:input.kind as AllowKind}:{type:'remove-rule',ruleId:input.ruleId as string});
 }
 /** Lookup before and after the load, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,command:PermissionsCommand):Promise<CommitResult<PermissionsState>>{
  const identity={id:PERMISSIONS_ID,commandId,fingerprint:fingerprint(OWNER,command)};
  for(let attempt=0;attempt<3;attempt++){
   const prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const snapshot=await this.#state(),{value,events}=applyPermissions(snapshot?.value??null,command,owner,{observedAt:this.#clock()});
   const result=await this.#store.commit({id:PERMISSIONS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
