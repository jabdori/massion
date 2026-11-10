import {validateProgressNote} from './member-progress.ts';
import {DomainError} from './domain.ts';
import type {CheckPredicate,Criteria,Verdict,StepProgress} from './domain.ts';
import {workFileInputs} from './github-review.ts';

export function fileReadCompletions(work:import('./domain.ts').Work):{taskId:string;count:number;completedAt:number}[] {
 const known=workFileInputs(work);
 return work.tasks.flatMap(task=>{
  if(!task.step||task.step.skipReason)return [];
  const files=known.filter(f=>!task.step!.sourceFiles||task.step!.sourceFiles.includes(f.path));if(!files.length)return [];
  const times=files.map(file=>{
   const marks=work.effects.filter(e=>e.taskId===task.id&&e.status==='succeeded'&&Number.isSafeInteger(e.deliveredAt)&&e.deliveredAt!>=0&&e.providerDispatch?.fileInputs?.some(f=>f.documentId===file.documentId&&f.path===file.path&&f.sha256===file.sha256));
   return marks.length?Math.min(...marks.map(e=>e.deliveredAt!)):null;
  });
  return times.some(at=>at===null)?[]:[{taskId:task.id,count:files.length,completedAt:Math.max(...times as number[])}];
 });
}

export function validatePredicates(value:unknown,criteria:Criteria,status:Verdict['status'],checkedAt?:number):asserts value is CheckPredicate[]|undefined {
 if(value===undefined)return;
 const line=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=16000&&v.isWellFormed();
 if(!Array.isArray(value)||value.length<1||value.length>128||!value.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).length===(Object.hasOwn(p,'checkedAt')?5:4)&&['criterion','passed','quote','reason'].every(k=>Object.hasOwn(p,k))&&(!Object.hasOwn(p,'checkedAt')||checkedAt!==undefined&&Number.isSafeInteger(p.checkedAt)&&p.checkedAt>=0&&p.checkedAt===checkedAt)&&p.criterion===criteria.description&&typeof p.passed==='boolean'&&line(p.quote)&&line(p.reason))||status==='passed'&&!value.every(p=>p.passed)||status==='failed'&&!value.some(p=>!p.passed))throw new DomainError('Invalid check predicates');
}

export function validateStepProgress(value:unknown):asserts value is StepProgress {
 const p=value as StepProgress,keys=p&&typeof p==='object'?Object.keys(p):[];
 const line=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=500&&v.isWellFormed();
 if(!p||!keys.every(k=>['done','total','at','note','wording'].includes(k))||!Number.isSafeInteger(p.at)||p.at<0||!Number.isSafeInteger(p.total)||p.total<1||p.total>10000||!Number.isSafeInteger(p.done)||p.done<0||p.done>p.total||Object.hasOwn(p,'note')&&(!p.note||Object.keys(p.note).length!==2||!line(p.note.label)||!line(p.note.text)))throw new DomainError('Invalid step progress');
 if(Object.hasOwn(p,'wording'))validateProgressNote(p.wording);
}

export function validateProcedureEdit(mission:import('./domain.ts').Mission,work:import('./domain.ts').Work,task:import('./domain.ts').Task):void {
 const e=task.procedureEdit;if(!Object.hasOwn(task,'procedureEdit'))return;
 const m=mission.conversations?.find(c=>c.workId===work.id)?.messages.find(m=>m.id===e?.messageId);
 if(!e||Object.keys(e).length!==5||!['messageId','actorId','title','instruction','at'].every(k=>Object.hasOwn(e,k))||!task.step||!m?.stepNote||m.stepNote.taskId!==task.id||m.stepNote.title!==e.title||m.text!==e.instruction||!Number.isSafeInteger(e.at)||e.at<0||m.at!==undefined&&e.at<m.at||!work.assignments.some(a=>a.taskId===task.id&&a.actorId===e.actorId&&a.role==='executor'))throw new DomainError('Invalid procedure acknowledgement');
}
