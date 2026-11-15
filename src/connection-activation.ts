import {DomainError,hash} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX,SEND_ORIGINS} from './assistant-conversation.ts';
import type {SendOrigin} from './assistant-conversation.ts';
import type {Operation} from './storage.ts';
export type {SendOrigin};

/** The three owner actions that turn a built-in connection on for live model calls. */
export type ActivationWay='key-added'|'login-started'|'first-message';
export interface ConnectionActivation {connectionId:string;at:number;way:ActivationWay;messageId?:string}
/** The single route fact: written once by the first-route transition, replaced only by an explicit owner choice. */
export interface RouteChoice {connectionId:string;at:number;source:'first-route'|'owner-choice'}
export interface ConnectionActivationState {kind:'connection-activation';id:string;activations:ConnectionActivation[];routeChoice:RouteChoice|null;routeClosedAt:number|null}
type Command={kind:'turn-on';commandId:string;connectionId:string;way:ActivationWay;at:number;messageId?:string;messageOrigin?:SendOrigin;detectedLogins?:readonly string[]}|{kind:'record-route';commandId:string;connectionId:string;at:number;source:'owner-choice'}|{kind:'close-route';commandId:string;at:number};
export const CONNECTION_ACTIVATION_ID=ASSISTANT_CONVERSATION_PREFIX+'connection-activation';
const ways=['key-added','login-started','first-message'];
function ensure(value:unknown,message:string,code:'invalid'|'conflict'='invalid'):asserts value {if(!value)throw new DomainError(message,code);}
function exact(value:unknown,keys:string[],optional:string[]=[]):asserts value is Record<string,any> {ensure(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>[...keys,...optional].includes(k))&&keys.every(k=>Object.hasOwn(value,k)),'Invalid connection activation fields');}
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);

/** One durable decision per connection; the journal line is the persistent on state. */
export function activationState(value:unknown):ConnectionActivationState {
 if(value===undefined)return {kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:[],routeChoice:null,routeClosedAt:null};
 exact(value,['kind','id','activations'],['routeChoice','routeClosedAt']);ensure(value.kind==='connection-activation'&&value.id===CONNECTION_ACTIVATION_ID&&Array.isArray(value.activations)&&value.activations.length<=32,'Invalid stored connection activations');
 for(const a of value.activations){exact(a,['connectionId','at','way'],['messageId']);ensure(identity(a.connectionId)&&ways.includes(a.way)&&Number.isSafeInteger(a.at)&&a.at>=0&&(a.messageId===undefined||/^m:[a-f0-9]{32}$/.test(a.messageId)),'Invalid stored connection activation');}
 ensure(new Set(value.activations.map((a:ConnectionActivation)=>a.connectionId)).size===value.activations.length,'Invalid stored connection activations');
 const routeChoice=value.routeChoice??null;
 if(routeChoice!==null){exact(routeChoice,['connectionId','at','source']);ensure(identity(routeChoice.connectionId)&&(routeChoice.source==='first-route'||routeChoice.source==='owner-choice')&&Number.isSafeInteger(routeChoice.at)&&routeChoice.at>=0,'Invalid stored route choice');}
 ensure(value.routeClosedAt===undefined||value.routeClosedAt===null||Number.isSafeInteger(value.routeClosedAt)&&value.routeClosedAt>=0,'Invalid stored route removal');
 return {kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:structuredClone(value.activations),routeChoice:structuredClone(routeChoice),routeClosedAt:value.routeClosedAt??null};
}
export function isConnectionActivationState(value:unknown):value is ConnectionActivationState {try{if(value===undefined)return false;activationState(value);return true;}catch{return false;}}
/** Distinct per source command and connection, so replay stays idempotent inside the global command namespace. */
export const activationCommandId=(commandId:string,connectionId:string)=>'connection-on:'+hash([commandId,connectionId]).slice(0,32);
const actor='local-owner';
export const activationFingerprint=(command:Command)=>hash({actorId:actor,command});
export function applyActivation(current:ConnectionActivationState,command:Command){
 const value=activationState(current);
 if(command.kind==='record-route'){
  exact(command,['kind','commandId','connectionId','at','source']);ensure(identity(command.commandId)&&identity(command.connectionId)&&command.source==='owner-choice'&&Number.isSafeInteger(command.at)&&command.at>=0,'Invalid route choice');
  value.routeChoice={connectionId:command.connectionId,at:command.at,source:command.source};value.routeClosedAt=null;
  return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
 }
 if(command.kind==='close-route'){
  exact(command,['kind','commandId','at']);ensure(identity(command.commandId)&&Number.isSafeInteger(command.at)&&command.at>=0,'Invalid route removal');
  value.routeChoice=null;
  if(value.routeClosedAt===null)value.routeClosedAt=command.at;
  return {value,events:[{type:'connection-activation',actor,command:structuredClone(command)}]};
 }
 exact(command,['kind','commandId','connectionId','way','at'],['messageId','messageOrigin','detectedLogins']);
 ensure(identity(command.commandId)&&identity(command.connectionId)&&ways.includes(command.way)&&Number.isSafeInteger(command.at)&&command.at>=0&&(command.messageId===undefined||/^m:[a-f0-9]{32}$/.test(command.messageId))&&(command.messageOrigin===undefined||SEND_ORIGINS.includes(command.messageOrigin))&&(command.detectedLogins===undefined||Array.isArray(command.detectedLogins)&&command.detectedLogins.length<=32&&command.detectedLogins.every(identity)),'Invalid connection activation');
 if(command.way==='first-message')ensure(command.messageId!==undefined&&command.messageOrigin!==undefined&&Array.isArray(command.detectedLogins),'Invalid connection activation');
 ensure(!value.activations.some(a=>a.connectionId===command.connectionId),'Connection already on','conflict');
 // The first route is decided inside this transition by recomputing firstRouteDecision against the aggregate at commit.
 const decision=firstRouteDecision({
  way:command.way,
  connectionId:command.connectionId,
  messageAccepted:command.messageId!==undefined,
  origin:command.messageOrigin??'unattributed',
  onConnections:value.activations.map(a=>a.connectionId),
  detectedLogins:command.detectedLogins??[],
  routePresent:value.routeChoice!==null,
  routeClosedByOwner:value.routeClosedAt!==null,
  loginWaitingForRoute:value.routeChoice===null&&value.activations.length===1&&value.activations[0]!.way==='login-started'?value.activations[0]!.connectionId:null
 });
 if(command.way==='first-message')ensure(decision.activate&&decision.connectionId===command.connectionId,'First-message activation not permitted','conflict');
 if(decision.activate&&decision.connectionId===command.connectionId)value.routeChoice={connectionId:decision.connectionId,at:command.at,source:'first-route'};
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

/** One pure decision for the owner's first route; the service only gathers inputs and applies the result. */
export interface FirstRouteFacts {
 way?:ActivationWay;
 connectionId?:string;
 messageAccepted:boolean;origin:SendOrigin;
 onConnections:readonly string[];detectedLogins:readonly string[];
 routePresent:boolean;routeClosedByOwner:boolean;loginWaitingForRoute:string|null;
}
export type FirstRouteDecision={activate:false}|{activate:true;connectionId:string};
export function firstRouteDecision(facts:FirstRouteFacts):FirstRouteDecision {
 const way=facts.way??'first-message';
 if(facts.routePresent||facts.routeClosedByOwner)return {activate:false};
 if(way==='key-added')return {activate:false};
 if(way==='login-started')return facts.onConnections.length===0&&facts.connectionId!==undefined?{activate:true,connectionId:facts.connectionId}:{activate:false};
 if(!facts.messageAccepted||facts.origin!=='owner-typed')return {activate:false};
 if(facts.onConnections.length===0)return facts.detectedLogins.length===1?{activate:true,connectionId:facts.detectedLogins[0]!}:{activate:false};
 if(facts.onConnections.length===1&&facts.loginWaitingForRoute===facts.onConnections[0])return {activate:true,connectionId:facts.onConnections[0]!};
 return {activate:false};
}
