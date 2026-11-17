/** Secret grants under Settings > Permissions (docs/architecture/secret-sources.md). Owner commands write grants; the host settles secret imports and writes. */
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
export interface SecretConsumer {kind:'connection'|'member';id:string}
export interface SecretGrant {id:string;secret:SecretSlot;sourceHash:string;consumer:SecretConsumer;purpose:string;at:number}
export interface SecretImport {id:string;secret:SecretSlot;sourceHash:string;grantId:string;at:number;status:'pending'|'completed'|'unavailable'|'superseded'}
export type SecretWrite=Omit<SecretImport,'status'>&{status:'pending'|'completed'|'unavailable'};
export interface PermissionsState {kind:'permissions';id:string;secretGrants?:SecretGrant[];secretImports?:SecretImport[];secretWrites?:SecretWrite[]}
export type PermissionsCommand = ({type:'grant-secret'}&Omit<SecretGrant,'at'>) | {type:'revoke-secret';grantId:string}
 | {type:'claim-secret-import';importId:string;grantId:string} | {type:'settle-secret-import';importId:string;status:'completed'|'unavailable'}
 | {type:'claim-secret-write';writeId:string;grantId:string} | {type:'settle-secret-write';writeId:string;status:'completed'|'unavailable'};
export const isPermissionsState=(value:unknown):value is PermissionsState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='permissions';
export const ruleId=(commandId:string)=>'rule-'+hash(commandId).slice(0,16);
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=120&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);

export function applyPermissions(current:PermissionsState|null,command:PermissionsCommand,actor:Actor,time:TimeObservation):{value:PermissionsState;events:unknown[]} {
 const host=commandActor(command)==='secret-host';
 ensure(actor&&id(actor.id)&&(host?actor.id==='secret-host'&&actor.roles.includes('representative'):actor.roles.includes('owner')),'Actor lacks required role','denied');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');
 const state:PermissionsState=current?structuredClone(current):{kind:'permissions',id:PERMISSIONS_ID};
 switch(command?.type){
  case 'grant-secret': {
   ensure(exact(command,['type','id','secret','sourceHash','consumer','purpose'])&&id(command.id)&&typeof command.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(command.sourceHash)&&exact(command.consumer,['kind','id'])&&['member','connection'].includes(command.consumer.kind)&&id(command.consumer.id)&&line(command.purpose),'Exact secret grant required');checkSlot(command.secret);
   const grants=state.secretGrants??=[];ensure(grants.length<MAX_RULES&&!grants.some(g=>g.id===command.id||hash([g.secret,g.sourceHash,g.consumer,g.purpose])===hash([command.secret,command.sourceHash,command.consumer,command.purpose])),'Secret grant already exists or limit reached','conflict');
   ensure(!grants.some(g=>hash(g.secret)===hash(command.secret)&&g.sourceHash!==command.sourceHash),'Revoke the previous source before changing a shared secret slot','conflict');
   const imports=(state.secretImports??[]).filter(i=>hash(i.secret)===hash(command.secret));
   ensure(!imports.some(i=>i.sourceHash!==command.sourceHash&&['pending','unavailable'].includes(i.status)),'Unresolved import prevents reuse of this slot','conflict');
   ensure(!(state.secretWrites??[]).some(w=>hash(w.secret)===hash(command.secret)&&w.sourceHash!==command.sourceHash&&w.status!=='completed'),'Unresolved own write prevents reuse of this slot','conflict');
   for(const imported of imports)if(imported.sourceHash!==command.sourceHash&&imported.status==='completed')imported.status='superseded';
   const {type,...grant}=command;grants.push({...structuredClone(grant),at:time.observedAt});break;
  }
  case 'revoke-secret': {ensure(exact(command,['type','grantId'])&&id(command.grantId),'Exact secret revocation required');const at=(state.secretGrants??[]).findIndex(g=>g.id===command.grantId);ensure(at>=0,'Unknown secret grant','conflict');state.secretGrants!.splice(at,1);break;}
  case 'claim-secret-write': {
   ensure(exact(command,['type','writeId','grantId'])&&id(command.writeId)&&id(command.grantId),'Exact own write claim required');const grant=state.secretGrants?.find(g=>g.id===command.grantId);ensure(grant&&grant.sourceHash===hash({kind:'own'}),'Own secret grant required','denied');
   const writes=state.secretWrites??=[];ensure(writes.length<128&&!writes.some(w=>w.id===command.writeId||hash(w.secret)===hash(grant.secret)&&w.status!=='completed')&&!(state.secretImports??[]).some(i=>hash(i.secret)===hash(grant.secret)&&['pending','unavailable'].includes(i.status)),'Unresolved write prevents reuse of this slot','conflict');
   writes.push({id:command.writeId,secret:structuredClone(grant.secret),sourceHash:grant.sourceHash,grantId:grant.id,at:time.observedAt,status:'pending'});break;
  }
  case 'settle-secret-write': {
   ensure(exact(command,['type','writeId','status'])&&['completed','unavailable'].includes(command.status),'Exact own write settlement required');const write=state.secretWrites?.find(w=>w.id===command.writeId);ensure(write?.status==='pending','Own write already settled','conflict');write.status=command.status;break;
  }
  case 'claim-secret-import': {
   ensure(exact(command,['type','importId','grantId'])&&id(command.importId)&&id(command.grantId),'Exact import claim required');const grant=state.secretGrants?.find(g=>g.id===command.grantId);ensure(grant,'Secret grant required','denied');
   const imports=state.secretImports??=[];ensure(imports.length<128&&!imports.some(i=>i.id===command.importId||hash(i.secret)===hash(grant.secret)&&['pending','unavailable'].includes(i.status)),'Import already claimed; never resend','conflict');
   ensure(!(state.secretWrites??[]).some(w=>hash(w.secret)===hash(grant.secret)&&w.status!=='completed'),'Unresolved own write prevents import','conflict');
   ensure(command.importId===secretImportId(grant.secret,grant.sourceHash),'Import identity mismatch');imports.push({id:command.importId,secret:structuredClone(grant.secret),sourceHash:grant.sourceHash,grantId:grant.id,at:time.observedAt,status:'pending'});break;
  }
  case 'settle-secret-import': {
   ensure(exact(command,['type','importId','status'])&&['completed','unavailable'].includes(command.status),'Exact import settlement required');const imported=state.secretImports?.find(i=>i.id===command.importId);ensure(imported?.status==='pending','Import already settled','conflict');imported.status=command.status;break;
  }
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
/** Rule commands were removed because nothing read the rules; a journal written before that still restores, so the two old types replay as inert history. */
type RuleCommand={type:'allow-rule';ruleId:string;what:string;kind:string}|{type:'remove-rule';ruleId:string};
type ReplayCommand=PermissionsCommand|RuleCommand;
const isRuleCommand=(command:ReplayCommand):command is RuleCommand=>command.type==='allow-rule'||command.type==='remove-rule';
const commandActor=(command:ReplayCommand)=>['claim-secret-import','settle-secret-import','claim-secret-write','settle-secret-write'].includes(command?.type)?'secret-host':'local-owner';
const fingerprint=(actorId:string,command:ReplayCommand)=>hash({actorId,command});
export const secretImportId=(secret:SecretSlot,sourceHash:string)=>'import-'+hash({secret,sourceHash}).slice(0,32);
const importCommandId=(command:ReplayCommand)=>'assistant-secret-'+hash(command).slice(0,32);
/** Values written before the rule removal carry a `rules` key the initializer no longer writes; compare without it on both sides so a main-written journal replays. Only the removed rule commands ever wrote that key, so this cannot hide a difference in the secret grants. */
const comparable=(value:PermissionsState)=>{const clone=structuredClone(value) as PermissionsState&{rules?:unknown};delete clone.rules;return clone;};
/** Backup lineage: every operation is an owner or host command with a caller ID; a grant's ID follows from it. */
export function replayPermissions(operation:Operation<PermissionsState>,prior:Operation<PermissionsState>|undefined):void {
 ensure(operation.aggregateId===PERMISSIONS_ID&&operation.value.id===PERMISSIONS_ID,'permissions aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:ReplayCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'permissions operation requires one typed event');
 ensure(event.actor===commandActor(event.command),'permissions actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(event.actor==='secret-host'?operation.commandId===importCommandId(event.command):!operation.commandId.startsWith('assistant-')&&(event.command.type!=='allow-rule'||event.command.ruleId===ruleId(operation.commandId))&&(event.command.type!=='grant-secret'||event.command.id===ruleId(operation.commandId)),'permissions command identity mismatch');
 ensure(operation.outbox.length===0,'permissions command/outbox transition');
 if(isRuleCommand(event.command))return;
 const next=applyPermissions(prior?prior.value:null,event.command,{id:event.actor,roles:[event.actor==='secret-host'?'representative':'owner']},event.time);
 ensure(hash(comparable(next.value))===hash(comparable(operation.value))&&hash(next.events)===hash(operation.events),'permissions command/state transition');
}

const OWNER='local-owner',owner:Actor={id:OWNER,roles:['owner']};
export class PermissionsService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(PERMISSIONS_ID) as Snapshot<PermissionsState>|null;}
 async read(){const s=await this.#state();return {revision:s?.revision??0,...(s?.value.secretGrants?{secrets:structuredClone(s.value.secretGrants)}:{})};}
 /** The owner's grant and revoke. A grant's ID derives from the command ID, so a resend commits once. */
 async act(input:unknown):Promise<CommitResult<PermissionsState>>{
  input=structuredClone(input);
  const grant=(input as {action?:unknown})?.action==='grant-secret';ensure(exact(input,grant?['commandId','action','secret','sourceHash','consumer','purpose']:['commandId','action','grantId'])&&id(input.commandId)&&!input.commandId.startsWith('assistant-'),'Exact secret permission fields required');
  return this.#dispatch(input.commandId,grant?{type:'grant-secret',id:ruleId(input.commandId),secret:input.secret as SecretSlot,sourceHash:input.sourceHash as string,consumer:input.consumer as SecretConsumer,purpose:input.purpose as string}:{type:'revoke-secret',grantId:input.grantId as string});
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
 async claimWrite(writeId:string,grant:{feedId:string;grantId:string}){
  const command:PermissionsCommand={type:'claim-secret-write',writeId,grantId:grant.grantId};
  return withAdmissionFeed(grant.feedId,()=>this.#dispatch(importCommandId(command),command));
 }
 async settleWrite(writeId:string,feedId:string,status:'completed'|'unavailable'){
  const command:PermissionsCommand={type:'settle-secret-write',writeId,status};
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
