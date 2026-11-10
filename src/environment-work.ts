import {DomainError} from './domain.ts';
import {environmentFields as exact,environmentId as id,validateOwnerWait} from './environment.ts';
import type {OwnerWait} from './environment.ts';
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
