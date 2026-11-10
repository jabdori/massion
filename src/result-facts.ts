import type {Work} from './domain.ts';
import {DomainError} from './domain.ts';
import {parseTableResult} from './table-results.ts';

export type ResultFacts={format:'massion-facts/v1'}&(
 {kind:'pricing';plans:number;tables:number}|
 {kind:'churn';reasons:number;business:number;other:number}|
 {kind:'causes';causes:number;evidence:number});

/** Explicit producer observations, never prose extraction or acceptance. */
export function parseResultFacts(text:string):ResultFacts|null {
 if(typeof text!=='string'||text.length>1024||!text.isWellFormed()||new TextEncoder().encode(text).length>1024)return null;
 let value;try{value=JSON.parse(text);}catch{return null;}
 if(!value||value.format!=='massion-facts/v1')return null;
 const fields=value.kind==='pricing'?['plans','tables']:value.kind==='churn'?['reasons','business','other']:value.kind==='causes'?['causes','evidence']:null;
 if(!fields||Object.keys(value).length!==fields.length+2||!fields.every(key=>Object.hasOwn(value,key)&&Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=1_000_000_000))return null;
 if(value.kind==='churn'&&value.reasons!==value.business+value.other)return null;
 return value;
}
export function validateFactsOutput(text:string):void {
 let value;try{value=JSON.parse(text);}catch{return;}
 if(value?.format==='massion-facts/v1'&&!parseResultFacts(text))throw new DomainError('Invalid bounded business result facts');
}
export function workResultFacts(work:Work){
 const settled=work.tasks.filter(t=>t.status==='settled'&&!t.step?.skipReason&&typeof t.result==='string'&&work.assignments.some(a=>a.taskId===t.id&&a.role==='executor'));
 const tables=settled.filter(t=>t.step).map(t=>parseTableResult(t.result!)).filter(t=>t!==null);
 const pricing=tables.filter(t=>t.business==='pricing');
 const facts=settled.filter(t=>t.step).map(t=>parseResultFacts(t.result!)).filter(f=>f!==null),assembly=settled.filter(t=>!t.step).map(t=>parseResultFacts(t.result!)).filter(f=>f!==null).at(-1);
 return {resultFacts:assembly??facts.at(-1)??(pricing.length?{format:'massion-facts/v1' as const,kind:'pricing' as const,plans:pricing.reduce((sum,t)=>sum+t.rows.length,0),tables:pricing.length}:null),tableCount:assembly?.kind==='pricing'?assembly.tables:tables.length};
}
export const FACTS_RESULT_FORMAT=' For business-result counts you may instead return exactly JSON {"format":"massion-facts/v1","kind":"pricing","plans":6,"tables":1}, {"format":"massion-facts/v1","kind":"churn","reasons":41,"business":9,"other":32}, or {"format":"massion-facts/v1","kind":"causes","causes":1,"evidence":2}. These are schema examples, not facts: use only counts supported by your actual inputs. Exact keys, integers 0–1000000000, churn reasons must equal business+other, at most 1024 UTF-8 bytes. These are untrusted observations, never checking, acceptance or permission.';

export const resultFactsClient=`const parseResultFacts=${parseResultFacts.toString()};`+String.raw`
function resultFactsElement(text){
 const facts=parseResultFacts(text);if(!facts)return null;
 return element('p',copy('ui.facts.'+(facts.kind==='churn'?'churn':facts.kind+'-counts'),facts));
}
`;
