import {DomainError} from './domain.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {validatePaymentIntent} from './payment-intent.ts';
import type {PaymentIntent} from './payment-intent.ts';

export interface EnvironmentBinding {environment:string;surface:string;origin:string;generation:number;revision:number}
export type EnvironmentGate={kind:'send'}|{kind:'delete'}|{kind:'effect'}|{kind:'payment',intent?:PaymentIntent};
export type EnvironmentPermissionLevel='always-ask'|'auto'|'full-access';
export type EnvironmentWebsiteAccess='always-ask'|'always-allow';
export type EnvironmentEffectKind='send'|'delete'|'effect';
/** Read-only host state; this site is the only scope, because once means not remembered. */
export interface EnvironmentRememberedApproval {covers:'send'|'delete'|'first-visit';scope:'site';origin:string}
export type ActionInput={kind:'click'|'submit'}|{kind:'type';secret:{owner:string;slot:string}}|{kind:'key';key:string}|{kind:'select';option:string}|{kind:'scroll';x:number;y:number};
export interface EnvironmentElement {id:string;role:string;label:string;operations:ActionInput['kind'][];gates:EnvironmentGate[]}
export interface EnvironmentObservation {binding:EnvironmentBinding;structure:EnvironmentElement[];facts:Record<string,boolean>;image:{handle:string;expiresAt:number}|null}
export interface EnvironmentAction {binding:EnvironmentBinding;element:string;input:ActionInput;gates:EnvironmentGate[];label?:string}
export type OwnerWait={kind:'approve';who:string;what:string;where:string;timeoutMs:number}|{kind:'takeover';reason:'authentication'|'captcha'|'other';who:string;what:string;where:string;timeoutMs:number}|{kind:'confirm-on-device'|'human-check'|'enter-value';who:string;what:string;where:string;timeoutMs:number;fact:string;from:boolean;to:boolean;maxPolls:number;intervalMs:number};
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
 // An intent-less payment gate is an observation raise (a card field on the page); declarations must still carry one (browser-environment.ts).
 for(const g of value){environmentFields(g,g?.kind==='payment'?['kind',...(Object.hasOwn(g,'intent')?['intent']:[])]:['kind']);requireEnvironment(['send','delete','effect','payment'].includes(g.kind),'Invalid environment gate');if(g.kind==='payment'&&Object.hasOwn(g,'intent'))validatePaymentIntent(g.intent);}
 requireEnvironment(new Set(value.map(g=>g.kind)).size===value.length,'Duplicate environment gates');
}
const gateRank=(gate:EnvironmentGate)=>gate.kind==='payment'?3:gate.kind==='effect'?1:2;
export function strictestGate(gates:readonly EnvironmentGate[]):EnvironmentGate|undefined{return [...gates].sort((a,b)=>gateRank(b)-gateRank(a))[0];}
/** Effect-capable inputs: a submit, the Enter key, a button click, or any input kind on a control that carries a host gate, so a declaration is never silently dropped. Typing into a text field stays ungated (a text field carries no gate); a plain link with no raised gate stays reading. */
export const effectCapable=(input:ActionInput,role:string,hostGates:readonly EnvironmentGate[]=[]):boolean=>input.kind==='submit'||input.kind==='key'&&input.key==='Enter'||input.kind==='click'&&(role==='button'||hostGates.length>0)||hostGates.length>0&&!(input.kind==='type'&&role==='textbox');
export function rememberedApprovalCovers(kind:'send'|'delete',origin:string,approvals:readonly EnvironmentRememberedApproval[]):boolean{return approvals.some(approval=>approval.covers===kind&&approval.scope==='site'&&approval.origin===origin);}
/** RU5 level table. The effective kind is the strictest of the host declaration and the member's stated kind; a submit-capable proposal without any kind is send. In the browser the unit of asking is the site: effect proceeds at every level. */
export function actionGateProposal(input:ActionInput,role:string,declared:readonly EnvironmentGate[],stated:EnvironmentEffectKind|undefined,level:EnvironmentPermissionLevel,origin:string,approvals:readonly EnvironmentRememberedApproval[]):{gates:EnvironmentGate[];asks:boolean}{
 const capable=effectCapable(input,role,declared),best=capable?strictestGate([...declared,...(stated?[{kind:stated}]:[])]):undefined;
 const kind=best??(capable?{kind:'send'} as EnvironmentGate:undefined);
 const gates:EnvironmentGate[]=kind?[kind]:[];
 const asks=!capable?false:kind!.kind==='payment'?true:kind!.kind==='effect'?false:level!=='full-access'&&!rememberedApprovalCovers(kind!.kind,origin,approvals);
 return {gates,asks};
}
/** Re-derives the delivered gates at act time; a page that only raised the kind invalidates the approved proposal instead of lowering or executing it. */
export function redeliveredGates(node:Pick<EnvironmentElement,'role'|'gates'>,action:Pick<EnvironmentAction,'input'|'gates'>):EnvironmentGate[]{
 const best=effectCapable(action.input,node.role,node.gates)?strictestGate([...node.gates,...action.gates]):strictestGate(action.gates);
 return best?[best]:[];
}
export function validateRememberedApprovals(value:unknown):asserts value is EnvironmentRememberedApproval[]{
 const approvals=value as EnvironmentRememberedApproval[];
 requireEnvironment(Array.isArray(approvals)&&approvals.length<=200,'Invalid remembered approvals');
 for(const approval of approvals){environmentFields(approval,['covers','scope','origin']);requireEnvironment(['send','delete','first-visit'].includes(approval.covers)&&approval.scope==='site','Invalid remembered approval');requireEnvironment(line(approval.origin),'Invalid remembered approval origin');}
 requireEnvironment(new Set(approvals.map(a=>[a.covers,a.scope,a.origin??''].join('\u0000'))).size===approvals.length,'Duplicate remembered approvals');
}
export function validateObservation(value:unknown):asserts value is EnvironmentObservation {
 environmentFields(value,['binding','structure','facts','image']);validateBinding(value.binding);requireEnvironment(Array.isArray(value.structure)&&value.structure.length<=64,'Invalid structure');
 for(const e of value.structure){environmentFields(e,['id','role','label','operations','gates']);requireEnvironment(environmentId(e.id)&&line(e.role,64)&&line(e.label)&&Array.isArray(e.operations)&&e.operations.length>0&&e.operations.length<=6&&e.operations.every((k:unknown)=>typeof k==='string'&&operations.includes(k))&&new Set(e.operations).size===e.operations.length,'Invalid element');validateGates(e.gates);}
 requireEnvironment(new Set(value.structure.map((e:EnvironmentElement)=>e.id)).size===value.structure.length,'Duplicate element');
 requireEnvironment(value.facts&&typeof value.facts==='object'&&!Array.isArray(value.facts)&&Object.entries(value.facts).every(([key,v])=>environmentId(key)&&typeof v==='boolean'),'Invalid host facts');
 if(value.image!==null){environmentFields(value.image,['handle','expiresAt']);requireEnvironment(environmentId(value.image.handle)&&environmentInteger(value.image.expiresAt),'Invalid ephemeral image');}
}
export function validateAction(value:unknown):asserts value is EnvironmentAction {
 const hasLabel=Object.hasOwn(value as object,'label');environmentFields(value,['binding','element','input','gates',...(hasLabel?['label']:[])]);validateBinding(value.binding);validateActionInput(value.input);validateGates(value.gates);requireEnvironment(environmentId(value.element),'Invalid element identity');
 if(hasLabel)requireEnvironment(line(value.label),'Invalid element label');
 requireEnvironment(value.input.kind!=='submit'||value.gates.length>0,'Submit requires an owner gate');
}
export function validateOwnerWait(value:unknown):asserts value is OwnerWait {
 boundedPlainJson(value);const w=value as OwnerWait;requireEnvironment(w&&['approve','takeover','confirm-on-device','human-check','enter-value'].includes(w.kind),'Invalid owner wait');
 environmentFields(w,['kind',...(w.kind==='takeover'?['reason']:[]),'who','what','where','timeoutMs',...(w.kind==='approve'||w.kind==='takeover'?[]:['fact','from','to','maxPolls','intervalMs'])]);
 requireEnvironment([w.who,w.what,w.where].every(v=>line(v))&&environmentInteger(w.timeoutMs)&&w.timeoutMs>0&&w.timeoutMs<=86400000,'Invalid owner wait bounds');
 if(w.kind==='takeover')requireEnvironment(['authentication','captcha','other'].includes(w.reason),'Invalid takeover reason');
 if(w.kind!=='approve'&&w.kind!=='takeover')requireEnvironment(environmentId(w.fact)&&typeof w.from==='boolean'&&typeof w.to==='boolean'&&w.from!==w.to&&environmentInteger(w.maxPolls)&&w.maxPolls>0&&w.maxPolls<=120&&environmentInteger(w.intervalMs)&&w.intervalMs>=1000&&w.intervalMs<=60000,'Invalid owner poll bounds');
}
