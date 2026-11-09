import {DomainError} from './domain.ts';
import type {CheckPredicate,Criteria,Verdict,StepProgress} from './domain.ts';

export function validatePredicates(value:unknown,criteria:Criteria,status:Verdict['status']):asserts value is CheckPredicate[]|undefined {
 if(value===undefined)return;
 const line=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=16000&&v.isWellFormed();
 if(!Array.isArray(value)||value.length<1||value.length>128||!value.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).length===4&&['criterion','passed','quote','reason'].every(k=>Object.hasOwn(p,k))&&p.criterion===criteria.description&&typeof p.passed==='boolean'&&line(p.quote)&&line(p.reason))||status==='passed'&&!value.every(p=>p.passed)||status==='failed'&&!value.some(p=>!p.passed))throw new DomainError('Invalid check predicates');
}

export function validateStepProgress(value:unknown):asserts value is StepProgress {
 const p=value as StepProgress,keys=p&&typeof p==='object'?Object.keys(p):[];
 const line=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=500&&v.isWellFormed();
 if(!p||!keys.every(k=>['done','total','at','note'].includes(k))||!Number.isSafeInteger(p.at)||p.at<0||!Number.isSafeInteger(p.total)||p.total<1||p.total>10000||!Number.isSafeInteger(p.done)||p.done<0||p.done>p.total||Object.hasOwn(p,'note')&&(!p.note||Object.keys(p.note).length!==2||!line(p.note.label)||!line(p.note.text)))throw new DomainError('Invalid step progress');
}
