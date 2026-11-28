import {DomainError,hash} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX,SEND_ORIGINS} from './assistant-conversation.ts';
import type {SendOrigin} from './assistant-conversation.ts';
import type {Operation} from './storage.ts';
export type {SendOrigin};

/** The owner actions that turn a built-in connection on for live model calls. */
export type ActivationWay='key-added'|'login-started'|'first-message'|'model-selected';
export interface ConnectionActivation {connectionId:string;at:number;way:ActivationWay;messageId?:string}
/** Stored representative route details reproduced deterministically by replay. */
export interface RouteSnapshot {model:string;profileId:string;configHash:string;outputTokenCap:number;intakeMissionId:string}
/** The single durable route fact: written once by first-route, or replaced/removed only by explicit owner choice. */
export interface RouteChoice extends RouteSnapshot {connectionId:string;at:number;source:'first-route'|'owner-choice'}
export interface ConnectionActivationState {kind:'connection-activation';id:string;activations:ConnectionActivation[];routeChoice:RouteChoice|null;routeClosedAt:number|null}
type Command=
 | {kind:'turn-on';commandId:string;connectionId:string;way:ActivationWay;at:number;messageId?:string;messageOrigin?:SendOrigin;detectedLogins?:readonly string[];detectedProviders?:readonly string[];route?:RouteSnapshot;automaticPick?:true}
 | {kind:'record-route';commandId:string;connectionId:string;model:string;profileId:string;configHash:string;outputTokenCap:number;intakeMissionId:string;at:number;source:'owner-choice'|'first-route';requireUnset?:true}
 | {kind:'close-route';commandId:string;at:number};
export const CONNECTION_ACTIVATION_ID=ASSISTANT_CONVERSATION_PREFIX+'connection-activation';
const ways=['key-added','login-started','first-message','model-selected'];
function ensure(value:unknown,message:string,code:'invalid'|'conflict'='invalid'):asserts value {if(!value)throw new DomainError(message,code);}
function exact(value:unknown,keys:string[],optional:string[]=[]):asserts value is Record<string,any> {ensure(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>[...keys,...optional].includes(k))&&keys.every(k=>Object.hasOwn(value,k)),'Invalid connection activation fields');}
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const modelName=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9._:/-]{1,256}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function validRouteFields(r:unknown):asserts r is RouteSnapshot {
 exact(r,['model','profileId','configHash','outputTokenCap','intakeMissionId']);
 ensure(modelName(r.model)&&identity(r.profileId)&&digest(r.configHash)&&Number.isSafeInteger(r.outputTokenCap)&&r.outputTokenCap>0&&identity(r.intakeMissionId)&&!r.intakeMissionId.startsWith(ASSISTANT_CONVERSATION_PREFIX),'Invalid stored route choice');
}

/**
 * One durable decision aggregate for connection activations and the Representative route.
 * The stored formats of this aggregate start with this PR (origin/main has no connection-activation aggregate); intermediate commits of the branch are not supported.
 */
export function activationState(value:unknown):ConnectionActivationState {
 if(value===undefined)return {kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:[],routeChoice:null,routeClosedAt:null};
 exact(value,['kind','id','activations','routeChoice','routeClosedAt']);ensure(value.kind==='connection-activation'&&value.id===CONNECTION_ACTIVATION_ID&&Array.isArray(value.activations)&&value.activations.length<=32,'Invalid stored connection activations');
 for(const a of value.activations){exact(a,['connectionId','at','way'],['messageId']);ensure(identity(a.connectionId)&&ways.includes(a.way)&&Number.isSafeInteger(a.at)&&a.at>=0&&(a.messageId===undefined||/^m:[a-f0-9]{32}$/.test(a.messageId)),'Invalid stored connection activation');}
 ensure(new Set(value.activations.map((a:ConnectionActivation)=>a.connectionId)).size===value.activations.length,'Invalid stored connection activations');
 if(value.routeChoice!==null){
  exact(value.routeChoice,['connectionId','model','profileId','configHash','outputTokenCap','intakeMissionId','at','source']);
  validRouteFields({model:value.routeChoice.model,profileId:value.routeChoice.profileId,configHash:value.routeChoice.configHash,outputTokenCap:value.routeChoice.outputTokenCap,intakeMissionId:value.routeChoice.intakeMissionId});
  ensure(identity(value.routeChoice.connectionId)&&(value.routeChoice.source==='first-route'||value.routeChoice.source==='owner-choice')&&Number.isSafeInteger(value.routeChoice.at)&&value.routeChoice.at>=0,'Invalid stored route choice');
 }
 ensure(value.routeClosedAt===null||Number.isSafeInteger(value.routeClosedAt)&&value.routeClosedAt>=0,'Invalid stored route removal');
 return {kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:structuredClone(value.activations),routeChoice:structuredClone(value.routeChoice),routeClosedAt:value.routeClosedAt};
}
export function isConnectionActivationState(value:unknown):value is ConnectionActivationState {try{if(value===undefined)return false;activationState(value);return true;}catch{return false;}}
/** Distinct per source command and connection, so replay stays idempotent inside the global command namespace. */
export const activationCommandId=(commandId:string,connectionId:string)=>'connection-on:'+hash([commandId,connectionId]).slice(0,32);
const actor='local-owner';
export const activationFingerprint=(command:Command)=>hash({actorId:actor,command});
export function applyActivation(current:ConnectionActivationState,command:Command){
 const value=activationState(current);
 if(command.kind==='record-route'){
  exact(command,['kind','commandId','connectionId','model','profileId','configHash','outputTokenCap','intakeMissionId','at','source'],['requireUnset']);
  validRouteFields({model:command.model,profileId:command.profileId,configHash:command.configHash,outputTokenCap:command.outputTokenCap,intakeMissionId:command.intakeMissionId});
  // A route command may call itself the first route only when it refuses to replace one.
  ensure(identity(command.commandId)&&identity(command.connectionId)&&(command.source==='owner-choice'||command.source==='first-route'&&command.requireUnset===true)&&Number.isSafeInteger(command.at)&&command.at>=0,'Invalid route choice');
  ensure(command.requireUnset===undefined||command.requireUnset===true,'Invalid route choice');
  if(command.requireUnset)ensure(value.routeChoice===null&&value.routeClosedAt===null,'Representative route already decided','conflict');
  value.routeChoice={connectionId:command.connectionId,model:command.model,profileId:command.profileId,configHash:command.configHash,outputTokenCap:command.outputTokenCap,intakeMissionId:command.intakeMissionId,at:command.at,source:command.source};
  value.routeClosedAt=null;
  return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
 }
 if(command.kind==='close-route'){
  exact(command,['kind','commandId','at']);ensure(identity(command.commandId)&&Number.isSafeInteger(command.at)&&command.at>=0,'Invalid route removal');
  ensure(value.routeChoice!==null&&value.routeClosedAt===null,'No Representative route is set','conflict');
  value.routeChoice=null;
  value.routeClosedAt=command.at;
  return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
 }
 exact(command,['kind','commandId','connectionId','way','at'],['messageId','messageOrigin','detectedLogins','detectedProviders','route','automaticPick']);
 ensure(identity(command.commandId)&&identity(command.connectionId)&&ways.includes(command.way)&&Number.isSafeInteger(command.at)&&command.at>=0&&(command.messageId===undefined||/^m:[a-f0-9]{32}$/.test(command.messageId))&&(command.automaticPick===undefined||command.automaticPick===true&&command.way==='model-selected')&&(command.messageOrigin===undefined||SEND_ORIGINS.includes(command.messageOrigin))&&(command.detectedLogins===undefined||Array.isArray(command.detectedLogins)&&command.detectedLogins.length<=32&&command.detectedLogins.every(identity))&&(command.detectedProviders===undefined||Array.isArray(command.detectedProviders)&&Array.isArray(command.detectedLogins)&&command.detectedProviders.length===command.detectedLogins.length&&command.detectedProviders.every(identity)),'Invalid connection activation');
 if(command.route!==undefined)validRouteFields(command.route);
 if(command.way==='first-message')ensure(command.messageId!==undefined&&command.messageOrigin!==undefined&&Array.isArray(command.detectedLogins),'Invalid connection activation');
 ensure(!value.activations.some(a=>a.connectionId===command.connectionId),'Connection already on','conflict');
 if(command.way==='model-selected'){
  ensure(command.messageOrigin!==undefined&&command.detectedLogins!==undefined,'Invalid connection activation');
  // The selection's permission is re-evaluated inside this transition against the aggregate at commit.
  const selection=modelSelectionDecision({origin:command.messageOrigin!,loginDetected:command.detectedLogins!.includes(command.connectionId),routePresent:value.routeChoice!==null,routeClosedByOwner:value.routeClosedAt!==null});
  ensure(selection.turnOn,'Model-selected activation not permitted','conflict');
  // The record keeps what the request declared: first-route only when the command says it is the screen's automatic pick; a command without the flag is recorded as the owner choice and does not say who sent it.
  if(selection.route)value.routeChoice={connectionId:command.connectionId,model:command.route!.model,profileId:command.route!.profileId,configHash:command.route!.configHash,outputTokenCap:command.route!.outputTokenCap,intakeMissionId:command.route!.intakeMissionId,at:command.at,source:command.automaticPick===true?'first-route':'owner-choice'};
  value.activations.push({connectionId:command.connectionId,at:command.at,way:command.way});
  return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
 }
 // The first route is decided inside this transition by recomputing firstRouteDecision against the aggregate at commit.
 const decision=firstRouteDecision({
  way:command.way,
  connectionId:command.connectionId,
  messageAccepted:command.messageId!==undefined,
  origin:command.messageOrigin??'unattributed',
  onConnections:value.activations.map(a=>a.connectionId),
  detectedLogins:command.detectedLogins??[],
  ...(command.detectedProviders!==undefined?{detectedProviders:command.detectedProviders}:{}),
  routePresent:value.routeChoice!==null,
  routeClosedByOwner:value.routeClosedAt!==null,
  loginWaitingForRoute:value.routeChoice===null&&value.activations.length===1&&value.activations[0]!.way==='login-started'?value.activations[0]!.connectionId:null
 });
 if(command.way==='first-message')ensure(decision.activate&&decision.connectionId===command.connectionId,'First-message activation not permitted','conflict');
 if(decision.activate&&decision.connectionId===command.connectionId){
  ensure(command.route!==undefined,'First route details required');
  value.routeChoice={connectionId:decision.connectionId,model:command.route.model,profileId:command.route.profileId,configHash:command.route.configHash,outputTokenCap:command.route.outputTokenCap,intakeMissionId:command.route.intakeMissionId,at:command.at,source:'first-route'};
 }
 value.activations.push({connectionId:command.connectionId,at:command.at,way:command.way,...(command.messageId!==undefined?{messageId:command.messageId}:{})});
 return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
}
export function replayConnectionActivation(operation:Operation<ConnectionActivationState>,prior:Operation<ConnectionActivationState>|undefined):void {
 activationState(operation.value);ensure(operation.aggregateId===CONNECTION_ACTIVATION_ID&&(!prior||prior.aggregateId===CONNECTION_ACTIVATION_ID)&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Connection activation revision lineage mismatch');
 ensure(operation.events.length===1,'One connection activation event required');const e=operation.events[0];exact(e,['type','actor','command']);
 ensure(e.type==='connection-activation'&&e.actor===actor&&operation.commandId===e.command.commandId,'Connection activation event identity mismatch');
 ensure(operation.fingerprint===activationFingerprint(e.command),'Connection activation fingerprint mismatch');const derived=applyActivation(activationState(prior?.value),e.command);
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Connection activation transition mismatch');
}

/** Fixed order for the first-message pick when more than one subscription login is detected (2026-11-17: of five compared apps four pick without asking, a subscription has no per-call charge, and the two-login wait came from PR #177's design text, not an owner request). */
export const FIRST_MESSAGE_LOGIN_ORDER:readonly string[]=['claude-code-cli','codex-cli'];
/** One pure decision for the owner's first route; the service only gathers inputs and applies the result. */
export interface FirstRouteFacts {
 way?:ActivationWay;
 connectionId?:string;
 messageAccepted:boolean;origin:SendOrigin;
 onConnections:readonly string[];detectedLogins:readonly string[];detectedProviders?:readonly string[];
 routePresent:boolean;routeClosedByOwner:boolean;loginWaitingForRoute:string|null;
}
export type FirstRouteDecision={activate:false}|{activate:true;connectionId:string};
export function firstRouteDecision(facts:FirstRouteFacts):FirstRouteDecision {
 const way=facts.way??'first-message';
 if(facts.routePresent||facts.routeClosedByOwner)return {activate:false};
 if(way==='key-added')return {activate:false};
 if(way==='login-started')return facts.onConnections.length===0&&facts.connectionId!==undefined?{activate:true,connectionId:facts.connectionId}:{activate:false};
 if(!facts.messageAccepted||facts.origin!=='owner-typed')return {activate:false};
 if(facts.onConnections.length===0){
  // The order and the exclusion live in this decision, never in its caller: rank by FIRST_MESSAGE_LOGIN_ORDER and drop a provider type that is not in it, so an unknown provider is never turned on unasked.
  if(facts.detectedProviders){
   const pick=facts.detectedLogins.map((connectionId,index)=>({connectionId,providerType:facts.detectedProviders![index]!})).filter(login=>FIRST_MESSAGE_LOGIN_ORDER.includes(login.providerType)).toSorted((left,right)=>FIRST_MESSAGE_LOGIN_ORDER.indexOf(left.providerType)-FIRST_MESSAGE_LOGIN_ORDER.indexOf(right.providerType))[0];
   return pick?{activate:true,connectionId:pick.connectionId}:{activate:false};
  }
  // Commands stored before the provider list exist only under main's rule (exactly one detected login, which it activated); several logins without provider types activate nothing here, in the transition and in replay.
  return facts.detectedLogins.length===1?{activate:true,connectionId:facts.detectedLogins[0]!}:{activate:false};
 }
 if(facts.onConnections.length===1&&facts.loginWaitingForRoute===facts.onConnections[0])return {activate:true,connectionId:facts.onConnections[0]!};
 return {activate:false};
}

/** One pure decision for the owner's Settings model selection on a subscription connection: the owner's proof with that provider's login detected turns it on, and the pick becomes the route only while none was decided. */
export interface ModelSelectionFacts {origin:SendOrigin;loginDetected:boolean;routePresent:boolean;routeClosedByOwner:boolean}
export interface ModelSelectionDecision {turnOn:boolean;route:boolean}
export function modelSelectionDecision(facts:ModelSelectionFacts):ModelSelectionDecision {
 const permitted=facts.origin==='owner-typed'&&facts.loginDetected;
 return {turnOn:permitted,route:permitted&&!facts.routePresent&&!facts.routeClosedByOwner};
}
