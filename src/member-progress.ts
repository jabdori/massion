import {DomainError} from './domain.ts';
import type {Work} from './domain.ts';

export interface ProgressNote {summary:string;caption?:string;checkCaption?:string}
export function validateProgressNote(value:unknown):asserts value is ProgressNote {
 const n=value as ProgressNote,line=(s:unknown,max:number)=>typeof s==='string'&&s.length>0&&s.length<=max&&s.trim()===s&&s.isWellFormed()&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);
 if(!n||typeof n!=='object'||Array.isArray(n)||!Object.hasOwn(n,'summary')||!Object.keys(n).every(k=>['summary','caption','checkCaption'].includes(k))||!line(n.summary,200)||Object.hasOwn(n,'caption')&&!line(n.caption,50)||Object.hasOwn(n,'checkCaption')&&!line(n.checkCaption,50))throw new DomainError('Invalid bounded progress wording');
}
export function parseStepResult(output:string):{result:string;progressNote?:ProgressNote} {
 let v;try{v=JSON.parse(output);}catch{return {result:output};}
 if(v?.format!=='massion-step/v1')return {result:output};
 if(Object.keys(v).length!==3||!['format','result','progressNote'].every(k=>Object.hasOwn(v,k))||typeof v.result!=='string'||!v.result.trim()||v.result.length>16000||!v.result.isWellFormed())throw new DomainError('Invalid bounded step result');
 validateProgressNote(v.progressNote);return {result:v.result,progressNote:v.progressNote};
}
export function workProgressNote(work:Work):ProgressNote|null {
 if(work.effects.some(e=>e.status==='unknown')||!['active','waiting','settled'].includes(work.execution)||!['pending','failed'].includes(work.acceptance))return null;
 return work.tasks.filter(t=>t.step&&!t.step.skipReason&&t.progress&&t.status!=='queued'&&work.assignments.some(a=>a.taskId===t.id&&a.role==='executor')).sort((a,b)=>a.progress!.at-b.progress!.at).at(-1)?.progress?.wording??null;
}
export const PROGRESS_NOTE_INSTRUCTION=' You may attach progressNote with exactly {summary,caption?,checkCaption?}: summary is a short concrete sentence (1–200 characters), captions are short phrases (1–50 characters each). Use trimmed well-formed single lines without control or format characters, in the owner request language. Korean summaries use polite conversational endings; captions use concise action phrases. Use the concept-specific Korean terms 실행 중, 완료, 확인 대기, 확인 실패, 결정 대기, 승인됨 · 미실행, 보관 안 함, 실행 취소; restoring a previous version is 되돌리기. Describe only observed work and the current action, never invented counts, permission, acceptance or a check verdict. checkCaption describes a check criterion or prerequisite, never a verdict. Do not include internal job titles, models or hidden reasoning.';
export const STEP_RESULT_FORMAT=' Return a step result with its note as exactly JSON {"format":"massion-step/v1","result":"<original result string>","progressNote":{"summary":"<observed progress>","caption":"<short progress>"}}; the result string retains the existing result format.';
