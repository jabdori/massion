/** The owner's adoption setting and the one adoption decision for self-made changes (docs/architecture/self-made-skills.md, E1). Only the owner sets the mode; audit and revert are always on. */
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_ACTOR_ID,ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const ADOPTION_ID=ASSISTANT_CONVERSATION_PREFIX+'adoption';
/** Kinds of self-made change. Only 'skill' (skills and procedures) is wired; the others are names for later slices. */
export type AdoptionTargetKind='skill'|'memory'|'app'|'organization';
export type AdoptionMode='review'|'auto-threshold'|'auto-adopt';
/** The one place the default mode is defined, so changing the default later is a one-line change (the owner has not yet confirmed that the present automatic skill adoption goes off by default). */
export const DEFAULT_ADOPTION_MODE:AdoptionMode='review';
/** One setting revision: who, when, which target (or the organization default), which mode, and for auto-adopt the required expiry. */
export interface AdoptionRevision {id:string;at:number;actor:string;target:'default'|AdoptionTargetKind;mode:AdoptionMode;expiresAt?:number}
export interface AdoptionState {kind:'adoption';id:string;revisions:AdoptionRevision[];resumes:{target:AdoptionTargetKind;at:number}[];expiries:{revisionId:string;at:number}[]}
export type AdoptionCommand =
 | {type:'set-adoption-mode';revisionId:string;target:'default'|AdoptionTargetKind;mode:AdoptionMode;expiresAt?:number}
 | {type:'resume-adoption';target:AdoptionTargetKind}
 | {type:'record-adoption-expiry';revisionId:string};
export const isAdoptionState=(value:unknown):value is AdoptionState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='adoption';

/** What the check says about a candidate. The caller derives it in today's order: a check that cannot support adoption is named as such before its scores are read. */
export type AdoptionCheckResult={kind:'scan-failed'}|{kind:'worse'}|{kind:'supported'}|{kind:'same-family'}|{kind:'none'};
export interface AdoptionCandidateNature {replacesOwnerWritten:boolean;widensPermissionsOrScope:boolean}
export type AdoptionOutcome='adopt'|'ask'|'reject'|'unchecked';
/** The one adoption decision, the shape of gateDecision in environment.ts: a scan failure or a worse candidate rejects in every mode; a candidate that replaces something the owner wrote or widens permissions or tool scope asks in every mode; a paused target behaves as review; a same-family-only judgement never adopts in any mode. */
export function adoptionDecision(input:{target:AdoptionTargetKind;candidate:AdoptionCandidateNature;check:AdoptionCheckResult;mode:AdoptionMode;paused:boolean}):AdoptionOutcome {
 const mode=input.paused?'review':input.mode;
 if(input.check.kind==='scan-failed'||input.check.kind==='worse')return 'reject';
 // Today's outcome stands: a check that cannot support adoption leaves the candidate unchecked, even when it would replace something the owner wrote (no card opens).
 if(input.check.kind==='same-family')return 'unchecked';
 if(input.candidate.replacesOwnerWritten||input.candidate.widensPermissionsOrScope)return 'ask';
 if(input.check.kind==='supported')return mode==='review'?'ask':'adopt';
 return input.check.kind==='none'&&mode==='auto-adopt'?'adopt':'unchecked';
}

export interface EffectiveAdoption {mode:AdoptionMode;revision:string|null;resumedAt:number|null;expiredRevision?:string}
/** The latest revision for the target, else the organization default, else the default constant. An expired auto-adopt revision means review. */
export function effectiveAdoption(state:AdoptionState|null,target:AdoptionTargetKind,at:number):EffectiveAdoption {
 const revisions=state?.revisions??[],resumedAt=state?.resumes.findLast(r=>r.target===target)?.at??null,chosen=revisions.findLast(r=>r.target===target)??revisions.findLast(r=>r.target==='default')??null;
 if(!chosen)return {mode:DEFAULT_ADOPTION_MODE,revision:null,resumedAt};
 const expired=chosen.mode==='auto-adopt'&&chosen.expiresAt!==undefined&&at>=chosen.expiresAt;
 return {mode:expired?'review':chosen.mode,revision:chosen.id,resumedAt,...(expired?{expiredRevision:chosen.id}:{})};
}
/** Calibration: the most recent automatic adoptions for the target (at most 10, after the last resume); an adoption failed if it was reverted. */
export function calibrationPaused(adoptions:readonly {at:number;failed:boolean}[],resumedAt:number|null):boolean {
 const counted=adoptions.filter(a=>resumedAt===null||a.at>resumedAt).slice(-10),failed=counted.filter(a=>a.failed).length;
 return failed>=2||failed>=1&&counted.length<5;
}

function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
export const adoptionRevisionId=(commandId:string)=>'rev-'+hash(commandId).slice(0,16);
const expireCommandId=(revisionId:string)=>'assistant-adoption-expire:'+revisionId;
const commandActor=(command:AdoptionCommand)=>command?.type==='record-adoption-expiry'?ASSISTANT_ACTOR_ID:'local-owner';

export function applyAdoption(current:AdoptionState|null,command:AdoptionCommand,actor:Actor,time:TimeObservation):{value:AdoptionState;events:unknown[]} {
 const host=commandActor(command)===ASSISTANT_ACTOR_ID;
 ensure(actor&&id(actor.id)&&(host?actor.id===ASSISTANT_ACTOR_ID&&actor.roles.includes('assistant'):actor.roles.includes('owner')),'Actor lacks required role','denied');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');
 const state:AdoptionState=current?structuredClone(current):{kind:'adoption',id:ADOPTION_ID,revisions:[],resumes:[],expiries:[]};
 switch(command?.type){
  case 'set-adoption-mode': {
   ensure(exact(command,['type','revisionId','target','mode',...(Object.hasOwn(command,'expiresAt')?['expiresAt']:[])])&&id(command.revisionId)&&['default','skill','memory','app','organization'].includes(command.target)&&['review','auto-threshold','auto-adopt'].includes(command.mode),'Exact adoption mode fields required');
   // Auto-adopt always expires; there is no "never". Review and auto-threshold take no expiry: the check and calibration guard them.
   if(command.mode==='auto-adopt')ensure(command.expiresAt!==undefined&&Number.isSafeInteger(command.expiresAt)&&command.expiresAt>time.observedAt,'Auto-adopt requires an expiry time');
   else ensure(!Object.hasOwn(command,'expiresAt'),'Only auto-adopt expires');
   ensure(!state.revisions.some(r=>r.id===command.revisionId),'Revision already exists','conflict');
   state.revisions.push({id:command.revisionId,at:time.observedAt,actor:actor.id,target:command.target,mode:command.mode,...(command.mode==='auto-adopt'?{expiresAt:command.expiresAt as number}:{})});break;
  }
  case 'resume-adoption': {
   ensure(exact(command,['type','target'])&&['skill','memory','app','organization'].includes(command.target),'Exact adoption resume fields required');
   state.resumes.push({target:command.target,at:time.observedAt});break;
  }
  case 'record-adoption-expiry': {
   ensure(exact(command,['type','revisionId'])&&id(command.revisionId),'Exact adoption expiry fields required');
   const r=state.revisions.find(x=>x.id===command.revisionId);ensure(r?.mode==='auto-adopt'&&r.expiresAt!==undefined&&r.expiresAt<=time.observedAt,'Only a past auto-adopt expiry is recorded','conflict');
   ensure(!state.expiries.some(x=>x.revisionId===command.revisionId),'Expiry already recorded','conflict');
   state.expiries.push({revisionId:command.revisionId,at:time.observedAt});break;
  }
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const fingerprint=(actorId:string,command:AdoptionCommand)=>hash({actorId,command});
/** Backup lineage: owner commands carry a caller command ID and a revision ID derived from it; the host records an expiry under a derived identity. */
export function replayAdoption(operation:Operation<AdoptionState>,prior:Operation<AdoptionState>|undefined):void {
 ensure(operation.aggregateId===ADOPTION_ID&&operation.value.id===ADOPTION_ID,'adoption aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:AdoptionCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'adoption operation requires one typed event');
 const host=commandActor(event.command)===ASSISTANT_ACTOR_ID;ensure(event.actor===commandActor(event.command),'adoption actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(host?operation.commandId===expireCommandId((event.command as {revisionId:string}).revisionId):!operation.commandId.startsWith('assistant-')&&(event.command.type!=='set-adoption-mode'||event.command.revisionId===adoptionRevisionId(operation.commandId)),'adoption command identity mismatch');
 const next=applyAdoption(prior?prior.value:null,event.command,{id:event.actor,roles:[host?'assistant':'owner']},event.time);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'adoption command/state transition');
}

const OWNER='local-owner',owner:Actor={id:OWNER,roles:['owner']};
export class AdoptionService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(ADOPTION_ID) as Snapshot<AdoptionState>|null;}
 /** The revisions, resumes and recorded expiries. An installation without the aggregate runs on the default mode. */
 async read(){const s=await this.#state(),v=s?.value;return {revision:s?.revision??0,revisions:(v?.revisions??[]).map(r=>({...r})),resumes:(v?.resumes??[]).map(r=>({...r})),expiries:(v?.expiries??[]).map(r=>({...r}))};}
 /** The owner's Set mode and Resume. Caller command IDs only; no member, app, schedule or host actor reaches this path. */
 async act(raw:unknown):Promise<CommitResult<AdoptionState>>{
  const input=structuredClone(raw),set=(input as {action?:unknown})?.action==='set-mode',withExpiry=set&&Object.hasOwn(input as object,'expiresAt');
  ensure(exact(input,['commandId','action',...(set?['target','mode']:['target']),...(withExpiry?['expiresAt']:[])])&&id(input.commandId),'Exact adoption fields required');
  const commandId=input.commandId as string;ensure(!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');
  if(!set)return this.#dispatch(commandId,{type:'resume-adoption',target:input.target as AdoptionTargetKind});
  return this.#dispatch(commandId,{type:'set-adoption-mode',revisionId:adoptionRevisionId(commandId),target:input.target as 'default'|AdoptionTargetKind,mode:input.mode as AdoptionMode,...(withExpiry?{expiresAt:input.expiresAt as number}:{})});
 }
 /** The effective mode for a target; a passed auto-adopt expiry is recorded once, as a host step with a derived identity. */
 async effective(target:AdoptionTargetKind):Promise<EffectiveAdoption> {
  const snapshot=await this.#state(),effective=effectiveAdoption(snapshot?.value??null,target,this.#clock());
  if(effective.expiredRevision!==undefined&&!(snapshot?.value?.expiries??[]).some(x=>x.revisionId===effective.expiredRevision))await this.#dispatch(expireCommandId(effective.expiredRevision),{type:'record-adoption-expiry',revisionId:effective.expiredRevision});
  return effective;
 }
 /** Lookup after the load and after an idempotency conflict, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,command:AdoptionCommand):Promise<CommitResult<AdoptionState>>{
  const actorId=commandActor(command),identity={id:ADOPTION_ID,commandId,fingerprint:fingerprint(actorId,command)};
  for(let attempt=0;attempt<3;attempt++){
   // Load, then look up: a resend overlapping its first request sees that commit instead of failing the reducer on it.
   const snapshot=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const {value,events}=applyAdoption(snapshot?.value??null,command,actorId===ASSISTANT_ACTOR_ID?{id:actorId,roles:['assistant']}:owner,{observedAt:this.#clock()});
   const result=await this.#store.commit({id:ADOPTION_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   // Same command, other clock reading: the digest differs, so replay the stored result by its fingerprint.
   if(result.status==='conflict'&&result.reason==='idempotency'){const stored=await this.#store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
