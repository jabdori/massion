import {DomainError} from './domain.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {validatePaymentIntent} from './payment-intent.ts';
import type {PaymentIntent} from './payment-intent.ts';

export interface EnvironmentBinding {environment:string;surface:string;origin:string;generation:number;revision:number}
export type EnvironmentGate={kind:'account-creation'|'personal-data-submission'|'terms-acceptance'|'irreversible-submit'}|{kind:'payment';intent:PaymentIntent};
export type ActionInput={kind:'click'|'submit'}|{kind:'type';secret:{owner:string;slot:string}}|{kind:'key';key:string}|{kind:'select';option:string}|{kind:'scroll';x:number;y:number};
export interface EnvironmentElement {id:string;role:string;label:string;operations:ActionInput['kind'][];gates:EnvironmentGate[]}
export interface EnvironmentObservation {binding:EnvironmentBinding;structure:EnvironmentElement[];facts:Record<string,boolean>;image:{handle:string;expiresAt:number}|null}
export interface EnvironmentAction {binding:EnvironmentBinding;element:string;input:ActionInput;gates:EnvironmentGate[]}
export type OwnerWait={kind:'approve';who:string;what:string;where:string;timeoutMs:number}|{kind:'confirm-on-device'|'human-check'|'enter-value';who:string;what:string;where:string;timeoutMs:number;fact:string;from:boolean;to:boolean;maxPolls:number;intervalMs:number};
/** Trusted host boundary: facts are instrumentation, never claims parsed from page text. */
export interface EnvironmentAdapter {
 observe(signal:AbortSignal):Promise<EnvironmentObservation>;
 /** Check binding/policy atomically at delivery, also after secret resolution. Erase secret bytes in finally; never return them. */
 act(action:EnvironmentAction,context:{signal:AbortSignal;secret?:()=>Promise<Uint8Array>}):Promise<void>;
}
export function requireEnvironment(value:unknown,message:string,code:'invalid'|'conflict'|'denied'='invalid'):asserts value {if(!value)throw new DomainError(message,code);}
export function environmentFields(value:unknown,keys:string[]):asserts value is Record<string,any>{boundedPlainJson(value);requireEnvironment(!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'Exact environment fields required');}
export const environmentId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
export const environmentInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const line=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
const operations=['click','type','key','select','scroll','submit'];
export function validateBinding(value:unknown):asserts value is EnvironmentBinding {
 environmentFields(value,['environment','surface','origin','generation','revision']);requireEnvironment(environmentId(value.environment)&&environmentId(value.surface)&&line(value.origin)&&environmentInteger(value.generation)&&value.generation>0&&environmentInteger(value.revision)&&value.revision>0,'Invalid environment binding');
}
export function validateActionInput(value:unknown):asserts value is ActionInput {
 boundedPlainJson(value);const v=value as ActionInput;requireEnvironment(v&&operations.includes(v.kind),'Invalid environment action');
 switch(v.kind){
  case 'click':case 'submit':environmentFields(v,['kind']);break;
  case 'type':environmentFields(v,['kind','secret']);environmentFields(v.secret,['owner','slot']);requireEnvironment(environmentId(v.secret.owner)&&environmentId(v.secret.slot),'Invalid secret reference');break;
  case 'key':environmentFields(v,['kind','key']);requireEnvironment(['Enter','Tab','Escape','Space','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(v.key),'Invalid key');break;
  case 'select':environmentFields(v,['kind','option']);requireEnvironment(line(v.option,128),'Invalid option identity');break;
  case 'scroll':environmentFields(v,['kind','x','y']);requireEnvironment([v.x,v.y].every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=10000),'Invalid scroll distance');break;
 }
}
function validateGates(value:unknown):asserts value is EnvironmentGate[]{
 requireEnvironment(Array.isArray(value)&&value.length<=5,'Invalid environment gates');
 for(const g of value){environmentFields(g,g?.kind==='payment'?['kind','intent']:['kind']);requireEnvironment(['account-creation','personal-data-submission','terms-acceptance','irreversible-submit','payment'].includes(g.kind),'Invalid environment gate');if(g.kind==='payment')validatePaymentIntent(g.intent);}
 requireEnvironment(new Set(value.map(g=>g.kind)).size===value.length,'Duplicate environment gates');
}
export function validateObservation(value:unknown):asserts value is EnvironmentObservation {
 environmentFields(value,['binding','structure','facts','image']);validateBinding(value.binding);requireEnvironment(Array.isArray(value.structure)&&value.structure.length<=64,'Invalid structure');
 for(const e of value.structure){environmentFields(e,['id','role','label','operations','gates']);requireEnvironment(environmentId(e.id)&&line(e.role,64)&&line(e.label)&&Array.isArray(e.operations)&&e.operations.length>0&&e.operations.length<=6&&e.operations.every((k:unknown)=>typeof k==='string'&&operations.includes(k))&&new Set(e.operations).size===e.operations.length,'Invalid element');validateGates(e.gates);}
 requireEnvironment(new Set(value.structure.map((e:EnvironmentElement)=>e.id)).size===value.structure.length,'Duplicate element');
 requireEnvironment(value.facts&&typeof value.facts==='object'&&!Array.isArray(value.facts)&&Object.entries(value.facts).every(([key,v])=>environmentId(key)&&typeof v==='boolean'),'Invalid host facts');
 if(value.image!==null){environmentFields(value.image,['handle','expiresAt']);requireEnvironment(environmentId(value.image.handle)&&environmentInteger(value.image.expiresAt),'Invalid ephemeral image');}
}
export function validateAction(value:unknown):asserts value is EnvironmentAction {
 environmentFields(value,['binding','element','input','gates']);validateBinding(value.binding);validateActionInput(value.input);validateGates(value.gates);requireEnvironment(environmentId(value.element),'Invalid element identity');
 requireEnvironment(value.input.kind!=='submit'||value.gates.length>0,'Submit requires an owner gate');
}
export function validateOwnerWait(value:unknown):asserts value is OwnerWait {
 boundedPlainJson(value);const w=value as OwnerWait;requireEnvironment(w&&['approve','confirm-on-device','human-check','enter-value'].includes(w.kind),'Invalid owner wait');
 environmentFields(w,['kind','who','what','where','timeoutMs',...(w.kind==='approve'?[]:['fact','from','to','maxPolls','intervalMs'])]);
 requireEnvironment([w.who,w.what,w.where].every(v=>line(v))&&environmentInteger(w.timeoutMs)&&w.timeoutMs>0&&w.timeoutMs<=86400000,'Invalid owner wait bounds');
 if(w.kind!=='approve')requireEnvironment(environmentId(w.fact)&&typeof w.from==='boolean'&&typeof w.to==='boolean'&&w.from!==w.to&&environmentInteger(w.maxPolls)&&w.maxPolls>0&&w.maxPolls<=120&&environmentInteger(w.intervalMs)&&w.intervalMs>=1000&&w.intervalMs<=60000,'Invalid owner poll bounds');
}
