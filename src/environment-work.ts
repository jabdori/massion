import {DomainError} from './domain.ts';
import {environmentFields as exact,environmentId as id,validateOwnerWait,validateActionInput} from './environment.ts';
import type {OwnerWait,ActionInput} from './environment.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {validateBrowserEnvironment} from './browser-environment.ts';
import type {BrowserEnvironmentConfig} from './browser-environment.ts';
import {secretRequestHash} from './secret-requests.ts';
import type {SecretDeclaration} from './secret-requests.ts';

export interface EnvironmentWorkSecret {id:string;label:string;purpose:string;fields:Array<SecretDeclaration['fields'][number]&{element:string}>}
export interface EnvironmentWorkDefinition {
 memberId:string;origin:string;elements:BrowserEnvironmentConfig['elements'];
 facts:Array<BrowserEnvironmentConfig['facts'][number]&{label:string;kind:'state'|'order-confirmation'}>;
 waits:Array<{id:string;request:Exclude<OwnerWait,{kind:'approve'}>}>;
 secrets:EnvironmentWorkSecret[];
}
export type EnvironmentWorkOperation={kind:'act';element:string;input:ActionInput}|{kind:'wait';id:string}|{kind:'observe';facts:string[]};
export type EnvironmentWorkPlan={format:'massion-environment/v1';operations:EnvironmentWorkOperation[]};
export function parseEnvironmentWorkPlan(output:string,definition:EnvironmentWorkDefinition):EnvironmentWorkPlan|null {
 let value;try{value=JSON.parse(output);}catch{return null;}
 if(value?.format!=='massion-environment/v1')return null;
 try{
  boundedPlainJson(value);exact(value,['format','operations']);
  ensure(Array.isArray(value.operations)&&value.operations.length>=1&&value.operations.length<=8&&value.operations.at(-1)?.kind==='observe');
  for(const operation of value.operations){
   switch(operation?.kind){
    case 'act':{
     exact(operation,['kind','element','input']);validateActionInput(operation.input);
     const element=definition.elements.find(e=>e.id===operation.element);ensure(element&&!element.ownerOnly&&element.operations.includes(operation.input.kind));
     if(operation.input.kind==='type'){
      const secret=operation.input.secret;ensure(secret.owner==='local-owner'&&definition.secrets.some(s=>s.fields.some(f=>f.slot===secret.slot&&f.element===element.id)));
     }
     break;
    }
    case 'wait':exact(operation,['kind','id']);ensure(definition.waits.some(w=>w.id===operation.id));break;
    case 'observe':
     exact(operation,['kind','facts']);ensure(Array.isArray(operation.facts)&&operation.facts.length<=64&&new Set(operation.facts).size===operation.facts.length&&operation.facts.every((fact:unknown)=>definition.facts.some(f=>f.id===fact)));break;
    default:ensure(false);
   }
  }
  return value as EnvironmentWorkPlan;
 }catch{throw new DomainError('Invalid environment Work plan');}
}
export const environmentSecretDeclaration=(definition:EnvironmentWorkDefinition,secret:EnvironmentWorkSecret):SecretDeclaration=>({memberId:definition.memberId,label:secret.label,purpose:secret.purpose,fields:secret.fields.map(({element,...field})=>field)});
const line=(v:unknown,max=128):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&v.isWellFormed()&&!/[\u0000-\u001f\u007f-\u009f]/.test(v);
function ensure(value:unknown):asserts value {if(!value)throw new DomainError('Invalid environment Work declaration');}
export function validateEnvironmentWorkDefinitions(value:unknown):asserts value is EnvironmentWorkDefinition[]{
 ensure(Array.isArray(value)&&value.length<=16);
 for(const d of value){
  exact(d,['memberId','origin','elements','facts','waits','secrets']);ensure(id(d.memberId)&&Array.isArray(d.facts)&&d.facts.length<=64&&Array.isArray(d.waits)&&d.waits.length<=16&&Array.isArray(d.secrets)&&d.secrets.length<=16);
  for(const fact of d.facts){exact(fact,['id','selector','state','label','kind']);ensure(line(fact.label)&&['state','order-confirmation'].includes(fact.kind));}
  validateBrowserEnvironment({environment:'definition',origin:d.origin,elements:d.elements,facts:d.facts.map(({label,kind,...fact}:EnvironmentWorkDefinition['facts'][number])=>fact)});
  for(const wait of d.waits){exact(wait,['id','request']);ensure(id(wait.id));validateOwnerWait(wait.request);ensure(wait.request.kind!=='approve'&&d.facts.some((f:EnvironmentWorkDefinition['facts'][number])=>f.id===wait.request.fact));}
  const slots=new Set<string>();
  for(const secret of d.secrets){
   exact(secret,['id','label','purpose','fields']);ensure(id(secret.id)&&Array.isArray(secret.fields));
   for(const field of secret.fields){exact(field,['slot','label','kind','element']);ensure(id(field.slot)&&!slots.has(field.slot)&&d.elements.some((e:BrowserEnvironmentConfig['elements'][number])=>e.id===field.element&&!e.ownerOnly&&e.operations.includes('type')));slots.add(field.slot);}
   secretRequestHash(environmentSecretDeclaration(d as unknown as EnvironmentWorkDefinition,secret as unknown as EnvironmentWorkSecret));
  }
  ensure(new Set(d.waits.map((w:EnvironmentWorkDefinition['waits'][number])=>w.id)).size===d.waits.length&&new Set(d.secrets.map((s:EnvironmentWorkSecret)=>s.id)).size===d.secrets.length);
 }
 ensure(new Set(value.map(d=>d.memberId)).size===value.length);
}
