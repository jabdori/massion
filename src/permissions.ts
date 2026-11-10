/** Permission rules for Settings > Permissions (docs/architecture/settings.md, ADR 0002 §5, ADR 0003 invariant 4). Only the owner writes; the second kind of decision has no rule. */
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';
import {withAdmissionFeed} from './storage.ts';
import {checkSlot} from './secret-slots.ts';
import type {SecretSlot} from './secret-slots.ts';
import {SecretSourceError} from './secret-sources.ts';

export const PERMISSIONS_ID=ASSISTANT_CONVERSATION_PREFIX+'permissions',MAX_RULES=64;
/** The first kind of owner decision (ADR 0002 §5 A). Only these may be allowed without asking. */
export const ALLOW_KINDS={spend:'Spend money',send:'Send as me',delete:'Delete',delegate:'Hand to a new member'} as const;
/** Always asked: the first kind, and checking rules from the second kind, which no rule can allow. */
const ASK={...ALLOW_KINDS,'check-rules':'Change check rules'} as const;
export type AllowKind=keyof typeof ALLOW_KINDS;
export interface PermissionRule {id:string;what:string;kind:AllowKind;at:number}
export interface SecretConsumer {kind:'connection'|'member';id:string}
export interface SecretGrant {id:string;secret:SecretSlot;sourceHash:string;consumer:SecretConsumer;purpose:string;at:number}
export interface SecretImport {id:string;secret:SecretSlot;sourceHash:string;grantId:string;at:number;status:'pending'|'completed'|'unavailable'|'superseded'}
export interface PermissionsState {kind:'permissions';id:string;rules:PermissionRule[];secretGrants?:SecretGrant[];secretImports?:SecretImport[]}
export type PermissionsCommand = {type:'allow-rule';ruleId:string;what:string;kind:AllowKind} | {type:'remove-rule';ruleId:string}
 | ({type:'grant-secret'}&Omit<SecretGrant,'at'>) | {type:'revoke-secret';grantId:string}
 | {type:'claim-secret-import';importId:string;grantId:string} | {type:'settle-secret-import';importId:string;status:'completed'|'unavailable'};
export const isPermissionsState=(value:unknown):value is PermissionsState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='permissions';
export const ruleId=(commandId:string)=>'rule-'+hash(commandId).slice(0,16);
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=120&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);

export function applyPermissions(current:PermissionsState|null,command:PermissionsCommand,actor:Actor,time:TimeObservation):{value:PermissionsState;events:unknown[]} {
 const host=command?.type==='claim-secret-import'||command?.type==='settle-secret-import';
 ensure(actor&&id(actor.id)&&(host?actor.id==='secret-host'&&actor.roles.includes('representative'):actor.roles.includes('owner')),'Actor lacks required role','denied');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');
 const state:PermissionsState=current?structuredClone(current):{kind:'permissions',id:PERMISSIONS_ID,rules:[]};
 switch(command?.type){
  case 'grant-secret': {
   ensure(exact(command,['type','id','secret','sourceHash','consumer','purpose'])&&id(command.id)&&typeof command.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(command.sourceHash)&&exact(command.consumer,['kind','id'])&&['member','connection'].includes(command.consumer.kind)&&id(command.consumer.id)&&line(command.purpose),'Exact secret grant required');checkSlot(command.secret);
   const grants=state.secretGrants??=[];ensure(grants.length<MAX_RULES&&!grants.some(g=>g.id===command.id||hash([g.secret,g.sourceHash,g.consumer,g.purpose])===hash([command.secret,command.sourceHash,command.consumer,command.purpose])),'Secret grant already exists or limit reached','conflict');
   ensure(!grants.some(g=>hash(g.secret)===hash(command.secret)&&g.sourceHash!==command.sourceHash),'Revoke the previous source before changing a shared secret slot','conflict');
   const imports=(state.secretImports??[]).filter(i=>hash(i.secret)===hash(command.secret));
   ensure(!imports.some(i=>i.sourceHash!==command.sourceHash&&['pending','unavailable'].includes(i.status)),'Unresolved import prevents reuse of this slot','conflict');
   for(const imported of imports)if(imported.sourceHash!==command.sourceHash&&imported.status==='completed')imported.status='superseded';
   const {type,...grant}=command;grants.push({...structuredClone(grant),at:time.observedAt});break;
  }
  case 'revoke-secret': {ensure(exact(command,['type','grantId'])&&id(command.grantId),'Exact secret revocation required');const at=(state.secretGrants??[]).findIndex(g=>g.id===command.grantId);ensure(at>=0,'Unknown secret grant','conflict');state.secretGrants!.splice(at,1);break;}
  case 'claim-secret-import': {
   ensure(exact(command,['type','importId','grantId'])&&id(command.importId)&&id(command.grantId),'Exact import claim required');const grant=state.secretGrants?.find(g=>g.id===command.grantId);ensure(grant,'Secret grant required','denied');
   const imports=state.secretImports??=[];ensure(imports.length<128&&!imports.some(i=>i.id===command.importId||hash(i.secret)===hash(grant.secret)&&['pending','unavailable'].includes(i.status)),'Import already claimed; never resend','conflict');
   ensure(command.importId===secretImportId(grant.secret,grant.sourceHash),'Import identity mismatch');imports.push({id:command.importId,secret:structuredClone(grant.secret),sourceHash:grant.sourceHash,grantId:grant.id,at:time.observedAt,status:'pending'});break;
  }
  case 'settle-secret-import': {
   ensure(exact(command,['type','importId','status'])&&['completed','unavailable'].includes(command.status),'Exact import settlement required');const imported=state.secretImports?.find(i=>i.id===command.importId);ensure(imported?.status==='pending','Import already settled','conflict');imported.status=command.status;break;
  }
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
const commandActor=(command:PermissionsCommand)=>command.type==='claim-secret-import'||command.type==='settle-secret-import'?'secret-host':'local-owner';
const fingerprint=(actorId:string,command:PermissionsCommand)=>hash({actorId,command});
export const secretImportId=(secret:SecretSlot,sourceHash:string)=>'import-'+hash({secret,sourceHash}).slice(0,32);
const importCommandId=(command:PermissionsCommand)=>'assistant-secret-'+hash(command).slice(0,32);
/** Backup lineage: every operation is an owner command with a caller ID, and an added rule's ID follows from it. */
export function replayPermissions(operation:Operation<PermissionsState>,prior:Operation<PermissionsState>|undefined):void {
 ensure(operation.aggregateId===PERMISSIONS_ID&&operation.value.id===PERMISSIONS_ID,'permissions aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:PermissionsCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'permissions operation requires one typed event');
 ensure(event.actor===commandActor(event.command),'permissions actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(event.actor==='secret-host'?operation.commandId===importCommandId(event.command):!operation.commandId.startsWith('assistant-')&&(event.command.type!=='allow-rule'||event.command.ruleId===ruleId(operation.commandId))&&(event.command.type!=='grant-secret'||event.command.id===ruleId(operation.commandId)),'permissions command identity mismatch');
 const next=applyPermissions(prior?prior.value:null,event.command,{id:event.actor,roles:[event.actor==='secret-host'?'representative':'owner']},event.time);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'permissions command/state transition');
}

const OWNER='local-owner',owner:Actor={id:OWNER,roles:['owner']};
export class PermissionsService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(PERMISSIONS_ID) as Snapshot<PermissionsState>|null;}
 async read(){const s=await this.#state();return {revision:s?.revision??0,ask:Object.entries(ASK).map(([kind,label])=>({kind,label})),allow:(s?.value.rules??[]).map(r=>({...r,label:ALLOW_KINDS[r.kind]})),...(s?.value.secretGrants?{secrets:structuredClone(s.value.secretGrants)}:{})};}
 /** The owner's Add and Remove. Add's rule ID derives from the command ID, so a resent Add commits once. */
 async act(input:unknown):Promise<CommitResult<PermissionsState>>{
  input=structuredClone(input);
  if((input as any)?.action==='grant-secret'||(input as any)?.action==='revoke-secret'){
   const grant=(input as any).action==='grant-secret';ensure(exact(input,grant?['commandId','action','secret','sourceHash','consumer','purpose']:['commandId','action','grantId'])&&id(input.commandId)&&!input.commandId.startsWith('assistant-'),'Exact secret permission fields required');
   return this.#dispatch(input.commandId,grant?{type:'grant-secret',id:ruleId(input.commandId),secret:input.secret as SecretSlot,sourceHash:input.sourceHash as string,consumer:input.consumer as SecretConsumer,purpose:input.purpose as string}:{type:'revoke-secret',grantId:input.grantId as string});
  }
  const allow=(input as {action?:unknown})?.action==='allow';ensure(exact(input,allow?['commandId','action','what','kind']:['commandId','action','ruleId'])&&id(input.commandId)&&(allow||input.action==='remove'&&id(input.ruleId)),'Exact permission fields required');
  const commandId=input.commandId as string;ensure(!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');
  return this.#dispatch(commandId,allow?{type:'allow-rule',ruleId:ruleId(commandId),what:input.what as string,kind:input.kind as AllowKind}:{type:'remove-rule',ruleId:input.ruleId as string});
 }
 async authorizeSecret(secret:SecretSlot,sourceHash:string,consumer:SecretConsumer,purpose:string,expected?:{feedId:string;grantId:string}){
  const read=await this.#store.readState(PERMISSIONS_ID),state=read.snapshot?.value as PermissionsState|undefined;
  const grant=state?.secretGrants?.find(g=>hash([g.secret,g.sourceHash,g.consumer,g.purpose])===hash([secret,sourceHash,consumer,purpose]));
  if(!grant||expected&&(expected.feedId!==read.feedId||expected.grantId!==grant.id))throw new SecretSourceError('grant-required');
  return {feedId:read.feedId,grantId:grant.id};
 }
 async imported(secret:SecretSlot,sourceHash:string){return (await this.#state())?.value.secretImports?.find(i=>i.id===secretImportId(secret,sourceHash));}
 async claimImport(secret:SecretSlot,sourceHash:string,grant:{feedId:string;grantId:string}){
  const command:PermissionsCommand={type:'claim-secret-import',importId:secretImportId(secret,sourceHash),grantId:grant.grantId};
  return withAdmissionFeed(grant.feedId,()=>this.#dispatch(importCommandId(command),command));
 }
 async settleImport(secret:SecretSlot,sourceHash:string,feedId:string,status:'completed'|'unavailable'){
  const command:PermissionsCommand={type:'settle-secret-import',importId:secretImportId(secret,sourceHash),status};
  return withAdmissionFeed(feedId,()=>this.#dispatch(importCommandId(command),command));
 }
 /** Lookup after the load and after an idempotency conflict, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,command:PermissionsCommand):Promise<CommitResult<PermissionsState>>{
  const actorId=commandActor(command),identity={id:PERMISSIONS_ID,commandId,fingerprint:fingerprint(actorId,command)};
  for(let attempt=0;attempt<3;attempt++){
   // Load, then look up: a resend overlapping its first request sees that commit instead of failing the reducer on it.
   const snapshot=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const {value,events}=applyPermissions(snapshot?.value??null,command,actorId===OWNER?owner:{id:actorId,roles:['representative']},{observedAt:this.#clock()});
   const result=await this.#store.commit({id:PERMISSIONS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   // Same command, other clock reading: the digest differs, so replay the stored result by its fingerprint.
   if(result.status==='conflict'&&result.reason==='idempotency'){const stored=await this.#store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
