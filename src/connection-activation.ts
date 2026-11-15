import {DomainError,hash} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {Operation} from './storage.ts';

/** The three owner actions that turn a built-in connection on for live model calls. */
export type ActivationWay='key-added'|'login-started'|'first-message';
export interface ConnectionActivation {connectionId:string;at:number;way:ActivationWay;messageId?:string}
export interface ConnectionActivationState {kind:'connection-activation';id:string;activations:ConnectionActivation[]}
type Command={kind:'turn-on';commandId:string;connectionId:string;way:ActivationWay;at:number;messageId?:string};
export const CONNECTION_ACTIVATION_ID=ASSISTANT_CONVERSATION_PREFIX+'connection-activation';
const ways=['key-added','login-started','first-message'];
function ensure(value:unknown,message:string,code:'invalid'|'conflict'='invalid'):asserts value {if(!value)throw new DomainError(message,code);}
function exact(value:unknown,keys:string[],optional:string[]=[]):asserts value is Record<string,any> {ensure(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>[...keys,...optional].includes(k))&&keys.every(k=>Object.hasOwn(value,k)),'Invalid connection activation fields');}
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);

/** One durable decision per connection; the journal line is the persistent on state. */
export function activationState(value:unknown):ConnectionActivationState {
 if(value===undefined)return {kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:[]};
 exact(value,['kind','id','activations']);ensure(value.kind==='connection-activation'&&value.id===CONNECTION_ACTIVATION_ID&&Array.isArray(value.activations)&&value.activations.length<=32,'Invalid stored connection activations');
 for(const a of value.activations){exact(a,['connectionId','at','way'],['messageId']);ensure(identity(a.connectionId)&&ways.includes(a.way)&&Number.isSafeInteger(a.at)&&a.at>=0&&(a.messageId===undefined||/^m:[a-f0-9]{32}$/.test(a.messageId)),'Invalid stored connection activation');}
 ensure(new Set(value.activations.map((a:ConnectionActivation)=>a.connectionId)).size===value.activations.length,'Invalid stored connection activations');
 return structuredClone(value) as ConnectionActivationState;
}
export function isConnectionActivationState(value:unknown):value is ConnectionActivationState {try{if(value===undefined)return false;activationState(value);return true;}catch{return false;}}
/** Distinct per source command and connection, so replay stays idempotent inside the global command namespace. */
export const activationCommandId=(commandId:string,connectionId:string)=>'connection-on:'+hash([commandId,connectionId]).slice(0,32);
const actor='local-owner';
export const activationFingerprint=(command:Command)=>hash({actorId:actor,command});
export function applyActivation(current:ConnectionActivationState,command:Command){
 const value=activationState(current);
 exact(command,['kind','commandId','connectionId','way','at'],['messageId']);ensure(identity(command.commandId)&&identity(command.connectionId)&&ways.includes(command.way)&&Number.isSafeInteger(command.at)&&command.at>=0&&(command.messageId===undefined||/^m:[a-f0-9]{32}$/.test(command.messageId)),'Invalid connection activation');
 ensure(!value.activations.some(a=>a.connectionId===command.connectionId),'Connection already on','conflict');
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

export type SendOrigin='owner-typed'|'scheduled'|'member'|'imported'|'replayed'|'unattributed';
/** One pure decision for the owner's first route; the service only gathers inputs and applies the result. */
export interface FirstRouteFacts {
 messageAccepted:boolean;origin:SendOrigin;
 onConnections:readonly string[];detectedLogins:readonly string[];
 routePresent:boolean;routeClosedByOwner:boolean;loginWaitingForRoute:string|null;
}
export type FirstRouteDecision={activate:false}|{activate:true;connectionId:string};
export function firstRouteDecision(facts:FirstRouteFacts):FirstRouteDecision {
 if(!facts.messageAccepted||facts.origin!=='owner-typed'||facts.routePresent||facts.routeClosedByOwner)return {activate:false};
 if(facts.onConnections.length===0)return facts.detectedLogins.length===1?{activate:true,connectionId:facts.detectedLogins[0]!}:{activate:false};
 if(facts.onConnections.length===1&&facts.loginWaitingForRoute===facts.onConnections[0])return {activate:true,connectionId:facts.onConnections[0]!};
 return {activate:false};
}
