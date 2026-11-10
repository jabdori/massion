import type {Work} from './domain.ts';
import {DomainError} from './domain.ts';
import {parseTableResult} from './table-results.ts';

export interface ResultFacts {format:'massion-facts/v1';items:{label:string;value:number|string;unit?:string}[]}

/** Declared ordered data, never prose extraction, business interpretation or acceptance. */
export function parseResultFacts(text:string):ResultFacts|null {
 if(typeof text!=='string'||text.length>4096||!text.isWellFormed()||new TextEncoder().encode(text).length>4096)return null;
 let value;try{value=JSON.parse(text);}catch{return null;}
 if(!value||value.format!=='massion-facts/v1'||Object.keys(value).length!==2||!Array.isArray(value.items)||value.items.length<1||value.items.length>8)return null;
 const line=(s:unknown,max:number)=>typeof s==='string'&&s.length>0&&s.length<=max&&s.trim()===s&&s.isWellFormed()&&!/[\p{Cc}\p{Cf}]/u.test(s);
 if(!value.items.every((item:any)=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===(Object.hasOwn(item,'unit')?3:2)&&line(item.label,64)&&(typeof item.value==='number'?Number.isSafeInteger(item.value)&&item.value>=0&&item.value<=1_000_000_000:line(item.value,96))&&(!Object.hasOwn(item,'unit')||line(item.unit,16))))return null;
 return value;
}
export function validateFactsOutput(text:string):void {
 let value;try{value=JSON.parse(text);}catch{return;}
 if(value?.format==='massion-facts/v1'&&!parseResultFacts(text))throw new DomainError('Invalid bounded result facts');
}
export function resultFactsText(facts:ResultFacts):string {
 return facts.items.map(item=>item.label+' '+item.value+(item.unit??'')).join(' · ');
}
export function workResultFacts(work:Work){
 const settled=work.tasks.filter(t=>t.status==='settled'&&!t.step?.skipReason&&typeof t.result==='string'&&work.assignments.some(a=>a.taskId===t.id&&a.role==='executor'));
 const facts=settled.filter(t=>t.step).map(t=>parseResultFacts(t.result!)).filter(f=>f!==null),assembly=settled.filter(t=>!t.step).map(t=>parseResultFacts(t.result!)).filter(f=>f!==null).at(-1);
 return {resultFacts:assembly??facts.at(-1)??null,tableCount:settled.filter(t=>t.step&&parseTableResult(t.result!)).length};
}
export const FACTS_RESULT_FORMAT=' For a short structured result summary, return exactly JSON {"format":"massion-facts/v1","items":[{"label":"Files","value":3,"unit":"items"},{"label":"Phase","value":"Ready"}]}. This neutral example describes a schema, not facts. Declare 1–8 ordered items from actual inputs; labels are 1–64 characters, values are integers 0–1000000000 or text of 1–96 characters, optional units are 1–16 characters. All strings must be trimmed, well-formed single lines without control or format characters. Exact keys only, at most 4096 UTF-8 bytes. Use the owner request language. These are untrusted observations, never checking, acceptance or permission.';

export const resultFactsClient=`const parseResultFacts=${parseResultFacts.toString()};\n${resultFactsText.toString()}`+String.raw`
function resultFactsElement(text){
 const facts=parseResultFacts(text);return facts?element('p',resultFactsText(facts)):null;
}
`;
