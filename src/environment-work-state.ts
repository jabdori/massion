import {DomainError,canonical,hash,workInputHash} from './domain.ts';
import type {Actor,Work,Task} from './domain.ts';
import {currentOwnership} from './runtime-continuation.ts';
import {teamTaskReady} from './internal-teams.ts';
import {requireProvidedSecrets} from './secret-requests.ts';
import {environmentFields as exact,environmentId as id,environmentInteger as integer,validateBinding} from './environment.ts';
import type {EnvironmentBinding} from './environment.ts';
import {parseEnvironmentWorkPlan,validateEnvironmentWorkDefinitions} from './environment-work.ts';
import type {EnvironmentWorkDefinition,EnvironmentWorkPlan} from './environment-work.ts';

export const ENVIRONMENT_WORK_HOST='environment-work-host';
export interface RuntimeEnvironmentBinding {id:string;feedId:string;definition:EnvironmentWorkDefinition}
export interface EnvironmentWorkReference {id:string;hash:string;at:number;deadline:number}
export interface EnvironmentWorkObservation {observationId:string;binding:EnvironmentBinding;facts:Record<string,boolean>;pageReadId:string}
export type EnvironmentWorkRecord={index:number;at:number}&({kind:'observed';observation:EnvironmentWorkObservation}|{kind:'delivered'|'owner-completed'|'intent-approved';reference:EnvironmentWorkReference;effectId?:string;approvedAt?:number});
export interface EnvironmentWorkStep {inputHash:string;plan:EnvironmentWorkPlan;cursor:number;records:EnvironmentWorkRecord[];pending?:EnvironmentWorkReference&{phase:'prepared'|'waiting'|'claimed';effectId?:string;approvedAt?:number}}
export type EnvironmentWorkUpdate={kind:'begin';plan:EnvironmentWorkPlan}|{kind:'link';reference:EnvironmentWorkReference;waiting:boolean}|{kind:'resume';approvedAt?:number}|{kind:'claim'}|{kind:'stop'}|{kind:'complete';result:'delivered'|'owner-completed'|'intent-approved'}|{kind:'observe';observation:EnvironmentWorkObservation};
export interface EnvironmentWorkCommand {type:'record-environment-work';workId:string;taskId:string;environment:string;dispatchId:string;inputHash:string;index:number;update:EnvironmentWorkUpdate}
export const environmentWorkEffectId=(environment:string,taskId:string,index:number)=>'environment-effect:'+hash([environment,taskId,index]).slice(0,40);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function ensure(v:unknown,message='Invalid environment Work state',code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
function reference(r:EnvironmentWorkReference){exact(r,['id','hash','at','deadline']);ensure(id(r.id)&&sha(r.hash)&&integer(r.at)&&integer(r.deadline)&&r.deadline>r.at);}
function observation(o:EnvironmentWorkObservation,b:RuntimeEnvironmentBinding,facts:string[]){exact(o,['observationId','binding','facts','pageReadId']);validateBinding(o.binding);ensure(id(o.observationId)&&id(o.pageReadId)&&o.binding.environment===b.id&&o.binding.origin===b.definition.origin);exact(o.facts,facts);ensure(Object.values(o.facts).every(v=>typeof v==='boolean'));}
export function validateRuntimeEnvironment(work:Work){
 const b=work.runtimeRun?.environment;if(b===undefined){ensure(!work.tasks.some(t=>t.environment));return;}
 exact(b,['id','feedId','definition']);ensure(id(b.id)&&id(b.feedId)&&!!work.runtimeRun?.ownership&&work.team?.memberId===b.definition.memberId);validateEnvironmentWorkDefinitions([b.definition]);
 for(const task of work.tasks){const s=task.environment;if(!s)continue;exact(s,['inputHash','plan','cursor','records',...(s.pending?['pending']:[])]);ensure(!!task.step&&!task.step.skipReason&&sha(s.inputHash)&&parseEnvironmentWorkPlan(JSON.stringify(s.plan),b.definition)!==null&&integer(s.cursor)&&s.cursor<=s.plan.operations.length&&Array.isArray(s.records)&&s.records.length===s.cursor);ensure(task.status!=='settled'||s.cursor===s.plan.operations.length&&!s.pending);
  for(const [index,r] of s.records.entries()){
   exact(r,r.kind==='observed'?['index','at','kind','observation']:['index','at','kind','reference',...(r.kind==='delivered'?['effectId']:[]),...(r.kind==='intent-approved'||r.kind==='delivered'&&Object.hasOwn(r,'approvedAt')?['approvedAt']:[])]);ensure(r.index===index&&integer(r.at));const op=s.plan.operations[index]!;
   if(r.kind==='observed'){ensure(op.kind==='observe');observation(r.observation,b,op.facts);}
   else{ensure(['delivered','owner-completed','intent-approved'].includes(r.kind));reference(r.reference);ensure(r.at>=r.reference.at);if(r.kind==='owner-completed')ensure(op.kind==='wait'&&r.effectId===undefined&&r.approvedAt===undefined);else{ensure(op.kind==='act');const payment=b.definition.elements.find(e=>e.id===op.element)!.gates.some(g=>g.kind==='payment');ensure(payment===(r.kind==='intent-approved'));if(payment)ensure(integer(r.approvedAt)&&r.approvedAt!>=r.reference.at&&r.approvedAt!<=r.at&&r.effectId===undefined);else ensure(r.effectId===environmentWorkEffectId(b.id,task.id,index)&&work.effects.some(e=>e.id===r.effectId&&e.taskId===task.id&&e.status==='succeeded'));}}
  }
  if(s.pending){const p=s.pending;exact(p,['id','hash','at','deadline','phase',...(Object.hasOwn(p,'effectId')?['effectId']:[]),...(Object.hasOwn(p,'approvedAt')?['approvedAt']:[])]);reference({id:p.id,hash:p.hash,at:p.at,deadline:p.deadline});ensure(s.cursor<s.plan.operations.length&&s.plan.operations[s.cursor]!.kind!=='observe'&&['prepared','waiting','claimed'].includes(p.phase));if(p.approvedAt!==undefined)ensure(integer(p.approvedAt)&&p.approvedAt>=p.at);if(p.phase==='claimed')ensure(p.effectId===environmentWorkEffectId(b.id,task.id,s.cursor)&&work.effects.some(e=>e.id===p.effectId&&e.taskId===task.id));else ensure(p.effectId===undefined);}
 }
}
export function environmentObservations(work:Work){return work.tasks.flatMap(task=>(task.environment?.records??[]).flatMap(r=>r.kind==='observed'?[{taskId:task.id,...r}]:[]));}
export function environmentIntentApprovals(work:Work){const b=work.runtimeRun?.environment;return b?work.tasks.flatMap(task=>(task.environment?.records??[]).flatMap(r=>{if(r.kind!=='intent-approved')return [];const op=task.environment!.plan.operations[r.index]!;if(op.kind!=='act')return [];const gate=b.definition.elements.find(e=>e.id===op.element)!.gates.find(g=>g.kind==='payment');return gate?.kind==='payment'?[{taskId:task.id,reference:r.reference,at:r.approvedAt!,intent:gate.intent}]:[];})):[];}
export function environmentStepResult(work:Work,task:Task){const b=work.runtimeRun?.environment;ensure(b&&task.environment);return task.environment.records.flatMap(r=>{if(r.kind!=='observed')return [];const page=work.browserSession?.pages.find(p=>p.readId===r.observation.pageReadId);return [...b.definition.facts.filter(f=>Object.hasOwn(r.observation.facts,f.id)).map(f=>f.label+': '+String(r.observation.facts[f.id])),...(page&&!page.tainted?[page.title,...page.blocks]:[])];}).join('\n').slice(0,12000)||task.step?.title||work.title;}

export function applyEnvironmentWork(work:Work,c:EnvironmentWorkCommand,actor:Actor,at:number|undefined){
 ensure(actor.id===ENVIRONMENT_WORK_HOST&&actor.roles.includes('representative'),'Environment Work host required','denied');exact(c,['type','workId','taskId','environment','dispatchId','inputHash','index','update']);validateRuntimeEnvironment(work);
 const b=work.runtimeRun?.environment,o=currentOwnership(work),task=work.tasks.find(t=>t.id===c.taskId);ensure(b&&o&&task?.step&&!task.step.skipReason&&task.status!=='settled'&&teamTaskReady(work,task)&&work.assignments.some(a=>a.taskId===task.id&&a.role==='executor'));
 ensure(integer(at)&&at!>=o.startedAt&&at!<o.deadlineAt&&c.environment===b.id&&c.dispatchId===o.dispatchId&&c.inputHash===workInputHash(work),'Environment Work binding is stale','conflict');ensure(work.acceptance==='pending'&&!work.runtimeRecovery&&!work.runtimeInterruption&&!work.blocker&&!work.monthlyBudgetDecision&&['queued','active','waiting'].includes(work.execution),'Environment Work cannot progress','conflict');requireProvidedSecrets(work);ensure(integer(c.index));const u=c.update;
 if(u.kind==='begin'){
  exact(u,['kind','plan']);ensure(c.index===0&&!task.environment&&work.execution!=='waiting'&&parseEnvironmentWorkPlan(JSON.stringify(u.plan),b.definition)!==null);task.environment={inputHash:c.inputHash,plan:structuredClone(u.plan),cursor:0,records:[]};task.status='active';task.startedAt??=at;work.execution='active';work.attempts.at(-1)!.status='active';validateRuntimeEnvironment(work);return;
 }
 const s=task.environment;ensure(s&&s.inputHash===c.inputHash&&s.cursor===c.index&&s.cursor<s.plan.operations.length,'Environment step is stale','conflict');const op=s.plan.operations[s.cursor]!,payment=op.kind==='act'?b.definition.elements.find(e=>e.id===op.element)!.gates.find(g=>g.kind==='payment'):undefined;
 switch(u.kind){
  case 'stop':exact(u,['kind']);ensure(s.pending);work.execution='blocked';work.blocker={code:'provider_failed',detail:'Environment step stopped before confirmed completion'};break;
  case 'link':
   exact(u,['kind','reference','waiting']);reference(u.reference);ensure(op.kind!=='observe'&&!s.pending&&typeof u.waiting==='boolean'&&u.reference.at<=at!&&u.reference.deadline>at!&&work.execution==='active');s.pending={...structuredClone(u.reference),phase:u.waiting?'waiting':'prepared'};if(u.waiting)work.execution='waiting';break;
  case 'resume':
   exact(u,['kind',...(Object.hasOwn(u,'approvedAt')?['approvedAt']:[])]);ensure(s.pending?.phase==='waiting'&&work.execution==='waiting'&&at!<s.pending.deadline);if(op.kind==='act'){ensure(integer(u.approvedAt)&&u.approvedAt!>=s.pending.at&&u.approvedAt!<=at!);s.pending.approvedAt=u.approvedAt;}else ensure(op.kind==='wait'&&u.approvedAt===undefined);s.pending.phase='prepared';work.execution='active';delete work.endedAt;break;
  case 'claim':{
   exact(u,['kind']);ensure(op.kind==='act'&&!payment&&s.pending?.phase==='prepared'&&work.execution==='active'&&at!<s.pending.deadline);const element=b.definition.elements.find(e=>e.id===op.element)!;if(element.gates.length||element.operations.some(k=>['click','submit','select'].includes(k)))ensure(s.pending.approvedAt!==undefined,'Owner approval is missing','denied');
   const effectId=environmentWorkEffectId(b.id,task.id,s.cursor);ensure(work.effects.length<128&&!work.effects.some(e=>e.id===effectId||e.status==='pending'||e.status==='unknown'),'Environment action is already claimed or another effect is unresolved','conflict');work.effects.push({id:effectId,taskId:task.id,status:'pending',target:element.label,authority:'environment:'+s.pending.hash});s.pending.phase='claimed';s.pending.effectId=effectId;break;
  }
  case 'complete':{
   exact(u,['kind','result']);ensure(s.pending&&work.execution==='active'&&['delivered','owner-completed','intent-approved'].includes(u.result));const p=s.pending,r={id:p.id,hash:p.hash,at:p.at,deadline:p.deadline};
   if(u.result==='delivered'){ensure(op.kind==='act'&&!payment&&p.phase==='claimed'&&p.effectId);const effect=work.effects.find(e=>e.id===p.effectId);ensure(effect?.status==='succeeded'&&effect.authority==='environment:'+p.hash);let receipt;try{receipt=JSON.parse(effect.receipt!);}catch{}ensure(receipt?.kind==='environment-delivery/v1'&&receipt.environment===b.id&&receipt.entryId===p.id&&receipt.requestHash===p.hash);s.records.push({index:s.cursor,kind:u.result,at:at!,reference:r,effectId:p.effectId,...(p.approvedAt===undefined?{}:{approvedAt:p.approvedAt})});}
   else{ensure(p.phase==='prepared'&&(u.result==='owner-completed'?op.kind==='wait':op.kind==='act'&&!!payment&&p.approvedAt!==undefined));s.records.push({index:s.cursor,kind:u.result,at:at!,reference:r,...(u.result==='intent-approved'?{approvedAt:p.approvedAt!}:{})});}
   s.cursor++;delete s.pending;break;
  }
  case 'observe':{
   exact(u,['kind','observation']);ensure(op.kind==='observe'&&!s.pending&&work.execution==='active'&&environmentObservations(work).length<32);observation(u.observation,b,op.facts);const page=work.browserSession?.pages.find(p=>p.readId===u.observation.pageReadId);ensure(page&&page.inputHash===c.inputHash&&page.address===b.definition.origin&&page.at<=at!,'Environment observation lacks its retained page');
   const effectId=environmentWorkEffectId(b.id,task.id,s.cursor);ensure(work.effects.length<128&&!work.effects.some(e=>e.id===effectId||e.status==='pending'||e.status==='unknown'));work.effects.push({id:effectId,taskId:task.id,status:'succeeded',target:task.step.title,authority:'environment-observation:'+u.observation.observationId,receipt:canonical({kind:'environment-observation/v1',...u.observation,approvals:environmentIntentApprovals(work)})});s.records.push({index:s.cursor,kind:'observed',at:at!,observation:structuredClone(u.observation)});s.cursor++;break;
  }
  default:ensure(false);
 }
 validateRuntimeEnvironment(work);
}
