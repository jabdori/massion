import {DomainError,hash} from './domain.ts';
import type {Actor,RuntimeOwnership} from './domain.ts';
import type {TimeObservation} from './memory-expiry.ts';
import {validateRuntimeOwnership} from './runtime-lifetime.ts';
import type {CommitResult,Store} from './storage.ts';
/** Bounded segments of the one owner conversation, stored as their own aggregates beside Missions. Provenance only, never a grant. */
export const ASSISTANT_CONVERSATION_PREFIX='assistant-conversation:',ASSISTANT_ACTOR_ID='assistant-representative';
export const SEGMENT_MESSAGES=16,SEGMENT_BYTES=65536,MESSAGE_BYTES=4096,TITLE_BYTES=512,RECEIPT_BYTES=1024,DIAGNOSTIC_BYTES=256,CONTEXT_MESSAGES=12,PENDING_GRACE_MS=30000;
/** Worst-case serialized growth of one exchange: owner message, turn, reply, settle and outcome fields. Texts exclude C0 controls other than tab and line breaks, so JSON escaping at most doubles their bytes. */
export const EXCHANGE_RESERVE_BYTES=28672;
export interface AssistantMessage {id:string;ordinal:number;actorId:string;role:'owner'|'representative';turnId:string|null;text:string}
export interface AssistantDiagnostic {code:string;message:string}
export interface AssistantRoute {profileId:string;configHash:string;provider:string;model:string;mode:'mock-http'|'live';outputTokenCap:number}
export interface AssistantUsage {inputTokens:number|null;outputTokens:number|null}
export interface AssistantOutcome {work:{status:'admitted'|'not_created'|'unknown';diagnostics:AssistantDiagnostic[]};run:{status:'requested'|'not_started'|'off';diagnostics:AssistantDiagnostic[]}}
export interface AssistantTurn {id:string;messageId:string;status:'not_started'|'pending'|'answered'|'failed'|'unknown';diagnostics?:AssistantDiagnostic[];route?:AssistantRoute;ownership?:RuntimeOwnership;requestHash?:string;contextMessageIds?:string[];usage?:AssistantUsage;receipt?:string;proposal?:{title:string};outcome?:AssistantOutcome}
export interface AssistantSegment {kind:'assistant-conversation';id:string;segment:number;previous:{id:string;lastMessageId:string}|null;closed:boolean;timeWatermark:number;messages:AssistantMessage[];turns:AssistantTurn[]}
export type AssistantTurnInput = {status:'pending';id:string;route:AssistantRoute;ownership:RuntimeOwnership;requestHash:string;contextMessageIds:string[]} | {status:'not_started';id:string;diagnostics:AssistantDiagnostic[]};
export type AssistantCommand =
 | {type:'append-assistant-message';messageId:string;text:string;turn:AssistantTurnInput}
 | {type:'open-assistant-segment';segment:number;previous:{id:string;lastMessageId:string}|null;messageId:string;text:string;turn:AssistantTurnInput}
 | {type:'close-assistant-segment';segment:number}
 | {type:'settle-assistant-turn';turnId:string;status:'answered';usage:AssistantUsage;receipt:string;reply:string;proposal:{title:string}|null}
 | {type:'settle-assistant-turn';turnId:string;status:'failed'|'unknown';usage:AssistantUsage;receipt:string}
 | {type:'record-assistant-outcome';turnId:string;work:AssistantOutcome['work'];run:AssistantOutcome['run']};
/** The owner's exact words pinned into a Work. The title stays the Representative's summary. */
export interface AssistantSource {segmentId:string;turnId:string;messageId:string;messageHash:string;message:AssistantMessage;representative:{provider:string;model:string}}
export const segmentId=(n:number)=>ASSISTANT_CONVERSATION_PREFIX+n,ownerMessageId=(commandId:string)=>'m:'+hash(commandId).slice(0,32),assistantTurnId=(messageId:string)=>'assistant-turn:'+messageId;
export const assistantWorkId=(turnId:string)=>'assistant-'+hash(turnId).slice(0,24),assistantRunId=(turnId:string)=>'assistant-run:'+turnId;
export const isAssistantSegment=(value:unknown):value is AssistantSegment=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='assistant-conversation';
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v),sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),count=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min;
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
function text(v:unknown,limit:number,name:string,oneLine=false):asserts v is string {ensure(typeof v==='string'&&v.trim().length>0&&v.isWellFormed()&&Buffer.byteLength(v,'utf8')<=limit&&!(oneLine?/[\u0000-\u001f]/:/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/).test(v),`Invalid ${name}: nonempty well-formed text within ${limit} bytes${oneLine?' on one line':''}`);}
const role=(actor:Actor,needed:'owner'|'assistant')=>ensure(actor.roles.includes(needed),'Actor lacks required role','denied');
function diagnostics(v:unknown,min:number):AssistantDiagnostic[] {ensure(Array.isArray(v)&&v.length>=min&&v.length<=2&&Object.keys(v).length===v.length,'Invalid diagnostics bound');for(const d of v){ensure(exact(d,['code','message'])&&typeof d.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(d.code),'Invalid diagnostic');text(d.message,DIAGNOSTIC_BYTES,'diagnostic message');}return structuredClone(v);}
export function hasRoom(segment:Pick<AssistantSegment,'messages'>):boolean {return segment.messages.length+2<=SEGMENT_MESSAGES&&bytes(segment)+EXCHANGE_RESERVE_BYTES<=SEGMENT_BYTES;}
/** Recorded host time only; a fast clock can make a turn unknown early, never accept a late reply. */
function observe(segment:AssistantSegment,time:TimeObservation|undefined):number {ensure(exact(time,['observedAt'])&&count(time!.observedAt)&&time!.observedAt>=segment.timeWatermark,'Host clock observation unavailable or below the segment watermark');return segment.timeWatermark=time!.observedAt;}
function expire(segment:AssistantSegment,observedAt:number):void {for(const t of segment.turns)if(t.status==='pending'&&observedAt>=t.ownership!.deadlineAt+PENDING_GRACE_MS)t.status='unknown';}
function turnInput(v:unknown,messageId:string,observedAt:number):AssistantTurn {
 const t=v as AssistantTurnInput;ensure(t&&typeof t==='object'&&t.id===assistantTurnId(messageId),'Turn identity must derive from its owner message');
 if(t.status==='not_started'){ensure(exact(t,['status','id','diagnostics']),'Exact not-started turn fields required');return {id:t.id,messageId,status:t.status,diagnostics:diagnostics(t.diagnostics,1)};}
 ensure(t.status==='pending'&&exact(t,['status','id','route','ownership','requestHash','contextMessageIds']),'Exact pending turn fields required');const r=t.route;
 ensure(exact(r,['profileId','configHash','provider','model','mode','outputTokenCap'])&&id(r.profileId)&&sha(r.configHash)&&['mock-http','live'].includes(r.mode)&&count(r.outputTokenCap,1),'Invalid Representative route pin');text(r.provider,128,'route provider',true);text(r.model,128,'route model',true);
 validateRuntimeOwnership(t.ownership);ensure(t.ownership.startedAt<=observedAt&&observedAt<t.ownership.deadlineAt,'Pending turn ownership must contain the recorded time');ensure(sha(t.requestHash),'Invalid request hash');
 ensure(Array.isArray(t.contextMessageIds)&&t.contextMessageIds.length<=CONTEXT_MESSAGES&&Object.keys(t.contextMessageIds).length===t.contextMessageIds.length&&t.contextMessageIds.every(id)&&new Set(t.contextMessageIds).size===t.contextMessageIds.length,'Invalid context message pins');
 return {id:t.id,messageId,status:'pending',route:structuredClone(r),ownership:structuredClone(t.ownership),requestHash:t.requestHash,contextMessageIds:structuredClone(t.contextMessageIds)};
}
function append(segment:AssistantSegment,command:{messageId:string;text:string;turn:unknown},actor:Actor,observedAt:number):void {
 ensure(typeof command.messageId==='string'&&/^m:[a-f0-9]{32}$/.test(command.messageId),'Invalid owner message identity');text(command.text,MESSAGE_BYTES,'owner message');const turn=turnInput(command.turn,command.messageId,observedAt);
 ensure(!segment.closed,'segment_closed: the segment is closed','conflict');expire(segment,observedAt);ensure(!segment.turns.some(t=>t.status==='pending'),'answer_in_progress: an earlier turn is still pending','conflict');
 ensure(hasRoom(segment),'segment_full: open the next segment','conflict');ensure(!segment.messages.some(m=>m.id===command.messageId),'Owner message already exists');
 segment.messages.push({id:command.messageId,ordinal:segment.messages.length+1,actorId:actor.id,role:'owner',turnId:null,text:command.text});segment.turns.push(turn);
}
/** Reducer for one segment. `current` is null only for the open that creates it. */
export function applyAssistant(current:AssistantSegment|null,command:AssistantCommand,actor:Actor,time:TimeObservation|undefined):{value:AssistantSegment;events:unknown[]} {
 ensure(actor&&id(actor.id),'Invalid actor');ensure((current===null)===(command?.type==='open-assistant-segment'),'Only an open creates a segment');
 const state:AssistantSegment=current?structuredClone(current):{kind:'assistant-conversation',id:'',segment:0,previous:null,closed:false,timeWatermark:0,messages:[],turns:[]};
 switch(command.type){
  case 'open-assistant-segment': {
   role(actor,'owner');ensure(exact(command,['type','segment','previous','messageId','text','turn'])&&count(command.segment,1),'Exact segment open fields required');
   ensure(command.segment===1?command.previous===null:exact(command.previous,['id','lastMessageId'])&&command.previous!.id===segmentId(command.segment-1)&&id(command.previous!.lastMessageId),'Open must name the previous segment and its last message');
   Object.assign(state,{id:segmentId(command.segment),segment:command.segment,previous:structuredClone(command.previous)});append(state,command,actor,observe(state,time));break;
  }
  case 'append-assistant-message': role(actor,'owner');ensure(exact(command,['type','messageId','text','turn']),'Exact owner message fields required');append(state,command,actor,observe(state,time));break;
  case 'close-assistant-segment': {
   role(actor,'owner');ensure(exact(command,['type','segment'])&&command.segment===state.segment,'Close must name this segment');const t=observe(state,time);ensure(!state.closed,'Segment is already closed');
   expire(state,t);ensure(!state.turns.some(x=>x.status==='pending'),'answer_in_progress: a turn is still pending','conflict');ensure(!hasRoom(state),'Only a full segment closes');state.closed=true;break;
  }
  case 'settle-assistant-turn': {
   role(actor,'assistant');const answered=command.status==='answered';ensure(['answered','failed','unknown'].includes(command.status)&&exact(command,['type','turnId','status','usage','receipt',...(answered?['reply','proposal']:[])]),'Exact settle fields required');
   ensure(exact(command.usage,['inputTokens','outputTokens'])&&[command.usage.inputTokens,command.usage.outputTokens].every(n=>n===null||count(n)),'Invalid usage');text(command.receipt,RECEIPT_BYTES,'receipt',true);
   if(command.status==='answered'){text(command.reply,MESSAGE_BYTES,'reply');ensure(command.proposal===null||exact(command.proposal,['title']),'Invalid proposal');if(command.proposal)text(command.proposal.title,TITLE_BYTES,'proposal title',true);}
   const t=observe(state,time);ensure(!state.closed,'Segment is closed; no reply lands after close');const turn=state.turns.find(x=>x.id===command.turnId);ensure(turn&&turn.status==='pending','Only a pending turn settles, once');
   if(command.status!=='unknown')ensure(t<turn.ownership!.deadlineAt,'A reply after the deadline is not accepted; settle unknown');
   turn.status=command.status;turn.usage=structuredClone(command.usage);turn.receipt=command.receipt;
   if(command.status==='answered'){ensure(command.usage.outputTokens!==null&&command.usage.outputTokens<=turn.route!.outputTokenCap,'Answered usage must be known and within the cap');if(command.proposal)turn.proposal={title:command.proposal.title};state.messages.push({id:'r:'+turn.id,ordinal:state.messages.length+1,actorId:actor.id,role:'representative',turnId:turn.id,text:command.reply});}
   expire(state,t);break;
  }
  case 'record-assistant-outcome': {
   role(actor,'assistant');ensure(exact(command,['type','turnId','work','run'])&&exact(command.work,['status','diagnostics'])&&exact(command.run,['status','diagnostics'])&&['admitted','not_created','unknown'].includes(command.work.status)&&['requested','not_started','off'].includes(command.run.status),'Exact outcome fields required');
   ensure(command.work.status==='admitted'||command.run.status!=='requested','A run is requested only for an admitted Work');const outcome={work:{status:command.work.status,diagnostics:diagnostics(command.work.diagnostics,0)},run:{status:command.run.status,diagnostics:diagnostics(command.run.diagnostics,0)}};
   const t=observe(state,time),turn=state.turns.find(x=>x.id===command.turnId);ensure(turn&&turn.status==='answered'&&turn.proposal&&!turn.outcome,'Outcome is recorded once for an answered turn with a proposal');turn.outcome=outcome;if(!state.closed)expire(state,t);break;
  }
  default: throw new DomainError('Unknown command');
 }
 ensure(state.messages.length<=SEGMENT_MESSAGES&&bytes(state)<=SEGMENT_BYTES,'Segment bound exceeded');
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
/** Host steps use deterministic command IDs; an owner message ID derives from the caller's command ID. */
export function requireAssistantCommandIdentity(commandId:string,command:AssistantCommand):void {
 ensure(typeof commandId==='string'&&commandId.length>0,'Missing command identity');
 if(command.type==='append-assistant-message'||command.type==='open-assistant-segment'){ensure(!commandId.startsWith('assistant-'),'Command IDs starting with assistant- are reserved for host steps');ensure(command.messageId===ownerMessageId(commandId),'Owner message ID must derive from the command ID');return;}
 const expected=command.type==='close-assistant-segment'?'assistant-close:'+command.segment:command.type==='settle-assistant-turn'?'assistant-settle:'+command.turnId:command.type==='record-assistant-outcome'?'assistant-outcome:'+command.turnId:null;
 ensure(expected!==null&&commandId===expected,`Command ID must be ${expected}`);
}
export function validateAssistantSource(v:unknown,workId:string):asserts v is AssistantSource {
 const s=v as AssistantSource;ensure(exact(s,['segmentId','turnId','messageId','messageHash','message','representative'])&&typeof s.segmentId==='string'&&/^assistant-conversation:[1-9][0-9]{0,15}$/.test(s.segmentId),'Exact assistant source fields required');
 ensure(typeof s.messageId==='string'&&/^m:[a-f0-9]{32}$/.test(s.messageId)&&s.turnId===assistantTurnId(s.messageId),'Assistant source turn must derive from its owner message');
 const m=s.message;ensure(exact(m,['id','ordinal','actorId','role','turnId','text'])&&m.id===s.messageId&&m.role==='owner'&&m.turnId===null&&count(m.ordinal,1)&&id(m.actorId),'Assistant source must pin one complete owner message');text(m.text,MESSAGE_BYTES,'pinned owner message');
 ensure(s.messageHash===hash(m),'Assistant source message hash mismatch');ensure(exact(s.representative,['provider','model']),'Exact Representative pin required');text(s.representative.provider,128,'Representative provider',true);text(s.representative.model,128,'Representative model',true);
 ensure(workId===assistantWorkId(s.turnId),'Assistant Work ID must derive from its turn');
}
export interface AssistantEnvelope {segment:number;commandId:string;expectedRevision:number;actorId:string;command:AssistantCommand}
/** Same envelope as Mission commands: frozen input, lookup before and after the load, CAS on the named segment. */
export class AssistantConversation {
 readonly store:Store<AssistantSegment>;private readonly actors:Map<string,Actor>;private readonly clock:()=>number;
 constructor(store:Store<any>,actors:readonly Actor[],clock:()=>number=Date.now){this.store=store;this.actors=new Map(actors.map(a=>[a.id,structuredClone(a)]));this.clock=clock;}
 async dispatch(envelope:AssistantEnvelope):Promise<CommitResult<AssistantSegment>> {
  envelope=structuredClone(envelope);ensure(exact(envelope,['segment','commandId','expectedRevision','actorId','command']),'Exact assistant envelope fields required');
  const actor=this.actors.get(envelope.actorId);ensure(actor,'Unknown actor','denied');const {segment,commandId,expectedRevision,command}=envelope;
  ensure(count(segment,1)&&count(expectedRevision),'Invalid segment or expected revision');requireAssistantCommandIdentity(commandId,command);
  ensure((expectedRevision===0)===(command.type==='open-assistant-segment')&&(command.type!=='open-assistant-segment'||command.segment===segment),'Only an open of the named segment starts at revision 0');
  const aggregate=segmentId(segment),fingerprint=hash({actorId:actor.id,command,expectedRevision}),identity={id:aggregate,commandId,fingerprint};
  const prior=await this.store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
  const snapshot=await this.store.load(aggregate);
  if((snapshot?.revision??0)!==expectedRevision){const concurrent=await this.store.lookupOperation(identity);if(concurrent.status!=='unknown')return concurrent;return {status:'conflict',revision:snapshot?.revision??0,reason:'revision'};}
  if(command.type==='open-assistant-segment'&&segment>1){const before=(await this.store.load(segmentId(segment-1)))?.value;ensure(before?.closed,'Segment '+(segment-1)+' must be closed before the next opens','conflict');ensure(command.previous?.lastMessageId===before.messages.at(-1)!.id,'Open must name the previous segment last message');}
  const {value,events}=applyAssistant(snapshot?.value??null,command,actor,{observedAt:this.clock()});
  return this.store.commit({id:aggregate,expectedRevision,commandId,fingerprint,value,events,outbox:[]});
 }
}
/** Exponential then binary search over contiguous segments; 0 when none exists. */
export async function headSegment(store:Pick<Store<unknown>,'load'>):Promise<number> {
 if(!await store.load(segmentId(1)))return 0;let low=1,high=2;while(await store.load(segmentId(high))){low=high;high*=2;}
 while(high-low>1){const mid=Math.floor((low+high)/2);if(await store.load(segmentId(mid)))low=mid;else high=mid;}return low;
}
