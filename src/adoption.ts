/** The owner's adoption setting and the one adoption decision for self-made changes (docs/architecture/self-made-skills.md, E1). Only the owner sets the mode; audit and revert are always on; no mode expires. */
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const ADOPTION_ID=ASSISTANT_CONVERSATION_PREFIX+'adoption';
/** Kinds of self-made change. Only 'skill' (skills and procedures) is wired; the others are names for later slices. */
export type AdoptionTargetKind='skill'|'memory'|'app'|'organization';
export type AdoptionMode='review'|'auto-threshold'|'auto-adopt';
/** The default per target until the choosing screen exists: exactly today's behaviour on main — a checked skill or procedure adopts automatically, every other kind asks (ADR 0008 §3). The first value for a NEW installation is decided together with that screen. */
export const DEFAULT_ADOPTION_MODES:Record<AdoptionTargetKind,AdoptionMode>={skill:'auto-threshold',memory:'review',app:'review',organization:'review'};
/** One setting revision: who, when, which target (or the organization default) and which mode. No mode carries an expiry. */
export interface AdoptionRevision {id:string;at:number;actor:string;target:'default'|AdoptionTargetKind;mode:AdoptionMode}
export interface AdoptionState {kind:'adoption';id:string;revisions:AdoptionRevision[]}
export interface AdoptionCommand {type:'set-adoption-mode';revisionId:string;target:'default'|AdoptionTargetKind;mode:AdoptionMode}
export const isAdoptionState=(value:unknown):value is AdoptionState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='adoption';

/** What the check says about a candidate. The caller derives it in today's order: a check that cannot support adoption is named as such before its scores are read. */
export type AdoptionCheckResult={kind:'scan-failed'}|{kind:'worse'}|{kind:'supported'}|{kind:'same-family'}|{kind:'none'};
export interface AdoptionCandidateNature {replacesOwnerWritten:boolean;widensPermissionsOrScope:boolean}
export type AdoptionOutcome='adopt'|'ask'|'reject'|'unchecked';
/** The one adoption decision, the shape of gateDecision in environment.ts, in the specified order: a scan failure or a worse candidate rejects in every mode; a candidate that replaces something the owner wrote or widens permissions or tool scope asks in every mode; a paused target behaves as review; a same-family-only judgement never adopts in any mode. */
export function adoptionDecision(input:{target:AdoptionTargetKind;candidate:AdoptionCandidateNature;check:AdoptionCheckResult;mode:AdoptionMode;paused:boolean}):AdoptionOutcome {
 const mode=input.paused?'review':input.mode;
 if(input.check.kind==='scan-failed'||input.check.kind==='worse')return 'reject';
 if(input.candidate.replacesOwnerWritten||input.candidate.widensPermissionsOrScope)return 'ask';
 if(input.check.kind==='same-family')return 'unchecked';
 if(input.check.kind==='supported')return mode==='review'?'ask':'adopt';
 return input.check.kind==='none'&&mode==='auto-adopt'?'adopt':'unchecked';
}

export interface EffectiveAdoption {mode:AdoptionMode;revision:string|null}
/** The latest revision for the target, else the organization default, else the per-target default. No clock is consulted: a mode stays in force until the owner changes it. */
export function effectiveAdoption(state:AdoptionState|null,target:AdoptionTargetKind):EffectiveAdoption {
 const revisions=state?.revisions??[],chosen=revisions.findLast(r=>r.target===target)??revisions.findLast(r=>r.target==='default')??null;
 return chosen?{mode:chosen.mode,revision:chosen.id}:{mode:DEFAULT_ADOPTION_MODES[target],revision:null};
}
/** Calibration: of the automatic adoptions after the last resume, at most the 10 most recent count; an adoption failed if it was reverted. Pause at 2 or more failures, or 1 failure while fewer than 5 are counted. */
export function calibrationPaused(failed:readonly boolean[]):boolean {
 const counted=failed.slice(-10),f=counted.filter(Boolean).length;
 return f>=2||f>=1&&counted.length<5;
}

function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
export const adoptionRevisionId=(commandId:string)=>'rev-'+hash(commandId).slice(0,16);
const OWNER_ID='local-owner',owner:Actor={id:OWNER_ID,roles:['owner']};

export function applyAdoption(current:AdoptionState|null,command:AdoptionCommand,actor:Actor,time:TimeObservation):{value:AdoptionState;events:unknown[]} {
 ensure(actor&&id(actor.id)&&actor.roles.includes('owner'),'Actor lacks required role','denied');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');
 // No released build has this aggregate; one that still carries the removed expiry fields is invalid, not silently carried on.
 if(current)ensure(exact(current,['kind','id','revisions'])&&Array.isArray(current.revisions)&&current.revisions.every(r=>exact(r,['id','at','actor','target','mode'])),'Unknown adoption state fields');
 const state:AdoptionState=current?structuredClone(current):{kind:'adoption',id:ADOPTION_ID,revisions:[]};
 switch(command?.type){
  case 'set-adoption-mode': {
   ensure(exact(command,['type','revisionId','target','mode'])&&id(command.revisionId)&&['default','skill','memory','app','organization'].includes(command.target)&&['review','auto-threshold','auto-adopt'].includes(command.mode),'Exact adoption mode fields required');
   ensure(!state.revisions.some(r=>r.id===command.revisionId),'Revision already exists','conflict');
   state.revisions.push({id:command.revisionId,at:time.observedAt,actor:actor.id,target:command.target,mode:command.mode});break;
  }
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const fingerprint=(actorId:string,command:AdoptionCommand)=>hash({actorId,command});
/** Backup lineage: an owner command carries a caller command ID, and its revision ID follows from it. */
export function replayAdoption(operation:Operation<AdoptionState>,prior:Operation<AdoptionState>|undefined):void {
 ensure(operation.aggregateId===ADOPTION_ID&&operation.value.id===ADOPTION_ID,'adoption aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:AdoptionCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'adoption operation requires one typed event');
 ensure(event.actor===OWNER_ID,'adoption actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(!operation.commandId.startsWith('assistant-')&&event.command.type==='set-adoption-mode'&&event.command.revisionId===adoptionRevisionId(operation.commandId),'adoption command identity mismatch');
 const next=applyAdoption(prior?prior.value:null,event.command,{id:event.actor,roles:['owner']},event.time);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'adoption command/state transition');
}

export class AdoptionService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(ADOPTION_ID) as Snapshot<AdoptionState>|null;}
 /** The revisions. An installation without the aggregate runs on the per-target default. */
 async read(){const s=await this.#state(),v=s?.value;return {revision:s?.revision??0,revisions:(v?.revisions??[]).map(r=>({...r}))};}
 /** The owner's Set mode. Caller command IDs only; no member, app, schedule or host actor reaches this path. */
 async act(raw:unknown):Promise<CommitResult<AdoptionState>>{
  const input=structuredClone(raw);
  ensure((input as {action?:unknown})?.action==='set-mode'&&exact(input,['commandId','action','target','mode'])&&id(input.commandId),'Exact adoption fields required');
  const commandId=input.commandId as string;ensure(!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');
  return this.#dispatch(commandId,{type:'set-adoption-mode',revisionId:adoptionRevisionId(commandId),target:input.target as 'default'|AdoptionTargetKind,mode:input.mode as AdoptionMode});
 }
 /** The inputs for a deciding write: the effective mode for the target and the setting aggregate's revision it was read from, as one consistent pair, so the writer can make its commit conditional on that revision. */
 async decision(target:AdoptionTargetKind):Promise<{mode:AdoptionMode;revision:string|null;aggregateRevision:number}> {
  const snapshot=await this.#state(),effective=effectiveAdoption(snapshot?.value??null,target);
  return {mode:effective.mode,revision:effective.revision,aggregateRevision:snapshot?.revision??0};
 }
 /** Lookup after the load and after an idempotency conflict, CAS on the revision read; a lost command replays by its ID. */
 async #dispatch(commandId:string,command:AdoptionCommand):Promise<CommitResult<AdoptionState>>{
  const identity={id:ADOPTION_ID,commandId,fingerprint:fingerprint(OWNER_ID,command)};
  for(let attempt=0;attempt<3;attempt++){
   // Load, then look up: a resend overlapping its first request sees that commit instead of failing the reducer on it.
   const snapshot=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const {value,events}=applyAdoption(snapshot?.value??null,command,owner,{observedAt:this.#clock()});
   const result=await this.#store.commit({id:ADOPTION_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   // Same command, other clock reading: the digest differs, so replay the stored result by its fingerprint.
   if(result.status==='conflict'&&result.reason==='idempotency'){const stored=await this.#store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
