import {DomainError} from './domain.ts';
import type {Work} from './domain.ts';
export interface WorkQuestion {id:string;actorId:string;text:string;answer:null|{actorId:string;text:string}}
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
function valid(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
export function questionText(v:unknown):asserts v is string {valid(typeof v==='string'&&v.trim().length>0&&v.isWellFormed()&&Buffer.byteLength(v,'utf8')<=4096,'Question and answer require bounded nonempty well-formed UTF-8');}
export function clarificationInput(work:Work):WorkQuestion[]|undefined {
 if(!Object.hasOwn(work,'questions'))return undefined;const qs=work.questions;
 valid(Array.isArray(qs)&&qs.length>0&&qs.length<=3&&Object.keys(qs).length===qs.length,'Invalid Work question count');const ids=new Set<string>();
 for(const q of qs){valid(exact(q,['id','actorId','text','answer'])&&id(q.id)&&id(q.actorId)&&!ids.has(q.id),'Invalid exact owner question');ids.add(q.id);questionText(q.text);if(q.answer!==null){valid(exact(q.answer,['actorId','text'])&&id(q.answer.actorId),'Invalid exact owner answer');questionText(q.answer.text);}}
 return structuredClone(qs);
}
export function requireAnswered(work:Work):void {valid(!clarificationInput(work)?.some(q=>q.answer===null),'Open owner clarification questions block execution');}
