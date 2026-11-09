import {DomainError,hash} from './domain.ts';
import type {Task,Work} from './domain.ts';
import {applySkills,bodyHash} from './skills.ts';
import type {SkillBody,SkillsState} from './skills.ts';
import {ASSISTANT_ACTOR_ID} from './assistant-conversation.ts';

export interface ProcedurePin {id:string;version:number;hash:string;body:SkillBody}
export interface TeamProcedure {memberId:string;skillsRevision:number;procedures:ProcedurePin[]}
export interface TeamStep {role:string;title:string;dependsOn:string[];skipReason?:string;instruction?:string}
export const MAX_TEAM_STEPS=12;
const defaultBody:SkillBody={description:'Complete the request',steps:['Read inputs','Draft result'],verify:'Check the result against the request'};
const fail=()=>{throw new DomainError('Invalid internal team procedure or plan');};
const line=(x:unknown,n=200):x is string=>typeof x==='string'&&x.length>0&&x.length<=n&&x.trim()===x&&x.isWellFormed()&&!/[\p{Cc}\p{Cf}]/u.test(x);
const exact=(x:any,keys:string[],optional:string[]=[])=>x&&typeof x==='object'&&!Array.isArray(x)&&keys.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>keys.includes(k)||optional.includes(k));
export function memberProcedures(state:SkillsState|null,memberId:string,skillsRevision=0):TeamProcedure {
 const skills=state?.skills.filter(s=>s.memberId===memberId&&s.kind==='procedure'&&s.current!==null&&s.archivedAt===undefined)??[];
 const procedures=skills.map(s=>{
  applySkills(state,{type:'use-skill',skillId:s.id},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{observedAt:s.usedAt});
  const v=s.versions[s.current!-1]!;return {id:s.id,version:v.version,hash:v.hash,body:structuredClone(v.body)};
 });
 const team={memberId,skillsRevision,procedures:procedures.length?procedures:[{id:'host-default-v1',version:1,hash:bodyHash(defaultBody),body:structuredClone(defaultBody)}]};validateTeamProcedure(team,memberId);return team;
}
export function validateTeamProcedure(value:unknown,memberId?:string):asserts value is TeamProcedure {
 const t=value as TeamProcedure;
 if(!exact(t,['memberId','skillsRevision','procedures'])||!Number.isSafeInteger(t.skillsRevision)||t.skillsRevision<0||!line(t.memberId,128)||t.memberId!==memberId||!Array.isArray(t.procedures)||!t.procedures.length||t.procedures.length>MAX_TEAM_STEPS)fail();
 for(const p of t.procedures){if(!exact(p,['id','version','hash','body'])||!line(p.id,128)||!Number.isSafeInteger(p.version)||p.version<1||!exact(p.body,['description','steps','verify'])||!line(p.body.description)||!line(p.body.verify)||!Array.isArray(p.body.steps)||!p.body.steps.length||!p.body.steps.every(s=>line(s))||p.hash!==hash(p.body))fail();}
 if(new Set(t.procedures.map(p=>p.id)).size!==t.procedures.length||procedureSteps(t).length>MAX_TEAM_STEPS)fail();
}
export const procedureSteps=(team:TeamProcedure)=>team.procedures.flatMap(p=>p.body.steps);
export const teamCallCount=(team?:TeamProcedure,rooms=false)=>team?procedureSteps(team).length+3+(rooms&&procedureSteps(team).length>1?2:0):2;
export function parseTeamPlan(output:string,work:Work):TeamStep[] {
 let plan:any;try{plan=JSON.parse(output);}catch{return fail();}
 const count=procedureSteps(work.team!).length;
 if(!exact(plan,['steps'])||!Array.isArray(plan.steps)||plan.steps.length!==count)fail();
 return plan.steps.map((s:any,i:number)=>{
  if(!exact(s,['role','title','dependsOn'],['skipReason','instruction'])||!line(s.role,40)||!line(s.title)||!Array.isArray(s.dependsOn)||s.dependsOn.length>count||new Set(s.dependsOn).size!==s.dependsOn.length||!s.dependsOn.every((n:unknown)=>Number.isSafeInteger(n)&&(n as number)>=0&&(n as number)<i)||Object.hasOwn(s,'skipReason')&&!line(s.skipReason)||Object.hasOwn(s,'instruction')&&!line(s.instruction,2000))fail();
  return {role:s.role,title:s.title,dependsOn:s.dependsOn.map((n:number)=>`${work.id}:step:${n}`),...(s.skipReason?{skipReason:s.skipReason}:{}),...(s.instruction?{instruction:s.instruction}:{})};
 });
}
export function validateTeamTask(work:Work,task:Task):void {
 const s=task.step;if(!Object.hasOwn(task,'step'))return;if(!s)return fail();
 if(!work.team||!/^\d+$/.test(task.id.slice((work.id+':step:').length))||!task.id.startsWith(work.id+':step:')||Number(task.id.split(':').at(-1))>=procedureSteps(work.team).length||task.parentId!==`${work.id}:executor`||!exact(s,['role','title','dependsOn'],['skipReason','instruction'])||!line(s.role,40)||!line(s.title)||!Array.isArray(s.dependsOn)||new Set(s.dependsOn).size!==s.dependsOn.length||s.dependsOn.some(id=>!work.tasks.some(t=>t.id===id&&t.step&&Number(t.id.split(':').at(-1))<Number(task.id.split(':').at(-1))))||Object.hasOwn(s,'skipReason')&&!line(s.skipReason)||Object.hasOwn(s,'instruction')&&!line(s.instruction,2000))fail();
}
export function teamTaskReady(work:Work,task:Task):boolean {return !!task.step&&!task.step.skipReason&&task.step.dependsOn.every(id=>work.tasks.some(t=>t.id===id&&t.status==='settled'));}
