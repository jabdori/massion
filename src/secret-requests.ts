import {DomainError,hash} from './domain.ts';
import type {Actor,Work} from './domain.ts';
import {checkSlot} from './secret-slots.ts';
import {validateSecretSource} from './secret-sources.ts';
import type {SecretSource} from './secret-sources.ts';

export const SECRET_REQUEST_HOST='secret-request-host';
export interface SecretDeclaration {memberId:string;label:string;purpose:string;fields:{slot:string;label:string;kind:'id'|'password'|'one-time-code'}[]}
export interface SecretSelection {slot:string;source:SecretSource}
export interface SecretRequest {id:string;requestHash:string;declaration:SecretDeclaration;state:'open'|'providing'|'provided'|'declined'|'unavailable';previousExecution:'queued'|'active';at:number;selections?:SecretSelection[];provisionId?:string;providedAt?:number}
export type SecretRequestCommand={type:'request-secret';workId:string;requestId:string;declaration:SecretDeclaration}
 | {type:'answer-secret-request';workId:string;requestId:string;requestHash:string;provisionId:string;answer:'provide'|'decline';selections:SecretSelection[]}
 | {type:'settle-secret-request';workId:string;requestId:string;requestHash:string;provisionId:string;status:'provided'|'unavailable'};
const exact=(v:unknown,keys:string[],optional:string[]=[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown,max:number)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
export function secretRequestHash(value:unknown):string {
 ensure(exact(value,['memberId','label','purpose','fields'])&&id(value.memberId)&&line(value.label,64)&&line(value.purpose,120)&&Array.isArray(value.fields)&&value.fields.length>0&&value.fields.length<=8,'Exact secret request metadata required');
 for(const field of value.fields){ensure(exact(field,['slot','label','kind'])&&line(field.label,64)&&['id','password','one-time-code'].includes(field.kind),'Invalid secret field');checkSlot({owner:value.memberId,slot:field.slot});}
 ensure(new Set(value.fields.map((f:any)=>f.slot)).size===value.fields.length,'Duplicate secret fields');return hash(value);
}
export function validateSecretSelections(request:SecretRequest,selections:unknown):asserts selections is SecretSelection[] {
 ensure(Array.isArray(selections)&&selections.length===request.declaration.fields.length&&new Set(selections.map(s=>s?.slot)).size===selections.length,'Exact secret selection required');
 for(const s of selections){ensure(exact(s,['slot','source'])&&request.declaration.fields.some(f=>f.slot===s.slot),'Undeclared secret slot');validateSecretSource(s.source);}
}
export const requestSecretSlot=(missionId:string,workId:string,requestId:string,slot:string)=>({owner:'request:'+hash({missionId,workId,requestId}).slice(0,32),slot});
export function validateSecretRequests(work:Work){
 if(work.secretRequests===undefined)return;
 ensure(Array.isArray(work.secretRequests)&&work.secretRequests.length>0&&work.secretRequests.length<=16&&new Set(work.secretRequests.map(r=>r.id)).size===work.secretRequests.length,'Invalid secret request history');
 for(const r of work.secretRequests){
  ensure(exact(r,['id','requestHash','declaration','state','previousExecution','at'],['selections','provisionId','providedAt'])&&id(r.id)&&r.requestHash===secretRequestHash(r.declaration)&&['open','providing','provided','declined','unavailable'].includes(r.state)&&['queued','active'].includes(r.previousExecution)&&Number.isSafeInteger(r.at)&&r.at>=0,'Invalid stored secret request');
  if(r.state==='open')ensure(r.selections===undefined&&r.provisionId===undefined&&r.providedAt===undefined,'Open request has no provision');
  else {ensure(id(r.provisionId),'Missing secret provision identity');if(r.state==='declined')ensure(r.selections===undefined,'Declined request has no selection');else validateSecretSelections(r,r.selections);}
  ensure(r.state==='provided'?Number.isSafeInteger(r.providedAt)&&r.providedAt!>=r.at:r.providedAt===undefined,'Invalid secret provision time');
 }
}
export function requireProvidedSecrets(work:Work){ensure(!work.secretRequests?.some(r=>r.state!=='provided'),'Unresolved secret request blocks execution');}
export function applySecretRequest(work:Work,command:SecretRequestCommand,actor:Actor,at:number){
 ensure(Number.isSafeInteger(at)&&at>=0,'Host time required');ensure(work.execution!=='cancelled'&&work.acceptance!=='accepted'&&!work.runtimeRecovery&&!work.runtimeInterruption,'Work no longer accepts secrets');validateSecretRequests(work);
 if(command.type==='request-secret'){
  ensure(actor.id===SECRET_REQUEST_HOST&&actor.roles.includes('representative'),'Secret request host required');
  ensure(exact(command,['type','workId','requestId','declaration'])&&id(command.requestId),'Exact secret request required');const requestHash=secretRequestHash(command.declaration),member=command.declaration.memberId;
  ensure(work.assistantSource?.memberId===member||work.assignments.some(a=>a.actorId===member&&a.role==='executor'),'Member is not assigned to this Work');
  ensure(['queued','active'].includes(work.execution)&&!work.blocker&&!work.secretRequests?.some(r=>r.state!=='provided')&&work.effects.every(e=>e.status!=='pending'&&e.status!=='unknown'),'Work must reach a settled boundary before requesting secrets');
  const requests=work.secretRequests??=[];ensure(requests.length<16&&!requests.some(r=>r.id===command.requestId),'Secret request already exists or limit reached');
  requests.push({id:command.requestId,requestHash,declaration:structuredClone(command.declaration),state:'open',previousExecution:work.execution as 'queued'|'active',at});work.execution='blocked';
 }else {
  const r=work.secretRequests?.find(r=>r.id===command.requestId);ensure(r&&r.requestHash===command.requestHash,'Secret request identity changed');
  if(command.type==='answer-secret-request'){
   ensure(actor.id==='local-owner'&&actor.roles.includes('owner'),'Owner decision required');ensure(exact(command,['type','workId','requestId','requestHash','provisionId','answer','selections'])&&id(command.provisionId)&&!command.provisionId.startsWith('assistant-')&&r.state==='open'&&['provide','decline'].includes(command.answer),'Exact open secret decision required');
   r.provisionId=command.provisionId;if(command.answer==='decline'){ensure(Array.isArray(command.selections)&&command.selections.length===0,'Decline has no secret sources');r.state='declined';}
   else {validateSecretSelections(r,command.selections);r.selections=structuredClone(command.selections);r.state='providing';}
  }else {
   ensure(actor.id===SECRET_REQUEST_HOST&&actor.roles.includes('representative'),'Secret settlement host required');ensure(exact(command,['type','workId','requestId','requestHash','provisionId','status'])&&r.state==='providing'&&r.provisionId===command.provisionId&&['provided','unavailable'].includes(command.status),'Exact pending provision required');
   r.state=command.status;if(command.status==='provided'){r.providedAt=at;if(work.execution==='blocked'&&!work.blocker&&!work.monthlyBudgetDecision){work.execution=r.previousExecution;delete work.endedAt;}}
  }
 }
 validateSecretRequests(work);
}
